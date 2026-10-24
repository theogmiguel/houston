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
            // A client moves its layouts on workspace_relocated, before any pane leaves.
            proto::ServerMsg::SessionReparented { session, .. } => {
                panic!("session_reparented for {session} arrived before workspace_relocated")
            }
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

async fn wait_exited(ws: &mut WsStream, session: u32) {
    loop {
        match next_control(ws).await {
            proto::ServerMsg::SessionState {
                session: s, state, ..
            } if s == session && !state.is_live() => return,
            proto::ServerMsg::Error { message, .. } => panic!("daemon error: {message}"),
            _ => continue,
        }
    }
}

#[tokio::test]
async fn an_exited_pane_in_a_subfolder_respawns_there_after_relocation() {
    let (addr, _state) = start_daemon().await;
    let tmp = houston_core::fixture_dirs::tempdir_outside_git();
    let original = tmp.path().join("proj");
    init_repo(&original);
    std::fs::create_dir(original.join("sub")).unwrap();
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
            proto::ServerMsg::WorkspaceList { workspaces } if !workspaces.is_empty() => break,
            proto::ServerMsg::Error { message, .. } => panic!("daemon error: {message}"),
            _ => continue,
        }
    }
    ws.send(Message::text(create_custom_msg(
        vec!["git", "--version"],
        &original.join("sub"),
    )))
    .await
    .unwrap();
    let source = expect_created(&mut ws).await.id;
    wait_exited(&mut ws, source).await;
    // A pane rooted in the workspace whose cwd is a folder inside it, like a worktree pane.
    send(
        &mut ws,
        &proto::ClientMsg::SessionCreate {
            request: None,
            agent: proto::AgentKind::Custom,
            project_dir: from.clone(),
            cmd: Some(vec!["git".into(), "--version".into()]),
            cols: Some(80),
            rows: Some(24),
            cwd_from: Some(source),
            shell_integration: None,
            auto_approve: None,
            acp: None,
            profile: None,
            prompt: None,
            model: None,
            effort: None,
        },
    )
    .await;
    let pane = expect_created(&mut ws).await;
    assert_eq!(Path::new(&pane.cwd), original.join("sub"));
    wait_exited(&mut ws, pane.id).await;

    let moved_dir = tmp.path().join("proj-moved");
    std::fs::rename(&original, &moved_dir).unwrap();
    let moved = relocate(&mut ws, &from, &moved_dir.display().to_string())
        .await
        .unwrap();
    assert_eq!(moved.sessions, 2, "{moved:?}");

    send(&mut ws, &proto::ClientMsg::SessionList).await;
    loop {
        match next_control(&mut ws).await {
            proto::ServerMsg::SessionList { sessions, .. } => {
                let listed = sessions.iter().find(|s| s.id == pane.id).unwrap();
                assert_eq!(Path::new(&listed.cwd), moved_dir.join("sub"));
                break;
            }
            _ => continue,
        }
    }
    send(
        &mut ws,
        &proto::ClientMsg::SessionRespawn {
            session: pane.id,
            shell_integration: None,
            cwd: None,
            shell: None,
            force: None,
            fresh: None,
        },
    )
    .await;
    let respawned = expect_created(&mut ws).await;
    assert_eq!(respawned.project_dir, moved_dir.display().to_string());
    assert_eq!(
        Path::new(&respawned.cwd),
        moved_dir.join("sub"),
        "the respawned pane keeps its folder inside the moved workspace"
    );
}
