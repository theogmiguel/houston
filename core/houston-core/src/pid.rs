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
    Hup,
    Int,
    Kill,
}

impl Signal {
    #[cfg(unix)]
    fn as_c_int(self) -> libc::c_int {
        match self {
            Signal::Check => 0,
            Signal::Term => libc::SIGTERM,
            Signal::Hup => libc::SIGHUP,
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

#[cfg(target_os = "linux")]
pub fn signal_owned_process_group(
    pid: u32,
    expected_creation: Option<u64>,
    sig: Signal,
) -> Result<SignalOutcome, SignalError> {
    let raw = checked_pid(pid).map_err(SignalError::InvalidPid)?;
    if pid == 1 {
        return Err(SignalError::Os(std::io::Error::other(
            "process group 1 is not an owned child group; expected group ID >= 2",
        )));
    }
    let Some(expected) = expected_creation else {
        return Ok(SignalOutcome::IdentityMismatch);
    };
    match process_creation_token(pid) {
        None => return Ok(SignalOutcome::NoSuchProcess),
        Some(actual) if actual != expected => return Ok(SignalOutcome::IdentityMismatch),
        Some(_) => {}
    }
    // An unreaped child anchors its group identity, even after it exits. Never
    // use this helper for a group outside the launcher's own terminal session.
    if unsafe { libc::getpgid(raw) } != raw
        || unsafe { libc::getsid(raw) } != unsafe { libc::getsid(0) }
    {
        return Ok(SignalOutcome::IdentityMismatch);
    }
    signal_process_group_checked(pid, sig)?;
    Ok(SignalOutcome::Delivered)
}

#[cfg(unix)]
fn signal_process_group_checked(pid: u32, sig: Signal) -> Result<(), SignalError> {
    if pid == 1 {
        return Err(SignalError::Os(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "process group 1 would broadcast to every signalable process; expected group ID >= 2",
        )));
    }
    let group = checked_process_group(pid).map_err(SignalError::InvalidPid)?;
    // SAFETY: the group is an explicitly validated positive process-group ID, negated once.
    if unsafe { libc::kill(group, sig.as_c_int()) } == 0 {
        return Ok(());
    }
    let error = std::io::Error::last_os_error();
    if error.raw_os_error() == Some(libc::ESRCH) {
        return Ok(());
    }
    Err(SignalError::Os(error))
}

#[cfg(unix)]
pub fn terminate_pty_session(
    pid: u32,
    master_fd: Option<std::os::fd::RawFd>,
    expected_creation: Option<u64>,
) -> Result<(), SignalError> {
    if pid == 1 {
        return Err(SignalError::Os(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "PTY root pid 1 cannot be an owned terminal session; expected pid >= 2",
        )));
    }
    let root = checked_pid(pid).map_err(SignalError::InvalidPid)?;
    if expected_creation.is_some_and(|expected| {
        process_creation_token(pid).is_some_and(|actual| actual != expected)
    }) {
        return Err(SignalError::Os(std::io::Error::other(format!(
            "PTY root pid {pid} was reused; refusing to terminate another process"
        ))));
    }
    // PTY children call setsid before exec; never signal a group belonging to the daemon.
    let session = unsafe { libc::getsid(root) };
    if session < 0 {
        let error = std::io::Error::last_os_error();
        if error.raw_os_error() == Some(libc::ESRCH) {
            return Ok(());
        }
        return Err(SignalError::Os(error));
    }
    if session != root {
        return Err(SignalError::Os(std::io::Error::other(format!(
            "PTY root pid {pid} belongs to session {session}, expected session {pid}"
        ))));
    }
    if let Some(fd) = master_fd {
        // Interactive shells put their foreground command in a separate process group.
        let foreground = unsafe { libc::tcgetpgrp(fd) };
        if foreground > 0 && foreground != root {
            let foreground_session = unsafe { libc::getsid(foreground) };
            if foreground_session == root {
                signal_process_group_checked(foreground as u32, Signal::Kill)?;
            }
        }
    }
    signal_process_group_checked(pid, Signal::Kill)
}

#[cfg(windows)]
mod win {
    use std::io;

