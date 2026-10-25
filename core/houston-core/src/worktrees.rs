use anyhow::{bail, Context, Result};
use std::path::{Path, PathBuf};
use std::time::Duration;

const BRANCH_PREFIX: &str = "houston/task/";

/// A managed creation budgets its `.worktreeinclude` copy at 30 s; a submodule
/// init past the same budget is abandoned with a warning, never a stalled spawn.
const SUBMODULE_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Worktree {
    pub path: PathBuf,
    pub branch: Option<String>,
    pub head: Option<String>,
    pub is_main: bool,
    pub is_bare: bool,
    pub is_detached: bool,
}

pub fn branch_for_task(task_id: &str) -> String {
    format!("{BRANCH_PREFIX}{}", crate::git::ref_slug(task_id))
}

pub fn default_path(state_dir: &Path, project_id: &str, task_id: &str) -> PathBuf {
    state_dir
        .join("worktrees")
        .join(crate::git::ref_slug(project_id))
        .join(crate::git::ref_slug(task_id))
}

pub fn create(repo: &Path, task_id: &str, base: Option<&str>, dest: &Path) -> Result<Worktree> {
    ensure_git_repo(repo)?;
    if dest.exists() {
        bail!(
            "worktree path {} is already occupied; a task gets a fresh directory",
            dest.display()
        );
    }
    let branch = branch_for_task(task_id);
    if branch_exists(repo, &branch) {
        bail!(
            "branch {branch:?} already exists for task {task_id:?}; remove it or use another task"
        );
    }
    let base = match base {
        Some(b) => {
            if !ref_exists(repo, b) {
                bail!(
                    "base ref {b:?} does not exist in {}; expected an existing branch, tag or commit",
                    repo.display()
                );
            }
            b.to_string()
        }
        None => crate::git::default_base(repo).unwrap_or_else(|| "HEAD".to_string()),
    };
    add_worktree(repo, &branch, &base, dest)
}

pub fn list(repo: &Path) -> Result<Vec<Worktree>> {
    ensure_git_repo(repo)?;
    let raw = run_git(repo, &["worktree", "list", "--porcelain"])?;
    Ok(parse_list(&raw))
}

/// What a `pane_spawn` caller asks for: a slug for the directory and, optionally, the
/// branch to create in place of `houston/<slug>`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SpawnWorktree {
    pub slug: String,
    pub branch: Option<String>,
}

/// The two spawn arguments as one ask; a branch with nowhere to check it out is refused.
pub fn spawn_ask(
    worktree: Option<String>,
    branch: Option<String>,
) -> Result<Option<SpawnWorktree>> {
    match (worktree, branch) {
        (Some(slug), branch) => Ok(Some(SpawnWorktree { slug, branch })),
        (None, Some(b)) => bail!(
            "spawn refused: `branch` {b:?} names the branch of a new worktree, so it needs \
             `worktree` too"
        ),
        (None, None) => Ok(None),
    }
}

/// A panel worktree: branch `houston/<slug>` off `base`, at `dest`. The task
/// flavour above stays for orchestrator runs; this one is named and untracked
/// by any task, so a collision is refused by name.
pub fn create_named(repo: &Path, slug: &str, base: Option<&str>, dest: &Path) -> Result<Worktree> {
    let slug = crate::git::ref_slug(slug);
    create_on_branch(repo, &format!("houston/{slug}"), base, dest)
}

/// Where `pane_spawn` puts the worktree it was asked for: inside the workspace, so the
/// child's cwd passes the same "inside the target workspace" rule any cwd does.
pub fn spawn_path(workspace: &Path, slug: &str) -> PathBuf {
    workspace
        .join(crate::paths::PROJECT_DIR)
        .join("worktrees")
        .join(slug)
}

/// A slug becomes one directory name under `.houston/worktrees/`, so anything that could
/// climb out of it or split it is refused rather than rewritten.
pub fn validate_slug(slug: &str) -> Result<()> {
    let rule = if slug.is_empty() {
        Some("it is empty")
    } else if slug.contains('/') || slug.contains('\\') {
        Some("it contains a path separator")
    } else if slug == "." {
        Some("it is `.`")
    } else if slug.chars().any(char::is_control) {
        Some("it contains a control character (including NUL)")
    } else if slug.len() > 255 {
        Some("it exceeds the limit of 255 bytes")
    } else if slug.contains("..") {
        Some("it contains `..`")
    } else if slug.chars().any(char::is_whitespace) {
        Some("it contains whitespace")
    } else {
        None
    };
    match rule {
        Some(rule) => bail!(
            "worktree slug {slug:?} is refused: {rule}; a slug is one directory name, \
             e.g. \"fix-login\""
        ),
        None => Ok(()),
    }
}

/// A Houston-managed subtree of a user workspace must not show in its `git status`;
/// one `*` keeps the whole directory out, as `.houston/swarm/` does. A file already
/// there is left alone.
pub fn ensure_ignored(dir: &Path) -> Result<()> {
    std::fs::create_dir_all(dir).with_context(|| format!("creating {}", dir.display()))?;
    let gitignore = dir.join(".gitignore");
    if !gitignore.exists() {
        std::fs::write(&gitignore, "*\n")
            .with_context(|| format!("writing {}", gitignore.display()))?;
    }
    Ok(())
}

pub fn create_on_branch(
    repo: &Path,
    branch: &str,
    base: Option<&str>,
    dest: &Path,
) -> Result<Worktree> {
    ensure_git_repo(repo)?;
    crate::git::validate_branch_name(branch)?;
    let branch = branch.to_string();
    let base = match base {
        Some(b) => {
            if !ref_exists(repo, b) {
                bail!(
                    "base ref {b:?} does not exist in {}; expected an existing branch, tag or commit",
                    repo.display()
                );
            }
            b.to_string()
        }
        None => crate::git::default_base(repo).unwrap_or_else(|| "HEAD".to_string()),
    };
    if dest.exists() {
        bail!(
            "worktree path {} is already occupied; nothing was created",
            dest.display()
        );
    }
    if branch_exists(repo, &branch) {
        bail!("branch {branch:?} already exists; remove its worktree or pick another name");
    }
    add_worktree(repo, &branch, &base, dest)
}

