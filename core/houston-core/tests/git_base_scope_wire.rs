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

fn branched_repo(dir: &Path) {
    git(dir, &["init", "-b", "main"]);
    git(dir, &["config", "user.email", "t@t.local"]);
    git(dir, &["config", "user.name", "t"]);
    std::fs::write(dir.join("README.md"), "hello\n").unwrap();
    git(dir, &["add", "-A"]);
    git(dir, &["commit", "-m", "init"]);
    git(dir, &["checkout", "-b", "feature"]);
    std::fs::write(dir.join("committed.txt"), "on the branch\n").unwrap();
    git(dir, &["add", "-A"]);
    git(dir, &["commit", "-m", "branch work"]);
    std::fs::write(dir.join("dirty.txt"), "not committed\n").unwrap();
}

async fn send(ws: &mut WsStream, msg: &proto::ClientMsg) {
    ws.send(Message::text(serde_json::to_string(msg).unwrap()))
        .await
        .unwrap();
}

struct Status {
    files: Vec<proto::GitFileStatus>,
    base: Option<String>,
    default_base: Option<String>,
}

async fn expect_status(ws: &mut WsStream) -> Status {
    loop {
        match next_control(ws).await {
            proto::ServerMsg::GitStatus {
                files,
                base,
                default_base,
                ..
            } => {
                return Status {
                    files,
                    base,
                    default_base,
                }
            }
            proto::ServerMsg::Error { message, .. } => panic!("daemon error: {message}"),
            _ => continue,
        }
    }
}

#[tokio::test]
async fn working_tree_scope_is_unchanged_and_names_the_default_base() {
    let (addr, _state) = start_daemon().await;
    let repo = tempfile::tempdir().unwrap();
    branched_repo(repo.path());

    let mut ws = connect_and_hello(addr, TOKEN).await;
    let _ = next_control(&mut ws).await;

    send(
        &mut ws,
        &proto::ClientMsg::GitStatus {
            dir: repo.path().display().to_string(),
            base: None,
        },
    )
    .await;
    let st = expect_status(&mut ws).await;
    assert_eq!(st.base, None);
    assert_eq!(
        st.default_base.as_deref(),
        Some("main"),
        "with no origin/HEAD, `main` is the resolved base"
    );
    let paths: Vec<&str> = st.files.iter().map(|f| f.path.as_str()).collect();
    assert!(paths.contains(&"dirty.txt"));
    assert!(
        !paths.contains(&"committed.txt"),
        "a committed file is not a working-tree change"
    );
}

#[tokio::test]
async fn branch_vs_base_scope_lists_committed_and_uncommitted_changes() {
    let (addr, _state) = start_daemon().await;
    let repo = tempfile::tempdir().unwrap();
    branched_repo(repo.path());

    let mut ws = connect_and_hello(addr, TOKEN).await;
    let _ = next_control(&mut ws).await;

    send(
        &mut ws,
        &proto::ClientMsg::GitStatus {
            dir: repo.path().display().to_string(),
            base: Some("main".into()),
        },
    )
    .await;
    let st = expect_status(&mut ws).await;
    assert_eq!(
        st.base.as_deref(),
        Some("main"),
        "the reply echoes the scope so a raced toggle can drop it"
    );
    let paths: Vec<&str> = st.files.iter().map(|f| f.path.as_str()).collect();
    assert!(
        paths.contains(&"committed.txt"),
        "the branch's own commit must appear: {paths:?}"
    );
    assert!(
        paths.contains(&"dirty.txt"),
        "the working tree rides on top: {paths:?}"
    );
    let committed = st.files.iter().find(|f| f.path == "committed.txt").unwrap();
    assert!(
        committed.staged,
        "a committed-on-branch entry sits on the staged side, where the pane groups it"
    );
}

#[tokio::test]
async fn branch_vs_base_diff_covers_the_committed_change() {
    let (addr, _state) = start_daemon().await;
    let repo = tempfile::tempdir().unwrap();
    branched_repo(repo.path());

    let mut ws = connect_and_hello(addr, TOKEN).await;
    let _ = next_control(&mut ws).await;

    send(
        &mut ws,
        &proto::ClientMsg::GitDiff {
            dir: repo.path().display().to_string(),
            path: Some("committed.txt".into()),
            base: Some("main".into()),
        },
    )
    .await;
    loop {
        match next_control(&mut ws).await {
            proto::ServerMsg::GitDiff { patch, base, .. } => {
                assert_eq!(base.as_deref(), Some("main"));
                assert!(
                    patch.contains("+on the branch"),
                    "branch scope must show the committed change: {patch}"
                );
                break;
            }
            proto::ServerMsg::Error { message, .. } => panic!("daemon error: {message}"),
            _ => continue,
        }
    }
}

#[tokio::test]
async fn an_unknown_base_errors_instead_of_falling_back() {
    let (addr, _state) = start_daemon().await;
    let repo = tempfile::tempdir().unwrap();
    branched_repo(repo.path());

    let mut ws = connect_and_hello(addr, TOKEN).await;
    let _ = next_control(&mut ws).await;

    send(
        &mut ws,
        &proto::ClientMsg::GitStatus {
            dir: repo.path().display().to_string(),
            base: Some("no-such-branch".into()),
        },
    )
    .await;
    loop {
        match next_control(&mut ws).await {
            proto::ServerMsg::Error { message, .. } => {
                assert!(
                    message.contains("no-such-branch"),
                    "the error must name the base it could not resolve: {message}"
                );
                break;
            }
            proto::ServerMsg::GitStatus { .. } => {
                panic!("an unresolvable base must not silently return the working tree")
            }
            _ => continue,
        }
    }
}
