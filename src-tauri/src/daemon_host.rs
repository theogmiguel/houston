use anyhow::Result;
use houston_core::paths;
use serde::Deserialize;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

pub const CHANNEL_ENV: &str = paths::CHANNEL_ENV;
pub const SESSION_ENV: &str = "HOUSTON_SESSION";

fn accepted_flags_description() -> String {
    #[cfg(feature = "bench")]
    let bench_scenario_note = ", --bench=<scenario>[,<scenario>...]";
    #[cfg(not(feature = "bench"))]
    let bench_scenario_note = "";
    format!(
        "--channel <name> (or --channel=<name>), {}{}",
        known_standalone_flags().join(", "),
        bench_scenario_note
    )
}

const KNOWN_STANDALONE_FLAGS_BASE: &[&str] = &[
    "--print-target",
    "--daemon-fresh",
    "--spike-invoke",
    "--spike-webview",
    "--spike-webview-auto",
    "--browser-selftest",
];

fn known_standalone_flags() -> Vec<&'static str> {
    #[allow(unused_mut)]
    let mut flags = KNOWN_STANDALONE_FLAGS_BASE.to_vec();
    #[cfg(feature = "bench")]
    flags.push("--bench");
    debug_assert!(
        flags.iter().all(|f| f.starts_with("--")),
        "every accepted standalone flag must start with \"--\" -- a flag spelled \
         without that prefix could ALSO be a valid channel name (channel_shape_rule \
         only forbids a channel name from starting/ending with '-', not from ever \
         containing one), so --channel <that-flag> would swallow it as a VALUE while \
         main.rs's whole-argv scanners kept matching it as a FLAG. Got: {flags:?}"
    );
    flags
}

#[cfg(not(feature = "bench"))]
pub fn bench_feature_missing_message() -> String {
    "houston-tauri: BENCH REFUSED: this binary was not built with --features bench, so \
     --bench has no handling at all (main.rs::bench_requested and every one of its call sites \
     are #[cfg(feature = \"bench\")]-gated out of this build). Build it in: `cargo build \
     --features bench` (or `cargo build --release --features bench`) in src-tauri/, then re-run \
     with --bench (or --bench=<scenario>[,<scenario>...], e.g. --bench=M8)."
        .to_string()
}

#[cfg(not(feature = "bench"))]
pub fn bench_flag_present(args: &[String]) -> bool {
    args.iter()
        .skip(1)
        .any(|arg| arg == "--bench" || arg.starts_with("--bench="))
}

#[derive(Debug, PartialEq, Eq)]
pub struct UnrecognizedArgError {
    pub token: String,
}

impl UnrecognizedArgError {
    pub fn message(&self) -> String {
        format!(
            "houston-tauri: unrecognized argument: {:?}. Accepted flags: {}",
            self.token,
            accepted_flags_description()
        )
    }
}

pub fn reject_unrecognized_args(args: &[String]) -> Result<(), UnrecognizedArgError> {
    let mut i = 1;
    while i < args.len() {
        let arg = &args[i];
        if arg == "--channel" {
            i += 2;
            continue;
        }
        if arg.starts_with("--channel=") {
            i += 1;
            continue;
        }
        #[cfg(feature = "bench")]
        if arg.starts_with("--bench=") {
            i += 1;
            continue;
        }
        if known_standalone_flags().contains(&arg.as_str()) {
            i += 1;
            continue;
        }
        return Err(UnrecognizedArgError { token: arg.clone() });
    }
    Ok(())
}

#[derive(Debug, PartialEq, Eq)]
pub enum OwnershipRefusal {
    InvalidChannel { raw: String },
}

impl OwnershipRefusal {
    pub fn message(&self) -> String {
        match self {
            OwnershipRefusal::InvalidChannel { raw } => format!(
                "houston-tauri: refusing to own a daemon: --channel {raw:?} is not a \
                 valid channel name ({})",
                paths::channel_shape_rule()
            ),
        }
    }
}

pub fn resolve_owning_channel(
    debug_build: bool,
    channel_flag: Option<&str>,
) -> Result<Option<String>, OwnershipRefusal> {
    if let Some(raw) = channel_flag {
        return paths::validate_channel(raw).map_err(|_| OwnershipRefusal::InvalidChannel {
            raw: raw.to_string(),
        });
    }
    if debug_build {
        return Ok(Some("dev".to_string()));
    }
    Ok(None)
}

#[derive(Debug, PartialEq, Eq)]
pub enum ChannelFlagError {
    MissingValue,
    EmptyValue(String),
}

impl ChannelFlagError {
    pub fn message(&self) -> String {
        match self {
            ChannelFlagError::MissingValue => "houston-tauri: --channel requires a value \
                 (got none). Expected: --channel <name>, e.g. --channel release"
                .to_string(),
            ChannelFlagError::EmptyValue(raw) => format!(
                "houston-tauri: --channel was given {raw:?}, which is empty or \
                 whitespace-only after trimming. Expected: 1-32 characters of [a-z0-9-] (not \
                 starting or ending with '-'), or the literal \"release\"."
            ),
        }
    }
}

pub fn parse_channel_flag(args: &[String]) -> Result<Option<String>, ChannelFlagError> {
    let mut last: Option<Result<String, ChannelFlagError>> = None;
    let mut i = 0;
    while i < args.len() {
        let arg = &args[i];
        if arg == "--channel" {
            last = Some(match args.get(i + 1) {
                Some(value) if !value.trim().is_empty() => Ok(value.clone()),
                Some(value) => Err(ChannelFlagError::EmptyValue(value.clone())),
                None => Err(ChannelFlagError::MissingValue),
            });
            i += 2;
            continue;
        }
        if let Some(value) = arg.strip_prefix("--channel=") {
            last = Some(if value.trim().is_empty() {
                Err(ChannelFlagError::EmptyValue(value.to_string()))
            } else {
                Ok(value.to_string())
            });
        }
        i += 1;
    }
    last.map_or(Ok(None), |r| r.map(Some))
}

pub fn print_target_requested(args: &[String]) -> bool {
    args.iter().any(|arg| arg == "--print-target")
}

#[cfg(feature = "bench")]
pub fn channel_flag_present(args: &[String]) -> bool {
    args.iter()
        .any(|arg| arg == "--channel" || arg.starts_with("--channel="))
}

pub fn release_warning_needed(channel_flag_present: bool, owning_channel: Option<&str>) -> bool {
    channel_flag_present && owning_channel.is_none()
}

pub fn normalize_channel_label(raw: Option<&str>) -> String {
    match raw {
        None => "release".to_string(),
        Some(raw) => match paths::validate_channel(raw) {
            Ok(None) => "release".to_string(),
            Ok(Some(channel)) => channel,
            Err(_) => raw.to_string(),
        },
    }
}

#[derive(Debug, Deserialize)]
struct DaemonJsonPid {
    pid: u32,
}

#[derive(Debug, PartialEq, Eq)]
pub enum StaleReason {
    Missing,
    Unparseable { snippet: String },
    Dead { pid: u32 },
    Recycled { pid: u32, comm: String },
}

#[derive(Debug, PartialEq, Eq)]
pub enum SingletonVerdict {
    Live { pid: u32 },
    Stale(StaleReason),
}

fn is_houston_binary(comm: &str) -> bool {
    comm.starts_with("houston-core") || comm.starts_with("houston")
}

pub fn singleton_verdict(
    daemon_json: Option<&str>,
    alive: &dyn Fn(u32) -> Option<String>,
) -> SingletonVerdict {
    let Some(text) = daemon_json else {
        return SingletonVerdict::Stale(StaleReason::Missing);
    };
    let pid = match serde_json::from_str::<DaemonJsonPid>(text) {
        Ok(cfg) => cfg.pid,
        Err(_) => {
            let snippet: String = text.chars().take(200).collect();
            return SingletonVerdict::Stale(StaleReason::Unparseable { snippet });
        }
    };
    match alive(pid) {
        None => SingletonVerdict::Stale(StaleReason::Dead { pid }),
        Some(comm) if is_houston_binary(&comm) => SingletonVerdict::Live { pid },
        Some(comm) => SingletonVerdict::Stale(StaleReason::Recycled { pid, comm }),
    }
}

pub fn stale_log_line(reason: &StaleReason, state_dir: &Path) -> String {
    let cfg = state_dir.join("daemon.json");
    match reason {
        StaleReason::Missing => format!(
            "houston-tauri: {} does not exist; proceeding to own this state dir (shape: missing)",
            cfg.display()
        ),
        StaleReason::Unparseable { snippet } => format!(
            "houston-tauri: {} is not valid JSON with a numeric \"pid\" field (content: \
             {snippet:?}); treating as stale and proceeding (shape: unparseable)",
            cfg.display()
        ),
        StaleReason::Dead { pid } => format!(
            "houston-tauri: {} names pid {pid}, which is not alive; treating as stale and \
             proceeding (shape: dead pid)",
            cfg.display()
        ),
        StaleReason::Recycled { pid, comm } => format!(
            "houston-tauri: {} names pid {pid}, which is alive but its /proc/{pid}/comm is \
             {comm:?} (not a houston-core/houston process); treating as a recycled pid and \
             proceeding (shape: recycled pid)",
            cfg.display()
        ),
    }
}

pub fn daemon_fresh_self_protection(
    session_env: Option<&str>,
    pane_channel_label: &str,
    target_channel_label: &str,
) -> bool {
    session_env.is_some() && pane_channel_label == target_channel_label
}

pub fn self_protection_refusal_message(target_channel_label: &str, session: &str) -> String {
    format!(
        "houston-tauri: refusing --daemon-fresh: this process is running inside a \
         '{target_channel_label}' channel pane (session {session}). Stopping that daemon would \
         kill this pane and every other session on the channel. Run --daemon-fresh from a pane \
         on another channel, or a terminal outside any pane."
    )
}

pub const DAEMON_FRESH_TIMEOUT: Duration = Duration::from_secs(10);

#[cfg(unix)]
#[allow(dead_code)]
pub fn terminate_and_wait(
    pid: u32,
    timeout: Duration,
    alive: &dyn Fn(u32) -> Option<String>,
) -> Result<(), String> {
    terminate_and_wait_identity(pid, None, timeout, alive)
}

