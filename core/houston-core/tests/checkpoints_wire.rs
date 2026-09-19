#![allow(clippy::disallowed_methods)]

use houston_core::checkpoints;
use std::path::Path;
use std::process::Command;

fn run_git(dir: &Path, args: &[&str]) {
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

fn git_out(dir: &Path, args: &[&str]) -> String {
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
    String::from_utf8_lossy(&out.stdout).into_owned()
}

fn init_repo(dir: &Path) {
    run_git(dir, &["init", "-b", "main"]);
    run_git(dir, &["config", "user.email", "t@t.local"]);
    run_git(dir, &["config", "user.name", "t"]);
    std::fs::write(dir.join("README.md"), "hello\n").unwrap();
    run_git(dir, &["add", "-A"]);
    run_git(dir, &["commit", "-m", "init"]);
}

fn read(dir: &Path, name: &str) -> String {
    std::fs::read_to_string(dir.join(name)).unwrap()
}

#[test]
fn a_checkpoint_reverts_a_changed_file_and_removes_an_untracked_one() {
    let tmp = tempfile::tempdir().unwrap();
    init_repo(tmp.path());
    std::fs::write(tmp.path().join("tracked.txt"), "original\n").unwrap();
    run_git(tmp.path(), &["add", "-A"]);
    run_git(tmp.path(), &["commit", "-m", "baseline"]);

    let before = checkpoints::capture(tmp.path(), "owner_1", "before").unwrap();
    assert_eq!(
        before.r#ref,
        checkpoints::checkpoint_ref("owner_1", "before"),
        "a checkpoint is a hidden ref, not a branch or a tag"
    );

    std::fs::write(tmp.path().join("tracked.txt"), "changed\n").unwrap();
    std::fs::write(tmp.path().join("untracked.txt"), "new file\n").unwrap();
    let after = checkpoints::capture(tmp.path(), "owner_1", "after").unwrap();

    checkpoints::revert(tmp.path(), &before).unwrap();

    assert_eq!(
        read(tmp.path(), "tracked.txt"),
        "original\n",
        "revert must restore the file the operation changed"
    );
    assert!(
        !tmp.path().join("untracked.txt").exists(),
        "an untracked file the operation created is inside the snapshot and must be removed by revert"
    );

    checkpoints::revert(tmp.path(), &after).unwrap();
    assert_eq!(read(tmp.path(), "tracked.txt"), "changed\n");
    assert_eq!(read(tmp.path(), "untracked.txt"), "new file\n");
}

#[test]
fn a_staged_new_file_is_removed_by_revert() {
    let tmp = tempfile::tempdir().unwrap();
    init_repo(tmp.path());

    let before = checkpoints::capture(tmp.path(), "owner_1", "before").unwrap();
    std::fs::write(tmp.path().join("staged.txt"), "created and staged\n").unwrap();
    run_git(tmp.path(), &["add", "staged.txt"]);

    checkpoints::revert(tmp.path(), &before).unwrap();
    assert!(
        !tmp.path().join("staged.txt").exists(),
        "staging a file during the operation must not save it from the revert"
    );
}

#[test]
fn a_file_recreated_during_a_operation_is_removed_by_revert() {
    let tmp = tempfile::tempdir().unwrap();
    init_repo(tmp.path());
    std::fs::write(tmp.path().join("gone.txt"), "original\n").unwrap();
    run_git(tmp.path(), &["add", "-A"]);
    run_git(tmp.path(), &["commit", "-m", "with the file"]);
    // Deleted from the worktree only: HEAD and the real index still hold it,
    // so the snapshot must learn it is gone while the index keeps it alive.
    std::fs::remove_file(tmp.path().join("gone.txt")).unwrap();

    let before = checkpoints::capture(tmp.path(), "owner_1", "before").unwrap();
    std::fs::write(tmp.path().join("gone.txt"), "recreated by the operation\n").unwrap();

    checkpoints::revert(tmp.path(), &before).unwrap();
    assert!(
        !tmp.path().join("gone.txt").exists(),
        "reverting to a state without the file must remove the operation's recreation"
    );
}

#[test]
fn a_checkpoint_reverts_in_a_repository_without_a_commit() {
    let tmp = tempfile::tempdir().unwrap();
    run_git(tmp.path(), &["init", "-b", "main"]);
    run_git(tmp.path(), &["config", "user.email", "t@t.local"]);
    run_git(tmp.path(), &["config", "user.name", "t"]);
    std::fs::write(tmp.path().join("first.txt"), "here before the operation\n").unwrap();
    let before = checkpoints::capture(tmp.path(), "owner_1", "before").unwrap();
    std::fs::write(
        tmp.path().join("second.txt"),
        "created during the operation\n",
    )
    .unwrap();

    checkpoints::revert(tmp.path(), &before).unwrap();
    assert_eq!(
        read(tmp.path(), "first.txt"),
        "here before the operation\n",
        "the snapshot the revert targets must survive in a repo with no HEAD"
    );
    assert!(
        !tmp.path().join("second.txt").exists(),
        "the operation's creation must be reverted even with no HEAD behind it"
    );
}

#[test]
fn checkpoints_are_not_branches_tags_or_stashes() {
    let tmp = tempfile::tempdir().unwrap();
    init_repo(tmp.path());
    checkpoints::capture(tmp.path(), "owner_1", "before").unwrap();

    let branches = git_out(tmp.path(), &["branch", "--format=%(refname)"]);
    assert!(
        !branches.contains("houston"),
        "a checkpoint must not appear as a branch: {branches}"
    );
    let tags = git_out(tmp.path(), &["tag", "--list"]);
    assert!(
        tags.trim().is_empty(),
        "a checkpoint must not be a tag: {tags}"
    );
    let stashes = git_out(tmp.path(), &["stash", "list"]);
    assert!(
        stashes.trim().is_empty(),
        "a checkpoint must not be a visible stash: {stashes}"
    );
}

#[test]
fn list_reports_both_boundaries_of_a_operation() {
    let tmp = tempfile::tempdir().unwrap();
    init_repo(tmp.path());
    checkpoints::capture(tmp.path(), "owner_1", "before").unwrap();
    std::fs::write(tmp.path().join("a.txt"), "x\n").unwrap();
    checkpoints::capture(tmp.path(), "owner_1", "after").unwrap();

    let listed = checkpoints::list(tmp.path(), Some("owner_1")).unwrap();
    assert_eq!(
        listed.len(),
        2,
        "expected a before and an after: {listed:?}"
    );
    assert!(listed.iter().any(|c| c.label == "before"));
    assert!(listed.iter().any(|c| c.label == "after"));
    assert!(checkpoints::exists(tmp.path(), &listed[0].r#ref));
}

#[test]
fn a_diff_reports_the_change_between_two_checkpoints() {
    let tmp = tempfile::tempdir().unwrap();
    init_repo(tmp.path());
    std::fs::write(tmp.path().join("tracked.txt"), "original\n").unwrap();
    run_git(tmp.path(), &["add", "-A"]);
    run_git(tmp.path(), &["commit", "-m", "baseline"]);

    let before = checkpoints::capture(tmp.path(), "owner_1", "before").unwrap();
    std::fs::write(tmp.path().join("tracked.txt"), "original\nmore\n").unwrap();
    let after = checkpoints::capture(tmp.path(), "owner_1", "after").unwrap();

    let diff = git_out(
        tmp.path(),
        &["diff", "--no-color", &before.r#ref, &after.r#ref],
    );
    assert!(diff.contains("+more"), "{diff}");
    let stats = git_out(
        tmp.path(),
        &["diff", "--numstat", &before.r#ref, &after.r#ref],
    );
    assert_eq!(stats, "1\t0\ttracked.txt\n");
}

#[test]
fn a_non_git_directory_is_refused_by_name() {
    let tmp = tempfile::tempdir().unwrap();
    let err = checkpoints::capture(tmp.path(), "owner_1", "before")
        .unwrap_err()
        .to_string();
    assert!(err.contains("not a git repository"), "unexpected: {err}");
}

#[test]
fn opaque_keys_roundtrip_without_collisions_and_can_be_deleted() {
    let tmp = tempfile::tempdir().unwrap();
    init_repo(tmp.path());
    for (owner, label) in [("A/B", "before / ação"), ("a-b", "before / ação"), ("", "")] {
        let checkpoint = checkpoints::capture(tmp.path(), owner, label).unwrap();
        assert_eq!(
            checkpoints::list(tmp.path(), Some(owner)).unwrap(),
            vec![checkpoint.clone()]
        );
    }
    let first = checkpoints::list(tmp.path(), Some("A/B"))
        .unwrap()
        .remove(0);
    checkpoints::delete(tmp.path(), &first.r#ref).unwrap();
    assert!(!checkpoints::exists(tmp.path(), &first.r#ref));
    assert!(checkpoints::list(tmp.path(), Some("A/B"))
        .unwrap()
        .is_empty());
    assert_eq!(checkpoints::list(tmp.path(), Some("a-b")).unwrap().len(), 1);
}

#[test]
fn capture_preserves_head_and_the_real_index_and_excludes_ignored_files() {
    let tmp = tempfile::tempdir().unwrap();
    init_repo(tmp.path());
    std::fs::write(tmp.path().join(".gitignore"), "ignored.txt\n").unwrap();
    std::fs::write(tmp.path().join("README.md"), "staged\n").unwrap();
    run_git(tmp.path(), &["add", "README.md"]);
    std::fs::write(tmp.path().join("README.md"), "working copy\n").unwrap();
    std::fs::write(tmp.path().join("ignored.txt"), "private\n").unwrap();
    let index = git_out(tmp.path(), &["diff", "--cached"]);
    let head = git_out(tmp.path(), &["rev-parse", "HEAD"]);
    let checkpoint = checkpoints::capture(tmp.path(), "owner", "snapshot").unwrap();
    assert_eq!(git_out(tmp.path(), &["diff", "--cached"]), index);
    assert_eq!(git_out(tmp.path(), &["rev-parse", "HEAD"]), head);
    assert_eq!(
        git_out(
            tmp.path(),
            &["show", &format!("{}:README.md", checkpoint.r#ref)]
        ),
        "working copy\n"
    );
    assert!(!git_out(
        tmp.path(),
        &["ls-tree", "-r", "--name-only", &checkpoint.r#ref]
    )
    .contains("ignored.txt"));
}
