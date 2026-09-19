#![cfg(unix)]

mod common;

use common::*;
use futures_util::{SinkExt, StreamExt};
use houston_protocol as proto;
use std::time::Duration;
use tokio_tungstenite::tungstenite::Message;

const FLOOD_LINES: u64 = 2_000_000;
const FLOOD_LINE_LEN: u64 = 11;
const FLOOD_BYTES: u64 = FLOOD_LINES * FLOOD_LINE_LEN;

const _: () = assert!(FLOOD_BYTES > 16 * 1024 * 1024);

const FLOOD_DEADLINE: Duration = Duration::from_secs(60);

const QUIET: Duration = Duration::from_millis(500);

static FLOOD_GATE: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

fn oracle(offset: u64, len: usize, line_len: u64, format: fn(u64) -> String) -> Vec<u8> {
    let mut out = Vec::with_capacity(len);
    let mut pos = offset;
    while out.len() < len {
        let line = format(pos / line_len);
        let col = (pos % line_len) as usize;
        let take = (line.len() - col).min(len - out.len());
        out.extend_from_slice(&line.as_bytes()[col..col + take]);
        pos += take as u64;
    }
    out
}

fn flood_line(i: u64) -> String {
    format!("{i:09}\r\n")
}

fn flood_oracle(offset: u64, len: usize) -> Vec<u8> {
    oracle(offset, len, FLOOD_LINE_LEN, flood_line)
}

fn flood_cmd() -> Vec<String> {
    vec![
        "sh".into(),
        "-c".into(),
        format!(
            "sleep 0.3; awk 'BEGIN {{ for (i = 0; i < {FLOOD_LINES}; i++) printf \"%09d\\n\", i }}' | cat; sleep 600"
        ),
    ]
}

const SLOW_LINE_LEN: u64 = 8;

fn slow_line(i: u64) -> String {
    format!("L{i:05}\r\n")
}

fn slow_oracle(offset: u64, len: usize) -> Vec<u8> {
    oracle(offset, len, SLOW_LINE_LEN, slow_line)
}

fn slow_cmd() -> Vec<&'static str> {
    vec![
        "sh",
        "-c",
        "i=0; while :; do printf 'L%05d\\n' \"$i\"; i=$((i+1)); sleep 0.02; done",
    ]
}

#[allow(clippy::large_enum_variant)]
#[derive(Debug)]
enum Event {
    Frame { offset: u64, payload: Vec<u8> },
    Gap { anchor: u64, dropped: u64 },
    Control(proto::ServerMsg),
}

async fn next_event(ws: &mut WsStream, session: u32, timeout: Duration) -> Option<Event> {
    let deadline = tokio::time::Instant::now() + timeout;
    loop {
        let remaining = deadline.checked_duration_since(tokio::time::Instant::now())?;
        let msg = tokio::time::timeout(remaining, ws.next())
            .await
            .ok()?
            .expect("socket closed")
            .expect("socket error");
        match msg {
            Message::Binary(buf) => {
                if let Some((id, offset, payload)) = proto::decode_output_frame(&buf) {
                    if id == session {
                        return Some(Event::Frame {
                            offset,
                            payload: payload.to_vec(),
                        });
                    }
                } else if let Some((id, anchor, dropped)) = proto::decode_gap_frame(&buf) {
                    if id == session {
                        return Some(Event::Gap { anchor, dropped });
                    }
                } else {
                    panic!("unrecognised binary frame of {} bytes", buf.len());
                }
            }
            Message::Text(t) => return Some(Event::Control(serde_json::from_str(&t).unwrap())),
            _ => continue,
        }
    }
}

struct Replay {
    data: Vec<u8>,
    replayed_bytes: u64,
    bytes_seen: u64,
    attempt: u32,
}

async fn read_until_scrollback(ws: &mut WsStream, session: u32) -> (Vec<(u64, Vec<u8>)>, Replay) {
    let mut before = Vec::new();
    loop {
        match next_event(ws, session, Duration::from_secs(15))
            .await
            .expect("timed out waiting for the scrollback reply")
        {
            Event::Frame { offset, payload } => before.push((offset, payload)),
            Event::Gap { anchor, dropped } => {
                panic!("unexpected gap (anchor {anchor}, dropped {dropped}) before the scrollback reply")
            }
            Event::Control(proto::ServerMsg::Scrollback {
                session: s,
                data,
                replayed_bytes,
                bytes_seen,
                attempt,
                ..
            }) if s == session => {
                return (
                    before,
                    Replay {
                        data: base64_decode(&data),
                        replayed_bytes,
                        bytes_seen,
                        attempt,
                    },
                )
            }
            Event::Control(_) => continue,
        }
    }
}

