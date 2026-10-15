//! Keystrokes on `/ws` reach the PTY while the daemon is blocked sending output to a client
//! that is not reading, and splitting the socket keeps reply order and connection teardown.
#![allow(clippy::disallowed_methods)]
mod common;

use common::*;
use futures_util::{SinkExt, StreamExt};
use houston_core::daemon::{CreateParams, Daemon, Outbound};
use houston_core::frame_queue::Observer;
use houston_protocol as proto;
use std::path::Path;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio_tungstenite::tungstenite::Message;

type RawWs = tokio_tungstenite::WebSocketStream<tokio::net::TcpStream>;

// Far past a 4 KiB client window plus the daemon's socket and WebSocket write buffers, so
// its send is blocked on backpressure by the time the keystroke goes out. ConPTY renders a
// flood at tens of KiB/s on a loaded host, which rules out overflowing the 4 MiB tap.
const BACKLOG_BYTES: u64 = 1024 * 1024;
const INPUT_BOUND: Duration = Duration::from_secs(10);

// Concurrent floods starve each other's PTYs and the other tests' daemons.
static SERIAL: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

struct Sessions(Arc<Daemon>, Vec<u32>);

impl Drop for Sessions {
    fn drop(&mut self) {
        for id in &self.1 {
            self.0.kill(*id).ok();
        }
    }
}

