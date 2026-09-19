mod common;

use base64::Engine;
use common::*;
use futures_util::SinkExt;
use houston_core::daemon::{CreateParams, Daemon, DaemonConfig};
use houston_protocol as proto;
use std::time::Duration;
use tokio_tungstenite::tungstenite::Message;

fn create_custom_session(
    daemon: &std::sync::Arc<Daemon>,
    dir: &std::path::Path,
    cmd: Vec<&str>,
) -> proto::SessionInfo {
    daemon
        .create_session(CreateParams {
            agent: proto::AgentKind::Custom,
            project_dir: dir.to_path_buf(),
            cmd: Some(cmd.into_iter().map(String::from).collect()),
            cols: 80,
            rows: 24,
            cwd_from: None,
            shell_integration: false,
            auto_approve: false,
            acp: None,
            profile: None,
            prompt: None,
        })
        .unwrap()
}

#[tokio::test]
async fn scrollback_replays_to_a_second_client() {
    let (addr, _state) = start_daemon().await;
    let tmp = tempfile::tempdir().unwrap();

    let mut ws1 = connect_and_hello(addr, TOKEN).await;
    let _ = next_control(&mut ws1).await;
    ws1.send(Message::text(create_custom_msg(vec!["cat"], tmp.path())))
        .await
        .unwrap();
    let id = expect_created(&mut ws1).await.id;

    let frame = proto::encode_stdin_frame(id, b"hello-replay\n");
    ws1.send(Message::Binary(frame.into())).await.unwrap();
    collect_output_until(&mut ws1, id, "hello-replay").await;

    let mut ws2 = connect_and_hello(addr, TOKEN).await;
    match next_control(&mut ws2).await {
        proto::ServerMsg::HelloOk { sessions, .. } => {
            assert!(sessions.iter().any(|s| s.id == id), "session in hello_ok");
        }
        other => panic!("expected hello_ok, got {other:?}"),
    }
    let attach = serde_json::to_string(&proto::ClientMsg::SessionAttach {
        session: id,
        replay_bytes: None,
        snapshot: None,
    })
    .unwrap();
    ws2.send(Message::text(attach)).await.unwrap();

    loop {
        match next_control(&mut ws2).await {
            proto::ServerMsg::Scrollback {
                session,
                data,
                generation,
                replayed_bytes,
                bytes_seen,
                attempt,
            } => {
                assert_eq!(session, id);
                assert_eq!(attempt, 1, "first attach on this socket");
                let bytes = base64::engine::general_purpose::STANDARD
                    .decode(data)
                    .unwrap();
                let text = String::from_utf8_lossy(&bytes);
                assert!(
                    text.contains("hello-replay"),
                    "scrollback missing history: {text:?}"
                );
                assert_eq!(generation, 1);
                assert_eq!(replayed_bytes, bytes.len() as u64, "untrimmed: no prefix");
                assert_eq!(bytes_seen, replayed_bytes, "full replay covers the stream");
                break;
            }
            proto::ServerMsg::Error { message, .. } => panic!("daemon error: {message}"),
            _ => continue,
        }
    }
}

#[tokio::test]
async fn pty_exports_houston_session_marker() {
    let state_dir = tempfile::tempdir().unwrap();
    let daemon = Daemon::new(DaemonConfig {
        token: TOKEN.to_string(),
        db_path: state_dir.path().join("test.db"),
    })
    .unwrap();
    let tmp = tempfile::tempdir().unwrap();

    let mut rx = daemon.observe();
    #[cfg(unix)]
    let mark_argv: Vec<&str> = vec!["sh", "-c", "echo MARK=$HOUSTON_SESSION"];
    #[cfg(windows)]
    let mark_argv: Vec<&str> = vec!["cmd", "/C", "echo MARK=%HOUSTON_SESSION%"];
    let id = create_custom_session(&daemon, tmp.path(), mark_argv).id;

    collect_broadcast_until(&mut rx, id, &format!("MARK={id}")).await;
}

