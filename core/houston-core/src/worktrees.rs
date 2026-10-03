use anyhow::{bail, Context, Result};
use std::path::{Path, PathBuf};

const BRANCH_PREFIX: &str = "houston/task/";

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

/// Worktrees nested in the workspace would show in its `git status`; one `*` keeps the
/// whole directory out, as `.houston/swarm/` does. A file already there is left alone.
pub fn ensure_ignored(worktrees_dir: &Path) -> Result<()> {
    std::fs::create_dir_all(worktrees_dir)
        .with_context(|| format!("creating {}", worktrees_dir.display()))?;
    let gitignore = worktrees_dir.join(".gitignore");
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

/// A task worktree: a fresh branch off `base`, or — on a re-Start — the same
/// branch checked out again at the same path when its earlier tree is gone.
/// The caller handles a tree that is already there and on the branch.
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
        return create_on_branch(repo, branch, base, dest);
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

/// `git worktree add` leaves submodules empty, so a repository that keeps
/// tooling in one gets a worktree quietly missing it. Best effort: a clone
/// needs the network, and failing must not undo a worktree that exists.
pub fn init_submodules(worktree: &Path) -> Result<()> {
    run_git(worktree, &["submodule", "update", "--init", "--recursive"])?;
    Ok(())
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
    let path = git_path(worktree)?;
    if force {
        run_git(repo, &["worktree", "remove", "--force", &path])?;
    } else {
        run_git(repo, &["worktree", "remove", &path])?;
    }
    let _ = run_git(repo, &["worktree", "prune"]);
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
    let mut command = crate::spawn::command("git");
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
    }
}
