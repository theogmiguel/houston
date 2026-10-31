//! Host for the v2 TypeScript server: detached spawn, discovery through its
//! runtime record, a keychain-held desktop secret, the bearer exchange and the
//! `desktopBridge` shim upstream's web app expects.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Child, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::Sha256;

/// The server's base directory below the channel directory: dev is
/// `~/.houston-dev/v2`, release would be `~/.houston/v2`.
pub const BASE_DIR_NAME: &str = "v2";
const KEYCHAIN_SERVICE_PREFIX: &str = "houston-v2";
const KEYCHAIN_PROFILE: &str = "desktop-bootstrap-secret";
const RUNTIME_DIR: &str = "userdata";
const RUNTIME_FILE: &str = "server-runtime.json";
/// Host-owned preferences that decide how the server is spawned.
const DESKTOP_SETTINGS_FILE: &str = "desktop-settings.json";
const DEFAULT_TAILSCALE_PORT: u16 = 443;
const PREFERRED_PORT: u16 = 3773;
const LAST_PROBED_PORT: u16 = 3809;
const READY_TIMEOUT: Duration = Duration::from_secs(60);
const READY_POLL: Duration = Duration::from_millis(250);
const HEALTH_TIMEOUT: Duration = Duration::from_secs(2);
const TOKEN_WINDOW_MS: u128 = 12 * 60 * 60 * 1000;
const TOKEN_EXCHANGE_GRANT: &str = "urn:ietf:params:oauth:grant-type:token-exchange";
const BOOTSTRAP_TOKEN_TYPE: &str = "urn:t3:params:oauth:token-type:environment-bootstrap";
const ACCESS_TOKEN_TYPE: &str = "urn:ietf:params:oauth:token-type:access_token";

/// Readiness endpoint upstream's desktop shell polls before showing the app.
pub const READINESS_PATH: &str = "/.well-known/t3/environment";

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[allow(dead_code)] // optional upstream fields are decoded for completeness, not read yet
pub struct ServerRuntime {
    #[serde(default)]
    pub version: i64,
    pub pid: i32,
    pub port: u16,
    pub origin: String,
    #[serde(default)]
    pub host: Option<String>,
    #[serde(default, rename = "startedAt")]
    pub started_at: Option<String>,
}

/// Host-owned server preferences. They live beside the runtime record rather
/// than in it: the server rewrites its record, while exposure is the host's.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopSettings {
    #[serde(default = "default_exposure_mode")]
    pub exposure_mode: String,
    #[serde(default)]
    pub tailscale_serve_enabled: bool,
    #[serde(default = "default_tailscale_port")]
    pub tailscale_serve_port: u16,
    #[serde(default)]
    pub wsl_enabled: bool,
    #[serde(default)]
    pub wsl_distro: Option<String>,
    #[serde(default)]
    pub wsl_only: bool,
}

fn default_exposure_mode() -> String {
    "local-only".to_string()
}

fn default_tailscale_port() -> u16 {
    DEFAULT_TAILSCALE_PORT
}

impl Default for DesktopSettings {
    fn default() -> Self {
        Self {
            exposure_mode: default_exposure_mode(),
            tailscale_serve_enabled: false,
            tailscale_serve_port: DEFAULT_TAILSCALE_PORT,
            wsl_enabled: false,
            wsl_distro: None,
            wsl_only: false,
        }
    }
}

pub fn settings_path(base_dir: &Path) -> PathBuf {
    base_dir.join(DESKTOP_SETTINGS_FILE)
}

/// A missing file is the default configuration. A malformed one is named so the
/// caller can report it rather than silently replacing the operator's choice.
pub fn load_settings(base_dir: &Path) -> Result<DesktopSettings, String> {
    let path = settings_path(base_dir);
    let text = match fs::read_to_string(&path) {
        Ok(text) => text,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(DesktopSettings::default()),
        Err(e) => return Err(format!("reading {}: {e}", path.display())),
    };
    let settings: DesktopSettings = serde_json::from_str(&text)
        .map_err(|e| format!("{} is not valid desktop settings JSON: {e}", path.display()))?;
    validate_settings(&settings)?;
    Ok(settings)
}

pub fn save_settings(base_dir: &Path, settings: &DesktopSettings) -> Result<(), String> {
    validate_settings(settings)?;
    let path = settings_path(base_dir);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| {
            format!(
                "creating the v2 settings directory {}: {e}",
                parent.display()
            )
        })?;
    }
    let tmp = path.with_extension("json.tmp");
    let body = serde_json::to_string_pretty(settings).expect("DesktopSettings serializes");
    fs::write(&tmp, body)
        .and_then(|()| fs::rename(&tmp, &path))
        .map_err(|e| format!("writing {}: {e}", path.display()))
}

fn validate_settings(settings: &DesktopSettings) -> Result<(), String> {
    if !matches!(
        settings.exposure_mode.as_str(),
        "local-only" | "network-accessible"
    ) {
        return Err(format!(
            "exposureMode must be \"local-only\" or \"network-accessible\", got {:?}",
            settings.exposure_mode
        ));
    }
    if settings.tailscale_serve_port == 0 {
        return Err("tailscaleServePort must be between 1 and 65535, got 0".to_string());
    }
    Ok(())
}

/// The host side of `desktopBridge.getServerExposureState`.
pub fn exposure_state(settings: &DesktopSettings, running: Option<&RunningServer>) -> Value {
    let local = running.and_then(|running| local_ipv4().map(|ip| (ip, running.port)));
    let endpoint = match (&settings.exposure_mode[..], local.as_ref(), running) {
        ("network-accessible", Some((ip, port)), _) => Some(format!("http://{ip}:{port}")),
        (_, _, Some(running)) => Some(running.origin.clone()),
        _ => None,
    };
    let advertised_host = if settings.exposure_mode == "network-accessible" {
        local
            .map(|(ip, _)| ip)
            .unwrap_or_else(|| "0.0.0.0".to_string())
    } else {
        "127.0.0.1".to_string()
    };
    json!({
        "mode": settings.exposure_mode,
        "endpointUrl": endpoint,
        "advertisedHost": advertised_host,
        "tailscaleServeEnabled": settings.tailscale_serve_enabled,
        "tailscaleServePort": settings.tailscale_serve_port,
    })
}

