//! `#[cfg(feature = "bench")]`-gated end to end: a default build never compiles this
//! module. Deliberately not built on the daemon's PTY sink -- a real PTY coalesces
//! writes per read, so exact per-message sizes need a framing transport instead.
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use crate::host;
use axum::extract::ws::{Message as WsMessage, WebSocket, WebSocketUpgrade};
use axum::routing::get;
use axum::Router;
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use std::sync::Arc;
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{AppHandle, State};
use tokio_tungstenite::tungstenite::Message as TtMessage;

#[derive(Default)]
pub struct BenchState {
    starts: Mutex<HashMap<String, Instant>>,
    scenarios: Option<Vec<String>>,
}

impl BenchState {
    pub fn new(scenarios: Option<Vec<String>>) -> Self {
        Self {
            starts: Mutex::new(HashMap::new()),
            scenarios,
        }
    }
}

#[tauri::command]
pub fn bench_scenario_selection(state: State<'_, BenchState>) -> Option<Vec<String>> {
    state.scenarios.clone()
}

pub const BENCH_SCENARIOS: &[&str] = &[
    "M1", "M2", "M3", "M4", "M5", "M6", "M7", "M8", "M9", "M10", "M11",
];

#[derive(Debug, PartialEq, Eq)]
pub struct BenchScenarioError {
    pub value: String,
}

impl BenchScenarioError {
    pub fn message(&self) -> String {
        format!(
            "houston-tauri: --bench named an unrecognized scenario {:?}. Accepted \
             scenarios: {}",
            self.value,
            BENCH_SCENARIOS.join(", ")
        )
    }
}

pub fn parse_bench_scenarios(args: &[String]) -> Result<Option<Vec<String>>, BenchScenarioError> {
    let mut last: Option<Result<Vec<String>, BenchScenarioError>> = None;
    for arg in args.iter().skip(1) {
        let Some(list) = arg.strip_prefix("--bench=") else {
            continue;
        };
        let mut scenarios = Vec::new();
        let mut err = None;
        for name in list.split(',') {
            let name = name.trim();
            if BENCH_SCENARIOS.contains(&name) {
                scenarios.push(name.to_string());
            } else {
                err = Some(BenchScenarioError {
                    value: name.to_string(),
                });
                break;
            }
        }
        last = Some(match err {
            Some(err) => Err(err),
            None => Ok(scenarios),
        });
    }
    last.map_or(Ok(None), |r| r.map(Some))
}

#[cfg(test)]
mod scenario_tests {
    use super::*;

    fn args(tokens: &[&str]) -> Vec<String> {
        std::iter::once("bin".to_string())
            .chain(tokens.iter().map(|s| s.to_string()))
            .collect()
    }

    #[test]
    fn no_selector_is_none() {
        assert_eq!(parse_bench_scenarios(&args(&["--bench"])), Ok(None));
    }

    #[test]
    fn single_name_selected() {
        assert_eq!(
            parse_bench_scenarios(&args(&["--bench=M8"])),
            Ok(Some(vec!["M8".to_string()]))
        );
    }

    #[test]
    fn list_selected_in_given_order() {
        assert_eq!(
            parse_bench_scenarios(&args(&["--bench=M6,M7,M8"])),
            Ok(Some(vec![
                "M6".to_string(),
                "M7".to_string(),
                "M8".to_string()
            ]))
        );
    }

    #[test]
    fn unknown_name_rejected_with_value_and_accepted_set() {
        let err =
            parse_bench_scenarios(&args(&["--bench=M99"])).expect_err("M99 is not a scenario");
        assert_eq!(err.value, "M99");
        let message = err.message();
        assert!(
            message.contains("M99"),
            "message must name the offending value, got: {message}"
        );
        for name in BENCH_SCENARIOS {
            assert!(
                message.contains(name),
                "message must list accepted scenario {name}, got: {message}"
            );
        }
    }

    #[test]
    fn last_occurrence_wins() {
        assert_eq!(
            parse_bench_scenarios(&args(&["--bench=M6", "--bench=M8"])),
            Ok(Some(vec!["M8".to_string()]))
        );
    }

