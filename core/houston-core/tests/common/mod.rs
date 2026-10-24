#![allow(clippy::disallowed_methods)]
#![allow(dead_code)]

use base64::Engine;
use futures_util::{SinkExt, StreamExt};
use houston_core::daemon::{Daemon, DaemonConfig};
use houston_core::server;
use houston_protocol as proto;
use std::time::Duration;
use tokio_tungstenite::tungstenite::Message;

pub type WsStream =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

pub const TOKEN: &str = "test-token-0000-0000-000000000000";

/// The test process's own environment: re-exec markers and what a fixture must forward.
/// Anything the daemon should see goes through `HostEnv` instead.
/// Points the daemon's `test-barriers` pauses at `dir` for this test process.
#[cfg(feature = "test-barriers")]
pub fn set_test_barrier_dir(dir: &std::path::Path) {
    std::env::set_var("HOUSTON_TEST_BARRIER_DIR", dir);
}

pub fn process_var_os(name: &str) -> Option<std::ffi::OsString> {
    std::env::var_os(name)
}

pub fn process_var(name: &str) -> Option<String> {
    std::env::var(name).ok()
}

/// Every git the test process starts, an in-process daemon's included, appends trace2
/// events to `path`. nextest's one process per test keeps the trace to one test.
pub fn trace_git_processes(path: &std::path::Path) {
    std::env::set_var("GIT_TRACE2_EVENT", path);
}

/// Puts `dir` first on the test process's PATH, so a fake CLI there shadows the real one,
/// until the guard drops. Process-wide: callers serialise the tests that use it.
pub struct PathPrepend(Option<std::ffi::OsString>);

pub fn prepend_path(dir: &std::path::Path) -> PathPrepend {
    let previous = std::env::var_os("PATH");
    let rest = previous.iter().flat_map(std::env::split_paths);
    let joined = std::env::join_paths(std::iter::once(dir.to_path_buf()).chain(rest))
        .expect("PATH entries contain no separator");
    std::env::set_var("PATH", joined);
    PathPrepend(previous)
}

impl Drop for PathPrepend {
    fn drop(&mut self) {
        match self.0.take() {
            Some(path) => std::env::set_var("PATH", path),
            None => std::env::remove_var("PATH"),
        }
    }
}

/// Holds daemon threads that reach `houston_core::test_barriers::pause(point, ..)` until
/// released or dropped. Process-wide, which nextest's one process per test keeps to one test.
pub struct TestBarrier {
    dir: tempfile::TempDir,
    point: String,
}

impl TestBarrier {
    pub fn arm(point: &str) -> Self {
        let dir = tempfile::tempdir().unwrap();
        std::env::set_var("HOUSTON_TEST_BARRIER_DIR", dir.path());
        std::fs::write(dir.path().join("armed"), point).unwrap();
        Self {
            dir,
            point: point.to_string(),
        }
    }