/// A named branch only one remote has continues that branch and tracks it, as `git
/// switch` does, unless `base` already holds its changes (a merged PR's stale remote
/// ref); otherwise it is a fresh branch off `base`, never guessing between remotes.
pub fn create_on_named_branch(
    repo: &Path,
    branch: &str,
    base: Option<&str>,
    dest: &Path,
) -> Result<Worktree> {
    ensure_git_repo(repo)?;
    crate::git::validate_branch_name(branch)?;
    let remote = if branch_exists(repo, branch) {
        None
    } else {
        sole_remote_branch(repo, branch)
    };
    let Some(remote) = remote.filter(|r| !integrated_into_base(repo, r, base)) else {
        return create_on_branch(repo, branch, base, dest);
    };
    let tree = create_on_branch(repo, branch, Some(&remote), dest)?;
    // Tracking is a convenience: the tree already holds the remote's commits.
    let upstream = format!("--set-upstream-to={remote}");
    if let Err(e) = run_git(repo, &["branch", &upstream, branch]) {
        tracing::warn!("worktree branch {branch:?} continues {remote} but tracks nothing: {e:#}");
    }
    Ok(tree)
}

/// `refs/remotes/<remote>/<branch>` when exactly one remote has `branch` and no other
/// remote's name could claim that ref (remotes `a` and `a/b` both read `a/b/c`).
fn sole_remote_branch(repo: &Path, branch: &str) -> Option<String> {
    let remotes = run_git(repo, &["remote"]).ok()?;
    let remotes: Vec<&str> = remotes
        .lines()
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .collect();
    let mut found = remotes
        .iter()
        .map(|name| format!("{name}/{branch}"))
        .filter(|short| ref_exists(repo, &format!("refs/remotes/{short}")));
    let short = found.next()?;
    if found.next().is_some() {
        return None;
    }
    let claimants = remotes
        .iter()
        .filter(|name| short.starts_with(&format!("{name}/")))
        .count();
    (claimants == 1).then(|| format!("refs/remotes/{short}"))
}

/// Whether `base` (or the default base) already has `remote`'s changes. An answer Git
/// cannot give counts as integrated: a fresh branch loses nothing the remote keeps.
fn integrated_into_base(repo: &Path, remote: &str, base: Option<&str>) -> bool {
    let base = match base {
        Some(b) => b.to_string(),
        None => crate::git::default_base(repo).unwrap_or_else(|| "HEAD".to_string()),
    };
    let Some(common_dir) = crate::git::checkout_facts(repo).common_dir else {
        return true;
    };
    match crate::conflict_prediction::is_integrated(Path::new(&common_dir), remote, &base) {
        Ok(integrated) => integrated,
        Err(e) => {
            tracing::warn!("worktree starts fresh off {base:?}, not from {remote}: {e}");
            true
        }
    }
}

fn add_worktree(repo: &Path, branch: &str, base: &str, dest: &Path) -> Result<Worktree> {
    let dest_str = git_path(dest)?;
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent)
            .with_context(|| format!("creating {}", parent.display()))?;
    }
    let head = run_git(
        repo,
        &["rev-parse", "--verify", &format!("{base}^{{commit}}")],
    )?;
    let head = head.trim();
    let reference = format!("refs/heads/{branch}");
    // An empty old value reserves a new ref atomically; a racing creator is never ours.
    run_git(repo, &["update-ref", &reference, head, ""])?;
    if let Err(error) = run_git(repo, &["worktree", "add", &dest_str, branch]) {
        let error = if let Err(rollback) = rollback_add(repo, dest, branch, head) {
            error.context(format!(
                "worktree creation failed; rollback for {} and {branch:?} also failed: {rollback:#}",
                dest.display()
            ))
        } else {
            error
        };
        let message = error.to_string();
        return Err(error)
            .context(crate::orchestrate::MutationMayHaveActed)
            .context(message);
    }
    Ok(Worktree {
        path: dest.to_path_buf(),
        branch: Some(branch.to_string()),
        head: crate::git::head_sha(dest).ok(),
        is_main: false,
        is_bare: false,
        is_detached: false,
    })
}

/// A task worktree: a fresh branch off `base`, or — on a re-Start — the same branch
/// checked out again (or continued from the one remote still holding it) when its
/// earlier tree is gone. The caller handles a tree already there and on the branch.
pub fn create_task(repo: &Path, branch: &str, base: Option<&str>, dest: &Path) -> Result<Worktree> {
    ensure_git_repo(repo)?;
    crate::git::validate_branch_name(branch)?;
    if dest.exists() {
        bail!(
            "worktree path {} is already occupied; a task reuses its own tree, so the occupant \
             is not a task's",
            dest.display()
        );
    }
    if !branch_exists(repo, branch) {
        return create_on_named_branch(repo, branch, base, dest);
    }
    let dest_str = git_path(dest)?;
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent)
            .with_context(|| format!("creating {}", parent.display()))?;
    }
    run_git(repo, &["worktree", "add", &dest_str, branch])?;
    Ok(Worktree {
        path: dest.to_path_buf(),
        branch: Some(branch.to_string()),
        head: crate::git::head_sha(dest).ok(),
        is_main: false,
        is_bare: false,
        is_detached: false,
    })
}

/// A detached tree at `commitish` (a branch tip or commit). A reviewer reads
/// the branch while the implementer's own worktree keeps it checked out, so the
/// new tree must not claim the branch.
pub fn create_detached(repo: &Path, commitish: &str, dest: &Path) -> Result<Worktree> {
    ensure_git_repo(repo)?;
    if !ref_exists(repo, commitish) {
        bail!(
            "commit-ish {commitish:?} does not exist in {}; expected an existing branch, tag or \
             commit",
            repo.display()
        );
    }
    if dest.exists() {
        bail!(
            "worktree path {} is already occupied; nothing was created",
            dest.display()
        );
    }
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent)
            .with_context(|| format!("creating {}", parent.display()))?;
    }
    let dest_str = git_path(dest)?;
    run_git(repo, &["worktree", "add", "--detach", &dest_str, commitish])?;
    Ok(Worktree {
        path: dest.to_path_buf(),
        branch: None,
        head: crate::git::head_sha(dest).ok(),
        is_main: false,
        is_bare: false,
        is_detached: true,
    })
}

