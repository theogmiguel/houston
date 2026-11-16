//! Whether a channel's v1 daemon still runs: its `daemon.json`, read and never written,
//! names a live process whose image is `houston-core`. `stop` signals only that verified pid,
//! and only after the caller's units did not stop it.

use crate::sys::pid::{self, Signal, SignalOutcome};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

/// `systemctl stop` waits for the unit, so this only needs to outlast a process that is
/// already on its way out. A daemon that ignores SIGTERM is reported, never SIGKILLed.
const STOP_TIMEOUT: Duration = Duration::from_secs(5);
const STOP_POLL: Duration = Duration::from_millis(50);

/// The PID and the `daemon.json` that names it, when that process is v1's daemon.
pub fn running(channel_dir: &Path) -> Option<(u32, PathBuf)> {
    let path = channel_dir.join("daemon.json");
    let text = std::fs::read_to_string(&path).ok()?;
    let record: serde_json::Value = serde_json::from_str(&text).ok()?;
    let pid = u32::try_from(record.get("pid")?.as_u64()?).ok()?;
    is_v1_daemon(pid).then_some((pid, path))
}

/// Stops the daemon named by `daemon.json` when no unit answered. The record and image are
/// verified as in `running`, and only SIGTERM is sent; v1's supervisor exits once its daemon
/// is gone, so it is never signalled directly.
pub fn stop(channel_dir: &Path) -> Result<Option<String>, String> {
    let Some((pid, record)) = running(channel_dir) else {
        return Ok(None);
    };
    match pid::signal_process_checked(pid, Signal::Term) {
        Ok(SignalOutcome::Delivered | SignalOutcome::NoSuchProcess) => {}
        Err(error) => {
            return Err(format!(
                "could not stop the Houston 1 daemon (pid {pid}, named by {}): {error}",
                record.display()
            ));
        }
    }
    let deadline = Instant::now() + STOP_TIMEOUT;
    while process_alive(pid) {
        if Instant::now() >= deadline {
            return Err(format!(
                "the Houston 1 daemon (pid {pid}, named by {}) is still running {:?} after \
                 SIGTERM; quit Houston 1 or stop its unit manually, then restart Houston",
                record.display(),
                STOP_TIMEOUT
            ));
        }
        std::thread::sleep(STOP_POLL);
    }
    Ok(Some(format!(
        "stopped the Houston 1 daemon (pid {pid}, named by {}); its supervisor exits when the \
         daemon it supervises is gone",
        record.display()
    )))
}

fn process_alive(pid: u32) -> bool {
    pid::process_is_alive(pid) && is_v1_daemon(pid)
}

/// An image that cannot be read (another user's process) counts as v1's daemon: standing
/// down for a run is harmless, removing entries a live daemon depends on is not.
fn is_v1_daemon(pid: u32) -> bool {
    is_v1_daemon_by(pid, image_name)
}

fn is_v1_daemon_by(pid: u32, image_name: impl Fn(u32) -> Option<String>) -> bool {
    pid != 0
        && pid != std::process::id()
        && crate::sys::pid::process_is_alive(pid)
        && image_name(pid).is_none_or(|name| name.starts_with("houston-core"))
}

#[cfg(target_os = "linux")]
fn image_name(pid: u32) -> Option<String> {
    let exe = std::fs::read_link(format!("/proc/{pid}/exe"))
        .ok()
        .and_then(|p| p.file_name().map(|n| n.to_string_lossy().into_owned()));
    // `comm` is world-readable but cut at 15 bytes, which still holds `houston-core`.
    exe.or_else(|| {
        std::fs::read_to_string(format!("/proc/{pid}/comm"))
            .ok()
            .map(|c| c.trim().to_string())
    })
}

#[cfg(windows)]
fn image_name(pid: u32) -> Option<String> {
    let path = crate::sys::pid::process_image_path(pid)?;
    Path::new(&path)
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
}

#[cfg(target_os = "macos")]
fn image_name(pid: u32) -> Option<String> {
    let pid = crate::sys::pid::checked_pid(pid).ok()?;
    let mut buffer = vec![0u8; libc::PROC_PIDPATHINFO_MAXSIZE as usize];
    // SAFETY: the buffer is writable for exactly the length passed.
    let length =
        unsafe { libc::proc_pidpath(pid, buffer.as_mut_ptr().cast(), buffer.len() as u32) };
    if length <= 0 {
        return None;
    }
    let path = std::str::from_utf8(&buffer[..length as usize]).ok()?;
    Path::new(path)
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
}

#[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
fn image_name(_pid: u32) -> Option<String> {
    None
}

#[test]
fn unreadable_image_counts_as_v1_daemon() {
    let scratch = tempfile::tempdir().expect("scratch dir");
    let live = super::fixtures::FakeDaemon::spawn(scratch.path(), "other-program");
    let pid = live.pid();
    assert!(
        is_v1_daemon_by(pid, |_| None),
        "an unreadable image stands down"
    );
    assert!(is_v1_daemon_by(pid, |_| Some("houston-core".into())));
    assert!(!is_v1_daemon_by(pid, |_| Some("other-program".into())));
    let dead = super::fixtures::exited_pid();
    assert!(
        !is_v1_daemon_by(dead, |_| None),
        "a dead PID never stands down"
    );
}