fn base64_decode(s: &str) -> Vec<u8> {
    use base64::Engine as _;
    base64::engine::general_purpose::STANDARD.decode(s).unwrap()
}

fn attach_msg(session: u32, replay_bytes: Option<u64>) -> Message {
    Message::text(
        serde_json::to_string(&proto::ClientMsg::SessionAttach {
            session,
            replay_bytes,
            snapshot: None,
        })
        .unwrap(),
    )
}

fn visibility_msg(session: u32, visible: bool) -> Message {
    Message::text(
        serde_json::to_string(&proto::ClientMsg::SessionVisibility { session, visible }).unwrap(),
    )
}

async fn read_contiguous(
    ws: &mut WsStream,
    session: u32,
    from: u64,
    until: u64,
    oracle: fn(u64, usize) -> Vec<u8>,
    deadline: Duration,
) -> u64 {
    let started = tokio::time::Instant::now();
    let mut next = from;
    let mut first = true;
    let mut frames = 0u64;
    while next < until {
        let remaining = deadline
            .checked_sub(started.elapsed())
            .unwrap_or_else(|| panic!("timed out at offset {next} of {until}"));
        match next_event(ws, session, remaining)
            .await
            .unwrap_or_else(|| panic!("timed out at offset {next} of {until}"))
        {
            Event::Frame { offset, payload } => {
                let end = offset + payload.len() as u64;
                if first {
                    assert!(
                        offset <= next && end > next,
                        "first frame after the reply must straddle or start at {next}: got [{offset}, {end})"
                    );
                    first = false;
                } else {
                    assert_eq!(offset, next, "frames must be contiguous");
                }
                assert_eq!(
                    payload,
                    oracle(offset, payload.len()),
                    "content mismatch at offset {offset}"
                );
                next = end;
                frames += 1;
            }
            Event::Gap { anchor, dropped } => {
                panic!("unexpected gap at offset {next}: anchor {anchor}, dropped {dropped}")
            }
            Event::Control(proto::ServerMsg::Scrollback { attempt, .. }) => {
                panic!("a second scrollback reply (attempt {attempt}) arrived during live output")
            }
            Event::Control(_) => continue,
        }
    }
    assert_eq!(next, until, "no overrun past the expected end");
    frames
}

async fn expect_quiet(ws: &mut WsStream, session: u32, what: &str) {
    let deadline = tokio::time::Instant::now() + QUIET;
    while let Some(remaining) = deadline.checked_duration_since(tokio::time::Instant::now()) {
        match next_event(ws, session, remaining).await {
            None => return,
            Some(Event::Control(proto::ServerMsg::Scrollback { attempt, .. })) => {
                panic!("{what}: an extra scrollback reply (attempt {attempt}) arrived")
            }
            Some(Event::Control(_)) => continue,
            Some(other) => panic!("{what}: expected silence, got {other:?}"),
        }
    }
}

struct Flood {
    _gate: tokio::sync::MutexGuard<'static, ()>,
    _state: tempfile::TempDir,
    _project: tempfile::TempDir,
    stalled: WsStream,
    stalled_seen_from: u64,
    healthy_seen_from: u64,
    id: u32,
}