#[tokio::test]
async fn agent_banner_sets_detected_identity() {
    let state_dir = tempfile::tempdir().unwrap();
    let daemon = Daemon::new(DaemonConfig {
        token: TOKEN.to_string(),
        db_path: state_dir.path().join("test.db"),
    })
    .unwrap();
    let tmp = tempfile::tempdir().unwrap();

    let mut rx = daemon.observe();
    #[cfg(unix)]
    let banner_argv: Vec<&str> = vec![
        "sh",
        "-c",
        "printf '\\033[38;5;208m\\342\\234\\273 Welcome to \\033[1mClaude Code\\033[0m!\\n' && sleep 5",
    ];
    #[cfg(windows)]
    let banner_argv: Vec<&str> = vec![
        "powershell",
        "-NoProfile",
        "-Command",
        "$e=[char]27; [Console]::Out.Write(\"$e[38;5;208m\u{273B} Welcome to $e[1mClaude Code$e[0m!`n\"); Start-Sleep 5",
    ];
    let id = create_custom_session(&daemon, tmp.path(), banner_argv).id;

    loop {
        match next_broadcast_control(&mut rx).await {
            proto::ServerMsg::AgentDetected { session, agent } => {
                assert_eq!(session, id);
                assert_eq!(agent, proto::AgentKind::Claude);
                break;
            }
            proto::ServerMsg::Error { message, .. } => panic!("daemon error: {message}"),
            _ => continue,
        }
    }

    let s = daemon
        .list()
        .into_iter()
        .find(|s| s.id == id)
        .expect("session listed");
    assert_eq!(s.detected_agent, Some(proto::AgentKind::Claude));
}

#[cfg(unix)]
#[tokio::test]
async fn create_with_cwd_from_inherits_live_directory() {
    let state_dir = tempfile::tempdir().unwrap();
    let daemon = Daemon::new(DaemonConfig {
        token: TOKEN.to_string(),
        db_path: state_dir.path().join("test.db"),
    })
    .unwrap();
    let tmp = tempfile::tempdir().unwrap();
    std::fs::create_dir(tmp.path().join("subdir")).unwrap();

    let mut rx = daemon.observe();
    let anchor = create_custom_session(
        &daemon,
        tmp.path(),
        vec!["sh", "-c", "cd subdir && echo READY && sleep 30"],
    )
    .id;
    collect_broadcast_until(&mut rx, anchor, "READY").await;

    let mut rx2 = daemon.observe();
    let split = daemon
        .create_session(CreateParams {
            agent: proto::AgentKind::Custom,
            project_dir: tmp.path().to_path_buf(),
            cmd: Some(vec!["pwd".into()]),
            cols: 80,
            rows: 24,
            cwd_from: Some(anchor),
            shell_integration: false,
            auto_approve: false,
            acp: None,
            profile: None,
            prompt: None,
        })
        .unwrap();
    assert!(
        split.cwd.ends_with("subdir"),
        "split session cwd should be the anchor's live dir, got {}",
        split.cwd
    );
    collect_broadcast_until(&mut rx2, split.id, "subdir").await;
}

#[tokio::test]
async fn workspace_registry_roundtrip() {
    let (addr, _state) = start_daemon().await;
    let tmp = tempfile::tempdir().unwrap();

    let mut ws = connect_and_hello(addr, TOKEN).await;
    match next_control(&mut ws).await {
        proto::ServerMsg::HelloOk { workspaces, .. } => assert!(workspaces.is_empty()),
        other => panic!("expected hello_ok, got {other:?}"),
    }

    let add = serde_json::to_string(&proto::ClientMsg::WorkspaceAdd {
        path: tmp.path().display().to_string(),
    })
    .unwrap();
    ws.send(Message::text(add)).await.unwrap();
    loop {
        match next_control(&mut ws).await {
            proto::ServerMsg::WorkspaceList { workspaces } => {
                assert_eq!(workspaces.len(), 1);
                assert_eq!(workspaces[0].path, tmp.path().display().to_string());
                break;
            }
            proto::ServerMsg::Error { message, .. } => panic!("daemon error: {message}"),
            _ => continue,
        }
    }

    let mut ws2 = connect_and_hello(addr, TOKEN).await;
    match next_control(&mut ws2).await {
        proto::ServerMsg::HelloOk { workspaces, .. } => assert_eq!(workspaces.len(), 1),
        other => panic!("expected hello_ok, got {other:?}"),
    }
}

