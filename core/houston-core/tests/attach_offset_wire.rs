#![cfg(unix)]

mod common;

use base64::Engine as _;
use common::*;
use futures_util::SinkExt as _;
use houston_protocol as proto;
use tokio_tungstenite::tungstenite::Message;

struct Replayed {
    data: Vec<u8>,
    generation: u32,
    replayed_bytes: u64,
    bytes_seen: u64,
}

async fn attach(
    ws: &mut WsStream,
    session: u32,
    from_offset: Option<u64>,
    generation: Option<u32>,
) -> Replayed {
    ws.send(Message::text(
        serde_json::to_string(&proto::ClientMsg::SessionAttach {
            session,
            replay_bytes: None,
            snapshot: Some(false),
            from_offset,
            generation,
        })
        .unwrap(),
    ))
    .await
    .unwrap();
    loop {
        if let proto::ServerMsg::Scrollback {
            session: id,
            data,
            generation,
            replayed_bytes,
            bytes_seen,
            ..
        } = next_control(ws).await
        {
            if id == session {
                return Replayed {
                    data: base64::engine::general_purpose::STANDARD
                        .decode(data)
                        .expect("scrollback data is base64"),
                    generation,
                    replayed_bytes,
                    bytes_seen,
                };
            }
        }
    }
}

#[tokio::test]
async fn an_attach_from_a_held_offset_replays_only_the_missing_tail() {
    let (addr, tmp) = start_daemon().await;
    let mut ws = connect_and_hello(addr, TOKEN).await;
    let _ = next_control(&mut ws).await;

    let project = tempfile::tempdir_in(tmp.path()).unwrap();
    ws.send(Message::text(create_custom_msg(
        vec![
            "sh",
            "-c",
            "printf 'first-chunk\\n'; read _; printf 'second-chunk\\n'; sleep 30",
        ],
        project.path(),
    )))
    .await
    .unwrap();
    let session = expect_created(&mut ws).await.id;
    attach_and_collect_output_until(&mut ws, session, "first-chunk").await;

    let held = attach(&mut ws, session, None, None).await;
    assert!(String::from_utf8_lossy(&held.data).contains("first-chunk"));

    ws.send(Message::Binary(
        proto::encode_stdin_frame(session, b"\n").into(),
    ))
    .await
    .unwrap();
    collect_output_until(&mut ws, session, "second-chunk").await;

    let tail = attach(
        &mut ws,
        session,
        Some(held.bytes_seen),
        Some(held.generation),
    )
    .await;
    let text = String::from_utf8_lossy(&tail.data);
    assert!(
        text.contains("second-chunk"),
        "the tail misses new output: {text:?}"
    );
    assert!(
        !text.contains("first-chunk"),
        "the tail repeats bytes the client already held: {text:?}"
    );
    assert_eq!(tail.replayed_bytes, tail.bytes_seen - held.bytes_seen);
    assert_eq!(tail.data.len() as u64, tail.replayed_bytes);

    let other_run = attach(
        &mut ws,
        session,
        Some(held.bytes_seen),
        Some(held.generation + 1),
    )
    .await;
    assert!(
        String::from_utf8_lossy(&other_run.data).contains("first-chunk"),
        "a generation mismatch must fall back to a full replay"
    );

    let ahead = attach(
        &mut ws,
        session,
        Some(tail.bytes_seen + 1_000),
        Some(held.generation),
    )
    .await;
    assert!(
        String::from_utf8_lossy(&ahead.data).contains("first-chunk"),
        "an offset past the ring's end must fall back to a full replay"
    );
}
