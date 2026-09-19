mod common;

use common::*;
use futures_util::SinkExt;
use houston_protocol as proto;
use std::time::Duration;
use tokio_tungstenite::tungstenite::Message;

async fn drain_frames(ws: &mut WsStream, session: u32, window: Duration) -> Vec<Vec<u8>> {
    use futures_util::StreamExt;
    let deadline = tokio::time::Instant::now() + window;
    let mut frames = Vec::new();
    loop {
        let Some(remaining) = deadline.checked_duration_since(tokio::time::Instant::now()) else {
            return frames;
        };
        match tokio::time::timeout(remaining, ws.next()).await {
            Err(_) => return frames,
            Ok(None) => return frames,
            Ok(Some(Err(e))) => panic!("socket error: {e}"),
            Ok(Some(Ok(Message::Binary(buf)))) => {
                if let Some((id, _, payload)) = proto::decode_output_frame(&buf) {
                    if id == session {
                        frames.push(payload.to_vec());
                    }
                }
            }
            Ok(Some(Ok(_))) => continue,
        }
    }
}

#[tokio::test]
async fn a_control_only_connection_receives_no_output_frames() {
    let (addr, _state) = start_daemon().await;
    let project = tempfile::tempdir().unwrap();

    let mut producer = connect_and_hello(addr, TOKEN).await;
    let _ = next_control(&mut producer).await;
    producer
        .send(Message::text(create_custom_msg(
            vec![
                "sh",
                "-c",
                "for i in 1 2 3 4 5; do echo MARKER-$i; sleep 0.05; done; sleep 600",
            ],
            project.path(),
        )))
        .await
        .unwrap();
    let session = expect_created(&mut producer).await.id;

    let mut control_only = connect_and_hello(addr, TOKEN).await;
    let _ = next_control(&mut control_only).await;

    let seen = collect_output_until(&mut producer, session, "MARKER-5").await;
    assert!(
        seen.contains("MARKER-5"),
        "producer should see its own output"
    );

    let leaked = drain_frames(&mut control_only, session, Duration::from_millis(300)).await;
    assert!(
        leaked.is_empty(),
        "a control-only connection received {} output frame(s) it never asked for — \
         the duplicate delivery W1 removed is back",
        leaked.len()
    );
}

#[tokio::test]
async fn declaring_a_session_visible_starts_the_frames() {
    let (addr, _state) = start_daemon().await;
    let project = tempfile::tempdir().unwrap();

    let mut producer = connect_and_hello(addr, TOKEN).await;
    let _ = next_control(&mut producer).await;
    producer
        .send(Message::text(create_custom_msg(
            vec!["sh", "-c", "while true; do echo TICK; sleep 0.05; done"],
            project.path(),
        )))
        .await
        .unwrap();
    let session = expect_created(&mut producer).await.id;

    let mut observer = connect_and_hello(addr, TOKEN).await;
    let _ = next_control(&mut observer).await;
    assert!(
        drain_frames(&mut observer, session, Duration::from_millis(200))
            .await
            .is_empty(),
        "observer received frames before asking for them"
    );

    observer
        .send(Message::text(
            serde_json::to_string(&proto::ClientMsg::SessionVisibility {
                session,
                visible: true,
            })
            .unwrap(),
        ))
        .await
        .unwrap();

    let seen = collect_output_until(&mut observer, session, "TICK").await;
    assert!(
        seen.contains("TICK"),
        "session_visibility{{visible:true}} must start delivery on this connection"
    );

    observer
        .send(Message::text(
            serde_json::to_string(&proto::ClientMsg::SessionVisibility {
                session,
                visible: false,
            })
            .unwrap(),
        ))
        .await
        .unwrap();
    let _ = drain_frames(&mut observer, session, Duration::from_millis(200)).await;
    assert!(
        drain_frames(&mut observer, session, Duration::from_millis(300))
            .await
            .is_empty(),
        "visible:false must stop delivery"
    );
}

#[tokio::test]
async fn attaching_alone_is_enough_to_receive_frames() {
    let (addr, _state) = start_daemon().await;
    let project = tempfile::tempdir().unwrap();

    let mut producer = connect_and_hello(addr, TOKEN).await;
    let _ = next_control(&mut producer).await;
    producer
        .send(Message::text(create_custom_msg(
            vec!["sh", "-c", "while true; do echo PULSE; sleep 0.05; done"],
            project.path(),
        )))
        .await
        .unwrap();
    let session = expect_created(&mut producer).await.id;

    let mut attacher = connect_and_hello(addr, TOKEN).await;
    let _ = next_control(&mut attacher).await;
    attacher
        .send(Message::text(
            serde_json::to_string(&proto::ClientMsg::SessionAttach {
                session,
                replay_bytes: None,
                snapshot: None,
            })
            .unwrap(),
        ))
        .await
        .unwrap();

    let seen = collect_output_until(&mut attacher, session, "PULSE").await;
    assert!(seen.contains("PULSE"), "session_attach must start delivery");
}
