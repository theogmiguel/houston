#![allow(clippy::disallowed_methods)]

mod common;

use common::*;
use futures_util::SinkExt;
use houston_protocol as proto;
use std::path::Path;
use std::process::Command;
use tokio_tungstenite::tungstenite::Message;

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

async fn send(ws: &mut WsStream, msg: &proto::ClientMsg) {
    ws.send(Message::text(serde_json::to_string(msg).unwrap()))
        .await
        .unwrap();
}

async fn expect_status(ws: &mut WsStream) -> Vec<proto::GitFileStatus> {
    loop {
        match next_control(ws).await {
            proto::ServerMsg::GitStatus { files, .. } => return files,
            proto::ServerMsg::Error { message, .. } => panic!("daemon error: {message}"),
            _ => continue,
        }
    }
}

async fn expect_error(ws: &mut WsStream) -> String {
    loop {
        match next_control(ws).await {
            proto::ServerMsg::Error { message, .. } => return message,
            proto::ServerMsg::GitStatus { .. } => {
                panic!("expected a refusal, got a status — the discard ran")
            }
            _ => continue,
        }
    }
}

#[tokio::test]
async fn discard_unstaged_restores_the_file_and_replies_with_a_fresh_status() {
    let (addr, _state) = start_daemon().await;
    let repo = tempfile::tempdir().unwrap();
    init_repo(repo.path());
    std::fs::write(repo.path().join("README.md"), "hello\nedited\n").unwrap();

    let mut ws = connect_and_hello(addr, TOKEN).await;
    let _ = next_control(&mut ws).await;
    let dir = repo.path().display().to_string();

    send(
        &mut ws,
        &proto::ClientMsg::GitDiscard {
            dir: dir.clone(),
            path: "README.md".into(),
            kind: proto::GitDiscardKind::Unstaged,
        },
    )
    .await;
    let files = expect_status(&mut ws).await;
    assert!(files.is_empty(), "tree should be clean, got {files:?}");
    assert_eq!(
        std::fs::read_to_string(repo.path().join("README.md")).unwrap(),
        "hello\n"
    );
}

#[tokio::test]
async fn discard_staged_drops_the_index_and_the_worktree_change() {
    let (addr, _state) = start_daemon().await;
    let repo = tempfile::tempdir().unwrap();
    init_repo(repo.path());
    std::fs::write(repo.path().join("README.md"), "hello\nstaged\n").unwrap();
    git(repo.path(), &["add", "-A"]);

    let mut ws = connect_and_hello(addr, TOKEN).await;
    let _ = next_control(&mut ws).await;
    let dir = repo.path().display().to_string();

    send(
        &mut ws,
        &proto::ClientMsg::GitDiscard {
            dir: dir.clone(),
            path: "README.md".into(),
            kind: proto::GitDiscardKind::Staged,
        },
    )
    .await;
    let files = expect_status(&mut ws).await;
    assert!(files.is_empty(), "tree should be clean, got {files:?}");
    assert_eq!(
        std::fs::read_to_string(repo.path().join("README.md")).unwrap(),
        "hello\n",
        "the worktree edit must go too, not just the index entry"
    );
}

#[tokio::test]
async fn discard_untracked_deletes_the_file() {
    let (addr, _state) = start_daemon().await;
    let repo = tempfile::tempdir().unwrap();
    init_repo(repo.path());
    std::fs::write(repo.path().join("scratch.txt"), "throwaway\n").unwrap();

    let mut ws = connect_and_hello(addr, TOKEN).await;
    let _ = next_control(&mut ws).await;
    let dir = repo.path().display().to_string();

    send(
        &mut ws,
        &proto::ClientMsg::GitDiscard {
            dir: dir.clone(),
            path: "scratch.txt".into(),
            kind: proto::GitDiscardKind::Untracked,
        },
    )
    .await;
    let files = expect_status(&mut ws).await;
    assert!(files.is_empty(), "tree should be clean, got {files:?}");
    assert!(!repo.path().join("scratch.txt").exists());
}

#[tokio::test]
async fn discard_refuses_a_path_that_escapes_the_repo() {
    let (addr, _state) = start_daemon().await;
    let repo = tempfile::tempdir().unwrap();
    init_repo(repo.path());
    let outside = repo.path().parent().unwrap().join("outside.txt");
    std::fs::write(&outside, "do not delete\n").unwrap();

    let mut ws = connect_and_hello(addr, TOKEN).await;
    let _ = next_control(&mut ws).await;

    send(
        &mut ws,
        &proto::ClientMsg::GitDiscard {
            dir: repo.path().display().to_string(),
            path: "../outside.txt".into(),
            kind: proto::GitDiscardKind::Untracked,
        },
    )
    .await;
    let message = expect_error(&mut ws).await;
    assert!(
        message.contains("../outside.txt") && message.contains(".."),
        "the refusal must name the offending value: {message}"
    );
    assert!(outside.exists(), "the outside file must survive");
}

#[tokio::test]
async fn discard_refuses_a_sensitive_path() {
    let (addr, _state) = start_daemon().await;
    let repo = tempfile::tempdir().unwrap();
    init_repo(repo.path());
    std::fs::write(repo.path().join(".env.local"), "TOKEN=shh\n").unwrap();

    let mut ws = connect_and_hello(addr, TOKEN).await;
    let _ = next_control(&mut ws).await;

    send(
        &mut ws,
        &proto::ClientMsg::GitDiscard {
            dir: repo.path().display().to_string(),
            path: ".env.local".into(),
            kind: proto::GitDiscardKind::Untracked,
        },
    )
    .await;
    let message = expect_error(&mut ws).await;
    assert!(
        message.contains(".env.local") && message.contains("sensitive"),
        "the refusal must name the value and the rule: {message}"
    );
    assert!(repo.path().join(".env.local").exists());
}