    pub async fn reached(&self, subject: u32) {
        let receipt = format!("{} {subject}", self.point);
        let reached = self.dir.path().join("reached");
        tokio::time::timeout(Duration::from_secs(15), async {
            while std::fs::read_to_string(&reached).ok().as_deref() != Some(receipt.as_str()) {
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .unwrap_or_else(|_| panic!("no daemon thread reached barrier {receipt:?}"));
    }

    pub fn release(&self) {
        let _ = std::fs::remove_file(self.dir.path().join("armed"));
    }
}

impl Drop for TestBarrier {
    fn drop(&mut self) {
        self.release();
        std::env::remove_var("HOUSTON_TEST_BARRIER_DIR");
    }
}

/// Git processes started since [`trace_git_processes`] named `path`.
pub fn git_processes_started(path: &std::path::Path) -> usize {
    std::fs::read_to_string(path)
        .map(|trace| {
            trace
                .lines()
                .filter(|line| line.contains("\"event\":\"start\""))
                .count()
        })
        .unwrap_or(0)
}

/// The environment an in-process daemon starts from: the test process's, minus the
/// variables that change daemon behaviour, so a runner that exports one cannot leak in,
/// and with the user's real config homes swapped for a throwaway one (see `isolate_config`).
pub fn base_env() -> houston_core::host_env::HostEnv {
    let env = [
        "HOUSTON_SAFE_MODE",
        "HOUSTON_DISABLE_AUTO_RESTORE",
        "HOUSTON_DISABLE_SWARM_AUTOLAUNCH",
        "HOUSTON_RESTORE_BUDGET",
        "HOUSTON_REAP_GRACE_MS",
        "HOUSTON_HANDOFF_TIMEOUT_MS",
        "HOUSTON_SHUTDOWN_DRAIN_MS",
    ]
    .into_iter()
    .fold(houston_core::host_env::HostEnv::capture(), |env, name| {
        env.without(name)
    });
    isolate_config(env)
}

/// Copies the hermetic `fake_claude_stream` into `shim` as the `claude` a daemon launches.
pub fn install_fake_claude(shim: &std::path::Path) -> std::path::PathBuf {
    let fake = shim.join(if cfg!(windows) {
        "claude.exe"
    } else {
        "claude"
    });
    std::fs::copy(env!("CARGO_BIN_EXE_fake_claude_stream"), &fake).unwrap();
    fake
}

/// `base_env` whose `claude` can only be the fake in `shim`: PATH keeps no directory under
/// the user's home (`~/.local/bin`, npm, bun) or holding another `claude`, so a test that
/// renames its fake cannot reach the real CLI. Panics unless `claude` resolves in `shim`.
pub fn hermetic_claude_env(shim: &std::path::Path) -> houston_core::host_env::HostEnv {
    let homes: Vec<std::path::PathBuf> = ["HOME", "USERPROFILE"]
        .into_iter()
        .filter_map(process_var_os)
        .map(std::path::PathBuf::from)
        .filter(|home| home.components().count() > 1)
        .collect();
    let env = base_env();
    let provides_claude = |dir: &std::path::Path| {
        houston_core::exe_path::resolve_in(&env.with("PATH", Some(dir)), "claude").is_some()
    };
    let inherited = process_var_os("PATH").unwrap_or_default();
    let kept = std::env::split_paths(&inherited)
        .filter(|dir| !homes.iter().any(|home| dir.starts_with(home)) && !provides_claude(dir));
    let path = std::env::join_paths(std::iter::once(shim.to_path_buf()).chain(kept))
        .expect("PATH entries contain no separator");
    let env = env.with("PATH", Some(path));
    let resolved = houston_core::exe_path::resolve_in(&env, "claude");
    assert!(
        resolved
            .as_deref()
            .is_some_and(|claude| claude.starts_with(shim)),
        "claude resolves to {resolved:?}, expected the fake in {}",
        shim.display()
    );
    env
}

/// The test process's environment as it is, for fixtures that pass daemon-behaviour
/// variables to a re-executed child, with the same config-home isolation as `base_env`.
pub fn capture_env() -> houston_core::host_env::HostEnv {
    isolate_config(houston_core::host_env::HostEnv::capture())
}

fn under_temp_dir(path: &std::ffi::OsStr) -> bool {
    std::path::Path::new(path).starts_with(std::env::temp_dir())
}

/// One per test process, under cargo's per-target scratch dir so `cargo clean` and the target
/// sweep reclaim it. Homes untouched for a day are removed when a new one is made.
fn throwaway_home() -> &'static std::path::Path {
    static HOME: std::sync::OnceLock<std::path::PathBuf> = std::sync::OnceLock::new();
    HOME.get_or_init(|| {
        let root = std::path::Path::new(env!("CARGO_TARGET_TMPDIR")).join("test-homes");
        std::fs::create_dir_all(&root)
            .unwrap_or_else(|e| panic!("creating {}: {e}", root.display()));
        let stale = std::time::Duration::from_secs(24 * 60 * 60);
        for entry in std::fs::read_dir(&root).into_iter().flatten().flatten() {
            let old = entry
                .metadata()
                .and_then(|m| m.modified())
                .is_ok_and(|t| t.elapsed().is_ok_and(|age| age > stale));
            if old {
                let _ = std::fs::remove_dir_all(entry.path());
            }
        }
        tempfile::Builder::new()
            .prefix("home-")
            .tempdir_in(&root)
            .unwrap_or_else(|e| panic!("creating a throwaway home in {}: {e}", root.display()))
            .keep()
    })
}

/// Daemons install Claude and Codex hooks under `HOME`, `CLAUDE_CONFIG_DIR`, `CODEX_HOME`
/// and `XDG_CONFIG_HOME`. Values under the temp dir are a test's own and are kept; any other
/// (including an unset `HOME`, which falls back to the account's) becomes a throwaway.
fn isolate_config(env: houston_core::host_env::HostEnv) -> houston_core::host_env::HostEnv {
    // Any other config home is refused daemon-side, whatever environment a test builds.
    houston_core::agent_hooks::confine_config_homes_for_tests(vec![
        std::env::temp_dir(),
        houston_core::fixture_dirs::root().to_path_buf(),
        std::path::PathBuf::from(env!("CARGO_TARGET_TMPDIR")),
    ]);
    let home_var = if env.var_os("HOME").is_some() {
        "HOME"
    } else {
        "USERPROFILE"
    };
    let test_home = env
        .var_os(home_var)
        .filter(|value| under_temp_dir(value))
        .map(std::path::PathBuf::from);
    let mut env = env;
    let home = match test_home {
        Some(home) => home,
        None => {
            let home = throwaway_home().to_path_buf();
            env = env.with("HOME", Some(home.clone()));
            env = env.with("USERPROFILE", Some(home.clone()));
            home
        }
    };
    for (name, relative) in [
        ("CLAUDE_CONFIG_DIR", ".claude"),
        ("CODEX_HOME", ".codex"),
        ("XDG_CONFIG_HOME", ".config"),
    ] {
        if env.var_os(name).is_some_and(|value| !under_temp_dir(value)) {
            env = env.with(name, Some(home.join(relative)));
        }
    }
    env
}

/// libtest's name for test `name` of the module `module_path!()` names, for `--exact`. Checked
/// against the binary's test list: an `--exact` name that matches nothing runs zero tests
/// and exits 0, which would turn a re-executed fixture into a silent pass.
pub fn exact_path(module: &str, name: &str) -> String {
    let relative = module.split_once("::").map_or("", |(_, rest)| rest);
    let path = if relative.is_empty() {
        name.to_owned()
    } else {
        format!("{relative}::{name}")
    };
    let listing = std::process::Command::new(std::env::current_exe().unwrap())
        .args(["--list", "--format", "terse"])
        .output()
        .expect("listing this binary's tests");
    let listing = String::from_utf8_lossy(&listing.stdout);
    assert!(
        listing
            .lines()
            .any(|line| line.strip_suffix(": test") == Some(path.as_str())),
        "re-executing {path:?} (module_path {module:?}, test {name:?}): no such test in this binary; \
         the name must be the module path under tests/it/main.rs plus the function name"
    );
    path
}

pub fn hermetic_command(
    bin: impl AsRef<std::ffi::OsStr>,
    home: &std::path::Path,
) -> std::process::Command {
    let mut cmd = std::process::Command::new(bin);
    cmd.env_clear()
        .env("PATH", std::env::var("PATH").unwrap_or_default())
        .env("HOME", home)
        .env("USERPROFILE", home);
    // `env_clear` would drop the offline endpoints `.cargo/config.toml` sets for every
    // test process, and the daemon would then reach the real update manifest and catalog.
    for name in [
        houston_core::updates::UPDATE_MANIFEST_URL_ENV,
        houston_core::model_catalog::CATALOG_URL_ENV,
    ] {
        if let Some(value) = std::env::var_os(name) {
            cmd.env(name, value);
        }
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let shims = home.join("provider-shims");
        std::fs::create_dir_all(&shims).unwrap();
        for name in ["claude", "codex", "agy", "opencode", "zcode"] {
            let path = shims.join(name);
            if !path.exists() {
                std::fs::write(
                    &path,
                    "#!/bin/sh\necho 'real provider CLI refused by test fixture' >&2\nexit 1\n",
                )
                .unwrap();
                std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)).unwrap();
            }
        }
        let shell = shims.join("login-shell");
        if !shell.exists() {
            std::fs::write(&shell, "#!/bin/sh\nif [ \"$1\" = '-lic' ]; then\n  printf '__TR_LOGIN_PATH__%s\\n' \"$PATH\"\nelse\n  exec /bin/sh \"$@\"\nfi\n").unwrap();
            std::fs::set_permissions(&shell, std::fs::Permissions::from_mode(0o700)).unwrap();
        }
        cmd.env(
            "PATH",
            format!(
                "{}:{}",
                shims.display(),
                std::env::var("PATH").unwrap_or_default()
            ),
        )
        .env("SHELL", shell);
    }
    #[cfg(windows)]
    for key in ["SystemRoot", "SystemDrive", "windir", "TEMP", "TMP"] {
        if let Ok(v) = std::env::var(key) {
            cmd.env(key, v);
        }
    }
    cmd
}

