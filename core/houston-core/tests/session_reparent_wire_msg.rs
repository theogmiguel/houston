mod common;

use common::*;
use futures_util::{SinkExt, StreamExt};
use houston_core::daemon::{CreateParams, Daemon, DaemonConfig};
use houston_core::db::Db;
use houston_protocol as proto;
use tokio_tungstenite::tungstenite::Message;

#[tokio::test]
async fn session_reparent_over_the_wire_moves_the_session_and_broadcasts() {
    let (addr, _dir, daemon) = start_daemon_with_handle().await;

    let old_dir = tempfile::tempdir().unwrap();
    let new_dir = tempfile::tempdir().unwrap();
    let info = daemon
        .create_session(CreateParams {
            agent: proto::AgentKind::Shell,
            project_dir: old_dir.path().to_path_buf(),
            cmd: None,
            cols: 80,
            rows: 24,
            cwd_from: None,
            shell_integration: false,
            auto_approve: false,
            acp: None,
            profile: None,
            prompt: None,
        })
        .unwrap();

    let mut ws = connect_and_hello(addr, TOKEN).await;
    let _ = next_control(&mut ws).await;

    let msg = serde_json::to_string(&proto::ClientMsg::SessionReparent {
        session: info.id,
        project_dir: new_dir.path().display().to_string(),
    })
    .unwrap();
    ws.send(Message::text(msg)).await.unwrap();

    loop {
        match next_control(&mut ws).await {
            proto::ServerMsg::SessionReparented {
                session,
                project_dir,
            } => {
                assert_eq!(session, info.id);
                assert_eq!(project_dir, new_dir.path().display().to_string());
                break;
            }
            proto::ServerMsg::Error { message, .. } => {
                panic!("unexpected daemon error: {message}")
            }
            _ => continue,
        }
    }

    let listed = daemon
        .list()
        .into_iter()
        .find(|s| s.id == info.id)
        .expect("session must still be listed");
    assert_eq!(listed.project_dir, new_dir.path().display().to_string());
}

#[tokio::test]
async fn session_reparent_has_no_second_direct_reply() {
    let (addr, _dir, daemon) = start_daemon_with_handle().await;

    let old_dir = tempfile::tempdir().unwrap();
    let new_dir = tempfile::tempdir().unwrap();
    let info = daemon
        .create_session(CreateParams {
            agent: proto::AgentKind::Shell,
            project_dir: old_dir.path().to_path_buf(),
            cmd: None,
            cols: 80,
            rows: 24,
            cwd_from: None,
            shell_integration: false,
            auto_approve: false,
            acp: None,
            profile: None,
            prompt: None,
        })
        .unwrap();

    let mut ws = connect_and_hello(addr, TOKEN).await;
    let _ = next_control(&mut ws).await;

    let msg = serde_json::to_string(&proto::ClientMsg::SessionReparent {
        session: info.id,
        project_dir: new_dir.path().display().to_string(),
    })
    .unwrap();
    ws.send(Message::text(msg)).await.unwrap();

    let mut reparented_count = 0;
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_millis(500);
    while let Some(remaining) = deadline.checked_duration_since(tokio::time::Instant::now()) {
        match tokio::time::timeout(remaining, ws.next()).await {
            Ok(Some(Ok(Message::Text(t)))) => {
                if let Ok(proto::ServerMsg::SessionReparented { session, .. }) =
                    serde_json::from_str::<proto::ServerMsg>(&t)
                {
                    if session == info.id {
                        reparented_count += 1;
                    }
                }
            }
            Ok(Some(Ok(_))) => continue,
            Ok(Some(Err(e))) => panic!("socket error: {e}"),
            Ok(None) => break,
            Err(_) => break,
        }
    }
    assert_eq!(
        reparented_count, 1,
        "exactly one session_reparented broadcast expected, got {reparented_count}"
    );
}

#[tokio::test]
async fn session_reparent_over_the_wire_refuses_a_swarm_tied_session() {
    let state = tempfile::tempdir().unwrap();
    let db_path = state.path().join("test.db");
    let new_dir = tempfile::tempdir().unwrap();
    let agent_id = {
        let db = Db::open(&db_path).unwrap();
        db.insert_session(&proto::SessionInfo {
            id: 1,
            agent: proto::AgentKind::Shell,
            project_dir: "/tmp".into(),
            cwd: "/tmp".into(),
            state: proto::SessionState::Interrupted,
            title: "Husk".into(),
            codename: "Husk".into(),
            detected_agent: None,
            hidden: false,
            ssh_host: None,
            restore_deferred: None,
            status: None,
            context: None,
            swarm_agent: None,
            spawned_by: None,
            acp: None,
            live_children: 0,
            profile_label: None,
            children_waiting: 0,
            delegation: None,
            inbox_unread: 0,
            tags: vec![],
        })
        .unwrap();
        let roster = vec![proto::SwarmRosterEntry {
            label: "Coordinator".into(),
            role: proto::SwarmRole::Coordinator,
            agent: proto::AgentKind::Claude,
            auto_approve: true,
            plan_mode: false,
            model: None,
            custom_prompt: None,
            cmd: None,
        }];
        let (_swarm, agents) = db.swarm_create("S1", "/tmp/r", "g", &roster, 0).unwrap();
        db.swarm_agent_bind_session(agents[0].id, None, Some(1))
            .unwrap();
        agents[0].id
    };

    let daemon = Daemon::new(DaemonConfig {
        token: TOKEN.to_string(),
        db_path,
    })
    .unwrap();
    let (addr, _handle) =
        houston_core::server::start(daemon.clone(), "127.0.0.1:0".parse().unwrap())
            .await
            .unwrap();
    daemon.set_port(addr.port());

    let mut ws = connect_and_hello(addr, TOKEN).await;
    let _ = next_control(&mut ws).await;

    let msg = serde_json::to_string(&proto::ClientMsg::SessionReparent {
        session: 1,
        project_dir: new_dir.path().display().to_string(),
    })
    .unwrap();
    ws.send(Message::text(msg)).await.unwrap();

    let err = loop {
        match next_control(&mut ws).await {
            proto::ServerMsg::Error { message, .. } => break message,
            proto::ServerMsg::SessionReparented { .. } => {
                panic!("swarm-tied session must be refused, not reparented")
            }
            _ => continue,
        }
    };
    assert!(
        err.contains("session 1"),
        "error should name the session id: {err}"
    );
    assert!(
        err.contains(&format!("swarm agent {agent_id}")),
        "error should name the swarm agent id: {err}"
    );
    assert!(
        err.contains("cannot be reparented"),
        "error should name why this session is refused: {err}"
    );
}
