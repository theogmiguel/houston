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

struct StatusReply {
    dir: String,
    files: Vec<proto::GitFileStatus>,
    upstream: Option<String>,
    ahead: u32,
}

async fn expect_git_status(ws: &mut WsStream) -> StatusReply {
    loop {
        match next_control(ws).await {
            proto::ServerMsg::GitStatus {
                dir,
                files,
                upstream,
                ahead,
                ..
            } => {
                return StatusReply {
                    dir,
                    files,
                    upstream,
                    ahead,
                }
            }
            proto::ServerMsg::Error { message, .. } => panic!("daemon error: {message}"),
            _ => continue,
        }
    }
}

async fn expect_git_commit(ws: &mut WsStream) -> (String, String) {
    loop {
        match next_control(ws).await {
            proto::ServerMsg::GitCommit { sha, summary, .. } => return (sha, summary),
            proto::ServerMsg::Error { message, .. } => panic!("daemon error: {message}"),
            _ => continue,
        }
    }
}

async fn expect_git_diff(ws: &mut WsStream) -> (Option<String>, String, bool) {
    loop {
        match next_control(ws).await {
            proto::ServerMsg::GitDiff {
                path,
                patch,
                truncated,
                ..
            } => return (path, patch, truncated),
            proto::ServerMsg::Error { message, .. } => panic!("daemon error: {message}"),
            _ => continue,
        }
    }
}

async fn expect_git_branch(ws: &mut WsStream) -> (String, Option<String>) {
    loop {
        match next_control(ws).await {
            proto::ServerMsg::GitBranch { dir, branch } => return (dir, branch),
            proto::ServerMsg::Error { message, .. } => panic!("daemon error: {message}"),
            _ => continue,
        }
    }
}

#[tokio::test]
async fn git_branch_over_the_wire() {
    let (addr, _state) = start_daemon().await;
    let repo = tempfile::tempdir().unwrap();
    init_repo(repo.path());

    let mut ws = connect_and_hello(addr, TOKEN).await;
    let _ = next_control(&mut ws).await;

    let dir = repo.path().display().to_string();
    let msg = serde_json::to_string(&proto::ClientMsg::GitBranch { dir: dir.clone() }).unwrap();
    ws.send(Message::text(msg)).await.unwrap();
    let (rdir, branch) = expect_git_branch(&mut ws).await;
    assert_eq!(rdir, dir);
    assert_eq!(branch.as_deref(), Some("main"));
}

#[tokio::test]
async fn git_branch_is_none_for_non_repo_and_does_not_error() {
    let (addr, _state) = start_daemon().await;
    let plain = tempfile::tempdir().unwrap();

    let mut ws = connect_and_hello(addr, TOKEN).await;
    let _ = next_control(&mut ws).await;

    let dir = plain.path().display().to_string();
    let msg = serde_json::to_string(&proto::ClientMsg::GitBranch { dir: dir.clone() }).unwrap();
    ws.send(Message::text(msg)).await.unwrap();
    let (rdir, branch) = expect_git_branch(&mut ws).await;
    assert_eq!(rdir, dir);
    assert_eq!(branch, None);
}

#[tokio::test]
async fn git_status_and_diff_over_the_wire() {
    let (addr, _state) = start_daemon().await;
    let repo = tempfile::tempdir().unwrap();
    init_repo(repo.path());
    std::fs::write(repo.path().join("README.md"), "hello\nworld\n").unwrap();
    std::fs::write(repo.path().join("new.txt"), "brand new\n").unwrap();

    let mut ws = connect_and_hello(addr, TOKEN).await;
    let _ = next_control(&mut ws).await;

    let dir = repo.path().display().to_string();
    let status = serde_json::to_string(&proto::ClientMsg::GitStatus {
        dir: dir.clone(),
        base: None,
    })
    .unwrap();
    ws.send(Message::text(status)).await.unwrap();
    let st = expect_git_status(&mut ws).await;
    assert_eq!(st.dir, dir);
    let readme = st.files.iter().find(|f| f.path == "README.md").unwrap();
    assert_eq!(readme.status, proto::GitFileState::Modified);
    assert_eq!(readme.added, Some(1));
    let new = st.files.iter().find(|f| f.path == "new.txt").unwrap();
    assert_eq!(new.status, proto::GitFileState::Untracked);

    let full = serde_json::to_string(&proto::ClientMsg::GitDiff {
        dir: dir.clone(),
        path: None,
        base: None,
    })
    .unwrap();
    ws.send(Message::text(full)).await.unwrap();
    let (path, patch, truncated) = expect_git_diff(&mut ws).await;
    assert_eq!(path, None);
    assert!(!truncated);
    assert!(patch.contains("+world"));
    assert!(patch.contains("+brand new"));

    let single = serde_json::to_string(&proto::ClientMsg::GitDiff {
        dir: dir.clone(),
        path: Some("new.txt".into()),
        base: None,
    })
    .unwrap();
    ws.send(Message::text(single)).await.unwrap();
    let (path, patch, _) = expect_git_diff(&mut ws).await;
    assert_eq!(path.as_deref(), Some("new.txt"));
    assert!(patch.contains("+brand new"));
    assert!(!patch.contains("+world"));
}