fn rollback_add(repo: &Path, dest: &Path, branch: &str, head: &str) -> Result<()> {
    let reference = format!("refs/heads/{branch}");
    let current = run_git(repo, &["rev-parse", "--verify", &reference])?;
    if current.trim() != head {
        bail!(
            "branch {branch:?} changed from {head} to {}; preserving its worktree and commits",
            current.trim()
        );
    }
    for tree in list(repo)? {
        let owned = tree
            .path
            .canonicalize()
            .ok()
            .zip(dest.canonicalize().ok())
            .is_some_and(|(actual, expected)| actual == expected);
        if owned && tree.branch.as_deref() == Some(branch) {
            remove(repo, dest, true)?;
        }
    }
    if list(repo)?
        .iter()
        .any(|tree| tree.branch.as_deref() == Some(branch))
    {
        bail!("branch {branch:?} is checked out elsewhere; refusing rollback deletion");
    }
    // The expected value also protects a commit written after the earlier check.
    run_git(repo, &["update-ref", "-d", &reference, head])?;
    Ok(())
}

fn git_path(path: &Path) -> Result<String> {
    let raw = path
        .to_str()
        .with_context(|| format!("worktree path is not UTF-8: {}", path.display()))?;
    #[cfg(windows)]
    {
        use std::path::{Component, Prefix};
        // Git interprets verbatim prefixes as //?/ paths, even though Rust accepts them.
        if matches!(path.components().next(), Some(Component::Prefix(prefix))
            if matches!(prefix.kind(), Prefix::Verbatim(_) | Prefix::DeviceNS(_)))
        {
            bail!("worktree path {raw:?} uses an unsupported device prefix; expected a drive or UNC path");
        }
        Ok(crate::paths::windows_command_path(path)
            .to_str()
            .context("normalised worktree path is not UTF-8")?
            .replace('\\', "/"))
    }
    #[cfg(not(windows))]
    Ok(raw.to_string())
}

pub fn has_submodules(worktree: &Path) -> bool {
    worktree.join(".gitmodules").is_file()
}

/// `git worktree add` leaves submodules empty. A clone can need the network and a
/// credential prompt can never be answered, so the update is bounded; failing must
/// not undo a worktree that exists.
pub fn init_submodules(worktree: &Path) -> Result<()> {
    let mut command = git_command(worktree);
    command.args(["submodule", "update", "--init", "--recursive"]);
    command.env("GIT_TERMINAL_PROMPT", "0");
    let out = crate::spawn::output_within(command, SUBMODULE_TIMEOUT).with_context(|| {
        format!(
            "spawning git submodule update --init --recursive in {}",
            worktree.display()
        )
    })?;
    let Some(out) = out else {
        bail!(
            "git submodule update --init --recursive in {} did not finish within {} s; \
             the submodules may be partly initialised",
            worktree.display(),
            SUBMODULE_TIMEOUT.as_secs()
        );
    };
    if !out.status.success() {
        bail!(
            "git submodule update --init --recursive in {} failed (exit {:?}): {}",
            worktree.display(),
            out.status.code(),
            String::from_utf8_lossy(&out.stderr).trim()
        );
    }
    Ok(())
}

/// The submodule paths a worktree's `.gitmodules` declares, so a failed init
/// names them; an unreadable file leaves the list empty rather than guessing.
fn declared_submodule_paths(worktree: &Path) -> Vec<String> {
    run_git(
        worktree,
        &[
            "config",
            "--file",
            ".gitmodules",
            "--get-regexp",
            r"^submodule\..+\.path$",
        ],
    )
    .map(|raw| {
        raw.lines()
            .filter_map(|line| line.split_once(' '))
            .map(|(_, path)| path.trim().to_string())
            .filter(|path| !path.is_empty())
            .collect()
    })
    .unwrap_or_default()
}

/// Managed creations initialise declared submodules best effort: the worktree stands
/// either way, and a failure becomes one warning naming the submodule and the error,
/// also logged for callers that drop it.
pub fn init_submodules_best_effort(worktree: &Path) -> Vec<String> {
    if !has_submodules(worktree) {
        return Vec::new();
    }
    let error = match init_submodules(worktree) {
        Ok(()) => return Vec::new(),
        Err(error) => error,
    };
    let paths = declared_submodule_paths(worktree);
    let named = if paths.is_empty() {
        "the declared submodules".to_string()
    } else {
        paths.join(", ")
    };
    let warning = format!(
        "submodules: initialising {named} in {} failed: {error:#}",
        worktree.display()
    );
    tracing::warn!("{warning}");
    vec![warning]
}

/// Registration cleanup, not deletion: a worktree whose directory is already
/// gone leaves a stale entry that blocks re-adding the same path.
pub fn prune(repo: &Path) -> Result<String> {
    ensure_git_repo(repo)?;
    let out = git_command(repo)
        .args(["worktree", "prune", "-v"])
        .output()
        .with_context(|| format!("spawning git worktree prune in {}", repo.display()))?;
    if !out.status.success() {
        bail!(
            "git worktree prune in {} failed (exit {:?}): {}",
            repo.display(),
            out.status.code(),
            String::from_utf8_lossy(&out.stderr).trim()
        );
    }
    // `prune -v` reports removed registrations on stderr, not stdout.
    let stdout = String::from_utf8_lossy(&out.stdout);
    let stderr = String::from_utf8_lossy(&out.stderr);
    let lines: Vec<&str> = stdout
        .lines()
        .chain(stderr.lines())
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .collect();
    if lines.is_empty() {
        Ok("nothing to prune".to_string())
    } else {
        Ok(lines.join("; "))
    }
}

// The reverse of create. The branch is left behind on purpose: it may hold
// commits that removing the checkout would otherwise destroy.
pub fn remove(repo: &Path, worktree: &Path, force: bool) -> Result<()> {
    ensure_git_repo(repo)?;
    if !worktree.exists() {
        bail!(
            "worktree {} does not exist; nothing to remove",
            worktree.display()
        );
    }
    if !force && is_dirty(worktree) {
        bail!(
            "worktree {} has uncommitted changes; commit or discard them, or remove it with force",
            worktree.display()
        );
    }
    #[cfg(windows)]
    {
        let git_file = worktree.join(".git");
        if git_file.is_file() || is_link(&git_file) {
            return remove_linked_windows(repo, worktree, force);
        }
    }
    let path = git_path(worktree)?;
    if force {
        run_git(repo, &["worktree", "remove", "--force", &path])?;
    } else {
        run_git(repo, &["worktree", "remove", &path])?;
    }
    let _ = run_git(repo, &["worktree", "prune"]);
    Ok(())
}