/// A UDP connect to a public address picks the interface the OS would use
/// without sending a packet. Fallible on offline machines, where LAN
/// advertisement is simply omitted.
fn local_ipv4() -> Option<String> {
    let socket = std::net::UdpSocket::bind("0.0.0.0:0").ok()?;
    socket.connect("8.8.8.8:80").ok()?;
    let address = socket.local_addr().ok()?;
    let ip = address.ip();
    if ip.is_loopback() || ip.is_unspecified() {
        None
    } else {
        Some(ip.to_string())
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TailscaleStatus {
    pub magic_dns_name: Option<String>,
    pub ipv4: Vec<String>,
}

/// `tailscale status --json`, read only for the fields the bridge advertises.
pub fn parse_tailscale_status(raw: &str) -> Option<TailscaleStatus> {
    let value: Value = serde_json::from_str(raw).ok()?;
    let self_node = value.get("Self")?;
    let magic_dns_name = self_node
        .get("DNSName")
        .and_then(Value::as_str)
        .map(|name| name.trim().trim_end_matches('.').to_string())
        .filter(|name| !name.is_empty());
    let ipv4 = self_node
        .get("TailscaleIPs")
        .and_then(Value::as_array)
        .map(|addresses| {
            addresses
                .iter()
                .filter_map(Value::as_str)
                .filter(|address| is_tailnet_ipv4(address))
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default();
    Some(TailscaleStatus {
        magic_dns_name,
        ipv4,
    })
}

fn is_tailnet_ipv4(address: &str) -> bool {
    let octets: Vec<u8> = address
        .split('.')
        .map(|part| part.parse::<u8>())
        .collect::<Result<Vec<_>, _>>()
        .unwrap_or_default();
    octets.len() == 4 && octets[0] == 100 && (64..=127).contains(&octets[1])
}

fn read_tailscale_status() -> Option<TailscaleStatus> {
    let mut command = crate::sys::spawn::command("tailscale");
    command.args(["status", "--json"]);
    let output = crate::sys::spawn::output_within(command, Duration::from_secs(3)).ok()??;
    if !output.status.success() {
        return None;
    }
    parse_tailscale_status(&String::from_utf8_lossy(&output.stdout))
}

struct EndpointSpec {
    id: String,
    label: &'static str,
    provider_id: &'static str,
    provider_label: &'static str,
    provider_kind: &'static str,
    url: String,
    reachability: &'static str,
    status: &'static str,
    hosted_compatibility: &'static str,
    is_default: bool,
}

fn endpoint(spec: EndpointSpec) -> Value {
    json!({
        "id": spec.id,
        "label": spec.label,
        "provider": {
            "id": spec.provider_id,
            "label": spec.provider_label,
            "kind": spec.provider_kind,
            "isAddon": false,
        },
        "httpBaseUrl": spec.url,
        "wsBaseUrl": spec.url.replacen("http", "ws", 1),
        "reachability": spec.reachability,
        "compatibility": {
            "hostedHttpsApp": spec.hosted_compatibility,
            "desktopApp": "compatible",
        },
        "source": "desktop-core",
        "status": spec.status,
        "isDefault": spec.is_default,
    })
}

/// The `desktopBridge.getAdvertisedEndpoints` list: loopback first, then the
/// LAN address when exposed, then Tailscale when its CLI answers.
pub fn advertised_endpoints(settings: &DesktopSettings, running: Option<&RunningServer>) -> Value {
    let Some(running) = running else {
        return json!([]);
    };
    let mut endpoints = vec![endpoint(EndpointSpec {
        id: format!("desktop-loopback:{}", running.port),
        label: "This machine",
        provider_id: "desktop-core",
        provider_label: "This machine",
        provider_kind: "core",
        url: running.origin.clone(),
        reachability: "loopback",
        status: "available",
        hosted_compatibility: "requires-configuration",
        is_default: settings.exposure_mode == "local-only",
    })];
    if settings.exposure_mode == "network-accessible" {
        if let Some(ip) = local_ipv4() {
            let url = format!("http://{ip}:{}", running.port);
            endpoints.push(endpoint(EndpointSpec {
                id: format!("desktop-lan:{url}"),
                label: "Local network",
                provider_id: "desktop-core",
                provider_label: "Local network",
                provider_kind: "private-network",
                url,
                reachability: "lan",
                status: "available",
                hosted_compatibility: "requires-configuration",
                is_default: true,
            }));
        }
    }
    if settings.exposure_mode == "network-accessible" || settings.tailscale_serve_enabled {
        if let Some(status) = read_tailscale_status() {
            if let Some(name) = status.magic_dns_name {
                let port = settings.tailscale_serve_port;
                let url = if port == DEFAULT_TAILSCALE_PORT {
                    format!("https://{name}")
                } else {
                    format!("https://{name}:{port}")
                };
                let available = settings.tailscale_serve_enabled;
                endpoints.push(endpoint(EndpointSpec {
                    id: format!("tailscale-magicdns:{name}:{port}"),
                    label: "Tailscale HTTPS",
                    provider_id: "tailscale",
                    provider_label: "Tailscale",
                    provider_kind: "private-network",
                    url,
                    reachability: "private-network",
                    status: if available {
                        "available"
                    } else {
                        "unavailable"
                    },
                    hosted_compatibility: "compatible",
                    is_default: false,
                }));
            }
        }
    }
    Value::Array(endpoints)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Decision {
    Attach { pid: u32, port: u16, origin: String },
    Spawn,
}

/// Attach only to a record whose process is alive and whose origin is a loopback
/// HTTP URL; anything else is stale and gets replaced.
pub fn decide(record: Option<&ServerRuntime>, alive: bool) -> Decision {
    let Some(record) = record else {
        return Decision::Spawn;
    };
    if record.pid <= 0 || !alive {
        return Decision::Spawn;
    }
    if !record.origin.starts_with("http://") && !record.origin.starts_with("https://") {
        return Decision::Spawn;
    }
    Decision::Attach {
        pid: record.pid as u32,
        port: record.port,
        origin: record.origin.clone(),
    }
}

/// `<channel dir>/v2`: the server's own state (`userdata/`) lives below it.
pub fn base_dir(channel_dir: &Path) -> PathBuf {
    channel_dir.join(BASE_DIR_NAME)
}

pub fn runtime_path(base_dir: &Path) -> PathBuf {
    base_dir.join(RUNTIME_DIR).join(RUNTIME_FILE)
}

pub fn log_path(base_dir: &Path) -> PathBuf {
    base_dir.join("logs").join("v2-server.log")
}

/// Where the v2 server comes from. A bundled install ships a single-executable
/// under the app's resources; a dev checkout runs its JavaScript entry with Node.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ServerEntry {
    /// The bundled Node single-executable, run directly without a Node runtime.
    Bundled(PathBuf),
    /// A JavaScript entry that needs the Node runtime from [`resolve_node`].
    Node(PathBuf),
}

/// The resource directory that `tauri.conf.json` bundles `v2-server/` under.
pub const BUNDLED_SERVER_DIR: &str = "v2-server";
const BUNDLED_SERVER_NAME: &str = "houston-v2-server";

pub fn bundled_server_executable(resource_dir: &Path) -> PathBuf {
    resource_dir.join(BUNDLED_SERVER_DIR).join(format!(
        "{BUNDLED_SERVER_NAME}{}",
        std::env::consts::EXE_SUFFIX
    ))
}

/// The dev checkout's JavaScript entry, also the last-resort fallback in `main.rs`.
pub fn dev_server_entry() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("apps")
        .join("server")
        .join("dist")
        .join("bin.mjs")
}

/// Resolution order: an explicit `HOUSTON_V2_SERVER_ENTRY` (with `HOUSTON_NODE`),
/// then the bundled executable under the app's resources, then the dev checkout.
pub fn resolve_server_entry(
    override_entry: Option<PathBuf>,
    resource_dir: Option<&Path>,
) -> Result<ServerEntry, String> {
    let bundled = resource_dir.map(bundled_server_executable);
    resolve_server_entry_with(override_entry, bundled.as_deref(), &dev_server_entry())
}

fn resolve_server_entry_with(
    override_entry: Option<PathBuf>,
    bundled: Option<&Path>,
    dev: &Path,
) -> Result<ServerEntry, String> {
    if let Some(path) = override_entry {
        return Ok(ServerEntry::Node(path));
    }
    if let Some(path) = bundled.filter(|path| path.is_file()) {
        return Ok(ServerEntry::Bundled(path.to_path_buf()));
    }
    if dev.is_file() {
        return Ok(ServerEntry::Node(dev.to_path_buf()));
    }
    let bundled_location = bundled
        .map(|path| path.display().to_string())
        .unwrap_or_else(|| "<app resource directory unavailable>".to_string());
    Err(format!(
        "cannot find the v2 server: HOUSTON_V2_SERVER_ENTRY is unset, the bundled executable \
         {bundled_location} is missing, and the dev checkout entry {} is missing. Set \
         HOUSTON_V2_SERVER_ENTRY to a server entry (with HOUSTON_NODE pointing at its Node \
         runtime), or build the dev checkout with `pnpm --filter houston build:bundle`.",
        dev.display()
    ))
}

pub fn resolve_node(override_node: Option<PathBuf>) -> PathBuf {
    override_node
        .or_else(|| crate::sys::exe_path::resolve("node"))
        .unwrap_or_else(|| PathBuf::from("node"))
}

pub fn current_desktop_bootstrap_token(secret: &str, now_ms: u128) -> String {
    let window = now_ms / TOKEN_WINDOW_MS;
    let mut mac =
        Hmac::<Sha256>::new_from_slice(secret.as_bytes()).expect("HMAC accepts any key length");
    mac.update(format!("t3-desktop-bootstrap:{window}").as_bytes());
    mac.finalize()
        .into_bytes()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

/// Bootstrap envelope read by upstream's CLI from fd 0. `desktopBootstrapSecret`
/// keeps a reopened app able to authenticate to a server started earlier; the
/// embedded token is only the current window's convenience value.
pub fn bootstrap_envelope(
    base_dir: &Path,
    port: u16,
    secret: &str,
    token: &str,
    settings: &DesktopSettings,
) -> Value {
    let host = if settings.exposure_mode == "network-accessible" {
        "0.0.0.0"
    } else {
        "127.0.0.1"
    };
    json!({
        "mode": "desktop",
        "noBrowser": true,
        "port": port,
        "t3Home": base_dir.to_string_lossy(),
        "host": host,
        "desktopBootstrapToken": token,
        "desktopBootstrapSecret": secret,
        "shellEnvironmentPrepared": false,
        "tailscaleServeEnabled": settings.tailscale_serve_enabled,
        "tailscaleServePort": settings.tailscale_serve_port,
    })
}

pub fn bootstrap_payload(origin: &str, secret: &str) -> Value {
    let token = current_desktop_bootstrap_token(secret, now_ms());
    json!([{
        "id": "primary",
        "label": "Local environment",
        "runningDistro": Value::Null,
        "httpBaseUrl": origin,
        "wsBaseUrl": origin.replacen("http", "ws", 1),
        "bootstrapToken": token,
    }])
}

fn now_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

/// Try a listener on the interface the server will actually bind; a taken port
/// means another process owns it, so step forward instead of racing it.
pub fn pick_port_for(bind_host: &str) -> u16 {
    for port in PREFERRED_PORT..=LAST_PROBED_PORT {
        if std::net::TcpListener::bind((bind_host, port)).is_ok() {
            return port;
        }
    }
    PREFERRED_PORT
}

fn read_runtime(base_dir: &Path) -> Option<ServerRuntime> {
    let text = fs::read_to_string(runtime_path(base_dir)).ok()?;
    serde_json::from_str(text.trim()).ok()
}

fn process_alive(pid: i32) -> bool {
    pid > 0 && crate::sys::pid::process_is_alive(pid as u32)
}

async fn health_ok(origin: &str) -> bool {
    let url = format!("{}{}", origin.trim_end_matches('/'), READINESS_PATH);
    match reqwest::Client::new()
        .get(&url)
        .timeout(HEALTH_TIMEOUT)
        .send()
        .await
    {
        Ok(response) => response.status().is_success(),
        Err(_) => false,
    }
}

fn keychain_entry(base_dir: &Path) -> Result<keyring::Entry, String> {
    let service = crate::sys::keychain::scoped_service(KEYCHAIN_SERVICE_PREFIX, base_dir);
    keyring::Entry::new(&service, KEYCHAIN_PROFILE).map_err(|e| {
        format!(
            "opening the system keychain for the v2 desktop secret (service {service:?}) \
             failed: {e}"
        )
    })
}

/// The secret must survive app restarts: the server rotates tokens from it, so a
/// reopened window authenticates without restarting the server.
pub fn load_or_create_secret(base_dir: &Path) -> Result<String, String> {
    let entry = keychain_entry(base_dir)?;
    match entry.get_password() {
        Ok(secret) if secret.len() >= 32 => Ok(secret),
        Ok(_) => {
            let secret = new_secret();
            entry
                .set_password(&secret)
                .map_err(|e| format!("replacing the malformed v2 desktop secret failed: {e}"))?;
            Ok(secret)
        }
        Err(keyring::Error::NoEntry) => {
            let secret = new_secret();
            entry
                .set_password(&secret)
                .map_err(|e| format!("storing the v2 desktop secret failed: {e}"))?;
            Ok(secret)
        }
        Err(e) => Err(format!("reading the v2 desktop secret failed: {e}")),
    }
}

fn new_secret() -> String {
    // Two v4 UUIDs: 256 bits of randomness without another dependency.
    format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    )
}

fn open_log(base_dir: &Path) -> Result<fs::File, String> {
    let path = log_path(base_dir);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("creating the v2 log directory {}: {e}", parent.display()))?;
    }
    fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| format!("opening the v2 server log {}: {e}", path.display()))
}