pub async fn start_daemon() -> (std::net::SocketAddr, tempfile::TempDir) {
    start_daemon_in(base_env()).await
}

pub async fn start_daemon_in(
    env: houston_core::host_env::HostEnv,
) -> (std::net::SocketAddr, tempfile::TempDir) {
    let (addr, dir, _daemon) = start_daemon_with_handle_in(env).await;
    (addr, dir)
}

pub async fn start_daemon_with_handle() -> (
    std::net::SocketAddr,
    tempfile::TempDir,
    std::sync::Arc<Daemon>,
) {
    start_daemon_with_handle_in(base_env()).await
}

pub async fn start_daemon_with_handle_in(
    env: houston_core::host_env::HostEnv,
) -> (
    std::net::SocketAddr,
    tempfile::TempDir,
    std::sync::Arc<Daemon>,
) {
    let state_dir = houston_core::fixture_dirs::tempdir_outside_git();
    let daemon = Daemon::new(DaemonConfig::new(
        TOKEN.to_string(),
        state_dir.path().join("test.db"),
        env,
    ))
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
    start_daemon_without_mail_loop_in(base_env()).await
}

pub async fn start_daemon_without_mail_loop_in(
    env: houston_core::host_env::HostEnv,
) -> (
    std::net::SocketAddr,
    tempfile::TempDir,
    std::sync::Arc<Daemon>,
) {
    let state_dir = houston_core::fixture_dirs::tempdir_outside_git();
    let daemon = Daemon::new(DaemonConfig::new(
        TOKEN.to_string(),
        state_dir.path().join("test.db"),
        env,
    ))
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
    collect_output(ws, session, needle, false).await
}

