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
    crate::transfer::paths::plain(path).display().to_string()
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
    crate::transfer::paths::canonical(path)
}

/// One transfer at a time per workspace, keyed by state directory too so that daemons
/// sharing a process do not see each other's.
static RUNNING: std::sync::LazyLock<std::sync::Mutex<HashSet<(PathBuf, PathBuf)>>> =
    std::sync::LazyLock::new(Default::default);

struct RunningTransfer((PathBuf, PathBuf));

impl Drop for RunningTransfer {
    fn drop(&mut self) {
        RUNNING
            .lock()
            .expect("running transfers lock")
            .remove(&self.0);
    }
}

fn begin_transfer(state_dir: &Path, root: &Path, name: &str) -> Result<RunningTransfer> {
    let key = (state_dir.to_path_buf(), root.to_path_buf());
    if !RUNNING
        .lock()
        .expect("running transfers lock")
        .insert(key.clone())
    {
        return Err(refuse(
            Code::TransferRunning,
            format!("A transfer is already running for {name}."),
            vec![display_path(root)],
            vec!["Wait for it to finish, then try again.".into()],
        ));
    }
    Ok(RunningTransfer(key))
}

/// A scratch folder for one transfer. It holds unencrypted code and conversations, so
/// only its owner may read it; a crash leaves it for `sweep_transfer_scratch`.
fn scratch_dir(state_dir: &Path, purpose: &str) -> Result<tempfile::TempDir> {
    let mut builder = tempfile::Builder::new();
    builder.prefix(SCRATCH_PREFIX);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        builder.permissions(std::fs::Permissions::from_mode(0o700));
    }
    builder
        .tempdir_in(state_dir)
        .with_context(|| format!("creating a scratch folder for the {purpose}"))
}

const SCRATCH_PREFIX: &str = "transfer-";

fn sweep_scratch(state_dir: &Path) {
    let Ok(entries) = std::fs::read_dir(state_dir) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with(SCRATCH_PREFIX) && entry.file_type().is_ok_and(|t| t.is_dir()) {
            if let Err(e) = std::fs::remove_dir_all(entry.path()) {
                tracing::warn!(
                    "removing stale transfer scratch {}: {e}",
                    entry.path().display()
                );
            }
        }
    }
}

/// What makes a live pane too busy to stop for an export.
fn busy_word(info: &proto::SessionInfo) -> Option<&'static str> {
    if !info.state.is_live() {
        return None;
    }
    match info.status {
        Some(proto::AgentStatus::Working) => Some("working"),
        Some(proto::AgentStatus::NeedsInput) => Some("waiting for input"),
        Some(proto::AgentStatus::Spawning) => Some("starting"),
        Some(proto::AgentStatus::Idle) => None,
        None | Some(proto::AgentStatus::Unavailable) => {
            (info.agent != proto::AgentKind::Shell).then_some("status unknown")
        }
    }
}

/// A turn that began before its pane was stopped: the status the pane last reported.
fn interrupted_word(info: &proto::SessionInfo) -> Option<&'static str> {
    match info.status {
        Some(proto::AgentStatus::Working) => Some("working"),
        Some(proto::AgentStatus::NeedsInput) => Some("waiting for input"),
        Some(proto::AgentStatus::Spawning) => Some("starting"),
        _ => None,
    }
}