// Git for Windows before 2.54 deletes what a worktree's junctions point to; later
// versions strand the junctions instead. Houston deletes the folder, unlinking links,
// and Git then only drops the registration.
#[cfg(windows)]
fn remove_linked_windows(repo: &Path, worktree: &Path, force: bool) -> Result<()> {
    if is_link(worktree) {
        bail!(
            "worktree path {} is a link; remove the worktree by the path Git registered",
            worktree.display()
        );
    }
    // A linked `.git` would borrow another worktree's registration for this folder.
    if is_link(&worktree.join(".git")) {
        bail!(
            "{} has a .git that is a link, not the file Git writes; refusing to delete it",
            worktree.display()
        );
    }
    let path = git_path(worktree)?;
    let admin_dir = registered_admin_dir(repo, worktree)?;
    // Git counts the lock file's existence as a lock, and the single `--force`
    // this caller can pass never overrides it.
    let lock_file = admin_dir.join("locked");
    if present(&lock_file) {
        let reason = std::fs::read_to_string(&lock_file).unwrap_or_default();
        let reason = reason.trim();
        bail!(
            "worktree {} is locked{}; unlock it with git worktree unlock before removing it",
            worktree.display(),
            if reason.is_empty() {
                String::new()
            } else {
                format!(" ({reason})")
            }
        );
    }
    if !force {
        refuse_submodules(worktree, &admin_dir)?;
        refuse_unclean(worktree)?;
    }
    // A file held open can stop the delete partway; putting `.git` back leaves
    // a worktree that a retry can remove.
    let git_file = worktree.join(".git");
    let git_file_contents =
        std::fs::read(&git_file).with_context(|| format!("reading {}", git_file.display()))?;
    // std's remove_dir_all unlinks junctions and symlinks without entering them.
    if let Err(error) = std::fs::remove_dir_all(worktree) {
        let _ = std::fs::write(&git_file, &git_file_contents);
        bail!(
            "failed to delete worktree {}: {error}; it stays registered, so close what holds its files and retry",
            worktree.display()
        );
    }
    run_git(
        repo,
        &["worktree", "remove", "--force", "--force", "--", &path],
    )?;
    let _ = run_git(repo, &["worktree", "prune"]);
    Ok(())
}

/// Proves `worktree` is a registered worktree of `repo` and returns its admin
/// directory: the `.git` file names an admin dir under the repo's common
/// `worktrees/`, and that dir's `gitdir` file points back at the `.git` file.
#[cfg(windows)]
fn registered_admin_dir(repo: &Path, worktree: &Path) -> Result<PathBuf> {
    let refuse = || {
        anyhow::anyhow!(
            "{} is not a registered worktree of {}; refusing to delete it",
            worktree.display(),
            repo.display()
        )
    };
    let found = run_git(worktree, &["rev-parse", "--absolute-git-dir"]).map_err(|_| refuse())?;
    let admin_dir = resolve_against(worktree, found.trim());
    let common = run_git(repo, &["rev-parse", "--git-common-dir"]).map_err(|_| refuse())?;
    let common = resolve_against(repo, common.trim());
    let back = std::fs::read_to_string(admin_dir.join("gitdir")).map_err(|_| refuse())?;
    let back = resolve_against(&admin_dir, back.trim());
    let admin_parent = admin_dir.parent().ok_or_else(refuse)?;
    let registered = same_path(&back, &worktree.join(".git"))
        && same_path(admin_parent, &common.join("worktrees"));
    if !registered {
        return Err(refuse());
    }
    Ok(admin_dir)
}

/// Resolves git's own relative output against the directory it was asked in.
#[cfg(windows)]
fn resolve_against(base: &Path, raw: &str) -> PathBuf {
    let path = Path::new(raw);
    if path.is_absolute() {
        path.to_path_buf()
    } else {
        base.join(path)
    }
}

/// A path that cannot be resolved is never equal, so a doubt refuses.
#[cfg(windows)]
fn same_path(left: &Path, right: &Path) -> bool {
    match (std::fs::canonicalize(left), std::fs::canonicalize(right)) {
        (Ok(left), Ok(right)) => left == right,
        _ => false,
    }
}

/// A symlink or junction; an unreadable path counts as one, so a doubt refuses.
#[cfg(windows)]
fn is_link(path: &Path) -> bool {
    match std::fs::symlink_metadata(path) {
        Ok(meta) => meta.file_type().is_symlink(),
        Err(error) => error.kind() != std::io::ErrorKind::NotFound,
    }
}

/// An unreadable path counts as present, so a doubt refuses.
#[cfg(windows)]
fn present(path: &Path) -> bool {
    match std::fs::symlink_metadata(path) {
        Ok(_) => true,
        Err(error) => error.kind() != std::io::ErrorKind::NotFound,
    }
}

// Git's own unforced refusal, checked here because the delete runs before Git.
#[cfg(windows)]
fn refuse_submodules(worktree: &Path, admin_dir: &Path) -> Result<()> {
    let refuse = || {
        anyhow::anyhow!(
            "worktree {} contains submodules; remove it with force",
            worktree.display()
        )
    };
    if present(&admin_dir.join("modules")) {
        return Err(refuse());
    }
    let index = run_git(worktree, &["ls-files", "--stage", "-z"])?;
    for entry in index.split('\0') {
        if !entry.starts_with("160000 ") {
            continue;
        }
        let Some((_, path)) = entry.split_once('\t') else {
            continue;
        };
        if present(&worktree.join(path).join(".git")) {
            return Err(refuse());
        }
    }
    Ok(())
}

/// Git's unforced clean check, except that a failed status refuses and a
/// repository setting cannot hide untracked files.
#[cfg(windows)]
fn refuse_unclean(worktree: &Path) -> Result<()> {
    let status = run_git(
        worktree,
        &[
            "-c",
            "status.showUntrackedFiles=normal",
            "status",
            "--porcelain",
            "--ignore-submodules=none",
        ],
    )?;
    if status.lines().any(|line| !line.trim().is_empty()) {
        bail!(
            "worktree {} has uncommitted changes; commit or discard them, or remove it with force",
            worktree.display()
        );
    }
    Ok(())
}

