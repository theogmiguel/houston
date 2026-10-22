//! Workspace transfer entry points: export a workspace's Claude and Codex panes and code
//! state to one file, import it and resume the panes. Import binds each conversation to its
//! new folder itself, so `resume_check` still refuses a folder change on respawn.

use super::*;
use crate::db::{TransferCheckoutRecord, TransferDirection, TransferRecord, TransferSessionRecord};
use crate::transfer::archive::{self, Entry, Source};
use crate::transfer::checkout;
use crate::transfer::manifest::{
    CheckoutEntry, Manifest, PaneEntry, WorkspaceEntry, FORMAT_VERSION,
};
use crate::transfer::{count, refuse, transcripts};
use proto::TransferRefusalCode as Code;

const MAIN_KEY: &str = "main";
const WORKTREE_KEY_PREFIX: &str = "worktree:";
const CHANGES_WORKTREE_SKIPPED: &str = "worktree created from the Changes panel lives outside the workspace; this version moves only .houston/worktrees worktrees";

pub(crate) type Progress<'a> = &'a (dyn Fn(proto::TransferStage) + Send + Sync);

struct Candidate {
    info: proto::SessionInfo,
    conversation: String,
    transcript: PathBuf,
    checkout_key: String,
    checkout_root: PathBuf,
    slug: Option<String>,
    rel_cwd: String,
    cwd: PathBuf,
}

/// A path as the user knows it: Windows' verbatim prefix removed.
fn display_path(path: &Path) -> String {
    let text = path.display().to_string();
    match text.strip_prefix(r"\\?\") {
        Some(rest) if !rest.starts_with("UNC\\") => rest.to_string(),
        _ => text,
    }
}

/// A Windows path into a WSL distro's file system.
fn is_wsl_path(path: &str) -> bool {
    let lower = path.to_ascii_lowercase().replace('/', "\\");
    let lower = lower
        .strip_prefix(r"\\?\unc\")
        .map_or(lower.clone(), |rest| format!(r"\\{rest}"));
    lower.starts_with(r"\\wsl$\") || lower.starts_with(r"\\wsl.localhost\")
}

fn canonical(path: &Path) -> PathBuf {
    path.canonicalize().unwrap_or_else(|_| path.to_path_buf())
}

fn same_path(a: &Path, b: &Path) -> bool {
    a == b || canonical(a) == canonical(b)
}

fn slash_relative(path: &Path, root: &Path) -> Option<String> {
    let relative = path.strip_prefix(root).ok()?;
    Some(
        relative
            .components()
            .map(|c| c.as_os_str().to_string_lossy().into_owned())
            .collect::<Vec<_>>()
            .join("/"),
    )
}

fn pane_label(info: &proto::SessionInfo) -> String {
    format!("{} (pane {})", info.title, info.id)
}

fn provider_name(provider: proto::AgentKind) -> &'static str {
    match provider {
        proto::AgentKind::Claude => "Claude Code",
        proto::AgentKind::Codex => "Codex",
        _ => "this provider",
    }
}

fn os_name(os: &str) -> &str {
    match os {
        "windows" => "Windows",
        "linux" => "Linux",
        "macos" => "macOS",
        other => other,
    }
}

/// A remote URL reduced to host and path, so `git@host:o/r.git` and `https://host/o/r`
/// name the same repository.
pub(crate) fn normalize_remote(url: &str) -> String {
    let mut rest = url.trim();
    if let Some((_, after)) = rest.split_once("://") {
        rest = after;
    }
    if let Some((before, after)) = rest.split_once('@') {
        if !before.contains('/') {
            rest = after;
        }
    }
    let rest = match rest.split_once('/') {
        Some((host, path)) if !host.contains(':') => format!("{host}/{path}"),
        _ => rest.replacen(':', "/", 1),
    };
    rest.trim_end_matches('/')
        .trim_end_matches(".git")
        .to_ascii_lowercase()
}

#[derive(Clone)]
enum CheckoutMode {
    /// The checkout exists, is clean, and moves to the file's state.
    Existing,
    /// A Houston worktree the import creates.
    NewWorktree,
    /// A return trip: the tree still matches this computer's export of it.
    ReturnTrip {
        recorded_head: String,
        exported_untracked: Vec<String>,
    },
}

struct CheckoutPlan<'a> {
    entry: &'a CheckoutEntry,
    root: PathBuf,
    source: PathBuf,
    mode: CheckoutMode,
}

enum PanePlan {
    New,
    InPlace(TransferSessionRecord),
}

impl Daemon {
    fn transfer_workspace(&self, workspace: &str) -> Result<(proto::Workspace, PathBuf)> {
        let found = self
            .workspace_list()?
            .into_iter()
            .find(|w| same_path(Path::new(&w.path), Path::new(workspace)));
        let Some(found) = found else {
            return Err(refuse(
                Code::UnknownWorkspace,
                format!("{workspace} is not a workspace in Houston on this computer."),
                vec![workspace.to_string()],
                vec!["Add the folder as a workspace, then try again.".into()],
            ));
        };
        if is_wsl_path(&found.path) {
            return Err(refuse(
                Code::WslWorkspace,
                format!(
                    "{} is in a WSL environment, and workspace transfer does not support WSL environments yet.",
                    found.path
                ),
                vec![found.path.clone()],
                vec!["Transfer a workspace on this computer's own file system instead.".into()],
            ));
        }
        let root = canonical(Path::new(&found.path));
        if !crate::git::is_git_repo(&root) {
            return Err(refuse(
                Code::NotGitRepository,
                format!(
                    "{} is not a git repository, and a transfer carries code through git.",
                    display_path(&root)
                ),
                vec![display_path(&root)],
                vec!["Run git init and commit the project, or choose a workspace that is a git repository.".into()],
            ));
        }
        Ok((found, root))
    }

    fn require_passphrase(passphrase: &proto::TransferPassphrase) -> Result<()> {
        if passphrase.expose().is_empty() {
            return Err(refuse(
                Code::PassphraseRequired,
                "A passphrase is required.",
                Vec::new(),
                vec!["Enter the passphrase, then try again.".into()],
            ));
        }
        Ok(())
    }

    fn in_workspace(info: &proto::SessionInfo, root: &Path, outside: &[PathBuf]) -> bool {
        let cwd = canonical(Path::new(&info.cwd));
        let project = canonical(Path::new(&info.project_dir));
        project == root
            || cwd.starts_with(root)
            || outside
                .iter()
                .any(|tree| cwd.starts_with(tree) || project.starts_with(tree))
    }

