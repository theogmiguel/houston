mod common;

use common::*;
use futures_util::SinkExt;
use houston_protocol as proto;
use std::time::Duration;
use tokio_tungstenite::tungstenite::Message;

async fn generate(ws: &mut WsStream, session: u32, cmd: Vec<&str>) {
    let msg = serde_json::to_string(&proto::ClientMsg::HandoffGenerate {
        session,
        provider: proto::AgentKind::Custom,
        cmd: Some(cmd.into_iter().map(String::from).collect()),
    })
    .unwrap();
    ws.send(Message::text(msg)).await.unwrap();
}

async fn expect_started(ws: &mut WsStream) -> u32 {
    loop {
        match next_control(ws).await {
            proto::ServerMsg::HandoffStarted { request, .. } => return request,
            proto::ServerMsg::Error { message, .. } => panic!("daemon error: {message}"),
            _ => continue,
        }
    }
}

#[tokio::test]
async fn silent_generator_times_out() {
    std::env::set_var("HOUSTON_HANDOFF_TIMEOUT_MS", "1500");
    let (addr, _state) = start_daemon().await;
    let project = tempfile::tempdir().unwrap();
    let mut ws = connect_and_hello(addr, TOKEN).await;
    let _ = next_control(&mut ws).await;

    ws.send(Message::text(create_custom_msg(
        vec!["sh", "-c", "echo src; sleep 600"],
        project.path(),
    )))
    .await
    .unwrap();
    let source = expect_created(&mut ws).await.id;
    collect_output_until(&mut ws, source, "src").await;

    generate(&mut ws, source, vec!["sh", "-c", "sleep 600", "sh"]).await;
    let request = expect_started(&mut ws).await;

    let deadline = tokio::time::Instant::now() + Duration::from_secs(20);
    loop {
        assert!(
            tokio::time::Instant::now() < deadline,
            "timeout error never arrived"
        );
        match next_control(&mut ws).await {
            proto::ServerMsg::HandoffError {
                request: r,
                message,
            } if r == request => {
                assert!(message.contains("no output"), "got: {message}");
                break;
            }
            proto::ServerMsg::HandoffDone { .. } => panic!("must not succeed"),
            _ => continue,
        }
    }
}
