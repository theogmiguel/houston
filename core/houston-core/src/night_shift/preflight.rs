//! Preflight: what blocks or warns before a run starts, from facts the daemon
//! and the machine report. Evaluation is pure; probes read the platform.
use houston_protocol::{
    AgentAccountIdentity, AgentKind, AgentSignIn, NightShiftSettings, NightWindow, PreflightItem,
    PreflightStatus, NIGHT_SHIFT_DISK_FLOOR_MIB, NIGHT_SHIFT_MEMORY_FLOOR_MIB,
};

use super::settings::{clock_label, minutes_between};

/// What the machine reports; `None` is "not measured on this platform".
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct MachineFacts {
    pub on_battery: Option<bool>,
    pub memory_free_mib: Option<u32>,
    pub disk_free_mib: Option<u32>,
    pub reboot_pending: Option<bool>,
    /// Windows Update active hours, start and end hour.
    pub active_hours: Option<(u8, u8)>,
    pub inhibitor_available: bool,
}

/// What a provider's own local sign-in state proves.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SignIn {
    /// A signed-in account; `identity` is what its files carry (an email,
    /// "API key" or provider names), never a credential.
    In(Option<String>),
    /// The provider's own credential store explicitly records no sign-in.
    Out,
    /// The files show no account, but the CLI documents another way in.
    Ambiguous,
    /// Houston could not read the state, or the provider keeps none locally.
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProviderFacts {
    pub provider: AgentKind,
    pub hooks_on: bool,
    pub cli_present: bool,
    /// Whether its MCP configuration has a server named `rea`; `None` when
    /// Houston cannot read that configuration.
    pub rea: Option<bool>,
    pub sign_in: SignIn,
    /// The environment variable the CLI documents for a credential, when the
    /// daemon's environment carries one. A name only, never its value.
    pub env_credential: Option<&'static str>,
}

/// Environment credentials named by the CLIs' authentication docs:
/// `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_USE_BEDROCK` and
/// `CLAUDE_CODE_USE_VERTEX` for Claude; `OPENAI_API_KEY` for Codex.
pub const ENV_CREDENTIALS: &[(AgentKind, &str)] = &[
    (AgentKind::Claude, "ANTHROPIC_API_KEY"),
    (AgentKind::Claude, "ANTHROPIC_AUTH_TOKEN"),
    (AgentKind::Claude, "CLAUDE_CODE_USE_BEDROCK"),
    (AgentKind::Claude, "CLAUDE_CODE_USE_VERTEX"),
    (AgentKind::Codex, "OPENAI_API_KEY"),
];

/// The first documented environment credential set for `provider`. An empty
/// value, "0" or "false" reads as absent, so a disabled switch is not a
/// credential.
pub fn env_credential(
    provider: AgentKind,
    mut var: impl FnMut(&str) -> Option<String>,
) -> Option<&'static str> {
    ENV_CREDENTIALS.iter().find_map(|(p, name)| {
        let set = *p == provider
            && var(name).is_some_and(|v| {
                let v = v.trim();
                !v.is_empty() && !v.eq_ignore_ascii_case("0") && !v.eq_ignore_ascii_case("false")
            });
        set.then_some(*name)
    })
}

/// One provider's sign-in state from the identities Houston read. Signed in
/// when any readable account is; signed out only when every row is that
/// provider's own definitive signal; unknown when a row could not be read.
pub fn login_fact(rows: &[AgentAccountIdentity], provider: AgentKind) -> SignIn {
    let mut identity = None;
    let mut signed_in = false;
    let mut signed_out = false;
    let mut ambiguous = false;
    let mut unknown = false;
    let mut seen = false;
    for row in rows.iter().filter(|r| r.agent == provider) {
        seen = true;
        match row.sign_in {
            AgentSignIn::SignedIn => {
                signed_in = true;
                if identity.is_none() {
                    identity = row.identity.clone();
                }
            }
            AgentSignIn::SignedOut => {
                signed_out = true;
                match signed_out_state(provider, row) {
                    SignedOutState::Definitive => {}
                    SignedOutState::Ambiguous => ambiguous = true,
                    SignedOutState::Unreadable => unknown = true,
                }
            }
            AgentSignIn::Unknown => unknown = true,
        }
    }
    if signed_in {
        SignIn::In(identity)
    } else if !seen || unknown {
        SignIn::Unknown
    } else if signed_out && !ambiguous {
        SignIn::Out
    } else {
        SignIn::Ambiguous
    }
}

/// The reasons `codex_identity` reports for a store that is absent and for a
/// readable store that holds no credential. A change to either string fails
/// `codex_reasons_classify_from_the_real_identity_output`.
const CODEX_STORE_MISSING: &str = "does not exist";
const CODEX_NO_CREDENTIAL: &str = "has neither tokens.id_token nor an API key";

/// How a signed-out row bears on a provider's sign-in state.
enum SignedOutState {
    /// The provider's readable store explicitly records no credential.
    Definitive,
    /// The provider may authenticate through a path Houston does not read.
    Ambiguous,
    /// Houston could not read or decode the store.
    Unreadable,
}