#[tokio::test]
async fn workspace_rename_broadcasts_new_name() {
    let (addr, _state) = start_daemon().await;
    let tmp = tempfile::tempdir().unwrap();
    let path = tmp.path().display().to_string();

    let mut ws = connect_and_hello(addr, TOKEN).await;
    let _ = next_control(&mut ws).await;
    let add =
        serde_json::to_string(&proto::ClientMsg::WorkspaceAdd { path: path.clone() }).unwrap();
    ws.send(Message::text(add)).await.unwrap();
    loop {
        match next_control(&mut ws).await {
            proto::ServerMsg::WorkspaceList { .. } => break,
            proto::ServerMsg::Error { message, .. } => panic!("daemon error: {message}"),
            _ => continue,
        }
    }

    let rename = serde_json::to_string(&proto::ClientMsg::WorkspaceRename {
        path: path.clone(),
        name: "renamed".into(),
    })
    .unwrap();
    ws.send(Message::text(rename)).await.unwrap();
    loop {
        match next_control(&mut ws).await {
            proto::ServerMsg::WorkspaceList { workspaces } => {
                assert_eq!(workspaces.len(), 1);
                assert_eq!(workspaces[0].name, "renamed");
                break;
            }
            proto::ServerMsg::Error { message, .. } => panic!("daemon error: {message}"),
            _ => continue,
        }
    }

    let bad = serde_json::to_string(&proto::ClientMsg::WorkspaceRename {
        path: "/nope".into(),
        name: "x".into(),
    })
    .unwrap();
    ws.send(Message::text(bad)).await.unwrap();
    loop {
        match next_control(&mut ws).await {
            proto::ServerMsg::Error { message, .. } => {
                assert!(
                    message.contains("/nope"),
                    "error must name the path: {message}"
                );
                break;
            }
            proto::ServerMsg::WorkspaceList { .. } => panic!("unknown workspace must not succeed"),
            _ => continue,
        }
    }
}

#[tokio::test]
async fn workspace_remove_kills_sessions_and_deletes_workspace() {
    let (addr, _state) = start_daemon().await;
    let tmp = tempfile::tempdir().unwrap();

    let mut ws = connect_and_hello(addr, TOKEN).await;
    let _ = next_control(&mut ws).await;

    let add = serde_json::to_string(&proto::ClientMsg::WorkspaceAdd {
        path: tmp.path().display().to_string(),
    })
    .unwrap();
    ws.send(Message::text(add)).await.unwrap();
    loop {
        match next_control(&mut ws).await {
            proto::ServerMsg::WorkspaceList { workspaces } => {
                assert_eq!(workspaces.len(), 1);
                break;
            }
            proto::ServerMsg::Error { message, .. } => panic!("daemon error: {message}"),
            _ => continue,
        }
    }

    ws.send(Message::text(create_custom_msg(vec!["cat"], tmp.path())))
        .await
        .unwrap();
    let id = expect_created(&mut ws).await.id;

    let remove = serde_json::to_string(&proto::ClientMsg::WorkspaceRemove {
        path: tmp.path().display().to_string(),
    })
    .unwrap();
    ws.send(Message::text(remove)).await.unwrap();

    let mut session_removed = false;
    let mut workspaces_after = None;
    while workspaces_after.is_none() {
        match next_control(&mut ws).await {
            proto::ServerMsg::SessionRemoved { session } if session == id => {
                session_removed = true;
            }
            proto::ServerMsg::WorkspaceList { workspaces } => workspaces_after = Some(workspaces),
            proto::ServerMsg::Error { message, .. } => panic!("daemon error: {message}"),
            _ => continue,
        }
    }
    assert!(session_removed, "session must be removed from the roster");
    assert!(workspaces_after.unwrap().is_empty());

    let remove_again = serde_json::to_string(&proto::ClientMsg::WorkspaceRemove {
        path: tmp.path().display().to_string(),
    })
    .unwrap();
    ws.send(Message::text(remove_again)).await.unwrap();
    loop {
        match next_control(&mut ws).await {
            proto::ServerMsg::Error { message, .. } => {
                assert!(
                    message.contains(&tmp.path().display().to_string()),
                    "error should name the path: {message}"
                );
                break;
            }
            proto::ServerMsg::WorkspaceList { .. } => panic!("unknown workspace must not succeed"),
            _ => continue,
        }
    }
}

#[tokio::test]
async fn interrupted_sessions_are_restored_and_respawnable() {
    use houston_core::db::Db;

    let state_dir = tempfile::tempdir().unwrap();
    let db_path = state_dir.path().join("test.db");
    let tmp = tempfile::tempdir().unwrap();

    {
        let db = Db::open(&db_path).unwrap();
        db.insert_session(&houston_protocol::SessionInfo {
            id: 1,
            agent: proto::AgentKind::Shell,
            project_dir: tmp.path().display().to_string(),
            cwd: tmp.path().display().to_string(),
            state: proto::SessionState::Running,
            title: "Kai".into(),
            codename: "Kai".into(),
            detected_agent: None,
            hidden: false,
            ssh_host: None,
            restore_deferred: None,
            status: None,
            swarm_agent: None,
            acp: None,
            spawned_by: None,
            live_children: 0,
            profile_label: None,
            children_waiting: 0,
            delegation: None,
            inbox_unread: 0,
            tags: vec![],
        })
        .unwrap();
    }

    let daemon = Daemon::new(DaemonConfig {
        token: TOKEN.to_string(),
        db_path,
    })
    .unwrap();

    let sessions = daemon.list();
    assert_eq!(sessions.len(), 1);
    assert_eq!(sessions[0].id, 1);
    assert_eq!(sessions[0].state, proto::SessionState::Interrupted);

    let replay = daemon.scrollback(1, None).unwrap();
    assert!(replay.data.is_empty());

    let fresh = daemon.respawn(1, true, None, None, false).unwrap();
    assert_ne!(fresh.id, 1);
    assert_eq!(fresh.cwd, tmp.path().display().to_string());
    assert_eq!(fresh.state, proto::SessionState::Running);
}