pub fn terminate_and_wait_identity(
    pid: u32,
    expected_creation: Option<u64>,
    timeout: Duration,
    alive: &dyn Fn(u32) -> Option<String>,
) -> Result<(), String> {
    match houston_core::pid::signal_process_checked_identity(
        pid,
        houston_core::pid::Signal::Term,
        expected_creation,
    ) {
        Ok(houston_core::pid::SignalOutcome::NoSuchProcess) => return Ok(()),
        Ok(houston_core::pid::SignalOutcome::IdentityMismatch) => {
            return Err(format!(
                "--daemon-fresh: pid {pid} now belongs to a different process (creation token \
                 mismatch) -- the recorded daemon is gone and the pid was RECYCLED. Nothing was \
                 signalled; remove {pid:?}'s stale daemon.json manually if that is intended."
            ));
        }
        Ok(houston_core::pid::SignalOutcome::Delivered) => {}
        Err(houston_core::pid::SignalError::InvalidPid(reason)) => {
            return Err(format!("--daemon-fresh: {reason}"));
        }
        Err(houston_core::pid::SignalError::Os(err)) => {
            return Err(format!(
                "--daemon-fresh: SIGTERM to pid {pid} failed: {err} (expected a signallable \
                 process owned by this user)"
            ));
        }
    }
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if alive(pid).is_none() {
            return Ok(());
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    Err(format!(
        "--daemon-fresh: pid {pid} did not exit within {timeout:?} of SIGTERM; refusing to \
         escalate to SIGKILL. Stop it manually and investigate why it did not respond."
    ))
}

#[derive(Debug, Deserialize)]
struct DaemonJsonForFresh {
    port: u16,
    token: String,
    pid: u32,
}

pub async fn run_daemon_fresh_via_manage(state_dir: &Path) -> Result<(), String> {
    let daemon_json_path = state_dir.join("daemon.json");
    let Some(contents) = fs::read_to_string(&daemon_json_path).ok() else {
        return Ok(());
    };
    let Ok(fields) = serde_json::from_str::<DaemonJsonForFresh>(&contents) else {
        eprintln!(
            "houston-tauri: --daemon-fresh: {} is not readable as port/token/pid; treating as \
             stale, nothing to stop",
            daemon_json_path.display()
        );
        return Ok(());
    };
    if houston_core::pid::process_comm(fields.pid).is_none() {
        return Ok(());
    }

    let client = manage_http_client();
    let (status, json) = manage_post(
        &client,
        fields.port,
        &fields.token,
        houston_protocol::ManageVerb::DaemonShutdown,
    )
    .await
    .map_err(|e| format!("--daemon-fresh: {e}"))?;
    if !status.is_success() {
        return Err(format!(
            "--daemon-fresh: /manage daemon_shutdown refused (HTTP {status}): {json}"
        ));
    }
    let ok = json.get("ok").and_then(serde_json::Value::as_bool);
    if ok != Some(true) {
        return Err(format!(
            "--daemon-fresh: daemon_shutdown did not report ok:true: {json}. Never falling back \
             to a bare kill -- stop it manually and investigate."
        ));
    }
    eprintln!(
        "houston-tauri: --daemon-fresh: daemon_shutdown confirmed (pid {}), waiting for it to \
         exit…",
        fields.pid
    );

    let deadline = std::time::Instant::now() + DAEMON_FRESH_TIMEOUT;
    while houston_core::pid::process_comm(fields.pid).is_some() {
        if std::time::Instant::now() >= deadline {
            return Err(format!(
                "--daemon-fresh: pid {} did not exit within {:?} of a confirmed daemon_shutdown. \
                 Refusing to start a second daemon on top of it -- stop it manually and \
                 investigate.",
                fields.pid, DAEMON_FRESH_TIMEOUT
            ));
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    Ok(())
}

pub const DAEMON_BIN_DIR_ENV: &str = "HOUSTON_DAEMON_BIN_DIR";

pub fn daemon_binary_name() -> &'static str {
    if cfg!(windows) {
        "houston-core.exe"
    } else {
        "houston-core"
    }
}

#[cfg(unix)]
pub fn supervisor_binary_name() -> &'static str {
    "houston-supervisor"
}

pub fn spawn_bin_dir(exe: &Path) -> PathBuf {
    if let Ok(dir) = std::env::var(DAEMON_BIN_DIR_ENV) {
        if !dir.trim().is_empty() {
            return PathBuf::from(dir);
        }
    }
    exe.parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| PathBuf::from("."))
}

#[derive(Debug, Clone)]
pub struct DaemonHandle {
    pub port: u16,
    pub token: String,
    pub spawned: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BootRefusal {
    pub message: String,
    pub daemon: Option<(u16, String)>,
}

impl BootRefusal {
    fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            daemon: None,
        }
    }

    fn with_daemon(message: impl Into<String>, port: u16, token: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            daemon: Some((port, token.into())),
        }
    }
}

impl std::fmt::Display for BootRefusal {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.message)
    }
}
impl std::error::Error for BootRefusal {}

const MANAGE_HTTP_TIMEOUT: Duration = Duration::from_secs(5);

const PRECHECK_PROBE_TIMEOUT: Duration = Duration::from_secs(1);

// A handoff parks every session and waits for the candidate's handshake, so
// it runs on the daemon's per-step budgets rather than a probe's 5s; a
// minute covers a full grid. A hang here is a bug, not a slow handoff.
pub(crate) const HANDOFF_HTTP_TIMEOUT: Duration = Duration::from_secs(60);

fn manage_http_client() -> reqwest::Client {
    manage_http_client_with(MANAGE_HTTP_TIMEOUT)
}

fn manage_http_client_with(timeout: Duration) -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(timeout)
        .connect_timeout(timeout)
        .build()
        .expect("building a reqwest client with a fixed timeout cannot fail")
}

/// What the release-channel daemon reports about live sessions. `None` means
/// no daemon (nothing to protect); an `Err` means one is named live but did
/// not answer — never read that as zero sessions.
#[cfg(any(windows, test))]
pub(crate) async fn probe_live_sessions(
    state_dir: &Path,
) -> Result<Option<houston_protocol::ManageLiveSessions>, String> {
    let daemon_json_path = state_dir.join("daemon.json");
    let Some(text) = fs::read_to_string(&daemon_json_path).ok() else {
        return Ok(None);
    };
    if !matches!(
        singleton_verdict(Some(&text), &houston_core::pid::process_comm),
        SingletonVerdict::Live { .. }
    ) {
        return Ok(None);
    }
    let fields = serde_json::from_str::<DaemonFileFields>(&text).map_err(|e| {
        format!(
            "{} names a live daemon but has no readable port/token: {e}",
            daemon_json_path.display()
        )
    })?;
    let client = manage_http_client();
    let status = probe_daemon_status(&client, fields.port, &fields.token).await?;
    Ok(Some(status.live_sessions))
}

/// How long a Windows update waits for the daemon it just retired to exit. The
/// daemon answers the shutdown, then exits on its own within ~50ms; ten seconds
/// is a tripwire for a wedged process, not a budget for a slow one.
#[cfg(any(windows, test))]
pub(crate) const UPDATE_SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(10);

/// Retire the active daemon so a Windows installer can replace houston-core.exe,
/// which a running daemon locks. The refusal-or-stop decision lives inside the
/// daemon, so a raced session is never killed; no daemon is the normal no-op.
#[cfg(any(windows, test))]
#[cfg_attr(not(windows), allow(dead_code))]
pub(crate) async fn retire_daemon_for_update(
    state_dir: &Path,
    channel_label: &str,
) -> Result<(), String> {
    retire_daemon_for_update_with(
        state_dir,
        channel_label,
        &houston_core::pid::process_comm,
        UPDATE_SHUTDOWN_TIMEOUT,
    )
    .await
}

#[cfg(any(windows, test))]
async fn retire_daemon_for_update_with(
    state_dir: &Path,
    channel_label: &str,
    alive: &(dyn Fn(u32) -> Option<String> + Sync),
    timeout: Duration,
) -> Result<(), String> {
    let daemon_json_path = state_dir.join("daemon.json");
    let Some(text) = fs::read_to_string(&daemon_json_path).ok() else {
        return Ok(());
    };
    let SingletonVerdict::Live { pid } = singleton_verdict(Some(&text), alive) else {
        return Ok(());
    };
    let fields = serde_json::from_str::<DaemonFileFields>(&text).map_err(|e| {
        format!(
            "app_update_install: {} names a live daemon (pid {pid}) but has no readable \
             port/token: {e}",
            daemon_json_path.display()
        )
    })?;
    let client = manage_http_client();
    let request = houston_protocol::ManageRequest {
        manage_version: houston_protocol::MANAGE_VERSION,
        verb: houston_protocol::ManageVerb::DaemonShutdownIfIdle,
        candidate_bin: None,
    };
    let (http_status, json) =
        match manage_post_request(&client, fields.port, &fields.token, &request).await {
            Ok(pair) => pair,
            Err(e) => {
                // The daemon may have exited between the verdict and the ask; a
                // pid that is gone is already retired, not a refusal.
                if alive(pid).is_none() {
                    eprintln!(
                    "app_update_install: the {channel_label} daemon (pid {pid}) exited before it \
                     could be asked to retire; nothing is holding {}",
                    daemon_binary_name()
                );
                    return Ok(());
                }
                return Err(format!(
                "app_update_install: asking the {channel_label} daemon (pid {pid}) to retire: {e}"
            ));
            }
        };
    if !http_status.is_success() {
        return Err(format!(
            "app_update_install: the {channel_label} channel's daemon refused to retire for the \
             update (HTTP {http_status}: {json}). A daemon from before this build cannot answer \
             this request; stop the daemon from the tray, then retry the install."
        ));
    }
    if json.get("ok").and_then(serde_json::Value::as_bool) != Some(true) {
        let reason = json
            .get("error")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("the daemon gave no reason");
        return Err(format!(
            "app_update_install: refusing to update: the {channel_label} channel's daemon would \
             not retire ({reason}). Nothing was installed and no session was stopped."
        ));
    }
    eprintln!(
        "app_update_install: retired the {channel_label} daemon (pid {pid}); waiting for it to \
         exit before the installer replaces {}",
        daemon_binary_name()
    );
    wait_for_daemon_exit(&daemon_json_path, pid, channel_label, timeout, alive).await
}

