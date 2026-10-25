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
    let daemon = Daemon::new(DaemonConfig::new(
        TOKEN.to_string(),
        state_dir.path().join("perf.db"),
        crate::common::capture_env(),
    ))
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
        request: None,
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
        model: None,
        effort: None,
        view: None,
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
    let daemon = Daemon::new(DaemonConfig::new(
        TOKEN.to_string(),
        state_dir.path().join("perf.db"),
        crate::common::capture_env(),
    ))
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
            request: None,
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
            model: None,
            effort: None,
            view: None,
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

#[cfg(target_os = "linux")]
mod thread_load {
    use crate::common::{self, WsStream};
    use futures_util::{SinkExt, StreamExt};
    use houston_protocol as proto;
    use proto::{ThreadEventKind, TurnOutcome};
    use serde_json::{json, Value};
    use std::time::{Duration, Instant};
    use tokio_tungstenite::tungstenite::Message;

    pub const THREADS: usize = 4;
    pub const PAIRS: usize = 3;
    const ECHO_SAMPLES: usize = 200;
    /// Deltas per flood turn: enough that coalescing, not the fake, sets the message rate.
    const FLOOD_DELTAS: usize = 20_000;
    pub const IDLE_HISTORY_EVENTS: usize = 200;
    pub const IDLE_WINDOW: Duration = Duration::from_secs(10);
    const FIXTURES: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/threads");

    #[derive(Clone, Copy, PartialEq)]
    enum Mode {
        Idle,
        Fill,
        Stream,
    }

    struct Thread {
        session: u32,
        in_turn: bool,
        turns: usize,
        last_seq: u64,
        stored: Vec<u64>,
    }

    struct Flood {
        session: u32,
        bytes: usize,
        started: Option<Instant>,
        exited: Option<Instant>,
    }

    /// One client that creates, and so is attached to, every session.
    pub struct Rig {
        ws: WsStream,
        _daemon: std::sync::Arc<houston_core::daemon::Daemon>,
        _state: tempfile::TempDir,
        _shim: tempfile::TempDir,
        project: tempfile::TempDir,
        mode: Mode,
        threads: Vec<Thread>,
        flood: Option<Flood>,
        echo: u32,
        echoed: Vec<u8>,
        next_request: u32,
        created: Option<(u32, Result<u32, String>)>,
        history: Option<(u32, Vec<proto::ThreadEvent>, bool)>,
    }

    impl Rig {
        pub async fn new() -> Self {
            let shim = tempfile::tempdir().unwrap();
            common::install_fake_claude(shim.path());
            let env = common::hermetic_claude_env(shim.path())
                .with("HOUSTON_FAKE_CLAUDE_FIXTURES", Some(FIXTURES));
            let (addr, state, daemon) = common::start_daemon_with_handle_in(env).await;
            let ws = common::connect_and_hello(addr, common::TOKEN).await;
            let mut rig = Rig {
                ws,
                _daemon: daemon,
                _state: state,
                _shim: shim,
                project: tempfile::tempdir().unwrap(),
                mode: Mode::Idle,
                threads: Vec::new(),
                flood: None,
                echo: 0,
                echoed: Vec::new(),
                next_request: 1,
                created: None,
                history: None,
            };
            // Raw mode, so `cat` itself echoes each byte as it arrives.
            rig.echo = rig
                .create(json!({"agent":"custom",
                    "cmd":["sh","-c","stty raw -echo && printf ready && exec cat"]}))
                .await;
            rig.until("the echo session to start", |rig| {
                rig.echoed.windows(5).any(|w| w == b"ready")
            })
            .await;
            rig.echoed.clear();
            rig
        }

        async fn send(&mut self, msg: Value) {
            self.ws.send(Message::text(msg.to_string())).await.unwrap();
        }

        async fn create(&mut self, mut body: Value) -> u32 {
            let request = self.next_request;
            self.next_request += 1;
            body["type"] = "session_create".into();
            body["request"] = request.into();
            body["project_dir"] = self.project.path().display().to_string().into();
            body["cols"] = 200.into();
            body["rows"] = 50.into();
            self.send(body).await;
            self.until("a session_create result", |rig| {
                rig.created.as_ref().is_some_and(|(r, _)| *r == request)
            })
            .await;
            match self.created.take().unwrap().1 {
                Ok(id) => id,
                Err(error) => panic!("session_create refused: {error}"),
            }
        }

        pub async fn add_threads(&mut self) {
            for _ in 0..THREADS {
                let session = self.create(json!({"agent":"claude","view":"thread"})).await;
                self.threads.push(Thread {
                    session,
                    in_turn: false,
                    turns: 0,
                    last_seq: 0,
                    stored: Vec::new(),
                });
            }
        }