#[tokio::test]
async fn codenames_are_assigned_renamed_and_persisted() {
    use houston_core::db::Db;

    let state_dir = tempfile::tempdir().unwrap();
    let db_path = state_dir.path().join("test.db");
    let tmp = tempfile::tempdir().unwrap();

    let daemon = Daemon::new(DaemonConfig {
        token: TOKEN.to_string(),
        db_path: db_path.clone(),
    })
    .unwrap();

    let created = daemon
        .create_session(CreateParams {
            agent: proto::AgentKind::Shell,
            project_dir: tmp.path().to_path_buf(),
            cmd: None,
            cols: 80,
            rows: 24,
            cwd_from: None,
            shell_integration: true,
            auto_approve: false,
            acp: None,
            profile: None,
            prompt: None,
        })
        .unwrap();
    assert!(
        !created.title.is_empty(),
        "a codename must be assigned at spawn"
    );
    let id = created.id;

    let mut rx = daemon.observe();
    daemon.rename(id, "Scout").unwrap();
    loop {
        match next_broadcast_control(&mut rx).await {
            proto::ServerMsg::SessionRenamed { session, title } if session == id => {
                assert_eq!(title, "Scout");
                break;
            }
            proto::ServerMsg::Error { message, .. } => panic!("daemon error: {message}"),
            _ => continue,
        }
    }
    let renamed = daemon
        .list()
        .into_iter()
        .find(|s| s.id == id)
        .expect("session listed");
    assert_eq!(renamed.title, "Scout");

    let err = daemon.rename(id, "   ").unwrap_err();
    assert!(err.to_string().contains("invalid session title"));
    match tokio::time::timeout(Duration::from_millis(200), next_broadcast_control(&mut rx)).await {
        Err(_) => {}
        Ok(proto::ServerMsg::SessionRenamed { .. }) => {
            panic!("a rejected rename must not broadcast")
        }
        Ok(other) => panic!("unexpected broadcast after a rejected rename: {other:?}"),
    }

    drop(daemon);
    let db = Db::open(&db_path).unwrap();
    db.mark_live_as_interrupted().unwrap();
    let restored = db.list_interrupted().unwrap();
    assert_eq!(restored.len(), 1);
    assert_eq!(restored[0].id, id);
    assert_eq!(restored[0].title, "Scout");
}

#[tokio::test]
async fn close_kills_a_live_session_and_removes_it() {
    let state_dir = tempfile::tempdir().unwrap();
    let daemon = Daemon::new(DaemonConfig {
        token: TOKEN.to_string(),
        db_path: state_dir.path().join("test.db"),
    })
    .unwrap();
    let tmp = tempfile::tempdir().unwrap();

    let mut rx = daemon.observe();
    let id = create_custom_session(&daemon, tmp.path(), vec!["cat"]).id;

    daemon.close(id).unwrap();

    loop {
        match next_broadcast_control(&mut rx).await {
            proto::ServerMsg::SessionRemoved { session } if session == id => break,
            proto::ServerMsg::Error { message, .. } => panic!("daemon error: {message}"),
            _ => continue,
        }
    }
}

#[tokio::test]
async fn respawn_reuses_the_directory() {
    let state_dir = tempfile::tempdir().unwrap();
    let daemon = Daemon::new(DaemonConfig {
        token: TOKEN.to_string(),
        db_path: state_dir.path().join("test.db"),
    })
    .unwrap();
    let tmp = tempfile::tempdir().unwrap();

    let old = create_custom_session(&daemon, tmp.path(), vec!["bash", "-lc", "exit 0"]);
    wait_for_state(&daemon, old.id, proto::SessionState::Exited).await;

    let fresh = daemon.respawn(old.id, true, None, None, false).unwrap();
    assert_ne!(fresh.id, old.id);
    assert_eq!(fresh.cwd, old.cwd);
    wait_for_state(&daemon, fresh.id, proto::SessionState::Exited).await;
}