    #[test]
    fn whitespace_around_names_is_trimmed() {
        assert_eq!(
            parse_bench_scenarios(&args(&["--bench=M6, M7 ,M8"])),
            Ok(Some(vec![
                "M6".to_string(),
                "M7".to_string(),
                "M8".to_string()
            ]))
        );
    }

    #[test]
    fn no_bench_flag_at_all_is_also_none() {
        assert_eq!(
            parse_bench_scenarios(&args(&["--channel", "dev"])),
            Ok(None)
        );
    }
}

#[cfg(test)]
mod channel_explicitness_tests {
    use super::*;

    #[test]
    fn explicit_channel_present_is_inert() {
        assert_eq!(
            bench_channel_refusal_if_needed(true, false, None),
            None,
            "an explicit --channel must never be refused, in either build profile"
        );
        assert_eq!(bench_channel_refusal_if_needed(true, true, None), None);
    }

    #[test]
    fn missing_channel_on_release_build_names_release_as_the_default() {
        let refusal =
            bench_channel_refusal_if_needed(false, false, None).expect("no --channel must refuse");
        assert_eq!(refusal.would_default_to, "release");
        let message = refusal.message();
        assert!(
            message.contains("--bench requires an explicit --channel"),
            "must name the requirement, got: {message}"
        );
        assert!(
            message.contains("\"release\""),
            "must name what the target would have defaulted to, got: {message}"
        );
        assert!(
            message.contains("--channel dev --bench")
                && message.contains("--channel release --bench"),
            "must give the correct invocation for both channels, got: {message}"
        );
        assert!(
            message.contains("installed app's own live state dir"),
            "must say why a bench must not default onto it, got: {message}"
        );
    }

    #[test]
    fn missing_channel_on_debug_build_names_dev_as_the_default() {
        let refusal =
            bench_channel_refusal_if_needed(false, true, None).expect("no --channel must refuse");
        assert_eq!(refusal.would_default_to, "dev");
        assert!(refusal.message().contains("\"dev\""));
    }

    #[test]
    fn pane_channel_env_set_does_not_satisfy_the_guard_and_is_named() {
        let refusal = bench_channel_refusal_if_needed(false, false, Some("dev".to_string()))
            .expect("HOUSTON_CHANNEL alone must still refuse");
        let message = refusal.message();
        assert!(
            message.contains("HOUSTON_CHANNEL=\"dev\""),
            "must name the env var's actual value, got: {message}"
        );
        assert!(
            message.contains("never read as a bench target"),
            "must say why setting it did not help, got: {message}"
        );
    }

    #[test]
    fn no_pane_channel_env_omits_the_env_clause() {
        let refusal = bench_channel_refusal_if_needed(false, false, None).expect("must refuse");
        assert!(!refusal.message().contains("HOUSTON_CHANNEL"));
    }
}

#[tauri::command]
pub async fn bench_channel_blast(
    state: State<'_, BenchState>,
    channel: Channel<InvokeResponseBody>,
    run_id: String,
    size: usize,
    count: usize,
) -> Result<(), String> {
    if size < 8 {
        return Err(format!(
            "bench_channel_blast: size={size} must be >= 8 (8-byte monotonic \
             counter prefix), got {size}"
        ));
    }
    state
        .starts
        .lock()
        .unwrap()
        .insert(run_id.clone(), Instant::now());
    let mut buf = vec![0xABu8; size];
    for i in 0..count as u64 {
        buf[0..8].copy_from_slice(&i.to_be_bytes());
        channel
            .send(InvokeResponseBody::Raw(buf.clone()))
            .map_err(|err| {
                format!(
                    "bench_channel_blast[{run_id}]: channel.send failed at \
                     message {i} of {count} (size={size}): {err}"
                )
            })?;
    }
    Ok(())
}