    /// Managed worktrees of the workspace's repository that live outside it: the ones the
    /// Changes panel creates in Houston's state directory.
    fn outside_worktrees(&self, root: &Path) -> Vec<PathBuf> {
        let Some(common) = crate::git::checkout_facts(root).common_dir else {
            return Vec::new();
        };
        let common = canonical(&root.join(common));
        self.db
            .managed_worktrees()
            .unwrap_or_else(|e| {
                tracing::warn!("listing managed worktrees for a transfer export: {e:#}");
                Vec::new()
            })
            .into_iter()
            .filter(|row| canonical(&root.join(&row.repo_common_dir)) == common)
            .map(|row| canonical(Path::new(&row.path)))
            .filter(|path| !path.starts_with(root))
            .collect()
    }

    /// The pane as a transfer candidate, or why it stays behind.
    fn transfer_candidate(
        &self,
        info: &proto::SessionInfo,
        root: &Path,
        outside: &[PathBuf],
    ) -> std::result::Result<Candidate, String> {
        if info.spawned_by.is_some() {
            return Err(
                "orchestrated child; parent and child panes do not transfer in this version".into(),
            );
        }
        if info.acp.is_some() {
            return Err("ACP pane; only terminal Claude and Codex panes transfer".into());
        }
        match info.agent {
            proto::AgentKind::Claude | proto::AgentKind::Codex => {}
            proto::AgentKind::Shell => return Err("shell pane".into()),
            other => {
                return Err(format!(
                    "{other:?} pane; only Claude and Codex panes transfer"
                ))
            }
        }
        let folder = canonical(Path::new(&info.cwd));
        if outside.iter().any(|tree| folder.starts_with(tree)) {
            return Err(CHANGES_WORKTREE_SKIPPED.into());
        }
        if info.transferred_at_ms.is_some() {
            return Err("its conversation already left in an earlier transfer".into());
        }
        let db_error = |e: anyhow::Error| format!("reading its record failed: {e:#}");
        if self
            .db
            .session_has_command_override(info.id)
            .map_err(db_error)?
        {
            return Err("it was started with a custom command".into());
        }
        let (conversation, transcript) = self
            .db
            .session_resume_handle(info.id)
            .map_err(db_error)?
            .ok_or("no conversation is recorded for it yet")?;
        let (agent, cwd) = self
            .db
            .session_resume_binding(info.id)
            .map_err(db_error)?
            .ok_or("its conversation is not bound to a folder yet")?;
        if agent != crate::agent_hooks::provider_slug(info.agent) {
            return Err(format!(
                "its conversation belongs to {agent}, not the pane's provider"
            ));
        }
        let transcript = PathBuf::from(transcript.ok_or("no transcript is recorded for it")?);
        match std::fs::metadata(&transcript) {
            Ok(meta) if meta.len() > 0 => {}
            _ => {
                return Err(format!(
                    "its transcript {} is missing or empty",
                    transcript.display()
                ))
            }
        }
        let cwd = canonical(Path::new(&cwd));
        if !cwd.starts_with(root) {
            return Err(format!(
                "its folder {} is outside the workspace",
                display_path(&cwd)
            ));
        }
        let worktrees = root.join(crate::paths::PROJECT_DIR).join("worktrees");
        let (checkout_key, checkout_root, slug) = match cwd.strip_prefix(&worktrees) {
            Ok(rest) => {
                let slug = rest
                    .components()
                    .next()
                    .map(|c| c.as_os_str().to_string_lossy().into_owned())
                    .ok_or("its folder is the worktrees folder itself")?;
                let tree = worktrees.join(&slug);
                let top = checkout::toplevel(&tree)
                    .map_err(|e| format!("worktree {slug} is not readable: {e:#}"))?;
                if !same_path(&top, &tree) {
                    return Err(format!("{} is not a git worktree", display_path(&tree)));
                }
                match checkout::branch(&tree) {
                    Ok(Some(_)) => {}
                    Ok(None) => return Err(format!("worktree {slug} has a detached HEAD")),
                    Err(e) => return Err(format!("worktree {slug} is not readable: {e:#}")),
                }
                (format!("{WORKTREE_KEY_PREFIX}{slug}"), tree, Some(slug))
            }
            Err(_) => (MAIN_KEY.to_string(), root.to_path_buf(), None),
        };
        let rel_cwd = slash_relative(&cwd, &checkout_root).unwrap_or_default();
        Ok(Candidate {
            info: info.clone(),
            conversation,
            transcript,
            checkout_key,
            checkout_root,
            slug,
            rel_cwd,
            cwd,
        })
    }

    fn cli_version(&self, provider: proto::AgentKind) -> Option<String> {
        let binary = crate::cli_probe::binary_name(provider)?;
        crate::cli_probe::probe_in(&self.env(), binary).version
    }

