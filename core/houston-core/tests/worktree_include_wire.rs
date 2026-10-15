#![allow(clippy::disallowed_methods)]

mod common;

use common::*;
use houston_core::worktree_include::{carry_over_within, Limits, INCLUDE_FILE};
use std::path::{Path, PathBuf};
use std::process::Command;

fn git(dir: &Path, args: &[&str]) -> String {
    let out = Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(args)
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "git {args:?} in {}: {}",
        dir.display(),
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8_lossy(&out.stdout).into_owned()
}

/// A repository whose `.worktreeinclude` lists `.env` (ignored, at any depth),
/// `settings.json` (tracked) and `notes.txt` (untracked, not ignored). `secret.key` is
/// ignored and not listed. The source checkout holds a local edit to `settings.json`.
fn repo(root: &Path) -> PathBuf {
    let dir = root.join("repo");
    std::fs::create_dir_all(&dir).unwrap();
    git(&dir, &["init", "-q", "-b", "main"]);
    git(&dir, &["config", "user.email", "t@t.local"]);
    git(&dir, &["config", "user.name", "t"]);
    git(&dir, &["config", "core.autocrlf", "false"]);
    std::fs::write(dir.join(".gitignore"), ".env\n*.key\n").unwrap();
    std::fs::write(dir.join(INCLUDE_FILE), ".env\nsettings.json\nnotes.txt\n").unwrap();
    std::fs::write(dir.join("settings.json"), "committed\n").unwrap();
    git(&dir, &["add", "-A"]);
    git(&dir, &["commit", "-q", "-m", "init"]);
    std::fs::write(dir.join(".env"), "TOKEN=root\n").unwrap();
    std::fs::create_dir_all(dir.join("app")).unwrap();
    std::fs::write(dir.join("app").join(".env"), "TOKEN=app\n").unwrap();
    std::fs::write(dir.join("secret.key"), "not listed\n").unwrap();
    std::fs::write(dir.join("notes.txt"), "not ignored\n").unwrap();
    std::fs::write(dir.join("settings.json"), "local edit\n").unwrap();
    dir.canonicalize().unwrap()
}

fn tree(repo: &Path, root: &Path, slug: &str) -> PathBuf {
    let dest = root.join(format!("wt-{slug}"));
    houston_core::worktrees::create_named(repo, slug, None, &dest).unwrap();
    dest
}

fn read(path: &Path) -> String {
    std::fs::read_to_string(path).unwrap()
}

#[tokio::test]
async fn a_changes_pane_worktree_gets_the_listed_ignored_files_and_nothing_else() {
    let (_addr, _state, daemon) = start_daemon_with_handle().await;
    let root = tempfile::tempdir().unwrap();
    let repo = repo(root.path());

    let (wt, warnings) = daemon.git_worktree_create(&repo, "carry", None).unwrap();

    assert!(warnings.is_empty(), "{warnings:?}");
    assert_eq!(read(&wt.path.join(".env")), "TOKEN=root\n");
    assert_eq!(read(&wt.path.join("app").join(".env")), "TOKEN=app\n");
    assert!(
        !wt.path.join("secret.key").exists(),
        "an ignored file the list does not name stays behind"
    );
    assert!(
        !wt.path.join("notes.txt").exists(),
        "a listed file git does not ignore stays behind"
    );
    assert_eq!(
        read(&wt.path.join("settings.json")),
        "committed\n",
        "a tracked file is never copied over the checkout"
    );
    assert_eq!(
        git(&wt.path, &["status", "--porcelain"]),
        "",
        "copied files are ignored, so the new worktree is clean"
    );
}

#[test]
fn a_repository_without_a_list_copies_nothing() {
    let root = tempfile::tempdir().unwrap();
    let repo = repo(root.path());
    std::fs::remove_file(repo.join(INCLUDE_FILE)).unwrap();
    git(&repo, &["commit", "-q", "-am", "drop the list"]);
    let dest = tree(&repo, root.path(), "bare");

    let report = carry_over_within(&repo, &dest, Limits::DEFAULT);

    assert_eq!(report, Default::default());
    assert!(!dest.join(".env").exists());
}