#[tauri::command]
pub async fn bench_channel_blast_paced(
    state: State<'_, BenchState>,
    channel: Channel<InvokeResponseBody>,
    run_id: String,
    size: usize,
    count: usize,
    interval_ns: u64,
) -> Result<(), String> {
    if size < 8 {
        return Err(format!(
            "bench_channel_blast_paced: size={size} must be >= 8 (8-byte monotonic \
             counter prefix), got {size}"
        ));
    }
    state
        .starts
        .lock()
        .unwrap()
        .insert(run_id.clone(), Instant::now());
    let interval = Duration::from_nanos(interval_ns);
    let mut buf = vec![0xABu8; size];
    let mut next_deadline = Instant::now();
    for i in 0..count as u64 {
        buf[0..8].copy_from_slice(&i.to_be_bytes());
        channel
            .send(InvokeResponseBody::Raw(buf.clone()))
            .map_err(|err| {
                format!(
                    "bench_channel_blast_paced[{run_id}]: channel.send failed at \
                     message {i} of {count} (size={size}): {err}"
                )
            })?;
        next_deadline += interval;
        let now = Instant::now();
        if next_deadline > now {
            tokio::time::sleep(next_deadline - now).await;
        }
    }
    Ok(())
}

pub struct BootStamps {
    t0: Instant,
    stamps: Mutex<Vec<(String, u64)>>,
}

impl BootStamps {
    #[allow(clippy::new_ret_no_self)]
    pub fn new() -> Arc<Self> {
        let stamps = Arc::new(Self {
            t0: Instant::now(),
            stamps: Mutex::new(Vec::new()),
        });
        stamps.stamp("main-entry");
        stamps
    }

    pub fn stamp(&self, name: &str) {
        let mut stamps = self.stamps.lock().unwrap();
        if stamps.iter().any(|(existing, _)| existing == name) {
            return;
        }
        stamps.push((name.to_string(), self.t0.elapsed().as_micros() as u64));
    }

    pub fn snapshot(&self) -> Vec<(String, u64)> {
        self.stamps.lock().unwrap().clone()
    }
}

#[tauri::command]
pub fn bench_m10_stamp(stamps: State<'_, Arc<BootStamps>>, name: String) {
    stamps.stamp(&name);
}

#[tauri::command]
pub fn bench_m10_stamps(stamps: State<'_, Arc<BootStamps>>) -> Vec<(String, u64)> {
    stamps.snapshot()
}

#[tauri::command]
pub async fn bench_session_count(connection: State<'_, host::ConnectionCell>) -> Result<usize, ()> {
    let info = connection.get().await;
    Ok(probe_live_session_count(info.port, &info.token)
        .await
        .unwrap_or(0))
}

async fn probe_live_session_count(port: u16, token: &str) -> Option<usize> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(5))
        .build()
        .ok()?;
    let body = houston_protocol::ManageRequest {
        manage_version: houston_protocol::MANAGE_VERSION,
        verb: houston_protocol::ManageVerb::DaemonStatus,
        candidate_bin: None,
    };
    let resp = client
        .post(format!("http://127.0.0.1:{port}/manage"))
        .bearer_auth(token)
        .json(&body)
        .send()
        .await
        .ok()?
        .error_for_status()
        .ok()?;
    let status = resp
        .json::<houston_protocol::ManageDaemonStatus>()
        .await
        .ok()?;
    Some(status.live_sessions.count as usize)
}

#[tauri::command]
pub fn bench_rss() -> Result<u64, String> {
    std::fs::read_to_string("/proc/self/status")
        .map_err(|err| format!("bench_rss: cannot read /proc/self/status: {err}"))?
        .lines()
        .find_map(|line| {
            line.strip_prefix("VmRSS:")?
                .split_whitespace()
                .next()?
                .parse::<u64>()
                .ok()
        })
        .ok_or_else(|| "bench_rss: no parsable VmRSS line in /proc/self/status".to_string())
}

pub fn run_ansi_flood(mib: usize) {
    use std::io::Write;
    let target = mib * 1024 * 1024;
    let stdout = std::io::stdout();
    let mut out = std::io::BufWriter::with_capacity(64 * 1024, stdout.lock());
    let mut written = 0usize;
    let mut i = 0u32;
    while written < target {
        let line = format!(
            "\x1b[38;5;{}m█▓▒░\x1b[0m \x1b[1m[{i:08}]\x1b[0m \x1b[38;5;208mhouston flood\x1b[0m \x1b[2m{}\x1b[0m\r\n",
            (i % 200) + 16,
            "≡".repeat((i % 40) as usize)
        );
        out.write_all(line.as_bytes()).expect("write flood line");
        written += line.len();
        i += 1;
    }
    out.flush().expect("flush flood");
}

