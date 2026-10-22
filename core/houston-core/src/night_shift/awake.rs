//! Keeps the machine awake while a run is in flight: a system-required power
//! request on Windows, a `systemd-inhibit` child on Linux reading a pipe only
//! the daemon holds. Dropping the hold, or any daemon exit, releases it.
use houston_protocol::{PreflightItem, PreflightStatus};

pub const LINUX_INHIBIT_TOOL: &str = "systemd-inhibit";

/// The child that holds the idle and sleep inhibitor until its stdin, the
/// daemon's end of a pipe, closes.
pub fn linux_argv() -> Vec<&'static str> {
    vec![
        LINUX_INHIBIT_TOOL,
        "--what=idle:sleep",
        "--who=Houston",
        "--why=Night shift run",
        "--mode=block",
        "cat",
    ]
}

/// Whether `tool` resolves on `path` (a `PATH`-style list).
pub fn tool_on_path(tool: &str, path: Option<&str>) -> bool {
    let Some(path) = path else { return false };
    std::env::split_paths(path).any(|dir| {
        let candidate = dir.join(tool);
        candidate.is_file()
    })
}

/// The preflight warning when the platform cannot keep the machine awake.
pub fn inhibitor_item(available: bool) -> Option<PreflightItem> {
    (!available).then(|| PreflightItem {
        id: "inhibit_unavailable".into(),
        status: PreflightStatus::Warn,
        label: "Keep awake".into(),
        detail: if cfg!(target_os = "linux") {
            format!(
                "{LINUX_INHIBIT_TOOL} is not on PATH, so the machine may sleep during the run; \
                 the run continues without it"
            )
        } else {
            "this platform has no keep-awake request; the run continues without it".into()
        },
        limit: None,
        actual: None,
    })
}

pub fn available(path: Option<&str>) -> bool {
    if cfg!(windows) {
        true
    } else if cfg!(target_os = "linux") {
        tool_on_path(LINUX_INHIBIT_TOOL, path)
    } else {
        false
    }
}

/// A held keep-awake; dropping it releases the request or stops the child.
pub struct Hold {
    #[cfg(windows)]
    handle: windows_sys::Win32::Foundation::HANDLE,
    #[cfg(not(windows))]
    child: Option<std::process::Child>,
}

// SAFETY: the power request handle is an opaque kernel handle the daemon
// owns; it is only cleared and closed in `drop`.
#[cfg(windows)]
unsafe impl Send for Hold {}

impl std::fmt::Debug for Hold {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Hold")
    }
}

#[cfg(windows)]
pub fn acquire(_path: Option<&str>) -> Result<Hold, String> {
    use windows_sys::Win32::System::Power::{
        PowerCreateRequest, PowerRequestSystemRequired, PowerSetRequest,
    };
    use windows_sys::Win32::System::Threading::{
        POWER_REQUEST_CONTEXT_SIMPLE_STRING, REASON_CONTEXT, REASON_CONTEXT_0,
    };
    let mut reason: Vec<u16> = "Houston Night shift run"
        .encode_utf16()
        .chain(Some(0))
        .collect();
    let context = REASON_CONTEXT {
        Version: 0,
        Flags: POWER_REQUEST_CONTEXT_SIMPLE_STRING,
        Reason: REASON_CONTEXT_0 {
            SimpleReasonString: reason.as_mut_ptr(),
        },
    };
    // SAFETY: `context` and its string outlive both calls; the returned handle
    // is owned by the `Hold` and closed in its drop.
    unsafe {
        let handle = PowerCreateRequest(&context);
        if handle.is_null() || handle == windows_sys::Win32::Foundation::INVALID_HANDLE_VALUE {
            return Err(format!(
                "PowerCreateRequest failed: {}",
                std::io::Error::last_os_error()
            ));
        }
        if PowerSetRequest(handle, PowerRequestSystemRequired) == 0 {
            let e = std::io::Error::last_os_error();
            windows_sys::Win32::Foundation::CloseHandle(handle);
            return Err(format!("PowerSetRequest failed: {e}"));
        }
        Ok(Hold { handle })
    }
}

