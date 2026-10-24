#![allow(clippy::disallowed_methods)]

use crate::common;

use common::*;
use futures_util::SinkExt;
use houston_protocol as proto;
use std::path::Path;
use std::process::Command;
use tokio_tungstenite::tungstenite::Message;

fn git(dir: &Path, args: &[&str]) -> String {
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
    std::fs::create_dir_all(dir).unwrap();
    git(dir, &["init", "-b", "main"]);
    git(dir, &["config", "user.email", "t@t.local"]);
    git(dir, &["config", "user.name", "t"]);
    std::fs::write(dir.join("README.md"), "hello\n").unwrap();
    git(dir, &["add", "README.md"]);
    git(dir, &["commit", "-m", "init"]);
}

async fn send(ws: &mut WsStream, msg: &proto::ClientMsg) {
    ws.send(Message::text(serde_json::to_string(msg).unwrap()))
        .await
        .unwrap();
}

async fn relocate(
    ws: &mut WsStream,
    from: &str,
    to: &str,
) -> Result<proto::WorkspaceRelocateMoved, String> {
    send(
        ws,
        &proto::ClientMsg::WorkspaceRelocate {
            from: from.to_owned(),
            to: to.to_owned(),
        },
    )
    .await;
    loop {
        match next_control(ws).await {
            proto::ServerMsg::WorkspaceRelocated { moved, .. } => return Ok(moved),
            proto::ServerMsg::Error { message, .. } => return Err(message),
            _ => continue,
        }
    }
}

#[tokio::test]
async fn a_moved_workspace_is_relocated_with_its_worktrees_only_to_the_same_repository() {
    let (addr, state) = start_daemon().await;
    let tmp = houston_core::fixture_dirs::tempdir_outside_git();
    let original = tmp.path().join("proj");
    init_repo(&original);
    let other = tmp.path().join("other");
    init_repo(&other);
    let from = original.display().to_string();

    let mut ws = connect_and_hello(addr, TOKEN).await;
    let _ = next_control(&mut ws).await;
    send(
        &mut ws,
        &proto::ClientMsg::WorkspaceAdd { path: from.clone() },
    )
    .await;
    loop {
        match next_control(&mut ws).await {
            proto::ServerMsg::WorkspaceList { workspaces } if !workspaces.is_empty() => {
                assert_eq!(workspaces[0].missing, None);
                break;
            }
            proto::ServerMsg::Error { message, .. } => panic!("daemon error: {message}"),
            _ => continue,
        }
    }
    send(
        &mut ws,
        &proto::ClientMsg::GitWorktreeCreate {
            dir: from.clone(),
            name: "review".into(),
            base: None,
        },
    )
    .await;
    loop {
        match next_control(&mut ws).await {
            proto::ServerMsg::GitWorktrees {
                message: Some(_), ..
            } => break,
            proto::ServerMsg::Error { message, .. } => panic!("daemon error: {message}"),
            _ => continue,
        }
    }
    let db = rusqlite::Connection::open(state.path().join("test.db")).unwrap();
    let worktree: String = db
        .query_row("SELECT path FROM managed_worktrees", [], |r| r.get(0))
        .unwrap();

    let err = relocate(&mut ws, &from, &other.display().to_string())
        .await
        .unwrap_err();
    assert!(err.contains("still exists"), "{err}");

    let moved_dir = tmp.path().join("proj-moved");
    std::fs::rename(&original, &moved_dir).unwrap();
    let to = moved_dir.display().to_string();
    send(&mut ws, &proto::ClientMsg::WorkspaceList).await;
    loop {
        match next_control(&mut ws).await {
            proto::ServerMsg::WorkspaceList { workspaces } => {
                assert_eq!(workspaces[0].missing, Some(true), "{workspaces:?}");
                break;
            }
            _ => continue,
        }
    }

    let err = relocate(&mut ws, &from, &other.display().to_string())
        .await
        .unwrap_err();
    assert!(err.contains("is not the repository"), "{err}");
    let common: String = db
        .query_row("SELECT repo_common_dir FROM managed_worktrees", [], |r| {
            r.get(0)
        })
        .unwrap();
    assert!(
        Path::new(&common).starts_with(&original),
        "a refused relocation leaves the row alone: {common}"
    );

    let moved = relocate(&mut ws, &from, &to).await.unwrap();
    assert_eq!(moved.worktrees, 1, "{moved:?}");
    assert_eq!(moved.repaired, 1, "{moved:?}");
    loop {
        match next_control(&mut ws).await {
            proto::ServerMsg::WorkspaceList { workspaces } => {
                assert_eq!(workspaces.len(), 1);
                assert_eq!(workspaces[0].path, to);
                assert_eq!(workspaces[0].name, "proj-moved");
                assert_eq!(workspaces[0].missing, None);
                break;
            }
            _ => continue,
        }
    }
    let common: String = db
        .query_row("SELECT repo_common_dir FROM managed_worktrees", [], |r| {
            r.get(0)
        })
        .unwrap();
    assert!(
        Path::new(&common).starts_with(moved_dir.canonicalize().unwrap())
            || Path::new(&common).starts_with(&moved_dir),
        "{common}"
    );
    // git itself follows: the worktree resolves to the moved repository again.
    let resolved = git(
        Path::new(&worktree),
        &["rev-parse", "--path-format=absolute", "--git-common-dir"],
    );
    assert_eq!(
        Path::new(resolved.trim()).canonicalize().unwrap(),
        moved_dir.join(".git").canonicalize().unwrap()
    );
}