fn parse_list(raw: &str) -> Vec<Worktree> {
    let mut out: Vec<Worktree> = Vec::new();
    let mut current: Option<Worktree> = None;
    for line in raw.lines() {
        if let Some(path) = line.strip_prefix("worktree ") {
            out.extend(current.take());
            current = Some(Worktree {
                path: PathBuf::from(path),
                branch: None,
                head: None,
                is_main: false,
                is_bare: false,
                is_detached: false,
            });
        } else if let Some(wt) = current.as_mut() {
            if let Some(sha) = line.strip_prefix("HEAD ") {
                wt.head = Some(sha.to_string());
            } else if let Some(branch) = line.strip_prefix("branch refs/heads/") {
                wt.branch = Some(branch.to_string());
            } else if line == "bare" {
                wt.is_bare = true;
            } else if line == "detached" {
                wt.is_detached = true;
            }
        }
    }
    out.extend(current.take());
    if let Some(first) = out.first_mut() {
        first.is_main = true;
    }
    out
}

pub fn is_dirty(worktree: &Path) -> bool {
    match run_git(worktree, &["status", "--porcelain"]) {
        Ok(out) => out.lines().any(|l| !l.trim().is_empty()),
        Err(_) => false,
    }
}

fn branch_exists(repo: &Path, branch: &str) -> bool {
    let refname = format!("refs/heads/{branch}");
    run_git(repo, &["show-ref", "--verify", "--quiet", &refname]).is_ok()
}

fn ref_exists(repo: &Path, name: &str) -> bool {
    let spec = format!("{name}^{{commit}}");
    run_git(repo, &["rev-parse", "--verify", "--quiet", &spec]).is_ok()
}

fn ensure_git_repo(dir: &Path) -> Result<()> {
    if !crate::git::is_git_repo(dir) {
        bail!(
            "{} is not a git repository; a worktree needs one",
            dir.display()
        );
    }
    Ok(())
}

