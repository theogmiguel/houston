#![cfg(unix)]

mod common;

use common::{connect_and_hello, next_control, start_daemon_with_handle, TOKEN};
use futures_util::SinkExt;
use houston_protocol as proto;
use tokio_tungstenite::tungstenite::Message;

async fn consume_hello(ws: &mut common::WsStream) {
    match next_control(ws).await {
        proto::ServerMsg::HelloOk { .. } => {}
        other => panic!("expected HelloOk after handshake, received {other:?}"),
    }
}

#[tokio::test]
async fn workspace_settings_and_task_links_are_available_over_control_wire() {
    let (addr, _state, daemon) = start_daemon_with_handle().await;
    let workspace = tempfile::tempdir().unwrap();
    daemon
        .workspace_add(workspace.path().to_str().unwrap())
        .unwrap();
    let mut ws = connect_and_hello(addr, TOKEN).await;
    consume_hello(&mut ws).await;

    ws.send(Message::text(
        serde_json::to_string(&proto::ClientMsg::TaskTrackerSettingsGet {
            workspace: workspace.path().display().to_string(),
        })
        .unwrap(),
    ))
    .await
    .unwrap();
    match next_control(&mut ws).await {
        proto::ServerMsg::TaskTrackerSettings { settings, refusal } => {
            assert!(refusal.is_none());
            assert!(settings.is_empty());
        }
        other => panic!("expected task tracker settings, received {other:?}"),
    }

    ws.send(Message::text(
        serde_json::to_string(&proto::ClientMsg::TaskTrackerLinksGet { task_id: 404 }).unwrap(),
    ))
    .await
    .unwrap();
    match next_control(&mut ws).await {
        proto::ServerMsg::TaskTrackerLinks { task_id, links } => {
            assert_eq!(task_id, 404);
            assert!(links.is_empty());
        }
        other => panic!("expected task tracker links, received {other:?}"),
    }
}

#[tokio::test]
async fn malformed_tracker_credentials_are_never_echoed_in_control_errors() {
    let (addr, _state, _daemon) = start_daemon_with_handle().await;
    let mut ws = connect_and_hello(addr, TOKEN).await;
    consume_hello(&mut ws).await;
    let secret = "notion-token-that-must-not-be-echoed";
    for payload in [
        serde_json::json!({"type":"task_tracker_credential_set", "workspace":"/tmp/project", "provider":"invalid", "token":secret}).to_string(),
        serde_json::json!({"type":"task_tracker_credential_set", "workspace":"/tmp/project", "provider":secret, "token":secret}).to_string(),
        format!(r#"{{"type":"task_tracker_credential_set","token":"{secret}""#),
        serde_json::json!({"type":"task_tracker_credential_set", "provider":"notion", "token":secret}).to_string().replace("token", r"tok\u0065n"),
    ] {
        ws.send(Message::text(payload)).await.unwrap();
        let reply = common::next_control(&mut ws).await;
        let encoded = serde_json::to_string(&reply).unwrap();
        assert!(!encoded.contains(secret), "control error disclosed the credential: {encoded}");
        assert!(matches!(reply, proto::ServerMsg::Error { context: None, .. }), "{reply:?}");
    }
}
