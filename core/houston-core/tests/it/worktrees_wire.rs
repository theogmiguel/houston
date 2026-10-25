#![allow(clippy::disallowed_methods)]

use houston_core::{git, worktrees};
use std::path::{Path, PathBuf};
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

fn init_repo(dir: &Path) {
    run_git(dir, &["init", "-b", "main"]);
    run_git(dir, &["config", "user.email", "t@t.local"]);
    run_git(dir, &["config", "user.name", "t"]);
    std::fs::write(dir.join("README.md"), "hello\n").unwrap();
    run_git(dir, &["add", "-A"]);
    run_git(dir, &["commit", "-m", "init"]);
}

// The repo and its worktrees are siblings: a worktree nested inside the parent
// working tree is visible to the parent's status and is not how tasks use one.
struct Fixture {
    root: tempfile::TempDir,
    repo: PathBuf,
}

fn fixture() -> Fixture {
    let root = tempfile::tempdir().unwrap();
    let repo = root.path().join("repo");
    std::fs::create_dir_all(&repo).unwrap();
    init_repo(&repo);
    Fixture { root, repo }
}

impl Fixture {
    fn worktree(&self, name: &str) -> PathBuf {
        self.root.path().join("worktrees").join(name)
    }
}

#[test]
fn a_task_worktree_is_created_listed_and_removed() {
    let f = fixture();
    let dest = f.worktree("task_1");

    let wt = worktrees::create(&f.repo, "task_1", None, &dest).unwrap();
    assert_eq!(wt.branch.as_deref(), Some("houston/task/task_1"));
    assert!(dest.exists(), "the worktree directory must exist");
    assert_eq!(
        git::branch(&dest).as_deref(),
        Some("houston/task/task_1"),
        "the new worktree must be on the task's branch"
    );

    let listed = worktrees::list(&f.repo).unwrap();
    let entry = listed
        .iter()
        .find(|w| w.path == dest)
        .expect("the new worktree must be listed");
    assert_eq!(entry.branch.as_deref(), Some("houston/task/task_1"));
    assert!(!entry.is_main);

    worktrees::remove(&f.repo, &dest, false).unwrap();
    assert!(!dest.exists(), "remove is the reverse of create");
}

#[test]
fn a_second_task_cannot_reuse_a_branch() {
    let f = fixture();
    worktrees::create(&f.repo, "task_1", None, &f.worktree("one")).unwrap();

    let err = worktrees::create(&f.repo, "task_1", None, &f.worktree("two"))
        .unwrap_err()
        .to_string();
    assert!(err.contains("already exists"), "unexpected: {err}");
}

#[test]
fn an_occupied_path_is_refused_by_name() {
    let f = fixture();
    let dest = f.worktree("occupied");
    std::fs::create_dir_all(&dest).unwrap();

    let err = worktrees::create(&f.repo, "task_1", None, &dest)
        .unwrap_err()
        .to_string();
    assert!(err.contains("already occupied"), "unexpected: {err}");
}

#[test]
fn removing_a_dirty_worktree_is_refused_until_forced() {
    let f = fixture();
    let dest = f.worktree("task_1");
    worktrees::create(&f.repo, "task_1", None, &dest).unwrap();
    std::fs::write(dest.join("scratch.txt"), "uncommitted\n").unwrap();

    let err = worktrees::remove(&f.repo, &dest, false)
        .unwrap_err()
        .to_string();
    assert!(err.contains("uncommitted changes"), "unexpected: {err}");
    assert!(
        dest.exists(),
        "a refused remove must leave the worktree in place"
    );

    worktrees::remove(&f.repo, &dest, true).unwrap();
    assert!(!dest.exists());
}

#[test]
fn a_missing_base_ref_is_refused_by_name() {
    let f = fixture();
    let dest = f.worktree("task_1");

    let err = worktrees::create(&f.repo, "task_1", Some("no-such-branch"), &dest)
        .unwrap_err()
        .to_string();
    assert!(err.contains("no-such-branch"), "unexpected: {err}");
    assert!(
        !dest.exists(),
        "a refused create must not make the directory"
    );
}

