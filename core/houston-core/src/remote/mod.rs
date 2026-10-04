//! Remote access: an opt-in second listener serving a web client and an HTTP API
//! to paired devices, which observe and answer panes. It never serves `/ws`, MCP
//! or agent routes; see docs/internals/overview.md for the trust model.
use std::collections::{HashMap, VecDeque};
use std::net::SocketAddr;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use houston_protocol as proto;
use sha2::{Digest, Sha256};

pub mod http;
pub mod ntfy;

/// A fixed port, so `tailscale serve --bg 47823` stays valid across restarts.
pub const DEFAULT_BIND: &str = "127.0.0.1:47823";
pub const PAIRING_TTL: Duration = Duration::from_secs(10 * 60);
pub const AUTH_FAILURE_LIMIT: usize = 10;
pub const AUTH_FAILURE_WINDOW: Duration = Duration::from_secs(60);
pub const AUTH_LOCKOUT: Duration = Duration::from_secs(60);
pub const SCREEN_LINES_DEFAULT: usize = 60;
pub const SCREEN_LINES_MAX: usize = 200;
pub const INPUT_TEXT_MAX: usize = 4096;
pub const INPUT_KEYS_MAX: usize = 16;
pub const DEVICE_NAME_MAX: usize = 64;
pub const NOTIFY_DELAY_DEFAULT: u32 = 30;
pub const NOTIFY_DELAY_MAX: u32 = 600;
pub const NTFY_URL_MAX: usize = 512;
// The largest legal request is a 4096-character answer, at most 16 KiB of UTF-8.
pub const BODY_LIMIT: usize = 20 * 1024;
// A device polls every few seconds; persisting each request would turn reads
// into a write stream, so last-seen is recorded at most once a minute.
pub const LAST_SEEN_WRITE_INTERVAL_MS: u64 = 60_000;
// Status transitions are a few per turn; the bound only matters when no
// notifier loop drains the queue, as in a daemon embedded by a test.
const STATUS_QUEUE: usize = 1024;

pub const REMOTE_KEYS: [(&str, &[u8]); 12] = [
    ("enter", b"\r"),
    ("esc", b"\x1b"),
    ("tab", b"\t"),
    ("up", b"\x1b[A"),
    ("down", b"\x1b[B"),
    ("left", b"\x1b[D"),
    ("right", b"\x1b[C"),
    ("backspace", b"\x7f"),
    ("ctrl+c", b"\x03"),
    ("y", b"y"),
    ("n", b"n"),
    ("space", b" "),
];

pub(crate) const KEY_ENABLED: &str = "remote_enabled";
pub(crate) const KEY_BIND: &str = "remote_bind";
pub(crate) const KEY_PUBLIC_URL: &str = "remote_public_url";
pub(crate) const KEY_NOTIFY_DELAY: &str = "remote_notify_delay_secs";
pub(crate) const KEY_NOTIFY_DETAIL: &str = "remote_notify_detail";
pub(crate) const KEY_NOTIFY_FINISHED: &str = "remote_notify_finished";
/// The ntfy server origin while the keychain holds a topic URL; empty when off.
pub(crate) const KEY_NTFY_SERVER: &str = "remote_ntfy_server";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NotifyDetail {
    Generic,
    PaneName,
}

impl NotifyDetail {
    pub fn as_str(self) -> &'static str {
        match self {
            NotifyDetail::Generic => "generic",
            NotifyDetail::PaneName => "pane_name",
        }
    }

    pub fn parse(raw: &str) -> Result<Self, String> {
        match raw {
            "generic" => Ok(NotifyDetail::Generic),
            "pane_name" => Ok(NotifyDetail::PaneName),
            other => Err(format!(
                "notify detail {other:?} is not recognised: expected \"generic\" or \"pane_name\""
            )),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Config {
    pub enabled: bool,
    pub bind: SocketAddr,
    /// Normalised origin such as `https://host.tailnet.ts.net`, without a trailing slash.
    pub public_url: Option<String>,
    pub notify_delay_secs: u32,
    pub notify_detail: NotifyDetail,
    pub notify_finished: bool,
    /// Set while notifications are on; the topic URL itself is in the keychain.
    pub ntfy_server: Option<String>,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            enabled: false,
            bind: DEFAULT_BIND.parse().expect("default bind parses"),
            public_url: None,
            notify_delay_secs: NOTIFY_DELAY_DEFAULT,
            notify_detail: NotifyDetail::Generic,
            notify_finished: false,
            ntfy_server: None,
        }
    }
}

