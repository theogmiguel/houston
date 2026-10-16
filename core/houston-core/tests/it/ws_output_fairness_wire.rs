//! A quiet pane's echo is not queued behind other panes' bulk output on the same `/ws`
//! connection: keystroke to echo frame, with flooding sessions attached alongside, while the
//! client reads fast, at a limited rate, and after a stall. One flood set per test process.
#![allow(clippy::disallowed_methods)]

use crate::common::*;
use crate::ws_input::{argv, attach_msg, spawn, RawWs, Sessions};
use futures_util::{SinkExt, StreamExt};
use houston_protocol as proto;
use std::collections::HashSet;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::{mpsc, watch};
use tokio_tungstenite::tungstenite::Message;

const FLOODS: usize = 6;
const PROBES: usize = 20;
const STALLS: usize = 6;
const STALL: Duration = Duration::from_secs(2);
// About what a renderer busy parsing six flooding panes drains; well below what the floods
// produce, so every flood keeps a full queue on the connection.
const LIMITED_RATE: u64 = 4 * 1024 * 1024;
const ECHO_TIMEOUT: Duration = Duration::from_secs(30);
// A whole-queue-per-session writer leaves up to FLOODS x 4 MiB (6 s here) ahead of an echo;
// one turn each (6 x 64 KiB) plus socket buffers measured p90 0.3-0.45 s on Windows. 2 s still
// absorbs a Linux runner's kernel send buffer (at most 4 MiB, 1 s) on top of that.
const LIMITED_P90_BOUND: Duration = Duration::from_secs(2);
// Fixed rather than autotuned, so bytes in flight are the same on every platform.
const CLIENT_RECV_BUFFER: u32 = 256 * 1024;

#[derive(Clone, Copy, PartialEq, Debug)]
enum Pace {
    Fast,
    Limited(u64),
    Stalled,
}