#[test]
fn a_non_git_directory_is_refused_by_name() {
    let tmp = houston_core::fixture_dirs::tempdir_outside_git();
    let dest = tmp.path().join("wt");
    let err = worktrees::create(tmp.path(), "task_1", None, &dest)
        .unwrap_err()
        .to_string();
    assert!(err.contains("not a git repository"), "unexpected: {err}");
}

/// A daemon against a throwaway home, so the Claude history probe reads a bucket the
/// test planted instead of the account's real `~/.claude/projects`.
fn history_daemon(
    home: &Path,
) -> (
    std::sync::Arc<houston_core::daemon::Daemon>,
    tempfile::TempDir,
) {
    let state = houston_core::fixture_dirs::tempdir_outside_git();
    let env = crate::common::capture_env()
        .with("HOME", Some(home))
        .with("USERPROFILE", Some(home))
        .without("CLAUDE_CONFIG_DIR");
    let daemon = houston_core::daemon::Daemon::new(houston_core::daemon::DaemonConfig::new(
        "slug-history-wire".into(),
        state.path().join("test.db"),
        env,
    ))
    .unwrap();
    (daemon, state)
}

/// Claude names its history bucket after the plain cwd it was started in.
fn plant_history(home: &Path, dir: &Path) -> PathBuf {
    let bucket =
        home.join(".claude")
            .join("projects")
            .join(houston_core::harness::digest::claude_slug(Path::new(
                &houston_core::launch::brief_display_path(dir),
            )));
    std::fs::create_dir_all(&bucket).unwrap();
    std::fs::write(bucket.join("session.jsonl"), "{}\n").unwrap();
    bucket
}

#[test]
fn a_reused_slug_whose_history_survives_is_created_under_a_fresh_name() {
    let f = fixture();
    let home = tempfile::tempdir().unwrap();
    let (daemon, state) = history_daemon(home.path());

    let first = daemon.git_worktree_create(&f.repo, "demo", None).unwrap().0;
    let bucket = plant_history(home.path(), &first.path);
    daemon
        .git_worktree_remove(&f.repo, &first.path, false)
        .unwrap();
    run_git(&f.repo, &["branch", "-D", "houston/demo"]);

    let (second, notes) = daemon.git_worktree_create(&f.repo, "demo", None).unwrap();
    let expected = first.path.with_file_name("demo-2");
    assert_eq!(
        second.path, expected,
        "the fresh name must spend a new history bucket"
    );
    assert_eq!(second.branch.as_deref(), Some("houston/demo-2"));
    assert!(
        notes
            .iter()
            .any(|note| note.contains("demo") && note.contains("demo-2")),
        "the result must name the collision: {notes:?}"
    );
    assert!(
        bucket.is_dir(),
        "the old checkout's history stays where it was"
    );
    drop(daemon);
    drop(state);
}

#[test]
fn a_slug_whose_history_is_gone_is_reused_unchanged() {
    let f = fixture();
    let home = tempfile::tempdir().unwrap();
    let (daemon, state) = history_daemon(home.path());

    let first = daemon
        .git_worktree_create(&f.repo, "fresh", None)
        .unwrap()
        .0;
    daemon
        .git_worktree_remove(&f.repo, &first.path, false)
        .unwrap();
    run_git(&f.repo, &["branch", "-D", "houston/fresh"]);

    let (second, notes) = daemon.git_worktree_create(&f.repo, "fresh", None).unwrap();
    assert_eq!(second.path, first.path, "a clean path reuses the slug");
    assert!(
        notes.iter().all(|note| !note.contains("fresh")),
        "no collision is named when no history survives: {notes:?}"
    );
    drop(daemon);
    drop(state);
}
