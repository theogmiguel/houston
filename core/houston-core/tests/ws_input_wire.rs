//! Splitting the `/ws` socket into a reader and a writer keeps attach-family reply order and
//! ends the connection when either half ends.
#![allow(clippy::disallowed_methods)]
mod common;
mod ws_input;

use common::*;
use futures_util::{SinkExt, StreamExt};
use houston_protocol as proto;
use std::time::{Duration, Instant};
use tokio_tungstenite::tungstenite::Message;
use ws_input::*;

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn attach_and_create_replies_keep_request_order_around_stdin() {
    let _serial = SERIAL.lock().await;
    let (addr, _state, daemon) = start_daemon_with_handle().await;
    let project = tempfile::tempdir().unwrap();
    // `hello_ok` lists sessions with a `git` probe each; connect first so a loaded host
    // cannot push it past the helper's timeout.
    let mut ws = connect_and_hello(addr, TOKEN).await;
    let _ = next_control(&mut ws).await;
    let ids: Vec<u32> = (0..3)
        .map(|_| spawn(&daemon, project.path(), ticker()))
        .collect();
    let mut sessions = Sessions(daemon.clone(), ids.clone());
    let (a, b, c) = (ids[0], ids[1], ids[2]);
    let create = |request: u32| {
        let mut msg: serde_json::Value = serde_json::from_str(&create_custom_msg(
            sleeper().iter().map(String::as_str).collect(),
            project.path(),
        ))
        .unwrap();
        msg["request"] = request.into();
        Message::text(msg.to_string())
    };
    let stdin = |session: u32| Message::Binary(proto::encode_stdin_frame(session, b"x").into());
    for (round, order) in [[c, a, b], [b, c, a]].into_iter().enumerate() {
        let base = round as u32 * 10;
        let burst = vec![
            attach_msg(order[0], None),
            stdin(a),
            create(base + 1),
            Message::text(r#"{"type":"session_list"}"#),
            attach_msg(order[1], None),
            stdin(b),
            create(base + 2),
            stdin(c),
            attach_msg(order[2], None),
        ];
        for msg in burst {
            ws.feed(msg).await.unwrap();
        }
        ws.flush().await.unwrap();

        let expected = [
            format!("attach {}", order[0]),
            format!("create {}", base + 1),
            format!("attach {}", order[1]),
            format!("create {}", base + 2),
            format!("attach {}", order[2]),
        ];
        let mut replies = Vec::new();
        let mut attached = std::collections::HashSet::new();
        let started = Instant::now();
        while replies.len() < expected.len() {
            assert!(
                started.elapsed() < Duration::from_secs(90),
                "round {round}: replies so far {replies:?}, expected {expected:?}"
            );
            let frame = tokio::time::timeout(Duration::from_secs(30), ws.next())
                .await
                .expect("timed out waiting for attach and create replies")
                .expect("socket closed")
                .expect("socket error");
            match frame {
                Message::Text(text) => match serde_json::from_str(&text).unwrap() {
                    proto::ServerMsg::Scrollback {
                        session, attempt, ..
                    } => {
                        assert_eq!(
                            attempt,
                            round as u32 + 1,
                            "session {session} attach attempt"
                        );
                        attached.insert(session);
                        replies.push(format!("attach {session}"));
                    }
                    proto::ServerMsg::SessionCreateResult {
                        request,
                        info,
                        error,
                    } => {
                        let info = info.unwrap_or_else(|| panic!("create {request}: {error:?}"));
                        sessions.1.push(info.id);
                        replies.push(format!("create {request}"));
                    }
                    proto::ServerMsg::Error { message, context } => {
                        panic!("daemon error {context:?}: {message}")
                    }
                    _ => {}
                },
                Message::Binary(buf) => {
                    if let Some((id, _, _)) = proto::decode_output_frame(&buf) {
                        assert!(
                            !ids.contains(&id) || attached.contains(&id) || round > 0,
                            "live frame for session {id} arrived before its attach reply"
                        );
                    }
                }
                _ => {}
            }
        }
        assert_eq!(replies, expected, "round {round}");
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_client_dropping_a_backpressured_socket_releases_the_connection() {
    let _serial = SERIAL.lock().await;
    let (addr, _state, daemon) = start_daemon_with_handle().await;
    let project = tempfile::tempdir().unwrap();
    let flood_id = spawn(&daemon, project.path(), flood());
    let _sessions = Sessions(daemon.clone(), vec![flood_id]);

    let mut ws = connect_unread(addr).await;
    attach_and_backlog(&daemon, &mut ws, flood_id).await;
    assert_eq!(daemon.manage_status().clients_connected, 1);
    drop(ws);
    wait_for_clients(&daemon, 0, Duration::from_secs(15)).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_connection_closed_by_its_writer_also_stops_reading() {
    let _serial = SERIAL.lock().await;
    let (addr, _state, daemon) = start_daemon_with_handle().await;
    let project = tempfile::tempdir().unwrap();
    let flood_id = spawn(&daemon, project.path(), flood());
    let _sessions = Sessions(daemon.clone(), vec![flood_id]);

    let mut ws = connect_unread(addr).await;
    attach_and_backlog(&daemon, &mut ws, flood_id).await;
    // Overrun the control broadcast while the writer is blocked, so it ends the connection
    // with `control_lag` once the client drains. Without the reader's abort the socket would
    // stay open, because the reader still holds its half.
    for _ in 0..houston_core::daemon::OUTBOUND_CAPACITY + 64 {
        daemon.broadcast_control(&proto::ServerMsg::WorkspaceList {
            workspaces: Vec::new(),
        });
    }
    let started = Instant::now();
    let mut lagged = false;
    let end = loop {
        assert!(
            started.elapsed() < Duration::from_secs(60),
            "connection still open 60 s after the control broadcast lagged (lag error seen: {lagged})"
        );
        match tokio::time::timeout(Duration::from_secs(10), ws.next()).await {
            Err(_) => panic!(
                "socket stayed open but silent after the writer stopped (lag error seen: {lagged})"
            ),
            Ok(None) => break "end of stream".to_string(),
            Ok(Some(Err(error))) => break error.to_string(),
            Ok(Some(Ok(Message::Close(frame)))) => break format!("close {frame:?}"),
            Ok(Some(Ok(Message::Text(text)))) => {
                if let proto::ServerMsg::Error {
                    context: Some(context),
                    ..
                } = serde_json::from_str(&text).unwrap()
                {
                    lagged |= context == "control_lag";
                }
            }
            Ok(Some(Ok(_))) => {}
        }
    };
    // Windows resets a socket closed with output still queued, which discards the
    // `control_lag` error the client had not read yet, so seeing it is not required.
    eprintln!("writer-side close: {end}; control_lag error seen: {lagged}");
    wait_for_clients(&daemon, 0, Duration::from_secs(15)).await;
}