#[cfg(windows)]
const DETACHED_PROCESS: u32 = 0x0000_0008;
#[cfg(windows)]
const CREATE_BREAKAWAY_FROM_JOB: u32 = 0x0100_0000;
#[cfg(windows)]
const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;

/// The server must outlive the window: no console of its own, its own process
/// group, and a breakaway from any job object the app was started in. A job
/// that forbids breakaway is handled by the caller's fallback spawn.
#[cfg(windows)]
pub fn detached_spawn_flags(breakaway: bool) -> u32 {
    let mut flags =
        crate::sys::spawn::CREATE_NO_WINDOW | DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP;
    if breakaway {
        flags |= CREATE_BREAKAWAY_FROM_JOB;
    }
    flags
}

/// Build a fresh command for either server source. The Windows breakaway retry
/// needs a new command because a failed `spawn` consumes the previous one.
fn server_command(
    node: &Path,
    entry: &ServerEntry,
    base_dir: &Path,
) -> Result<std::process::Command, String> {
    let log = open_log(base_dir)?;
    let stderr = log
        .try_clone()
        .map_err(|e| format!("cloning the v2 server log handle: {e}"))?;
    let mut cmd = match entry {
        ServerEntry::Bundled(executable) => crate::sys::spawn::command(executable),
        ServerEntry::Node(entry) => {
            let mut cmd = crate::sys::spawn::command(node);
            cmd.arg(entry);
            cmd
        }
    };
    cmd.arg("--bootstrap-fd")
        .arg("0")
        .env("T3CODE_DESKTOP_DETACHED", "1")
        .stdin(Stdio::piped())
        .stdout(log)
        .stderr(stderr);

    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        // SAFETY: `setsid` is async-signal-safe and runs in the child after fork.
        unsafe {
            cmd.pre_exec(|| {
                if libc::setsid() == -1 {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }
    }

    Ok(cmd)
}

fn spawn_server(
    node: &Path,
    entry: &ServerEntry,
    base_dir: &Path,
    port: u16,
    payload: &Value,
) -> Result<Child, String> {
    let program = match entry {
        ServerEntry::Bundled(executable) => executable,
        ServerEntry::Node(_) => node,
    };

    #[cfg(windows)]
    let mut child = {
        use std::os::windows::process::CommandExt;
        let mut cmd = server_command(node, entry, base_dir)?;
        cmd.creation_flags(detached_spawn_flags(true));
        match cmd.spawn() {
            Ok(child) => child,
            // A job object that forbids breakaway makes CreateProcess fail with
            // access denied; stay in the job instead of refusing to start, and
            // say so because the server now shares the app's lifetime.
            Err(first) => {
                eprintln!(
                    "houston-tauri: v2 server breakaway spawn failed ({first}); retrying \
                     without CREATE_BREAKAWAY_FROM_JOB. The server will share the app's job \
                     and may not survive the app closing."
                );
                let mut retry = server_command(node, entry, base_dir)?;
                retry.creation_flags(detached_spawn_flags(false));
                retry.spawn().map_err(|second| {
                    format!("spawning the v2 server with {program:?}: {second}")
                })?
            }
        }
    };

    #[cfg(not(windows))]
    let mut child = server_command(node, entry, base_dir)?
        .spawn()
        .map_err(|e| format!("spawning the v2 server with {program:?}: {e}"))?;

    if let Some(mut stdin) = child.stdin.take() {
        let line = format!("{payload}\n");
        stdin
            .write_all(line.as_bytes())
            .map_err(|e| format!("delivering the v2 bootstrap envelope: {e}"))?;
        let _ = stdin.flush();
    }
    eprintln!(
        "houston-tauri: spawned the v2 server (pid {}) on port {port}",
        child.id()
    );
    Ok(child)
}

async fn wait_for_ready(base_dir: &Path, child: &mut Child) -> Result<ServerRuntime, String> {
    let deadline = Instant::now() + READY_TIMEOUT;
    loop {
        if let Some(runtime) = read_runtime(base_dir) {
            if process_alive(runtime.pid) && health_ok(&runtime.origin).await {
                return Ok(runtime);
            }
        }
        if let Ok(Some(status)) = child.try_wait() {
            return Err(format!(
                "the v2 server exited ({status}) before becoming ready; tail of {}:\n{}",
                log_path(base_dir).display(),
                log_tail(base_dir)
            ));
        }
        if Instant::now() >= deadline {
            return Err(format!(
                "timed out after {}s waiting for the v2 server at {}; tail of {}:\n{}",
                READY_TIMEOUT.as_secs(),
                runtime_path(base_dir).display(),
                log_path(base_dir).display(),
                log_tail(base_dir)
            ));
        }
        tokio::time::sleep(READY_POLL).await;
    }
}

fn log_tail(base_dir: &Path) -> String {
    let text = fs::read_to_string(log_path(base_dir)).unwrap_or_default();
    let mut lines: Vec<&str> = text.lines().rev().take(40).collect();
    lines.reverse();
    lines.join("\n")
}

#[derive(Debug, Clone, Serialize)]
pub struct RunningServer {
    pub origin: String,
    pub port: u16,
    pub pid: i32,
    pub attached: bool,
}

#[derive(Debug)]
struct HostState {
    running: Option<RunningServer>,
    bearer: Option<String>,
    last_error: Option<String>,
    settings: DesktopSettings,
}

pub struct V2Host {
    base_dir: PathBuf,
    node: PathBuf,
    entry: ServerEntry,
    state: Mutex<HostState>,
}

impl V2Host {
    pub fn new(base_dir: PathBuf, node: PathBuf, entry: ServerEntry) -> Self {
        let settings = load_settings(&base_dir).unwrap_or_else(|error| {
            eprintln!("houston-tauri: v2 desktop settings: {error}; using defaults");
            DesktopSettings::default()
        });
        Self {
            base_dir,
            node,
            entry,
            state: Mutex::new(HostState {
                running: None,
                bearer: None,
                last_error: None,
                settings,
            }),
        }
    }

    pub fn settings(&self) -> DesktopSettings {
        self.state
            .lock()
            .map(|state| state.settings.clone())
            .unwrap_or_default()
    }

    fn store_settings(&self, settings: DesktopSettings) -> Result<(), String> {
        save_settings(&self.base_dir, &settings)?;
        if let Ok(mut state) = self.state.lock() {
            state.settings = settings;
        }
        Ok(())
    }

    /// Persist preferences that do not change how the server is spawned (WSL
    /// routing is resolved by the server slice; the host records the choice).
    pub fn update_settings(&self, settings: DesktopSettings) -> Result<(), String> {
        self.store_settings(settings)
    }

    /// Apply a settings change that affects how the server is spawned. The old
    /// value is restored if the new server does not become healthy.
    pub async fn apply_settings_restarting(&self, next: DesktopSettings) -> Result<(), String> {
        let previous = self.settings();
        self.store_settings(next)?;
        match self.restart().await {
            Ok(_) => Ok(()),
            Err(error) => {
                let _ = self.store_settings(previous);
                let recovery = self.restart().await;
                Err(match recovery {
                    Ok(_) => format!("{error}; the previous exposure settings were restored"),
                    Err(second) => format!(
                        "{error}; restoring the previous exposure settings also failed: {second}"
                    ),
                })
            }
        }
    }

    /// Stop the tracked server and start a fresh one with the current settings.
    pub async fn restart(&self) -> Result<RunningServer, String> {
        if let Some(running) = self.running() {
            stop_server(running.pid).await?;
        }
        let _ = fs::remove_file(runtime_path(&self.base_dir));
        if let Ok(mut state) = self.state.lock() {
            state.running = None;
            state.bearer = None;
        }
        ensure_running(self).await
    }

    fn record_error(&self, error: String) {
        eprintln!("houston-tauri: v2 server: {error}");
        if let Ok(mut state) = self.state.lock() {
            state.last_error = Some(error);
        }
    }

    fn set_running(&self, running: RunningServer) {
        if let Ok(mut state) = self.state.lock() {
            state.running = Some(running);
            state.last_error = None;
        }
    }

    pub fn running(&self) -> Option<RunningServer> {
        self.state
            .lock()
            .ok()
            .and_then(|state| state.running.clone())
    }

    pub fn status(&self) -> Value {
        let (running, last_error) = self
            .state
            .lock()
            .map(|state| (state.running.clone(), state.last_error.clone()))
            .unwrap_or((None, None));
        match running {
            Some(running) => json!({
                "state": "ready",
                "origin": running.origin,
                "port": running.port,
                "pid": running.pid,
                "attached": running.attached,
                "baseDir": self.base_dir,
                "logPath": log_path(&self.base_dir),
            }),
            None => json!({
                "state": if last_error.is_some() { "error" } else { "starting" },
                "error": last_error,
                "baseDir": self.base_dir,
                "logPath": log_path(&self.base_dir),
            }),
        }
    }

    /// Bootstrap payload read by upstream's `desktopBridge.getLocalEnvironmentBootstraps`.
    pub fn bootstrap_list(&self) -> Result<Value, String> {
        let running = self
            .running()
            .ok_or_else(|| "the v2 server is not running yet".to_string())?;
        let secret = load_or_create_secret(&self.base_dir)?;
        Ok(bootstrap_payload(&running.origin, &secret))
    }

    /// Exchange the rotating desktop credential for a bearer session. Cached for
    /// the app's lifetime; a server restart keeps sessions, a stale cache only
    /// costs one rejected request.
    pub async fn bearer_token(&self) -> Result<String, String> {
        if let Ok(state) = self.state.lock() {
            if let Some(token) = &state.bearer {
                return Ok(token.clone());
            }
        }
        let token = self.fetch_bearer().await?;
        if let Ok(mut state) = self.state.lock() {
            state.bearer = Some(token.clone());
        }
        Ok(token)
    }

    async fn fetch_bearer(&self) -> Result<String, String> {
        let running = self
            .running()
            .ok_or_else(|| "the v2 server is not running yet".to_string())?;
        let secret = load_or_create_secret(&self.base_dir)?;
        let credential = current_desktop_bootstrap_token(&secret, now_ms());
        let body = format!(
            "grant_type={}&subject_token={}&subject_token_type={}&requested_token_type={}\
             &client_label=Houston&client_device_type=desktop",
            form_encode(TOKEN_EXCHANGE_GRANT),
            form_encode(&credential),
            form_encode(BOOTSTRAP_TOKEN_TYPE),
            form_encode(ACCESS_TOKEN_TYPE),
        );
        let url = format!("{}/oauth/token", running.origin.trim_end_matches('/'));
        let response = reqwest::Client::new()
            .post(&url)
            .header(
                reqwest::header::CONTENT_TYPE,
                "application/x-www-form-urlencoded",
            )
            .timeout(Duration::from_secs(10))
            .body(body)
            .send()
            .await
            .map_err(|e| format!("exchanging the v2 desktop credential at {url}: {e}"))?;
        let status = response.status();
        let text = response
            .text()
            .await
            .map_err(|e| format!("reading the v2 credential exchange response: {e}"))?;
        if !status.is_success() {
            return Err(format!(
                "the v2 server rejected the desktop credential ({status}): {text}"
            ));
        }
        let value: Value = serde_json::from_str(&text)
            .map_err(|e| format!("decoding the v2 credential exchange response: {e}"))?;
        value
            .get("access_token")
            .and_then(Value::as_str)
            .filter(|token| !token.is_empty())
            .map(str::to_string)
            .ok_or_else(|| format!("the v2 credential exchange returned no access_token: {text}"))
    }
}

fn form_encode(value: &str) -> String {
    let mut out = String::new();
    for byte in value.as_bytes() {
        match *byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(*byte as char)
            }
            b' ' => out.push('+'),
            other => out.push_str(&format!("%{other:02X}")),
        }
    }
    out
}