#[cfg(test)]
mod boot_stamp_tests {
    use super::*;

    #[test]
    fn stamps_are_ordered_and_start_at_main_entry() {
        let stamps = BootStamps::new();
        stamps.stamp("a");
        stamps.stamp("b");
        let snapshot = stamps.snapshot();
        assert_eq!(
            snapshot.iter().map(|(n, _)| n.as_str()).collect::<Vec<_>>(),
            vec!["main-entry", "a", "b"]
        );
        assert!(
            snapshot.windows(2).all(|w| w[0].1 <= w[1].1),
            "offsets must be monotonic, got {snapshot:?}"
        );
    }

    #[test]
    fn re_stamping_a_name_keeps_the_first_offset() {
        let stamps = BootStamps::new();
        stamps.stamp("page-load-finished");
        let first = stamps.snapshot();
        std::thread::sleep(Duration::from_millis(2));
        stamps.stamp("page-load-finished");
        assert_eq!(
            stamps.snapshot(),
            first,
            "a later navigation's re-stamp must not rewrite the boot history"
        );
    }
}

#[derive(Debug, PartialEq, Eq)]
pub struct BenchChannelRefusal {
    would_default_to: &'static str,
    pane_channel_env: Option<String>,
}

impl BenchChannelRefusal {
    pub fn message(&self) -> String {
        let env_clause = match &self.pane_channel_env {
            Some(v) => format!(
                " (HOUSTON_CHANNEL={v:?} is set in this shell, but that variable is never \
                 read as a bench target -- it is pane input for --daemon-fresh's self-protection \
                 guard only)"
            ),
            None => String::new(),
        };
        format!(
            "houston-tauri: BENCH REFUSED: --bench requires an explicit --channel; none \
             was given{env_clause}, so this run would have defaulted to the {default:?} \
             channel. A bench must never default onto a channel: {default:?} may be the \
             installed app's own live state dir, and a measurement must always name the one it \
             targets. Re-run naming the channel you mean: `--channel dev --bench` for the dev \
             channel, or `--channel release --bench` if you really mean the installed app's \
             channel.",
            default = self.would_default_to,
        )
    }
}

// A bench must never default onto a channel: on a release build that default is
// `~/.houston`, the installed app's live state, so a bare `--bench` would write a
// daemon record and databases into it. An explicit `--channel` is required.
pub fn bench_channel_refusal_if_needed(
    channel_flag_present: bool,
    debug_build: bool,
    pane_channel_env: Option<String>,
) -> Option<BenchChannelRefusal> {
    if channel_flag_present {
        return None;
    }
    Some(BenchChannelRefusal {
        would_default_to: if debug_build { "dev" } else { "release" },
        pane_channel_env,
    })
}

#[cfg(feature = "bench")]
// Debug timings inflate ~8-11.6x over release, non-uniformly across payload size, so
// they corrupt the derived ratios the bench exists to produce -- not just their
// magnitude. Refuse before a window opens; `TR_BENCH_ALLOW_DEBUG=1` is the named hatch.
pub fn refuse_if_debug_without_escape_hatch() {
    if !cfg!(debug_assertions) {
        return;
    }
    if std::env::var("TR_BENCH_ALLOW_DEBUG").as_deref() == Ok("1") {
        eprintln!(
            "houston-tauri: BENCH: running a debug build under TR_BENCH_ALLOW_DEBUG=1 -- \
             timings from this run are NOT valid measurements (debug inflates 8-11.6x, \
             non-uniformly across payload size) and must not be recorded as \
             results."
        );
        return;
    }
    eprintln!(
        "houston-tauri: BENCH REFUSED: this is a debug build (cfg!(debug_assertions) == \
         true), and --bench does not run against debug builds. Debug timings inflate 8-11.6x \
         over release, non-uniformly across payload size, which corrupts the derived ratios \
         (the coalescing ratio and the flush ceiling) the measurement exists to produce, not \
         just their absolute magnitude. Build release instead: `cargo build --release --features \
         bench` in src-tauri/, then run `src-tauri/target/release/houston-tauri --bench`. \
         Escape hatch, for testing the bench harness itself (not for recording results): set \
         TR_BENCH_ALLOW_DEBUG=1."
    );
    std::process::exit(1);
}

