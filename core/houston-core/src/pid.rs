//! The only module allowed to call raw `libc::kill` (`OpenProcess`/`TerminateProcess` on
//! Windows) -- `scripts/check-kill-guard.sh` enforces it. A pid's non-positive values are
//! broadcast commands to `kill(2)` (0 = caller's process group, -1 = everything signallable).

use std::fmt;

#[cfg(unix)]
pub type RawPid = libc::pid_t;
#[cfg(windows)]
pub type RawPid = u32;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Signal {
    Check,
    Term,
    Int,
    Kill,
}

impl Signal {
    #[cfg(unix)]
    fn as_c_int(self) -> libc::c_int {
        match self {
            Signal::Check => 0,
            Signal::Term => libc::SIGTERM,
            Signal::Int => libc::SIGINT,
            Signal::Kill => libc::SIGKILL,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PidError {
    pid: u32,
}

impl PidError {
    fn new(pid: u32) -> Self {
        PidError { pid }
    }
}

impl fmt::Display for PidError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "pid {} is not a usable process id (expected 1..={}): refusing to pass it to \
             kill(2), where 0 means \"every process in this process group\" and negative values \
             mean \"every process we may signal\"",
            self.pid,
            i32::MAX
        )
    }
}

impl std::error::Error for PidError {}

// Refuses 0 and anything past pid_t's positive range before it reaches kill(2), where 0
// means "this process group" and a negative pid means "every process (group) the caller
// may signal" -- not "obviously invalid input".
pub fn checked_pid(pid: u32) -> Result<RawPid, PidError> {
    if pid == 0 || pid > i32::MAX as u32 {
        return Err(PidError::new(pid));
    }
    Ok(pid as RawPid)
}

#[cfg(unix)]
pub fn checked_process_group(pid: u32) -> Result<libc::pid_t, PidError> {
    checked_pid(pid).map(|pid_t| -pid_t)
}

#[derive(Debug, PartialEq, Eq)]
pub enum SignalOutcome {
    Delivered,
    NoSuchProcess,
    IdentityMismatch,
}

#[derive(Debug)]
pub enum SignalError {
    InvalidPid(PidError),
    Os(std::io::Error),
}

impl fmt::Display for SignalError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            SignalError::InvalidPid(err) => write!(f, "{err}"),
            SignalError::Os(err) => write!(f, "{err}"),
        }
    }
}

impl std::error::Error for SignalError {}

#[cfg(unix)]
pub fn signal_process_checked(pid: u32, sig: Signal) -> Result<SignalOutcome, SignalError> {
    let pid_t = checked_pid(pid).map_err(SignalError::InvalidPid)?;
    // SAFETY: `pid_t` passed checked_pid above, so it is never 0 or negative by accident.
    let ret = unsafe { libc::kill(pid_t, sig.as_c_int()) };
    if ret == 0 {
        return Ok(SignalOutcome::Delivered);
    }
    let err = std::io::Error::last_os_error();
    if err.raw_os_error() == Some(libc::ESRCH) {
        return Ok(SignalOutcome::NoSuchProcess);
    }
    Err(SignalError::Os(err))
}

#[cfg(unix)]
pub fn signal_process_checked_identity(
    pid: u32,
    sig: Signal,
    expected_creation: Option<u64>,
) -> Result<SignalOutcome, SignalError> {
    // Identity is compared BEFORE delivery: a mismatch means the pid was recycled and
    // something else lives there now, so nothing is signalled.
    checked_pid(pid).map_err(SignalError::InvalidPid)?;
    if let Some(expected) = expected_creation {
        match process_creation_token(pid) {
            None => {}
            Some(actual) if actual == expected => {}
            Some(_) => return Ok(SignalOutcome::IdentityMismatch),
        }
    }
    signal_process_checked(pid, sig)
}

#[cfg(unix)]
pub fn signal_process(pid: u32, sig: Signal) -> Result<(), PidError> {
    let pid_t = checked_pid(pid)?;
    // SAFETY: `pid_t` passed checked_pid above.
    unsafe {
        libc::kill(pid_t, sig.as_c_int());
    }
    Ok(())
}

#[cfg(unix)]
pub fn signal_process_group(pid: u32, sig: Signal) -> Result<(), PidError> {
    let group = checked_process_group(pid)?;
    // SAFETY: `group` passed checked_process_group above.
    unsafe {
        libc::kill(group, sig.as_c_int());
    }
    Ok(())
}

