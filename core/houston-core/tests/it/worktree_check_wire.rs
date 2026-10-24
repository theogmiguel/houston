#![allow(clippy::disallowed_methods)]

use crate::common;

use common::*;
use futures_util::SinkExt;
use houston_core::daemon::{CreateParams, Daemon};
use houston_protocol as proto;
use std::path::Path;
use std::process::Command;
use std::sync::Arc;
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
    git(dir, &["config", "core.autocrlf", "false"]);
    git(dir, &["config", "user.email", "t@t.local"]);
    git(dir, &["config", "user.name", "t"]);
    std::fs::write(dir.join("README.md"), "hello\n").unwrap();
    git(dir, &["add", "-A"]);
    git(dir, &["commit", "-m", "init"]);
}

fn long_running_session(daemon: &Arc<Daemon>, dir: &Path) -> proto::SessionInfo {
    #[cfg(unix)]
    let cmd = vec!["sleep".into(), "60".into()];
    #[cfg(windows)]
    let cmd = vec!["ping".into(), "-n".into(), "61".into(), "127.0.0.1".into()];
    daemon
        .create_session(CreateParams {
            agent: proto::AgentKind::Custom,
            project_dir: dir.to_path_buf(),
            cmd: Some(cmd),
            cols: 80,
            rows: 24,
            cwd_from: None,
            shell_integration: false,
            auto_approve: false,
            acp: None,
            profile: None,
            prompt: None,
            model: None,
            effort: None,
        })
        .unwrap()
}

async fn send(ws: &mut WsStream, msg: &proto::ClientMsg) {
    ws.send(Message::text(serde_json::to_string(msg).unwrap()))
        .await
        .unwrap();
}

async fn worktree_path(ws: &mut WsStream, dir: &str, branch: &str) -> String {
    loop {
        match next_control(ws).await {
            proto::ServerMsg::GitWorktrees {
                message: Some(_), ..
            } => break,
            proto::ServerMsg::Error { message, .. } => panic!("daemon error: {message}"),
            _ => continue,
        }
    }
    send(
        ws,
        &proto::ClientMsg::GitWorktrees {
            dir: dir.to_string(),
        },
    )
    .await;
    loop {
        match next_control(ws).await {
            proto::ServerMsg::GitWorktrees { worktrees, .. } if !worktrees.is_empty() => {
                return worktrees
                    .into_iter()
                    .find(|w| w.branch.as_deref() == Some(branch))
                    .expect("the new worktree is listed")
                    .path;
            }
            proto::ServerMsg::Error { message, .. } => panic!("daemon error: {message}"),
            _ => continue,
        }
    }
}

async fn check(ws: &mut WsStream, dir: &str, path: &str) -> proto::WorktreeCheckResult {
    send(
        ws,
        &proto::ClientMsg::WorktreeCheck {
            dir: dir.to_string(),
            path: path.to_string(),
        },
    )
    .await;
    loop {
        match next_control(ws).await {
            proto::ServerMsg::WorktreeCheck {
                dir: d,
                path: p,
                check,
            } => {
                assert_eq!((d.as_str(), p.as_str()), (dir, path));
                return check;
            }
            proto::ServerMsg::Error { message, .. } => panic!("daemon error: {message}"),
            _ => continue,
        }
    }
}

fn gap(check: &proto::WorktreeCheckResult, part: proto::WorktreeCheckPart) -> Option<&str> {
    check
        .gaps
        .iter()
        .find(|g| g.part == part)
        .map(|g| g.reason.as_str())
}

#[tokio::test]
async fn a_worktree_check_names_changes_commits_and_panes_before_removal() {
    let (addr, _state, daemon) = start_daemon_with_handle().await;
    let repo = tempfile::tempdir().unwrap();
    init_repo(repo.path());
    let dir = repo.path().display().to_string();
    let mut ws = connect_and_hello(addr, TOKEN).await;
    let _ = next_control(&mut ws).await;

    send(
        &mut ws,
        &proto::ClientMsg::GitWorktreeCreate {
            dir: dir.clone(),
            name: "review".to_string(),
            base: None,
        },
    )
    .await;
    let path = worktree_path(&mut ws, &dir, "houston/review").await;
    let tree = Path::new(&path);

    let clean = check(&mut ws, &dir, &path).await;
    assert_eq!(clean.dirty_files, Some(0));
    assert_eq!(clean.newest_change_ms, None);
    assert_eq!(clean.base.as_deref(), Some("main"));
    assert_eq!(clean.ahead, Some(0));
    assert!(clean.panes.is_empty());
    assert_eq!(
        gap(&clean, proto::WorktreeCheckPart::Unpushed),
        Some("the repository has no remote"),
        "{:?}",
        clean.gaps
    );

    std::fs::write(tree.join("feature.txt"), "one\n").unwrap();
    git(tree, &["add", "feature.txt"]);
    git(tree, &["commit", "-m", "feature"]);
    let remote = tempfile::tempdir().unwrap();
    git(remote.path(), &["init", "--bare", "-b", "main"]);
    git(
        repo.path(),
        &[
            "remote",
            "add",
            "origin",
            &remote.path().display().to_string(),
        ],
    );
    git(repo.path(), &["push", "-q", "origin", "main"]);
    let before_write = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64;
    std::fs::write(tree.join("scratch.txt"), "x\n").unwrap();
    std::fs::write(tree.join("README.md"), "changed\n").unwrap();
    let pane = long_running_session(&daemon, tree);

    let busy = check(&mut ws, &dir, &path).await;
    assert_eq!(busy.dirty_files, Some(2));
    let newest = busy.newest_change_ms.expect("a written file has a date");
    assert!(newest >= before_write - 2_000, "{newest} < {before_write}");
    assert_eq!(busy.ahead, Some(1));
    assert_eq!(busy.unpushed, Some(1));
    assert!(busy.gaps.is_empty(), "{:?}", busy.gaps);
    let panes: Vec<u32> = busy.panes.iter().map(|p| p.session).collect();
    assert_eq!(panes, vec![pane.id]);
    assert!(!busy.panes[0].title.is_empty());
    daemon.kill(pane.id).ok();
}

#[tokio::test]
async fn a_check_that_cannot_look_names_why_for_every_part() {
    let (addr, _state, _daemon) = start_daemon_with_handle().await;
    let repo = tempfile::tempdir().unwrap();
    init_repo(repo.path());
    let dir = repo.path().display().to_string();
    let missing = repo.path().join("gone").display().to_string();
    let mut ws = connect_and_hello(addr, TOKEN).await;
    let _ = next_control(&mut ws).await;

    let result = check(&mut ws, &dir, &missing).await;
    assert_eq!(result.dirty_files, None);
    assert_eq!(result.ahead, None);
    assert_eq!(result.unpushed, None);
    for part in [
        proto::WorktreeCheckPart::Changes,
        proto::WorktreeCheckPart::Commits,
        proto::WorktreeCheckPart::Unpushed,
    ] {
        let reason = gap(&result, part).unwrap_or_else(|| panic!("no gap for {part:?}"));
        assert!(reason.contains("does not exist"), "{reason}");
    }
}