fn spawn(daemon: &Arc<Daemon>, dir: &Path, cmd: Vec<String>) -> u32 {
    daemon
        .create_session(CreateParams {
            agent: proto::AgentKind::Custom,
            project_dir: dir.to_path_buf(),
            cmd: Some(cmd),
            cols: 400,
            rows: 100,
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
        .id
}

fn argv(parts: &[&str]) -> Vec<String> {
    parts.iter().map(|part| part.to_string()).collect()
}

#[cfg(unix)]
fn shell(script: &str) -> Vec<String> {
    argv(&["/bin/sh", "-c", script])
}

#[cfg(windows)]
fn shell(script: &str) -> Vec<String> {
    argv(&[
        "powershell",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        script,
    ])
}

#[cfg(unix)]
fn flood() -> Vec<String> {
    shell("yes \"$(printf '%0190d' 0)\"")
}

#[cfg(windows)]
fn flood() -> Vec<String> {
    // One console write per 64 KiB: a write per line is what limits a flood on Windows.
    shell(
        "$b = ((1..320) | ForEach-Object { \"$_ \" + ('0' * 190) }) -join \"`r`n\";          while ($true) { [Console]::Out.Write($b) }",
    )
}

#[cfg(unix)]
fn ticker() -> Vec<String> {
    shell("while :; do echo tick; sleep 0.05; done")
}

#[cfg(windows)]
fn ticker() -> Vec<String> {
    shell("while ($true) { 'tick'; Start-Sleep -Milliseconds 50 }")
}

#[cfg(unix)]
fn sleeper() -> Vec<String> {
    shell("sleep 60")
}

#[cfg(windows)]
fn sleeper() -> Vec<String> {
    shell("Start-Sleep 60")
}

/// Writes `ready` before reading a line from its terminal, then writes the line to `got`.
#[cfg(unix)]
fn line_reader(dir: &Path) -> Vec<String> {
    let (ready, got) = (dir.join("ready"), dir.join("got"));
    shell(&format!(
        "touch '{}'; read line; printf '%s' \"$line\" > '{}'; sleep 60",
        ready.display(),
        got.display()
    ))
}

#[cfg(windows)]
fn line_reader(dir: &Path) -> Vec<String> {
    let (ready, got) = (dir.join("ready"), dir.join("got"));
    shell(&format!(
        "Set-Content -LiteralPath '{}' -Value 1; $l = [Console]::In.ReadLine(); \
         Set-Content -LiteralPath '{}' -Value $l; Start-Sleep 60",
        ready.display(),
        got.display()
    ))
}

async fn wait_for_file(path: &Path, within: Duration) -> Option<Duration> {
    let started = Instant::now();
    while started.elapsed() < within {
        if path.exists() {
            return Some(started.elapsed());
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    None
}

/// A client with a small receive window that never reads unless the test asks it to, so the
/// daemon's writes stall as soon as the loopback buffers fill.
async fn connect_unread(addr: std::net::SocketAddr) -> RawWs {
    let socket = tokio::net::TcpSocket::new_v4().unwrap();
    socket.set_recv_buffer_size(4096).unwrap();
    let tcp = socket.connect(addr).await.unwrap();
    let (mut ws, _) = tokio_tungstenite::client_async(format!("ws://{addr}/ws"), tcp)
        .await
        .unwrap();
    let hello = serde_json::to_string(&proto::ClientMsg::Hello {
        token: TOKEN.to_string(),
        protocol: proto::PROTOCOL_VERSION,
    })
    .unwrap();
    ws.send(Message::text(hello)).await.unwrap();
    ws
}

fn attach_msg(session: u32) -> Message {
    Message::text(
        serde_json::to_string(&proto::ClientMsg::SessionAttach {
            session,
            replay_bytes: None,
            snapshot: Some(false),
            from_offset: None,
            generation: None,
        })
        .unwrap(),
    )
}

/// Counts `session`'s output until `bytes` more have been produced.
async fn await_output(observer: &mut Observer, session: u32, bytes: u64) -> Duration {
    let started = Instant::now();
    let mut produced = 0u64;
    while produced < bytes {
        assert!(
            started.elapsed() < Duration::from_secs(120),
            "flood session {session} produced {produced} of {bytes} bytes in 120 s"
        );
        match tokio::time::timeout(Duration::from_secs(5), observer.recv()).await {
            Ok(Ok(Outbound::Frame(buf))) => {
                if let Some((id, _, payload)) = proto::decode_output_frame(&buf) {
                    if id == session {
                        produced += payload.len() as u64;
                    }
                }
            }
            Ok(Err(tokio::sync::broadcast::error::RecvError::Lagged(dropped))) => {
                produced += dropped
            }
            Ok(Err(tokio::sync::broadcast::error::RecvError::Closed)) => {
                panic!("daemon broadcast closed while session {session} flooded")
            }
            Ok(Ok(_)) | Err(_) => {}
        }
    }
    started.elapsed()
}

/// Attaches a running flood on an unread socket and waits until it has produced
/// `BACKLOG_BYTES` since, so the daemon's writes to that socket are blocked.
async fn attach_and_backlog(daemon: &Daemon, ws: &mut RawWs, session: u32) {
    let mut observer = daemon.observe();
    // An unwatched session has the daemon answer its terminal's startup queries; once
    // this client (which never answers) watches it, an unanswered query stalls ConPTY.
    await_output(&mut observer, session, 64 * 1024).await;
    ws.send(attach_msg(session)).await.unwrap();
    let elapsed = await_output(&mut observer, session, BACKLOG_BYTES).await;
    eprintln!(
        "backlog: session {session} produced {BACKLOG_BYTES} bytes in {} ms while the client          read nothing",
        elapsed.as_millis()
    );
}

async fn wait_for_clients(daemon: &Daemon, expected: u32, within: Duration) {
    let started = Instant::now();
    while daemon.manage_status().clients_connected != expected {
        assert!(
            started.elapsed() < within,
            "{} clients still connected after {within:?}; expected {expected}",
            daemon.manage_status().clients_connected
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn stdin_reaches_the_pty_while_output_backpressures_the_socket() {
    let _serial = SERIAL.lock().await;
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
    let got = std::fs::read_to_string(project.path().join("got")).unwrap();
    assert_eq!(got.trim(), "through-backpressure");
}

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
            attach_msg(order[0]),
            stdin(a),
            create(base + 1),
            Message::text(r#"{"type":"session_list"}"#),
            attach_msg(order[1]),
            stdin(b),
            create(base + 2),
            stdin(c),
            attach_msg(order[2]),
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
