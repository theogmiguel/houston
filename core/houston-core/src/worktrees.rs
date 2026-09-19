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
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent)
            .with_context(|| format!("creating {}", parent.display()))?;
    }
    let dest_str = dest
        .to_str()
        .with_context(|| format!("worktree path is not UTF-8: {}", dest.display()))?;
    run_git(repo, &["worktree", "add", "-b", &branch, dest_str, &base])?;
    Ok(Worktree {
        path: dest.to_path_buf(),
        branch: Some(branch),
        head: crate::git::head_sha(dest).ok(),
        is_main: false,
        is_bare: false,
        is_detached: false,
    })
}

pub fn list(repo: &Path) -> Result<Vec<Worktree>> {
    ensure_git_repo(repo)?;
    let raw = run_git(repo, &["worktree", "list", "--porcelain"])?;
    Ok(parse_list(&raw))
}

/// A panel worktree: branch `houston/<slug>` off `base`, at `dest`. The task
/// flavour above stays for orchestrator runs; this one is named and untracked
/// by any task, so a collision is refused by name.
pub fn create_named(repo: &Path, slug: &str, base: Option<&str>, dest: &Path) -> Result<Worktree> {
    ensure_git_repo(repo)?;
    let slug = crate::git::ref_slug(slug);
    let branch = format!("houston/{slug}");
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
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent)
            .with_context(|| format!("creating {}", parent.display()))?;
    }
    let dest_str = dest
        .to_str()
        .with_context(|| format!("worktree path is not UTF-8: {}", dest.display()))?;
    run_git(repo, &["worktree", "add", "-b", &branch, dest_str, &base])?;
    Ok(Worktree {
        path: dest.to_path_buf(),
        branch: Some(branch),
        head: crate::git::head_sha(dest).ok(),
        is_main: false,
        is_bare: false,
        is_detached: false,
    })
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
    let out = crate::spawn::command("git")
        .arg("-C")
        .arg(repo)
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
    let path = worktree
        .to_str()
        .with_context(|| format!("worktree path is not UTF-8: {}", worktree.display()))?;
    if force {
        run_git(repo, &["worktree", "remove", "--force", path])?;
    } else {
        run_git(repo, &["worktree", "remove", path])?;
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
    let out = crate::spawn::command("git")
        .arg("-C")
        .arg(dir)
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
