#![cfg(target_os = "linux")]

mod common;

use futures_util::SinkExt;
use houston_core::daemon::{CreateParams, Daemon};
use houston_protocol as proto;
use std::net::TcpListener;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use common::{TOKEN, WsStream, connect_and_hello, next_control, start_daemon_with_handle};

fn listener_session(daemon: &Arc<Daemon>, dir: &PathBuf, port: u16) -> proto::SessionInfo {
    let source = format!(
        r#"python3 -u -c 'import socket,time;s=socket.socket();s.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1);s.bind(("127.0.0.1",{port}));s.listen();time.sleep(60)'"#
    );
    daemon
        .create_session(CreateParams {
            agent: proto::AgentKind::Custom,
            project_dir: dir.clone(),
            cmd: Some(vec!["sh".into(), "-c".into(), source]),
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

async fn local_servers(ws: &mut WsStream, workspace: &str) -> Vec<proto::LocalServer> {
    ws.send(tokio_tungstenite::tungstenite::Message::text(
        serde_json::to_string(&proto::ClientMsg::WorkspaceLocalServers {
            workspace: workspace.to_owned(),
        })
        .unwrap(),
    ))
    .await
    .unwrap();
    loop {
        match next_control(ws).await {
            proto::ServerMsg::WorkspaceLocalServers {
                workspace: reply_workspace,
                servers,
                ..
            } if reply_workspace == workspace => return servers,
            proto::ServerMsg::Error { message, .. } => panic!("daemon error: {message}"),
            _ => continue,
        }
    }
}

#[tokio::test]
async fn reports_only_listeners_from_live_sessions_in_the_requested_workspace() {
    let (addr, _state, daemon) = start_daemon_with_handle().await;
    let mut ws = connect_and_hello(addr, TOKEN).await;
    let _ = next_control(&mut ws).await;
    let workspace = tempfile::tempdir().unwrap();
    let other_workspace = tempfile::tempdir().unwrap();
    let port = TcpListener::bind(("127.0.0.1", 0))
        .unwrap()
        .local_addr()
        .unwrap()
        .port();
    let other_port = TcpListener::bind(("127.0.0.1", 0))
        .unwrap()
        .local_addr()
        .unwrap()
        .port();
    let local = listener_session(&daemon, &workspace.path().to_path_buf(), port);
    let unrelated = listener_session(&daemon, &other_workspace.path().to_path_buf(), other_port);

    let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
    loop {
        if local_servers(&mut ws, &workspace.path().to_string_lossy())
            .await
            .iter()
            .any(|s| s.port == port)
        {
            break;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "listener on port {port} did not appear in the local-server reply"
        );
        tokio::time::sleep(Duration::from_millis(25)).await;
    }

    let rows = local_servers(&mut ws, &workspace.path().to_string_lossy()).await;
    let server = rows.iter().find(|server| server.port == port).unwrap();
    assert_eq!(server.session, local.id);
    assert!(!server.process.is_empty());
    assert_eq!(server.pane_title, local.title);
    assert!(
        !rows.iter().any(|server| server.port == other_port),
        "another workspace's listener leaked into the reply"
    );

    daemon.kill(local.id).unwrap();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
    loop {
        if !local_servers(&mut ws, &workspace.path().to_string_lossy())
            .await
            .iter()
            .any(|s| s.port == port)
        {
            break;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "listener on port {port} remained after its session stopped"
        );
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    daemon.kill(unrelated.id).ok();
}