pub async fn attach_and_collect_output_until(
    ws: &mut WsStream,
    session: u32,
    needle: &str,
) -> String {
    collect_output(ws, session, needle, true).await
}

async fn collect_output(ws: &mut WsStream, session: u32, needle: &str, attach: bool) -> String {
    const BUDGET: Duration = Duration::from_secs(15);
    if attach {
        let message = serde_json::to_string(&proto::ClientMsg::SessionAttach {
            session,
            replay_bytes: None,
            snapshot: Some(false),
            from_offset: None,
            generation: None,
        })
        .unwrap();
        ws.send(Message::text(message)).await.unwrap();
    }

    let mut acc = String::new();
    let mut replay_received = !attach;
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
            Message::Text(text) => {
                let msg: proto::ServerMsg = serde_json::from_str(&text).unwrap();
                if let proto::ServerMsg::Scrollback {
                    session: replay_session,
                    data,
                    ..
                } = msg
                {
                    if replay_session == session {
                        let bytes = base64::engine::general_purpose::STANDARD
                            .decode(data)
                            .unwrap();
                        acc.push_str(&String::from_utf8_lossy(&bytes));
                        replay_received = true;
                        if acc.contains(needle) {
                            return acc;
                        }
                    }
                }
            }
            Message::Binary(buf) => {
                if let Some((id, _offset, payload)) = proto::decode_output_frame(&buf) {
                    if id == session {
                        acc.push_str(&String::from_utf8_lossy(payload));
                        if replay_received && acc.contains(needle) {
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
        request: None,
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
        model: None,
        effort: None,
        view: None,
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
    collect_broadcast_matching(rx, session, needle, false).await
}

/// The last 512 characters of a pane's output with control bytes escaped, so a timeout
/// shows whether the program wrote anything past the terminal's own startup sequences.
pub fn escaped_tail(output: &[u8]) -> String {
    let text = String::from_utf8_lossy(output);
    let skip = text.chars().count().saturating_sub(512);
    text.chars()
        .skip(skip)
        .collect::<String>()
        .escape_debug()
        .to_string()
}

fn broadcast_timeout(needle: &str, session: u32, acc: &str) -> ! {
    panic!(
        "timed out waiting for {needle:?} on session {session} in broadcast output \
         (accumulated {} bytes, ending: \"{}\")",
        acc.len(),
        escaped_tail(acc.as_bytes())
    )
}

pub async fn collect_broadcast_envelope(
    rx: &mut houston_core::frame_queue::Observer,
    session: u32,
    needle: &str,
) -> String {
    collect_broadcast_matching(rx, session, needle, true).await
}

async fn collect_broadcast_matching(
    rx: &mut houston_core::frame_queue::Observer,
    session: u32,
    needle: &str,
    complete_envelope: bool,
) -> String {
    let mut acc = String::new();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
    loop {
        let remaining = deadline
            .checked_duration_since(tokio::time::Instant::now())
            .unwrap_or_else(|| broadcast_timeout(needle, session, &acc));
        let out = match tokio::time::timeout(remaining, rx.recv())
            .await
            .unwrap_or_else(|_| broadcast_timeout(needle, session, &acc))
        {
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
                    if acc.find(needle).is_some_and(|at| {
                        !complete_envelope || acc[at..].contains("--- End Inbox ---")
                    }) {
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