/// Confirm the retired generation is gone before an installer overwrites its
/// binary. A different live generation named in daemon.json is a refusal: the
/// installer would race a daemon it did not retire, so it must not start.
#[cfg(any(windows, test))]
async fn wait_for_daemon_exit(
    daemon_json_path: &Path,
    pid: u32,
    channel_label: &str,
    timeout: Duration,
    alive: &(dyn Fn(u32) -> Option<String> + Sync),
) -> Result<(), String> {
    let deadline = Instant::now() + timeout;
    loop {
        let named = fs::read_to_string(daemon_json_path).ok();
        if let SingletonVerdict::Live { pid: other } = singleton_verdict(named.as_deref(), alive) {
            if other != pid {
                return Err(format!(
                    "app_update_install: while waiting for pid {pid} to exit, {} names pid \
                     {other} instead: a new daemon generation owns the {channel_label} channel, \
                     so the installer cannot replace {}. Nothing was installed.",
                    daemon_json_path.display(),
                    daemon_binary_name()
                ));
            }
        }
        if alive(pid).is_none() {
            return Ok(());
        }
        if Instant::now() >= deadline {
            return Err(format!(
                "app_update_install: pid {pid} did not exit within {}s of a confirmed \
                 daemon_shutdown; the installer cannot replace {} while it runs. Stop it \
                 manually and retry",
                timeout.as_secs(),
                daemon_binary_name()
            ));
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

/// Ask a daemon to hand its sessions to `candidate` and retire. A refused
/// handoff is `Ok` with `accepted: false`: the daemon that answered still owns
/// every session. Off Linux the daemon itself refuses, by name.
pub(crate) async fn request_candidate_handoff(
    state_dir: &Path,
    candidate: Option<&Path>,
) -> Result<houston_protocol::ManageDaemonHandoffResult, String> {
    let daemon_json_path = state_dir.join("daemon.json");
    let text = fs::read_to_string(&daemon_json_path)
        .map_err(|e| format!("reading {} for a handoff: {e}", daemon_json_path.display()))?;
    let fields = serde_json::from_str::<DaemonFileFields>(&text)
        .map_err(|e| format!("parsing {}: {e}", daemon_json_path.display()))?;
    let client = manage_http_client_with(HANDOFF_HTTP_TIMEOUT);
    let request = houston_protocol::ManageRequest {
        manage_version: houston_protocol::MANAGE_VERSION,
        verb: houston_protocol::ManageVerb::DaemonHandoff,
        candidate_bin: candidate.map(|p| p.to_string_lossy().into_owned()),
    };
    let (status, json) = manage_post_request(&client, fields.port, &fields.token, &request).await?;
    if !status.is_success() {
        return Err(format!(
            "/manage daemon_handoff refused (HTTP {status}): {json}"
        ));
    }
    serde_json::from_value(json).map_err(|e| {
        format!("/manage daemon_handoff response did not match the expected shape: {e}")
    })
}

async fn manage_post(
    client: &reqwest::Client,
    port: u16,
    token: &str,
    verb: houston_protocol::ManageVerb,
) -> Result<(reqwest::StatusCode, serde_json::Value), String> {
    let body = houston_protocol::ManageRequest {
        manage_version: houston_protocol::MANAGE_VERSION,
        verb,
        candidate_bin: None,
    };
    manage_post_request(client, port, token, &body).await
}

async fn manage_post_request(
    client: &reqwest::Client,
    port: u16,
    token: &str,
    body: &houston_protocol::ManageRequest,
) -> Result<(reqwest::StatusCode, serde_json::Value), String> {
    let resp = client
        .post(format!("http://127.0.0.1:{port}/manage"))
        .bearer_auth(token)
        .json(body)
        .send()
        .await
        .map_err(|e| format!("POST /manage ({:?}) to port {port} failed: {e}", body.verb))?;
    let status = resp.status();
    let json = resp
        .json::<serde_json::Value>()
        .await
        .map_err(|e| format!("/manage ({:?}) response was not valid JSON: {e}", body.verb))?;
    Ok((status, json))
}

async fn probe_daemon_status(
    client: &reqwest::Client,
    port: u16,
    token: &str,
) -> Result<houston_protocol::ManageDaemonStatus, String> {
    let (status, json) = manage_post(
        client,
        port,
        token,
        houston_protocol::ManageVerb::DaemonStatus,
    )
    .await?;
    if !status.is_success() {
        return Err(format!(
            "/manage daemon_status refused (HTTP {status}): {json}"
        ));
    }
    serde_json::from_value(json).map_err(|e| {
        format!("/manage daemon_status response did not match the expected shape: {e}")
    })
}

fn protocol_mismatch_message(daemon_protocol: u32, live_sessions: Option<u32>) -> String {
    let sessions = live_sessions
        .map(|n| n.to_string())
        .unwrap_or_else(|| "unknown".to_string());
    format!(
        "Cannot attach: daemon protocol {daemon_protocol}, app protocol {}; {sessions} live \
         sessions. That daemon did not come from this install's own binary; stop its sessions \
         and restart, or reinstall Houston.",
        houston_protocol::PROTOCOL_VERSION
    )
}

fn channel_name_from_flag<'a>(channel_flag: &[&'a str]) -> Option<&'a str> {
    match channel_flag {
        ["--channel", name] => Some(name),
        _ => None,
    }
}

pub fn spawn_detached(
    state_dir: &Path,
    channel_flag: &[&str],
    bin_dir: &Path,
    log_path: &Path,
    render_overrides: &crate::webview_render::AppliedOverrides,
) -> Result<(), String> {
    let open_log = || -> Result<std::fs::File, String> {
        if let Some(parent) = log_path.parent() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("creating log dir {}: {e}", parent.display()))?;
        }
        std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(log_path)
            .map_err(|e| format!("opening daemon log {}: {e}", log_path.display()))
    };

    let channel_env = channel_name_from_flag(channel_flag).unwrap_or("release");

    #[cfg(unix)]
    {
        let supervisor = bin_dir.join(supervisor_binary_name());
        let core = bin_dir.join(daemon_binary_name());
        if !supervisor.is_file() {
            return Err(format!(
                "cannot spawn a daemon: {} does not exist (bin dir: {})",
                supervisor.display(),
                bin_dir.display()
            ));
        }
        if !core.is_file() {
            return Err(format!(
                "cannot spawn a daemon: {} does not exist (bin dir: {})",
                core.display(),
                bin_dir.display()
            ));
        }
        let stdout_log = open_log()?;
        let stderr_log = stdout_log
            .try_clone()
            .map_err(|e| format!("cloning log fd: {e}"))?;
        let mut cmd = houston_core::spawn::command(&supervisor);
        render_overrides.remove_from_child(&mut cmd);
        cmd.arg("--channel-dir")
            .arg(state_dir)
            .arg("--daemon")
            .arg(&core)
            .arg("--")
            .args(channel_flag)
            .env(houston_core::paths::CHANNEL_ENV, channel_env)
            .stdin(std::process::Stdio::null())
            .stdout(stdout_log)
            .stderr(stderr_log);
        // SAFETY: `pre_exec` runs after fork, before exec, in the child only;
        // `setsid()` there only detaches it from this process's session.
        unsafe {
            use std::os::unix::process::CommandExt;
            cmd.pre_exec(|| {
                if libc::setsid() == -1 {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }
        cmd.spawn()
            .map_err(|e| format!("spawning {}: {e}", supervisor.display()))?;
        Ok(())
    }
    #[cfg(windows)]
    {
        let core = bin_dir.join(daemon_binary_name());
        if !core.is_file() {
            return Err(format!(
                "cannot spawn a daemon: {} does not exist (bin dir: {})",
                core.display(),
                bin_dir.display()
            ));
        }
        let stdout_log = open_log()?;
        let stderr_log = stdout_log
            .try_clone()
            .map_err(|e| format!("cloning log fd: {e}"))?;
        use std::os::windows::process::CommandExt;
        const DETACHED_PROCESS: u32 = 0x0000_0008;
        let mut cmd = houston_core::spawn::command(&core);
        render_overrides.remove_from_child(&mut cmd);
        cmd.args(channel_flag)
            .env(houston_core::paths::CHANNEL_ENV, channel_env)
            .stdin(std::process::Stdio::null())
            .stdout(stdout_log)
            .stderr(stderr_log)
            .creation_flags(houston_core::spawn::CREATE_NO_WINDOW | DETACHED_PROCESS);
        cmd.spawn()
            .map_err(|e| format!("spawning {}: {e}", core.display()))?;
        Ok(())
    }
}

pub const DAEMON_SPAWN_READY_TIMEOUT: Duration = Duration::from_secs(20);

pub async fn wait_for_daemon_ready(
    state_dir: &Path,
    timeout: Duration,
) -> Result<DaemonHandle, BootRefusal> {
    let client = manage_http_client();
    let deadline = std::time::Instant::now() + timeout;
    let daemon_json_path = state_dir.join("daemon.json");
    loop {
        let contents = fs::read_to_string(&daemon_json_path).ok();
        if let SingletonVerdict::Live { .. } =
            singleton_verdict(contents.as_deref(), &houston_core::pid::process_comm)
        {
            if let Some(cfg) =
                contents.and_then(|text| serde_json::from_str::<DaemonFileFields>(&text).ok())
            {
                if let Ok(status) = probe_daemon_status(&client, cfg.port, &cfg.token).await {
                    if status.protocol_version == houston_protocol::PROTOCOL_VERSION {
                        return Ok(DaemonHandle {
                            port: cfg.port,
                            token: cfg.token,
                            spawned: true,
                        });
                    }
                    return Err(BootRefusal::with_daemon(
                        protocol_mismatch_message(
                            status.protocol_version,
                            Some(status.live_sessions.count),
                        ),
                        cfg.port,
                        cfg.token,
                    ));
                }
            }
        }
        if std::time::Instant::now() >= deadline {
            return Err(BootRefusal::new(format!(
                "timed out after {}s waiting for the daemon to become ready at {} -- check the \
                 daemon log at the channel's log directory for why it did not start",
                timeout.as_secs(),
                daemon_json_path.display()
            )));
        }
        tokio::time::sleep(Duration::from_millis(150)).await;
    }
}

#[derive(Debug, Deserialize)]
struct DaemonFileFields {
    port: u16,
    token: String,
}

pub enum BootPrecheck {
    Attached(DaemonHandle),
    NeedsSpawn(StaleReason),
}

/// What this app process is: the daemon it attaches to must speak its wire
/// and come from its own build. A live daemon failing either is a leftover
/// from before an install or a rebuild, and gets handed off at startup.
#[derive(Debug, Clone, Copy)]
pub struct DaemonIdentity<'a> {
    pub protocol: u32,
    pub build: &'a str,
}

impl DaemonIdentity<'static> {
    pub fn current() -> Self {
        Self {
            protocol: houston_protocol::PROTOCOL_VERSION,
            build: houston_core::daemon::build_commit(),
        }
    }
}

fn identity_matches(
    status: &houston_protocol::ManageDaemonStatus,
    identity: &DaemonIdentity<'_>,
) -> bool {
    status.protocol_version == identity.protocol && status.build == identity.build
}

/// Why a path cannot be spawned as a daemon, if it cannot: it must exist, be a
/// regular file and be executable. Checked before either handoff asks, so a bad
/// candidate is a named refusal, never a supervisor spawn failure.
pub(crate) fn candidate_problem(candidate: &Path) -> Option<String> {
    let meta = match fs::metadata(candidate) {
        Ok(meta) => meta,
        Err(e) => return Some(format!("cannot be read: {e}")),
    };
    if !meta.is_file() {
        return Some("is not a regular file".to_string());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if meta.permissions().mode() & 0o111 == 0 {
            return Some("is not executable".to_string());
        }
    }
    None
}

pub async fn precheck(state_dir: &Path) -> Result<BootPrecheck, BootRefusal> {
    precheck_with(state_dir, &DaemonIdentity::current(), None).await
}

async fn precheck_with(
    state_dir: &Path,
    identity: &DaemonIdentity<'_>,
    candidate_override: Option<&Path>,
) -> Result<BootPrecheck, BootRefusal> {
    fs::create_dir_all(state_dir)
        .map_err(|e| BootRefusal::new(format!("creating {}: {e}", state_dir.display())))?;

    let daemon_json_path = state_dir.join("daemon.json");
    let contents = fs::read_to_string(&daemon_json_path).ok();
    match singleton_verdict(contents.as_deref(), &houston_core::pid::process_comm) {
        SingletonVerdict::Live { pid } => {
            let fields = contents
                .as_deref()
                .and_then(|text| serde_json::from_str::<DaemonFileFields>(text).ok())
                .ok_or_else(|| {
                    BootRefusal::new(format!(
                        "{} names a live pid {pid} but has no readable port/token",
                        daemon_json_path.display()
                    ))
                })?;
            let client = manage_http_client_with(PRECHECK_PROBE_TIMEOUT);
            let status = probe_daemon_status(&client, fields.port, &fields.token)
                .await
                .map_err(|e| {
                    BootRefusal::with_daemon(
                        format!(
                            "daemon.json names a live pid {pid}, but it did not answer an \
                             authenticated /manage probe within {}s: {e}. Refusing to spawn a \
                             second daemon on top of a possibly-live one; run --daemon-fresh, or \
                             if it is truly gone, remove {} and retry.",
                            PRECHECK_PROBE_TIMEOUT.as_secs(),
                            daemon_json_path.display()
                        ),
                        fields.port,
                        fields.token.clone(),
                    )
                })?;
            if identity_matches(&status, identity) {
                eprintln!(
                    "houston-tauri: attaching to the running daemon (pid {pid}, build {}, {} live \
                     session(s))",
                    status.build, status.live_sessions.count
                );
                return Ok(BootPrecheck::Attached(DaemonHandle {
                    port: fields.port,
                    token: fields.token,
                    spawned: false,
                }));
            }
            eprintln!(
                "houston-tauri: the running daemon (pid {pid}, build {}, protocol {}) is not this \
                 app's (build {}, protocol {}); handing the channel to this install's daemon",
                status.build, status.protocol_version, identity.build, identity.protocol
            );
            startup_handoff(
                state_dir,
                pid,
                &fields,
                &status,
                identity,
                candidate_override,
            )
            .await
        }
        SingletonVerdict::Stale(reason) => Ok(BootPrecheck::NeedsSpawn(reason)),
    }
}