#[cfg(windows)]
mod win {
    use std::io;

    use windows_sys::Win32::Foundation::FILETIME;
    pub(super) use windows_sys::Win32::Foundation::HANDLE;

    pub(super) const QUERY: u32 =
        windows_sys::Win32::System::Threading::PROCESS_QUERY_LIMITED_INFORMATION;
    pub(super) const TERMINATE: u32 = windows_sys::Win32::System::Threading::PROCESS_TERMINATE;

    const ERR_NO_SUCH_PROCESS: i32 = windows_sys::Win32::Foundation::ERROR_INVALID_PARAMETER as i32;
    const ERR_ACCESS_DENIED: i32 = windows_sys::Win32::Foundation::ERROR_ACCESS_DENIED as i32;

    pub(super) fn open(pid: u32, access: u32) -> Result<HANDLE, io::Error> {
        // SAFETY: no side effects beyond acquiring a handle; the pid has already been
        // through checked_pid.
        let handle = unsafe { windows_sys::Win32::System::Threading::OpenProcess(access, 0, pid) };
        if !handle.is_null() {
            return Ok(handle);
        }
        let err = io::Error::last_os_error();
        if err.raw_os_error() == Some(ERR_NO_SUCH_PROCESS) {
            return Err(io::Error::from(io::ErrorKind::NotFound));
        }
        Err(err)
    }

    pub(super) fn close(handle: HANDLE) {
        // SAFETY: closing a handle this module opened.
        unsafe { windows_sys::Win32::Foundation::CloseHandle(handle) };
    }

    pub(super) fn is_access_denied(err: &io::Error) -> bool {
        err.raw_os_error() == Some(ERR_ACCESS_DENIED)
    }

    pub(super) fn terminate(handle: HANDLE) -> Result<(), io::Error> {
        // SAFETY: terminating a process Houston owns a session for is the whole purpose
        // of this module; exit code 1 distinguishes our kill from a clean exit.
        let ok = unsafe { windows_sys::Win32::System::Threading::TerminateProcess(handle, 1) };
        if ok != 0 {
            return Ok(());
        }
        Err(io::Error::last_os_error())
    }

    const EXIT_STILL_ACTIVE: u32 = 259;

    pub(super) fn creation_token(handle: HANDLE) -> Option<u64> {
        let zero = FILETIME {
            dwLowDateTime: 0,
            dwHighDateTime: 0,
        };
        let mut creation = zero;
        let mut exit = zero;
        let mut kernel = zero;
        let mut user = zero;
        // SAFETY: `handle` is a valid, still-open process handle from the caller; the
        // four out-params are valid `FILETIME` locals.
        let ok = unsafe {
            windows_sys::Win32::System::Threading::GetProcessTimes(
                handle,
                &mut creation,
                &mut exit,
                &mut kernel,
                &mut user,
            )
        };
        if ok == 0 {
            return None;
        }
        Some(((creation.dwHighDateTime as u64) << 32) | creation.dwLowDateTime as u64)
    }

    pub(super) fn already_terminated(pid: u32) -> bool {
        match open(pid, QUERY) {
            Ok(handle) => {
                let mut code: u32 = 0;
                // SAFETY: `handle` just came from a successful `open` above.
                let ok = unsafe {
                    windows_sys::Win32::System::Threading::GetExitCodeProcess(handle, &mut code)
                };
                close(handle);
                ok != 0 && code != EXIT_STILL_ACTIVE
            }
            Err(_) => false,
        }
    }

    pub(super) fn image_basename(handle: HANDLE) -> Option<String> {
        let mut buf = [0u16; 1024];
        let mut size = buf.len() as u32;
        // SAFETY: `handle` is caller-supplied and valid; `buf` is sized and passed with
        // its own length.
        let ok = unsafe {
            windows_sys::Win32::System::Threading::QueryFullProcessImageNameW(
                handle,
                0,
                buf.as_mut_ptr(),
                &mut size,
            )
        };
        if ok == 0 || size == 0 {
            return None;
        }
        let full = String::from_utf16_lossy(&buf[..size as usize]);
        std::path::Path::new(&full)
            .file_name()
            .map(|s| s.to_string_lossy().into_owned())
    }
}

