//! Whether a channel's v1 daemon still runs: its `daemon.json`, read and never written,
//! names a live process whose image is `houston-core`. Nothing here signals a process.

use std::path::{Path, PathBuf};

/// The PID and the `daemon.json` that names it, when that process is v1's daemon.
pub fn running(channel_dir: &Path) -> Option<(u32, PathBuf)> {
    let path = channel_dir.join("daemon.json");
    let text = std::fs::read_to_string(&path).ok()?;
    let record: serde_json::Value = serde_json::from_str(&text).ok()?;
    let pid = u32::try_from(record.get("pid")?.as_u64()?).ok()?;
    is_v1_daemon(pid).then_some((pid, path))
}

/// An image that cannot be read (another user's process) counts as v1's daemon: standing
/// down for a run is harmless, removing entries a live daemon depends on is not.
fn is_v1_daemon(pid: u32) -> bool {
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

#[cfg(not(any(target_os = "linux", windows)))]
fn image_name(_pid: u32) -> Option<String> {
    None
}