impl Config {
    /// The URL a device opens: the configured public URL, else the bind address.
    pub fn effective_url(&self) -> String {
        match &self.public_url {
            Some(url) => url.clone(),
            None => format!("http://{}", self.bind),
        }
    }

    /// Host names a request may carry in `Host` or `Origin`. Anything else is a
    /// DNS-rebinding attempt or a misdirected request.
    pub fn allowed_hosts(&self) -> Vec<String> {
        let mut hosts = vec![
            "localhost".to_string(),
            "127.0.0.1".to_string(),
            "[::1]".to_string(),
        ];
        let bind_host = match self.bind {
            SocketAddr::V4(a) => a.ip().to_string(),
            SocketAddr::V6(a) => format!("[{}]", a.ip()),
        };
        if !self.bind.ip().is_unspecified() {
            hosts.push(bind_host);
        }
        if let Some(host) = self
            .public_url
            .as_deref()
            .and_then(|u| reqwest::Url::parse(u).ok())
            .and_then(|u| u.host_str().map(str::to_ascii_lowercase))
        {
            hosts.push(host);
        }
        hosts
    }
}

/// A partial update; `None` leaves a field unchanged.
#[derive(Debug, Clone, Default)]
pub struct ConfigPatch {
    pub enabled: Option<bool>,
    pub bind: Option<String>,
    pub public_url: Option<String>,
    pub ntfy_url: Option<String>,
    pub notify_delay_secs: Option<u32>,
    pub notify_detail: Option<String>,
    pub notify_finished: Option<bool>,
}

pub fn parse_bind(raw: &str) -> Result<SocketAddr, String> {
    let addr: SocketAddr = raw.trim().parse().map_err(|_| {
        format!("remote bind {raw:?} is not an address: expected IP:PORT such as {DEFAULT_BIND}")
    })?;
    if addr.port() == 0 {
        return Err(format!(
            "remote bind {raw:?} has port 0: expected a fixed port such as {DEFAULT_BIND}, so the \
             paired URL stays valid"
        ));
    }
    Ok(addr)
}

/// `""` clears the public URL. Otherwise an http(s) origin with no path, query,
/// fragment or credentials.
pub fn parse_public_url(raw: &str) -> Result<Option<String>, String> {
    let raw = raw.trim();
    if raw.is_empty() {
        return Ok(None);
    }
    let shape = "expected an origin such as https://machine.tailnet.ts.net";
    let url = reqwest::Url::parse(raw)
        .map_err(|e| format!("public URL {raw:?} is not a URL ({e}): {shape}"))?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err(format!(
            "public URL {raw:?} uses scheme {:?}: {shape}",
            url.scheme()
        ));
    }
    if url.host_str().is_none_or(str::is_empty) {
        return Err(format!("public URL {raw:?} has no host: {shape}"));
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err(format!("public URL {raw:?} carries credentials: {shape}"));
    }
    if url.path() != "/" || url.query().is_some() || url.fragment().is_some() {
        return Err(format!(
            "public URL {raw:?} has a path, query or fragment: {shape}"
        ));
    }
    Ok(Some(url.origin().ascii_serialization()))
}

/// `""` turns notifications off. Otherwise an http(s) topic URL without credentials.
pub fn parse_ntfy_url(raw: &str) -> Result<Option<String>, String> {
    let raw = raw.trim();
    if raw.is_empty() {
        return Ok(None);
    }
    let shape = "expected a topic URL such as https://ntfy.sh/<unguessable-topic>";
    if raw.len() > NTFY_URL_MAX {
        return Err(format!(
            "ntfy URL is {} bytes; the limit is {NTFY_URL_MAX}: {shape}",
            raw.len()
        ));
    }
    // The URL is a bearer secret, so errors name its shape, never its value.
    let url =
        reqwest::Url::parse(raw).map_err(|e| format!("ntfy URL is not a URL ({e}): {shape}"))?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err(format!("ntfy URL uses scheme {:?}: {shape}", url.scheme()));
    }
    if url.host_str().is_none_or(str::is_empty) {
        return Err(format!("ntfy URL has no host: {shape}"));
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err(format!("ntfy URL carries credentials: {shape}"));
    }
    if url.path().trim_matches('/').is_empty() {
        return Err(format!("ntfy URL names no topic: {shape}"));
    }
    if url.query().is_some() || url.fragment().is_some() {
        return Err(format!("ntfy URL has a query or fragment: {shape}"));
    }
    Ok(Some(url.to_string()))
}