    use windows_sys::Win32::Foundation::FILETIME;
    pub(super) use windows_sys::Win32::Foundation::HANDLE;

    pub(super) const QUERY: u32 =
        windows_sys::Win32::System::Threading::PROCESS_QUERY_LIMITED_INFORMATION;
    const CHECK: u32 = QUERY | windows_sys::Win32::System::Threading::PROCESS_SYNCHRONIZE;
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

    pub(super) fn already_terminated(pid: u32) -> Result<bool, io::Error> {
        use windows_sys::Win32::Foundation::{WAIT_FAILED, WAIT_OBJECT_0, WAIT_TIMEOUT};
        let handle = open(pid, CHECK)?;
        // SAFETY: this handle owns SYNCHRONIZE; a zero timeout never blocks.
        // A signaled process is exited, including one whose exit code is 259.
        let state =
            unsafe { windows_sys::Win32::System::Threading::WaitForSingleObject(handle, 0) };
        let result = match state {
            WAIT_OBJECT_0 => Ok(true),
            WAIT_TIMEOUT => Ok(false),
            WAIT_FAILED => Err(io::Error::last_os_error()),
            other => Err(io::Error::other(format!(
                "process wait returned {other}; expected WAIT_OBJECT_0 or WAIT_TIMEOUT"
            ))),
        };
        close(handle);
        result
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
        Signal::Check => match win::already_terminated(pid) {
            Ok(true) => Ok(SignalOutcome::NoSuchProcess),
            Ok(false) => Ok(SignalOutcome::Delivered),
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
                Ok(SignalOutcome::NoSuchProcess)
            }
            Err(err) => Err(SignalError::Os(err)),
        },
        Signal::Term | Signal::Hup | Signal::Int | Signal::Kill => {
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
            if win::already_terminated(pid).unwrap_or(false) {
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
    #[cfg(target_os = "linux")]
    fn owned_group_signals_require_a_child_group_with_matching_identity() {
        for (pid, _) in BROADCAST_VALUES {
            assert!(signal_owned_process_group(pid, Some(1), Signal::Check).is_err());
        }
        assert!(signal_owned_process_group(1, Some(1), Signal::Check).is_err());
        let current = std::process::id();
        assert_eq!(
            signal_owned_process_group(current, None, Signal::Check).unwrap(),
            SignalOutcome::IdentityMismatch
        );
        assert_eq!(
            signal_owned_process_group(current, Some(0), Signal::Check).unwrap(),
            SignalOutcome::IdentityMismatch
        );
    }

    #[test]
    #[cfg(unix)]
    fn terminal_termination_refuses_broadcast_group_one() {
        let error = signal_process_group_checked(1, Signal::Check).unwrap_err();
        assert!(error.to_string().contains("broadcast"));
        assert!(terminate_pty_session(1, None, None).is_err());
        for (pid, _) in BROADCAST_VALUES {
            assert!(terminate_pty_session(pid, None, None).is_err());
        }
    }

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
        crate::spawn::command("cmd")
            .args(["/d", "/C", "exit 0"])
            .spawn()
            .expect("spawn cmd")
    }

    #[cfg(windows)]
    #[test]
    fn exited_process_is_dead_while_its_handle_is_still_open() {
        assert!(process_is_alive(std::process::id()));
        for exit_code in [0, 259] {
            let mut child = crate::spawn::command("cmd")
                .args(["/d", "/c", &format!("exit {exit_code}")])
                .spawn()
                .unwrap();
            let pid = child.id();
            let creation = process_creation_token(pid).unwrap();
            assert_eq!(child.wait().unwrap().code(), Some(exit_code));
            // Child retains the kernel process object even after wait completes.
            assert_eq!(process_creation_token(pid), Some(creation));
            assert!(
                !process_is_alive(pid),
                "exited pid {pid} with code {exit_code} must not be reported alive"
            );
            assert_eq!(
                signal_process_checked_identity(pid, Signal::Check, Some(creation)).unwrap(),
                SignalOutcome::NoSuchProcess
            );
            assert_eq!(
                signal_process_checked_identity(pid, Signal::Kill, Some(creation)).unwrap(),
                SignalOutcome::NoSuchProcess
            );
            drop(child);
        }
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