#[tauri::command]
pub fn bench_done(state: State<'_, BenchState>, run_id: String, n: usize) -> Result<u64, String> {
    let start = state
        .starts
        .lock()
        .unwrap()
        .remove(&run_id)
        .ok_or_else(|| {
            format!(
                "bench_done: no bench_channel_blast start recorded for run_id={run_id:?} \
             (renderer claims it saw n={n} messages) -- bench_done must follow a \
             bench_channel_blast call with the same run_id"
            )
        })?;
    Ok(start.elapsed().as_nanos() as u64)
}

#[tauri::command]
pub fn bench_config() -> String {
    std::env::var("TR_BENCH_RESULTS_PATH").unwrap_or_else(|_| {
        std::env::temp_dir()
            .join("houston-phase-2-bench-raw.json")
            .display()
            .to_string()
    })
}

#[derive(serde::Serialize)]
pub struct BenchBinaryInfo {
    binary_path: String,
    debug_assertions: bool,
}

#[tauri::command]
pub fn bench_binary_info() -> Result<BenchBinaryInfo, String> {
    let binary_path = std::env::current_exe()
        .map_err(|err| format!("bench_binary_info: failed to resolve current_exe: {err}"))?
        .display()
        .to_string();
    Ok(BenchBinaryInfo {
        binary_path,
        debug_assertions: cfg!(debug_assertions),
    })
}

fn write_results_json(path: &str, json: &serde_json::Value, caller: &str) -> Result<(), String> {
    let dest = std::path::PathBuf::from(path);
    let tmp = dest.with_extension("json.tmp");
    let pretty = serde_json::to_string_pretty(json)
        .map_err(|err| format!("{caller}: failed to serialize results JSON: {err}"))?;
    std::fs::write(&tmp, pretty)
        .map_err(|err| format!("{caller}: failed to write {}: {err}", tmp.display()))?;
    std::fs::rename(&tmp, &dest).map_err(|err| {
        format!(
            "{caller}: failed to rename {} -> {}: {err}",
            tmp.display(),
            dest.display()
        )
    })
}

#[tauri::command]
pub fn bench_checkpoint(path: String, json: serde_json::Value) -> Result<(), String> {
    write_results_json(&path, &json, "bench_checkpoint")
}

#[tauri::command]
pub fn bench_log(line: String) {
    println!("houston-tauri: [bench] {line}");
}

#[tauri::command]
pub fn bench_report(app: AppHandle, path: String, json: serde_json::Value) -> Result<(), String> {
    write_results_json(&path, &json, "bench_report")?;
    println!("houston-tauri: bench results written to {path}");
    app.exit(0);
    Ok(())
}

#[tauri::command]
pub fn bench_failed(app: AppHandle, message: String) {
    eprintln!("houston-tauri: BENCH FAILED: {message}");
    app.exit(1);
}

#[derive(Deserialize)]
struct WsBlastRequest {
    size: usize,
    count: usize,
    #[serde(default)]
    precise: bool,
}

#[tauri::command]
pub async fn bench_ws_start() -> Result<u16, String> {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|err| format!("bench_ws_start: failed to bind 127.0.0.1:0: {err}"))?;
    let port = listener
        .local_addr()
        .map_err(|err| format!("bench_ws_start: failed to read local_addr: {err}"))?
        .port();
    let router = Router::new().route("/ws", get(ws_handler));
    tauri::async_runtime::spawn(async move {
        if let Err(err) = axum::serve(listener, router).await {
            eprintln!("houston-tauri: bench WS server exited: {err}");
        }
    });
    Ok(port)
}

async fn ws_connect_and_hello(
    port: u16,
    token: &str,
) -> Result<
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>,
    String,