/// Origin of the ntfy server, safe to show and log; the topic is the secret part.
pub fn ntfy_server(url: &str) -> Option<String> {
    reqwest::Url::parse(url)
        .ok()
        .map(|u| u.origin().ascii_serialization())
}

pub fn validate_notify_delay(secs: u32) -> Result<u32, String> {
    if secs > NOTIFY_DELAY_MAX {
        return Err(format!(
            "notify delay {secs} s is out of range: expected 0 to {NOTIFY_DELAY_MAX} seconds"
        ));
    }
    Ok(secs)
}

pub fn validate_device_name(raw: &str) -> Result<String, String> {
    let name = raw.trim();
    let len = name.chars().count();
    if name.is_empty() || len > DEVICE_NAME_MAX {
        return Err(format!(
            "device name {name:?} is {len} characters: expected 1 to {DEVICE_NAME_MAX}"
        ));
    }
    if name.chars().any(char::is_control) {
        return Err(format!(
            "device name {name:?} contains a control character: expected printable text"
        ));
    }
    Ok(name.to_string())
}

pub fn keys_to_bytes(keys: &[String]) -> Result<Vec<u8>, String> {
    let names = || {
        REMOTE_KEYS
            .iter()
            .map(|(k, _)| *k)
            .collect::<Vec<_>>()
            .join(", ")
    };
    if keys.len() > INPUT_KEYS_MAX {
        return Err(format!(
            "{} keys in one request; the limit is {INPUT_KEYS_MAX}",
            keys.len()
        ));
    }
    let mut out = Vec::new();
    for key in keys {
        let wanted = key.trim().to_ascii_lowercase();
        let Some((_, bytes)) = REMOTE_KEYS.iter().find(|(k, _)| *k == wanted) else {
            return Err(format!(
                "key {key:?} is not one remote access sends: expected one of {}",
                names()
            ));
        };
        out.extend_from_slice(bytes);
    }
    Ok(out)
}

/// Free text from a device: `\r\n` and `\r` become `\n`, and other control
/// characters are refused so text cannot end a bracketed paste or forge a key.
pub fn validate_input_text(raw: &str) -> Result<String, String> {
    let len = raw.chars().count();
    if len > INPUT_TEXT_MAX {
        return Err(format!(
            "text is {len} characters; the limit is {INPUT_TEXT_MAX}"
        ));
    }
    let text = raw.replace("\r\n", "\n").replace('\r', "\n");
    if let Some(bad) = text
        .chars()
        .find(|c| c.is_control() && *c != '\n' && *c != '\t')
    {
        return Err(format!(
            "text contains control character U+{:04X}: send keys such as esc or ctrl+c in \
             `keys` instead",
            bad as u32
        ));
    }
    Ok(text)
}

pub fn mint_secret() -> String {
    let mut bytes = [0u8; 32];
    rand::fill(&mut bytes);
    hex(&bytes)
}

pub fn mint_pairing_code() -> String {
    let mut bytes = [0u8; 16];
    rand::fill(&mut bytes);
    hex(&bytes)
}

pub fn hash_secret(raw: &str) -> String {
    hex(&Sha256::digest(raw.trim().as_bytes()))
}

fn hex(bytes: &[u8]) -> String {
    use std::fmt::Write as _;
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        let _ = write!(out, "{b:02x}");
    }
    out
}

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// An HTTP API refusal; the message names the offending value and the expected shape.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ApiError {
    BadRequest(String),
    Unauthorized(String),
    NotFound(String),
    Conflict(String),
    Internal(String),
}

impl std::fmt::Display for ApiError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ApiError::BadRequest(m)
            | ApiError::Unauthorized(m)
            | ApiError::NotFound(m)
            | ApiError::Conflict(m)
            | ApiError::Internal(m) => f.write_str(m),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PairError {
    NoneActive,
    Invalid,
    Expired,
}