#[cfg(windows)]
pub fn signal_process_checked(pid: u32, sig: Signal) -> Result<SignalOutcome, SignalError> {
    signal_process_checked_identity(pid, sig, None)
}

#[cfg(windows)]
pub fn signal_process_checked_identity(
    pid: u32,
    sig: Signal,
    expected_creation: Option<u64>,
) -> Result<SignalOutcome, SignalError> {
    checked_pid(pid).map_err(SignalError::InvalidPid)?;
    if let Some(expected) = expected_creation {
        match process_creation_token(pid) {
            None => {}
            Some(actual) if actual == expected => {}
            Some(_) => return Ok(SignalOutcome::IdentityMismatch),
        }
    }
    match sig {
        Signal::Check => deliver_or_classify(pid, win::QUERY, |_, _| Ok(())),
        Signal::Term | Signal::Int | Signal::Kill => {
            deliver_or_classify(pid, win::TERMINATE, |_, handle| win::terminate(handle))
        }
    }
}

#[cfg(windows)]
fn deliver_or_classify(
    pid: u32,
    access: u32,
    act: impl FnOnce(u32, win::HANDLE) -> Result<(), std::io::Error>,
) -> Result<SignalOutcome, SignalError> {
    let handle = match win::open(pid, access) {
        Ok(handle) => handle,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            return Ok(SignalOutcome::NoSuchProcess);
        }
        Err(err) => return Err(SignalError::Os(err)),
    };
    let result = act(pid, handle);
    win::close(handle);
    match result {
        Ok(()) => Ok(SignalOutcome::Delivered),
        Err(err) if win::is_access_denied(&err) => {
            if win::already_terminated(pid) {
                Ok(SignalOutcome::NoSuchProcess)
            } else {
                Err(SignalError::Os(err))
            }
        }
        Err(_) => Ok(SignalOutcome::NoSuchProcess),
    }
}

#[cfg(windows)]
pub fn signal_process(pid: u32, sig: Signal) -> Result<(), PidError> {
    checked_pid(pid)?;
    if matches!(sig, Signal::Check) {
        return Ok(());
    }
    if let Ok(handle) = win::open(pid, win::TERMINATE) {
        let _ = win::terminate(handle);
        win::close(handle);
    }
    Ok(())
}

#[cfg(windows)]
pub fn process_creation_token(pid: u32) -> Option<u64> {
    let handle = win::open(pid, win::QUERY).ok()?;
    let token = win::creation_token(handle);
    win::close(handle);
    token
}

#[cfg(unix)]
pub fn process_creation_token(pid: u32) -> Option<u64> {
    let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    let cut = stat.rfind(')')? + 2;
    stat[cut..].split_whitespace().nth(19)?.parse::<u64>().ok()
}

#[cfg(windows)]
pub fn self_creation_token() -> Option<u64> {
    // SAFETY: GetCurrentProcess returns a pseudo-handle that needs no close;
    // GetProcessTimes on it is a pure read.
    let handle = unsafe { windows_sys::Win32::System::Threading::GetCurrentProcess() };
    win::creation_token(handle)
}

#[cfg(unix)]
pub fn self_creation_token() -> Option<u64> {
    process_creation_token(std::process::id())
}

pub fn process_is_alive(pid: u32) -> bool {
    match signal_process_checked(pid, Signal::Check) {
        Ok(SignalOutcome::Delivered) => true,
        Ok(SignalOutcome::NoSuchProcess | SignalOutcome::IdentityMismatch) => false,
        Err(SignalError::InvalidPid(_)) => false,
        Err(SignalError::Os(_)) => true,
    }
}

#[cfg(unix)]
pub fn process_comm(pid: u32) -> Option<String> {
    if !process_is_alive(pid) {
        return None;
    }
    std::fs::read_to_string(format!("/proc/{pid}/comm"))
        .ok()
        .map(|s| s.trim().to_string())
}

#[cfg(windows)]
pub fn process_comm(pid: u32) -> Option<String> {
    let handle = win::open(pid, win::QUERY).ok()?;
    let name = win::image_basename(handle);
    win::close(handle);
    name
}

#[cfg(test)]
mod tests {
    #![allow(clippy::disallowed_methods)]
    use super::*;