async fn connect(addr: std::net::SocketAddr) -> RawWs {
    let socket = tokio::net::TcpSocket::new_v4().unwrap();
    socket.set_recv_buffer_size(CLIENT_RECV_BUFFER).unwrap();
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

// About 3 MiB/s per session, near what a Windows flood manages: six unpaced floods saturate
// a CI runner, which then delays the echo for reasons other than the connection's queueing.
#[cfg(unix)]
fn flood() -> Vec<String> {
    crate::ws_input::shell(concat!(
        "b=$(yes \"$(printf '%0099d' 0)\" | head -n 640); ",
        "while :; do printf '%s\\n' \"$b\"; sleep 0.02; done",
    ))
}

#[cfg(windows)]
use crate::ws_input::flood;

#[cfg(unix)]
fn echoer() -> Vec<String> {
    argv(&["cat"])
}

// The console host echoes a cooked read as it is typed, as an interactive shell's prompt does.
#[cfg(windows)]
fn echoer() -> Vec<String> {
    argv(&["cmd", "/d", "/k"])
}

fn probe(n: u32) -> Vec<u8> {
    format!("rem Q{n:06}\r").into_bytes()
}

/// Reports each probe token the first time it appears in `session`'s output.
fn scan(buf: &mut Vec<u8>, seen: &mut HashSet<u32>, mut found: impl FnMut(u32)) {
    let mut i = 0;
    while i + 7 <= buf.len() {
        if buf[i] == b'Q' && buf[i + 1..i + 7].iter().all(u8::is_ascii_digit) {
            let n = std::str::from_utf8(&buf[i + 1..i + 7])
                .unwrap()
                .parse()
                .unwrap();
            if seen.insert(n) {
                found(n);
            }
            i += 7;
        } else {
            i += 1;
        }
    }
    buf.drain(..i);
}

struct Counters {
    bytes: AtomicU64,
    gaps: AtomicU64,
}

async fn read_paced(
    mut stream: futures_util::stream::SplitStream<RawWs>,
    quiet: u32,
    mut pace: watch::Receiver<Pace>,
    echoes: mpsc::UnboundedSender<(u32, Instant)>,
    counters: Arc<Counters>,
) {
    let mut tail = Vec::new();
    let mut seen = HashSet::new();
    let mut current = Pace::Fast;
    let mut window = (Instant::now(), 0u64);
    loop {
        while *pace.borrow_and_update() == Pace::Stalled {
            if pace.changed().await.is_err() {
                return;
            }
        }
        let Some(Ok(message)) = stream.next().await else {
            return;
        };
        let arrived = Instant::now();
        let len = message.len() as u64;
        counters.bytes.fetch_add(len, Ordering::Relaxed);
        if let Message::Binary(buf) = &message {
            if let Some((id, _, payload)) = proto::decode_output_frame(buf) {
                if id == quiet {
                    tail.extend_from_slice(payload);
                    scan(&mut tail, &mut seen, |n| {
                        let _ = echoes.send((n, arrived));
                    });
                }
            } else if proto::decode_gap_frame(buf).is_some() {
                counters.gaps.fetch_add(1, Ordering::Relaxed);
            }
        }
        let now = *pace.borrow_and_update();
        if now != current {
            current = now;
            window = (arrived, 0);
        }
        if let Pace::Limited(rate) = current {
            window.1 += len;
            let due = window.0 + Duration::from_secs_f64(window.1 as f64 / rate as f64);
            tokio::time::sleep_until(due.into()).await;
        }
    }
}

async fn wait_echo(
    echoes: &mut mpsc::UnboundedReceiver<(u32, Instant)>,
    n: u32,
    quiet: u32,
) -> Instant {
    let deadline = tokio::time::Instant::now() + ECHO_TIMEOUT;
    loop {
        match tokio::time::timeout_at(deadline, echoes.recv()).await {
            Ok(Some((got, at))) if got == n => return at,
            Ok(Some(_)) => {}
            Ok(None) => panic!("the client stopped reading before probe {n}'s echo"),
            Err(_) => panic!(
                "probe {n} to session {quiet} was not echoed to the client within {ECHO_TIMEOUT:?}"
            ),
        }
    }
}

type WsSink = futures_util::stream::SplitSink<RawWs, Message>;

async fn send_probe(sink: &mut WsSink, quiet: u32, next: &mut u32) -> (u32, Instant) {
    *next += 1;
    sink.send(Message::Binary(
        proto::encode_stdin_frame(quiet, &probe(*next)).into(),
    ))
    .await
    .unwrap();
    (*next, Instant::now())
}

struct Summary {
    p50: Duration,
    p90: Duration,
    max: Duration,
}

fn summarize(mut samples: Vec<Duration>) -> Summary {
    samples.sort();
    let at = |q: usize| samples[(samples.len() * q).div_ceil(100).max(1) - 1];
    Summary {
        p50: at(50),
        p90: at(90),
        max: *samples.last().unwrap(),
    }
}

fn report(phase: &str, samples: &[Duration], bytes: u64, gaps: u64, took: Duration) -> Summary {
    let s = summarize(samples.to_vec());
    eprintln!(
        "{phase}: echo p50 {} ms, p90 {} ms, max {} ms over {} probes; client read {:.1} MiB/s, \
         {gaps} gaps",
        s.p50.as_millis(),
        s.p90.as_millis(),
        s.max.as_millis(),
        samples.len(),
        bytes as f64 / took.as_secs_f64() / (1024.0 * 1024.0),
    );
    s
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_quiet_session_echoes_promptly_while_others_flood_the_same_connection() {
    // Windows throttles a busy windowless process 1–3 s after it starts; the daemon's sweep
    // opts every child out, so the floods keep their speed for the whole measurement.
    tokio::spawn(houston_core::power_throttling::sweep_loop());
    let (addr, _state, daemon) = start_daemon_with_handle().await;
    let project = tempfile::tempdir().unwrap();
    let quiet = spawn(&daemon, project.path(), echoer());
    let floods: Vec<u32> = (0..FLOODS)
        .map(|_| spawn(&daemon, project.path(), flood()))
        .collect();
    let _sessions = Sessions(
        daemon.clone(),
        std::iter::once(quiet)
            .chain(floods.iter().copied())
            .collect(),
    );

    let ws = connect(addr).await;
    let (mut sink, stream) = ws.split();
    let (pace_tx, pace) = watch::channel(Pace::Fast);
    let (echo_tx, mut echoes) = mpsc::unbounded_channel();
    let counters = Arc::new(Counters {
        bytes: AtomicU64::new(0),
        gaps: AtomicU64::new(0),
    });
    let reader = tokio::spawn(read_paced(
        stream,
        quiet,
        pace,
        echo_tx,
        Arc::clone(&counters),
    ));
    for id in std::iter::once(quiet).chain(floods.iter().copied()) {
        sink.send(attach_msg(id, Some(0))).await.unwrap();
    }

    let mut next = 0u32;
    // The first echo also waits for the shell to start.
    let (n, _) = send_probe(&mut sink, quiet, &mut next).await;
    wait_echo(&mut echoes, n, quiet).await;
    tokio::time::sleep(Duration::from_secs(1)).await;

    let phase = |pace: Pace| {
        pace_tx.send(pace).unwrap();
        (
            Instant::now(),
            counters.bytes.load(Ordering::Relaxed),
            counters.gaps.load(Ordering::Relaxed),
        )
    };
    let since = |counters: &Counters, (started, bytes, gaps): (Instant, u64, u64)| {
        (
            counters.bytes.load(Ordering::Relaxed) - bytes,
            counters.gaps.load(Ordering::Relaxed) - gaps,
            started.elapsed(),
        )
    };

    let started = phase(Pace::Fast);
    let mut fast = Vec::new();
    for _ in 0..PROBES {
        let (n, sent) = send_probe(&mut sink, quiet, &mut next).await;
        fast.push(wait_echo(&mut echoes, n, quiet).await - sent);
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    let (bytes, gaps, took) = since(&counters, started);
    report("fast reader", &fast, bytes, gaps, took);

    let started = phase(Pace::Limited(LIMITED_RATE));
    // Long enough for every flood's queue on this connection to fill.
    tokio::time::sleep(Duration::from_secs(3)).await;
    let mut limited = Vec::new();
    for _ in 0..PROBES {
        let (n, sent) = send_probe(&mut sink, quiet, &mut next).await;
        limited.push(wait_echo(&mut echoes, n, quiet).await - sent);
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    let (bytes, limited_gaps, took) = since(&counters, started);
    let limited = report(
        &format!("reader limited to {} MiB/s", LIMITED_RATE >> 20),
        &limited,
        bytes,
        limited_gaps,
        took,
    );

    let started = phase(Pace::Fast);
    tokio::time::sleep(Duration::from_secs(1)).await;
    let mut stalled = Vec::new();
    for _ in 0..STALLS {
        pace_tx.send(Pace::Stalled).unwrap();
        tokio::time::sleep(STALL / 2).await;
        let (n, _) = send_probe(&mut sink, quiet, &mut next).await;
        tokio::time::sleep(STALL / 2).await;
        let resumed = Instant::now();
        pace_tx.send(Pace::Fast).unwrap();
        stalled.push(wait_echo(&mut echoes, n, quiet).await - resumed);
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
    let (bytes, gaps, took) = since(&counters, started);
    report(
        &format!("after a {} s stall (echo after resume)", STALL.as_secs()),
        &stalled,
        bytes,
        gaps,
        took,
    );
    reader.abort();

    assert!(
        limited_gaps > 0,
        "no session's queue overflowed while the client read {} MiB/s, so nothing was \
         queued ahead of the echo; the floods must outrun the client for this test to measure",
        LIMITED_RATE >> 20
    );
    assert!(
        limited.p90 < LIMITED_P90_BOUND,
        "session {quiet}'s echo took p90 {} ms (bound {} ms) while {FLOODS} sessions flooded \
         the same connection and the client read {} MiB/s",
        limited.p90.as_millis(),
        LIMITED_P90_BOUND.as_millis(),
        LIMITED_RATE >> 20
    );
}