impl std::fmt::Display for PairError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            PairError::NoneActive | PairError::Invalid => write!(
                f,
                "pairing code is not valid: start a new pairing in Settings > Remote access"
            ),
            PairError::Expired => write!(
                f,
                "pairing code expired after {} minutes: start a new pairing in Settings > \
                 Remote access",
                PAIRING_TTL.as_secs() / 60
            ),
        }
    }
}

struct Pairing {
    code_hash: String,
    expires: Instant,
}

/// Failed authentication or pairing attempts across all callers: behind
/// `tailscale serve` every request arrives from loopback, so a per-address
/// count would not separate anyone.
#[derive(Default)]
pub struct FailureLimiter {
    failures: VecDeque<Instant>,
    locked_until: Option<Instant>,
}

impl FailureLimiter {
    /// `Err(seconds)` while locked out.
    pub fn check(&mut self, now: Instant) -> Result<(), u64> {
        match self.locked_until {
            Some(until) if now < until => Err((until - now).as_secs().max(1)),
            Some(_) => {
                self.locked_until = None;
                Ok(())
            }
            None => Ok(()),
        }
    }

    pub fn record_failure(&mut self, now: Instant) {
        while self
            .failures
            .front()
            .is_some_and(|t| now.duration_since(*t) >= AUTH_FAILURE_WINDOW)
        {
            self.failures.pop_front();
        }
        self.failures.push_back(now);
        if self.failures.len() >= AUTH_FAILURE_LIMIT {
            self.failures.clear();
            self.locked_until = Some(now + AUTH_LOCKOUT);
        }
    }
}

pub fn lockout_message(retry_secs: u64) -> String {
    format!(
        "too many failed remote authentication attempts: the limit is {AUTH_FAILURE_LIMIT} per \
         {} s and it was reached, so remote authentication is refused for {} s; retry in {retry_secs} s",
        AUTH_FAILURE_WINDOW.as_secs(),
        AUTH_LOCKOUT.as_secs()
    )
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ListenState {
    pub listening: Option<SocketAddr>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Copy)]
pub(crate) struct SeenStatus {
    pub status: proto::AgentStatus,
    pub since_ms: u64,
    /// Bumped on every transition; a pending notification fires only if the
    /// epoch it was scheduled under is still current.
    pub epoch: u64,
}

#[derive(Debug, Clone)]
pub(crate) struct StatusEvent {
    pub session: u32,
    pub from: Option<proto::AgentStatus>,
    pub to: proto::AgentStatus,
    pub epoch: u64,
}

/// In-memory remote state owned by the daemon. Configuration persists in the
/// settings table; everything here is rebuilt at boot.
pub struct Runtime {
    pub(crate) config: Mutex<Option<Config>>,
    pub(crate) ntfy_url: Mutex<Option<zeroize::Zeroizing<String>>>,
    pub(crate) listen: Mutex<ListenState>,
    pub(crate) reconfigured: tokio::sync::watch::Sender<u64>,
    pairing: Mutex<Option<Pairing>>,
    limiter: Mutex<FailureLimiter>,
    pub(crate) seen: Mutex<HashMap<u32, SeenStatus>>,
    pub(crate) last_seen_written: Mutex<HashMap<i64, u64>>,
    status_tx: tokio::sync::mpsc::Sender<StatusEvent>,
    /// Taken by the notifier loop; transitions before it starts wait in the channel.
    pub(crate) status_rx: Mutex<Option<tokio::sync::mpsc::Receiver<StatusEvent>>>,
    next_epoch: std::sync::atomic::AtomicU64,
}

impl Default for Runtime {
    fn default() -> Self {
        Self::new()
    }
}

impl Runtime {
    pub fn new() -> Self {
        let (status_tx, status_rx) = tokio::sync::mpsc::channel(STATUS_QUEUE);
        Self {
            config: Mutex::new(None),
            ntfy_url: Mutex::new(None),
            listen: Mutex::new(ListenState::default()),
            reconfigured: tokio::sync::watch::Sender::new(0),
            pairing: Mutex::new(None),
            limiter: Mutex::new(FailureLimiter::default()),
            seen: Mutex::new(HashMap::new()),
            last_seen_written: Mutex::new(HashMap::new()),
            status_tx,
            status_rx: Mutex::new(Some(status_rx)),
            next_epoch: std::sync::atomic::AtomicU64::new(1),
        }
    }