#[tokio::test]
async fn oversized_diff_sets_the_truncation_flag() {
    let (addr, _state) = start_daemon().await;
    let repo = tempfile::tempdir().unwrap();
    init_repo(repo.path());
    std::fs::write(
        repo.path().join("big.txt"),
        "filler line for a very large diff\n".repeat(20_000),
    )
    .unwrap();

    let mut ws = connect_and_hello(addr, TOKEN).await;
    let _ = next_control(&mut ws).await;

    let msg = serde_json::to_string(&proto::ClientMsg::GitDiff {
        dir: repo.path().display().to_string(),
        path: None,
        base: None,
    })
    .unwrap();
    ws.send(Message::text(msg)).await.unwrap();
    let (_, patch, truncated) = expect_git_diff(&mut ws).await;
    assert!(truncated);
    assert!(patch.len() <= 512 * 1024);
}

#[tokio::test]
async fn non_git_dir_returns_error_envelope() {
    let (addr, _state) = start_daemon().await;
    let plain = tempfile::tempdir().unwrap();

    let mut ws = connect_and_hello(addr, TOKEN).await;
    let _ = next_control(&mut ws).await;

    let msg = serde_json::to_string(&proto::ClientMsg::GitStatus {
        dir: plain.path().display().to_string(),
        base: None,
    })
    .unwrap();
    ws.send(Message::text(msg)).await.unwrap();
    loop {
        match next_control(&mut ws).await {
            proto::ServerMsg::Error { message, .. } => {
                assert!(
                    message.contains("not a git repository"),
                    "unexpected error: {message}"
                );
                break;
            }
            proto::ServerMsg::GitStatus { .. } => panic!("expected an error envelope"),
            _ => continue,
        }
    }
}

#[tokio::test]
async fn git_stage_and_commit_over_the_wire() {
    let (addr, _state) = start_daemon().await;
    let repo = tempfile::tempdir().unwrap();
    init_repo(repo.path());
    std::fs::write(repo.path().join("feature.txt"), "work\n").unwrap();

    let mut ws = connect_and_hello(addr, TOKEN).await;
    let _ = next_control(&mut ws).await;
    let dir = repo.path().display().to_string();

    send(
        &mut ws,
        &proto::ClientMsg::GitStatus {
            dir: dir.clone(),
            base: None,
        },
    )
    .await;
    let st = expect_git_status(&mut ws).await;
    let f = st.files.iter().find(|f| f.path == "feature.txt").unwrap();
    assert!(!f.staged);
    assert_eq!(f.status, proto::GitFileState::Untracked);

    send(
        &mut ws,
        &proto::ClientMsg::GitStage {
            dir: dir.clone(),
            paths: vec!["feature.txt".into()],
        },
    )
    .await;
    let st = expect_git_status(&mut ws).await;
    let f = st.files.iter().find(|f| f.path == "feature.txt").unwrap();
    assert!(f.staged, "expected feature.txt staged");
    assert_eq!(f.status, proto::GitFileState::Added);

    send(
        &mut ws,
        &proto::ClientMsg::GitCommit {
            dir: dir.clone(),
            message: "add feature".into(),
        },
    )
    .await;
    let (sha, _summary) = expect_git_commit(&mut ws).await;
    assert!(sha.len() >= 7, "short sha: {sha}");
    let st = expect_git_status(&mut ws).await;
    assert!(st.files.is_empty(), "tree should be clean after commit");
}

#[tokio::test]
async fn git_push_to_bare_remote_clears_ahead() {
    let (addr, _state) = start_daemon().await;
    let remote = tempfile::tempdir().unwrap();
    git(remote.path(), &["init", "--bare", "-b", "main"]);
    let repo = tempfile::tempdir().unwrap();
    init_repo(repo.path());
    git(
        repo.path(),
        &[
            "remote",
            "add",
            "origin",
            &remote.path().display().to_string(),
        ],
    );
    git(repo.path(), &["push", "-u", "origin", "main"]);
    std::fs::write(repo.path().join("second.txt"), "more\n").unwrap();
    git(repo.path(), &["add", "-A"]);
    git(repo.path(), &["commit", "-m", "second"]);

    let mut ws = connect_and_hello(addr, TOKEN).await;
    let _ = next_control(&mut ws).await;
    let dir = repo.path().display().to_string();

    send(
        &mut ws,
        &proto::ClientMsg::GitStatus {
            dir: dir.clone(),
            base: None,
        },
    )
    .await;
    let st = expect_git_status(&mut ws).await;
    assert_eq!(st.upstream.as_deref(), Some("origin/main"));
    assert_eq!(st.ahead, 1);

    send(&mut ws, &proto::ClientMsg::GitPush { dir: dir.clone() }).await;
    let st = expect_git_status(&mut ws).await;
    assert_eq!(st.ahead, 0, "push should clear the ahead count");
}