/// Hand the live channel to this app's own sidecar (never the retiring
/// daemon's path). A same-wire refusal still attaches the app to the daemon
/// that is there; a wire difference is a named refusal, because it cannot.
async fn startup_handoff(
    state_dir: &Path,
    previous_pid: u32,
    fields: &DaemonFileFields,
    status: &houston_protocol::ManageDaemonStatus,
    identity: &DaemonIdentity<'_>,
    candidate_override: Option<&Path>,
) -> Result<BootPrecheck, BootRefusal> {
    let candidate = match candidate_override {
        Some(path) => path.to_path_buf(),
        None => {
            let exe = match std::env::current_exe() {
                Ok(exe) => exe,
                Err(e) => {
                    return after_failed_handoff(
                        status,
                        identity,
                        fields,
                        format!("resolving this app's own path: {e}"),
                    );
                }
            };
            spawn_bin_dir(&exe).join(daemon_binary_name())
        }
    };
    if let Some(problem) = candidate_problem(&candidate) {
        return after_failed_handoff(
            status,
            identity,
            fields,
            format!(
                "this install's daemon binary {} {problem}",
                candidate.display()
            ),
        );
    }
    let result = match request_candidate_handoff(state_dir, Some(&candidate)).await {
        Ok(result) => result,
        Err(e) => return after_failed_handoff(status, identity, fields, e),
    };
    if !result.accepted {
        let reason = result
            .reason
            .unwrap_or_else(|| "the daemon gave no reason".to_string());
        return after_failed_handoff(status, identity, fields, reason);
    }
    wait_for_handoff_successor(
        state_dir,
        previous_pid,
        identity,
        DAEMON_SPAWN_READY_TIMEOUT,
    )
    .await
}

fn after_failed_handoff(
    status: &houston_protocol::ManageDaemonStatus,
    identity: &DaemonIdentity<'_>,
    fields: &DaemonFileFields,
    reason: String,
) -> Result<BootPrecheck, BootRefusal> {
    if status.protocol_version == identity.protocol {
        eprintln!(
            "houston-tauri: keeping the running daemon (build {}): {reason}; attaching to it",
            status.build
        );
        return Ok(BootPrecheck::Attached(DaemonHandle {
            port: fields.port,
            token: fields.token.clone(),
            spawned: false,
        }));
    }
    Err(BootRefusal::with_daemon(
        format!(
            "Cannot attach: daemon protocol {}, app protocol {}; {} live session(s). Moving the \
             running daemon to this install's binary failed: {reason}. The daemon and every \
             session it owns are unchanged.",
            status.protocol_version, identity.protocol, status.live_sessions.count
        ),
        fields.port,
        fields.token.clone(),
    ))
}

/// Wait for the successor the handoff spawned: a different live pid, answering
/// a probe, on this app's wire. Another wire is an old daemon that re-spawned
/// itself instead of adopting the candidate; this app cannot attach to it.
async fn wait_for_handoff_successor(
    state_dir: &Path,
    previous_pid: u32,
    identity: &DaemonIdentity<'_>,
    timeout: Duration,
) -> Result<BootPrecheck, BootRefusal> {
    let client = manage_http_client();
    let deadline = Instant::now() + timeout;
    let daemon_json_path = state_dir.join("daemon.json");
    let mut wrong_wire: Option<u32> = None;
    loop {
        let contents = fs::read_to_string(&daemon_json_path).ok();
        if let SingletonVerdict::Live { pid } =
            singleton_verdict(contents.as_deref(), &houston_core::pid::process_comm)
        {
            if pid != previous_pid {
                if let Some(cfg) =
                    contents.and_then(|text| serde_json::from_str::<DaemonFileFields>(&text).ok())
                {
                    if let Ok(status) = probe_daemon_status(&client, cfg.port, &cfg.token).await {
                        if status.protocol_version == identity.protocol {
                            return Ok(BootPrecheck::Attached(DaemonHandle {
                                port: cfg.port,
                                token: cfg.token,
                                spawned: false,
                            }));
                        }
                        wrong_wire = Some(status.protocol_version);
                    }
                }
            }
        }
        if Instant::now() >= deadline {
            let detail = match wrong_wire {
                Some(protocol) => format!(
                    "the successor speaks protocol {protocol}, not this app's {}: the daemon \
                     re-spawned its own binary instead of adopting this install's. Stop that \
                     daemon and restart Houston, or keep the app that matches it",
                    identity.protocol
                ),
                None => format!(
                    "no new daemon generation answered at {} within {}s",
                    daemon_json_path.display(),
                    timeout.as_secs()
                ),
            };
            return Err(BootRefusal::new(format!(
                "the handoff was accepted, but {detail}"
            )));
        }
        tokio::time::sleep(Duration::from_millis(150)).await;
    }
}

pub async fn spawn_and_wait(
    state_dir: PathBuf,
    channel_flag: &[&str],
    reason: &StaleReason,
    render_overrides: &crate::webview_render::AppliedOverrides,
) -> Result<DaemonHandle, BootRefusal> {
    eprintln!("{}", stale_log_line(reason, &state_dir));
    let exe = std::env::current_exe()
        .map_err(|e| BootRefusal::new(format!("resolving this process's own exe path: {e}")))?;
    let bin_dir = spawn_bin_dir(&exe);
    let log_path = state_dir.join("logs").join("daemon.log");
    spawn_detached(
        &state_dir,
        channel_flag,
        &bin_dir,
        &log_path,
        render_overrides,
    )
    .map_err(BootRefusal::new)?;
    wait_for_daemon_ready(&state_dir, DAEMON_SPAWN_READY_TIMEOUT).await
}

// Deliberately a no-op: the app is a client of the daemon, not its owner.
// Quitting only detaches the socket -- the daemon keeps running the PTYs.
pub fn shutdown(_handle: &DaemonHandle) {}

#[cfg(unix)]
pub async fn wait_for_terminate_or_interrupt() {
    let mut sigterm = match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
    {
        Ok(sig) => sig,
        Err(err) => {
            eprintln!(
                "houston-tauri: failed to install a SIGTERM handler: {err}; an \
                     external kill(2)/systemd stop will now bypass the shutdown sequence \
                     (SIGINT/Ctrl+C is still handled)"
            );
            let _ = tokio::signal::ctrl_c().await;
            return;
        }
    };
    tokio::select! {
        _ = tokio::signal::ctrl_c() => {}
        _ = sigterm.recv() => {}
    }
}

#[cfg(windows)]
pub async fn wait_for_terminate_or_interrupt() {
    let _ = tokio::signal::ctrl_c().await;
}