#[cfg(not(windows))]
pub fn acquire(path: Option<&str>) -> Result<Hold, String> {
    if !cfg!(target_os = "linux") {
        return Err("this platform has no keep-awake request".into());
    }
    if !tool_on_path(LINUX_INHIBIT_TOOL, path) {
        return Err(format!("{LINUX_INHIBIT_TOOL} is not on PATH"));
    }
    let argv = linux_argv();
    let mut cmd = crate::spawn::command(argv[0]);
    // The write end stays in the `Child`; std opens it close-on-exec, so no
    // other child inherits it and the daemon's exit ends the inhibitor.
    cmd.args(&argv[1..])
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    if let Some(path) = path {
        cmd.env("PATH", path);
    }
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("starting {LINUX_INHIBIT_TOOL}: {e}"))?;
    // polkit refusing the inhibitor ends the child at once.
    std::thread::sleep(std::time::Duration::from_millis(150));
    if let Ok(Some(status)) = child.try_wait() {
        return Err(format!("{LINUX_INHIBIT_TOOL} exited at once ({status})"));
    }
    Ok(Hold { child: Some(child) })
}

impl Drop for Hold {
    fn drop(&mut self) {
        #[cfg(windows)]
        // SAFETY: the handle came from PowerCreateRequest and is released once.
        unsafe {
            use windows_sys::Win32::System::Power::{
                PowerClearRequest, PowerRequestSystemRequired,
            };
            PowerClearRequest(self.handle, PowerRequestSystemRequired);
            windows_sys::Win32::Foundation::CloseHandle(self.handle);
        }
        #[cfg(not(windows))]
        if let Some(mut child) = self.child.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn linux_argv_and_missing_tool() {
        assert_eq!(
            linux_argv(),
            [
                "systemd-inhibit",
                "--what=idle:sleep",
                "--who=Houston",
                "--why=Night shift run",
                "--mode=block",
                "cat"
            ]
        );
        let empty = tempfile::tempdir().unwrap();
        let path = empty.path().display().to_string();
        assert!(!tool_on_path(LINUX_INHIBIT_TOOL, Some(&path)));
        let item = inhibitor_item(false).expect("a missing tool warns");
        assert_eq!(item.id, "inhibit_unavailable");
        assert_eq!(item.status, PreflightStatus::Warn);
        assert!(inhibitor_item(true).is_none());
        std::fs::write(empty.path().join(LINUX_INHIBIT_TOOL), "#!/bin/sh\n").unwrap();
        assert!(tool_on_path(LINUX_INHIBIT_TOOL, Some(&path)));
        #[cfg(target_os = "linux")]
        assert!(acquire(Some(
            &tempfile::tempdir().unwrap().path().display().to_string()
        ))
        .is_err());
    }

    #[cfg(target_os = "linux")]
    const HOLDER_DIR_ENV: &str = "HOUSTON_TEST_AWAKE_HOLDER_DIR";

    /// Run by `inhibitor_ends_with_a_killed_daemon` in a child process: holds
    /// keep-awake through a stand-in `systemd-inhibit` until it is killed.
    #[cfg(target_os = "linux")]
    #[test]
    #[ignore = "a helper process for inhibitor_ends_with_a_killed_daemon"]
    fn hold_until_killed() {
        let Ok(dir) = std::env::var(HOLDER_DIR_ENV) else {
            return;
        };
        let path = format!("{dir}:{}", std::env::var("PATH").unwrap_or_default());
        let _hold = acquire(Some(&path)).expect("the stand-in inhibitor starts");
        std::fs::write(std::path::Path::new(&dir).join("held"), "").unwrap();
        std::thread::sleep(std::time::Duration::from_secs(60));
    }

    /// A daemon killed outright (SIGKILL, no drop) still ends its inhibitor.
    #[cfg(target_os = "linux")]
    #[test]
    fn inhibitor_ends_with_a_killed_daemon() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let tool = dir.path().join(LINUX_INHIBIT_TOOL);
        std::fs::write(
            &tool,
            format!(
                "#!/bin/sh\nwhile [ \"${{1#--}}\" != \"$1\" ]; do shift; done\necho $$ > '{}'\nexec \"$@\"\n",
                dir.path().join("pid").display()
            ),
        )
        .unwrap();
        std::fs::set_permissions(&tool, std::fs::Permissions::from_mode(0o755)).unwrap();
        let mut holder = crate::spawn::command(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "night_shift::awake::tests::hold_until_killed",
                "--ignored",
            ])
            .env(HOLDER_DIR_ENV, dir.path())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .unwrap();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(20);
        while !dir.path().join("held").exists() {
            assert!(
                std::time::Instant::now() < deadline,
                "the holder never held"
            );
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        let pid: u32 = std::fs::read_to_string(dir.path().join("pid"))
            .unwrap()
            .trim()
            .parse()
            .unwrap();
        assert!(crate::pid::process_is_alive(pid));
        holder.kill().unwrap();
        holder.wait().unwrap();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        while crate::pid::process_is_alive(pid) {
            assert!(
                std::time::Instant::now() < deadline,
                "inhibitor {pid} outlived the killed daemon"
            );
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
    }
}