/// A detached child stays unreaped until Houston exits, so `kill(pid, 0)`
/// still succeeds for a zombie. On Linux the process state distinguishes the
/// two; elsewhere (Windows has no zombies) `kill(pid, 0)` is already final.
fn process_exited(pid: i32) -> bool {
    if pid <= 0 || !process_alive(pid) {
        return true;
    }
    #[cfg(target_os = "linux")]
    {
        let path = format!("/proc/{pid}/stat");
        if let Ok(stat) = fs::read_to_string(path) {
            if let Some((_, rest)) = stat.rsplit_once(')') {
                return rest.trim_start().starts_with('Z');
            }
        }
    }
    false
}

/// Stop a server this host started or attached to. SIGTERM first so the server
/// can close its database; a process that ignores it is killed after five
/// seconds. Only a recorded, positive pid ever reaches the signal helper.
async fn stop_server(pid: i32) -> Result<(), String> {
    use crate::sys::pid::{signal_process_checked, Signal, SignalOutcome};
    if process_exited(pid) {
        return Ok(());
    }
    let pid = pid as u32;
    match signal_process_checked(pid, Signal::Term) {
        Ok(SignalOutcome::Delivered | SignalOutcome::NoSuchProcess) => {}
        Err(error) => return Err(format!("stopping the v2 server (pid {pid}): {error}")),
    }
    for _ in 0..25 {
        if process_exited(pid as i32) {
            return Ok(());
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
    eprintln!("houston-tauri: v2 server (pid {pid}) ignored SIGTERM for 5 s; sending a hard kill");
    match signal_process_checked(pid, Signal::Kill) {
        Ok(SignalOutcome::Delivered | SignalOutcome::NoSuchProcess) => {}
        Err(error) => return Err(format!("killing the v2 server (pid {pid}): {error}")),
    }
    for _ in 0..25 {
        if process_exited(pid as i32) {
            return Ok(());
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
    Err(format!(
        "the v2 server (pid {pid}) is still alive after SIGKILL"
    ))
}

/// Discover and attach, or spawn and wait. On either path the host ends up with
/// the loopback origin and pid the renderer talks to.
pub async fn ensure_running(host: &V2Host) -> Result<RunningServer, String> {
    fs::create_dir_all(host.base_dir.join(RUNTIME_DIR)).map_err(|e| {
        format!(
            "creating the v2 state directory {}: {e}",
            host.base_dir.display()
        )
    })?;

    if let Some(record) = read_runtime(&host.base_dir) {
        if let Decision::Attach { pid, port, origin } =
            decide(Some(&record), process_alive(record.pid))
        {
            if health_ok(&origin).await {
                let running = RunningServer {
                    origin,
                    port,
                    pid: pid as i32,
                    attached: true,
                };
                host.set_running(running.clone());
                eprintln!(
                    "houston-tauri: attached to the running v2 server (pid {pid}) on port {port}"
                );
                return Ok(running);
            }
        }
    }

    let secret = load_or_create_secret(&host.base_dir)?;
    let settings = host.settings();
    let bind_host = if settings.exposure_mode == "network-accessible" {
        "0.0.0.0"
    } else {
        "127.0.0.1"
    };
    let port = pick_port_for(bind_host);
    let token = current_desktop_bootstrap_token(&secret, now_ms());
    let envelope = bootstrap_envelope(&host.base_dir, port, &secret, &token, &settings);
    let mut child = spawn_server(&host.node, &host.entry, &host.base_dir, port, &envelope)?;
    let runtime = wait_for_ready(&host.base_dir, &mut child).await?;
    let running = RunningServer {
        origin: runtime.origin,
        port: runtime.port,
        pid: runtime.pid,
        attached: false,
    };
    host.set_running(running.clone());
    Ok(running)
}

/// Restart on crash while the window is open. A user-closed app leaves the
/// server alone: this loop ends with the process.
pub async fn monitor(host: std::sync::Arc<V2Host>) {
    loop {
        tokio::time::sleep(Duration::from_secs(5)).await;
        let Some(running) = host.running() else {
            continue;
        };
        if process_alive(running.pid) && health_ok(&running.origin).await {
            continue;
        }
        eprintln!(
            "houston-tauri: v2 server (pid {}) is no longer healthy; restarting it",
            running.pid
        );
        if let Err(error) = ensure_running(&host).await {
            host.record_error(error);
        }
    }
}

#[tauri::command]
pub fn v2_local_environment_bootstrap(
    host: tauri::State<'_, std::sync::Arc<V2Host>>,
) -> Result<Value, String> {
    host.bootstrap_list()
}

#[tauri::command]
pub async fn v2_local_environment_bearer_token(
    host: tauri::State<'_, std::sync::Arc<V2Host>>,
) -> Result<String, String> {
    host.bearer_token().await
}

#[tauri::command]
pub fn v2_server_status(host: tauri::State<'_, std::sync::Arc<V2Host>>) -> Value {
    host.status()
}

#[tauri::command]
pub fn v2_server_exposure_state(
    host: tauri::State<'_, std::sync::Arc<V2Host>>,
) -> Result<Value, String> {
    Ok(exposure_state(&host.settings(), host.running().as_ref()))
}

#[tauri::command]
pub async fn v2_server_set_exposure_mode(
    mode: String,
    host: tauri::State<'_, std::sync::Arc<V2Host>>,
) -> Result<Value, String> {
    if !matches!(mode.as_str(), "local-only" | "network-accessible") {
        return Err(format!(
            "network exposure mode must be \"local-only\" or \"network-accessible\", got {mode:?}"
        ));
    }
    let mut settings = host.settings();
    settings.exposure_mode = mode;
    host.apply_settings_restarting(settings).await?;
    Ok(exposure_state(&host.settings(), host.running().as_ref()))
}

#[tauri::command]
pub async fn v2_server_set_tailscale_serve(
    enabled: bool,
    port: Option<u16>,
    host: tauri::State<'_, std::sync::Arc<V2Host>>,
) -> Result<Value, String> {
    let port = port.unwrap_or_else(default_tailscale_port);
    if port == 0 {
        return Err("Tailscale Serve port must be between 1 and 65535, got 0".to_string());
    }
    let mut settings = host.settings();
    settings.tailscale_serve_enabled = enabled;
    settings.tailscale_serve_port = port;
    host.apply_settings_restarting(settings).await?;
    Ok(exposure_state(&host.settings(), host.running().as_ref()))
}

#[tauri::command]
pub async fn v2_server_advertised_endpoints(
    host: tauri::State<'_, std::sync::Arc<V2Host>>,
) -> Result<Value, String> {
    let settings = host.settings();
    let running = host.running();
    tokio::task::spawn_blocking(move || advertised_endpoints(&settings, running.as_ref()))
        .await
        .map_err(|e| format!("reading advertised endpoints stopped unexpectedly: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn record(pid: i32, origin: &str) -> ServerRuntime {
        ServerRuntime {
            version: 1,
            pid,
            port: 3773,
            origin: origin.to_string(),
            host: Some("127.0.0.1".to_string()),
            started_at: None,
        }
    }

    #[test]
    fn a_missing_record_spawns() {
        assert_eq!(decide(None, false), Decision::Spawn);
    }

    #[test]
    fn a_live_loopback_record_attaches() {
        assert_eq!(
            decide(Some(&record(42, "http://127.0.0.1:3773")), true),
            Decision::Attach {
                pid: 42,
                port: 3773,
                origin: "http://127.0.0.1:3773".to_string()
            }
        );
    }

    #[test]
    fn a_dead_pid_spawns() {
        assert_eq!(
            decide(Some(&record(42, "http://127.0.0.1:3773")), false),
            Decision::Spawn
        );
    }

    #[test]
    fn a_non_positive_pid_spawns() {
        assert_eq!(
            decide(Some(&record(0, "http://127.0.0.1:3773")), true),
            Decision::Spawn
        );
        assert_eq!(
            decide(Some(&record(-1, "http://127.0.0.1:3773")), true),
            Decision::Spawn
        );
    }

    #[test]
    fn a_non_http_origin_spawns() {
        assert_eq!(
            decide(Some(&record(42, "file:///tmp/x")), true),
            Decision::Spawn
        );
        assert_eq!(decide(Some(&record(42, "")), true), Decision::Spawn);
    }

    fn touch(path: &Path) {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).expect("create the fixture directory");
        }
        fs::write(path, b"fixture").expect("write the fixture file");
    }

    #[test]
    fn the_bundled_executable_is_named_per_platform() {
        let executable = bundled_server_executable(Path::new("/app/resources"));
        assert_eq!(
            executable,
            Path::new("/app/resources")
                .join(BUNDLED_SERVER_DIR)
                .join(format!(
                    "{BUNDLED_SERVER_NAME}{}",
                    std::env::consts::EXE_SUFFIX
                ))
        );
    }

    #[test]
    fn an_explicit_override_wins_over_bundled_and_dev() {
        let dir = tempfile::tempdir().expect("temp dir");
        let override_entry = dir.path().join("override.mjs");
        let bundled = dir.path().join("v2-server/houston-v2-server");
        let dev = dir.path().join("apps/server/dist/bin.mjs");
        touch(&override_entry);
        touch(&bundled);
        touch(&dev);

        assert_eq!(
            resolve_server_entry_with(Some(override_entry.clone()), Some(&bundled), &dev),
            Ok(ServerEntry::Node(override_entry))
        );
    }

    #[test]
    fn the_bundled_executable_wins_over_the_dev_checkout() {
        let dir = tempfile::tempdir().expect("temp dir");
        let bundled = dir.path().join("v2-server/houston-v2-server");
        let dev = dir.path().join("apps/server/dist/bin.mjs");
        touch(&bundled);
        touch(&dev);

        assert_eq!(
            resolve_server_entry_with(None, Some(&bundled), &dev),
            Ok(ServerEntry::Bundled(bundled))
        );
    }

    #[test]
    fn the_dev_checkout_is_used_when_no_override_or_bundle_exists() {
        let dir = tempfile::tempdir().expect("temp dir");
        let bundled = dir.path().join("v2-server/houston-v2-server");
        let dev = dir.path().join("apps/server/dist/bin.mjs");
        touch(&dev);

        assert_eq!(
            resolve_server_entry_with(None, Some(&bundled), &dev),
            Ok(ServerEntry::Node(dev))
        );
    }

    #[test]
    fn a_missing_server_error_lists_every_location_and_env_override() {
        let dir = tempfile::tempdir().expect("temp dir");
        let bundled = dir.path().join("v2-server/houston-v2-server");
        let dev = dir.path().join("apps/server/dist/bin.mjs");

        let error = resolve_server_entry_with(None, Some(&bundled), &dev)
            .expect_err("nothing exists, so resolution must fail");
        assert!(error.contains("HOUSTON_V2_SERVER_ENTRY"), "{error}");
        assert!(error.contains("HOUSTON_NODE"), "{error}");
        assert!(error.contains(&bundled.display().to_string()), "{error}");
        assert!(error.contains(&dev.display().to_string()), "{error}");
    }

    #[test]
    fn the_base_dir_is_per_channel_below_the_channel_dir() {
        assert_eq!(
            base_dir(Path::new("/home/u/.houston-dev")),
            PathBuf::from("/home/u/.houston-dev/v2")
        );
        assert_eq!(
            runtime_path(Path::new("/home/u/.houston-dev/v2")),
            PathBuf::from("/home/u/.houston-dev/v2/userdata/server-runtime.json")
        );
    }

    #[test]
    fn the_record_shape_matches_upstream() {
        let parsed: ServerRuntime = serde_json::from_str(
            r#"{"version":1,"pid":123,"port":3773,"origin":"http://127.0.0.1:3773","startedAt":"2026-10-29T00:00:00Z"}"#,
        )
        .expect("upstream's runtime record must decode");
        assert_eq!(parsed.pid, 123);
        assert_eq!(parsed.port, 3773);
        assert_eq!(parsed.started_at.as_deref(), Some("2026-10-29T00:00:00Z"));
    }

    #[test]
    fn the_desktop_token_is_window_scoped_hmac_sha256_hex() {
        let secret = "s3cret";
        let first = current_desktop_bootstrap_token(secret, 0);
        let same_window = current_desktop_bootstrap_token(secret, TOKEN_WINDOW_MS - 1);
        let next_window = current_desktop_bootstrap_token(secret, TOKEN_WINDOW_MS);
        assert_eq!(first, same_window);
        assert_ne!(first, next_window);
        assert_eq!(first.len(), 64);
        assert!(first.chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn the_bootstrap_envelope_carries_desktop_mode_and_secret() {
        let envelope = bootstrap_envelope(
            Path::new("/home/u/.houston-dev/v2"),
            3773,
            "secret",
            "token",
            &DesktopSettings::default(),
        );
        assert_eq!(envelope["mode"], "desktop");
        assert_eq!(envelope["noBrowser"], true);
        assert_eq!(envelope["port"], 3773);
        assert_eq!(envelope["host"], "127.0.0.1");
        assert_eq!(envelope["desktopBootstrapSecret"], "secret");
        assert_eq!(envelope["desktopBootstrapToken"], "token");
        assert_eq!(envelope["tailscaleServeEnabled"], false);
        assert_eq!(envelope["tailscaleServePort"], 443);
        assert!(envelope["t3Home"].as_str().unwrap().ends_with("v2"));
    }

    #[cfg(windows)]
    #[test]
    fn the_detached_spawn_flags_break_away_from_a_job() {
        let flags = detached_spawn_flags(true);
        assert_eq!(flags & CREATE_BREAKAWAY_FROM_JOB, CREATE_BREAKAWAY_FROM_JOB);
        assert_eq!(flags & DETACHED_PROCESS, DETACHED_PROCESS);
        assert_eq!(flags & CREATE_NEW_PROCESS_GROUP, CREATE_NEW_PROCESS_GROUP);
        assert_eq!(
            flags & crate::sys::spawn::CREATE_NO_WINDOW,
            crate::sys::spawn::CREATE_NO_WINDOW
        );
        assert_eq!(
            flags & 0x0000_0010,
            0,
            "detached must not ask for a console"
        );
    }

    #[cfg(windows)]
    #[test]
    fn the_fallback_spawn_flags_keep_detachment_without_breakaway() {
        let flags = detached_spawn_flags(false);
        assert_eq!(flags & CREATE_BREAKAWAY_FROM_JOB, 0);
        assert_eq!(flags & DETACHED_PROCESS, DETACHED_PROCESS);
        assert_eq!(flags & CREATE_NEW_PROCESS_GROUP, CREATE_NEW_PROCESS_GROUP);
    }

    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn stop_server_accepts_an_unreaped_child_as_stopped() {
        let mut child = crate::sys::spawn::command("sleep")
            .arg("30")
            .spawn()
            .expect("spawn sleep");
        let pid = child.id() as i32;
        stop_server(pid).await.expect("SIGTERM stops the child");
        assert!(process_exited(pid), "an exited child may still be a zombie");
        let _ = child.wait();
    }

    #[test]
    fn desktop_settings_round_trip_and_reject_an_unknown_mode() {
        let dir = tempfile::tempdir().expect("temp dir");
        let mut settings = DesktopSettings {
            exposure_mode: "network-accessible".to_string(),
            tailscale_serve_enabled: true,
            tailscale_serve_port: 8443,
            ..DesktopSettings::default()
        };
        save_settings(dir.path(), &settings).expect("save settings");
        assert_eq!(load_settings(dir.path()).unwrap(), settings);

        settings.exposure_mode = "everyone".to_string();
        let error = save_settings(dir.path(), &settings).expect_err("mode must be refused");
        assert!(error.contains("everyone"), "{error}");
    }

    #[test]
    fn network_exposure_binds_every_interface_and_passes_tailscale_flags() {
        let settings = DesktopSettings {
            exposure_mode: "network-accessible".to_string(),
            tailscale_serve_enabled: true,
            tailscale_serve_port: 8443,
            ..DesktopSettings::default()
        };
        let envelope = bootstrap_envelope(
            Path::new("/home/u/.houston-dev/v2"),
            3773,
            "secret",
            "token",
            &settings,
        );
        assert_eq!(envelope["host"], "0.0.0.0");
        assert_eq!(envelope["tailscaleServeEnabled"], true);
        assert_eq!(envelope["tailscaleServePort"], 8443);
    }

    #[test]
    fn exposure_state_names_the_loopback_endpoint_until_network_access_is_on() {
        let settings = DesktopSettings::default();
        let running = RunningServer {
            origin: "http://127.0.0.1:3773".to_string(),
            port: 3773,
            pid: 42,
            attached: false,
        };
        let state = exposure_state(&settings, Some(&running));
        assert_eq!(state["mode"], "local-only");
        assert_eq!(state["endpointUrl"], "http://127.0.0.1:3773");
        assert_eq!(state["advertisedHost"], "127.0.0.1");
        assert_eq!(state["tailscaleServeEnabled"], false);
        assert_eq!(state["tailscaleServePort"], 443);
    }

    #[test]
    fn advertised_endpoints_begin_with_the_loopback_endpoint() {
        let settings = DesktopSettings::default();
        let running = RunningServer {
            origin: "http://127.0.0.1:3773".to_string(),
            port: 3773,
            pid: 42,
            attached: false,
        };
        let endpoints = advertised_endpoints(&settings, Some(&running));
        let first = &endpoints[0];
        assert_eq!(first["id"], "desktop-loopback:3773");
        assert_eq!(first["reachability"], "loopback");
        assert_eq!(first["status"], "available");
        assert_eq!(first["isDefault"], true);
        assert_eq!(first["wsBaseUrl"], "ws://127.0.0.1:3773");
        assert_eq!(advertised_endpoints(&settings, None), serde_json::json!([]));
    }

    #[test]
    fn tailscale_status_reads_dns_name_and_tailnet_addresses() {
        let status = parse_tailscale_status(
            r#"{"Self":{"DNSName":"desktop.tail.ts.net.","TailscaleIPs":["100.100.100.100","fd7a::1","192.168.1.20"]}}"#,
        )
        .expect("valid status");
        assert_eq!(
            status.magic_dns_name.as_deref(),
            Some("desktop.tail.ts.net")
        );
        assert_eq!(status.ipv4, ["100.100.100.100"]);
        assert!(parse_tailscale_status("not json").is_none());
    }

    #[test]
    fn the_form_body_percent_encodes_urns_without_escaping_them() {
        assert_eq!(
            form_encode("urn:ietf:params:oauth:grant-type:token-exchange"),
            "urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Atoken-exchange"
        );
    }
}