    pub(crate) fn transfer_export(
        self: &Arc<Self>,
        workspace: &str,
        destination: &str,
        passphrase: &proto::TransferPassphrase,
        grids: String,
        progress: Progress,
    ) -> Result<proto::TransferExportSummary> {
        Self::require_passphrase(passphrase)?;
        let destination = PathBuf::from(destination);
        if !destination.is_absolute() || destination.file_name().is_none() {
            bail!(
                "export destination {} is not an absolute file path",
                destination.display()
            );
        }
        let (workspace, root) = self.transfer_workspace(workspace)?;
        progress(proto::TransferStage::Checking);
        let outside = self.outside_worktrees(&root);
        let panes: Vec<proto::SessionInfo> = self
            .list()
            .into_iter()
            .filter(|info| !info.hidden && Self::in_workspace(info, &root, &outside))
            .collect();
        let busy: Vec<String> = panes
            .iter()
            .filter(|info| info.state.is_live())
            .filter_map(|info| {
                let word = match info.status? {
                    proto::AgentStatus::Working => "working",
                    proto::AgentStatus::NeedsInput => "waiting for input",
                    proto::AgentStatus::Spawning => "starting",
                    _ => return None,
                };
                Some(format!("{}: {word}", pane_label(info)))
            })
            .collect();
        if !busy.is_empty() {
            return Err(refuse(
                Code::BusyPanes,
                format!(
                    "{} in {} still busy, and a transfer stops every exported pane.",
                    count(busy.len(), "pane", "panes"),
                    workspace.name
                ),
                busy,
                vec![
                    "Let each listed pane finish its turn, or answer it, then export again.".into(),
                ],
            ));
        }
        let mut candidates = Vec::new();
        let mut skipped = Vec::new();
        for info in &panes {
            match self.transfer_candidate(info, &root, &outside) {
                Ok(candidate) => candidates.push(candidate),
                Err(reason) => skipped.push(proto::TransferSkipped {
                    session: info.id,
                    title: info.title.clone(),
                    reason,
                }),
            }
        }
        if candidates.is_empty() {
            return Err(refuse(
                Code::NothingToTransfer,
                format!(
                    "{} has no Claude or Codex pane with a recorded conversation to transfer.",
                    workspace.name
                ),
                skipped
                    .iter()
                    .map(|s| format!("{} (pane {}): {}", s.title, s.session, s.reason))
                    .collect(),
                vec!["Start or resume a Claude or Codex pane in this workspace, let it finish a turn, then export again.".into()],
            ));
        }

        progress(proto::TransferStage::Packing);
        let transfer_id = uuid::Uuid::new_v4().to_string();
        let scratch = tempfile::Builder::new()
            .prefix("transfer-")
            .tempdir_in(self.state_dir())
            .context("creating a scratch folder for the export")?;
        let mut checkout_order: Vec<(String, PathBuf, Option<String>)> = Vec::new();
        for c in &candidates {
            if !checkout_order
                .iter()
                .any(|(key, _, _)| *key == c.checkout_key)
            {
                checkout_order.push((
                    c.checkout_key.clone(),
                    c.checkout_root.clone(),
                    c.slug.clone(),
                ));
            }
        }
        let mut entries = Vec::new();
        let mut checkouts = Vec::new();
        let mut checkout_records = Vec::new();
        let mut skipped_links = Vec::new();
        for (n, (key, tree, slug)) in checkout_order.iter().enumerate() {
            let captured =
                checkout::capture(tree, &scratch.path().join(format!("checkout-{n}")))
                    .with_context(|| format!("reading the code state of {}", display_path(tree)))?;
            let dir = format!("checkouts/{n}");
            if let Some(bundle) = &captured.bundle {
                entries.push(Entry {
                    path: format!("{dir}/head.bundle"),
                    source: Source::File(bundle.clone()),
                });
            }
            if let Some(diff) = &captured.diff {
                entries.push(Entry {
                    path: format!("{dir}/tracked.diff"),
                    source: Source::File(diff.clone()),
                });
            }
            for relative in &captured.untracked {
                entries.push(Entry {
                    path: format!("{dir}/untracked/{relative}"),
                    source: Source::File(transcripts::join(tree, relative)),
                });
            }
            skipped_links.extend(
                captured
                    .links
                    .iter()
                    .map(|link| format!("{}/{link}", display_path(tree))),
            );
            let path = display_path(tree);
            checkouts.push(CheckoutEntry {
                key: key.clone(),
                worktree: slug.clone(),
                path: path.clone(),
                branch: captured.branch.clone(),
                head: captured.head.clone(),
                bundle: captured.bundle.is_some(),
                diff: captured.diff.is_some(),
                untracked: captured.untracked.clone(),
                archive_dir: dir,
                origin: self.db.transfer_checkout_origin(&path, key)?,
            });
            checkout_records.push(TransferCheckoutRecord {
                key: key.clone(),
                path,
                tree_state: Some(captured.state),
                untracked: captured.untracked,
            });
        }
        let mut pane_entries = Vec::new();
        let mut session_records = Vec::new();
        for (n, c) in candidates.iter().enumerate() {
            let collected = transcripts::collect(c.info.agent, &c.transcript, &c.conversation)?;
            let dir = format!("transcripts/{n}");
            for relative in std::iter::once(&collected.transcript).chain(&collected.extra_files) {
                entries.push(Entry {
                    path: format!("{dir}/{relative}"),
                    source: Source::File(transcripts::join(&collected.root, relative)),
                });
            }
            let sha = checkout::sha256_file(&c.transcript)?;
            pane_entries.push(PaneEntry {
                source_session: c.info.id,
                provider: c.info.agent,
                title: c.info.title.clone(),
                checkout: c.checkout_key.clone(),
                rel_cwd: c.rel_cwd.clone(),
                cwd: display_path(&c.cwd),
                conversation: c.conversation.clone(),
                archive_dir: dir,
                transcript: collected.transcript,
                extra_files: collected.extra_files,
                transcript_sha256: sha.clone(),
                launch_selections: self.db.session_launch_selections(c.info.id)?,
                profile_label: self.db.session_profile_label(c.info.id)?,
                origin: self.db.transfer_conversation_origin(&c.conversation)?,
            });
            session_records.push(TransferSessionRecord {
                local_session: c.info.id,
                source_session: c.info.id,
                conversation: c.conversation.clone(),
                transcript_path: c.transcript.display().to_string(),
                transcript_sha256: sha,
            });
        }
        let mut providers: Vec<proto::AgentKind> = Vec::new();
        for c in &candidates {
            if !providers.contains(&c.info.agent) {
                providers.push(c.info.agent);
            }
        }
        let created_at_ms = now_ms();
        let manifest = Manifest {
            format: FORMAT_VERSION,
            transfer_id: transfer_id.clone(),
            created_at_ms,
            source_os: std::env::consts::OS.to_string(),
            houston_version: env!("CARGO_PKG_VERSION").to_string(),
            workspace: WorkspaceEntry {
                path: display_path(&root),
                name: workspace.name.clone(),
                remote_url: crate::git::remote_url(&root),
            },
            cli_versions: providers
                .iter()
                .map(|provider| proto::TransferCliVersion {
                    provider: *provider,
                    version: self.cli_version(*provider),
                })
                .collect(),
            checkouts,
            panes: pane_entries,
            skipped: skipped.clone(),
            skipped_links: skipped_links.clone(),
            grids,
        };
        let file_name = destination
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default();
        let partial = destination.with_file_name(format!(".{file_name}.{transfer_id}.partial"));
        let written = archive::write(&partial, passphrase.expose(), &manifest, &entries);
        let written = match written {
            Ok(written) => written,
            Err(error) => {
                let _ = std::fs::remove_file(&partial);
                return Err(error);
            }
        };
        if let Err(error) = std::fs::rename(&partial, &destination) {
            let _ = std::fs::remove_file(&partial);
            return Err(error)
                .with_context(|| format!("moving the transfer file to {}", destination.display()));
        }
        self.db.transfer_record(&TransferRecord {
            id: transfer_id.clone(),
            direction: TransferDirection::Export,
            workspace: display_path(&root),
            created_at_ms,
            checkouts: checkout_records,
            sessions: session_records,
        })?;
        for c in &candidates {
            if c.info.state.is_live() {
                if let Err(e) = self.stop_for_transfer(c.info.id) {
                    tracing::warn!(
                        "stopping pane {} after exporting its conversation: {e:#}",
                        c.info.id
                    );
                }
            }
            self.set_transfer_mark(c.info.id, Some(created_at_ms), None);
        }
        tracing::info!(
            "exported transfer {transfer_id} of {} ({} panes, {written} bytes)",
            display_path(&root),
            candidates.len()
        );
        Ok(proto::TransferExportSummary {
            transfer_id,
            file: destination.display().to_string(),
            bytes: written,
            panes: manifest.panes.iter().map(transfer_pane).collect(),
            skipped,
            skipped_links,
        })
    }

