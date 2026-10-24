//! Preflight: what blocks or warns before a run starts, from facts the daemon
//! and the machine report. Evaluation is pure; probes read the platform.
use houston_protocol::{
    AgentKind, NightShiftSettings, NightWindow, PreflightItem, PreflightStatus,
    NIGHT_SHIFT_DISK_FLOOR_MIB, NIGHT_SHIFT_MEMORY_FLOOR_MIB,
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

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProviderFacts {
    pub provider: AgentKind,
    pub hooks_on: bool,
    pub cli_present: bool,
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

    fn blocks(items: &[PreflightItem]) -> Vec<&PreflightItem> {
        items
            .iter()
            .filter(|i| i.status == PreflightStatus::Block)
            .collect()
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
