use futures_util::{SinkExt, StreamExt};
use houston_core::daemon::{Daemon, DaemonConfig};
use houston_core::server;
use houston_protocol as proto;
use std::time::{Duration, Instant};
use tokio_tungstenite::tungstenite::Message;

const TOKEN: &str = "perf-token-0000-0000-000000000000";
const FLOOD_MIB: usize = 64;
const MIN_MIB_PER_SEC: f64 = 5.0;

const RSS_BUDGET_MIB: f64 = 50.0;
const RSS_REGRESSION_CEILING_MIB: f64 = 150.0;
const RSS_FLOOD_MIB: usize = 8;
const RSS_SESSIONS: usize = 10;

fn vmrss_kib() -> Option<u64> {
    std::fs::read_to_string("/proc/self/status")
        .ok()?
        .lines()
        .find_map(|line| {
            line.strip_prefix("VmRSS:")?
                .split_whitespace()
                .next()?
                .parse::<u64>()
                .ok()
        })
}

#[tokio::test]
#[ignore = "perf smoke — run explicitly (CI runs it in release)"]
async fn flood_throughput_floor() {
    let state_dir = tempfile::tempdir().unwrap();
    let daemon = Daemon::new(DaemonConfig {
        token: TOKEN.to_string(),
        db_path: state_dir.path().join("perf.db"),
    })
    .unwrap();
    let (addr, _handle) = server::start(daemon, "127.0.0.1:0".parse().unwrap())
        .await
        .unwrap();

    let (mut ws, _) = tokio_tungstenite::connect_async(format!("ws://{addr}/ws"))
        .await
        .unwrap();
    let hello = serde_json::to_string(&proto::ClientMsg::Hello {
        token: TOKEN.into(),
        protocol: proto::PROTOCOL_VERSION,
    })
    .unwrap();
    ws.send(Message::text(hello)).await.unwrap();

    let flood_bin = env!("CARGO_BIN_EXE_ansi_flood");
    let tmp = tempfile::tempdir().unwrap();
    let create = serde_json::to_string(&proto::ClientMsg::SessionCreate {
        agent: proto::AgentKind::Custom,
        project_dir: tmp.path().display().to_string(),
        cmd: Some(vec![flood_bin.to_string(), FLOOD_MIB.to_string()]),
        cols: Some(200),
        rows: Some(50),
        cwd_from: None,
        shell_integration: None,
        auto_approve: None,
        acp: None,
        profile: None,
        prompt: None,
    })
    .unwrap();
    ws.send(Message::text(create)).await.unwrap();

    let mut session_id = None;
    let mut received = 0usize;
    let mut started: Option<Instant> = None;
    let mut exited = false;

    let deadline = Instant::now() + Duration::from_secs(120);
    while Instant::now() < deadline {
        let msg = match tokio::time::timeout(Duration::from_secs(30), ws.next()).await {
            Ok(Some(Ok(m))) => m,
            Ok(_) => break,
            Err(_) => panic!("stalled: no messages for 30s ({received} bytes so far)"),
        };
        match msg {
            Message::Binary(buf) => {
                if let Some((_, _, payload)) = proto::decode_output_frame(&buf) {
                    started.get_or_insert_with(Instant::now);
                    received += payload.len();
                }
            }
            Message::Text(t) => match serde_json::from_str::<proto::ServerMsg>(&t).unwrap() {
                proto::ServerMsg::SessionCreated { info } => session_id = Some(info.id),
                proto::ServerMsg::SessionState { state, .. } if !state.is_live() => {
                    exited = true;
                    break;
                }
                proto::ServerMsg::Error { message, .. } => panic!("daemon error: {message}"),
                _ => {}
            },
            _ => {}
        }
    }

    assert!(session_id.is_some(), "session was never created");
    assert!(exited, "flood session did not finish within the deadline");
    let elapsed = started.expect("no output received").elapsed();
    let mib = received as f64 / (1024.0 * 1024.0);
    let rate = mib / elapsed.as_secs_f64();
    println!(
        "perf_smoke: {mib:.1} MiB in {:.2}s → {rate:.1} MiB/s (floor {MIN_MIB_PER_SEC})",
        elapsed.as_secs_f64()
    );

    assert!(
        mib >= (FLOOD_MIB as f64) * 0.9,
        "received only {mib:.1} MiB of ~{FLOOD_MIB} MiB flood"
    );
    assert!(
        rate >= MIN_MIB_PER_SEC,
        "throughput {rate:.1} MiB/s below floor {MIN_MIB_PER_SEC} MiB/s"
    );
}