    /// Updates a pane's transfer mark in memory and tells clients. The database row is
    /// the caller's.
    fn set_transfer_mark(&self, id: u32, at: Option<u64>, fork: Option<bool>) {
        let apply = |mark: &mut (Option<u64>, bool)| {
            mark.0 = at;
            if let Some(fork) = fork {
                mark.1 = fork;
            }
        };
        if let Some(session) = self.sessions.lock().expect("sessions lock").get(&id) {
            apply(&mut session.transfer_mark.lock().expect("transfer mark lock"));
        }
        if let Some(info) = self.dead.lock().expect("dead lock").get_mut(&id) {
            let mut mark = (info.transferred_at_ms, info.transfer_fork);
            apply(&mut mark);
            (info.transferred_at_ms, info.transfer_fork) = mark;
        }
        if let Some(info) = self.list().into_iter().find(|info| info.id == id) {
            self.broadcast_control(&proto::ServerMsg::SessionUpdated { info });
        }
    }

    /// A respawn that resumes a transferred (or already forked) conversation continues a
    /// fork of what left; the new pane says so.
    pub(super) fn carry_transfer_fork(
        &self,
        old_id: u32,
        mut spawned: proto::SessionInfo,
    ) -> proto::SessionInfo {
        match self.db.session_transfer_mark(old_id) {
            Ok((None, false)) => spawned,
            Ok(_) => {
                if let Err(e) = self.db.set_session_transfer_fork(spawned.id) {
                    tracing::warn!("marking pane {} as a transfer fork: {e:#}", spawned.id);
                    return spawned;
                }
                self.set_transfer_mark(spawned.id, None, Some(true));
                spawned.transfer_fork = true;
                spawned
            }
            Err(e) => {
                tracing::warn!("reading pane {old_id}'s transfer mark: {e:#}");
                spawned
            }
        }
    }

    /// The export of this computer that the file continues, if any.
    fn transfer_return_export(&self, manifest: &Manifest) -> Result<Option<TransferRecord>> {
        let ids = manifest
            .panes
            .iter()
            .filter_map(|pane| pane.origin.as_ref().map(|o| o.transfer_id.clone()))
            .chain(manifest.checkouts.iter().filter_map(|c| c.origin.clone()));
        for id in ids {
            if let Some(record) = self.db.transfer_export(&id)? {
                return Ok(Some(record));
            }
        }
        Ok(None)
    }

    fn transfer_profile_need(&self, provider: proto::AgentKind, label: &str) -> bool {
        self.resolve_named_profile(provider, label).is_ok()
    }

    pub(crate) fn transfer_inspect(
        &self,
        path: &str,
        passphrase: &proto::TransferPassphrase,
    ) -> Result<proto::TransferFileSummary> {
        Self::require_passphrase(passphrase)?;
        let manifest = archive::read_manifest(Path::new(path), passphrase.expose())?;
        let returning = self.transfer_return_export(&manifest)?;
        let proposed_workspace = match &returning {
            Some(record) => Some(record.workspace.clone()),
            None => manifest.workspace.remote_url.as_deref().and_then(|url| {
                let wanted = normalize_remote(url);
                self.workspace_list().ok()?.into_iter().find_map(|w| {
                    crate::git::remote_url(Path::new(&w.path))
                        .filter(|remote| normalize_remote(remote) == wanted)
                        .map(|_| w.path)
                })
            }),
        };
        let mut profiles: Vec<proto::TransferProfileNeed> = Vec::new();
        for pane in &manifest.panes {
            if let Some(label) = &pane.profile_label {
                if !profiles
                    .iter()
                    .any(|p| p.provider == pane.provider && &p.label == label)
                {
                    profiles.push(proto::TransferProfileNeed {
                        provider: pane.provider,
                        label: label.clone(),
                        matched: self.transfer_profile_need(pane.provider, label),
                    });
                }
            }
        }
        Ok(proto::TransferFileSummary {
            transfer_id: manifest.transfer_id.clone(),
            source_os: manifest.source_os.clone(),
            source_workspace: manifest.workspace.path.clone(),
            remote_url: manifest.workspace.remote_url.clone(),
            created_at_ms: manifest.created_at_ms,
            panes: manifest.panes.iter().map(transfer_pane).collect(),
            skipped: manifest.skipped.clone(),
            cli_versions: manifest.cli_versions.clone(),
            proposed_workspace,
            profiles,
            return_trip: returning.is_some(),
        })
    }

    fn check_transfer_environment(&self, manifest: &Manifest) -> Result<()> {
        let here = std::env::consts::OS;
        if manifest.source_os != here {
            return Err(refuse(
                Code::OtherOperatingSystem,
                format!(
                    "The file was exported on {}, and this computer runs {}. Transfers between operating systems are not supported yet.",
                    os_name(&manifest.source_os),
                    os_name(here)
                ),
                vec![format!("source: {}", os_name(&manifest.source_os))],
                vec![format!(
                    "Import the file on a computer running {}.",
                    os_name(&manifest.source_os)
                )],
            ));
        }
        let mut providers: Vec<proto::AgentKind> = Vec::new();
        for pane in &manifest.panes {
            if !providers.contains(&pane.provider) {
                providers.push(pane.provider);
            }
        }
        for provider in providers {
            let name = provider_name(provider);
            let binary = crate::cli_probe::binary_name(provider).unwrap_or("?");
            let recorded = manifest
                .cli_versions
                .iter()
                .find(|v| v.provider == provider)
                .and_then(|v| v.version.clone());
            let Some(local) = self.cli_version(provider) else {
                return Err(refuse(
                    Code::CliMissing,
                    format!("Houston could not read the version of {name} on this computer."),
                    vec![format!("{binary} --version")],
                    vec![format!(
                        "Install {name}{} and check that `{binary} --version` works, then import again.",
                        recorded
                            .as_deref()
                            .map(|v| format!(" {v} or newer"))
                            .unwrap_or_default()
                    )],
                ));
            };
            if let Some(recorded) = recorded {
                let (Some(have), Some(need)) = (
                    crate::transfer::manifest::version_key(&local),
                    crate::transfer::manifest::version_key(&recorded),
                ) else {
                    continue;
                };
                if have < need {
                    return Err(refuse(
                        Code::CliTooOld,
                        format!(
                            "{name} on this computer is version {local}, older than version {recorded}, which wrote these conversations."
                        ),
                        vec![format!("this computer: {local}"), format!("exporting computer: {recorded}")],
                        vec![format!("Update {name} to {recorded} or newer, then import again.")],
                    ));
                }
            }
        }
        Ok(())
    }

