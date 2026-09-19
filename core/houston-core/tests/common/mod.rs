#![allow(clippy::disallowed_methods)]
#![allow(dead_code)]

use futures_util::{SinkExt, StreamExt};
use houston_core::daemon::{Daemon, DaemonConfig};
use houston_core::server;
use houston_protocol as proto;
use std::time::Duration;
use tokio_tungstenite::tungstenite::Message;

pub type WsStream =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

pub const TOKEN: &str = "test-token-0000-0000-000000000000";

pub fn hermetic_command(
    bin: impl AsRef<std::ffi::OsStr>,
    home: &std::path::Path,
) -> std::process::Command {
    let mut cmd = std::process::Command::new(bin);
    cmd.env_clear()
        .env("PATH", std::env::var("PATH").unwrap_or_default())
        .env("HOME", home)
        .env("USERPROFILE", home);
    #[cfg(windows)]
    for key in ["SystemRoot", "SystemDrive", "windir", "TEMP", "TMP"] {
        if let Ok(v) = std::env::var(key) {
            cmd.env(key, v);
        }
    }
    cmd
}

pub async fn start_daemon() -> (std::net::SocketAddr, tempfile::TempDir) {
    let (addr, dir, _daemon) = start_daemon_with_handle().await;
    (addr, dir)
}

pub async fn start_daemon_with_handle() -> (
    std::net::SocketAddr,
    tempfile::TempDir,
    std::sync::Arc<Daemon>,
) {
    let state_dir = tempfile::tempdir().unwrap();
    let daemon = Daemon::new(DaemonConfig {
        token: TOKEN.to_string(),
        db_path: state_dir.path().join("test.db"),
    })
    .unwrap();
    let (addr, _handle) = server::start(daemon.clone(), "127.0.0.1:0".parse().unwrap())
        .await
        .unwrap();
    daemon.set_port(addr.port());
    tokio::spawn({
        let daemon = daemon.clone();
        async move { daemon.swarm_mail_loop().await }
    });
    (addr, state_dir, daemon)
}

pub async fn start_daemon_without_mail_loop() -> (
    std::net::SocketAddr,
    tempfile::TempDir,
    std::sync::Arc<Daemon>,
) {
    let state_dir = tempfile::tempdir().unwrap();
    let daemon = Daemon::new(DaemonConfig {
        token: TOKEN.to_string(),
        db_path: state_dir.path().join("test.db"),
    })
    .unwrap();
    let (addr, _handle) = server::start(daemon.clone(), "127.0.0.1:0".parse().unwrap())
        .await
        .unwrap();
    daemon.set_port(addr.port());
    (addr, state_dir, daemon)
}

pub async fn connect_and_hello(addr: std::net::SocketAddr, token: &str) -> WsStream {
    let (mut ws, _) = tokio_tungstenite::connect_async(format!("ws://{addr}/ws"))
        .await
        .unwrap();
    let hello = serde_json::to_string(&proto::ClientMsg::Hello {
        token: token.to_string(),
        protocol: proto::PROTOCOL_VERSION,
    })
    .unwrap();
    ws.send(Message::text(hello)).await.unwrap();
    ws
}

pub async fn next_control(ws: &mut WsStream) -> proto::ServerMsg {
    loop {
        match tokio::time::timeout(Duration::from_secs(10), ws.next())
            .await
            .expect("timed out waiting for control message")
            .expect("socket closed")
            .expect("socket error")
        {
            Message::Text(t) => return serde_json::from_str(&t).unwrap(),
            _ => continue,
        }
    }
}

pub async fn collect_output_until(ws: &mut WsStream, session: u32, needle: &str) -> String {
    const BUDGET: Duration = Duration::from_secs(15);
    let mut acc = String::new();
    let deadline = tokio::time::Instant::now() + BUDGET;
    loop {
        let Some(remaining) = deadline.checked_duration_since(tokio::time::Instant::now()) else {
            panic!(
                "timed out after {BUDGET:?} waiting for {needle:?} in session {session}'s \
                 PTY output; collected {acc:?}"
            )
        };
        let frame = match tokio::time::timeout(remaining, ws.next()).await {
            Ok(frame) => frame,
            Err(_) => panic!(
                "timed out after {BUDGET:?} waiting for {needle:?} in session {session}'s \
                 PTY output; collected {acc:?}"
            ),
        };
        match frame.expect("socket closed").expect("socket error") {
            Message::Binary(buf) => {
                if let Some((id, _offset, payload)) = proto::decode_output_frame(&buf) {
                    if id == session {
                        acc.push_str(&String::from_utf8_lossy(payload));
                        if acc.contains(needle) {
                            return acc;
                        }
                    }
                }
            }
            _ => continue,
        }
    }
}

