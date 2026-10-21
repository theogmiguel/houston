//! Attach-family requests whose work is slow (a spawn) do not stop the connection loop: other
//! panes' frames and control replies keep flowing while it runs, and its reply still orders
//! against the frames and attach-family requests around it.
#![cfg(feature = "test-barriers")]
#![allow(clippy::disallowed_methods)]

use crate::common::*;
use crate::ws_input::{attach_msg, flood, sleeper, spawn, RawWs, Sessions};
use futures_util::{SinkExt, StreamExt};
use houston_protocol as proto;
use std::time::{Duration, Instant};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message;

// Stands in for a slow spawn (shell integration, hook placement, a cold ConPTY) through the
// startup test hook, which runs on the blocking spawn path after the PTY exists.
const SPAWN_DELAY: Duration = Duration::from_millis(2000);
const EVENT_TIMEOUT: Duration = Duration::from_secs(60);

enum Event {
    Frame(u32),
    Control(Box<proto::ServerMsg>),
}

async fn connect(addr: std::net::SocketAddr) -> RawWs {
    let tcp = tokio::net::TcpStream::connect(addr).await.unwrap();
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

fn read_events(
    mut stream: futures_util::stream::SplitStream<RawWs>,
) -> mpsc::UnboundedReceiver<(Instant, Event)> {
    let (tx, rx) = mpsc::unbounded_channel();
    tokio::spawn(async move {
        while let Some(Ok(message)) = stream.next().await {
            let at = Instant::now();
            let event = match &message {
                Message::Binary(buf) => match proto::decode_output_frame(buf) {
                    Some((id, _, _)) => Event::Frame(id),
                    None => continue,
                },
                Message::Text(text) => match serde_json::from_str(text) {
                    Ok(msg) => Event::Control(Box::new(msg)),
                    Err(_) => continue,
                },
                _ => continue,
            };
            if tx.send((at, event)).is_err() {
                return;
            }
        }
    });
    rx
}

fn control(msg: &proto::ClientMsg) -> Message {
    Message::text(serde_json::to_string(msg).unwrap())
}

fn create_msg(request: u32, dir: &std::path::Path) -> Message {
    control(&proto::ClientMsg::SessionCreate {
        request: Some(request),
        agent: proto::AgentKind::Custom,
        project_dir: dir.display().to_string(),
        cmd: Some(sleeper()),
        cols: Some(80),
        rows: Some(24),
        cwd_from: None,
        shell_integration: Some(false),
        auto_approve: None,
        acp: None,
        profile: None,
        prompt: None,
        model: None,
        effort: None,
    })
}

/// Longest interval without a frame for `session` between `from` and `to`, counting from the
/// last frame before `from`.
fn longest_gap(events: &[(Instant, u32)], session: u32, from: Instant, to: Instant) -> Duration {
    let mut last = events
        .iter()
        .filter(|(at, id)| *id == session && *at <= from)
        .map(|(at, _)| *at)
        .next_back()
        .unwrap_or(from);
    let mut longest = Duration::ZERO;
    for (at, _) in events
        .iter()
        .filter(|(at, id)| *id == session && *at > from && *at <= to)
    {
        longest = longest.max(*at - last);
        last = *at;
    }
    longest.max(to.saturating_duration_since(last))
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_slow_spawn_does_not_stall_other_panes_or_control_replies() {
    tokio::spawn(houston_core::power_throttling::sweep_loop());
    let (addr, _state, daemon) = start_daemon_with_handle().await;
    let project = tempfile::tempdir().unwrap();
    let flooding = spawn(&daemon, project.path(), flood());
    let mut sessions = Sessions(daemon.clone(), vec![flooding]);

    let (mut sink, stream) = connect(addr).await.split();
    let mut events = read_events(stream);
    sink.send(attach_msg(flooding, Some(0))).await.unwrap();

    let mut frames: Vec<(Instant, u32)> = Vec::new();
    let warm = Instant::now();
    while warm.elapsed() < Duration::from_secs(2) || frames.is_empty() {
        let (at, event) = tokio::time::timeout(EVENT_TIMEOUT, events.recv())
            .await
            .expect("the flooding session produced no frame")
            .unwrap();
        if let Event::Frame(id) = event {
            frames.push((at, id));
        }
    }

    daemon.set_startup_test(None, Box::new(|_, _| std::thread::sleep(SPAWN_DELAY)));
    let sent = Instant::now();
    sink.send(create_msg(1, project.path())).await.unwrap();
    // An attach-family request behind the spawn is answered after it, in request order.
    sink.send(attach_msg(flooding, Some(0))).await.unwrap();
    tokio::time::sleep(Duration::from_millis(200)).await;
    let probed = Instant::now();
    sink.send(control(&proto::ClientMsg::SessionList))
        .await
        .unwrap();

    let mut probe_rtt = None;
    let mut created = None;
    let mut replayed = None;
    let mut early_frames = 0usize;
    while created.is_none() || probe_rtt.is_none() || replayed.is_none() {
        let (at, event) = tokio::time::timeout(EVENT_TIMEOUT, events.recv())
            .await
            .expect("the create, attach or probe reply never arrived")
            .unwrap();
        match event {
            Event::Frame(id) => {
                if created.is_none() && id != flooding {
                    early_frames += 1;
                }
                frames.push((at, id));
            }
            Event::Control(msg) => match *msg {
                proto::ServerMsg::SessionList { .. } if probe_rtt.is_none() => {
                    probe_rtt = Some(at - probed);
                }
                proto::ServerMsg::SessionCreateResult {
                    request: 1,
                    info,
                    error,
                    ..
                } => {
                    let info = info.unwrap_or_else(|| panic!("create refused: {error:?}"));
                    sessions.1.push(info.id);
                    created = Some(at);
                }
                proto::ServerMsg::Scrollback { session, .. } if session == flooding => {
                    assert!(
                        created.is_some(),
                        "session {flooding}'s attach was answered before the create sent ahead \
                     of it"
                    );
                    replayed = Some(at);
                }
                _ => {}
            },
        }
    }
    daemon.set_startup_test(None, Box::new(|_, _| {}));
    let created = created.unwrap();
    let probe_rtt = probe_rtt.unwrap();
    let gap = longest_gap(&frames, flooding, sent, created);
    eprintln!(
        "spawn delay {} ms: create reply after {} ms; longest frame gap on the flooding session \
         {} ms; session_list round trip during the spawn {} ms",
        SPAWN_DELAY.as_millis(),
        (created - sent).as_millis(),
        gap.as_millis(),
        probe_rtt.as_millis(),
    );

    assert!(
        created - sent >= SPAWN_DELAY,
        "the create replied after {} ms, before the injected {} ms spawn delay; the hook did \
         not run",
        (created - sent).as_millis(),
        SPAWN_DELAY.as_millis()
    );
    assert_eq!(
        early_frames, 0,
        "the new session's frames arrived before its session_create_result"
    );
    assert!(
        gap < SPAWN_DELAY / 2,
        "session {flooding} sent no frame for {} ms while a {} ms spawn ran on the same \
         connection",
        gap.as_millis(),
        SPAWN_DELAY.as_millis()
    );
    assert!(
        probe_rtt < SPAWN_DELAY / 2,
        "session_list took {} ms while a {} ms spawn ran on the same connection",
        probe_rtt.as_millis(),
        SPAWN_DELAY.as_millis()
    );
}