    /// The environment and label each pane runs with: the profile with the same label,
    /// or the user's choice for a label without one.
    fn transfer_profiles(
        &self,
        manifest: &Manifest,
        choices: &[proto::TransferProfileChoice],
    ) -> Result<Vec<ProfileSpawnEnvList>> {
        let mut missing = Vec::new();
        let mut out = Vec::new();
        for pane in &manifest.panes {
            let Some(label) = &pane.profile_label else {
                out.push((Vec::new(), None));
                continue;
            };
            if let Ok(resolved) = self.resolve_named_profile(pane.provider, label) {
                out.push(resolved);
                continue;
            }
            match choices
                .iter()
                .find(|c| c.provider == pane.provider && &c.label == label)
            {
                Some(choice) => match &choice.use_profile {
                    Some(local) => out.push(self.resolve_named_profile(pane.provider, local)?),
                    None => out.push((Vec::new(), None)),
                },
                None => {
                    let line = format!("{} profile \"{label}\"", provider_name(pane.provider));
                    if !missing.contains(&line) {
                        missing.push(line);
                    }
                    out.push((Vec::new(), None));
                }
            }
        }
        if !missing.is_empty() {
            return Err(refuse(
                Code::ProfileChoiceMissing,
                "Some panes used an agent profile that this computer does not have.",
                missing,
                vec!["Choose a profile on this computer, or the default account, for each listed profile, then import.".into()],
            ));
        }
        Ok(out)
    }

    /// The effective provider state directory for a pane launched with `env`.
    fn transfer_provider_dir(
        &self,
        provider: proto::AgentKind,
        env: &[(String, String)],
    ) -> Result<PathBuf> {
        if let Some(dir) = Self::agent_profile_config_dir(provider, env) {
            return Ok(PathBuf::from(dir));
        }
        let (var, default) = match provider {
            proto::AgentKind::Claude => ("CLAUDE_CONFIG_DIR", ".claude"),
            proto::AgentKind::Codex => ("CODEX_HOME", ".codex"),
            other => bail!("{other:?} conversations are not transferred"),
        };
        if let Some(dir) = self.env().var(var).filter(|v| !v.trim().is_empty()) {
            return Ok(PathBuf::from(dir));
        }
        Ok(self.hook_config_home()?.home.join(default))
    }

    /// Worktrees of the repository that have `branch` checked out, other than `except`.
    fn branch_checked_out_elsewhere(
        repo: &Path,
        branch: &str,
        except: &Path,
    ) -> Result<Option<PathBuf>> {
        Ok(crate::worktrees::list(repo)?
            .into_iter()
            .find(|tree| tree.branch.as_deref() == Some(branch) && !same_path(&tree.path, except))
            .map(|tree| tree.path))
    }