    pub fn listen_state(&self) -> ListenState {
        self.listen.lock().expect("remote listen lock").clone()
    }

    /// Returns the code and its expiry; any earlier code stops working.
    pub fn start_pairing(&self, now: Instant) -> String {
        let code = mint_pairing_code();
        *self.pairing.lock().expect("remote pairing lock") = Some(Pairing {
            code_hash: hash_secret(&code),
            expires: now + PAIRING_TTL,
        });
        code
    }

    /// Consumes the active code on success. A wrong code leaves it in place, so a
    /// guess cannot cancel the operator's pairing.
    pub fn redeem_pairing(&self, code: &str, now: Instant) -> Result<(), PairError> {
        let mut slot = self.pairing.lock().expect("remote pairing lock");
        let Some(active) = slot.as_ref() else {
            return Err(PairError::NoneActive);
        };
        if !constant_time_eq(active.code_hash.as_bytes(), hash_secret(code).as_bytes()) {
            return Err(PairError::Invalid);
        }
        if now >= active.expires {
            *slot = None;
            return Err(PairError::Expired);
        }
        *slot = None;
        Ok(())
    }

    #[doc(hidden)]
    pub fn expire_pairing_for_test(&self) {
        if let Some(p) = self.pairing.lock().expect("remote pairing lock").as_mut() {
            p.expires = Instant::now();
        }
    }

    pub fn auth_check(&self, now: Instant) -> Result<(), u64> {
        self.limiter.lock().expect("remote limiter lock").check(now)
    }

    pub fn auth_failed(&self, now: Instant) {
        self.limiter
            .lock()
            .expect("remote limiter lock")
            .record_failure(now);
    }

    pub(crate) fn note_status(&self, session: u32, status: proto::AgentStatus, now_ms: u64) {
        let epoch = self
            .next_epoch
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let from = self
            .seen
            .lock()
            .expect("remote seen lock")
            .insert(
                session,
                SeenStatus {
                    status,
                    since_ms: now_ms,
                    epoch,
                },
            )
            .map(|s| s.status);
        let _ = self.status_tx.try_send(StatusEvent {
            session,
            from,
            to: status,
            epoch,
        });
    }

    pub(crate) fn seen(&self, session: u32) -> Option<SeenStatus> {
        self.seen
            .lock()
            .expect("remote seen lock")
            .get(&session)
            .copied()
    }
}