/// Adds to a failed export that its panes were stopped and stay unmarked.
fn with_stopped(error: anyhow::Error, stopped: &[String]) -> anyhow::Error {
    if stopped.is_empty() {
        return error;
    }
    let note = format!(
        "Stopped for this export and not marked as transferred: {}",
        stopped.join(", ")
    );
    let step = "Restart those panes to continue on this computer.".to_string();
    match crate::transfer::refusal(&error) {
        Some(refusal) => {
            let mut refusal = refusal.clone();
            refusal.items.push(note);
            refusal.steps.push(step);
            anyhow::Error::new(crate::transfer::Refused(refusal))
        }
        None => error.context(format!("{note}. {step}")),
    }
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

/// What an import changed, in order. Each step is logged before its change is made, so
/// a failure halfway through a step still undoes it.
#[derive(Default)]
struct ImportUndo {
    steps: Vec<UndoStep>,
}

enum UndoStep {
    /// A checkout left `position`; a return trip also set its local changes aside.
    Moved {
        dir: PathBuf,
        position: checkout::Position,
        saved: Option<checkout::SavedChanges>,
    },
    /// The branch pointed at `tip`, or did not exist.
    Branch {
        repo: PathBuf,
        branch: String,
        tip: Option<String>,
    },
    Worktree {
        repo: PathBuf,
        path: PathBuf,
    },
    Created(PathBuf),
    Replaced {
        path: PathBuf,
        backup: PathBuf,
    },
    Recorded(String),
    /// A pane whose transfer mark was cleared.
    Unmarked {
        session: u32,
        at_ms: u64,
    },
    /// A return trip's pane, resumed in place.
    Resumed {
        session: u32,
        at_ms: u64,
    },
    Spawned(u32),
}

/// The refusal for a failed import whose changes `undo_import` reversed.
fn undone(error: anyhow::Error, changed: bool, failures: Vec<String>) -> anyhow::Error {
    let mut refusal = match crate::transfer::refusal(&error) {
        Some(refusal) => refusal.clone(),
        None => proto::TransferRefusal {
            code: Code::ImportUndone,
            problem: format!("Import stopped and was undone: {error:#}"),
            items: Vec::new(),
            steps: vec!["Remove the cause named above, then import again.".into()],
        },
    };
    if failures.is_empty() {
        if changed && refusal.code != Code::ImportUndone {
            refusal
                .items
                .push("Houston undid the changes this import had made.".into());
        }
    } else {
        refusal
            .items
            .extend(failures.into_iter().map(|f| format!("not undone: {f}")));
        refusal
            .steps
            .push("Put the listed items back by hand before importing again.".into());
    }
    anyhow::Error::new(crate::transfer::Refused(refusal))
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

    #[allow(clippy::too_many_arguments)]
    pub(crate) fn transfer_export(
        self: &Arc<Self>,
        workspace: &str,
        destination: &str,
        overwrite: bool,
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
        if destination.exists() && !overwrite {
            return Err(refuse(
                Code::DestinationExists,
                format!(
                    "A file already exists at {}, and replacing it was not confirmed.",
                    display_path(&destination)
                ),
                vec![display_path(&destination)],
                vec!["Export again and choose another name, or pick that file in the save dialog and confirm replacing it.".into()],
            ));
        }
        let (workspace, root) = self.transfer_workspace(workspace)?;
        let _running = begin_transfer(self.state_dir(), &root, &workspace.name)?;
        progress(proto::TransferStage::Checking);
        let outside = self.outside_worktrees(&root);
        let panes: Vec<proto::SessionInfo> = self
            .list()
            .into_iter()
            .filter(|info| !info.hidden && Self::in_workspace(info, &root, &outside))
            .collect();
        let busy: Vec<String> = panes
            .iter()
            .filter_map(|info| busy_word(info).map(|word| format!("{}: {word}", pane_label(info))))
            .collect();
        if !busy.is_empty() {
            return Err(Self::busy_refusal(&workspace.name, busy));
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
            return Err(Self::nothing_refusal(&workspace.name, &skipped));
        }
        let mut partial = Vec::new();
        let mut roots: Vec<&PathBuf> = Vec::new();
        for c in &candidates {
            if !roots.contains(&&c.checkout_root) {
                roots.push(&c.checkout_root);
            }
        }
        let mut invalid = Vec::new();
        for tree in &roots {
            let files = checkout::untracked_files(tree)?;
            for problem in crate::transfer::paths::untracked_problems(&files) {
                invalid.push(format!("{problem} (in {})", display_path(tree)));
            }
        }
        if !invalid.is_empty() {
            return Err(refuse(
                Code::DirtyCheckout,
                "Some untracked files have names a transfer to another computer cannot carry.",
                invalid,
                vec!["Rename, ignore or delete each listed file, then export again.".into()],
            ));
        }
        for tree in roots {
            for path in checkout::partially_staged(tree)? {
                partial.push(format!("{path} (in {})", display_path(tree)));
            }
        }
        if !partial.is_empty() {
            return Err(refuse(
                Code::PartiallyStaged,
                "Some files have staged changes that differ from the working copy, and a transfer carries only the working copy.",
                partial,
                vec!["Stage or unstage these files completely, then export again.".into()],
            ));
        }

        // Stop before capturing, so no turn can change the code or conversation while it
        // is read. A pane that does not stop stays out of the file.
        let mut stopped = Vec::new();
        let mut kept = Vec::new();
        for c in candidates {
            if !c.info.state.is_live() {
                kept.push(c);
                continue;
            }
            match self.stop_for_transfer(c.info.id) {
                Ok(()) => {
                    stopped.push(pane_label(&c.info));
                    kept.push(c);
                }
                Err(e) => skipped.push(proto::TransferSkipped {
                    session: c.info.id,
                    title: c.info.title.clone(),
                    reason: format!("not transferred: it could not be stopped ({e:#})"),
                }),
            }
        }
        let candidates = kept;
        let after = self.list();
        let interrupted: Vec<String> = candidates
            .iter()
            .filter_map(|c| {
                let info = after.iter().find(|info| info.id == c.info.id)?;
                interrupted_word(info).map(|word| format!("{}: {word}", pane_label(info)))
            })
            .collect();
        if !interrupted.is_empty() {
            return Err(with_stopped(
                Self::busy_refusal(&workspace.name, interrupted),
                &stopped,
            ));
        }
        if candidates.is_empty() {
            return Err(with_stopped(
                Self::nothing_refusal(&workspace.name, &skipped),
                &stopped,
            ));
        }

        progress(proto::TransferStage::Packing);
        let packed = self.pack_export(
            &workspace,
            &root,
            &candidates,
            &skipped,
            &destination,
            passphrase,
            grids,
        );
        let (manifest, written, checkout_records, session_records) = match packed {
            Ok(packed) => packed,
            Err(error) => return Err(with_stopped(error, &stopped)),
        };
        self.db.transfer_record(&TransferRecord {
            id: manifest.transfer_id.clone(),
            direction: TransferDirection::Export,
            workspace: display_path(&root),
            created_at_ms: manifest.created_at_ms,
            checkouts: checkout_records,
            sessions: session_records,
        })?;
        for c in &candidates {
            self.set_transfer_mark(c.info.id, Some(manifest.created_at_ms), None);
        }
        tracing::info!(
            "exported transfer {} of {} ({} panes, {written} bytes)",
            manifest.transfer_id,
            display_path(&root),
            candidates.len()
        );
        Ok(proto::TransferExportSummary {
            transfer_id: manifest.transfer_id.clone(),
            file: display_path(&destination),
            bytes: written,
            panes: manifest.panes.iter().map(transfer_pane).collect(),
            skipped,
            skipped_links: manifest.skipped_links.clone(),
        })
    }

    fn busy_refusal(workspace: &str, busy: Vec<String>) -> anyhow::Error {
        refuse(
            Code::BusyPanes,
            format!(
                "{} in {workspace} {} still busy, and a transfer stops every exported pane.",
                count(busy.len(), "pane", "panes"),
                if busy.len() == 1 { "is" } else { "are" },
            ),
            busy,
            vec!["Let each listed pane finish its turn, or answer it, then export again. A pane whose status is unknown reports no status; turn its status hooks on in Settings ▸ Agents ▸ CLIs, or close the pane.".into()],
        )
    }

    fn nothing_refusal(workspace: &str, skipped: &[proto::TransferSkipped]) -> anyhow::Error {
        refuse(
            Code::NothingToTransfer,
            format!("{workspace} has no Claude or Codex pane with a recorded conversation to transfer."),
            skipped
                .iter()
                .map(|s| format!("{} (pane {}): {}", s.title, s.session, s.reason))
                .collect(),
            vec!["Start or resume a Claude or Codex pane in this workspace, let it finish a turn, then export again.".into()],
        )
    }

    /// Captures the code and conversations and writes the encrypted file.
    #[allow(clippy::too_many_arguments, clippy::type_complexity)]
    fn pack_export(
        &self,
        workspace: &proto::Workspace,
        root: &Path,
        candidates: &[Candidate],
        skipped: &[proto::TransferSkipped],
        destination: &Path,
        passphrase: &proto::TransferPassphrase,
        grids: String,
    ) -> Result<(
        Manifest,
        u64,
        Vec<TransferCheckoutRecord>,
        Vec<TransferSessionRecord>,
    )> {
        let transfer_id = uuid::Uuid::new_v4().to_string();
        let scratch = scratch_dir(self.state_dir(), "export")?;
        let mut checkout_order: Vec<(String, PathBuf, Option<String>)> = Vec::new();
        for c in candidates {
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
        for c in candidates {
            if !providers.contains(&c.info.agent) {
                providers.push(c.info.agent);
            }
        }
        let manifest = Manifest {
            format: FORMAT_VERSION,
            transfer_id: transfer_id.clone(),
            created_at_ms: now_ms(),
            source_os: std::env::consts::OS.to_string(),
            houston_version: env!("CARGO_PKG_VERSION").to_string(),
            workspace: WorkspaceEntry {
                path: display_path(root),
                name: workspace.name.clone(),
                remote_url: crate::git::remote_url(root),
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
            skipped: skipped.to_vec(),
            skipped_links,
            grids,
        };
        let file_name = destination
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default();
        let partial = destination.with_file_name(format!(".{file_name}.{transfer_id}.partial"));
        let written = match archive::write(&partial, passphrase.expose(), &manifest, &entries) {
            Ok(written) => written,
            Err(error) => {
                let _ = std::fs::remove_file(&partial);
                return Err(error);
            }
        };
        if let Err(error) = std::fs::rename(&partial, destination) {
            let _ = std::fs::remove_file(&partial);
            return Err(error)
                .with_context(|| format!("moving the transfer file to {}", destination.display()));
        }
        Ok((manifest, written, checkout_records, session_records))
    }

    /// Removes scratch folders a crashed transfer left in the state directory.
    pub(crate) fn sweep_transfer_scratch(&self) {
        sweep_scratch(self.state_dir());
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
        let diff = plan.source.join("tracked.diff");
        if entry.diff {
            if let Some(error) = checkout::diff_apply_error(repo, &entry.head, &diff)? {
                return Err(refuse(
                    Code::ChangesDoNotApply,
                    format!(
                        "The uncommitted changes the file carries for {target} do not apply to commit {} on this computer.",
                        crate::transfer::manifest::short(&entry.head)
                    ),
                    error.lines().map(str::to_string).collect(),
                    vec![
                        "Export again on the other computer, then import the new file.".into(),
                        "If the refusal repeats, commit the changes there and transfer again.".into(),
                    ],
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
            // Checking out the file's commits and applying its changes would replace
            // ignored files (a local .env) at the paths they add, so those count too.
            let mut carried = entry.untracked.clone();
            let current = checkout::head(&plan.root)?;
            if current != entry.head {
                carried.extend(checkout::added_between(&plan.root, &current, &entry.head)?);
            }
            if entry.diff {
                carried.extend(checkout::created_by_diff(repo, &diff)?);
            }
            carried.sort();
            carried.dedup();
            let collisions = checkout::untracked_collisions(&plan.root, &carried, ignore)?;
            if !collisions.is_empty() {
                return Err(refuse(
                    Code::PathsExist,
                    format!("Files the transfer carries or adds already exist in {target}, and import does not overwrite them."),
                    collisions,
                    vec![format!("Move or delete the listed files in {target}, ignored files included, then import again.")],
                ));
            }
        }
        Ok(())
    }

    fn apply_checkout_plan(
        &self,
        repo: &Path,
        plan: &CheckoutPlan,
        saved_dir: &Path,
        undo: &mut ImportUndo,
    ) -> Result<()> {
        let entry = plan.entry;
        if let Some(branch) = &entry.branch {
            undo.steps.push(UndoStep::Branch {
                repo: repo.to_path_buf(),
                branch: branch.clone(),
                tip: checkout::branch_tip(repo, branch)?,
            });
        }
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
                undo.steps.push(UndoStep::Worktree {
                    repo: repo.to_path_buf(),
                    path: crate::worktrees::spawn_path(repo, slug),
                });
                self.create_transfer_worktree(repo, slug, branch, &entry.head)?;
            }
            CheckoutMode::ReturnTrip {
                exported_untracked, ..
            } => {
                let position = checkout::position(&plan.root)?;
                let saved = checkout::save_changes(&plan.root, saved_dir, exported_untracked)?;
                undo.steps.push(UndoStep::Moved {
                    dir: plan.root.clone(),
                    position,
                    saved: Some(saved),
                });
                checkout::restore_exported_state(&plan.root, exported_untracked)?;
                checkout::move_to(&plan.root, entry.branch.as_deref(), &entry.head)?;
            }
            CheckoutMode::Existing => {
                undo.steps.push(UndoStep::Moved {
                    dir: plan.root.clone(),
                    position: checkout::position(&plan.root)?,
                    saved: None,
                });
                checkout::move_to(&plan.root, entry.branch.as_deref(), &entry.head)?;
            }
        }
        if entry.diff {
            checkout::apply_diff(&plan.root, &plan.source.join("tracked.diff"))?;
        }
        let mut written = Vec::new();
        let result = checkout::write_untracked(
            &plan.root,
            &plan.source.join("untracked"),
            &entry.untracked,
            &mut written,
        );
        undo.steps
            .extend(written.into_iter().map(UndoStep::Created));
        result
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
                crate::worktrees::create_task(
                    repo,
                    branch,
                    None,
                    &dest,
                    &self.merge_tree_scratch(),
                )?;
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
        let (workspace, root) = self.transfer_workspace(workspace)?;
        let _running = begin_transfer(self.state_dir(), &root, &workspace.name)?;
        progress(proto::TransferStage::Decrypting);
        let scratch = scratch_dir(self.state_dir(), "import")?;
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

        let mut undo = ImportUndo::default();
        let applied = self.apply_import(
            &manifest,
            &root,
            scratch.path(),
            &checkout_plans,
            pane_plans.into_iter().zip(profiles).collect(),
            progress,
            &mut undo,
        );
        let (sessions, updated_in_place) = match applied {
            Ok(applied) => applied,
            Err(error) => {
                tracing::warn!(
                    "import of transfer {} into {} failed, undoing it: {error:#}",
                    manifest.transfer_id,
                    display_path(&root)
                );
                let changed = !undo.steps.is_empty();
                let failures = self.undo_import(undo);
                return Err(undone(error, changed, failures));
            }
        };
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

    /// Every change of an import, each logged in `undo` before it is made.
    #[allow(clippy::too_many_arguments, clippy::type_complexity)]
    fn apply_import(
        self: &Arc<Self>,
        manifest: &Manifest,
        root: &Path,
        scratch: &Path,
        checkout_plans: &[CheckoutPlan],
        panes: Vec<(PanePlan, ProfileSpawnEnvList)>,
        progress: Progress,
        undo: &mut ImportUndo,
    ) -> Result<(
        Vec<proto::TransferSessionMapping>,
        Vec<proto::TransferSessionMapping>,
    )> {
        progress(proto::TransferStage::RestoringCode);
        for (n, plan) in checkout_plans.iter().enumerate() {
            self.apply_checkout_plan(root, plan, &scratch.join(format!("saved-{n}")), undo)
                .with_context(|| {
                    format!("restoring the code state of {}", display_path(&plan.root))
                })?;
        }

        progress(proto::TransferStage::PlacingConversations);
        let mut placements = Vec::new();
        for (pane, (plan, (env, label))) in manifest.panes.iter().zip(panes) {
            let source = scratch.join(&pane.archive_dir);
            let files: Vec<String> = std::iter::once(pane.transcript.clone())
                .chain(pane.extra_files.iter().cloned())
                .collect();
            let (place_root, placed) = match plan {
                PanePlan::InPlace(record) => {
                    let transcript = PathBuf::from(&record.transcript_path);
                    let place_root = match pane.provider {
                        proto::AgentKind::Claude => transcript
                            .parent()
                            .context("a recorded transcript has a folder")?
                            .to_path_buf(),
                        _ => {
                            transcripts::collect(pane.provider, &transcript, &pane.conversation)?
                                .root
                        }
                    };
                    (place_root, Placed::InPlace(record))
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
                    let cwd = if cwd.is_dir() {
                        cwd
                    } else {
                        root.to_path_buf()
                    };
                    let provider_dir = self.transfer_provider_dir(pane.provider, &env)?;
                    let place_root = transcripts::place_root(pane.provider, &provider_dir, &cwd);
                    let transcript = transcripts::join(&place_root, &pane.transcript);
                    (
                        place_root,
                        Placed::New {
                            cwd,
                            transcript,
                            env,
                            label,
                        },
                    )
                }
            };
            placements.push((pane, source, files, place_root, placed));
        }
        let mut clashes = Vec::new();
        for (pane, source, files, place_root, placed) in &placements {
            if matches!(placed, Placed::InPlace(_)) {
                continue;
            }
            for path in transcripts::differing(source, place_root, files)? {
                clashes.push(format!(
                    "{} (conversation {}, {})",
                    display_path(&path),
                    pane.conversation,
                    self.conversation_holder(&pane.conversation)
                ));
            }
        }
        if !clashes.is_empty() {
            return Err(refuse(
                Code::PathsExist,
                "Another version of a transferred conversation already exists on this computer, and import does not overwrite it.",
                clashes,
                vec![
                    "Keep that version: import the file on another computer.".into(),
                    "Or close the listed pane and move the listed files out of the way, then import again.".into(),
                ],
            ));
        }
        let backups = scratch.join("replaced");
        std::fs::create_dir_all(&backups)
            .with_context(|| format!("creating {}", backups.display()))?;
        for (_, source, files, place_root, _) in &placements {
            for relative in files {
                let dest = crate::transfer::paths::inside(place_root, relative)?;
                if std::fs::symlink_metadata(&dest).is_ok() {
                    let backup = backups.join(undo.steps.len().to_string());
                    std::fs::copy(&dest, &backup)
                        .with_context(|| format!("keeping a copy of {}", dest.display()))?;
                    undo.steps.push(UndoStep::Replaced { path: dest, backup });
                } else {
                    undo.steps.push(UndoStep::Created(dest));
                }
                transcripts::copy_file(source, place_root, relative)?;
            }
        }

        // Recorded before any pane starts, so a crash while starting them still leaves
        // the return trip's record.
        let mut record = TransferRecord {
            id: manifest.transfer_id.clone(),
            direction: TransferDirection::Import,
            workspace: display_path(root),
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
            sessions: Vec::new(),
        };
        undo.steps
            .push(UndoStep::Recorded(manifest.transfer_id.clone()));
        self.db.transfer_record(&record)?;

        progress(proto::TransferStage::StartingPanes);
        let mut sessions = Vec::new();
        let mut updated_in_place = Vec::new();
        for (pane, _, _, _, placed) in placements {
            match placed {
                Placed::InPlace(old) => {
                    let (at, _) = self.db.session_transfer_mark(old.local_session)?;
                    let at = at.unwrap_or(manifest.created_at_ms);
                    undo.steps.push(UndoStep::Unmarked {
                        session: old.local_session,
                        at_ms: at,
                    });
                    self.db.clear_session_transferred(old.local_session)?;
                    self.set_transfer_mark(old.local_session, None, None);
                    let info = self.respawn(old.local_session, true, None, None, false)?;
                    undo.steps.push(UndoStep::Resumed {
                        session: info.id,
                        at_ms: at,
                    });
                    updated_in_place.push(proto::TransferSessionMapping {
                        from: pane.source_session,
                        to: info.id,
                    });
                    record.sessions.push(TransferSessionRecord {
                        local_session: info.id,
                        source_session: pane.source_session,
                        conversation: pane.conversation.clone(),
                        transcript_path: old.transcript_path.clone(),
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
                        root,
                        cwd,
                        pane,
                        &transcript,
                        env,
                        label,
                        note,
                    )?;
                    undo.steps.push(UndoStep::Spawned(info.id));
                    sessions.push(proto::TransferSessionMapping {
                        from: pane.source_session,
                        to: info.id,
                    });
                    record.sessions.push(TransferSessionRecord {
                        local_session: info.id,
                        source_session: pane.source_session,
                        conversation: pane.conversation.clone(),
                        transcript_path: transcript.display().to_string(),
                        transcript_sha256: pane.transcript_sha256.clone(),
                    });
                }
            }
            self.db.transfer_record(&record)?;
        }
        Ok((sessions, updated_in_place))
    }

    /// The pane that holds `conversation` on this computer, for a refusal.
    fn conversation_holder(&self, conversation: &str) -> String {
        let holders = self
            .db
            .sessions_naming_conversation(conversation)
            .unwrap_or_default();
        let listed = self.list();
        let dead = self.dead.lock().expect("dead lock");
        let names: Vec<String> = holders
            .iter()
            .filter_map(|id| {
                listed
                    .iter()
                    .find(|info| info.id == *id)
                    .or_else(|| dead.get(id))
                    .map(pane_label)
            })
            .collect();
        if names.is_empty() {
            "no pane on this computer holds it".to_string()
        } else {
            format!("held by {}", names.join(", "))
        }
    }

    /// Reverses `undo` from the last change to the first and returns what failed.
    fn undo_import(&self, undo: ImportUndo) -> Vec<String> {
        let mut failures = Vec::new();
        for step in undo.steps.into_iter().rev() {
            let result = match &step {
                UndoStep::Spawned(id) => self
                    .close(*id)
                    .or_else(|_| self.kill(*id).and_then(|()| self.close(*id)))
                    .with_context(|| format!("closing pane {id}")),
                UndoStep::Resumed { session, at_ms } => {
                    let stopped = self
                        .stop_for_transfer(*session)
                        .with_context(|| format!("stopping pane {session}"));
                    self.set_transfer_mark(*session, Some(*at_ms), None);
                    stopped.and(self.db.set_session_transferred(*session, *at_ms))
                }
                UndoStep::Unmarked { session, at_ms } => {
                    self.set_transfer_mark(*session, Some(*at_ms), None);
                    self.db.set_session_transferred(*session, *at_ms)
                }
                UndoStep::Recorded(id) => self.db.transfer_forget(id, TransferDirection::Import),
                UndoStep::Created(path) => match std::fs::remove_file(path) {
                    Err(e) if e.kind() != std::io::ErrorKind::NotFound => {
                        Err(e).with_context(|| format!("removing {}", display_path(path)))
                    }
                    _ => Ok(()),
                },
                UndoStep::Replaced { path, backup } => std::fs::rename(backup, path)
                    .with_context(|| format!("restoring {}", display_path(path))),
                UndoStep::Worktree { repo, path } => {
                    let recorded = canonical(path);
                    let removed = if path.exists() {
                        crate::worktrees::remove(repo, path, true)
                    } else {
                        Ok(())
                    };
                    removed
                        .and(
                            self.db
                                .managed_worktree_delete(&recorded.display().to_string()),
                        )
                        .with_context(|| format!("removing worktree {}", display_path(path)))
                }
                UndoStep::Branch { repo, branch, tip } => {
                    checkout::restore_branch(repo, branch, tip.as_deref())
                        .with_context(|| format!("resetting branch {branch}"))
                }
                UndoStep::Moved {
                    dir,
                    position,
                    saved,
                } => checkout::restore_position(dir, position)
                    .and_then(|()| {
                        saved
                            .as_ref()
                            .map_or(Ok(()), |s| checkout::put_back(dir, s))
                    })
                    .with_context(|| format!("putting {} back", display_path(dir))),
            };
            if let Err(e) = result {
                tracing::warn!("undoing a transfer import: {e:#}");
                failures.push(format!("{e:#}"));
            }
        }
        failures
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

    #[test]
    fn a_second_transfer_of_one_workspace_is_refused_until_the_first_ends() {
        let state = Path::new("/state");
        let root = Path::new("/work/app");
        let first = begin_transfer(state, root, "app").unwrap();
        let Err(refused) = begin_transfer(state, root, "app") else {
            panic!("a second transfer of one workspace starts");
        };
        assert_eq!(
            crate::transfer::refusal(&refused).map(|r| r.code),
            Some(Code::TransferRunning)
        );
        assert!(begin_transfer(Path::new("/other-state"), root, "app").is_ok());
        assert!(begin_transfer(state, Path::new("/work/other"), "other").is_ok());
        drop(first);
        assert!(begin_transfer(state, root, "app").is_ok());
    }

    #[test]
    fn a_live_agent_pane_without_a_status_is_busy() {
        let mut info = crate::db::tests::info(1, proto::SessionState::Running);
        info.agent = proto::AgentKind::Claude;
        info.status = None;
        assert_eq!(busy_word(&info), Some("status unknown"));
        info.status = Some(proto::AgentStatus::Idle);
        assert_eq!(busy_word(&info), None);
        info.status = Some(proto::AgentStatus::Working);
        assert_eq!(busy_word(&info), Some("working"));
        info.agent = proto::AgentKind::Shell;
        info.status = None;
        assert_eq!(busy_word(&info), None, "a shell reports no status");
        info.agent = proto::AgentKind::Claude;
        info.state = proto::SessionState::Exited;
        info.status = Some(proto::AgentStatus::Working);
        assert_eq!(
            busy_word(&info),
            None,
            "an exited pane is not running a turn"
        );
        assert_eq!(
            interrupted_word(&info),
            Some("working"),
            "a pane stopped mid-turn is named after the stop"
        );
    }

    #[test]
    fn scratch_folders_are_private_and_swept() {
        let state = tempfile::tempdir().unwrap();
        let scratch = scratch_dir(state.path(), "test").unwrap().keep();
        std::fs::write(scratch.join("bundle"), "plaintext").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&scratch).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o700);
        }
        std::fs::create_dir(state.path().join("worktrees")).unwrap();
        sweep_scratch(state.path());
        assert!(!scratch.exists());
        assert!(
            state.path().join("worktrees").is_dir(),
            "other folders stay"
        );
    }
}