fn run_git(dir: &Path, args: &[&str]) -> Result<String> {
    let out = git_command(dir)
        .args(args)
        .output()
        .with_context(|| format!("spawning git {args:?} in {}", dir.display()))?;
    if !out.status.success() {
        bail!(
            "git {:?} in {} failed (exit {:?}): {}",
            args,
            dir.display(),
            out.status.code(),
            String::from_utf8_lossy(&out.stderr).trim()
        );
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

fn git_command(dir: &Path) -> std::process::Command {
    let mut command = crate::git::command();
    #[cfg(windows)]
    command.args(["-c", "core.longpaths=true"]);
    command.arg("-C").arg(dir);
    command
}

#[cfg(test)]
mod tests {
    #![allow(clippy::disallowed_methods)]

    use super::*;
    use std::process::Command;

    fn git(dir: &Path, args: &[&str]) {
        let out = Command::new("git")
            .arg("-C")
            .arg(dir)
            .args(args)
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "git {args:?}: {}",
            String::from_utf8_lossy(&out.stderr)
        );
    }

    fn init_repo(dir: &Path) {
        git(dir, &["init", "-b", "main"]);
        git(dir, &["config", "user.email", "t@t.local"]);
        git(dir, &["config", "user.name", "t"]);
        std::fs::write(dir.join("README.md"), "hello\n").unwrap();
        git(dir, &["add", "-A"]);
        git(dir, &["commit", "-m", "init"]);
    }

    fn git_out(dir: &Path, args: &[&str]) -> String {
        let out = Command::new("git")
            .arg("-C")
            .arg(dir)
            .args(args)
            .output()
            .unwrap();
        assert!(out.status.success(), "git {args:?}");
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    }

    /// A bare remote `name` holding `main` and a `branch` one commit ahead of it,
    /// fetched into `repo`, which never had `branch` locally.
    fn remote_with_branch(root: &Path, repo: &Path, name: &str, branch: &str) -> String {
        let bare = root.join(format!("{name}.git"));
        git(
            root,
            &["init", "--bare", "-b", "main", bare.to_str().unwrap()],
        );
        git(repo, &["remote", "add", name, bare.to_str().unwrap()]);
        git(repo, &["push", name, "main"]);
        let other = root.join(format!("{name}-clone"));
        git(
            root,
            &["clone", bare.to_str().unwrap(), other.to_str().unwrap()],
        );
        git(&other, &["config", "user.email", "t@t.local"]);
        git(&other, &["config", "user.name", "t"]);
        git(&other, &["switch", "-c", branch]);
        std::fs::write(other.join("remote.txt"), "pushed\n").unwrap();
        git(&other, &["add", "remote.txt"]);
        git(&other, &["commit", "-m", "remote work"]);
        git(&other, &["push", "origin", branch]);
        git(repo, &["fetch", name]);
        git_out(repo, &["rev-parse", &format!("{name}/{branch}")])
    }

    #[test]
    fn a_task_branch_only_on_its_remote_continues_it_and_tracks_it() {
        let root = tempfile::tempdir().unwrap();
        let repo = root.path().join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        init_repo(&repo);
        let pushed = remote_with_branch(root.path(), &repo, "origin", "feat/resume");

        let dest = root.path().join("wt");
        create_task(&repo, "feat/resume", None, &dest).unwrap();

        assert_eq!(git_out(&dest, &["rev-parse", "HEAD"]), pushed);
        std::fs::write(dest.join("local.txt"), "more\n").unwrap();
        git(&dest, &["add", "local.txt"]);
        git(&dest, &["commit", "-m", "local work"]);
        let sync = crate::git::sync(&dest);
        assert_eq!(sync.upstream.as_deref(), Some("origin/feat/resume"));
        assert_eq!((sync.ahead, sync.behind), (1, 0));
    }

    #[test]
    fn a_branch_on_two_remotes_is_not_guessed_between() {
        let root = tempfile::tempdir().unwrap();
        let repo = root.path().join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        init_repo(&repo);
        let main = git_out(&repo, &["rev-parse", "main"]);
        remote_with_branch(root.path(), &repo, "origin", "feat/both");
        remote_with_branch(root.path(), &repo, "fork", "feat/both");

        let dest = root.path().join("wt");
        create_task(&repo, "feat/both", None, &dest).unwrap();

        assert_eq!(git_out(&dest, &["rev-parse", "HEAD"]), main);
        assert_eq!(crate::git::sync(&dest).upstream, None);
    }

    #[test]
    fn a_restart_after_a_squash_merge_starts_fresh_off_the_base() {
        let root = tempfile::tempdir().unwrap();
        let repo = root.path().join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        init_repo(&repo);
        remote_with_branch(root.path(), &repo, "origin", "houston/hou-1-fix");
        let dest = root.path().join("wt");
        create_task(&repo, "houston/hou-1-fix", None, &dest).unwrap();
        git(&repo, &["merge", "--squash", "origin/houston/hou-1-fix"]);
        git(&repo, &["commit", "-m", "squashed"]);
        git(&repo, &["push", "origin", "main"]);
        git(&repo, &["fetch", "origin"]);
        git(&repo, &["worktree", "remove", dest.to_str().unwrap()]);
        git(&repo, &["branch", "-D", "houston/hou-1-fix"]);

        create_task(&repo, "houston/hou-1-fix", None, &dest).unwrap();

        assert_eq!(
            git_out(&dest, &["rev-parse", "HEAD"]),
            git_out(&repo, &["rev-parse", "origin/main"])
        );
        assert_eq!(crate::git::sync(&dest).upstream, None);
    }

    #[test]
    fn a_ref_two_remote_names_could_claim_is_not_guessed() {
        let root = tempfile::tempdir().unwrap();
        let repo = root.path().join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        init_repo(&repo);
        let main = git_out(&repo, &["rev-parse", "main"]);
        remote_with_branch(root.path(), &repo, "a", "b/c");
        // Current Git refuses `remote add` for overlapping names; config still allows them.
        let other = root.path().join("a.git");
        git(
            &repo,
            &["config", "remote.a/b.url", other.to_str().unwrap()],
        );

        let dest = root.path().join("wt");
        create_task(&repo, "b/c", None, &dest).unwrap();

        assert_eq!(git_out(&dest, &["rev-parse", "HEAD"]), main);
        assert_eq!(crate::git::sync(&dest).upstream, None);
    }

    #[test]
    fn a_new_branch_off_a_remote_default_base_tracks_nothing() {
        let root = tempfile::tempdir().unwrap();
        let repo = root.path().join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        init_repo(&repo);
        remote_with_branch(root.path(), &repo, "origin", "feat/other");
        git(&repo, &["remote", "set-head", "origin", "main"]);

        let dest = root.path().join("wt");
        create_task(&repo, "feat/fresh", None, &dest).unwrap();

        assert_eq!(
            git_out(&dest, &["rev-parse", "HEAD"]),
            git_out(&repo, &["rev-parse", "origin/main"])
        );
        assert_eq!(crate::git::sync(&dest).upstream, None);
    }

    #[test]
    fn create_named_makes_a_houston_branch_and_refuses_a_taken_name() {
        let root = tempfile::tempdir().unwrap();
        let repo = root.path().join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        init_repo(&repo);
        let dest = root.path().join("named-wt");
        let wt = create_named(&repo, "Fix Login!", None, &dest).unwrap();
        assert_eq!(wt.branch.as_deref(), Some("houston/fix-login"));
        assert!(wt.head.is_some(), "a fresh worktree has a HEAD");

        let err = create_named(&repo, "fix login", None, &dest)
            .unwrap_err()
            .to_string();
        assert!(
            err.contains("already occupied"),
            "a second create must refuse by name: {err}"
        );

        let other = root.path().join("other-wt");
        let err = create_named(&repo, "fix-login", None, &other)
            .unwrap_err()
            .to_string();
        assert!(
            err.contains("branch \"houston/fix-login\" already exists"),
            "an existing branch must be named in the refusal: {err}"
        );
    }

    #[cfg(windows)]
    #[test]
    fn canonical_windows_paths_create_and_remove_worktrees() {
        let root = tempfile::tempdir().unwrap();
        let repo = root.path().join("projeto com acentuação");
        std::fs::create_dir_all(&repo).unwrap();
        init_repo(&repo);
        let repo = repo.canonicalize().unwrap();
        for (slug, task) in [("named", false), ("task", true)] {
            let dest = spawn_path(&repo, slug);
            let wt = if task {
                create(&repo, slug, None, &dest)
            } else {
                create_named(&repo, slug, None, &dest)
            }
            .unwrap();
            assert_eq!(
                wt.path.canonicalize().unwrap(),
                dest.canonicalize().unwrap()
            );
            let actual = list(&repo).unwrap();
            assert!(actual
                .iter()
                .any(|tree| { tree.path.canonicalize().unwrap() == dest.canonicalize().unwrap() }));
            remove(&repo, &dest.canonicalize().unwrap(), true).unwrap();
            assert!(!dest.exists());
            assert_eq!(list(&repo).unwrap().len(), 1);
        }
    }

    #[cfg(windows)]
    #[test]
    fn long_windows_worktree_paths_either_round_trip_or_roll_back_cleanly() {
        let root = tempfile::tempdir().unwrap();
        let repo = root.path().join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        init_repo(&repo);
        let repo = repo.canonicalize().unwrap();
        let long = repo
            .join("segment".repeat(10))
            .join("segment".repeat(10))
            .join("segment".repeat(10))
            .join("long-tree");
        assert!(long.as_os_str().len() > 260);
        match create_named(&repo, "long-tree", None, &long) {
            Ok(_) => {
                assert!(long.join("README.md").is_file());
                remove(&repo, &long.canonicalize().unwrap(), true).unwrap();
            }
            Err(error) => {
                // Git versions differ in their internal worktree path limits.
                assert!(error.to_string().contains("git"), "{error:#}");
                assert!(!branch_exists(&repo, "houston/long-tree"));
                assert_eq!(list(&repo).unwrap().len(), 1);
                create_named(&repo, "long-tree", None, &repo.join("short-tree")).unwrap();
            }
        }
        assert!(!long.exists());
    }

    #[cfg(windows)]
    #[test]
    fn git_paths_keep_drive_and_unc_roots_without_device_prefixes() {
        assert_eq!(
            git_path(Path::new(r"\\?\C:\project space\tree")).unwrap(),
            "C:/project space/tree"
        );
        assert_eq!(
            git_path(Path::new(r"\\?\UNC\server\share\tree")).unwrap(),
            "//server/share/tree"
        );
        assert_eq!(
            git_path(Path::new(r"\\server\share\tree")).unwrap(),
            "//server/share/tree"
        );
        assert!(git_path(Path::new(r"\\.\PhysicalDrive0")).is_err());
    }

    #[test]
    fn failed_checkout_does_not_leave_a_branch_and_can_be_retried() {
        let root = tempfile::tempdir().unwrap();
        let repo = root.path().join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        init_repo(&repo);
        git(
            &repo,
            &[
                "config",
                "core.hooksPath",
                repo.join("hooks").to_str().unwrap(),
            ],
        );
        std::fs::create_dir_all(repo.join("hooks")).unwrap();
        std::fs::write(repo.join("hooks/post-checkout"), "#!/bin/sh\nexit 1\n").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(
                repo.join("hooks/post-checkout"),
                std::fs::Permissions::from_mode(0o755),
            )
            .unwrap();
        }
        let dest = root.path().join("wt");
        let error = create_on_branch(&repo, "houston/retry", None, &dest).unwrap_err();
        assert!(error.to_string().contains("failed"), "{error}");
        assert!(!branch_exists(&repo, "houston/retry"));
        assert!(!dest.exists());
        assert_eq!(list(&repo).unwrap().len(), 1);
        std::fs::remove_file(repo.join("hooks/post-checkout")).unwrap();
        create_on_branch(&repo, "houston/retry", None, &dest).unwrap();
    }

    #[test]
    fn failed_checkout_preserves_a_commit_written_by_its_hook() {
        let root = tempfile::tempdir().unwrap();
        let repo = root.path().join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        init_repo(&repo);
        let original = crate::git::head_sha(&repo).unwrap();
        let hooks = repo.join("hooks");
        std::fs::create_dir_all(&hooks).unwrap();
        git(
            &repo,
            &["config", "core.hooksPath", hooks.to_str().unwrap()],
        );
        std::fs::write(
            hooks.join("post-checkout"),
            "#!/bin/sh\ngit commit --allow-empty -m hook-commit\nexit 1\n",
        )
        .unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(
                hooks.join("post-checkout"),
                std::fs::Permissions::from_mode(0o755),
            )
            .unwrap();
        }
        let dest = root.path().join("wt");
        let error = create_on_branch(&repo, "houston/hook", None, &dest).unwrap_err();
        assert!(error.to_string().contains("preserving"), "{error:#}");
        assert!(branch_exists(&repo, "houston/hook"));
        assert!(dest.exists());
        assert_ne!(crate::git::head_sha(&dest).unwrap(), original);
        assert_eq!(list(&repo).unwrap().len(), 2);
    }

    #[test]
    fn prune_reports_nothing_when_clean_and_clears_a_deleted_directory() {
        let root = tempfile::tempdir().unwrap();
        let repo = root.path().join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        init_repo(&repo);
        let dest = root.path().join("wt");
        create_named(&repo, "prunable", None, &dest).unwrap();

        assert!(
            prune(&repo).unwrap().contains("nothing to prune"),
            "a live worktree leaves nothing stale"
        );

        std::fs::remove_dir_all(&dest).unwrap();
        let summary = prune(&repo).unwrap();
        assert!(
            summary.contains("prunable") || summary.contains("wt"),
            "prune must name what it dropped: {summary}"
        );
        assert!(
            list(&repo).unwrap().len() == 1,
            "only the main checkout stays"
        );
    }

    #[test]
    fn remove_refuses_a_dirty_worktree_without_force() {
        let root = tempfile::tempdir().unwrap();
        let repo = root.path().join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        init_repo(&repo);
        let dest = root.path().join("wt");
        create_named(&repo, "dirty", None, &dest).unwrap();
        assert!(!is_dirty(&dest));

        std::fs::write(dest.join("scratch.txt"), "wip\n").unwrap();
        assert!(is_dirty(&dest), "an untracked file makes a worktree dirty");

        let err = remove(&repo, &dest, false).unwrap_err().to_string();
        assert!(err.contains("uncommitted changes"), "unexpected: {err}");
        remove(&repo, &dest, true).unwrap();
        assert!(!dest.exists());
        assert!(list(&repo).unwrap().len() == 1);
    }

    #[cfg(windows)]
    #[test]
    fn force_remove_refuses_a_locked_worktree_and_keeps_its_files() {
        let root = tempfile::tempdir().unwrap();
        let repo = root.path().join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        init_repo(&repo);
        let dest = root.path().join("wt");
        create_named(&repo, "locked-up", None, &dest).unwrap();
        git(&repo, &["worktree", "lock", dest.to_str().unwrap()]);

        let err = remove(&repo, &dest, true).unwrap_err().to_string();
        assert!(err.contains("is locked"), "unexpected: {err}");
        assert!(
            dest.join("README.md").is_file(),
            "a locked worktree must not be deleted"
        );

        git(&repo, &["worktree", "unlock", dest.to_str().unwrap()]);
        remove(&repo, &dest, true).unwrap();
        assert!(!dest.exists());
        assert_eq!(list(&repo).unwrap().len(), 1);
    }

    #[cfg(windows)]
    #[test]
    fn force_remove_refuses_a_tree_it_cannot_prove_is_a_registered_worktree() {
        let root = tempfile::tempdir().unwrap();
        let repo = root.path().join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        init_repo(&repo);
        let fake = repo.join("fake");
        std::fs::create_dir_all(&fake).unwrap();
        std::fs::write(fake.join("precious.txt"), "keep\n").unwrap();
        std::fs::write(fake.join(".git"), "gitdir: C:/definitely/not/this/repo\n").unwrap();

        let err = remove(&repo, &fake, true).unwrap_err().to_string();
        assert!(
            err.contains("is not a registered worktree"),
            "unexpected: {err}"
        );
        assert!(
            fake.join("precious.txt").is_file(),
            "a tree that cannot be proved must be refused, not deleted"
        );
        assert!(fake.join(".git").is_file());
    }

    #[cfg(windows)]
    fn create_junction(link: &Path, target: &Path) {
        let native = |path: &Path| path.display().to_string().replace('/', "\\");
        let out = Command::new("cmd")
            .args(["/c", "mklink", "/J"])
            .arg(native(link))
            .arg(native(target))
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "mklink /J: {}",
            String::from_utf8_lossy(&out.stderr)
        );
    }

    /// A folder whose `.git` links to a real worktree's, and that worktree.
    #[cfg(windows)]
    fn folder_borrowing_a_worktree(root: &Path) -> (PathBuf, PathBuf, PathBuf) {
        let repo = root.join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        init_repo(&repo);
        let real = root.join("wt");
        create_named(&repo, "real", None, &real).unwrap();
        let folder = root.join("folder");
        std::fs::create_dir_all(&folder).unwrap();
        std::fs::write(folder.join("precious.txt"), "keep\n").unwrap();
        (repo, real, folder)
    }

    #[cfg(windows)]
    #[test]
    fn force_remove_refuses_a_folder_whose_git_is_a_junction() {
        let root = tempfile::tempdir().unwrap();
        let (repo, real, folder) = folder_borrowing_a_worktree(root.path());
        let admin = repo.join(".git/worktrees/wt");
        create_junction(&folder.join(".git"), &admin);

        let err = remove(&repo, &folder, true).unwrap_err().to_string();

        assert!(err.contains("is a link"), "unexpected: {err}");
        assert!(folder.join("precious.txt").is_file());
        assert!(real.join("README.md").is_file());
    }

    #[cfg(windows)]
    #[test]
    fn force_remove_refuses_a_folder_whose_git_file_is_a_symlink() {
        let root = tempfile::tempdir().unwrap();
        let (repo, real, folder) = folder_borrowing_a_worktree(root.path());
        // File symlinks need Developer Mode or elevation; CI runners have it.
        if let Err(e) = std::os::windows::fs::symlink_file(real.join(".git"), folder.join(".git")) {
            eprintln!("skipped: cannot create a file symlink here: {e}");
            return;
        }

        let err = remove(&repo, &folder, true).unwrap_err().to_string();

        assert!(err.contains("is a link"), "unexpected: {err}");
        assert!(folder.join("precious.txt").is_file());
        assert!(real.join("README.md").is_file());
    }

    #[cfg(windows)]
    #[test]
    fn unforced_remove_counts_untracked_files_a_repo_setting_hides() {
        let root = tempfile::tempdir().unwrap();
        let repo = root.path().join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        init_repo(&repo);
        let dest = root.path().join("wt");
        create_named(&repo, "hidden-untracked", None, &dest).unwrap();
        git(&dest, &["config", "status.showUntrackedFiles", "no"]);
        std::fs::write(dest.join("draft.txt"), "unsaved\n").unwrap();

        let err = remove(&repo, &dest, false).unwrap_err().to_string();
        assert!(err.contains("uncommitted changes"), "unexpected: {err}");
        assert!(dest.join("draft.txt").is_file());
    }
}