/// NeedsInput first, then Working, Idle, and everything else; panes that are
/// no longer running sort last.
pub fn status_rank(status: Option<proto::AgentStatus>, live: bool) -> u8 {
    if !live {
        return 5;
    }
    match status {
        Some(proto::AgentStatus::NeedsInput) => 0,
        Some(proto::AgentStatus::Working) => 1,
        Some(proto::AgentStatus::Idle) => 2,
        Some(proto::AgentStatus::Spawning) => 3,
        _ => 4,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_pairing_code_works_once() {
        let rt = Runtime::new();
        let now = Instant::now();
        let code = rt.start_pairing(now);
        assert_eq!(code.len(), 32, "128 bits in hex");
        assert_eq!(rt.redeem_pairing("nope", now), Err(PairError::Invalid));
        assert_eq!(rt.redeem_pairing(&code, now), Ok(()));
        assert_eq!(rt.redeem_pairing(&code, now), Err(PairError::NoneActive));
    }

    #[test]
    fn a_pairing_code_expires() {
        let rt = Runtime::new();
        let now = Instant::now();
        let code = rt.start_pairing(now);
        assert_eq!(
            rt.redeem_pairing(&code, now + PAIRING_TTL),
            Err(PairError::Expired)
        );
    }

    #[test]
    fn a_new_pairing_replaces_the_old_code() {
        let rt = Runtime::new();
        let now = Instant::now();
        let first = rt.start_pairing(now);
        let second = rt.start_pairing(now);
        assert_eq!(rt.redeem_pairing(&first, now), Err(PairError::Invalid));
        assert_eq!(rt.redeem_pairing(&second, now), Ok(()));
    }

    #[test]
    fn the_limiter_locks_after_the_limit_and_releases() {
        let mut l = FailureLimiter::default();
        let now = Instant::now();
        for _ in 0..AUTH_FAILURE_LIMIT - 1 {
            l.record_failure(now);
        }
        assert!(l.check(now).is_ok());
        l.record_failure(now);
        assert_eq!(l.check(now), Err(AUTH_LOCKOUT.as_secs()));
        assert!(l.check(now + AUTH_LOCKOUT).is_ok());
    }

    #[test]
    fn failures_outside_the_window_do_not_count() {
        let mut l = FailureLimiter::default();
        let start = Instant::now();
        for _ in 0..AUTH_FAILURE_LIMIT - 1 {
            l.record_failure(start);
        }
        l.record_failure(start + AUTH_FAILURE_WINDOW);
        assert!(l.check(start + AUTH_FAILURE_WINDOW).is_ok());
    }

    #[test]
    fn public_urls_are_normalised_origins() {
        assert_eq!(
            parse_public_url("https://box.tail1234.ts.net/").unwrap(),
            Some("https://box.tail1234.ts.net".to_string())
        );
        assert_eq!(parse_public_url("  ").unwrap(), None);
        assert!(parse_public_url("https://box/x").is_err());
        assert!(parse_public_url("ftp://box").is_err());
        assert!(parse_public_url("https://u:p@box").is_err());
    }

    #[test]
    fn ntfy_errors_never_echo_the_topic() {
        let err = parse_ntfy_url("https://ntfy.sh/secret-topic?x=1").unwrap_err();
        assert!(!err.contains("secret-topic"), "{err}");
        assert!(parse_ntfy_url("https://ntfy.sh/").is_err());
        assert_eq!(
            parse_ntfy_url("https://ntfy.sh/abc").unwrap().as_deref(),
            Some("https://ntfy.sh/abc")
        );
    }

    #[test]
    fn bind_refuses_port_zero() {
        assert!(parse_bind("127.0.0.1:0").is_err());
        assert!(parse_bind("nonsense").is_err());
        assert_eq!(
            parse_bind("0.0.0.0:47823").unwrap().to_string(),
            "0.0.0.0:47823"
        );
    }

    #[test]
    fn allowed_hosts_cover_bind_and_public_url() {
        let cfg = Config {
            public_url: Some("https://Box.tail1.ts.net".to_string()),
            bind: "100.64.0.2:47823".parse().unwrap(),
            ..Config::default()
        };
        let hosts = cfg.allowed_hosts();
        assert!(hosts.contains(&"box.tail1.ts.net".to_string()));
        assert!(hosts.contains(&"100.64.0.2".to_string()));
        let any = Config {
            bind: "0.0.0.0:47823".parse().unwrap(),
            ..Config::default()
        };
        assert!(!any.allowed_hosts().contains(&"0.0.0.0".to_string()));
    }

    #[test]
    fn text_refuses_escape_but_keeps_newlines() {
        assert_eq!(validate_input_text("a\r\nb").unwrap(), "a\nb");
        assert!(validate_input_text("\x1b[201~").is_err());
        assert!(validate_input_text(&"x".repeat(INPUT_TEXT_MAX + 1)).is_err());
    }

    #[test]
    fn keys_map_to_terminal_bytes() {
        assert_eq!(
            keys_to_bytes(&["Enter".into(), "ctrl+c".into()]).unwrap(),
            b"\r\x03"
        );
        assert!(keys_to_bytes(&["f1".into()]).is_err());
        assert!(keys_to_bytes(&vec!["y".to_string(); INPUT_KEYS_MAX + 1]).is_err());
    }

    #[test]
    fn needs_input_sorts_first_and_dead_panes_last() {
        let mut v = [
            status_rank(Some(proto::AgentStatus::Idle), true),
            status_rank(Some(proto::AgentStatus::NeedsInput), false),
            status_rank(Some(proto::AgentStatus::NeedsInput), true),
            status_rank(Some(proto::AgentStatus::Working), true),
        ];
        v.sort();
        assert_eq!(v, [0, 1, 2, 5]);
    }
}
