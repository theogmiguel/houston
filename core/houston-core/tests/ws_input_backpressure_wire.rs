//! Keystrokes on `/ws` reach the PTY while the daemon is blocked sending output to a client
//! that is not reading. One flood per test binary: on Windows, a flood from an earlier test in
//! the same process has slowed later floods enough to time out filling the scrollback.
#![allow(clippy::disallowed_methods)]
mod common;
mod ws_input;

use common::*;
use futures_util::SinkExt;
use houston_protocol as proto;
use std::time::{Duration, Instant};
use tokio_tungstenite::tungstenite::Message;
use ws_input::*;

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn stdin_reaches_the_pty_while_output_backpressures_the_socket() {
    let (addr, _state, daemon) = start_daemon_with_handle().await;
    let project = tempfile::tempdir().unwrap();
    let flood_id = spawn(&daemon, project.path(), flood());
    let reader_id = spawn(&daemon, project.path(), line_reader(project.path()));
    let _sessions = Sessions(daemon.clone(), vec![flood_id, reader_id]);
    assert!(
        wait_for_file(&project.path().join("ready"), Duration::from_secs(30))
            .await
            .is_some(),
        "line reader session {reader_id} did not start within 30 s"
    );

    let mut ws = connect_unread(addr).await;
    fill_scrollback(&daemon, flood_id).await;
    attach_and_backlog(&daemon, &mut ws, flood_id).await;

    ws.send(Message::Binary(
        proto::encode_stdin_frame(reader_id, b"through-backpressure\r").into(),
    ))
    .await
    .unwrap();
    let delivered = wait_for_file(&project.path().join("got"), INPUT_BOUND).await;
    let Some(latency) = delivered else {
        panic!(
            "session {reader_id} did not receive stdin within {INPUT_BOUND:?} while the same \
             socket's output to session {flood_id} was backpressured"
        );
    };
    eprintln!(
        "stdin under backpressure: delivered in {} ms (bound {} ms); single run, host load \
         uncontrolled",
        latency.as_millis(),
        INPUT_BOUND.as_millis()
    );
    // The child may still hold the file open for writing.
    let read_started = Instant::now();
    let got = loop {
        match std::fs::read_to_string(project.path().join("got")) {
            Ok(got) if !got.trim().is_empty() => break got,
            result => assert!(
                read_started.elapsed() < Duration::from_secs(10),
                "reading the line reader's output: {result:?}"
            ),
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    };
    assert_eq!(got.trim(), "through-backpressure");
}