#[cfg(test)]
mod submodule_tests {
    #![allow(clippy::disallowed_methods)]

    use super::*;
    use std::process::Command;

    fn git(dir: &Path, args: &[&str]) {
        let out = Command::new("git")
            .arg("-C")
            .arg(dir)
            .args(args)
            // A local-path submodule clone is the file transport, which git refuses
            // unless `protocol.file.allow=always`; per-command env keeps the
            // allowance off this process, so plain `cargo test` cannot leak it.
            .env("GIT_CONFIG_COUNT", "1")
            .env("GIT_CONFIG_KEY_0", "protocol.file.allow")
            .env("GIT_CONFIG_VALUE_0", "always")
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "git {args:?}: {}",
            String::from_utf8_lossy(&out.stderr)
        );
    }

    fn init_repo(dir: &Path) {
        git(dir, &["init", "-b", "main"]);
        git(dir, &["config", "user.email", "t@t.local"]);
        git(dir, &["config", "user.name", "t"]);
        std::fs::write(dir.join("README.md"), "hello\n").unwrap();
        git(dir, &["add", "-A"]);
        git(dir, &["commit", "-m", "init"]);
    }

    #[test]
    fn submodules_are_initialized_after_a_worktree_is_created() {
        let root = tempfile::tempdir().unwrap();
        let sub = root.path().join("sub");
        std::fs::create_dir_all(&sub).unwrap();
        init_repo(&sub);

        let repo = root.path().join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        init_repo(&repo);
        // Local-path submodules need the file transport allowed explicitly.
        git(
            &repo,
            &[
                "-c",
                "protocol.file.allow=always",
                "submodule",
                "add",
                sub.to_str().unwrap(),
                "vendor/sub",
            ],
        );
        git(&repo, &["commit", "-m", "add submodule"]);

        let dest = root.path().join("wt");
        create_named(&repo, "with-sub", None, &dest).unwrap();
        assert!(has_submodules(&dest), "the worktree carries .gitmodules");
        // The fixture's submodule is a local path, so the child `git submodule
        // update` needs the file transport allowed; real submodules over https
        // do not. `GIT_ALLOW_PROTOCOL=file` widens this test process only.
        std::env::set_var("GIT_ALLOW_PROTOCOL", "file");

        init_submodules(&dest).unwrap();
        assert!(
            dest.join("vendor/sub/README.md").is_file(),
            "init_submodules must populate the submodule's own files"
        );
    }

    #[test]
    fn a_repo_without_submodules_reports_none() {
        let root = tempfile::tempdir().unwrap();
        let repo = root.path().join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        init_repo(&repo);
        assert!(!has_submodules(&repo));
        assert!(init_submodules_best_effort(&repo).is_empty());
    }

    /// Returns the root, the repo and the submodule.
    fn repo_with_one_submodule() -> (tempfile::TempDir, PathBuf, PathBuf) {
        let root = tempfile::tempdir().unwrap();
        let sub = root.path().join("sub");
        std::fs::create_dir_all(&sub).unwrap();
        init_repo(&sub);
        let repo = root.path().join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        init_repo(&repo);
        git(
            &repo,
            &["submodule", "add", sub.to_str().unwrap(), "vendor/sub"],
        );
        git(&repo, &["commit", "-m", "add submodule"]);
        (root, repo, sub)
    }

    #[test]
    fn a_failed_init_warns_naming_the_submodule_and_keeps_the_worktree() {
        let (root, repo, sub) = repo_with_one_submodule();
        let dest = root.path().join("wt");
        create_named(&repo, "broken", None, &dest).unwrap();
        std::fs::remove_dir_all(&sub).unwrap();

        let warnings = init_submodules_best_effort(&dest);
        assert_eq!(warnings.len(), 1, "{warnings:?}");
        assert!(
            warnings[0].contains("vendor/sub") && warnings[0].contains("failed"),
            "the warning must name the submodule and the error: {:?}",
            warnings[0]
        );
        assert!(
            dest.join("README.md").is_file(),
            "a failed init must not undo the worktree"
        );
    }
}