    fn plan_checkout<'a>(
        &self,
        root: &Path,
        scratch: &Path,
        entry: &'a CheckoutEntry,
        returning: Option<&TransferRecord>,
    ) -> Result<CheckoutPlan<'a>> {
        let target = match &entry.worktree {
            None => root.to_path_buf(),
            Some(slug) => {
                crate::worktrees::validate_slug(slug)?;
                crate::worktrees::spawn_path(root, slug)
            }
        };
        let recorded = returning.and_then(|record| {
            (entry.origin.as_deref() == Some(record.id.as_str()))
                .then(|| record.checkouts.iter().find(|c| c.key == entry.key))
                .flatten()
        });
        let mode = if !target.exists() {
            if entry.worktree.is_none() {
                bail!("workspace folder {} is missing", display_path(&target));
            }
            CheckoutMode::NewWorktree
        } else if let Some(recorded) = recorded.filter(|r| r.tree_state.is_some()) {
            let now = checkout::tree_state(&target)?;
            let then = recorded.tree_state.as_ref().expect("filtered");
            if &now != then {
                return Err(refuse(
                    Code::ReturnTreeChanged,
                    format!(
                        "{} changed after this computer exported it, so the returning state would overwrite those changes.",
                        display_path(&target)
                    ),
                    now.changes_since(then),
                    vec![
                        format!(
                            "Undo the listed changes in {} so it matches the export again, then import again.",
                            display_path(&target)
                        ),
                        "Or import into another workspace.".into(),
                    ],
                ));
            }
            CheckoutMode::ReturnTrip {
                recorded_head: then.head.clone(),
                exported_untracked: recorded.untracked.clone(),
            }
        } else {
            if entry.worktree.is_some()
                && !same_path(&checkout::toplevel(&target).unwrap_or_default(), &target)
            {
                return Err(refuse(
                    Code::PathsExist,
                    format!(
                        "{} already exists and is not a git worktree, so the transferred worktree cannot be created there.",
                        display_path(&target)
                    ),
                    vec![display_path(&target)],
                    vec![format!("Move or remove {}, then import again.", display_path(&target))],
                ));
            }
            let dirty = checkout::dirty_paths(&target)?;
            if !dirty.is_empty() {
                return Err(checkout::dirty_refusal(&display_path(&target), dirty));
            }
            CheckoutMode::Existing
        };
        Ok(CheckoutPlan {
            entry,
            root: target,
            source: scratch.join(&entry.archive_dir),
            mode,
        })
    }

    /// Commits, branches and untracked paths: everything that must hold before the
    /// first change. Adds the bundle's objects, which changes no ref or file.
    fn check_checkout_plan(&self, repo: &Path, plan: &CheckoutPlan) -> Result<()> {
        let entry = plan.entry;
        let target = display_path(&plan.root);
        let fetch_steps = vec![
            format!("Run git fetch in {} so this computer has the commits the file builds on, then import again.", display_path(repo)),
            "If those commits were never pushed, push them from the exporting computer, then export again.".into(),
        ];
        if entry.bundle {
            let bundle = plan.source.join("head.bundle");
            let missing = checkout::missing_prerequisites(repo, &bundle)?;
            if !missing.is_empty() {
                return Err(refuse(
                    Code::MissingCommits,
                    format!(
                        "This computer lacks commits that the code state of {target} builds on."
                    ),
                    missing,
                    fetch_steps,
                ));
            }
            checkout::unbundle(repo, &bundle)?;
        }
        if !checkout::has_commit(repo, &entry.head)? {
            return Err(refuse(
                Code::MissingCommits,
                format!(
                    "This computer lacks commit {} that {target} was on.",
                    crate::transfer::manifest::short(&entry.head)
                ),
                vec![entry.head.clone()],
                fetch_steps,
            ));
        }
        if let CheckoutMode::ReturnTrip { recorded_head, .. } = &plan.mode {
            if !checkout::is_ancestor(repo, recorded_head, &entry.head)? {
                return Err(refuse(
                    Code::BranchDiverged,
                    format!(
                        "The returning state of {target} does not build on commit {}, which this computer exported.",
                        crate::transfer::manifest::short(recorded_head)
                    ),
                    vec![format!(
                        "{}: {} here, {} in the file",
                        entry.branch.as_deref().unwrap_or("HEAD"),
                        crate::transfer::manifest::short(recorded_head),
                        crate::transfer::manifest::short(&entry.head)
                    )],
                    vec!["Import into another workspace, or rebase the work onto the exported commit on the other computer and export again.".into()],
                ));
            }
        }
        if let Some(branch) = &entry.branch {
            if !checkout::branch_fast_forwards(repo, branch, &entry.head)? {
                let tip = checkout::branch_tip(repo, branch)?.unwrap_or_default();
                return Err(refuse(
                    Code::BranchDiverged,
                    format!("Branch {branch} on this computer has commits that the transferred branch does not, so it cannot move forward to the file's state."),
                    vec![format!(
                        "{branch}: {} here, {} in the file",
                        crate::transfer::manifest::short(&tip),
                        crate::transfer::manifest::short(&entry.head)
                    )],
                    vec![
                        format!("Rename or reset branch {branch} here, then import again."),
                        "Or merge the commits on the exporting computer, then export again.".into(),
                    ],
                ));
            }
            if let Some(other) = Self::branch_checked_out_elsewhere(repo, branch, &plan.root)? {
                return Err(refuse(
                    Code::BranchCheckedOut,
                    format!("Branch {branch} is checked out in another folder, so the transfer cannot check it out in {target}."),
                    vec![display_path(&other)],
                    vec![format!("Switch {} to another branch, then import again.", display_path(&other))],
                ));
            }
        }
        if plan.root.exists() {
            let ignore: &[String] = match &plan.mode {
                CheckoutMode::ReturnTrip {
                    exported_untracked, ..
                } => exported_untracked,
                _ => &[],
            };
            let collisions = checkout::untracked_collisions(&plan.root, &entry.untracked, ignore)?;
            if !collisions.is_empty() {
                return Err(refuse(
                    Code::PathsExist,
                    format!("Files the transfer carries already exist in {target}, and import does not overwrite them."),
                    collisions,
                    vec![format!("Move or delete the listed files in {target}, then import again.")],
                ));
            }
        }
        Ok(())
    }

    fn apply_checkout_plan(&self, repo: &Path, plan: &CheckoutPlan) -> Result<()> {
        let entry = plan.entry;
        match &plan.mode {
            CheckoutMode::NewWorktree => {
                let slug = entry
                    .worktree
                    .as_deref()
                    .expect("a worktree plan has a slug");
                let branch = entry
                    .branch
                    .as_deref()
                    .context("a transferred worktree is on a branch")?;
                self.create_transfer_worktree(repo, slug, branch, &entry.head)?;
            }
            CheckoutMode::ReturnTrip {
                exported_untracked, ..
            } => {
                checkout::restore_exported_state(&plan.root, exported_untracked)?;
                checkout::move_to(&plan.root, entry.branch.as_deref(), &entry.head)?;
            }
            CheckoutMode::Existing => {
                checkout::move_to(&plan.root, entry.branch.as_deref(), &entry.head)?;
            }
        }
        if entry.diff {
            checkout::apply_diff(&plan.root, &plan.source.join("tracked.diff"))?;
        }
        checkout::write_untracked(&plan.root, &plan.source.join("untracked"), &entry.untracked)
    }

    /// Creates `.houston/worktrees/<slug>` on `branch` at `head` (the branch is created
    /// or fast-forwarded) and records it as a managed worktree, as a spawned pane's is.
    fn create_transfer_worktree(
        &self,
        repo: &Path,
        slug: &str,
        branch: &str,
        head: &str,
    ) -> Result<()> {
        let common_dir = crate::git::checkout_facts(repo)
            .common_dir
            .filter(|dir| !dir.is_empty())
            .ok_or_else(|| anyhow!("repo_common_dir for {} is unavailable; expected a non-empty git common directory", repo.display()))?;
        let dest = crate::worktrees::spawn_path(repo, slug);
        if let Some(dir) = dest.parent() {
            crate::worktrees::ensure_ignored(dir)?;
        }
        match checkout::branch_tip(repo, branch)? {
            None => {
                crate::worktrees::create_on_branch(repo, branch, Some(head), &dest)?;
            }
            Some(tip) => {
                if tip != head {
                    checkout::fast_forward_ref(repo, branch, &tip, head)?;
                }
                crate::worktrees::create_task(repo, branch, None, &dest)?;
            }
        }
        let path = dest.canonicalize().unwrap_or(dest);
        self.db
            .managed_worktree_record(&crate::db::ManagedWorktreeRow {
                path: path.display().to_string(),
                repo_common_dir: common_dir,
                branch: branch.to_string(),
                base_branch: crate::git::default_base(repo),
                provenance: crate::db::WorktreeProvenance::PaneSpawn,
                created_by_session: None,
                created_at_ms: now_ms() as i64,
                bytes: None,
                measured_at_ms: None,
            })
    }

    pub(crate) fn transfer_import(
        self: &Arc<Self>,
        path: &str,
        passphrase: &proto::TransferPassphrase,
        workspace: &str,
        choices: &[proto::TransferProfileChoice],
        progress: Progress,
    ) -> Result<proto::TransferImportResult> {
        Self::require_passphrase(passphrase)?;
        let (_, root) = self.transfer_workspace(workspace)?;
        progress(proto::TransferStage::Decrypting);
        let scratch = tempfile::Builder::new()
            .prefix("transfer-")
            .tempdir_in(self.state_dir())
            .context("creating a scratch folder for the import")?;
        let manifest = archive::unpack(Path::new(path), passphrase.expose(), scratch.path())?;
        progress(proto::TransferStage::Checking);
        self.check_transfer_environment(&manifest)?;
        let profiles = self.transfer_profiles(&manifest, choices)?;
        let returning = self
            .transfer_return_export(&manifest)?
            .filter(|record| same_path(Path::new(&record.workspace), &root));

        let mut open = Vec::new();
        let mut forked = Vec::new();
        let mut pane_plans = Vec::new();
        for pane in &manifest.panes {
            let in_place = returning.as_ref().and_then(|record| {
                let origin = pane.origin.as_ref()?;
                (origin.transfer_id == record.id)
                    .then(|| {
                        record.sessions.iter().find(|s| {
                            s.local_session == origin.session && s.conversation == pane.conversation
                        })
                    })
                    .flatten()
                    .cloned()
            });
            let plan = match in_place {
                Some(record) => self.plan_return_pane(record, &mut forked),
                None => PanePlan::New,
            };
            let holders = self.db.sessions_naming_conversation(&pane.conversation)?;
            let sessions = self.sessions.lock().expect("sessions lock");
            for holder in holders {
                if let Some(session) = sessions.get(&holder) {
                    if session.state.lock().expect("state lock").is_live() {
                        open.push(format!(
                            "{} (pane {holder}) holds conversation {}",
                            session.title.lock().expect("title lock"),
                            pane.conversation
                        ));
                    }
                }
            }
            drop(sessions);
            pane_plans.push(plan);
        }
        if !forked.is_empty() {
            return Err(refuse(
                Code::ReturnForked,
                "A transferred conversation continued on this computer after the export, so the returning conversation would overwrite it.",
                forked.iter().map(|(label, _)| label.clone()).collect(),
                forked
                    .iter()
                    .map(|(label, _)| format!("Close or kill {label} on this computer, or import into another workspace."))
                    .collect(),
            ));
        }
        if !open.is_empty() {
            return Err(refuse(
                Code::ConversationOpen,
                "A conversation in the file is already open in a pane on this computer.",
                open,
                vec!["Close the listed panes, then import again.".into()],
            ));
        }

        let mut checkout_plans = Vec::new();
        for entry in &manifest.checkouts {
            checkout_plans.push(self.plan_checkout(
                &root,
                scratch.path(),
                entry,
                returning.as_ref(),
            )?);
        }
        for plan in &checkout_plans {
            self.check_checkout_plan(&root, plan)?;
        }

        progress(proto::TransferStage::RestoringCode);
        for plan in &checkout_plans {
            self.apply_checkout_plan(&root, plan).with_context(|| {
                format!("restoring the code state of {}", display_path(&plan.root))
            })?;
        }

        progress(proto::TransferStage::PlacingConversations);
        let mut sessions = Vec::new();
        let mut updated_in_place = Vec::new();
        let mut session_records = Vec::new();
        let mut placed = Vec::new();
        for ((pane, plan), (env, label)) in manifest.panes.iter().zip(pane_plans).zip(profiles) {
            let source = scratch.path().join(&pane.archive_dir);
            let files: Vec<String> = std::iter::once(pane.transcript.clone())
                .chain(pane.extra_files.iter().cloned())
                .collect();
            match plan {
                PanePlan::InPlace(record) => {
                    let transcript = PathBuf::from(&record.transcript_path);
                    let place_root = match pane.provider {
                        proto::AgentKind::Claude => transcript
                            .parent()
                            .context("a recorded transcript has a folder")?
                            .to_path_buf(),
                        _ => {
                            let collected = transcripts::collect(
                                pane.provider,
                                &transcript,
                                &pane.conversation,
                            )?;
                            collected.root
                        }
                    };
                    transcripts::copy_files(&source, &place_root, &files)?;
                    placed.push((pane, Placed::InPlace(record)));
                }
                PanePlan::New => {
                    let checkout_root = checkout_plans
                        .iter()
                        .find(|p| p.entry.key == pane.checkout)
                        .map(|p| p.root.clone())
                        .with_context(|| {
                            format!(
                                "pane {} names checkout {} that the file does not carry",
                                pane.source_session, pane.checkout
                            )
                        })?;
                    let cwd = pane
                        .rel_cwd
                        .split('/')
                        .filter(|part| !part.is_empty())
                        .fold(checkout_root, |p, part| p.join(part));
                    let cwd = if cwd.is_dir() { cwd } else { root.clone() };
                    let provider_dir = self.transfer_provider_dir(pane.provider, &env)?;
                    let place_root = transcripts::place_root(pane.provider, &provider_dir, &cwd);
                    transcripts::copy_files(&source, &place_root, &files)?;
                    let transcript = transcripts::join(&place_root, &pane.transcript);
                    placed.push((
                        pane,
                        Placed::New {
                            cwd,
                            transcript,
                            env,
                            label,
                        },
                    ));
                }
            }
        }

        progress(proto::TransferStage::StartingPanes);
        for (pane, placed) in placed {
            match placed {
                Placed::InPlace(record) => {
                    self.db.clear_session_transferred(record.local_session)?;
                    self.set_transfer_mark(record.local_session, None, None);
                    let info = self.respawn(record.local_session, true, None, None, false)?;
                    updated_in_place.push(proto::TransferSessionMapping {
                        from: pane.source_session,
                        to: info.id,
                    });
                    session_records.push(TransferSessionRecord {
                        local_session: info.id,
                        source_session: pane.source_session,
                        conversation: pane.conversation.clone(),
                        transcript_path: record.transcript_path.clone(),
                        transcript_sha256: pane.transcript_sha256.clone(),
                    });
                }
                Placed::New {
                    cwd,
                    transcript,
                    env,
                    label,
                } => {
                    let note = (display_path(&cwd) != pane.cwd).then(|| {
                        format!(
                            "Note: this project moved from {} to {} (a Houston workspace transfer). Paths in earlier messages refer to the old location.",
                            pane.cwd,
                            display_path(&cwd)
                        )
                    });
                    let info = self.spawn_transferred_pane(
                        &root,
                        cwd,
                        pane,
                        &transcript,
                        env,
                        label,
                        note,
                    )?;
                    sessions.push(proto::TransferSessionMapping {
                        from: pane.source_session,
                        to: info.id,
                    });
                    session_records.push(TransferSessionRecord {
                        local_session: info.id,
                        source_session: pane.source_session,
                        conversation: pane.conversation.clone(),
                        transcript_path: transcript.display().to_string(),
                        transcript_sha256: pane.transcript_sha256.clone(),
                    });
                }
            }
        }
        self.db.transfer_record(&TransferRecord {
            id: manifest.transfer_id.clone(),
            direction: TransferDirection::Import,
            workspace: display_path(&root),
            created_at_ms: now_ms(),
            checkouts: checkout_plans
                .iter()
                .map(|plan| TransferCheckoutRecord {
                    key: plan.entry.key.clone(),
                    path: display_path(&canonical(&plan.root)),
                    tree_state: None,
                    untracked: plan.entry.untracked.clone(),
                })
                .collect(),
            sessions: session_records,
        })?;
        tracing::info!(
            "imported transfer {} into {} ({} new panes, {} resumed in place)",
            manifest.transfer_id,
            display_path(&root),
            sessions.len(),
            updated_in_place.len()
        );
        Ok(proto::TransferImportResult {
            transfer_id: manifest.transfer_id.clone(),
            workspace: display_path(&root),
            source_workspace: manifest.workspace.path.clone(),
            sessions,
            updated_in_place,
            grids: returning.is_none().then(|| manifest.grids.clone()),
        })
    }

    /// Where a returning pane goes: back into its exported pane, unless that pane
    /// continued after the export (its transcript changed, or it was respawned).
    fn plan_return_pane(
        &self,
        record: TransferSessionRecord,
        forked: &mut Vec<(String, u32)>,
    ) -> PanePlan {
        // A killed pane gave its conversation up; a closed one is no longer listed.
        let exists = |id: u32| {
            self.sessions
                .lock()
                .expect("sessions lock")
                .get(&id)
                .map(|s| s.snapshot_info())
                .or_else(|| self.dead.lock().expect("dead lock").get(&id).cloned())
                .filter(|info| info.state != proto::SessionState::Killed)
        };
        if let Some(tip) = self.respawn_chain_tip(record.local_session) {
            if let Some(info) = exists(tip) {
                forked.push((pane_label(&info), tip));
            }
            return PanePlan::New;
        }
        let Some(info) = exists(record.local_session) else {
            return PanePlan::New;
        };
        let unchanged = checkout::sha256_file(Path::new(&record.transcript_path))
            .is_ok_and(|sha| sha == record.transcript_sha256);
        if !unchanged || info.transferred_at_ms.is_none() {
            forked.push((pane_label(&info), info.id));
            return PanePlan::New;
        }
        PanePlan::InPlace(record)
    }

    #[allow(clippy::too_many_arguments)]
    fn spawn_transferred_pane(
        self: &Arc<Self>,
        root: &Path,
        cwd: PathBuf,
        pane: &PaneEntry,
        transcript: &Path,
        extra_env: Vec<(String, String)>,
        profile_label: Option<String>,
        note: Option<String>,
    ) -> Result<proto::SessionInfo> {
        let provider = pane.provider;
        let mut extra_args = crate::launch::resume_args(provider, &pane.conversation)?;
        let launch_selections = pane
            .launch_selections
            .clone()
            .filter(|selections| selections.provider == provider);
        if let Some(selections) = &launch_selections {
            extra_args.extend(selections.args(provider)?);
        }
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let codename = self.next_codename();
        let info = self.spawn_session(SpawnParams {
            id,
            agent: provider,
            detected_agent: None,
            project_dir: root.to_path_buf(),
            cwd,
            custom_cmd: None,
            cols: 80,
            rows: 24,
            title: pane.title.clone(),
            title_source: TitleSource::User,
            codename,
            tags: Vec::new(),
            shell_integration: true,
            hidden: false,
            shell_override: None,
            swarm_agent: None,
            spawned_by: None,
            extra_args,
            launch_selections,
            shell_startup: None,
            extra_env,
            wrap: None,
            acp: None,
            profile_label,
            session_origin: None,
            resume_handle: Some((
                pane.conversation.clone(),
                Some(transcript.display().to_string()),
            )),
            resume_notice: None,
            scrollback_seed: None,
            replacement: None,
            pastes_first_prompt: note.is_some(),
        })?;
        // Prefilled, not submitted: the note goes out with the user's first message.
        if let Some(note) = note {
            self.deliver_first_prompt(info.id, note, None, false);
        }
        Ok(info)
    }
}

