//! Fixtures that are deliberately not repositories must stay unreachable from a repository
//! that encloses `TMPDIR`: an agent worktree's scratch directory is one. Each re-executed
//! test below is one that used to register worktrees and branches in the enclosing repo.
#![allow(clippy::disallowed_methods)]

use crate::common;
use std::path::Path;
use std::process::Command;

fn git(dir: &Path, args: &[&str]) -> String {
    let out = Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(["-c", "user.name=t", "-c", "user.email=t@example.invalid"])
        .args(args)
        .output()
        .expect("run git");
    assert!(
        out.status.success(),
        "git {args:?} in {}: {}",
        dir.display(),
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8_lossy(&out.stdout).into_owned()
}

#[test]
fn fixtures_outside_git_cannot_reach_a_repository_enclosing_tmpdir() {
    let root = houston_core::fixture_dirs::tempdir_outside_git();
    let repo = root.path().join("enclosing");
    let scratch = repo.join("tmp");
    std::fs::create_dir_all(&scratch).unwrap();
    git(&repo, &["init", "-q", "-b", "main"]);
    git(&repo, &["commit", "-q", "--allow-empty", "-m", "base"]);
    let head = git(&repo, &["rev-parse", "HEAD"]);

    let cases = [
        (
            "it::worktree_spawn_wire",
            "a_worktree_spawn_outside_git_is_refused_and_creates_nothing",
        ),
        (
            "it::orchestration_wire",
            "keyed_worktree_refusal_before_checkout_releases_the_receipt",
        ),
        (
            "it::worktrees_wire",
            "a_non_git_directory_is_refused_by_name",
        ),
        ("it::git_wire", "non_git_dir_replies_not_a_repo_status"),
        (
            "it::checkpoints_wire",
            "a_non_git_directory_is_refused_by_name",
        ),
        (
            "it::routines_wire",
            "isolation_outside_a_git_repo_is_refused_naming_the_directory",
        ),
    ];
    for (module, name) in cases {
        let out = Command::new(std::env::current_exe().unwrap())
            .args(["--exact", &common::exact_path(module, name)])
            .env("TMPDIR", &scratch)
            .env("TMP", &scratch)
            .env("TEMP", &scratch)
            .output()
            .expect("re-execute the fixture test");
        assert!(
            out.status.success(),
            "{module}::{name} failed with TMPDIR={}:\n{}\n{}",
            scratch.display(),
            String::from_utf8_lossy(&out.stdout),
            String::from_utf8_lossy(&out.stderr)
        );
    }

    let worktrees = git(&repo, &["worktree", "list", "--porcelain"]);
    assert_eq!(
        worktrees.matches("worktree ").count(),
        1,
        "a fixture registered a worktree in the enclosing repository:\n{worktrees}"
    );
    let refs = git(&repo, &["for-each-ref", "--format=%(refname)"]);
    assert_eq!(
        refs.trim(),
        "refs/heads/main",
        "a fixture created a ref in the enclosing repository"
    );
    assert_eq!(git(&repo, &["rev-parse", "HEAD"]), head);
}