        async fn start_turn(&mut self, at: usize) {
            let wanted = match self.mode {
                Mode::Idle => false,
                Mode::Fill => self.threads[at].stored.len() < IDLE_HISTORY_EVENTS,
                Mode::Stream => true,
            };
            if !wanted {
                return;
            }
            let text = if self.mode == Mode::Stream && self.threads[at].turns.is_multiple_of(2) {
                format!("flood:{FLOOD_DELTAS}")
            } else {
                "replay:tools".to_string()
            };
            let thread = &mut self.threads[at];
            thread.in_turn = true;
            thread.turns += 1;
            let session = thread.session;
            self.send(json!({"type":"thread_send","session":session,"text":text}))
                .await;
        }

        /// Fill: replay turns until each thread stores `IDLE_HISTORY_EVENTS`. Stream: flood
        /// and replay turns back to back until the mode changes. Idle: running turns finish.
        async fn set_mode(&mut self, mode: Mode) {
            self.mode = mode;
            for at in 0..self.threads.len() {
                if !self.threads[at].in_turn {
                    self.start_turn(at).await;
                }
            }
            if mode != Mode::Stream {
                self.until("thread turns to end", |rig| {
                    rig.threads.iter().all(|t| !t.in_turn)
                })
                .await;
            }
        }

        pub async fn fill_history(&mut self) {
            self.set_mode(Mode::Fill).await;
            self.set_mode(Mode::Idle).await;
        }

        pub async fn stream_threads(&mut self) {
            self.set_mode(Mode::Stream).await;
        }

        /// Lets the running turns end, then ends each thread's process tree, so a baseline
        /// runs with no thread process at all.
        pub async fn stop_threads(&mut self) {
            self.set_mode(Mode::Idle).await;
            for at in 0..self.threads.len() {
                let session = self.threads[at].session;
                self.send(json!({"type":"thread_stop","session":session}))
                    .await;
            }
        }

        /// Handles one message; false when none arrived within `wait`.
        async fn step(&mut self, wait: Duration) -> bool {
            let msg = match tokio::time::timeout(wait, self.ws.next()).await {
                Err(_) => return false,
                Ok(None) => panic!("the daemon closed the socket"),
                Ok(Some(Err(error))) => panic!("socket error: {error}"),
                Ok(Some(Ok(msg))) => msg,
            };
            match msg {
                Message::Binary(buf) => {
                    if let Some((session, _, payload)) = proto::decode_output_frame(&buf) {
                        if session == self.echo {
                            self.echoed.extend_from_slice(payload);
                        } else if let Some(flood) =
                            self.flood.as_mut().filter(|f| f.session == session)
                        {
                            flood.started.get_or_insert_with(Instant::now);
                            flood.bytes += payload.len();
                        }
                    }
                }
                Message::Text(text) => {
                    match serde_json::from_str::<proto::ServerMsg>(&text).unwrap() {
                        proto::ServerMsg::SessionCreateResult {
                            request,
                            info,
                            error,
                        } => {
                            let created = info.map(|i| i.id).ok_or(error.unwrap_or_default());
                            self.created = Some((request, created));
                        }
                        proto::ServerMsg::SessionState { session, state, .. }
                            if !state.is_live() =>
                        {
                            if let Some(flood) =
                                self.flood.as_mut().filter(|f| f.session == session)
                            {
                                flood.exited.get_or_insert_with(Instant::now);
                            }
                        }
                        proto::ServerMsg::ThreadEvents { session, events } => {
                            self.thread_events(session, events).await
                        }
                        proto::ServerMsg::ThreadHistory {
                            session,
                            events,
                            has_more,
                            ..
                        } => self.history = Some((session, events, has_more)),
                        // A lagging connection gets `control_lag` here before it is closed.
                        proto::ServerMsg::Error { message, context } => {
                            panic!("daemon error ({context:?}): {message}")
                        }
                        _ => {}
                    }
                }
                Message::Close(frame) => panic!("the daemon closed the socket: {frame:?}"),
                _ => {}
            }
            true
        }

        async fn thread_events(&mut self, session: u32, events: Vec<proto::ThreadEvent>) {
            let Some(at) = self.threads.iter().position(|t| t.session == session) else {
                return;
            };
            let mut ended = false;
            for event in events {
                let thread = &mut self.threads[at];
                assert!(
                    event.seq > thread.last_seq,
                    "thread {session}: seq {} arrived after seq {}, a duplicate or out of order",
                    event.seq,
                    thread.last_seq
                );
                thread.last_seq = event.seq;
                if let ThreadEventKind::TurnEnd { outcome, error } = &event.kind {
                    assert_eq!(
                        *outcome,
                        TurnOutcome::Completed,
                        "thread {session}: a turn ended with {error:?}"
                    );
                    ended = true;
                }
                if !matches!(event.kind, ThreadEventKind::AssistantDelta { .. }) {
                    thread.stored.push(event.seq);
                }
            }
            if ended {
                self.threads[at].in_turn = false;
                self.start_turn(at).await;
            }
        }