#[tokio::test]
#[ignore = "perf smoke — run explicitly (CI runs it in release)"]
async fn daemon_rss_at_ten_sessions() {
    let state_dir = tempfile::tempdir().unwrap();
    let daemon = Daemon::new(DaemonConfig {
        token: TOKEN.to_string(),
        db_path: state_dir.path().join("perf.db"),
    })
    .unwrap();
    let (addr, _handle) = server::start(daemon, "127.0.0.1:0".parse().unwrap())
        .await
        .unwrap();

    let (mut ws, _) = tokio_tungstenite::connect_async(format!("ws://{addr}/ws"))
        .await
        .unwrap();
    let hello = serde_json::to_string(&proto::ClientMsg::Hello {
        token: TOKEN.into(),
        protocol: proto::PROTOCOL_VERSION,
    })
    .unwrap();
    ws.send(Message::text(hello)).await.unwrap();

    let rss_start_kib = vmrss_kib().expect("VmRSS must be readable on Linux");

    const FLOOD_START_DELAY_SECS: u32 = 2;
    let flood_bin = env!("CARGO_BIN_EXE_ansi_flood");
    let tmp = tempfile::tempdir().unwrap();
    for _ in 0..RSS_SESSIONS {
        let create = serde_json::to_string(&proto::ClientMsg::SessionCreate {
            agent: proto::AgentKind::Custom,
            project_dir: tmp.path().display().to_string(),
            cmd: Some(vec![
                "sh".to_string(),
                "-c".to_string(),
                format!("sleep {FLOOD_START_DELAY_SECS}; exec {flood_bin} {RSS_FLOOD_MIB}"),
            ]),
            cols: Some(200),
            rows: Some(50),
            cwd_from: None,
            shell_integration: None,
            auto_approve: None,
            acp: None,
            profile: None,
            prompt: None,
        })
        .unwrap();
        ws.send(Message::text(create)).await.unwrap();
    }

    let mut flood_ids = std::collections::HashSet::new();
    let ack_deadline = Instant::now() + Duration::from_secs(u64::from(FLOOD_START_DELAY_SECS));
    while flood_ids.len() < RSS_SESSIONS && Instant::now() < ack_deadline {
        let msg = match tokio::time::timeout(Duration::from_millis(500), ws.next()).await {
            Ok(Some(Ok(m))) => m,
            Ok(_) => break,
            Err(_) => continue,
        };
        if let Message::Text(t) = msg {
            match serde_json::from_str::<proto::ServerMsg>(&t).unwrap() {
                proto::ServerMsg::SessionCreated { info } => {
                    flood_ids.insert(info.id);
                }
                proto::ServerMsg::Error { message, .. } => panic!("daemon error: {message}"),
                _ => {}
            }
        }
    }
    assert_eq!(
        flood_ids.len(),
        RSS_SESSIONS,
        "only {} of {RSS_SESSIONS} SessionCreated ACKs arrived in the pre-flood quiet window",
        flood_ids.len()
    );

    let mut exited = 0usize;
    let mut received = 0usize;
    let mut peak_kib = rss_start_kib;
    let mut last_sample = Instant::now();

    let deadline = Instant::now() + Duration::from_secs(120);
    while Instant::now() < deadline && exited < RSS_SESSIONS {
        let msg = match tokio::time::timeout(Duration::from_secs(3), ws.next()).await {
            Ok(Some(Ok(m))) => m,
            Ok(_) => break,
            Err(_) => break,
        };
        if last_sample.elapsed() >= Duration::from_millis(50) {
            last_sample = Instant::now();
            if let Some(kib) = vmrss_kib() {
                peak_kib = peak_kib.max(kib);
            }
        }
        match msg {
            Message::Binary(buf) => {
                if let Some((_, _, payload)) = proto::decode_output_frame(&buf) {
                    received += payload.len();
                }
            }
            Message::Text(t) => match serde_json::from_str::<proto::ServerMsg>(&t).unwrap() {
                proto::ServerMsg::SessionState { session, state, .. }
                    if !state.is_live() && flood_ids.contains(&session) =>
                {
                    exited += 1
                }
                proto::ServerMsg::Error { message, .. } => panic!("daemon error: {message}"),
                _ => {}
            },
            _ => {}
        }
    }

    ws.send(Message::text(
        serde_json::to_string(&proto::ClientMsg::SessionList).unwrap(),
    ))
    .await
    .unwrap();
    let list_deadline = Instant::now() + Duration::from_secs(10);
    let mut finished = 0usize;
    'list: while Instant::now() < list_deadline {
        let msg = match tokio::time::timeout(Duration::from_secs(10), ws.next()).await {
            Ok(Some(Ok(m))) => m,
            _ => break,
        };
        if let Message::Text(t) = msg {
            if let proto::ServerMsg::SessionList { sessions } =
                serde_json::from_str::<proto::ServerMsg>(&t).unwrap()
            {
                finished = sessions
                    .iter()
                    .filter(|s| flood_ids.contains(&s.id) && !s.state.is_live())
                    .count();
                break 'list;
            }
        }
    }

    let rss_end_kib = vmrss_kib().expect("VmRSS must be readable on Linux");
    let peak_mib = peak_kib as f64 / 1024.0;
    println!(
        "perf_smoke rss: {finished}/{RSS_SESSIONS} floods finished ({exited} exits seen live), \
         {:.1} MiB reached this client; RSS start {:.1} MiB → peak {peak_mib:.1} MiB → end \
         {:.1} MiB (budget {RSS_BUDGET_MIB} MiB)",
        received as f64 / (1024.0 * 1024.0),
        rss_start_kib as f64 / 1024.0,
        rss_end_kib as f64 / 1024.0,
    );

    assert_eq!(
        finished, RSS_SESSIONS,
        "only {finished} of {RSS_SESSIONS} flood sessions had finished at SessionList time"
    );
    assert!(
        peak_mib < RSS_REGRESSION_CEILING_MIB,
        "peak RSS {peak_mib:.1} MiB exceeds the {RSS_REGRESSION_CEILING_MIB} MiB regression \
         ceiling at {RSS_SESSIONS} sessions (baseline peak 99.9-111.1 MiB, 2026-08-20; the §9 \
         {RSS_BUDGET_MIB} MB budget is separately recorded as failed — see the constant's doc)"
    );
}