async fn flood_with_a_stalled_and_a_healthy_client() -> Flood {
    let gate = FLOOD_GATE.lock().await;
    let (addr, state) = start_daemon().await;
    let project = tempfile::tempdir().unwrap();

    let mut stalled = connect_and_hello(addr, TOKEN).await;
    let _ = next_control(&mut stalled).await;
    stalled
        .send(Message::text(create_custom_msg(
            flood_cmd().iter().map(String::as_str).collect(),
            project.path(),
        )))
        .await
        .unwrap();
    let id = expect_created(&mut stalled).await.id;
    stalled.send(attach_msg(id, None)).await.unwrap();
    let (_, stalled_mount) = read_until_scrollback(&mut stalled, id).await;
    let stalled_seen_from = stalled_mount.bytes_seen;

    let mut healthy = connect_and_hello(addr, TOKEN).await;
    let _ = next_control(&mut healthy).await;
    healthy.send(attach_msg(id, None)).await.unwrap();
    let (_, replay) = read_until_scrollback(&mut healthy, id).await;
    assert_eq!(replay.attempt, 1);
    assert_eq!(
        replay.data,
        flood_oracle(0, replay.bytes_seen as usize),
        "the healthy client's replay is the stream so far"
    );

    let started = tokio::time::Instant::now();
    let frames = read_contiguous(
        &mut healthy,
        id,
        replay.bytes_seen,
        FLOOD_BYTES,
        flood_oracle,
        FLOOD_DEADLINE,
    )
    .await;
    eprintln!(
        "healthy client saw all {FLOOD_BYTES} bytes in {frames} frames ({} bytes/frame) in {:?} \
         while its neighbour never read",
        (FLOOD_BYTES - replay.bytes_seen) / frames.max(1),
        started.elapsed()
    );

    Flood {
        _gate: gate,
        _state: state,
        _project: project,
        stalled,
        stalled_seen_from,
        healthy_seen_from: replay.bytes_seen,
        id,
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_stalled_client_does_not_slow_a_healthy_one_on_the_same_session() {
    let flood = flood_with_a_stalled_and_a_healthy_client().await;
    assert!(
        flood.healthy_seen_from < FLOOD_BYTES,
        "the healthy client attached during the flood's opening pause"
    );
}

async fn read_stalled_until_gap(ws: &mut WsStream, id: u32, from: u64) -> u64 {
    let mut next = from;
    let mut first_anchor = None;
    while next < FLOOD_BYTES {
        match next_event(ws, id, Duration::from_secs(30))
            .await
            .expect("timed out reading the stalled client's backlog")
        {
            Event::Frame { offset, payload } => {
                assert_eq!(
                    offset, next,
                    "frames are contiguous with whatever precedes them"
                );
                assert_eq!(payload, flood_oracle(offset, payload.len()));
                next = offset + payload.len() as u64;
            }
            Event::Gap { anchor, dropped } => {
                assert_eq!(
                    anchor, next,
                    "the gap is anchored exactly where the last delivery ended"
                );
                assert!(dropped > 0, "a gap always reports what it lost");
                first_anchor.get_or_insert(anchor);
                next = anchor + dropped;
            }
            Event::Control(_) => continue,
        }
    }
    assert_eq!(next, FLOOD_BYTES, "no overrun past the end of the flood");
    first_anchor.expect("the stalled connection must have dropped at least once")
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_connection_that_falls_behind_gets_one_gap_frame_anchored_where_loss_began() {
    let mut flood = flood_with_a_stalled_and_a_healthy_client().await;
    let from = flood.stalled_seen_from;
    let anchor = read_stalled_until_gap(&mut flood.stalled, flood.id, from).await;
    assert!(
        anchor < FLOOD_BYTES,
        "the stalled connection must actually have dropped: anchor {anchor} of {FLOOD_BYTES}"
    );
    expect_quiet(&mut flood.stalled, flood.id, "after the gap").await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn gap_recovery_is_one_attach_with_replay_ordered_before_live_bytes() {
    let mut flood = flood_with_a_stalled_and_a_healthy_client().await;
    let id = flood.id;
    let from = flood.stalled_seen_from;
    let ws = &mut flood.stalled;
    read_stalled_until_gap(ws, id, from).await;

    let replay_cap = 1024 * 1024;
    ws.send(attach_msg(id, Some(replay_cap))).await.unwrap();
    let (before, replay) = read_until_scrollback(ws, id).await;
    assert!(
        before.is_empty(),
        "nothing was queued between the gap and the attach: {} stray frames",
        before.len()
    );
    assert_eq!(
        replay.attempt, 2,
        "second attach on this socket -- the first was the pre-flood confirmation"
    );
    assert_eq!(replay.bytes_seen, FLOOD_BYTES);
    assert!(replay.replayed_bytes <= replay_cap);
    let prefix = b"\x1b[0m";
    assert_eq!(&replay.data[..prefix.len()], prefix);
    assert_eq!(
        &replay.data[prefix.len()..],
        flood_oracle(
            FLOOD_BYTES - replay.replayed_bytes,
            replay.replayed_bytes as usize
        ),
        "the replay is the tail of the stream up to bytes_seen"
    );

    expect_quiet(ws, id, "after the recovery reply").await;

    ws.send(Message::Binary(
        proto::encode_stdin_frame(id, b"ping\n").into(),
    ))
    .await
    .unwrap();
    let echo = b"ping\r\n";
    let mut got = Vec::new();
    let mut next = FLOOD_BYTES;
    while got.len() < echo.len() {
        match next_event(ws, id, Duration::from_secs(10))
            .await
            .expect("timed out waiting for the echo")
        {
            Event::Frame { offset, payload } => {
                assert_eq!(offset, next, "live frames continue where the replay ended");
                next += payload.len() as u64;
                got.extend_from_slice(&payload);
            }
            Event::Gap { anchor, dropped } => {
                panic!("a gap after recovery: anchor {anchor}, dropped {dropped}")
            }
            Event::Control(proto::ServerMsg::Scrollback { attempt, .. }) => {
                panic!(
                    "a second scrollback reply (attempt {attempt}) — recovery must be one attach"
                )
            }
            Event::Control(_) => continue,
        }
    }
    assert_eq!(got, echo);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_initial_mount_is_one_numbered_reply_with_live_bytes_continuing_from_it() {
    let (addr, _state) = start_daemon().await;
    let project = tempfile::tempdir().unwrap();

    let mut producer = connect_and_hello(addr, TOKEN).await;
    let _ = next_control(&mut producer).await;
    producer
        .send(Message::text(create_custom_msg(slow_cmd(), project.path())))
        .await
        .unwrap();
    let id = expect_created(&mut producer).await.id;
    tokio::time::sleep(Duration::from_millis(200)).await;

    let mut pane = connect_and_hello(addr, TOKEN).await;
    let _ = next_control(&mut pane).await;
    pane.send(attach_msg(id, None)).await.unwrap();
    let (before, replay) = read_until_scrollback(&mut pane, id).await;
    assert!(
        before.is_empty(),
        "no frame precedes the first attach's reply"
    );
    assert_eq!(replay.attempt, 1);
    assert!(replay.bytes_seen > 0, "the printer had started");
    assert_eq!(replay.replayed_bytes, replay.bytes_seen);
    assert_eq!(replay.data, slow_oracle(0, replay.bytes_seen as usize));

    read_contiguous(
        &mut pane,
        id,
        replay.bytes_seen,
        replay.bytes_seen + 10 * SLOW_LINE_LEN,
        slow_oracle,
        Duration::from_secs(10),
    )
    .await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn hidden_then_shown_is_one_attach_with_nothing_obsolete_after_the_reply() {
    let (addr, _state) = start_daemon().await;
    let project = tempfile::tempdir().unwrap();

    let mut pane = connect_and_hello(addr, TOKEN).await;
    let _ = next_control(&mut pane).await;
    pane.send(Message::text(create_custom_msg(slow_cmd(), project.path())))
        .await
        .unwrap();
    let id = expect_created(&mut pane).await.id;

    pane.send(attach_msg(id, None)).await.unwrap();
    let (_, mount) = read_until_scrollback(&mut pane, id).await;
    assert_eq!(mount.attempt, 1);
    let shown_until = mount.bytes_seen + 3 * SLOW_LINE_LEN;
    read_contiguous(
        &mut pane,
        id,
        mount.bytes_seen,
        shown_until,
        slow_oracle,
        Duration::from_secs(10),
    )
    .await;

    pane.send(visibility_msg(id, false)).await.unwrap();
    let _ = next_event(&mut pane, id, Duration::from_millis(100)).await;
    expect_quiet(&mut pane, id, "while hidden").await;

    pane.send(visibility_msg(id, true)).await.unwrap();
    pane.send(attach_msg(id, None)).await.unwrap();
    let (before, shown) = read_until_scrollback(&mut pane, id).await;
    assert_eq!(shown.attempt, 2, "the second attach on this socket");
    assert!(
        shown.bytes_seen > shown_until,
        "output kept flowing while hidden: {} > {shown_until}",
        shown.bytes_seen
    );
    for (offset, payload) in &before {
        assert!(
            offset + payload.len() as u64 <= shown.bytes_seen,
            "a frame written before the reply is covered by the replay"
        );
    }
    assert_eq!(shown.data, slow_oracle(0, shown.bytes_seen as usize));

    read_contiguous(
        &mut pane,
        id,
        shown.bytes_seen,
        shown.bytes_seen + 5 * SLOW_LINE_LEN,
        slow_oracle,
        Duration::from_secs(10),
    )
    .await;
}