        async fn until(&mut self, what: &str, done: impl Fn(&Self) -> bool) {
            let deadline = Instant::now() + Duration::from_secs(120);
            while !done(self) {
                assert!(Instant::now() < deadline, "timed out waiting for {what}");
                assert!(
                    self.step(Duration::from_secs(30)).await,
                    "no message for 30 s while waiting for {what}"
                );
            }
        }

        /// Reads whatever arrives for `window`.
        pub async fn idle_for(&mut self, window: Duration) {
            let end = Instant::now() + window;
            while let Some(left) = end.checked_duration_since(Instant::now()) {
                self.step(left).await;
            }
        }

        /// MiB/s of a `FLOOD_MIB` `ansi_flood` session's output frames.
        pub async fn flood_rate(&mut self) -> f64 {
            let flood_bin = env!("CARGO_BIN_EXE_ansi_flood");
            let session = self
                .create(json!({"agent":"custom",
                    "cmd":[flood_bin, super::FLOOD_MIB.to_string()]}))
                .await;
            self.flood = Some(Flood {
                session,
                bytes: 0,
                started: None,
                exited: None,
            });
            self.until("the flood session to exit", |rig| {
                rig.flood.as_ref().is_some_and(|f| f.exited.is_some())
            })
            .await;
            let flood = self.flood.take().unwrap();
            let mib = flood.bytes as f64 / (1024.0 * 1024.0);
            assert!(
                mib >= super::FLOOD_MIB as f64 * 0.9,
                "received only {mib:.1} MiB of the ~{} MiB flood",
                super::FLOOD_MIB
            );
            let started = flood.started.expect("no flood output received");
            mib / (flood.exited.unwrap() - started).as_secs_f64()
        }

        /// p95 time from a one-byte stdin frame to the output frame that echoes it.
        pub async fn echo_p95(&mut self) -> Duration {
            let mut samples = Vec::with_capacity(ECHO_SAMPLES);
            for _ in 0..ECHO_SAMPLES {
                let target = self.echoed.len() + 1;
                let sent = Instant::now();
                let frame = proto::encode_stdin_frame(self.echo, b"x");
                self.ws.send(Message::Binary(frame.into())).await.unwrap();
                self.until("an echoed byte", |rig| rig.echoed.len() >= target)
                    .await;
                samples.push(sent.elapsed());
            }
            samples.sort();
            samples[(ECHO_SAMPLES * 95).div_ceil(100) - 1]
        }

        /// Checks that each stored event arrived live exactly once; live order was checked
        /// on arrival. Returns the number of stored events checked per thread.
        pub async fn check_history(&mut self) -> Vec<usize> {
            let mut checked = Vec::new();
            for at in 0..self.threads.len() {
                let session = self.threads[at].session;
                let mut stored = Vec::new();
                let mut before: Option<u64> = None;
                loop {
                    self.send(json!({"type":"thread_history","session":session,
                        "before_seq":before,"limit":proto::THREAD_HISTORY_PAGE_MAX}))
                        .await;
                    self.until("a thread_history page", |rig| {
                        rig.history.as_ref().is_some_and(|(s, _, _)| *s == session)
                    })
                    .await;
                    let (_, events, has_more) = self.history.take().unwrap();
                    before = events.first().map(|e| e.seq);
                    stored.extend(
                        events
                            .iter()
                            .filter(|e| !matches!(e.kind, ThreadEventKind::Notice { .. }))
                            .map(|e| e.seq),
                    );
                    if !has_more || before.is_none() {
                        break;
                    }
                }
                stored.sort_unstable();
                // History pruning may have removed the oldest events; it never adds any.
                let oldest = stored.first().copied().unwrap_or(u64::MAX);
                let live: Vec<u64> = self.threads[at]
                    .stored
                    .iter()
                    .copied()
                    .filter(|seq| *seq >= oldest)
                    .collect();
                assert_eq!(
                    stored, live,
                    "thread {session}: the stored seqs differ from the ones that arrived live"
                );
                checked.push(stored.len());
            }
            checked
        }
    }

