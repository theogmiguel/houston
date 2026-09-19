#![cfg(unix)]

mod common;

use common::*;
use futures_util::{SinkExt as _, StreamExt as _};
use houston_protocol as proto;
use std::time::Duration;
use tokio_tungstenite::tungstenite::Message;

fn attach_msg(session: u32, snapshot: bool) -> Message {
    Message::text(
        serde_json::to_string(&proto::ClientMsg::SessionAttach {
            session,
            replay_bytes: None,
            snapshot: snapshot.then_some(true),
        })
        .unwrap(),
    )
}

fn visibility_msg(session: u32, visible: bool) -> Message {
    Message::text(
        serde_json::to_string(&proto::ClientMsg::SessionVisibility { session, visible }).unwrap(),
    )
}

struct Taken {
    attempt: u32,
    output_offset: u64,
    state: Vec<u8>,
}

async fn take_snapshot(ws: &mut WsStream, session: u32) -> Taken {
    loop {
        match next_control(ws).await {
            proto::ServerMsg::AttachSnapshot {
                session: id,
                attempt,
                output_offset,
                format_version,
                state,
                ..
            } if id == session => {
                use base64::Engine as _;
                assert_eq!(
                    format_version,
                    houston_core::vt::snapshot_format_version(),
                    "the daemon must stamp the version its own library writes"
                );
                return Taken {
                    attempt,
                    output_offset,
                    state: base64::engine::general_purpose::STANDARD
                        .decode(state)
                        .expect("state is base64"),
                };
            }
            proto::ServerMsg::Scrollback { session: id, .. } if id == session => {
                panic!("a snapshot attach was answered with a byte replay")
            }
            _ => {}
        }
    }
}

async fn frames_until(
    ws: &mut WsStream,
    session: u32,
    needle: &str,
) -> (String, Vec<(u64, usize)>) {
    let mut text = String::new();
    let mut frames = Vec::new();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
    loop {
        let remaining = deadline
            .checked_duration_since(tokio::time::Instant::now())
            .expect("timed out waiting for PTY output");
        let msg = tokio::time::timeout(remaining, ws.next())
            .await
            .expect("timed out waiting for PTY output")
            .expect("socket closed")
            .expect("socket error");
        if let Message::Binary(buf) = msg {
            if let Some((id, offset, payload)) = proto::decode_output_frame(&buf) {
                if id == session {
                    frames.push((offset, payload.len()));
                    text.push_str(&String::from_utf8_lossy(payload));
                    if text.contains(needle) {
                        return (text, frames);
                    }
                }
            }
        }
    }
}

#[tokio::test]
async fn hello_ok_advertises_the_emulator_and_its_container_version() {
    let (addr, _tmp) = start_daemon().await;
    let mut ws = connect_and_hello(addr, TOKEN).await;
    match next_control(&mut ws).await {
        proto::ServerMsg::HelloOk {
            snapshot_attach,
            snapshot_format_version,
            ..
        } => {
            assert!(snapshot_attach, "this build links libghostty-vt");
            assert_eq!(
                snapshot_format_version,
                houston_core::vt::snapshot_format_version()
            );
            assert!(
                snapshot_format_version > 0,
                "an advertised emulator must name a real container version"
            );
        }
        other => panic!("expected HelloOk, got {other:?}"),
    }
}

