#![cfg(unix)]

mod common;

use common::{connect_and_hello, next_control, start_daemon_with_handle, TOKEN};
use futures_util::SinkExt;
use houston_protocol as proto;
use tokio_tungstenite::tungstenite::Message;

#[tokio::test]
async fn workspace_settings_and_task_links_are_available_over_control_wire() {
    let (addr, _state, daemon) = start_daemon_with_handle().await;
    let workspace = tempfile::tempdir().unwrap();
    daemon.workspace_add(workspace.path().to_str().unwrap()).unwrap();
    let mut ws = connect_and_hello(addr, TOKEN).await;

    ws.send(Message::text(serde_json::to_string(&proto::ClientMsg::TaskTrackerSettingsGet {
        workspace: workspace.path().display().to_string(),
    }).unwrap())).await.unwrap();
    match next_control(&mut ws).await {
        proto::ServerMsg::TaskTrackerSettings { settings, refusal } => {
            assert!(refusal.is_none());
            assert!(settings.is_empty());
        }
        other => panic!("expected task tracker settings, received {other:?}"),
    }

    ws.send(Message::text(serde_json::to_string(&proto::ClientMsg::TaskTrackerLinksGet { task_id: 404 }).unwrap())).await.unwrap();
    match next_control(&mut ws).await {
        proto::ServerMsg::TaskTrackerLinks { task_id, links } => {
            assert_eq!(task_id, 404);
            assert!(links.is_empty());
        }
        other => panic!("expected task tracker links, received {other:?}"),
    }
}