/// Only Codex's readable store proves a sign-out. Other CLIs document another
/// way in, `verified` guards the read, and an unreadable store proves nothing.
fn signed_out_state(provider: AgentKind, row: &AgentAccountIdentity) -> SignedOutState {
    if provider != AgentKind::Codex {
        return SignedOutState::Ambiguous;
    }
    if !row.verified {
        return SignedOutState::Ambiguous;
    }
    let Some(reason) = row.reason.as_deref() else {
        return SignedOutState::Ambiguous;
    };
    if reason.contains(CODEX_STORE_MISSING) || reason.contains(CODEX_NO_CREDENTIAL) {
        SignedOutState::Definitive
    } else {
        SignedOutState::Unreadable
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Facts {
    pub orchestration_enabled: bool,
    pub providers: Vec<ProviderFacts>,
    pub machine: MachineFacts,
}

/// Every provider a run would launch: orchestrator, reviewer and workers.
pub fn providers_of(s: &NightShiftSettings) -> Vec<AgentKind> {
    let mut out = vec![s.orchestrator.provider];
    if let Some(r) = &s.reviewer {
        out.push(r.provider);
    }
    out.extend(s.workers.iter().map(|w| w.provider));
    let mut seen = Vec::new();
    out.retain(|p| {
        let fresh = !seen.contains(p);
        seen.push(*p);
        fresh
    });
    out
}

fn item(
    id: impl Into<String>,
    status: PreflightStatus,
    label: &str,
    detail: String,
) -> PreflightItem {
    PreflightItem {
        id: id.into(),
        status,
        label: label.into(),
        detail,
        limit: None,
        actual: None,
    }
}

fn floor_item(id: &str, label: &str, free: Option<u32>, floor: u32, what: &str) -> PreflightItem {
    let gib = |mib: u32| format!("{:.1} GiB", f64::from(mib) / 1024.0);
    match free {
        Some(free) if free < floor => PreflightItem {
            limit: Some(format!("{floor} MiB")),
            actual: Some(format!("{free} MiB")),
            ..item(
                id,
                PreflightStatus::Block,
                label,
                format!(
                    "{} {what} free; a run needs at least {}",
                    gib(free),
                    gib(floor)
                ),
            )
        },
        Some(free) => PreflightItem {
            limit: Some(format!("{floor} MiB")),
            actual: Some(format!("{free} MiB")),
            ..item(
                id,
                PreflightStatus::Ok,
                label,
                format!(
                    "{} {what} free; a run needs at least {}",
                    gib(free),
                    gib(floor)
                ),
            )
        },
        None => item(
            id,
            PreflightStatus::Warn,
            label,
            format!("free {what} could not be read on this machine"),
        ),
    }
}

/// `run` is the clock window the run will cover: the settings' window for a
/// scheduled start, Run now's for a manual one.
pub fn evaluate(s: &NightShiftSettings, facts: &Facts, run: &NightWindow) -> Vec<PreflightItem> {
    let mut out = Vec::new();
    out.push(if facts.orchestration_enabled {
        item(
            "orchestration",
            PreflightStatus::Ok,
            "Agent spawning",
            "on".into(),
        )
    } else {
        item(
            "orchestration_off",
            PreflightStatus::Block,
            "Agent spawning",
            "agent spawning is off, so the orchestrator cannot start workers; turn it on in \
             Settings ▸ Agents ▸ Orchestration"
                .into(),
        )
    });
    for provider in providers_of(s) {
        let slug = crate::agent_hooks::provider_slug(provider);
        let f = facts.providers.iter().find(|p| p.provider == provider);
        if !f.is_some_and(|f| f.cli_present) {
            out.push(item(
                format!("cli_missing:{slug}"),
                PreflightStatus::Block,
                "Provider CLI",
                format!("the {slug} CLI is not installed or not on PATH"),
            ));
        } else if !f.is_some_and(|f| f.hooks_on) {
            out.push(item(
                format!("hooks_off:{slug}"),
                PreflightStatus::Block,
                "Provider hooks",
                format!(
                    "{slug} hooks are off, so Houston cannot see its turns end; turn them on in \
                     Settings ▸ Agents ▸ Hooks"
                ),
            ));
        } else {
            out.push(item(
                format!("provider:{slug}"),
                PreflightStatus::Ok,
                "Provider",
                format!("{slug} is installed and its hooks are on"),
            ));
        }
        if let Some(f) = f.filter(|f| f.cli_present) {
            out.push(sign_in_item(provider, &f.sign_in, f.env_credential));
        }
    }
    let m = &facts.machine;
    out.push(match m.on_battery {
        Some(true) => PreflightItem {
            limit: Some("AC power".into()),
            actual: Some("battery".into()),
            ..item(
                "on_battery",
                PreflightStatus::Block,
                "Power",
                "the machine is on battery; plug it in, since a run keeps it awake for hours"
                    .into(),
            )
        },
        Some(false) => item("power", PreflightStatus::Ok, "Power", "on AC power".into()),
        None => item(
            "power",
            PreflightStatus::Ok,
            "Power",
            "no battery reported".into(),
        ),
    });
    out.push(floor_item(
        "memory",
        "Free memory",
        m.memory_free_mib,
        NIGHT_SHIFT_MEMORY_FLOOR_MIB,
        "memory",
    ));
    out.push(floor_item(
        "disk",
        "Free disk",
        m.disk_free_mib,
        NIGHT_SHIFT_DISK_FLOOR_MIB,
        "disk",
    ));
    out.push(if s.checks.is_empty() {
        item(
            "checks_missing",
            PreflightStatus::Block,
            "Checks before hand-back",
            "no check is configured; add at least one command every change must pass".into(),
        )
    } else {
        item(
            "checks",
            PreflightStatus::Ok,
            "Checks before hand-back",
            format!("{} configured", s.checks.len()),
        )
    });
    out.extend(rea_items(s, facts));
    if s.app_qa.enabled && s.app_qa.start_command.trim().is_empty() {
        out.push(item(
            "app_qa_start_missing",
            PreflightStatus::Block,
            "App QA",
            "App QA is on but has no start command; enter one in Setup or turn App QA off".into(),
        ));
    }
    out.extend(restart_items(m.reboot_pending, m.active_hours, run));
    out.extend(super::awake::inhibitor_item(m.inhibitor_available));
    out
}

/// What the provider's own local sign-in files say, or an environment
/// credential it documents. The detail names the identifier or variable only;
/// Houston never reads or shows a token.
fn sign_in_item(
    provider: AgentKind,
    sign_in: &SignIn,
    env_credential: Option<&str>,
) -> PreflightItem {
    let slug = crate::agent_hooks::provider_slug(provider);
    let id = format!("signin:{slug}");
    match sign_in {
        SignIn::In(identity) => item(
            id,
            PreflightStatus::Ok,
            "Sign-in",
            match identity {
                Some(identity) => format!("signed in as {identity}"),
                None => format!("signed in; {slug} stores no readable identifier"),
            },
        ),
        // A store that says it holds no credential still warns when the
        // environment supplies one: Houston cannot confirm that key works.
        _ if env_credential.is_some() => item(
            id,
            if *sign_in == SignIn::Out {
                PreflightStatus::Warn
            } else {
                PreflightStatus::Ok
            },
            "Sign-in",
            format!(
                "credentials from the environment ({})",
                env_credential.unwrap_or_default()
            ),
        ),
        // Out only reaches here from a provider whose own store records it;
        // another provider's row is the ambiguous absence its CLI allows.
        SignIn::Out if provider == AgentKind::Codex => item(
            id,
            PreflightStatus::Block,
            "Sign-in",
            format!("{slug} is signed out, which blocks this run: run `{slug}` and sign in"),
        ),
        SignIn::Out | SignIn::Ambiguous => item(
            id,
            PreflightStatus::Warn,
            "Sign-in",
            format!(
                "no {slug} account sign-in found; fine if you use an API key or a cloud \
                 provider, otherwise run `{slug}` and sign in"
            ),
        ),
        SignIn::Unknown if provider == AgentKind::Zcode => item(
            id,
            PreflightStatus::Warn,
            "Sign-in",
            "could not tell whether zcode is signed in; the quota probe decides".into(),
        ),
        SignIn::Unknown => item(
            id,
            PreflightStatus::Warn,
            "Sign-in",
            format!(
                "could not tell whether {slug} is signed in; Houston reads only its local \
                 sign-in files, so start it once and sign in if it asks"
            ),
        ),
    }
}

/// An installed-app competitor is analysed with REA by the scouts, which run
/// on the worker providers: each needs it.
fn rea_items(s: &NightShiftSettings, facts: &Facts) -> Vec<PreflightItem> {
    let apps = s
        .competitors
        .iter()
        .any(|c| matches!(c, houston_protocol::NightCompetitor::App { .. }));
    if !apps || s.focus.competitor_gaps == houston_protocol::NightFocusLevel::Off {
        return Vec::new();
    }
    let mut seen = Vec::new();
    s.workers
        .iter()
        .map(|w| w.provider)
        .filter(|p| {
            let fresh = !seen.contains(p);
            seen.push(*p);
            fresh
        })
        .filter_map(|provider| {
            let slug = crate::agent_hooks::provider_slug(provider);
            let rea = facts
                .providers
                .iter()
                .find(|f| f.provider == provider)
                .and_then(|f| f.rea);
            let detail = match rea {
                Some(true) => return None,
                Some(false) => format!(
                    "an installed-app competitor is analysed with REA, but {slug} has no MCP \
                     server named rea; add one for {slug} or remove the app competitor"
                ),
                None => format!(
                    "an installed-app competitor is analysed with REA, and Houston cannot read \
                     {slug}'s MCP configuration to confirm it has REA; use another worker \
                     provider or remove the app competitor"
                ),
            };
            Some(item(
                format!("rea_missing:{slug}"),
                PreflightStatus::Block,
                "REA for app competitors",
                detail,
            ))
        })
        .collect()
}

/// Windows restarts for updates outside its active hours; a window reaching
/// into those hours may be cut short.
pub fn restart_items(
    reboot_pending: Option<bool>,
    active_hours: Option<(u8, u8)>,
    w: &NightWindow,
) -> Vec<PreflightItem> {
    let mut out = Vec::new();
    let hours = active_hours.map(|(a, b)| format!("{a:02}:00–{b:02}:00"));
    if reboot_pending == Some(true) {
        out.push(PreflightItem {
            actual: Some("restart pending".into()),
            ..item(
                "restart_pending",
                PreflightStatus::Warn,
                "Pending restart",
                format!(
                    "Windows has a restart pending and may restart outside active hours{}; \
                     restart before the run to avoid an interruption",
                    hours
                        .as_deref()
                        .map(|h| format!(" ({h})"))
                        .unwrap_or_default()
                ),
            )
        });
    }
    if let (Some((start, end)), Some(label)) = (active_hours, hours) {
        if window_leaves_active_hours(w, start, end) {
            out.push(PreflightItem {
                limit: Some(label.clone()),
                actual: Some(format!(
                    "{}–{}",
                    clock_label(w.start),
                    clock_label(w.hard_stop)
                )),
                ..item(
                    "restart_window",
                    PreflightStatus::Warn,
                    "Update restarts",
                    format!(
                        "the window {}–{} reaches outside Windows Update active hours {label}, \
                         when Windows may restart for updates",
                        clock_label(w.start),
                        clock_label(w.hard_stop)
                    ),
                )
            });
        }
    }
    out
}

/// True when any minute of the window falls outside `[start, end)` active
/// hours (which may wrap past midnight).
fn window_leaves_active_hours(w: &NightWindow, start: u8, end: u8) -> bool {
    let active = |minute: u32| {
        let h = (minute / 60) as u8;
        if start == end {
            true
        } else if start < end {
            (start..end).contains(&h)
        } else {
            h >= start || h < end
        }
    };
    let begin = u32::from(w.start.hour) * 60 + u32::from(w.start.minute);
    let len = minutes_between(w.start, w.hard_stop);
    (0..len).any(|m| !active((begin + m) % 1440))
}

/// Parses `ActiveHoursStart`/`ActiveHoursEnd` as the registry stores them.
pub fn active_hours_from_registry(start: Option<u32>, end: Option<u32>) -> Option<(u8, u8)> {
    match (start, end) {
        (Some(a), Some(b)) if a < 24 && b < 24 => Some((a as u8, b as u8)),
        _ => None,
    }
}

pub fn memory_free_mib() -> Option<u32> {
    probe::memory_free_mib()
}

pub fn probe_machine(state_dir: &std::path::Path, path_env: Option<&str>) -> MachineFacts {
    let (reboot_pending, active_hours) = probe::restart();
    MachineFacts {
        on_battery: probe::on_battery(),
        memory_free_mib: probe::memory_free_mib(),
        disk_free_mib: probe::disk_free_mib(state_dir),
        reboot_pending,
        active_hours,
        inhibitor_available: super::awake::available(path_env),
    }
}

#[cfg(target_os = "linux")]
mod probe {
    pub fn on_battery() -> Option<bool> {
        let dir = std::fs::read_dir("/sys/class/power_supply").ok()?;
        let mut mains = None;
        let mut battery = false;
        for entry in dir.flatten() {
            let p = entry.path();
            let kind = std::fs::read_to_string(p.join("type")).unwrap_or_default();
            match kind.trim() {
                "Mains" | "USB" => {
                    let online = std::fs::read_to_string(p.join("online")).unwrap_or_default();
                    if online.trim() == "1" {
                        mains = Some(true);
                    } else if mains.is_none() {
                        mains = Some(false);
                    }
                }
                "Battery" => battery = true,
                _ => {}
            }
        }
        match (battery, mains) {
            (true, Some(online)) => Some(!online),
            _ => None,
        }
    }

    pub fn memory_free_mib() -> Option<u32> {
        let meminfo = std::fs::read_to_string("/proc/meminfo").ok()?;
        let kb: u64 = meminfo
            .lines()
            .find_map(|l| l.strip_prefix("MemAvailable:"))?
            .trim()
            .trim_end_matches("kB")
            .trim()
            .parse()
            .ok()?;
        u32::try_from(kb / 1024).ok()
    }

    pub fn disk_free_mib(dir: &std::path::Path) -> Option<u32> {
        use std::os::unix::ffi::OsStrExt;
        let c = std::ffi::CString::new(dir.as_os_str().as_bytes()).ok()?;
        // SAFETY: `c` is a NUL-terminated path and `st` a zeroed out-parameter.
        let mut st: libc::statvfs = unsafe { std::mem::zeroed() };
        if unsafe { libc::statvfs(c.as_ptr(), &mut st) } != 0 {
            return None;
        }
        let bytes = st.f_bavail as u64 * st.f_frsize as u64;
        u32::try_from(bytes / (1024 * 1024)).ok()
    }

    pub fn restart() -> (Option<bool>, Option<(u8, u8)>) {
        (None, None)
    }
}

#[cfg(windows)]
mod probe {
    use windows_sys::Win32::Foundation::ERROR_SUCCESS;
    use windows_sys::Win32::System::Registry::{
        RegCloseKey, RegOpenKeyExW, RegQueryValueExW, HKEY, HKEY_LOCAL_MACHINE, KEY_READ,
    };

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(Some(0)).collect()
    }

    pub fn on_battery() -> Option<bool> {
        use windows_sys::Win32::System::Power::{GetSystemPowerStatus, SYSTEM_POWER_STATUS};
        // SAFETY: `status` is a zeroed out-parameter of the declared type.
        let mut status: SYSTEM_POWER_STATUS = unsafe { std::mem::zeroed() };
        if unsafe { GetSystemPowerStatus(&mut status) } == 0 {
            return None;
        }
        match status.ACLineStatus {
            0 => Some(true),
            1 => Some(false),
            _ => None,
        }
    }

    pub fn memory_free_mib() -> Option<u32> {
        use windows_sys::Win32::System::SystemInformation::{GlobalMemoryStatusEx, MEMORYSTATUSEX};
        // SAFETY: `status` is zeroed and carries its own length, as the API requires.
        let mut status: MEMORYSTATUSEX = unsafe { std::mem::zeroed() };
        status.dwLength = std::mem::size_of::<MEMORYSTATUSEX>() as u32;
        if unsafe { GlobalMemoryStatusEx(&mut status) } == 0 {
            return None;
        }
        u32::try_from(status.ullAvailPhys / (1024 * 1024)).ok()
    }

    pub fn disk_free_mib(dir: &std::path::Path) -> Option<u32> {
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::Storage::FileSystem::GetDiskFreeSpaceExW;
        let path: Vec<u16> = dir.as_os_str().encode_wide().chain(Some(0)).collect();
        let mut free: u64 = 0;
        // SAFETY: `path` is NUL-terminated; the null out-parameters are optional.
        let ok = unsafe {
            GetDiskFreeSpaceExW(
                path.as_ptr(),
                &mut free,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
            )
        };
        if ok == 0 {
            return None;
        }
        u32::try_from(free / (1024 * 1024)).ok()
    }

    fn open(path: &str) -> Option<HKEY> {
        let p = wide(path);
        let mut key: HKEY = std::ptr::null_mut();
        // SAFETY: `p` is NUL-terminated and `key` an out-parameter closed by the caller.
        let rc = unsafe { RegOpenKeyExW(HKEY_LOCAL_MACHINE, p.as_ptr(), 0, KEY_READ, &mut key) };
        (rc == ERROR_SUCCESS).then_some(key)
    }

    fn key_exists(path: &str) -> bool {
        match open(path) {
            Some(key) => {
                // SAFETY: `key` was opened above and is closed once.
                unsafe { RegCloseKey(key) };
                true
            }
            None => false,
        }
    }

    fn dword(path: &str, name: &str) -> Option<u32> {
        let key = open(path)?;
        let n = wide(name);
        let mut value: u32 = 0;
        let mut size = std::mem::size_of::<u32>() as u32;
        // SAFETY: the buffer is a u32 of `size` bytes; the key is closed after.
        let rc = unsafe {
            RegQueryValueExW(
                key,
                n.as_ptr(),
                std::ptr::null(),
                std::ptr::null_mut(),
                (&mut value as *mut u32).cast(),
                &mut size,
            )
        };
        unsafe { RegCloseKey(key) };
        (rc == ERROR_SUCCESS).then_some(value)
    }

    pub fn restart() -> (Option<bool>, Option<(u8, u8)>) {
        let pending = key_exists(
            r"SOFTWARE\Microsoft\Windows\CurrentVersion\WindowsUpdate\Auto Update\RebootRequired",
        ) || key_exists(
            r"SOFTWARE\Microsoft\Windows\CurrentVersion\Component Based Servicing\RebootPending",
        );
        let ux = r"SOFTWARE\Microsoft\WindowsUpdate\UX\Settings";
        let hours = super::active_hours_from_registry(
            dword(ux, "ActiveHoursStart"),
            dword(ux, "ActiveHoursEnd"),
        );
        (Some(pending), hours)
    }
}

#[cfg(not(any(target_os = "linux", windows)))]
mod probe {
    pub fn on_battery() -> Option<bool> {
        None
    }
    pub fn memory_free_mib() -> Option<u32> {
        None
    }
    pub fn disk_free_mib(_dir: &std::path::Path) -> Option<u32> {
        None
    }
    pub fn restart() -> (Option<bool>, Option<(u8, u8)>) {
        (None, None)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use houston_protocol::NightClock;

    fn facts(machine: MachineFacts) -> Facts {
        Facts {
            orchestration_enabled: true,
            providers: [AgentKind::Claude, AgentKind::Zcode]
                .into_iter()
                .map(|provider| ProviderFacts {
                    provider,
                    hooks_on: true,
                    cli_present: true,
                    rea: Some(provider == AgentKind::Claude),
                    sign_in: SignIn::In(Some(format!(
                        "{}@example.com",
                        crate::agent_hooks::provider_slug(provider)
                    ))),
                    env_credential: None,
                })
                .collect(),
            machine,
        }
    }

    fn healthy() -> MachineFacts {
        MachineFacts {
            on_battery: Some(false),
            memory_free_mib: Some(16 * 1024),
            disk_free_mib: Some(100 * 1024),
            reboot_pending: Some(false),
            active_hours: None,
            inhibitor_available: true,
        }
    }

    fn settings() -> NightShiftSettings {
        let mut s = crate::night_shift::settings::defaults();
        s.checks = vec![houston_protocol::NightCheck {
            command: "cargo test".into(),
            source: "added by you".into(),
        }];
        s
    }

    fn all_provider_settings() -> NightShiftSettings {
        let mut s = settings();
        s.reviewer = Some(houston_protocol::NightAgent {
            provider: AgentKind::Codex,
            model: None,
        });
        s.workers = [
            AgentKind::Opencode,
            AgentKind::Antigravity,
            AgentKind::Zcode,
        ]
        .into_iter()
        .map(|provider| houston_protocol::NightAgent {
            provider,
            model: None,
        })
        .collect();
        s
    }

    fn all_provider_facts(sign_in: SignIn) -> Facts {
        Facts {
            orchestration_enabled: true,
            providers: providers_of(&all_provider_settings())
                .into_iter()
                .map(|provider| ProviderFacts {
                    provider,
                    hooks_on: true,
                    cli_present: true,
                    rea: None,
                    sign_in: sign_in.clone(),
                    env_credential: None,
                })
                .collect(),
            machine: healthy(),
        }
    }

    fn blocks(items: &[PreflightItem]) -> Vec<&PreflightItem> {
        items
            .iter()
            .filter(|i| i.status == PreflightStatus::Block)
            .collect()
    }

    fn signin_item<'a>(items: &'a [PreflightItem], slug: &str) -> &'a PreflightItem {
        items
            .iter()
            .find(|i| i.id == format!("signin:{slug}"))
            .unwrap_or_else(|| panic!("{slug} has a sign-in item: {items:?}"))
    }

    fn set_codex_sign_in(f: &mut Facts, sign_in: SignIn, env: Option<&'static str>) {
        let codex = f
            .providers
            .iter_mut()
            .find(|p| p.provider == AgentKind::Codex)
            .expect("the fixture lists Codex");
        codex.sign_in = sign_in;
        codex.env_credential = env;
    }

    #[test]
    fn signed_in_providers_report_the_identity_label() {
        let s = all_provider_settings();
        let items = evaluate(
            &s,
            &all_provider_facts(SignIn::In(Some("dev@example.com".into()))),
            &s.window,
        );
        for provider in providers_of(&s) {
            let slug = crate::agent_hooks::provider_slug(provider);
            let item = items
                .iter()
                .find(|i| i.id == format!("signin:{slug}"))
                .unwrap_or_else(|| panic!("{slug} has a sign-in item: {items:?}"));
            assert_eq!(item.status, PreflightStatus::Ok, "{item:?}");
            assert_eq!(item.detail, "signed in as dev@example.com");
        }
    }

    /// Only a provider whose own store says it holds no credential blocks:
    /// the others document an API key, a cloud provider or another store.
    #[test]
    fn a_signed_out_provider_blocks_only_when_its_cli_says_so() {
        let s = all_provider_settings();
        let items = evaluate(&s, &all_provider_facts(SignIn::Out), &s.window);
        for provider in providers_of(&s) {
            let slug = crate::agent_hooks::provider_slug(provider);
            let item = items
                .iter()
                .find(|i| i.id == format!("signin:{slug}"))
                .unwrap_or_else(|| panic!("{slug} has a sign-in item: {items:?}"));
            if provider == AgentKind::Codex {
                assert_eq!(item.status, PreflightStatus::Block, "{item:?}");
                assert!(
                    item.detail.contains(&format!("run `{slug}` and sign in")),
                    "{item:?}"
                );
            } else {
                assert_eq!(item.status, PreflightStatus::Warn, "{item:?}");
                assert!(
                    item.detail.contains("fine if you use an API key"),
                    "{item:?}"
                );
                assert!(
                    item.detail.contains(&format!("run `{slug}` and sign in")),
                    "{item:?}"
                );
            }
        }
        assert_eq!(
            blocks(&items)
                .iter()
                .map(|b| b.id.as_str())
                .collect::<Vec<_>>(),
            ["signin:codex"]
        );
    }

    #[test]
    fn an_environment_credential_is_ok_and_names_the_variable_only() {
        let s = all_provider_settings();
        let mut f = all_provider_facts(SignIn::Ambiguous);
        for provider in &mut f.providers {
            provider.env_credential = match provider.provider {
                AgentKind::Claude => Some("ANTHROPIC_API_KEY"),
                AgentKind::Codex => Some("OPENAI_API_KEY"),
                _ => None,
            };
        }
        let items = evaluate(&s, &f, &s.window);
        for provider in providers_of(&s) {
            let slug = crate::agent_hooks::provider_slug(provider);
            let item = items
                .iter()
                .find(|i| i.id == format!("signin:{slug}"))
                .unwrap_or_else(|| panic!("{slug} has a sign-in item: {items:?}"));
            match provider {
                AgentKind::Claude => {
                    assert_eq!(item.status, PreflightStatus::Ok, "{item:?}");
                    assert_eq!(
                        item.detail,
                        "credentials from the environment (ANTHROPIC_API_KEY)"
                    );
                }
                AgentKind::Codex => {
                    assert_eq!(item.status, PreflightStatus::Ok, "{item:?}");
                    assert_eq!(
                        item.detail,
                        "credentials from the environment (OPENAI_API_KEY)"
                    );
                }
                _ => assert_eq!(item.status, PreflightStatus::Warn, "{item:?}"),
            }
        }
    }

    /// A missing Codex store is a signed-out row, so it blocks unless the
    /// daemon's own environment carries the documented credential.
    #[test]
    fn a_missing_codex_store_blocks_without_an_environment_credential() {
        let dir = tempfile::tempdir().unwrap();
        let rows = [crate::cli_accounts::codex_identity(dir.path(), None)];
        let sign_in = login_fact(&rows, AgentKind::Codex);
        assert_eq!(sign_in, SignIn::Out);

        let s = all_provider_settings();
        let mut f = all_provider_facts(SignIn::In(None));
        set_codex_sign_in(&mut f, sign_in.clone(), None);
        let items = evaluate(&s, &f, &s.window);
        let item = signin_item(&items, "codex");
        assert_eq!(item.status, PreflightStatus::Block, "{item:?}");
        assert!(item.detail.contains("run `codex` and sign in"), "{item:?}");

        set_codex_sign_in(&mut f, sign_in, Some("OPENAI_API_KEY"));
        let items = evaluate(&s, &f, &s.window);
        let item = signin_item(&items, "codex");
        assert_eq!(item.status, PreflightStatus::Warn, "{item:?}");
        assert_eq!(
            item.detail,
            "credentials from the environment (OPENAI_API_KEY)"
        );
        assert!(blocks(&items).is_empty(), "{:?}", blocks(&items));
    }

    /// A store Houston could not read or decode is not proof of a sign-out.
    #[test]
    fn a_corrupt_codex_store_warns_instead_of_blocking() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("auth.json"), "[1,2").unwrap();
        let rows = [crate::cli_accounts::codex_identity(dir.path(), None)];
        let sign_in = login_fact(&rows, AgentKind::Codex);
        assert_eq!(sign_in, SignIn::Unknown);

        let s = all_provider_settings();
        let mut f = all_provider_facts(SignIn::In(None));
        set_codex_sign_in(&mut f, sign_in, None);
        let items = evaluate(&s, &f, &s.window);
        let item = signin_item(&items, "codex");
        assert_eq!(item.status, PreflightStatus::Warn, "{item:?}");
        assert!(
            item.detail
                .contains("could not tell whether codex is signed in"),
            "{item:?}"
        );
        assert!(blocks(&items).is_empty(), "{:?}", blocks(&items));
    }

    /// Claude omits `oauthAccount` for an API key, Bedrock, Vertex and a setup
    /// token, so its signed-out row stays ambiguous.
    #[test]
    fn a_claude_store_without_an_oauth_account_warns() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join(".claude.json");
        std::fs::write(&file, "{}").unwrap();
        let rows = [crate::cli_accounts::claude_identity(&file, None)];
        let sign_in = login_fact(&rows, AgentKind::Claude);
        assert_eq!(sign_in, SignIn::Ambiguous);

        let s = all_provider_settings();
        let mut f = all_provider_facts(SignIn::In(None));
        f.providers
            .iter_mut()
            .find(|p| p.provider == AgentKind::Claude)
            .expect("the fixture lists Claude")
            .sign_in = sign_in;
        let items = evaluate(&s, &f, &s.window);
        let item = signin_item(&items, "claude");
        assert_eq!(item.status, PreflightStatus::Warn, "{item:?}");
        assert!(
            item.detail.contains("fine if you use an API key"),
            "{item:?}"
        );
        assert!(blocks(&items).is_empty(), "{:?}", blocks(&items));
    }

    #[test]
    fn unknown_sign_in_warns_and_zcode_names_the_quota_probe() {
        let s = all_provider_settings();
        let items = evaluate(&s, &all_provider_facts(SignIn::Unknown), &s.window);
        assert!(blocks(&items).is_empty(), "{:?}", blocks(&items));
        for provider in providers_of(&s) {
            let slug = crate::agent_hooks::provider_slug(provider);
            let item = items
                .iter()
                .find(|i| i.id == format!("signin:{slug}"))
                .unwrap_or_else(|| panic!("{slug} has a sign-in item: {items:?}"));
            assert_eq!(item.status, PreflightStatus::Warn, "{item:?}");
        }
        let zcode = items
            .iter()
            .find(|i| i.id == "signin:zcode")
            .expect("ZCode has a sign-in item");
        assert_eq!(
            zcode.detail,
            "could not tell whether zcode is signed in; the quota probe decides"
        );
    }

    #[test]
    fn login_fact_reads_accounts_of_every_provider() {
        let row = |agent, sign_in, identity: Option<&str>, reason: Option<&str>| {
            houston_protocol::AgentAccountIdentity {
                agent,
                profile_id: None,
                sign_in,
                identity: identity.map(str::to_string),
                detail: None,
                providers: Vec::new(),
                reason: reason.map(str::to_string),
                verified: true,
            }
        };
        let rows = vec![
            row(
                AgentKind::Claude,
                AgentSignIn::SignedIn,
                Some("dev@example.com"),
                None,
            ),
            row(
                AgentKind::Claude,
                AgentSignIn::SignedOut,
                None,
                Some("no oauthAccount.emailAddress"),
            ),
            row(
                AgentKind::Codex,
                AgentSignIn::SignedOut,
                None,
                Some("has neither tokens.id_token nor an API key"),
            ),
            row(AgentKind::Opencode, AgentSignIn::SignedOut, None, None),
            row(AgentKind::Zcode, AgentSignIn::Unknown, None, None),
        ];
        assert_eq!(
            login_fact(&rows, AgentKind::Claude),
            SignIn::In(Some("dev@example.com".into()))
        );
        assert_eq!(login_fact(&rows, AgentKind::Codex), SignIn::Out);
        assert_eq!(login_fact(&rows, AgentKind::Opencode), SignIn::Ambiguous);
        assert_eq!(login_fact(&rows, AgentKind::Zcode), SignIn::Unknown);
        assert_eq!(login_fact(&rows, AgentKind::Antigravity), SignIn::Unknown);
    }

    fn signed_out_row(
        agent: AgentKind,
        verified: bool,
        reason: &str,
    ) -> houston_protocol::AgentAccountIdentity {
        houston_protocol::AgentAccountIdentity {
            agent,
            profile_id: None,
            sign_in: AgentSignIn::SignedOut,
            identity: None,
            detail: None,
            providers: Vec::new(),
            reason: Some(reason.into()),
            verified,
        }
    }

    /// A signed-out row from an unverified store, a store Houston could not
    /// read, or a provider with another way in is not a definitive sign-out.
    #[test]
    fn only_a_verified_provider_specific_signed_out_row_is_definitive() {
        let definitive = |agent| signed_out_row(agent, true, "auth.json has neither x");
        for provider in [
            AgentKind::Claude,
            AgentKind::Opencode,
            AgentKind::Antigravity,
            AgentKind::Zcode,
        ] {
            assert_eq!(
                login_fact(&[definitive(provider)], provider),
                SignIn::Ambiguous,
                "{provider:?}"
            );
        }
        let codex_caught = |reason: &str| {
            login_fact(
                &[signed_out_row(AgentKind::Codex, true, reason)],
                AgentKind::Codex,
            )
        };
        assert_eq!(codex_caught(CODEX_NO_CREDENTIAL), SignIn::Out);
        assert_eq!(codex_caught(CODEX_STORE_MISSING), SignIn::Out);
        assert_eq!(
            codex_caught("auth.json: tokens.id_token is not a decodable JWT"),
            SignIn::Unknown,
            "a corrupt store does not prove a sign-out"
        );
        assert_eq!(
            login_fact(
                &[signed_out_row(AgentKind::Codex, false, "store read")],
                AgentKind::Codex
            ),
            SignIn::Ambiguous,
            "an unconfirmed store does not prove a sign-out"
        );
        assert_eq!(
            login_fact(
                &[
                    signed_out_row(AgentKind::Codex, true, CODEX_NO_CREDENTIAL),
                    signed_out_row(AgentKind::Zcode, true, "store read")
                ],
                AgentKind::Codex
            ),
            SignIn::Out,
            "another provider's row does not count"
        );
    }

    /// The classifier must keep reading the reason strings `codex_identity`
    /// actually produces; a renamed reason would otherwise change it silently.
    #[test]
    fn codex_reasons_classify_from_the_real_identity_output() {
        let dir = tempfile::tempdir().unwrap();
        let missing = crate::cli_accounts::codex_identity(dir.path(), None);
        assert_eq!(missing.sign_in, AgentSignIn::SignedOut);
        assert_eq!(
            login_fact(&[missing], AgentKind::Codex),
            SignIn::Out,
            "a missing store is a definitive sign-out"
        );

        std::fs::write(dir.path().join("auth.json"), r#"{"auth_mode":"chatgpt"}"#).unwrap();
        let empty = crate::cli_accounts::codex_identity(dir.path(), None);
        assert_eq!(empty.sign_in, AgentSignIn::SignedOut);
        assert_eq!(
            login_fact(&[empty], AgentKind::Codex),
            SignIn::Out,
            "a readable store with neither token nor key is a definitive sign-out"
        );

        std::fs::write(dir.path().join("auth.json"), "[1,2").unwrap();
        let malformed = crate::cli_accounts::codex_identity(dir.path(), None);
        assert!(malformed
            .reason
            .as_deref()
            .unwrap()
            .contains("not valid JSON"));
        assert_eq!(
            login_fact(&[malformed], AgentKind::Codex),
            SignIn::Unknown,
            "an unreadable store is unknown"
        );

        std::fs::write(
            dir.path().join("auth.json"),
            r#"{"tokens":{"id_token":"not-a-jwt"}}"#,
        )
        .unwrap();
        let corrupt = crate::cli_accounts::codex_identity(dir.path(), None);
        assert!(corrupt
            .reason
            .as_deref()
            .unwrap()
            .contains("not a decodable JWT"));
        assert_eq!(
            login_fact(&[corrupt], AgentKind::Codex),
            SignIn::Unknown,
            "a corrupt token is unknown"
        );
    }

    #[test]
    fn environment_credentials_name_the_first_documented_variable() {
        fn env(pairs: &'static [(&'static str, &'static str)]) -> impl Fn(&str) -> Option<String> {
            move |name: &str| {
                pairs
                    .iter()
                    .find(|(k, _)| *k == name)
                    .map(|(_, v)| (*v).to_string())
            }
        }
        assert_eq!(
            env_credential(AgentKind::Claude, env(&[("ANTHROPIC_API_KEY", "x")])),
            Some("ANTHROPIC_API_KEY")
        );
        assert_eq!(
            env_credential(AgentKind::Claude, env(&[("CLAUDE_CODE_USE_VERTEX", "1")])),
            Some("CLAUDE_CODE_USE_VERTEX")
        );
        assert_eq!(
            env_credential(AgentKind::Codex, env(&[("OPENAI_API_KEY", "sk-x")])),
            Some("OPENAI_API_KEY")
        );
        assert_eq!(
            env_credential(
                AgentKind::Claude,
                env(&[("CLAUDE_CODE_USE_BEDROCK", "false")])
            ),
            None,
            "a disabled switch is not a credential"
        );
        assert_eq!(
            env_credential(AgentKind::Opencode, env(&[("ANTHROPIC_API_KEY", "x")])),
            None,
            "another provider's variable is not this provider's credential"
        );
    }

    /// The restart warning judges the window the run will cover: an
    /// afternoon Run now inside active hours is not warned about the night.
    #[test]
    fn restart_window_follows_the_run() {
        let s = settings();
        let mut machine = healthy();
        machine.active_hours = Some((8, 17));
        let f = facts(machine);
        let hour = 3_600_000;
        let run = crate::night_shift::window::run_now(14 * hour, 15 * hour).unwrap();
        let afternoon = crate::night_shift::window::clock_window(14 * hour, &run, |_| 0);
        assert_eq!(
            (
                afternoon.start.hour,
                afternoon.wrap_up.hour,
                afternoon.wrap_up.minute
            ),
            (14, 14, 15)
        );
        let warned = |w: &NightWindow| evaluate(&s, &f, w).iter().any(|i| i.id == "restart_window");
        assert!(!warned(&afternoon), "14:00–15:00 is inside 08:00–17:00");
        assert!(warned(&s.window), "the nightly window reaches outside");
    }

    #[test]
    fn thresholds_name_limit_and_actual() {
        let s = settings();
        let ok = evaluate(&s, &facts(healthy()), &s.window);
        assert!(blocks(&ok).is_empty());
        let memory = ok.iter().find(|i| i.id == "memory").unwrap();
        assert!(
            memory
                .detail
                .ends_with("memory free; a run needs at least 6.0 GiB"),
            "the detail names the value and the floor once: {}",
            memory.detail
        );
        let items = evaluate(
            &s,
            &facts(MachineFacts {
                on_battery: Some(true),
                memory_free_mib: Some(4 * 1024),
                disk_free_mib: Some(10 * 1024),
                ..healthy()
            }),
            &s.window,
        );
        let b = blocks(&items);
        let get = |id: &str| {
            *b.iter()
                .find(|i| i.id == id)
                .unwrap_or_else(|| panic!("{id}"))
        };
        assert_eq!(get("on_battery").actual.as_deref(), Some("battery"));
        assert_eq!(get("memory").limit.as_deref(), Some("6144 MiB"));
        assert_eq!(get("memory").actual.as_deref(), Some("4096 MiB"));
        assert_eq!(get("disk").limit.as_deref(), Some("20480 MiB"));
        assert_eq!(get("disk").actual.as_deref(), Some("10240 MiB"));
        assert_eq!(b.len(), 3);
    }

    #[test]
    fn daemon_facts_block_by_name() {
        let mut f = facts(healthy());
        f.orchestration_enabled = false;
        f.providers[1].hooks_on = false;
        f.providers.remove(0);
        let mut s = settings();
        s.checks.clear();
        let items = evaluate(&s, &f, &s.window);
        let ids: Vec<&str> = blocks(&items).iter().map(|i| i.id.as_str()).collect();
        assert_eq!(
            ids,
            [
                "orchestration_off",
                "cli_missing:claude",
                "hooks_off:zcode",
                "checks_missing"
            ]
        );
    }

    #[test]
    fn app_competitors_need_rea() {
        let mut s = settings();
        s.focus.competitor_gaps = houston_protocol::NightFocusLevel::Normal;
        s.competitors = vec![houston_protocol::NightCompetitor::App {
            name: "Orca".into(),
            version: "1.4.238".into(),
            path: "/opt/orca/orca".into(),
        }];
        let mut f = facts(healthy());
        let items = evaluate(&s, &f, &s.window);
        let ids: Vec<&str> = blocks(&items).iter().map(|i| i.id.as_str()).collect();
        assert_eq!(ids, ["rea_missing:zcode"], "Claude has REA; ZCode does not");
        assert!(blocks(&items)[0].detail.contains("no MCP server named rea"));
        f.providers[1].rea = None;
        let items = evaluate(&s, &f, &s.window);
        assert!(blocks(&items)[0]
            .detail
            .contains("cannot read zcode's MCP configuration"));
        s.competitors = vec![houston_protocol::NightCompetitor::Repo { repo: "a/b".into() }];
        assert!(
            blocks(&evaluate(&s, &f, &s.window)).is_empty(),
            "a repository needs no REA"
        );
    }

    #[test]
    fn app_qa_needs_a_start_command() {
        let mut s = settings();
        s.app_qa.enabled = true;
        let items = evaluate(&s, &facts(healthy()), &s.window);
        let ids: Vec<&str> = blocks(&items).iter().map(|i| i.id.as_str()).collect();
        assert_eq!(ids, ["app_qa_start_missing"]);
        s.app_qa.start_command = "bun run dev".into();
        assert!(blocks(&evaluate(&s, &facts(healthy()), &s.window)).is_empty());
    }

    #[test]
    fn windows_restart_warnings() {
        let w = NightWindow {
            start: NightClock {
                hour: 23,
                minute: 30,
            },
            wrap_up: NightClock {
                hour: 6,
                minute: 45,
            },
            hard_stop: NightClock {
                hour: 7,
                minute: 30,
            },
            nights: vec![],
        };
        let hours = active_hours_from_registry(Some(10), Some(2));
        assert_eq!(hours, Some((10, 2)));
        let items = restart_items(Some(true), hours, &w);
        let ids: Vec<&str> = items.iter().map(|i| i.id.as_str()).collect();
        assert_eq!(ids, ["restart_pending", "restart_window"]);
        for i in &items {
            assert_eq!(i.status, PreflightStatus::Warn);
            assert!(i.detail.contains("10:00–02:00"), "{}", i.detail);
        }
        assert!(restart_items(Some(false), Some((8, 17)), &w)
            .iter()
            .any(|i| i.id == "restart_window"));
        let inside = NightWindow {
            start: NightClock {
                hour: 12,
                minute: 0,
            },
            hard_stop: NightClock {
                hour: 13,
                minute: 0,
            },
            wrap_up: NightClock {
                hour: 12,
                minute: 30,
            },
            nights: vec![],
        };
        assert!(restart_items(Some(false), hours, &inside).is_empty());
        assert_eq!(active_hours_from_registry(Some(30), Some(2)), None);
        assert_eq!(active_hours_from_registry(None, Some(2)), None);
    }
}
