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
    // Only Linux child-group cleanup sends it; other targets just match on it.
    #[cfg_attr(not(target_os = "linux"), allow(dead_code))]
    Kill,
}

impl Signal {
    #[cfg(unix)]
    fn as_c_int(self) -> libc::c_int {
        match self {
            Signal::Check => 0,
            Signal::Term => libc::SIGTERM,
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

/// The executable path behind a pid, used to label a captured window. It only opens
/// the process for `PROCESS_QUERY_LIMITED_INFORMATION`, never to signal it.
#[cfg(windows)]
pub fn process_image_path(pid: u32) -> Option<String> {
    let pid = checked_pid(pid).ok()?;
    let handle = win::open(pid, win::QUERY).ok()?;
    let mut buffer = vec![0u16; 32_768];
    let mut length = buffer.len() as u32;
    // SAFETY: the handle comes from this module's open(), and the buffer length is
    // passed in the units QueryFullProcessImageNameW expects (UTF-16 code units).
    let found = unsafe {
        windows_sys::Win32::System::Threading::QueryFullProcessImageNameW(
            handle,
            0,
            buffer.as_mut_ptr(),
            &mut length,
        )
    };
    win::close(handle);
    (found != 0).then(|| String::from_utf16_lossy(&buffer[..length as usize]))
}

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

/// Observe an owned child without reaping it, retaining its process-group identity.
#[cfg(target_os = "linux")]
pub(crate) fn unreaped_child_exited(child: &std::process::Child) -> std::io::Result<bool> {
    let raw = checked_pid(child.id()).map_err(std::io::Error::other)?;
    // SAFETY: info is initialized and waitid writes only this out-parameter.
    let mut info: libc::siginfo_t = unsafe { std::mem::zeroed() };
    if unsafe {
        libc::waitid(
            libc::P_PID,
            raw as libc::id_t,
            &mut info,
            libc::WEXITED | libc::WNOHANG | libc::WNOWAIT,
        )
    } < 0
    {
        return Err(std::io::Error::last_os_error());
    }
    // SAFETY: waitid populated siginfo's child-status variant (or left si_pid zero).
    Ok(unsafe { info.si_pid() } == raw)
}

/// Caller must retain this direct child without wait/try_wait until after delivery.
#[cfg(target_os = "linux")]
pub(crate) fn signal_unreaped_child_group(
    child: &std::process::Child,
    sig: Signal,
) -> Result<(), SignalError> {
    let raw = checked_pid(child.id()).map_err(SignalError::InvalidPid)?;
    // The unreaped direct child anchors identity; verify our session and group.
    if unsafe { libc::getpgid(raw) } != raw
        || unsafe { libc::getsid(raw) } != unsafe { libc::getsid(0) }
    {
        return Err(SignalError::Os(std::io::Error::other(format!(
            "child pid {} is not an owned process group in the caller session",
            child.id()
        ))));
    }
    signal_process_group_checked(child.id(), sig)
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

#[cfg(windows)]
mod win {
    use std::io;

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
}

#[cfg(windows)]
pub fn signal_process_checked(pid: u32, sig: Signal) -> Result<SignalOutcome, SignalError> {
    checked_pid(pid).map_err(SignalError::InvalidPid)?;
    match sig {
        Signal::Check => match win::already_terminated(pid) {
            Ok(true) => Ok(SignalOutcome::NoSuchProcess),
            Ok(false) => Ok(SignalOutcome::Delivered),
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
                Ok(SignalOutcome::NoSuchProcess)
            }
            Err(err) => Err(SignalError::Os(err)),
        },
        Signal::Term | Signal::Kill => {
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

pub fn process_is_alive(pid: u32) -> bool {
    match signal_process_checked(pid, Signal::Check) {
        Ok(SignalOutcome::Delivered) => true,
        Ok(SignalOutcome::NoSuchProcess) => false,
        Err(SignalError::InvalidPid(_)) => false,
        Err(SignalError::Os(_)) => true,
    }
}

#[cfg(windows)]
pub(crate) fn terminate_owned_child(child: &std::process::Child) -> std::io::Result<()> {
    use std::os::windows::io::AsRawHandle;
    win::terminate(child.as_raw_handle())
}

#[cfg(windows)]
pub(crate) struct OwnedJob(std::os::windows::io::OwnedHandle);

#[cfg(windows)]
impl OwnedJob {
    pub(crate) fn new() -> std::io::Result<Self> {
        use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
        use windows_sys::Win32::System::JobObjects::*;
        // SAFETY: null attributes/name create a private, non-inheritable job.
        let raw = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
        if raw.is_null() {
            return Err(std::io::Error::last_os_error());
        }
        // SAFETY: this newly created handle is owned exactly once.
        let job = Self(unsafe { OwnedHandle::from_raw_handle(raw) });
        // SAFETY: this C structure permits all-zero defaults.
        let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        // SAFETY: the job and sized information buffer remain valid for the call.
        if unsafe {
            SetInformationJobObject(
                job.0.as_raw_handle(),
                JobObjectExtendedLimitInformation,
                (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                std::mem::size_of_val(&limits) as u32,
            )
        } == 0
        {
            return Err(std::io::Error::last_os_error());
        }
        Ok(job)
    }

    pub(crate) fn assign(&self, child: &std::process::Child) -> std::io::Result<()> {
        use std::os::windows::io::AsRawHandle;
        // SAFETY: both handles are retained; the child has not been resumed.
        if unsafe {
            windows_sys::Win32::System::JobObjects::AssignProcessToJobObject(
                self.0.as_raw_handle(),
                child.as_raw_handle(),
            )
        } == 0
        {
            return Err(std::io::Error::last_os_error());
        }
        Ok(())
    }

    pub(crate) fn terminate(&self) -> std::io::Result<()> {
        use std::os::windows::io::AsRawHandle;
        // SAFETY: this private job contains only children assigned by its owner.
        if unsafe {
            windows_sys::Win32::System::JobObjects::TerminateJobObject(self.0.as_raw_handle(), 1)
        } == 0
        {
            return Err(std::io::Error::last_os_error());
        }
        Ok(())
    }
}

#[cfg(windows)]
pub(crate) fn resume_owned_child(
    child: &std::process::Child,
    start: std::time::Instant,
    timeout: std::time::Duration,
) -> std::io::Result<()> {
    use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
    use windows_sys::Win32::Foundation::INVALID_HANDLE_VALUE;
    use windows_sys::Win32::System::Diagnostics::ToolHelp::*;
    use windows_sys::Win32::System::Threading::*;
    // std retains the process handle, but closes the primary thread handle.
    // CREATE_SUSPENDED means this child has not yet created additional threads.
    let raw = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0) };
    if raw == INVALID_HANDLE_VALUE {
        return Err(std::io::Error::last_os_error());
    }
    // SAFETY: snapshot is a newly acquired handle, closed on every exit.
    let snapshot = unsafe { OwnedHandle::from_raw_handle(raw) };
    // SAFETY: THREADENTRY32 is a plain C structure with valid zero defaults.
    let mut entry: THREADENTRY32 = unsafe { std::mem::zeroed() };
    entry.dwSize = std::mem::size_of_val(&entry) as u32;
    // SAFETY: snapshot and writable entry are live for enumeration.
    let mut found = unsafe { Thread32First(snapshot.as_raw_handle(), &mut entry) };
    let mut primary = None;
    while found != 0 {
        if start.elapsed() >= timeout {
            return Err(std::io::Error::from(std::io::ErrorKind::TimedOut));
        }
        if entry.th32OwnerProcessID == child.id() && primary.replace(entry.th32ThreadID).is_some() {
            return Err(std::io::Error::other(
                "suspended child has multiple threads; expected one primary thread",
            ));
        }
        entry.dwSize = std::mem::size_of_val(&entry) as u32;
        // SAFETY: same live snapshot and entry used by Thread32First.
        found = unsafe { Thread32Next(snapshot.as_raw_handle(), &mut entry) };
    }
    let error = std::io::Error::last_os_error();
    if error.raw_os_error() != Some(windows_sys::Win32::Foundation::ERROR_NO_MORE_FILES as i32) {
        return Err(error);
    }
    let primary = primary
        .ok_or_else(|| std::io::Error::other("suspended child's primary thread was not found"))?;
    // SAFETY: acquire a non-inheritable thread handle, then verify ownership.
    let raw = unsafe {
        OpenThread(
            THREAD_SUSPEND_RESUME | THREAD_QUERY_LIMITED_INFORMATION,
            0,
            primary,
        )
    };
    if raw.is_null() {
        return Err(std::io::Error::last_os_error());
    }
    // SAFETY: this newly acquired handle is owned exactly once.
    let thread = unsafe { OwnedHandle::from_raw_handle(raw) };
    // SAFETY: the thread and child's anchoring process handle remain open.
    if unsafe { GetProcessIdOfThread(thread.as_raw_handle()) } != child.id() {
        return Err(std::io::Error::other(
            "suspended child thread ownership changed",
        ));
    }
    if start.elapsed() >= timeout {
        return Err(std::io::Error::from(std::io::ErrorKind::TimedOut));
    }
    // SAFETY: this is the verified sole thread of our suspended child.
    let previous = unsafe { ResumeThread(thread.as_raw_handle()) };
    match previous {
        1 => Ok(()),
        u32::MAX => Err(std::io::Error::last_os_error()),
        other => Err(std::io::Error::other(format!(
            "child thread suspend count was {other}; expected 1"
        ))),
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::disallowed_methods)]
    use super::*;

    #[cfg(target_os = "linux")]
    #[test]
    fn exited_child_retains_group_identity_until_cleanup() {
        use std::os::unix::process::CommandExt;
        let mut cmd = crate::sys::spawn::command("sh");
        cmd.args(["-c", "sleep 1 & exit 0"]).process_group(0);
        let mut child = cmd.spawn().unwrap();
        let start = std::time::Instant::now();
        while !unreaped_child_exited(&child).unwrap() {
            if start.elapsed() > std::time::Duration::from_secs(2) {
                let _ = signal_unreaped_child_group(&child, Signal::Kill);
                let _ = child.wait();
                panic!("fixture root did not exit");
            }
            std::thread::yield_now();
        }
        let cleanup = signal_unreaped_child_group(&child, Signal::Kill);
        let status = child.wait().unwrap();
        cleanup.unwrap();
        assert!(status.success());
    }

    const BROADCAST_VALUES: [(u32, &str); 3] = [
        (
            u32::MAX,
            "u32::MAX, which casts to -1 = every signallable process",
        ),
        (0, "0 = this process group"),
        (i32::MAX as u32 + 1, "one past pid_t's positive range"),
    ];

    #[test]
    #[cfg(unix)]
    fn terminal_termination_refuses_broadcast_group_one() {
        let error = signal_process_group_checked(1, Signal::Check).unwrap_err();
        assert!(error.to_string().contains("broadcast"));
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
    fn process_is_alive_reports_unusable_pids_as_not_alive() {
        for (pid, _) in BROADCAST_VALUES {
            assert!(
                !process_is_alive(pid),
                "pid {pid} must not be reported alive"
            );
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
        crate::sys::spawn::command("cmd")
            .args(["/d", "/C", "exit 0"])
            .spawn()
            .expect("spawn cmd")
    }

    #[cfg(windows)]
    #[test]
    fn private_job_close_cancels_its_suspended_child() {
        use std::os::windows::process::CommandExt;
        use windows_sys::Win32::System::Threading::CREATE_SUSPENDED;
        struct Fixture(std::process::Child);
        impl Drop for Fixture {
            fn drop(&mut self) {
                let _ = terminate_owned_child(&self.0);
                let _ = self.0.wait();
            }
        }
        let job = OwnedJob::new().unwrap();
        let mut cmd = crate::sys::spawn::command("cmd");
        cmd.args(["/d", "/c", "exit 0"])
            .creation_flags(crate::sys::spawn::CREATE_NO_WINDOW | CREATE_SUSPENDED);
        let mut child = Fixture(cmd.spawn().unwrap());
        job.assign(&child.0).unwrap();
        drop(job);
        let start = std::time::Instant::now();
        loop {
            if child.0.try_wait().unwrap().is_some() {
                break;
            }
            assert!(
                start.elapsed() < std::time::Duration::from_secs(2),
                "closing the private job must cancel its suspended child"
            );
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
    }

    #[cfg(windows)]
    #[test]
    fn exited_process_is_dead_while_its_handle_is_still_open() {
        assert!(process_is_alive(std::process::id()));
        for exit_code in [0, 259] {
            let mut child = crate::sys::spawn::command("cmd")
                .args(["/d", "/c", &format!("exit {exit_code}")])
                .spawn()
                .unwrap();
            let pid = child.id();
            assert_eq!(child.wait().unwrap().code(), Some(exit_code));
            assert!(
                !process_is_alive(pid),
                "exited pid {pid} with code {exit_code} must not be reported alive"
            );
            drop(child);
        }
    }
}
