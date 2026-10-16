//! Fixtures for `/ws` tests that need a daemon blocked writing to a client that never reads.
#![allow(dead_code)]

use crate::common::TOKEN;
use futures_util::SinkExt;
use houston_core::daemon::{CreateParams, Daemon, Outbound};
use houston_protocol as proto;
use std::path::Path;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio_tungstenite::tungstenite::Message;

pub type RawWs = tokio_tungstenite::WebSocketStream<tokio::net::TcpStream>;

// A whole scrollback ring, replayed as one base64 message of about 5.3 MiB: far past a 4 KiB
// client window plus the daemon's socket buffers, so the attach's own send blocks.
pub const REPLAY_BYTES: u64 = 4 * 1024 * 1024;
// Output then waiting on the connection's queue. A writer that kept up drains it on every
// wake, so this much waiting means its send is blocked. It stays small because on Windows a
// session watched by a client that does not read produces output at only KiB/s.
pub const TAP_BACKLOG: usize = 32 * 1024;
pub const INPUT_BOUND: Duration = Duration::from_secs(10);

pub struct Sessions(pub Arc<Daemon>, pub Vec<u32>);

impl Drop for Sessions {
    fn drop(&mut self) {
        for id in &self.1 {
            if let Err(error) = self.0.kill(*id) {
                eprintln!("cleanup: killing session {id} failed: {error:#}");
            }
        }
    }
}

pub fn spawn(daemon: &Arc<Daemon>, dir: &Path, cmd: Vec<String>) -> u32 {
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

pub fn argv(parts: &[&str]) -> Vec<String> {
    parts.iter().map(|part| part.to_string()).collect()
}

#[cfg(unix)]
pub fn shell(script: &str) -> Vec<String> {
    argv(&["/bin/sh", "-c", script])
}

#[cfg(windows)]
pub fn shell(script: &str) -> Vec<String> {
    argv(&[
        "powershell",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        script,
    ])
}

#[cfg(unix)]
pub fn flood() -> Vec<String> {
    shell("yes \"$(printf '%0190d' 0)\"")
}

// One console write per 64 KiB: a write per line is what limits a flood on Windows.
#[cfg(windows)]
pub fn flood() -> Vec<String> {
    shell(concat!(
        "$b = ((1..320) | ForEach-Object { \"$_ \" + ('0' * 190) }) -join \"`r`n\"; ",
        "while ($true) { [Console]::Out.Write($b) }",
    ))
}

#[cfg(unix)]
pub fn ticker() -> Vec<String> {
    shell("while :; do echo tick; sleep 0.05; done")
}

#[cfg(windows)]
pub fn ticker() -> Vec<String> {
    shell("while ($true) { 'tick'; Start-Sleep -Milliseconds 50 }")
}

#[cfg(unix)]
pub fn sleeper() -> Vec<String> {
    shell("sleep 60")
}

#[cfg(windows)]
pub fn sleeper() -> Vec<String> {
    shell("Start-Sleep 60")
}

/// Writes `ready` before reading a line from its terminal, then writes the line to `got`.
#[cfg(unix)]
pub fn line_reader(dir: &Path) -> Vec<String> {
    let (ready, got) = (dir.join("ready"), dir.join("got"));
    shell(&format!(
        "touch '{}'; read line; printf '%s' \"$line\" > '{}'; sleep 60",
        ready.display(),
        got.display()
    ))
}

#[cfg(windows)]
pub fn line_reader(dir: &Path) -> Vec<String> {
    let (ready, got) = (dir.join("ready"), dir.join("got"));
    shell(&format!(
        "Set-Content -LiteralPath '{}' -Value 1; $l = [Console]::In.ReadLine(); \
         Set-Content -LiteralPath '{}' -Value $l; Start-Sleep 60",
        ready.display(),
        got.display()
    ))
}

pub async fn wait_for_file(path: &Path, within: Duration) -> Option<Duration> {
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
pub async fn connect_unread(addr: std::net::SocketAddr) -> RawWs {
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

pub fn attach_msg(session: u32, replay_bytes: Option<u64>) -> Message {
    Message::text(
        serde_json::to_string(&proto::ClientMsg::SessionAttach {
            session,
            replay_bytes,
            snapshot: Some(false),
            from_offset: None,
            generation: None,
        })
        .unwrap(),
    )
}

/// Waits until an unwatched flood has produced a whole scrollback ring.
pub async fn fill_scrollback(daemon: &Daemon, session: u32) {
    let mut observer = daemon.observe();
    let started = Instant::now();
    let mut produced = 0u64;
    while produced < REPLAY_BYTES {
        assert!(
            started.elapsed() < Duration::from_secs(120),
            "flood session {session} produced {produced} of {REPLAY_BYTES} bytes in 120 s"
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
            _ => {}
        }
    }
}

/// Attaches a session with a full scrollback on an unread socket with a whole-ring replay,
/// and waits until that connection's queue for it holds `TAP_BACKLOG`.
pub async fn attach_and_backlog(daemon: &Daemon, ws: &mut RawWs, session: u32) {
    ws.send(attach_msg(session, Some(REPLAY_BYTES)))
        .await
        .unwrap();
    let attached = Instant::now();
    loop {
        let queued = daemon
            .frame_taps()
            .taps_for_test(session)
            .iter()
            .filter_map(std::sync::Weak::upgrade)
            .map(|tap| tap.queued_bytes_for_test())
            .max();
        if queued.is_some_and(|bytes| bytes >= TAP_BACKLOG) {
            break;
        }
        assert!(
            attached.elapsed() < Duration::from_secs(120),
            "session {session}: connection queue holds {queued:?} bytes 120 s after attach; \
             expected {TAP_BACKLOG} once its writer blocks"
        );
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    eprintln!(
        "backlog: {TAP_BACKLOG} bytes queued for session {session} {} ms after attach; client \
         read nothing",
        attached.elapsed().as_millis()
    );
}

/// Waits until no client is connected and no connection still queues `session`'s output.
pub async fn wait_for_release(daemon: &Daemon, session: u32, within: Duration) {
    let started = Instant::now();
    loop {
        let clients = daemon.manage_status().clients_connected;
        let taps = daemon
            .frame_taps()
            .taps_for_test(session)
            .iter()
            .filter(|tap| tap.strong_count() > 0)
            .count();
        if clients == 0 && taps == 0 {
            return;
        }
        assert!(
            started.elapsed() < within,
            "{clients} clients connected and {taps} frame queues for session {session} after \
             {within:?}; expected both 0 once the connection ends"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}
