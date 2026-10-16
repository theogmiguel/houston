#![allow(clippy::disallowed_methods)]

#[path = "../../build_git.rs"]
mod build_git;

use std::path::Path;
use std::process::Command;

fn git(dir: &Path, args: &[&str]) {
    let status = Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(["-c", "user.name=t", "-c", "user.email=t@example.invalid"])
        .args(args)
        .status()
        .expect("run git");
    assert!(status.success(), "git {args:?} failed in {}", dir.display());
}

#[test]
fn a_linked_worktree_yields_only_existing_watch_paths() {
    let tmp = tempfile::tempdir().expect("tempdir");
    let main = tmp.path().join("main");
    std::fs::create_dir(&main).unwrap();
    git(&main, &["init", "-q"]);
    git(&main, &["commit", "-q", "--allow-empty", "-m", "init"]);
    let linked = tmp.path().join("linked");
    git(
        &main,
        &[
            "worktree",
            "add",
            "-q",
            linked.to_str().unwrap(),
            "-b",
            "wt",
        ],
    );
    assert!(
        linked.join(".git").is_file(),
        "a linked worktree's .git is a file"
    );

    let paths = build_git::rerun_paths(&linked);
    let names: Vec<_> = paths
        .iter()
        .filter_map(|p| p.file_name()?.to_str())
        .collect();
    assert!(
        names.contains(&"HEAD") && names.contains(&"wt"),
        "HEAD and the checked-out branch ref must be watched in a linked worktree, got {paths:?}"
    );
    for p in &paths {
        assert!(
            p.exists(),
            "cargo treats a missing rerun-if-changed path as always dirty: {}",
            p.display()
        );
    }
}

fn watched_repo() -> (tempfile::TempDir, std::path::PathBuf) {
    let tmp = tempfile::tempdir().expect("tempdir");
    let repo = tmp.path().join("repo");
    std::fs::create_dir(&repo).unwrap();
    git(&repo, &["init", "-q"]);
    git(&repo, &["commit", "-q", "--allow-empty", "-m", "init"]);
    (tmp, repo)
}

#[test]
fn remote_tracking_refs_are_not_watched() {
    let (_tmp, repo) = watched_repo();
    git(&repo, &["update-ref", "refs/remotes/origin/main", "HEAD"]);
    let remotes = repo.join(".git/refs/remotes/origin/main");
    for p in build_git::rerun_paths(&repo) {
        assert!(
            !remotes.starts_with(&p) && !p.starts_with(repo.join(".git/refs/remotes")),
            "{} would rebuild houston-core on every fetch or push",
            p.display()
        );
    }
}

#[test]
fn the_current_branch_ref_changes_with_a_new_commit() {
    let (_tmp, repo) = watched_repo();
    let branch = git_head_branch(&repo);
    let watched = build_git::rerun_paths(&repo);
    let ref_file = repo.join(".git/refs/heads").join(&branch);
    assert!(
        watched.contains(&ref_file),
        "branch ref {} must be watched, got {watched:?}",
        ref_file.display()
    );
    let before = std::fs::read(&ref_file).unwrap();
    git(&repo, &["commit", "-q", "--allow-empty", "-m", "next"]);
    assert_ne!(before, std::fs::read(&ref_file).unwrap());
}

#[test]
fn a_packed_branch_still_sees_the_next_commit() {
    let (_tmp, repo) = watched_repo();
    git(&repo, &["pack-refs", "--all", "--prune"]);
    let branch = git_head_branch(&repo);
    let loose = repo.join(".git/refs/heads").join(&branch);
    assert!(!loose.exists(), "pack-refs --prune removes the loose ref");
    let watched = build_git::rerun_paths(&repo);
    assert!(
        watched.contains(&repo.join(".git/packed-refs")),
        "packed-refs must be watched, got {watched:?}"
    );
    assert!(
        watched.contains(&repo.join(".git/refs/heads")),
        "a packed branch's next commit creates a loose file; its directory must be watched, got {watched:?}"
    );
    for p in &watched {
        assert!(p.exists(), "missing path emitted: {}", p.display());
    }
}

fn git_head_branch(dir: &Path) -> String {
    let out = Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(["symbolic-ref", "--short", "HEAD"])
        .output()
        .expect("run git");
    String::from_utf8(out.stdout).unwrap().trim().to_string()
}