pub fn react_to_terminate_signal(
    app_handle_present: bool,
    shutdown_fn: &mut dyn FnMut(),
    exit_via_app_handle_fn: &mut dyn FnMut(),
    exit_via_process_fn: &mut dyn FnMut(),
) {
    shutdown_fn();
    if app_handle_present {
        exit_via_app_handle_fn();
    } else {
        exit_via_process_fn();
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::disallowed_methods)]
    use super::*;

    #[cfg(unix)]
    fn core_bin_dir_if_built() -> Option<PathBuf> {
        let dir = Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()?
            .join("core")
            .join("target")
            .join("debug");
        (dir.join("houston-core").is_file() && dir.join("houston-supervisor").is_file())
            .then_some(dir)
    }

    #[test]
    fn the_release_channel_is_spelled_out_for_a_spawned_daemon() {
        assert_eq!(channel_name_from_flag(&[]), None);
        assert_eq!(channel_name_from_flag(&["--channel", "dev"]), Some("dev"));
        assert_eq!(
            channel_name_from_flag(&[]).unwrap_or("release"),
            "release",
            "an absent flag must spell the release channel, never leave the variable unset"
        );
    }

    #[cfg(unix)]
    struct ThrowawayChannel {
        dir: PathBuf,
        connection: Option<(u16, String)>,
    }

    #[cfg(unix)]
    impl Drop for ThrowawayChannel {
        fn drop(&mut self) {
            if let Some((port, token)) = self.connection.take() {
                let dir = self.dir.clone();
                let _ = std::thread::spawn(move || {
                    let rt = match tokio::runtime::Builder::new_current_thread()
                        .enable_all()
                        .build()
                    {
                        Ok(rt) => rt,
                        Err(_) => return,
                    };
                    rt.block_on(async {
                        let _ = manage_http_client()
                            .post(format!("http://127.0.0.1:{port}/manage"))
                            .header("Authorization", format!("Bearer {token}"))
                            .json(&serde_json::json!({
                                "manage_version": houston_protocol::MANAGE_VERSION,
                                "verb": "daemon_shutdown"
                            }))
                            .timeout(Duration::from_secs(10))
                            .send()
                            .await;
                    });
                    let _ = std::fs::remove_dir_all(&dir);
                })
                .join();
            } else {
                let _ = std::fs::remove_dir_all(&self.dir);
            }
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_spawned_daemon_outlives_the_task_and_the_session_that_spawned_it() {
        let Some(bin_dir) = core_bin_dir_if_built() else {
            eprintln!(
                "SKIPPED: core/target/debug/{{houston-core,houston-supervisor}} are not built;                  build them and re-run to exercise the detach guarantee"
            );
            return;
        };
        let channel = format!("detachtest-{}", std::process::id());
        let home = houston_core::home_dir::home_dir().expect("home dir");
        let state_dir = paths::dir_for(&home, Some(&channel));
        let mut guard = ThrowawayChannel {
            dir: state_dir.clone(),
            connection: None,
        };
        let log_path = state_dir.join("logs").join("daemon.log");

        let spawn_dir = state_dir.clone();
        let spawn_bin = bin_dir.clone();
        let spawn_log = log_path.clone();
        let spawn_channel = channel.clone();
        tokio::spawn(async move {
            spawn_detached(
                &spawn_dir,
                &["--channel", &spawn_channel],
                &spawn_bin,
                &spawn_log,
                &crate::webview_render::AppliedOverrides::default(),
            )
        })
        .await
        .expect("the spawning task itself must not panic")
        .expect("spawn_detached");

        let handle = wait_for_daemon_ready(&state_dir, Duration::from_secs(20))
            .await
            .unwrap_or_else(|e| {
                panic!(
                    "the spawned daemon must become ready: {}\n--- {} ---\n{}",
                    e.message,
                    log_path.display(),
                    fs::read_to_string(&log_path).unwrap_or_default()
                )
            });
        guard.connection = Some((handle.port, handle.token.clone()));

        let sup: serde_json::Value = serde_json::from_str(
            &fs::read_to_string(state_dir.join("supervisor.json")).expect("supervisor.json"),
        )
        .expect("supervisor.json parses");
        let sup_pid = sup["pid"].as_u64().expect("supervisor.json names a pid") as i32;
        // SAFETY: both are plain reads of kernel-maintained ids; neither takes
        // a pointer or has a failure mode worth checking here.
        let (sup_sid, own_sid) = unsafe { (libc::getsid(sup_pid), libc::getsid(0)) };
        assert_eq!(
            sup_sid, sup_pid,
            "the supervisor must lead its own session (setsid), not sit in this process's"
        );
        assert_ne!(
            sup_sid, own_sid,
            "a supervisor sharing this process's session dies with it"
        );
    }

    #[test]
    fn unrecognized_token_alone_is_rejected_and_named() {
        let args = vec!["houston-tauri".to_string(), "--nonsense".to_string()];
        let err = reject_unrecognized_args(&args).expect_err("must be rejected");
        assert_eq!(err.token, "--nonsense");
        assert!(err.message().contains("--nonsense"));
        assert!(
            err.message().contains("Accepted flags:"),
            "must list the accepted flags, got: {}",
            err.message()
        );
    }

    #[test]
    fn unrecognized_token_after_valid_flags_is_rejected_and_named() {
        let args = vec![
            "houston-tauri".to_string(),
            "--channel".to_string(),
            "dev".to_string(),
            "--print-target".to_string(),
            "garbage".to_string(),
        ];
        let err = reject_unrecognized_args(&args).expect_err("must be rejected");
        assert_eq!(err.token, "garbage");
    }

    #[test]
    fn unrecognized_token_alongside_channel_release_is_rejected() {
        let args = vec![
            "houston-tauri".to_string(),
            "--channel".to_string(),
            "release".to_string(),
            "--nonsense".to_string(),
        ];
        let err = reject_unrecognized_args(&args).expect_err("must be rejected");
        assert_eq!(err.token, "--nonsense");
    }

    #[test]
    fn every_accepted_flag_passes() {
        let cases: Vec<Vec<String>> = vec![
            vec![
                "bin".to_string(),
                "--channel".to_string(),
                "dev".to_string(),
            ],
            vec!["bin".to_string(), "--channel=dev".to_string()],
            vec!["bin".to_string(), "--print-target".to_string()],
            vec!["bin".to_string(), "--daemon-fresh".to_string()],
            vec!["bin".to_string(), "--spike-invoke".to_string()],
            vec!["bin".to_string(), "--spike-webview".to_string()],
            vec!["bin".to_string(), "--spike-webview-auto".to_string()],
            vec![
                "bin".to_string(),
                "--channel".to_string(),
                "dev".to_string(),
                "--daemon-fresh".to_string(),
            ],
        ];
        for args in cases {
            assert_eq!(
                reject_unrecognized_args(&args),
                Ok(()),
                "accepted argv {args:?} must not be rejected"
            );
        }
    }

    #[test]
    fn bench_is_accepted_only_with_the_feature() {
        let args = vec!["bin".to_string(), "--bench".to_string()];
        #[cfg(feature = "bench")]
        assert_eq!(
            reject_unrecognized_args(&args),
            Ok(()),
            "a --features bench build must accept --bench"
        );
        #[cfg(not(feature = "bench"))]
        {
            let err = reject_unrecognized_args(&args).expect_err("must be rejected");
            assert_eq!(err.token, "--bench");
            let message = err.message();
            let accepted_portion = message
                .split("Accepted flags: ")
                .nth(1)
                .expect("message must contain the accepted-flags list");
            assert!(
                !accepted_portion.contains("--bench"),
                "a default build's accepted-flags list must not advertise --bench, got: {message}"
            );
        }
    }

    #[test]
    fn bench_scenario_flag_is_accepted_only_with_the_feature() {
        let args = vec!["bin".to_string(), "--bench=M8".to_string()];
        #[cfg(feature = "bench")]
        assert_eq!(
            reject_unrecognized_args(&args),
            Ok(()),
            "a --features bench build must accept --bench=<list>"
        );
        #[cfg(not(feature = "bench"))]
        {
            let err = reject_unrecognized_args(&args).expect_err("must be rejected");
            assert_eq!(err.token, "--bench=M8");
        }
    }

    #[cfg(not(feature = "bench"))]
    #[test]
    fn bench_flag_present_catches_the_scenario_selector_shape() {
        assert!(bench_flag_present(&[
            "bin".to_string(),
            "--bench=M8".to_string()
        ]));
        assert!(bench_flag_present(&[
            "bin".to_string(),
            "--bench=M6,M7,M8".to_string()
        ]));
        assert!(bench_flag_present(&[
            "bin".to_string(),
            "--bench".to_string()
        ]));
        assert!(!bench_flag_present(&[
            "bin".to_string(),
            "--channel".to_string(),
            "dev".to_string()
        ]));
    }

    #[test]
    fn every_accepted_standalone_flag_starts_with_dashdash() {
        for flag in known_standalone_flags() {
            assert!(
                flag.starts_with("--"),
                "accepted flag {flag:?} does not start with \"--\": it could ALSO be a \
                 valid channel name, so --channel {flag:?} would swallow it as a value \
                 while main.rs's whole-argv scanners kept matching it as a flag -- the \
                 two guards would disagree about what the token is"
            );
        }
    }

    #[test]
    fn accepted_flags_description_matches_the_build() {
        let description = accepted_flags_description();
        #[cfg(feature = "bench")]
        assert!(
            description.contains("--bench"),
            "a --features bench build must advertise --bench, got: {description}"
        );
        #[cfg(not(feature = "bench"))]
        assert!(
            !description.contains("--bench"),
            "a default build must not advertise --bench, got: {description}"
        );
    }

    #[test]
    fn channel_value_that_looks_like_a_flag_is_consumed_not_flagged() {
        let args = vec![
            "bin".to_string(),
            "--print-target".to_string(),
            "--channel".to_string(),
            "--print-target".to_string(),
        ];
        assert_eq!(reject_unrecognized_args(&args), Ok(()));
    }

    #[test]
    fn no_args_beyond_the_binary_path_is_accepted() {
        assert_eq!(
            reject_unrecognized_args(&["houston-tauri".to_string()]),
            Ok(())
        );
    }

    #[test]
    fn debug_build_no_flag_defaults_to_dev() {
        assert_eq!(
            resolve_owning_channel(true, None),
            Ok(Some("dev".to_string())),
            "a debug build with no --channel flag must target dev, never release"
        );
    }

    #[test]
    fn debug_explicit_channel_dev_proceeds() {
        assert_eq!(
            resolve_owning_channel(true, Some("dev")),
            Ok(Some("dev".to_string()))
        );
    }

    #[test]
    fn debug_explicit_channel_release_proceeds() {
        assert_eq!(resolve_owning_channel(true, Some("release")), Ok(None));
    }

    #[test]
    fn release_build_no_flag_defaults_to_release() {
        assert_eq!(
            resolve_owning_channel(false, None),
            Ok(None),
            "a release build with no flags is the installed app booting normally"
        );
    }

    #[test]
    fn release_build_explicit_channel_dev_still_honoured() {
        assert_eq!(
            resolve_owning_channel(false, Some("dev")),
            Ok(Some("dev".to_string()))
        );
    }

    #[test]
    fn invalid_channel_value_is_named_in_the_error() {
        let err = resolve_owning_channel(true, Some("UPPER")).unwrap_err();
        let OwnershipRefusal::InvalidChannel { raw, .. } = &err;
        assert_eq!(raw, "UPPER");
        assert!(err.message().contains("UPPER"));
    }

    #[test]
    fn invalid_channel_flag_refusal_names_channel_flag_not_the_env_var() {
        let err = resolve_owning_channel(true, Some("--print-target")).unwrap_err();
        let message = err.message();
        assert!(
            message.contains("--channel \"--print-target\""),
            "must name --channel and the offending value, got: {message}"
        );
        assert!(
            !message.contains("HOUSTON_CHANNEL"),
            "must not blame the env var for a value that came from --channel, got: {message}"
        );
    }

    #[test]
    fn path_traversal_channel_value_is_rejected_and_named() {
        for bad in ["x/../.houston", "../etc", "a/b", "/abs"] {
            let err = resolve_owning_channel(true, Some(bad))
                .expect_err(&format!("{bad:?} must be refused"));
            assert!(
                err.message().contains(bad),
                "refusal must name the offending value {bad:?}, got: {}",
                err.message()
            );
        }
    }

    #[test]
    fn no_channel_flag_is_none() {
        let args = vec!["houston-tauri".to_string()];
        assert_eq!(parse_channel_flag(&args), Ok(None));
    }

    #[test]
    fn channel_flag_with_space_separated_value() {
        let args = vec![
            "houston-tauri".to_string(),
            "--channel".to_string(),
            "dev".to_string(),
        ];
        assert_eq!(parse_channel_flag(&args), Ok(Some("dev".to_string())));
    }

    #[test]
    fn channel_flag_with_equals_value() {
        let args = vec!["houston-tauri".to_string(), "--channel=release".to_string()];
        assert_eq!(parse_channel_flag(&args), Ok(Some("release".to_string())));
    }

    #[test]
    fn channel_flag_missing_value_is_an_error() {
        let args = vec!["houston-tauri".to_string(), "--channel".to_string()];
        assert_eq!(
            parse_channel_flag(&args),
            Err(ChannelFlagError::MissingValue)
        );
    }

    #[test]
    fn channel_flag_empty_value_is_an_error() {
        let args = vec![
            "houston-tauri".to_string(),
            "--channel".to_string(),
            "".to_string(),
        ];
        assert_eq!(
            parse_channel_flag(&args),
            Err(ChannelFlagError::EmptyValue("".to_string()))
        );

        let args_eq = vec!["houston-tauri".to_string(), "--channel=".to_string()];
        assert_eq!(
            parse_channel_flag(&args_eq),
            Err(ChannelFlagError::EmptyValue("".to_string()))
        );
    }

    #[test]
    fn channel_flag_whitespace_only_value_is_rejected_and_named() {
        for raw in [" ", "\t", "\n", "   ", "\t\n "] {
            let args = vec![
                "houston-tauri".to_string(),
                "--channel".to_string(),
                raw.to_string(),
            ];
            let err = parse_channel_flag(&args)
                .expect_err(&format!("{raw:?} must be rejected as whitespace-only"));
            assert_eq!(err, ChannelFlagError::EmptyValue(raw.to_string()));
            assert!(
                err.message().contains(&format!("{raw:?}")),
                "refusal must name the offending value {raw:?}, got: {}",
                err.message()
            );

            let args_eq = vec!["houston-tauri".to_string(), format!("--channel={raw}")];
            let err_eq = parse_channel_flag(&args_eq)
                .expect_err(&format!("--channel={raw:?} must be rejected"));
            assert_eq!(err_eq, ChannelFlagError::EmptyValue(raw.to_string()));
        }
    }

    #[test]
    fn repeated_channel_flag_last_occurrence_wins() {
        let args = vec![
            "houston-tauri".to_string(),
            "--channel".to_string(),
            "release".to_string(),
            "--channel".to_string(),
            "dev".to_string(),
        ];
        assert_eq!(
            parse_channel_flag(&args),
            Ok(Some("dev".to_string())),
            "the LAST --channel flag must win, matching dev.sh's last-wins argv loop"
        );
    }

    #[test]
    fn repeated_channel_flag_last_occurrence_wins_other_order() {
        let args = vec![
            "houston-tauri".to_string(),
            "--channel".to_string(),
            "dev".to_string(),
            "--channel".to_string(),
            "release".to_string(),
        ];
        assert_eq!(parse_channel_flag(&args), Ok(Some("release".to_string())));
    }

    #[test]
    fn repeated_channel_flag_last_wins_mixed_with_equals_form() {
        let spaced_then_equals = vec![
            "houston-tauri".to_string(),
            "--channel".to_string(),
            "dev".to_string(),
            "--channel=release".to_string(),
        ];
        assert_eq!(
            parse_channel_flag(&spaced_then_equals),
            Ok(Some("release".to_string())),
            "a later --channel=<value> must win over an earlier spaced --channel <value>"
        );

        let equals_then_spaced = vec![
            "houston-tauri".to_string(),
            "--channel=release".to_string(),
            "--channel".to_string(),
            "dev".to_string(),
        ];
        assert_eq!(
            parse_channel_flag(&equals_then_spaced),
            Ok(Some("dev".to_string())),
            "a later spaced --channel <value> must win over an earlier --channel=<value>"
        );
    }

    #[test]
    fn repeated_channel_flag_earlier_empty_value_is_superseded_by_a_later_valid_one() {
        let args = vec![
            "houston-tauri".to_string(),
            "--channel".to_string(),
            " ".to_string(),
            "--channel".to_string(),
            "dev".to_string(),
        ];
        assert_eq!(
            parse_channel_flag(&args),
            Ok(Some("dev".to_string())),
            "a later valid --channel must supersede an earlier whitespace-only one"
        );
    }

    #[test]
    fn print_target_flag_is_detected() {
        assert!(print_target_requested(&[
            "bin".to_string(),
            "--print-target".to_string()
        ]));
        assert!(!print_target_requested(&["bin".to_string()]));
    }

    #[test]
    fn release_warning_fires_for_every_spelling_that_resolves_to_release() {
        for raw in [
            "release",
            " release ",
            "release\n",
            "\trelease",
            "\t release\n",
        ] {
            let resolved = paths::validate_channel(raw)
                .unwrap_or_else(|e| panic!("{raw:?} expected to validate, got {e}"));
            assert_eq!(
                resolved, None,
                "{raw:?} expected to resolve to the release channel"
            );
            assert!(
                release_warning_needed(true, resolved.as_deref()),
                "input {raw:?} resolves to release but the warning did not fire"
            );
        }
    }

    #[test]
    fn release_warning_does_not_fire_without_an_explicit_flag_or_for_non_release_channels() {
        assert!(!release_warning_needed(false, None));
        let resolved = paths::validate_channel("dev").unwrap();
        assert!(!release_warning_needed(true, resolved.as_deref()));
    }

    #[test]
    fn normalize_maps_none_and_release_to_release() {
        assert_eq!(normalize_channel_label(None), "release");
        assert_eq!(normalize_channel_label(Some("release")), "release");
        assert_eq!(normalize_channel_label(Some("")), "release");
    }

    #[test]
    fn normalize_trims_whitespace_the_same_way_validate_channel_does() {
        assert_eq!(normalize_channel_label(Some("dev\n")), "dev");
        assert_eq!(normalize_channel_label(Some(" dev ")), "dev");
    }

    #[test]
    fn missing_daemon_json_is_stale() {
        let verdict = singleton_verdict(None, &|_| None);
        assert_eq!(verdict, SingletonVerdict::Stale(StaleReason::Missing));
    }

    #[test]
    fn unparseable_daemon_json_is_stale() {
        let verdict = singleton_verdict(Some("not json"), &|_| None);
        match verdict {
            SingletonVerdict::Stale(StaleReason::Unparseable { snippet }) => {
                assert_eq!(snippet, "not json");
            }
            other => panic!("expected Unparseable, got {other:?}"),
        }
    }

    #[test]
    fn missing_pid_field_is_unparseable() {
        let verdict = singleton_verdict(Some(r#"{"port":1}"#), &|_| None);
        assert!(matches!(
            verdict,
            SingletonVerdict::Stale(StaleReason::Unparseable { .. })
        ));
    }

    #[test]
    fn dead_pid_is_stale() {
        let verdict = singleton_verdict(Some(r#"{"pid":4242}"#), &|pid| {
            assert_eq!(pid, 4242);
            None
        });
        assert_eq!(
            verdict,
            SingletonVerdict::Stale(StaleReason::Dead { pid: 4242 })
        );
    }

    #[test]
    fn live_houston_core_pid_refuses() {
        let verdict =
            singleton_verdict(Some(r#"{"pid":99}"#), &|_| Some("houston-core".to_string()));
        assert_eq!(verdict, SingletonVerdict::Live { pid: 99 });
    }

    #[test]
    fn live_truncated_houston_tauri_comm_refuses() {
        let verdict = singleton_verdict(Some(r#"{"pid":99}"#), &|_| Some("houston-ta".to_string()));
        assert_eq!(verdict, SingletonVerdict::Live { pid: 99 });
    }

    #[test]
    fn live_recycled_pid_with_unrelated_comm_is_stale() {
        let verdict = singleton_verdict(Some(r#"{"pid":99}"#), &|_| Some("sleep".to_string()));
        match verdict {
            SingletonVerdict::Stale(StaleReason::Recycled { pid, comm }) => {
                assert_eq!(pid, 99);
                assert_eq!(comm, "sleep");
            }
            other => panic!("expected Recycled, got {other:?}"),
        }
    }

    #[test]
    fn stale_log_line_names_the_shape_and_state_dir() {
        let dir = Path::new("/home/tester/.houston-dev");
        let line = stale_log_line(&StaleReason::Dead { pid: 7 }, dir);
        assert!(line.contains("7"));
        assert!(line.contains(&dir.join("daemon.json").display().to_string()));
        assert!(line.contains("dead pid"));

        let line = stale_log_line(
            &StaleReason::Recycled {
                pid: 8,
                comm: "sleep".to_string(),
            },
            dir,
        );
        assert!(line.contains('8'));
        assert!(line.contains("sleep"));
        assert!(line.contains("recycled pid"));
    }

    #[test]
    fn self_protection_refuses_when_session_set_and_channel_matches() {
        assert!(daemon_fresh_self_protection(Some("sess-1"), "dev", "dev"));
    }

    #[test]
    fn self_protection_allows_when_no_session() {
        assert!(!daemon_fresh_self_protection(None, "dev", "dev"));
    }

    #[test]
    fn self_protection_allows_when_channel_differs() {
        assert!(!daemon_fresh_self_protection(
            Some("sess-1"),
            "release",
            "dev"
        ));
    }

    #[test]
    fn self_protection_normalizes_whitespace_so_it_no_longer_fails_open() {
        let pane_raw = Some("dev\n");
        let target_channel = Some("dev".to_string());
        let pane_normalized = normalize_channel_label(pane_raw);
        let target_normalized = normalize_channel_label(target_channel.as_deref());
        assert_eq!(pane_normalized, "dev");
        assert_eq!(target_normalized, "dev");
        assert!(
            daemon_fresh_self_protection(Some("sess-1"), &pane_normalized, &target_normalized),
            "normalized 'dev\\n' pane must match normalized 'dev' target and refuse"
        );
    }

    #[cfg(windows)]
    #[test]
    fn terminate_and_wait_identity_refuses_a_mismatched_creation_token() {
        let mut child = std::process::Command::new("cmd")
            .args(["/C", "ping", "-n", "30", "127.0.0.1"])
            .spawn()
            .expect("spawn fixture process");
        let pid = child.id();
        struct KillOnDrop(u32);
        impl Drop for KillOnDrop {
            fn drop(&mut self) {
                let _ = houston_core::pid::signal_process(self.0, houston_core::pid::Signal::Kill);
            }
        }
        let _guard = KillOnDrop(pid);

        let real_token = houston_core::pid::process_creation_token(pid)
            .expect("a just-spawned live process has a creation token");
        let err = daemon_host_terminate_identity_for_test(pid, Some(real_token.wrapping_add(1)));
        assert!(
            err.contains("RECYCLED"),
            "refusal must name the recycle: {err}"
        );
        assert!(
            child.try_wait().unwrap().is_none(),
            "the mismatched-token fixture must be untouched"
        );
        terminate_and_wait_identity(pid, Some(real_token), Duration::from_secs(3), &|p| {
            houston_core::pid::process_comm(p)
        })
        .expect("a matching-token terminate must deliver");
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while child.try_wait().unwrap().is_none() {
            assert!(
                std::time::Instant::now() < deadline,
                "fixture did not exit after a matching-token terminate"
            );
            std::thread::sleep(Duration::from_millis(50));
        }
    }

    #[cfg(windows)]
    fn daemon_host_terminate_identity_for_test(pid: u32, expected: Option<u64>) -> String {
        eprintln!(
            "IDENTITY-DBG pid={pid} expected={expected:?} actual={:?}",
            houston_core::pid::process_creation_token(pid)
        );
        terminate_and_wait_identity(pid, expected, Duration::from_secs(3), &|p| {
            houston_core::pid::process_comm(p)
        })
        .expect_err("the mismatch case must fail")
    }

    #[test]
    fn fallback_path_runs_shutdown_before_process_exit() {
        let order: std::cell::RefCell<Vec<&str>> = std::cell::RefCell::new(Vec::new());
        react_to_terminate_signal(
            false,
            &mut || order.borrow_mut().push("shutdown"),
            &mut || order.borrow_mut().push("exit_via_app_handle"),
            &mut || order.borrow_mut().push("exit_via_process"),
        );
        assert_eq!(
            *order.borrow(),
            vec!["shutdown", "exit_via_process"],
            "the no-AppHandle fallback must run shutdown() BEFORE std::process::exit"
        );
    }

    #[test]
    fn published_handle_path_also_runs_shutdown_first() {
        let order: std::cell::RefCell<Vec<&str>> = std::cell::RefCell::new(Vec::new());
        react_to_terminate_signal(
            true,
            &mut || order.borrow_mut().push("shutdown"),
            &mut || order.borrow_mut().push("exit_via_app_handle"),
            &mut || order.borrow_mut().push("exit_via_process"),
        );
        assert_eq!(*order.borrow(), vec!["shutdown", "exit_via_app_handle"]);
    }

    #[test]
    fn shutdown_touches_nothing_and_is_safe_to_call_repeatedly_and_concurrently() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let state_dir = tmp.path().to_path_buf();
        let daemon_json = state_dir.join("daemon.json");
        fs::write(&daemon_json, "{\"pid\":123}").expect("seed daemon.json");

        let handle = std::sync::Arc::new(DaemonHandle {
            port: 0,
            token: "test-token".to_string(),
            spawned: false,
        });

        let t1 = std::thread::spawn({
            let handle = handle.clone();
            move || shutdown(&handle)
        });
        let t2 = std::thread::spawn({
            let handle = handle.clone();
            move || shutdown(&handle)
        });
        t1.join().expect("first caller must not panic");
        t2.join().expect("second caller must not panic");
        shutdown(&handle);

        assert!(
            daemon_json.exists(),
            "shutdown() must never remove daemon.json -- only the daemon's own orderly exit does"
        );
    }

    #[test]
    fn terminate_and_wait_refuses_pids_that_are_kill_broadcasts() {
        for (pid, what) in [
            (
                u32::MAX,
                "u32::MAX, which casts to -1 = every signallable process",
            ),
            (0, "0 = this process group"),
            (i32::MAX as u32 + 1, "one past pid_t's positive range"),
        ] {
            let err = terminate_and_wait_identity(pid, None, Duration::from_secs(1), &|_| {
                panic!("alive() must never be reached for an unusable pid ({what})")
            })
            .expect_err("an unusable pid must be refused, not signalled");
            assert!(
                err.contains(&pid.to_string()),
                "refusal must name the offending pid {pid} ({what}), got: {err}"
            );
        }
    }

    #[test]
    fn terminate_and_wait_returns_ok_when_the_pid_is_already_gone() {
        let mut child = std::process::Command::new("true")
            .spawn()
            .expect("spawn `true`");
        let pid = child.id();
        child.wait().expect("reap child");

        let result = terminate_and_wait_identity(pid, None, Duration::from_secs(1), &|_| None);
        assert!(
            result.is_ok(),
            "a reaped pid must be treated as already gone, got: {result:?}"
        );
    }

    #[test]
    fn protocol_mismatch_message_names_both_versions_and_the_session_count() {
        let msg = protocol_mismatch_message(61, Some(3));
        assert!(msg.contains("61"), "must name the daemon's protocol: {msg}");
        assert!(
            msg.contains(&houston_protocol::PROTOCOL_VERSION.to_string()),
            "must name this app's protocol: {msg}"
        );
        assert!(msg.contains('3'), "must name the live session count: {msg}");
        assert!(
            !msg.to_lowercase().contains("unknown"),
            "a known count must not also say unknown: {msg}"
        );
    }

    #[test]
    fn protocol_mismatch_message_names_the_session_count_as_unknown_when_not_available() {
        let msg = protocol_mismatch_message(61, None);
        assert!(
            msg.contains("unknown"),
            "an unknown session count must say so, got: {msg}"
        );
    }

    // The three spawn_bin_dir tests mutate one process-wide env var, so they
    // take one module-level lock rather than a per-test one that never meets.
    static SPAWN_BIN_DIR_ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    #[test]
    fn spawn_bin_dir_prefers_the_env_override() {
        let _guard = SPAWN_BIN_DIR_ENV_LOCK.lock().unwrap();

        std::env::set_var(DAEMON_BIN_DIR_ENV, "/tmp/some-debug-dir");
        let result = spawn_bin_dir(Path::new("/opt/houston/houston"));
        std::env::remove_var(DAEMON_BIN_DIR_ENV);
        assert_eq!(result, PathBuf::from("/tmp/some-debug-dir"));
    }

    #[test]
    fn spawn_bin_dir_falls_back_to_the_exes_own_directory() {
        let _guard = SPAWN_BIN_DIR_ENV_LOCK.lock().unwrap();

        std::env::remove_var(DAEMON_BIN_DIR_ENV);
        let result = spawn_bin_dir(Path::new("/opt/houston/houston"));
        assert_eq!(result, PathBuf::from("/opt/houston"));
    }

    #[test]
    fn spawn_bin_dir_treats_a_blank_override_as_unset() {
        let _guard = SPAWN_BIN_DIR_ENV_LOCK.lock().unwrap();

        std::env::set_var(DAEMON_BIN_DIR_ENV, "   ");
        let result = spawn_bin_dir(Path::new("/opt/houston/houston"));
        std::env::remove_var(DAEMON_BIN_DIR_ENV);
        assert_eq!(result, PathBuf::from("/opt/houston"));
    }

    const STATUS_WITH_THREE_SESSIONS: &str = r#"{"manage_version":1,"protocol_version":106,"build":"test","pid":1,"started_at":"2026-01-01T00:00:00Z","live_sessions":{"count":3,"ids":[1,2,3]},"routines_enabled":0,"clients_connected":0,"handoff":{"supported":false,"reason":""},"reap":{"armed":false,"deadline_ms":null}}"#;

    const ACCEPTED_HANDOFF: &str =
        r#"{"accepted":true,"reason":null,"generation":2,"sessions_transferred":2}"#;

    /// One-shot `/manage` responder. Writes a daemon.json naming this test
    /// process as the live daemon (its comm starts with "houston", so the
    /// singleton verdict reads it as one) and returns the request it saw.
    async fn serve_manage_once(
        dir: &Path,
        status_line: &'static str,
        response_body: &'static str,
    ) -> tokio::task::JoinHandle<String> {
        let seen =
            serve_manage_sequence(dir, std::process::id(), vec![(status_line, response_body)])
                .await;
        tokio::spawn(async move {
            seen.await
                .unwrap_or_default()
                .into_iter()
                .next()
                .unwrap_or_default()
        })
    }

    /// `/manage` responder for `responses.len()` requests, answering the nth
    /// with the nth pair. Writes a daemon.json naming `pid` (the caller decides
    /// whether that pid is alive) and returns every request body it saw.
    async fn serve_manage_sequence(
        dir: &Path,
        pid: u32,
        responses: Vec<(&'static str, &'static str)>,
    ) -> tokio::task::JoinHandle<Vec<String>> {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        std::fs::write(
            dir.join("daemon.json"),
            format!(r#"{{"pid":{pid},"port":{port},"token":"fake-manage-token"}}"#),
        )
        .unwrap();
        tokio::spawn(async move {
            let mut seen = Vec::new();
            for (status_line, response_body) in responses {
                let (mut sock, _) = listener.accept().await.unwrap();
                let mut buf: Vec<u8> = Vec::new();
                let mut tmp = [0u8; 4096];
                loop {
                    let n = sock.read(&mut tmp).await.unwrap_or(0);
                    if n == 0 {
                        break;
                    }
                    buf.extend_from_slice(&tmp[..n]);
                    let text = String::from_utf8_lossy(&buf);
                    if let Some(head_end) = text.find("\r\n\r\n") {
                        let content_length = text[..head_end]
                            .lines()
                            .find_map(|l| {
                                l.to_ascii_lowercase()
                                    .strip_prefix("content-length:")
                                    .map(str::trim)
                                    .and_then(|v| v.parse::<usize>().ok())
                            })
                            .unwrap_or(0);
                        if buf.len() >= head_end + 4 + content_length {
                            break;
                        }
                    }
                }
                let response = format!(
                    "HTTP/1.1 {status_line}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    response_body.len(),
                    response_body
                );
                let _ = sock.write_all(response.as_bytes()).await;
                let _ = sock.shutdown().await;
                seen.push(String::from_utf8_lossy(&buf).into_owned());
            }
            seen
        })
    }

    #[tokio::test]
    async fn probe_live_sessions_reports_the_count_a_live_daemon_reports() {
        let dir = tempfile::tempdir().unwrap();
        let server = serve_manage_once(dir.path(), "200 OK", STATUS_WITH_THREE_SESSIONS).await;
        let live = probe_live_sessions(dir.path())
            .await
            .expect("the fake daemon answers")
            .expect("a live daemon");
        assert_eq!(live.count, 3);
        assert_eq!(live.ids, vec![1, 2, 3]);
        server.await.unwrap();
    }

    #[tokio::test]
    async fn probe_live_sessions_is_none_without_a_live_daemon() {
        let dir = tempfile::tempdir().unwrap();
        assert!(probe_live_sessions(dir.path()).await.unwrap().is_none());
        std::fs::write(
            dir.path().join("daemon.json"),
            r#"{"pid":999999999,"port":1,"token":"t","comm":"not-houston"}"#,
        )
        .unwrap();
        assert!(
            probe_live_sessions(dir.path()).await.unwrap().is_none(),
            "a dead or recycled pid names no live daemon"
        );
    }

    #[tokio::test]
    async fn request_candidate_handoff_sends_the_candidate_and_parses_acceptance() {
        let dir = tempfile::tempdir().unwrap();
        let server = serve_manage_once(dir.path(), "200 OK", ACCEPTED_HANDOFF).await;
        let candidate = Path::new("/usr/bin/houston-core");
        let result = request_candidate_handoff(dir.path(), Some(candidate))
            .await
            .expect("the fake daemon answers");
        assert!(result.accepted);
        assert_eq!(result.sessions_transferred, Some(2));
        let request = server.await.expect("the responder task finished");
        assert!(
            request.contains(r#""candidate_bin":"/usr/bin/houston-core""#),
            "the request must carry the candidate path: {request}"
        );
        assert!(
            request.contains(r#""verb":"daemon_handoff""#),
            "the request must be a handoff: {request}"
        );
    }

    #[tokio::test]
    async fn request_candidate_handoff_rejects_a_non_success_response_by_name() {
        let dir = tempfile::tempdir().unwrap();
        let server = serve_manage_once(
            dir.path(),
            "409 CONFLICT",
            r#"{"error":"manage version mismatch: daemon 1, caller 9"}"#,
        )
        .await;
        let err = request_candidate_handoff(dir.path(), None)
            .await
            .expect_err("a non-success status must be an error");
        assert!(
            err.contains("refused") && err.contains("manage version mismatch"),
            "{err}"
        );
        let _ = server.await;
    }

    #[tokio::test]
    async fn retire_daemon_for_update_accepts_a_daemon_that_exited_before_it_was_asked() {
        let dir = tempfile::tempdir().unwrap();
        let port = {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            listener.local_addr().unwrap().port()
        };
        std::fs::write(
            dir.path().join("daemon.json"),
            format!(r#"{{"pid":4242,"port":{port},"token":"t"}}"#),
        )
        .unwrap();
        let calls = std::sync::atomic::AtomicUsize::new(0);
        let alive = |pid: u32| {
            (pid == 4242 && calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst) == 0)
                .then(|| "houston-core".to_string())
        };
        retire_daemon_for_update_with(dir.path(), "dev", &alive, Duration::from_secs(1))
            .await
            .expect(
                "a pid that is already gone needs no retirement and must not block the install",
            );
    }

    #[tokio::test]
    async fn retire_daemon_for_update_refuses_when_the_daemon_reports_live_sessions() {
        let dir = tempfile::tempdir().unwrap();
        let server = serve_manage_once(
            dir.path(),
            "200 OK",
            r#"{"ok":false,"error":"refusing to stop: 2 live session(s) are running (ids [1, 2]); an update must not kill them, and nothing was stopped","unterminated":[1,2]}"#,
        )
        .await;
        let alive = |_pid: u32| Some("houston-core".to_string());
        let err = retire_daemon_for_update_with(dir.path(), "dev", &alive, Duration::from_secs(1))
            .await
            .expect_err("a daemon holding live sessions must refuse to retire");
        assert!(
            err.contains("2 live session(s)") && err.contains("no session was stopped"),
            "the refusal must carry the daemon's own count and say nothing was stopped: {err}"
        );
        assert!(
            err.contains("dev"),
            "the refusal must name the channel it is about: {err}"
        );
        let request = server.await.unwrap();
        assert!(
            request.contains(r#""verb":"daemon_shutdown_if_idle""#),
            "the updater must use the refuse-if-live verb, never plain daemon_shutdown: {request}"
        );
    }

    #[tokio::test]
    async fn retire_daemon_for_update_refuses_a_daemon_that_predates_the_verb() {
        let dir = tempfile::tempdir().unwrap();
        let server = serve_manage_once(
            dir.path(),
            "400 BAD REQUEST",
            r#"{"error":"invalid manage request: unknown variant `daemon_shutdown_if_idle`, expected one of `daemon_status`, `daemon_shutdown`, `daemon_handoff`"}"#,
        )
        .await;
        let alive = |_pid: u32| Some("houston-core".to_string());
        let err =
            retire_daemon_for_update_with(dir.path(), "release", &alive, Duration::from_secs(1))
                .await
                .expect_err("an older daemon cannot answer the retire request");
        assert!(
            err.contains("stop the daemon from the tray") && err.contains("retry the install"),
            "an old daemon must produce the manual-update refusal: {err}"
        );
        let _ = server.await;
    }

    #[tokio::test]
    async fn retire_daemon_for_update_waits_for_the_retired_pid_and_confirms_the_channel_empty() {
        let dir = tempfile::tempdir().unwrap();
        let server = serve_manage_once(
            dir.path(),
            "200 OK",
            r#"{"ok":true,"stopped_sessions":0,"disarmed_routines":0}"#,
        )
        .await;
        let live = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(true));
        let flipper = std::sync::Arc::clone(&live);
        let pid = 4242u32;
        tokio::spawn(async move {
            server.await.unwrap();
            flipper.store(false, std::sync::atomic::Ordering::SeqCst);
        });
        let alive = move |asked: u32| {
            (asked == pid && live.load(std::sync::atomic::Ordering::SeqCst))
                .then(|| "houston-core".to_string())
        };
        retire_daemon_for_update_with(dir.path(), "dev", &alive, Duration::from_secs(5))
            .await
            .expect("the retired daemon exits and the updater confirms it");
    }

    #[tokio::test]
    async fn wait_for_daemon_exit_refuses_a_new_generation_owning_the_channel() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("daemon.json"),
            r#"{"pid":7777,"port":1,"token":"t"}"#,
        )
        .unwrap();
        let alive = |pid: u32| (pid == 7777).then(|| "houston-core".to_string());
        let err = wait_for_daemon_exit(
            &dir.path().join("daemon.json"),
            4242,
            "dev",
            Duration::from_millis(200),
            &alive,
        )
        .await
        .expect_err("a different live generation must not read as success");
        assert!(
            err.contains("7777") && err.contains("new daemon generation"),
            "the refusal must name the successor and why the install stopped: {err}"
        );
    }

    #[tokio::test]
    async fn wait_for_daemon_exit_times_out_naming_the_pid_that_would_not_leave() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("daemon.json"),
            r#"{"pid":4242,"port":1,"token":"t"}"#,
        )
        .unwrap();
        let alive = |_pid: u32| Some("houston-core".to_string());
        let err = wait_for_daemon_exit(
            &dir.path().join("daemon.json"),
            4242,
            "dev",
            Duration::from_millis(150),
            &alive,
        )
        .await
        .expect_err("a wedged daemon must refuse, not wait forever");
        assert!(
            err.contains("4242") && err.contains("did not exit") && err.contains("houston-core"),
            "the timeout must name the pid and the binary it blocks: {err}"
        );
    }

    fn status_with(protocol: u32, build: &str) -> houston_protocol::ManageDaemonStatus {
        houston_protocol::ManageDaemonStatus {
            manage_version: houston_protocol::MANAGE_VERSION,
            protocol_version: protocol,
            build: build.to_string(),
            pid: 1,
            started_at: "2026-01-01T00:00:00Z".to_string(),
            live_sessions: houston_protocol::ManageLiveSessions {
                count: 0,
                ids: Vec::new(),
            },
            routines_enabled: 0,
            clients_connected: 0,
            handoff: houston_protocol::ManageHandoffInfo {
                supported: false,
                reason: String::new(),
            },
            reap: houston_protocol::ManageReapInfo {
                armed: false,
                deadline_ms: None,
            },
        }
    }

    #[test]
    fn an_identity_matches_only_the_same_wire_and_build() {
        let identity = DaemonIdentity {
            protocol: 106,
            build: "abc1234",
        };
        assert!(identity_matches(&status_with(106, "abc1234"), &identity));
        assert!(
            !identity_matches(&status_with(105, "abc1234"), &identity),
            "a protocol difference alone must trigger the startup handoff"
        );
        assert!(
            !identity_matches(&status_with(106, "def5678"), &identity),
            "a build difference alone must trigger the startup handoff"
        );
    }

    #[cfg(unix)]
    fn daemon_json_pid(state_dir: &Path) -> Option<u32> {
        let raw = fs::read_to_string(state_dir.join("daemon.json")).ok()?;
        let value: serde_json::Value = serde_json::from_str(&raw).ok()?;
        value["pid"].as_u64().map(|pid| pid as u32)
    }

    #[cfg(unix)]
    fn copy_of_the_core_binary() -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let candidate = dir.path().join("houston-core-app-sidecar");
        let source = Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .join("core")
            .join("target")
            .join("debug")
            .join("houston-core");
        std::fs::copy(&source, &candidate).expect("copying the daemon binary");
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&candidate, std::fs::Permissions::from_mode(0o755)).unwrap();
        (dir, candidate)
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn startup_precheck_hands_a_mismatched_daemon_to_this_apps_candidate() {
        let Some(bin_dir) = core_bin_dir_if_built() else {
            eprintln!(
                "SKIPPED: core/target/debug/{{houston-core,houston-supervisor}} are not built; \
                 build them and re-run to exercise the startup handoff"
            );
            return;
        };
        let channel = format!("starthandoff-{}", std::process::id());
        let home = houston_core::home_dir::home_dir().expect("home dir");
        let state_dir = paths::dir_for(&home, Some(&channel));
        let mut guard = ThrowawayChannel {
            dir: state_dir.clone(),
            connection: None,
        };
        let log_path = state_dir.join("logs").join("daemon.log");
        spawn_detached(
            &state_dir,
            &["--channel", &channel],
            &bin_dir,
            &log_path,
            &crate::webview_render::AppliedOverrides::default(),
        )
        .expect("spawn_detached");
        let handle = wait_for_daemon_ready(&state_dir, DAEMON_SPAWN_READY_TIMEOUT)
            .await
            .expect("the spawned daemon becomes ready");
        guard.connection = Some((handle.port, handle.token.clone()));
        let before_pid = daemon_json_pid(&state_dir).expect("daemon.json names a pid");

        // A stand-in for this app's own sidecar: the real daemon binary at a
        // path nothing runs from, so /proc/<pid>/exe proves which one the
        // startup handoff spawned — never the retiring daemon's own path.
        let (_candidate_dir, candidate) = copy_of_the_core_binary();
        // The build differs, which is what a rebuild or an install leaves
        // behind; the protocol-mismatch trigger is the same decision and is
        // pinned in `an_identity_matches_only_the_same_wire_and_build`.
        let identity = DaemonIdentity {
            protocol: houston_protocol::PROTOCOL_VERSION,
            build: "not-the-running-daemons-build",
        };
        let verdict = precheck_with(&state_dir, &identity, Some(&candidate))
            .await
            .expect("precheck hands off instead of refusing");
        let BootPrecheck::Attached(attached) = verdict else {
            panic!("expected Attached after the startup handoff");
        };
        assert_eq!(
            attached.port, handle.port,
            "a handoff preserves the channel's port"
        );

        let after_pid = daemon_json_pid(&state_dir).expect("daemon.json names the successor");
        assert_ne!(
            after_pid, before_pid,
            "a new generation must own the channel"
        );
        let exe = std::fs::read_link(format!("/proc/{after_pid}/exe")).expect("/proc/<pid>/exe");
        assert_eq!(
            exe, candidate,
            "the successor must be this app's candidate, never the retiring daemon's path"
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn startup_precheck_keeps_a_same_wire_daemon_when_the_handoff_cannot_run() {
        let Some(bin_dir) = core_bin_dir_if_built() else {
            eprintln!("SKIPPED: core daemon binaries are not built");
            return;
        };
        let channel = format!("startfallback-{}", std::process::id());
        let home = houston_core::home_dir::home_dir().expect("home dir");
        let state_dir = paths::dir_for(&home, Some(&channel));
        let mut guard = ThrowawayChannel {
            dir: state_dir.clone(),
            connection: None,
        };
        let log_path = state_dir.join("logs").join("daemon.log");
        spawn_detached(
            &state_dir,
            &["--channel", &channel],
            &bin_dir,
            &log_path,
            &crate::webview_render::AppliedOverrides::default(),
        )
        .expect("spawn_detached");
        let handle = wait_for_daemon_ready(&state_dir, DAEMON_SPAWN_READY_TIMEOUT)
            .await
            .expect("the spawned daemon becomes ready");
        guard.connection = Some((handle.port, handle.token.clone()));
        let before_pid = daemon_json_pid(&state_dir).expect("daemon.json names a pid");

        let missing = tempfile::tempdir().unwrap().path().join("houston-core");
        let identity = DaemonIdentity {
            protocol: houston_protocol::PROTOCOL_VERSION,
            build: "not-the-running-daemons-build",
        };
        let verdict = precheck_with(&state_dir, &identity, Some(&missing))
            .await
            .expect("same wire: the app runs against the daemon that is there");
        let BootPrecheck::Attached(attached) = verdict else {
            panic!("expected Attached to the old daemon");
        };
        assert_eq!(attached.port, handle.port);
        assert_eq!(attached.token, handle.token);
        assert_eq!(
            daemon_json_pid(&state_dir),
            Some(before_pid),
            "a failed handoff must leave the old generation owning the channel"
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn startup_precheck_refuses_a_cross_wire_daemon_it_cannot_move() {
        let Some(bin_dir) = core_bin_dir_if_built() else {
            eprintln!("SKIPPED: core daemon binaries are not built");
            return;
        };
        let channel = format!("startrefusal-{}", std::process::id());
        let home = houston_core::home_dir::home_dir().expect("home dir");
        let state_dir = paths::dir_for(&home, Some(&channel));
        let mut guard = ThrowawayChannel {
            dir: state_dir.clone(),
            connection: None,
        };
        let log_path = state_dir.join("logs").join("daemon.log");
        spawn_detached(
            &state_dir,
            &["--channel", &channel],
            &bin_dir,
            &log_path,
            &crate::webview_render::AppliedOverrides::default(),
        )
        .expect("spawn_detached");
        let handle = wait_for_daemon_ready(&state_dir, DAEMON_SPAWN_READY_TIMEOUT)
            .await
            .expect("the spawned daemon becomes ready");
        guard.connection = Some((handle.port, handle.token.clone()));
        let before_pid = daemon_json_pid(&state_dir).expect("daemon.json names a pid");

        let missing = tempfile::tempdir().unwrap().path().join("houston-core");
        let identity = DaemonIdentity {
            protocol: houston_protocol::PROTOCOL_VERSION.wrapping_add(1),
            build: "not-the-running-daemons-build",
        };
        let refusal = match precheck_with(&state_dir, &identity, Some(&missing)).await {
            Ok(_) => panic!("cross wire: the app cannot attach and cannot move it"),
            Err(refusal) => refusal,
        };
        assert!(
            refusal.message.contains("Moving the running daemon"),
            "{}",
            refusal.message
        );
        assert!(
            refusal.message.contains("houston-core"),
            "the refusal must name the candidate: {}",
            refusal.message
        );
        assert_eq!(
            daemon_json_pid(&state_dir),
            Some(before_pid),
            "a refused startup handoff must leave the old generation owning the channel"
        );
    }
}