enum Placed {
    InPlace(TransferSessionRecord),
    New {
        cwd: PathBuf,
        transcript: PathBuf,
        env: Vec<(String, String)>,
        label: Option<String>,
    },
}

fn transfer_pane(pane: &PaneEntry) -> proto::TransferPane {
    proto::TransferPane {
        session: pane.source_session,
        title: pane.title.clone(),
        provider: pane.provider,
        checkout: match pane.checkout.strip_prefix(WORKTREE_KEY_PREFIX) {
            Some(slug) => format!("worktree {slug}"),
            None => "main checkout".to_string(),
        },
        profile_label: pane.profile_label.clone(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn remotes_compare_by_host_and_path() {
        let same = [
            "git@github.com:Owner/Repo.git",
            "https://github.com/owner/repo",
            "https://user@github.com/owner/repo.git/",
            "ssh://git@github.com/owner/repo.git",
        ];
        for url in same {
            assert_eq!(normalize_remote(url), "github.com/owner/repo", "{url}");
        }
        assert_ne!(
            normalize_remote("git@github.com:owner/other.git"),
            "github.com/owner/repo"
        );
    }

    #[test]
    fn wsl_paths_are_recognised_in_every_spelling() {
        for path in [
            r"\\wsl$\Ubuntu\home\dev\p",
            r"\\wsl.localhost\Ubuntu\p",
            "//wsl.localhost/Ubuntu/p",
            r"\\?\UNC\wsl$\Ubuntu\p",
        ] {
            assert!(is_wsl_path(path), "{path}");
        }
        assert!(!is_wsl_path(r"C:\dev\houston"));
        assert!(!is_wsl_path("/home/dev/p"));
    }

    #[test]
    fn display_paths_drop_the_verbatim_prefix() {
        assert_eq!(
            display_path(Path::new(r"\\?\C:\dev\houston")),
            r"C:\dev\houston"
        );
        assert_eq!(display_path(Path::new("/home/dev/p")), "/home/dev/p");
    }
}