    /// The test process's user plus system CPU time.
    pub fn cpu_time() -> Duration {
        let stat = std::fs::read_to_string("/proc/self/stat").expect("/proc/self/stat");
        let fields: Vec<&str> = stat[stat.rfind(')').expect("stat has a comm field") + 1..]
            .split_whitespace()
            .collect();
        let ticks: u64 = fields[11].parse::<u64>().unwrap() + fields[12].parse::<u64>().unwrap();
        // SAFETY: sysconf only reads a configuration value.
        let hz = unsafe { libc::sysconf(libc::_SC_CLK_TCK) } as u64;
        Duration::from_secs_f64(ticks as f64 / hz as f64)
    }

    pub fn median(values: &mut [f64]) -> f64 {
        values.sort_by(f64::total_cmp);
        values[values.len() / 2]
    }
}

/// Four threads streaming must leave terminal throughput and echo latency within a margin
/// of the same run without them, and must never lag the control channel. Relative within
/// one invocation, so it needs no stored baseline.
#[cfg(target_os = "linux")]
#[tokio::test(flavor = "multi_thread")]
#[ignore = "perf smoke — run explicitly (CI runs it in release)"]
async fn thread_streams_leave_terminals_alone() {
    use thread_load::*;
    const THROUGHPUT_SHARE: f64 = 0.9;
    const LATENCY_FACTOR: f64 = 1.5;
    const LATENCY_SLACK: Duration = Duration::from_millis(5);
    const IDLE_RSS_SLACK_MIB: f64 = 10.0;
    const IDLE_CPU_SHARE: f64 = 0.01;

    let mut rig = Rig::new().await;

    rig.idle_for(IDLE_WINDOW).await;
    let rss_without = vmrss_kib().expect("VmRSS must be readable on Linux") as f64 / 1024.0;
    rig.add_threads().await;
    rig.fill_history().await;
    let cpu_before = cpu_time();
    rig.idle_for(IDLE_WINDOW).await;
    let idle_cpu = (cpu_time() - cpu_before).as_secs_f64() / IDLE_WINDOW.as_secs_f64();
    let rss_idle = vmrss_kib().expect("VmRSS must be readable on Linux") as f64 / 1024.0;
    rig.stop_threads().await;

    let (mut base_rate, mut load_rate) = (Vec::new(), Vec::new());
    let (mut base_p95, mut load_p95) = (Vec::new(), Vec::new());
    for _ in 0..PAIRS {
        base_rate.push(rig.flood_rate().await);
        base_p95.push(rig.echo_p95().await.as_secs_f64());
        rig.stream_threads().await;
        load_rate.push(rig.flood_rate().await);
        load_p95.push(rig.echo_p95().await.as_secs_f64());
        rig.stop_threads().await;
    }
    let checked = rig.check_history().await;

    let (base_rate, load_rate) = (median(&mut base_rate), median(&mut load_rate));
    let (base_p95, load_p95) = (median(&mut base_p95), median(&mut load_p95));
    let p95_limit = (base_p95 * LATENCY_FACTOR).max(base_p95 + LATENCY_SLACK.as_secs_f64());
    println!(
        "perf_smoke threads: flood {base_rate:.1} → {load_rate:.1} MiB/s with {THREADS} threads \
         streaming (median of {PAIRS}); echo p95 {:.2} → {:.2} ms (limit {:.2} ms); idle RSS \
         {rss_without:.1} → {rss_idle:.1} MiB, CPU {:.2} % of a core; stored events checked \
         per thread {checked:?}",
        base_p95 * 1e3,
        load_p95 * 1e3,
        p95_limit * 1e3,
        idle_cpu * 100.0,
    );

    assert!(
        load_rate >= THROUGHPUT_SHARE * base_rate && load_rate >= MIN_MIB_PER_SEC,
        "flood throughput with threads streaming is {load_rate:.1} MiB/s; expected at least \
         {THROUGHPUT_SHARE} × the {base_rate:.1} MiB/s baseline and {MIN_MIB_PER_SEC} MiB/s"
    );
    assert!(
        load_p95 <= p95_limit,
        "echo p95 with threads streaming is {:.2} ms; expected at most {:.2} ms (baseline \
         {:.2} ms)",
        load_p95 * 1e3,
        p95_limit * 1e3,
        base_p95 * 1e3
    );
    assert!(
        rss_idle <= rss_without + IDLE_RSS_SLACK_MIB,
        "RSS with {THREADS} idle threads of {IDLE_HISTORY_EVENTS} stored events is \
         {rss_idle:.1} MiB; expected at most {rss_without:.1} + {IDLE_RSS_SLACK_MIB} MiB"
    );
    assert!(
        idle_cpu <= IDLE_CPU_SHARE,
        "CPU with {THREADS} idle threads is {:.2} % of a core; expected at most {} %",
        idle_cpu * 100.0,
        IDLE_CPU_SHARE * 100.0
    );
}
