#![allow(clippy::disallowed_methods)]

use crate::common;

use common::*;
use futures_util::SinkExt;
use houston_protocol as proto;
use std::path::Path;
use std::process::{Command, Output};
use tokio_tungstenite::tungstenite::Message;

fn run(dir: &Path, args: &[&str]) -> Output {
    Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(args)
        .env("GIT_EDITOR", "true")
        .output()
        .unwrap()
}

fn git(dir: &Path, args: &[&str]) {
    let out = run(dir, args);
    assert!(
        out.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&out.stderr)
    );
}

/// The operation is expected to stop on a conflict, which git reports as a failure.
fn git_conflicts(dir: &Path, args: &[&str]) {
    let out = run(dir, args);
    assert!(
        !out.status.success(),
        "git {args:?} was expected to stop on a conflict"
    );
}

/// `main` and `feature` both rewrite README.md from the same parent.
fn diverged_repo(dir: &Path) {
    git(dir, &["init", "-b", "main"]);
    git(dir, &["config", "core.autocrlf", "false"]);
    git(dir, &["config", "user.email", "t@t.local"]);
    git(dir, &["config", "user.name", "t"]);
    std::fs::write(dir.join("README.md"), "hello\n").unwrap();
    git(dir, &["add", "-A"]);
    git(dir, &["commit", "-m", "init"]);
    git(dir, &["switch", "-c", "feature"]);
    std::fs::write(dir.join("README.md"), "feature\n").unwrap();
    git(dir, &["commit", "-am", "feature"]);
    git(dir, &["switch", "main"]);
    std::fs::write(dir.join("README.md"), "main\n").unwrap();
    git(dir, &["commit", "-am", "main"]);
}

async fn status(
    ws: &mut WsStream,
    dir: &Path,
) -> (Option<proto::GitOperation>, Vec<proto::GitFileStatus>) {
    let dir = dir.display().to_string();
    ws.send(Message::text(
        serde_json::to_string(&proto::ClientMsg::GitStatus {
            dir: dir.clone(),
            base: None,
        })
        .unwrap(),
    ))
    .await
    .unwrap();
    loop {
        match next_control(ws).await {
            proto::ServerMsg::GitStatus {
                dir: d,
                operation,
                files,
                ..
            } if d == dir => return (operation, files),
            proto::ServerMsg::Error { message, .. } => panic!("daemon error: {message}"),
            _ => continue,
        }
    }
}

fn conflicted(files: &[proto::GitFileStatus]) -> Vec<&str> {
    files
        .iter()
        .filter(|f| f.status == proto::GitFileState::Conflicted)
        .map(|f| f.path.as_str())
        .collect()
}

#[tokio::test]
async fn a_paused_merge_rebase_or_cherry_pick_is_reported_with_the_status() {
    let (addr, _state, _daemon) = start_daemon_with_handle().await;
    let repo = tempfile::tempdir().unwrap();
    let dir = repo.path();
    diverged_repo(dir);
    let mut ws = connect_and_hello(addr, TOKEN).await;
    let _ = next_control(&mut ws).await;

    assert_eq!(status(&mut ws, dir).await.0, None);

    git_conflicts(dir, &["merge", "feature"]);
    let (operation, files) = status(&mut ws, dir).await;
    assert_eq!(operation, Some(proto::GitOperation::Merge));
    assert_eq!(conflicted(&files), ["README.md"]);
    git(dir, &["merge", "--abort"]);
    assert_eq!(status(&mut ws, dir).await.0, None);

    git_conflicts(dir, &["cherry-pick", "feature"]);
    assert_eq!(
        status(&mut ws, dir).await.0,
        Some(proto::GitOperation::CherryPick)
    );
    git(dir, &["cherry-pick", "--abort"]);

    git(dir, &["switch", "feature"]);
    git_conflicts(dir, &["rebase", "main"]);
    assert_eq!(
        status(&mut ws, dir).await.0,
        Some(proto::GitOperation::Rebase)
    );
    git(dir, &["rebase", "--abort"]);
    assert_eq!(status(&mut ws, dir).await.0, None);
}

#[tokio::test]
async fn a_paused_operation_belongs_to_its_own_worktree() {
    let (addr, _state, _daemon) = start_daemon_with_handle().await;
    let repo = tempfile::tempdir().unwrap();
    let dir = repo.path().join("main");
    std::fs::create_dir(&dir).unwrap();
    diverged_repo(&dir);
    let tree = repo.path().join("linked");
    git(
        &dir,
        &["worktree", "add", &tree.display().to_string(), "feature"],
    );
    let mut ws = connect_and_hello(addr, TOKEN).await;
    let _ = next_control(&mut ws).await;

    git_conflicts(&tree, &["rebase", "main"]);
    assert_eq!(
        status(&mut ws, &tree).await.0,
        Some(proto::GitOperation::Rebase)
    );
    assert_eq!(
        status(&mut ws, &dir).await.0,
        None,
        "the main checkout has nothing paused"
    );
    git(&tree, &["rebase", "--abort"]);
}
