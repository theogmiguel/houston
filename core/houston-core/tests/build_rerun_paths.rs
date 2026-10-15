#![allow(clippy::disallowed_methods)]

#[path = "../build_git.rs"]
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
        names.contains(&"HEAD") && names.contains(&"refs"),
        "HEAD and refs must be watched in a linked worktree, got {paths:?}"
    );
    for p in &paths {
        assert!(
            p.exists(),
            "cargo treats a missing rerun-if-changed path as always dirty: {}",
            p.display()
        );
    }
}