> {
    let url = format!("ws://127.0.0.1:{port}/ws");
    let (mut ws, _response) = tokio_tungstenite::connect_async(&url)
        .await
        .map_err(|err| format!("bench ws: failed to connect to {url}: {err}"))?;
    let hello = houston_protocol::ClientMsg::Hello {
        token: token.to_string(),
        protocol: houston_protocol::PROTOCOL_VERSION,
    };
    ws.send(TtMessage::Text(
        serde_json::to_string(&hello)
            .expect("ClientMsg::Hello serializes")
            .into(),
    ))
    .await
    .map_err(|err| format!("bench ws: failed to send hello to {url}: {err}"))?;
    match ws.next().await {
        Some(Ok(TtMessage::Text(text))) => {
            let msg: houston_protocol::ServerMsg = serde_json::from_str(&text)
                .map_err(|err| format!("bench ws: malformed hello reply {text:?}: {err}"))?;
            if !matches!(msg, houston_protocol::ServerMsg::HelloOk { .. }) {
                return Err(format!("bench ws: expected hello_ok, got: {text}"));
            }
        }
        Some(Ok(other)) => {
            return Err(format!(
                "bench ws: expected hello_ok as text, got {other:?}"
            ))
        }
        Some(Err(err)) => return Err(format!("bench ws: error waiting for hello_ok: {err}")),
        None => return Err("bench ws: connection closed before hello_ok".to_string()),
    }
    Ok(ws)
}

#[tauri::command]
pub async fn bench_stdin(
    connection: State<'_, host::ConnectionCell>,
    session: u32,
    text: String,
) -> Result<(), String> {
    let info = connection.get().await;
    let mut ws = ws_connect_and_hello(info.port, &info.token).await?;
    let frame = houston_protocol::encode_stdin_frame(session, text.as_bytes());
    ws.send(TtMessage::Binary(frame.into()))
        .await
        .map_err(|err| format!("bench_stdin: send failed for session {session}: {err}"))
}

#[tauri::command]
pub async fn bench_session_kill(
    connection: State<'_, host::ConnectionCell>,
    session: u32,
) -> Result<(), String> {
    let info = connection.get().await;
    let mut ws = ws_connect_and_hello(info.port, &info.token).await?;
    let msg = houston_protocol::ClientMsg::SessionKill {
        session,
        confirm_children: Some(true),
    };
    ws.send(TtMessage::Text(
        serde_json::to_string(&msg)
            .expect("ClientMsg::SessionKill serializes")
            .into(),
    ))
    .await
    .map_err(|err| format!("bench_session_kill: send failed for session {session}: {err}"))
}

async fn ws_handler(ws: WebSocketUpgrade) -> axum::response::Response {
    ws.on_upgrade(ws_blast)
}

async fn ws_blast(mut socket: WebSocket) {
    loop {
        let req = match socket.recv().await {
            Some(Ok(WsMessage::Text(text))) => {
                match serde_json::from_str::<WsBlastRequest>(&text) {
                    Ok(req) => req,
                    Err(err) => {
                        eprintln!(
                            "houston-tauri: bench WS: malformed control message {text:?}: {err}"
                        );
                        return;
                    }
                }
            }
            Some(Ok(_)) => continue,
            Some(Err(err)) => {
                eprintln!("houston-tauri: bench WS: recv error waiting for control message: {err}");
                return;
            }
            None => return,
        };
        if req.size < 8 {
            eprintln!(
                "houston-tauri: bench WS: size={} must be >= 8 (8-byte counter prefix)",
                req.size
            );
            return;
        }
        let mut buf = vec![0xABu8; req.size];
        let start = if req.precise {
            Some(Instant::now())
        } else {
            None
        };
        for i in 0..req.count as u64 {
            buf[0..8].copy_from_slice(&i.to_be_bytes());
            if socket
                .send(WsMessage::Binary(buf.clone().into()))
                .await
                .is_err()
            {
                return;
            }
        }
        let Some(start) = start else {
            continue;
        };
        match socket.recv().await {
            Some(Ok(WsMessage::Text(_))) => {
                let elapsed_ns = start.elapsed().as_nanos() as u64;
                let reply = serde_json::json!({ "elapsed_ns": elapsed_ns }).to_string();
                if socket.send(WsMessage::Text(reply.into())).await.is_err() {
                    return;
                }
            }
            Some(Ok(_)) => {
                eprintln!(
                    "houston-tauri: bench WS: expected a text ack after {} precise \
                     frames (size={}), got a non-text frame",
                    req.count, req.size
                );
                return;
            }
            Some(Err(err)) => {
                eprintln!(
                    "houston-tauri: bench WS: recv error waiting for precise-mode ack: {err}"
                );
                return;
            }
            None => return,
        }
    }
}