#[tokio::test]
async fn a_hidden_then_shown_pane_gets_a_snapshot_and_then_contiguous_bytes() {
    let (addr, tmp) = start_daemon().await;
    let mut ws = connect_and_hello(addr, TOKEN).await;
    let _ = next_control(&mut ws).await;

    let project = tempfile::tempdir_in(tmp.path()).unwrap();
    ws.send(Message::text(create_custom_msg(
        vec!["sh", "-c", "cat"],
        project.path(),
    )))
    .await
    .unwrap();
    let session = expect_created(&mut ws).await.id;

    ws.send(Message::Binary(
        proto::encode_stdin_frame(session, b"FIRST\n").into(),
    ))
    .await
    .unwrap();
    let (_, _) = frames_until(&mut ws, session, "FIRST").await;

    ws.send(visibility_msg(session, false)).await.unwrap();
    ws.send(attach_msg(session, true)).await.unwrap();
    let first = take_snapshot(&mut ws, session).await;
    assert_eq!(first.attempt, 1, "the first attach on this socket");
    assert!(!first.state.is_empty());

    ws.send(Message::Binary(
        proto::encode_stdin_frame(session, b"SECOND\n").into(),
    ))
    .await
    .unwrap();

    ws.send(visibility_msg(session, true)).await.unwrap();
    ws.send(attach_msg(session, true)).await.unwrap();
    let second = take_snapshot(&mut ws, session).await;
    assert_eq!(second.attempt, 2, "the second attach on the same socket");
    assert!(
        second.output_offset >= first.output_offset,
        "a later snapshot cannot describe an earlier cutoff: {} then {}",
        first.output_offset,
        second.output_offset
    );

    let mut restored = houston_core::vt::Emulator::new(80, 24, houston_core::vt::VT_HISTORY_BYTES)
        .expect("emulator");
    restored.import(&second.state).expect("import");
    let screen = restored.screen_text(40).join("\n");
    assert!(
        screen.contains("SECOND"),
        "output produced while the pane was hidden must be IN the snapshot, not replayed \
         after it: {screen:?}"
    );

    ws.send(Message::Binary(
        proto::encode_stdin_frame(session, b"THIRD\n").into(),
    ))
    .await
    .unwrap();
    let (_, frames) = frames_until(&mut ws, session, "THIRD").await;
    let after: Vec<_> = frames
        .iter()
        .filter(|(offset, len)| offset + (*len as u64) > second.output_offset)
        .collect();
    assert!(
        !after.is_empty(),
        "the pane must receive frames after the snapshot: {frames:?}"
    );
    let mut cursor = second.output_offset;
    for (offset, len) in &after {
        assert!(
            *offset <= cursor,
            "a hole between the cutoff and the first frame after it: expected a frame at or \
             before {cursor}, got one at {offset}"
        );
        cursor = offset + (*len as u64);
    }
}

async fn output_and_exit(ws: &mut WsStream, session: u32, needle: &str) {
    let mut text = String::new();
    let mut exited = false;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
    while !(exited && text.contains(needle)) {
        let remaining = deadline
            .checked_duration_since(tokio::time::Instant::now())
            .expect("timed out waiting for the pane's output and exit");
        let msg = tokio::time::timeout(remaining, ws.next())
            .await
            .expect("timed out waiting for the pane's output and exit")
            .expect("socket closed")
            .expect("socket error");
        match msg {
            Message::Binary(buf) => {
                if let Some((id, _, payload)) = proto::decode_output_frame(&buf) {
                    if id == session {
                        text.push_str(&String::from_utf8_lossy(payload));
                    }
                }
            }
            Message::Text(t) => {
                if let Ok(proto::ServerMsg::SessionState {
                    session: s,
                    state: proto::SessionState::Exited,
                    ..
                }) = serde_json::from_str::<proto::ServerMsg>(&t)
                {
                    exited |= s == session;
                }
            }
            _ => {}
        }
    }
}

#[tokio::test]
async fn a_finished_pane_still_answers_with_the_screen_it_died_on() {
    let (addr, tmp) = start_daemon().await;
    let mut ws = connect_and_hello(addr, TOKEN).await;
    let _ = next_control(&mut ws).await;

    let project = tempfile::tempdir_in(tmp.path()).unwrap();
    ws.send(Message::text(create_custom_msg(
        vec!["sh", "-c", "printf 'LASTWORDS\\n'"],
        project.path(),
    )))
    .await
    .unwrap();
    let session = expect_created(&mut ws).await.id;
    output_and_exit(&mut ws, session, "LASTWORDS").await;

    ws.send(attach_msg(session, true)).await.unwrap();
    let taken = take_snapshot(&mut ws, session).await;
    let mut restored = houston_core::vt::Emulator::new(80, 24, houston_core::vt::VT_HISTORY_BYTES)
        .expect("emulator");
    restored.import(&taken.state).expect("import");
    assert!(
        restored.screen_text(40).join("\n").contains("LASTWORDS"),
        "a husk must still hand back the screen it exited on"
    );
}

#[tokio::test]
async fn a_snapshot_attach_for_an_unknown_session_is_refused_by_name() {
    let (addr, _tmp) = start_daemon().await;
    let mut ws = connect_and_hello(addr, TOKEN).await;
    let _ = next_control(&mut ws).await;

    ws.send(attach_msg(4242, true)).await.unwrap();
    loop {
        match next_control(&mut ws).await {
            proto::ServerMsg::Error { message, .. } => {
                assert!(
                    message.contains("4242"),
                    "the refusal must name the session asked for: {message:?}"
                );
                break;
            }
            proto::ServerMsg::AttachSnapshot { .. } | proto::ServerMsg::Scrollback { .. } => {
                panic!("an unknown session must be refused, not answered")
            }
            _ => {}
        }
    }
}