pub fn create_custom_msg(cmd: Vec<&str>, dir: &std::path::Path) -> String {
    serde_json::to_string(&proto::ClientMsg::SessionCreate {
        agent: proto::AgentKind::Custom,
        project_dir: dir.display().to_string(),
        cmd: Some(cmd.into_iter().map(String::from).collect()),
        cols: Some(80),
        rows: Some(24),
        cwd_from: None,
        shell_integration: None,
        auto_approve: None,
        acp: None,
        profile: None,
        prompt: None,
    })
    .unwrap()
}

pub async fn expect_created(ws: &mut WsStream) -> proto::SessionInfo {
    try_expect_created(ws)
        .await
        .unwrap_or_else(|message| panic!("daemon error: {message}"))
}

pub async fn try_expect_created(ws: &mut WsStream) -> Result<proto::SessionInfo, String> {
    loop {
        match next_control(ws).await {
            proto::ServerMsg::SessionCreated { info } => return Ok(info),
            proto::ServerMsg::Error { message, .. } => return Err(message),
            _ => continue,
        }
    }
}

pub async fn collect_broadcast_until(
    rx: &mut houston_core::frame_queue::Observer,
    session: u32,
    needle: &str,
) -> String {
    let mut acc = String::new();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
    loop {
        let remaining = deadline.checked_duration_since(tokio::time::Instant::now()).unwrap_or_else(|| {
            panic!("timed out waiting for {needle:?} on session {session} in broadcast output (accumulated {} bytes)", acc.len())
        });
        let out = match tokio::time::timeout(remaining, rx.recv()).await.unwrap_or_else(|_| {
            panic!("timed out waiting for {needle:?} on session {session} in broadcast output (accumulated {} bytes)", acc.len())
        }) {
            Ok(o) => o,
            Err(tokio::sync::broadcast::error::RecvError::Lagged(n)) => panic!(
                "broadcast receiver lagged by {n} messages while waiting for {needle:?} on \
                 session {session} -- the event under test may have been dropped, not merely delayed"
            ),
            Err(tokio::sync::broadcast::error::RecvError::Closed) => {
                panic!("daemon broadcast closed while waiting for {needle:?} on session {session}")
            }
        };
        if let houston_core::daemon::Outbound::Frame(buf) = out {
            if let Some((id, _offset, payload)) = proto::decode_output_frame(&buf) {
                if id == session {
                    acc.push_str(&String::from_utf8_lossy(payload));
                    if acc.contains(needle) {
                        return acc;
                    }
                }
            }
        }
    }
}

pub async fn next_broadcast_control(
    rx: &mut houston_core::frame_queue::Observer,
) -> proto::ServerMsg {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    loop {
        let remaining = deadline
            .checked_duration_since(tokio::time::Instant::now())
            .expect("timed out waiting for control broadcast");
        let out = match tokio::time::timeout(remaining, rx.recv())
            .await
            .expect("timed out waiting for control broadcast")
        {
            Ok(o) => o,
            Err(tokio::sync::broadcast::error::RecvError::Lagged(n)) => panic!(
                "broadcast receiver lagged by {n} messages while waiting for a control message \
                 -- the event under test may have been dropped, not merely delayed"
            ),
            Err(tokio::sync::broadcast::error::RecvError::Closed) => {
                panic!("daemon broadcast closed while waiting for a control message")
            }
        };
        if let houston_core::daemon::Outbound::Control(json) = out {
            return serde_json::from_str(&json).unwrap();
        }
    }
}

pub async fn wait_for_state(daemon: &Daemon, id: u32, state: proto::SessionState) {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
    loop {
        if daemon
            .list()
            .into_iter()
            .any(|s| s.id == id && s.state == state)
        {
            return;
        }
        if tokio::time::Instant::now() >= deadline {
            panic!("timed out waiting for session {id} to reach {state:?}");
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

pub async fn expect_state(ws: &mut WsStream, session: u32, state: proto::SessionState) {
    loop {
        match next_control(ws).await {
            proto::ServerMsg::SessionState {
                session: s,
                state: st,
                ..
            } if s == session => {
                if st == state {
                    return;
                }
            }
            proto::ServerMsg::Error { message, .. } => panic!("daemon error: {message}"),
            _ => continue,
        }
    }
}
