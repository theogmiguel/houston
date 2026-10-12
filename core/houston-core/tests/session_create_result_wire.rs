#![cfg(unix)]

mod common;

use common::*;
use futures_util::SinkExt;
use houston_protocol as proto;
use tokio_tungstenite::tungstenite::Message;

#[tokio::test]
async fn create_results_are_private_and_correlate_success_and_refusal() {
    let (addr, _state) = start_daemon().await;
    let project = tempfile::tempdir().unwrap();
    let mut first = connect_and_hello(addr, TOKEN).await;
    let mut second = connect_and_hello(addr, TOKEN).await;
    let _ = next_control(&mut first).await;
    let _ = next_control(&mut second).await;

    // Identical commands/workspaces and request numbers on different connections.
    // Neither the broadcast nor the other socket's request can acknowledge ours.
    let mut create: serde_json::Value = serde_json::from_str(&create_custom_msg(
        vec!["sh", "-c", "sleep 30"],
        project.path(),
    ))
    .unwrap();
    create["request"] = 7.into();
    first.send(Message::text(create.to_string())).await.unwrap();
    let first_id = loop {
        if let proto::ServerMsg::SessionCreateResult {
            request,
            info,
            error,
        } = next_control(&mut first).await
        {
            assert_eq!(request, 7);
            assert!(error.is_none());
            break info.unwrap().id;
        }
    };
    let broadcast = expect_created(&mut second).await;
    assert_eq!(broadcast.id, first_id);
    second
        .send(Message::text(create.to_string()))
        .await
        .unwrap();
    let second_id = loop {
        if let proto::ServerMsg::SessionCreateResult {
            request,
            info,
            error,
        } = next_control(&mut second).await
        {
            assert_eq!(request, 7);
            assert!(error.is_none());
            break info.unwrap().id;
        }
    };
    assert_ne!(first_id, second_id);

    create["request"] = 8.into();
    create["cmd"] = serde_json::json!(["/houston-test-missing-executable"]);
    first.send(Message::text(create.to_string())).await.unwrap();
    loop {
        match next_control(&mut first).await {
            proto::ServerMsg::SessionCreateResult {
                request,
                info,
                error,
            } => {
                assert_eq!(
                    request, 8,
                    "another connection's result reached this socket"
                );
                assert!(info.is_none());
                assert!(error.is_some());
                break;
            }
            proto::ServerMsg::Error { message, .. } => panic!("uncorrelated refusal: {message}"),
            _ => {}
        }
    }
}