#[test]
fn copying_stops_at_the_file_limit_and_names_it() {
    let root = tempfile::tempdir().unwrap();
    let repo = repo(root.path());
    let dest = tree(&repo, root.path(), "files");

    let report = carry_over_within(
        &repo,
        &dest,
        Limits {
            files: 1,
            bytes: 1 << 20,
        },
    );

    assert_eq!(report.copied, vec![".env".to_string()]);
    assert!(!dest.join("app").join(".env").exists());
    assert_eq!(report.warnings.len(), 1, "{:?}", report.warnings);
    let warning = &report.warnings[0];
    assert!(
        warning.contains("the limit of 1 files (asked for 2 files)")
            && warning.contains("app/.env")
            && warning.contains(INCLUDE_FILE),
        "{warning}"
    );
}

#[test]
fn copying_stops_at_the_byte_limit_and_names_it() {
    let root = tempfile::tempdir().unwrap();
    let repo = repo(root.path());
    let dest = tree(&repo, root.path(), "bytes");

    let report = carry_over_within(
        &repo,
        &dest,
        Limits {
            files: 10,
            bytes: 12,
        },
    );

    // `.env` (11 bytes) sorts first; `app/.env` (10 bytes) would pass 12.
    assert_eq!(report.copied, vec![".env".to_string()]);
    let warning = report.warnings.join("\n");
    assert!(
        warning.contains("the limit of 12 bytes (asked for 21 bytes)")
            && warning.contains("app/.env"),
        "{warning}"
    );
    assert!(
        !warning.contains("TOKEN="),
        "a warning never carries file contents: {warning}"
    );
}

#[test]
fn a_file_already_in_the_worktree_is_kept() {
    let root = tempfile::tempdir().unwrap();
    let repo = repo(root.path());
    let dest = tree(&repo, root.path(), "own");
    std::fs::write(dest.join(".env"), "TOKEN=mine\n").unwrap();

    let report = carry_over_within(&repo, &dest, Limits::DEFAULT);

    assert_eq!(read(&dest.join(".env")), "TOKEN=mine\n");
    assert_eq!(report.copied, vec!["app/.env".to_string()]);
    assert!(
        report
            .warnings
            .iter()
            .any(|w| w.contains("not overwritten") && w.contains(".env")),
        "{:?}",
        report.warnings
    );
}

#[test]
fn an_unchanged_copy_does_not_keep_the_worktree_but_an_edited_one_does() {
    let root = tempfile::tempdir().unwrap();
    let repo = repo(root.path());
    let dest = tree(&repo, root.path(), "cleanup");
    std::fs::remove_dir_all(repo.join("app")).unwrap();
    carry_over_within(&repo, &dest, Limits::DEFAULT);
    let ignored = houston_core::worktree_cleanup::ignored_files;

    assert_eq!(
        ignored(&dest, None),
        Some(1),
        "fixture: the copy is an ignored file"
    );
    assert_eq!(
        ignored(&dest, Some(&repo)),
        Some(0),
        "a copy byte for byte the source's loses nothing when removed"
    );

    std::fs::write(dest.join(".env"), "TOKEN=edited\n").unwrap();
    assert_eq!(
        ignored(&dest, Some(&repo)),
        Some(1),
        "an edited copy keeps it"
    );

    std::fs::write(dest.join(".env"), "TOKEN=root\n").unwrap();
    std::fs::write(dest.join("own.key"), "made here\n").unwrap();
    assert_eq!(
        ignored(&dest, Some(&repo)),
        Some(1),
        "an ignored file the source does not have keeps it"
    );
}

#[cfg(unix)]
#[test]
fn a_listed_symlink_is_refused_by_name() {
    let root = tempfile::tempdir().unwrap();
    let repo = repo(root.path());
    let outside = root.path().join("outside.env");
    std::fs::write(&outside, "TOKEN=outside\n").unwrap();
    std::fs::remove_file(repo.join("app").join(".env")).unwrap();
    std::os::unix::fs::symlink(&outside, repo.join("app").join(".env")).unwrap();
    let dest = tree(&repo, root.path(), "link");

    let report = carry_over_within(&repo, &dest, Limits::DEFAULT);

    assert_eq!(report.copied, vec![".env".to_string()]);
    assert!(std::fs::symlink_metadata(dest.join("app").join(".env")).is_err());
    assert!(
        report
            .warnings
            .iter()
            .any(|w| w.contains("symlink") && w.contains("app/.env")),
        "{:?}",
        report.warnings
    );
}