    const BROADCAST_VALUES: [(u32, &str); 3] = [
        (
            u32::MAX,
            "u32::MAX, which casts to -1 = every signallable process",
        ),
        (0, "0 = this process group"),
        (i32::MAX as u32 + 1, "one past pid_t's positive range"),
    ];

    #[test]
    fn checked_pid_refuses_broadcast_values() {
        for (pid, what) in BROADCAST_VALUES {
            let err = checked_pid(pid).expect_err(&format!("must refuse {what}"));
            assert!(
                err.to_string().contains(&pid.to_string()),
                "refusal must name the offending pid {pid} ({what}), got: {err}"
            );
        }
    }

    #[cfg(unix)]
    #[test]
    fn checked_process_group_refuses_broadcast_values() {
        for (pid, what) in BROADCAST_VALUES {
            let err = checked_process_group(pid).expect_err(&format!("must refuse {what}"));
            assert!(
                err.to_string().contains(&pid.to_string()),
                "refusal must name the offending pid {pid} ({what}), got: {err}"
            );
        }
    }

    #[test]
    fn checked_pid_accepts_ordinary_pids() {
        assert_eq!(checked_pid(1), Ok(1));
        assert_eq!(
            checked_pid(std::process::id()).map(|p| p as u64),
            Ok(u64::from(std::process::id()))
        );
        assert_eq!(
            checked_pid(i32::MAX as u32).map(|p| p as u64),
            Ok(i32::MAX as u64)
        );
    }

    #[cfg(unix)]
    #[test]
    fn checked_process_group_returns_the_negation() {
        assert_eq!(checked_process_group(1), Ok(-1));
        assert_eq!(checked_process_group(i32::MAX as u32), Ok(-(i32::MAX)));
    }

    #[test]
    fn process_is_alive_and_process_comm_report_unusable_pids_as_not_alive() {
        for (pid, _) in BROADCAST_VALUES {
            assert!(
                !process_is_alive(pid),
                "pid {pid} must not be reported alive"
            );
            assert_eq!(process_comm(pid), None, "pid {pid} must not reach the OS");
        }
    }

    #[test]
    fn signal_process_checked_reports_no_such_process_for_a_reaped_pid() {
        for _ in 0..64 {
            let mut child = spawn_exit_child();
            let pid = child.id();
            child.wait().expect("reap child");
            drop(child);

            if matches!(
                signal_process_checked(pid, Signal::Check),
                Ok(SignalOutcome::NoSuchProcess)
            ) {
                assert!(!process_is_alive(pid));
                return;
            }
        }
        if cfg!(windows) && std::env::var_os("CI").is_some() {
            eprintln!("SKIPPED on Windows CI: all 64 reaped pids were recycled before the probe");
            return;
        }
        panic!("no reaped pid stayed unrecycled long enough to probe in 64 attempts");
    }

    #[cfg(unix)]
    fn spawn_exit_child() -> std::process::Child {
        std::process::Command::new("true")
            .spawn()
            .expect("spawn `true`")
    }

    #[cfg(not(unix))]
    fn spawn_exit_child() -> std::process::Child {
        std::process::Command::new("cmd")
            .args(["/C", "exit 0"])
            .spawn()
            .expect("spawn cmd")
    }
}

#[cfg(windows)]
#[test]
#[allow(clippy::disallowed_methods)]
fn creation_token_identity_mismatch_is_refused() {
    let mut child = std::process::Command::new("cmd")
        .args(["/C", "ping", "-n", "30", "127.0.0.1"])
        .spawn()
        .expect("spawn long-lived fixture");
    let pid = child.id();
    let token = process_creation_token(pid).expect("live child has a creation token");
    let wrong = signal_process_checked_identity(pid, Signal::Check, Some(token + 1)).unwrap();
    assert_eq!(
        wrong,
        SignalOutcome::IdentityMismatch,
        "wrong token must be refused"
    );
    let right = signal_process_checked_identity(pid, Signal::Check, Some(token)).unwrap();
    assert_eq!(right, SignalOutcome::Delivered);
    let none = signal_process_checked_identity(pid, Signal::Check, None).unwrap();
    assert_eq!(none, SignalOutcome::Delivered);
    let _ = signal_process(pid, Signal::Kill);
    let _ = child.wait();
}
