//! Spawn-side window policy: every production spawn builds its `Command` here,
//! never `Command::new` directly, and the Windows flag is pre-set at construction
//! so a stored or handed-off builder cannot lose it. Clippy denies a bare new.

// The child gets no console window, nor the parent's. Spelled as a literal so
// this module stays dependency-free; a typo would still compile and silently
// reintroduce the window that flashes in and steals focus mid-typing.
#[cfg(windows)]
pub const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[allow(clippy::disallowed_methods)]
pub fn command<S: AsRef<std::ffi::OsStr>>(program: S) -> std::process::Command {
    #[allow(unused_mut)]
    let mut cmd = std::process::Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt as _;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

/// Every production git spawn. On Windows, PATH's Git for Windows launcher is resolved
/// once to the binary it would start, saving a process per call; see
/// `exe_path::git_for_windows_binary`.
pub fn git() -> std::process::Command {
    command(git_program())
}

#[cfg(windows)]
fn git_program() -> &'static std::ffi::OsStr {
    static PROGRAM: std::sync::OnceLock<std::ffi::OsString> = std::sync::OnceLock::new();
    PROGRAM.get_or_init(|| {
        crate::sys::exe_path::resolve("git")
            .and_then(|shim| crate::sys::exe_path::git_for_windows_binary(&shim))
            .map_or_else(|| "git".into(), std::path::PathBuf::into_os_string)
    })
}

#[cfg(not(windows))]
fn git_program() -> &'static std::ffi::OsStr {
    "git".as_ref()
}

#[cfg(unix)]
#[allow(clippy::disallowed_methods)]
pub fn tokio_command<S: AsRef<std::ffi::OsStr>>(program: S) -> tokio::process::Command {
    #[allow(unused_mut)]
    let mut cmd = tokio::process::Command::new(program);
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);
    cmd
}

/// Capture a background command with closed stdin. The deadline covers both
/// child exit and pipe completion; timeout returns `Ok(None)`.
pub fn output_within(
    cmd: std::process::Command,
    timeout: std::time::Duration,
) -> std::io::Result<Option<std::process::Output>> {
    output_within_with_stdin(cmd, timeout, std::process::Stdio::null())
}

// Background metadata and diagnostics must not allocate without a bound.
const OUTPUT_LIMIT: usize = 8 * 1024 * 1024;

/// Reads taken from each pipe once a deadline passes: 8 KiB each, enough for
/// what a child wrote just before it, and bounded so a flood cannot hold the kill.
const DRAIN_READS: usize = 16;

/// Which pipe a chunk came from.
#[derive(Clone, Copy)]
enum Stream {
    Out,
    Err,
}

/// Where a capture's bytes go, chunk by chunk, in the order they were read.
type Sink<'a> = &'a mut dyn FnMut(Stream, &[u8]) -> std::io::Result<()>;

/// Capture with caller-owned stdin and an 8 MiB combined output limit.
/// Linux owns a process group; Windows owns a job. Other platforms refuse.
pub fn output_within_with_stdin(
    mut cmd: std::process::Command,
    timeout: std::time::Duration,
    stdin: std::process::Stdio,
) -> std::io::Result<Option<std::process::Output>> {
    cmd.stdin(stdin);
    let (mut out, mut err) = (Vec::new(), Vec::new());
    let mut total = 0;
    let mut sink = |stream: Stream, bytes: &[u8]| {
        total += bytes.len();
        if total > OUTPUT_LIMIT {
            return Err(std::io::Error::other(format!(
                "subprocess capture requested {total} bytes; combined output limit is {OUTPUT_LIMIT} bytes"
            )));
        }
        match stream {
            Stream::Out => out.extend_from_slice(bytes),
            Stream::Err => err.extend_from_slice(bytes),
        }
        Ok(())
    };
    let status = capture(cmd, timeout, &mut sink)?;
    Ok(status.map(|status| std::process::Output {
        status,
        stdout: out,
        stderr: err,
    }))
}

fn capture(
    cmd: std::process::Command,
    timeout: std::time::Duration,
    sink: Sink<'_>,
) -> std::io::Result<Option<std::process::ExitStatus>> {
    #[cfg(target_os = "linux")]
    {
        bounded_linux::capture(cmd, timeout, sink)
    }
    #[cfg(windows)]
    {
        bounded_windows::capture(cmd, timeout, sink)
    }
    #[cfg(not(any(target_os = "linux", windows)))]
    {
        let _ = (cmd, timeout, sink);
        Err(std::io::Error::new(
            std::io::ErrorKind::Unsupported,
            format!("bounded subprocess capture is unsupported on {}; expected Linux or Windows process ownership", std::env::consts::OS),
        ))
    }
}

#[cfg(target_os = "linux")]
mod bounded_linux {
    use super::{Sink, Stream};
    use std::io::{self, Read};
    use std::os::fd::{AsRawFd, RawFd};
    use std::os::unix::process::CommandExt;
    use std::process::{Child, Command, ExitStatus, Stdio};
    use std::time::{Duration, Instant};

    struct OwnedChild {
        child: Child,
        reaped: bool,
    }

    impl OwnedChild {
        fn terminate(&mut self) -> io::Result<()> {
            // No wait/try_wait has reaped this child: its PID still anchors the
            // group even when it is a zombie. Identity is released only after kill.
            crate::sys::pid::signal_unreaped_child_group(&self.child, crate::sys::pid::Signal::Kill)
                .map_err(io::Error::other)
        }
    }

    impl Drop for OwnedChild {
        fn drop(&mut self) {
            if !self.reaped {
                if self.terminate().is_err() {
                    let _ = crate::sys::pid::signal_process_checked(
                        self.child.id(),
                        crate::sys::pid::Signal::Kill,
                    );
                }
                let _ = self.child.wait();
            }
        }
    }

    fn nonblocking(fd: RawFd) -> io::Result<()> {
        // SAFETY: fd belongs to an open pipe retained by the caller.
        let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
        if flags < 0 || unsafe { libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) } < 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }

    fn read_pipe(pipe: &mut impl Read, stream: Stream, sink: Sink<'_>) -> io::Result<bool> {
        let mut buf = [0; 8192];
        // One chunk per pass keeps a busy stdout from starving stderr/deadline.
        match pipe.read(&mut buf) {
            Ok(0) => Ok(true),
            Ok(n) => {
                sink(stream, &buf[..n])?;
                Ok(false)
            }
            Err(err)
                if matches!(
                    err.kind(),
                    io::ErrorKind::WouldBlock | io::ErrorKind::Interrupted
                ) =>
            {
                Ok(false)
            }
            Err(err) => Err(err),
        }
    }

    pub(super) fn capture(
        mut cmd: Command,
        timeout: Duration,
        sink: Sink<'_>,
    ) -> io::Result<Option<ExitStatus>> {
        let start = Instant::now();
        cmd.process_group(0)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let mut child = OwnedChild {
            child: cmd.spawn()?,
            reaped: false,
        };
        let mut stdout = child.child.stdout.take().expect("stdout was piped");
        let mut stderr = child.child.stderr.take().expect("stderr was piped");
        nonblocking(stdout.as_raw_fd())?;
        nonblocking(stderr.as_raw_fd())?;
        let mut out_done = false;
        let mut err_done = false;
        loop {
            if start.elapsed() >= timeout {
                // Keep what the child wrote before its deadline; the pipes do not block.
                for _ in 0..super::DRAIN_READS {
                    if !out_done {
                        out_done = read_pipe(&mut stdout, Stream::Out, sink)?;
                    }
                    if !err_done {
                        err_done = read_pipe(&mut stderr, Stream::Err, sink)?;
                    }
                }
                return Ok(None);
            }
            if !out_done {
                out_done = read_pipe(&mut stdout, Stream::Out, sink)?;
            }
            if !err_done {
                err_done = read_pipe(&mut stderr, Stream::Err, sink)?;
            }
            if out_done && err_done && crate::sys::pid::unreaped_child_exited(&child.child)? {
                child.terminate()?;
                let status = child.child.wait()?;
                // Drop must never signal the now-reaped identity.
                child.reaped = true;
                return Ok(Some(status));
            }
            let remaining = timeout.saturating_sub(start.elapsed());
            let mut pipes = [
                libc::pollfd {
                    fd: if out_done { -1 } else { stdout.as_raw_fd() },
                    events: libc::POLLIN,
                    revents: 0,
                },
                libc::pollfd {
                    fd: if err_done { -1 } else { stderr.as_raw_fd() },
                    events: libc::POLLIN,
                    revents: 0,
                },
            ];
            let millis = remaining.as_millis().min(5) as i32;
            // SAFETY: pipes is a valid two-element array for the whole call.
            if unsafe { libc::poll(pipes.as_mut_ptr(), 2, millis) } < 0 {
                let error = io::Error::last_os_error();
                if error.kind() != io::ErrorKind::Interrupted {
                    return Err(error);
                }
            }
        }
    }
}

#[cfg(windows)]
mod bounded_windows {
    use super::{Sink, Stream};
    use std::io::{self, Read};
    use std::os::windows::io::AsRawHandle;
    use std::os::windows::process::CommandExt;
    use std::process::{Child, Command, ExitStatus, Stdio};
    use std::time::{Duration, Instant};
    use windows_sys::Win32::Foundation::ERROR_BROKEN_PIPE;
    use windows_sys::Win32::System::Pipes::PeekNamedPipe;
    use windows_sys::Win32::System::Threading::CREATE_SUSPENDED;

    struct OwnedChild {
        child: Child,
        job: crate::sys::pid::OwnedJob,
        assigned: bool,
        finished: bool,
    }

    impl Drop for OwnedChild {
        fn drop(&mut self) {
            if !self.finished {
                if !self.assigned || self.job.terminate().is_err() {
                    let _ = crate::sys::pid::terminate_owned_child(&self.child);
                }
                let _ = self.child.wait();
            }
            // Closing the non-inherited job also cancels descendants on unwind.
        }
    }

    fn read_pipe(
        pipe: &mut (impl Read + AsRawHandle),
        stream: Stream,
        sink: Sink<'_>,
    ) -> io::Result<(bool, bool)> {
        let mut available = 0;
        // SAFETY: the retained pipe handle and writable availability count are valid.
        let ok = unsafe {
            PeekNamedPipe(
                pipe.as_raw_handle(),
                std::ptr::null_mut(),
                0,
                std::ptr::null_mut(),
                &mut available,
                std::ptr::null_mut(),
            )
        };
        if ok == 0 {
            let error = io::Error::last_os_error();
            return if error.raw_os_error() == Some(ERROR_BROKEN_PIPE as i32) {
                Ok((true, false))
            } else {
                Err(error)
            };
        }
        if available == 0 {
            return Ok((false, false));
        }
        let mut buf = [0; 8192];
        let length = (available as usize).min(buf.len());
        // Only this collector reads the pipe; available bytes cannot be consumed
        // by another reader between PeekNamedPipe and this bounded read.
        let n = pipe.read(&mut buf[..length])?;
        sink(stream, &buf[..n])?;
        Ok((n == 0, n != 0))
    }

    pub(super) fn capture(
        mut cmd: Command,
        timeout: Duration,
        sink: Sink<'_>,
    ) -> io::Result<Option<ExitStatus>> {
        let start = Instant::now();
        let job = crate::sys::pid::OwnedJob::new()?;
        // CommandExt replaces flags rather than adding them, so retain window policy.
        cmd.creation_flags(super::CREATE_NO_WINDOW | CREATE_SUSPENDED)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let mut child = OwnedChild {
            child: cmd.spawn()?,
            job,
            assigned: false,
            finished: false,
        };
        child.job.assign(&child.child)?;
        child.assigned = true;
        if start.elapsed() >= timeout {
            return Ok(None);
        }
        if let Err(error) = crate::sys::pid::resume_owned_child(&child.child, start, timeout) {
            return if error.kind() == io::ErrorKind::TimedOut {
                Ok(None)
            } else {
                Err(error)
            };
        }
        let mut stdout = child.child.stdout.take().expect("stdout was piped");
        let mut stderr = child.child.stderr.take().expect("stderr was piped");
        let (mut out_done, mut err_done) = (false, false);
        let mut status = None;
        loop {
            if start.elapsed() >= timeout {
                // Keep what the child wrote before its deadline; a peek never blocks.
                for _ in 0..super::DRAIN_READS {
                    if !out_done {
                        out_done = read_pipe(&mut stdout, Stream::Out, sink)?.0;
                    }
                    if !err_done {
                        err_done = read_pipe(&mut stderr, Stream::Err, sink)?.0;
                    }
                }
                return Ok(None);
            }
            let mut progress = false;
            if !out_done {
                let read = read_pipe(&mut stdout, Stream::Out, sink)?;
                out_done = read.0;
                progress |= read.1;
            }
            if !err_done {
                let read = read_pipe(&mut stderr, Stream::Err, sink)?;
                err_done = read.0;
                progress |= read.1;
            }
            if status.is_none() {
                status = child.child.try_wait()?;
            }
            if out_done && err_done {
                if let Some(status) = status {
                    // Child retains its process handle after wait; the job owns descendants.
                    child.job.terminate()?;
                    child.finished = true;
                    return Ok(Some(status));
                }
            }
            if !progress {
                // Poll at most every 5 ms without delaying a continuously readable pipe.
                std::thread::sleep(
                    timeout
                        .saturating_sub(start.elapsed())
                        .min(Duration::from_millis(5)),
                );
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(target_os = "linux")]
    #[test]
    fn output_within_kills_a_child_past_its_deadline() {
        let start = std::time::Instant::now();
        let mut cmd = command("sleep");
        cmd.arg("30");
        let out = output_within(cmd, std::time::Duration::from_millis(200)).unwrap();
        assert!(out.is_none());
        assert!(start.elapsed() < std::time::Duration::from_secs(10));

        let mut cmd = command("sh");
        cmd.args(["-c", "read x; echo out; echo err >&2"]);
        let out = output_within(cmd, std::time::Duration::from_secs(10))
            .unwrap()
            .expect("a closed stdin ends the read at once");
        assert_eq!(String::from_utf8_lossy(&out.stdout), "out\n");
        assert_eq!(String::from_utf8_lossy(&out.stderr), "err\n");
    }

    #[cfg(not(any(target_os = "linux", windows)))]
    #[test]
    fn unsupported_capture_refuses_before_spawning() {
        let error = output_within(
            command("houston-nonexistent-fixture"),
            std::time::Duration::from_secs(1),
        )
        .unwrap_err();
        assert_eq!(error.kind(), std::io::ErrorKind::Unsupported);
        assert!(error.to_string().contains(std::env::consts::OS));
    }

    #[cfg(windows)]
    #[test]
    fn expired_deadline_never_resumes_the_child() {
        let dir = tempfile::tempdir().unwrap();
        let mut cmd = command("cmd");
        cmd.args(["/d", "/c", "echo unexpected > marker"])
            .current_dir(dir.path());
        assert!(output_within(cmd, std::time::Duration::ZERO)
            .unwrap()
            .is_none());
        assert!(!dir.path().join("marker").exists());
    }

    #[cfg(windows)]
    #[test]
    fn bounded_capture_preserves_spawn_errors() {
        let error = output_within(
            command("houston-nonexistent-fixture"),
            std::time::Duration::from_secs(1),
        )
        .unwrap_err();
        assert_eq!(error.kind(), std::io::ErrorKind::NotFound);
    }

    #[cfg(windows)]
    #[test]
    fn create_no_window_is_winbase_s_value() {
        assert_eq!(CREATE_NO_WINDOW, 0x0800_0000);
        assert_eq!(
            CREATE_NO_WINDOW,
            windows_sys::Win32::System::Threading::CREATE_NO_WINDOW,
            "the literal must equal the platform crate's own constant"
        );
    }

    #[cfg(windows)]
    #[test]
    fn a_flagged_command_still_captures_stdout_normally() {
        let out = command("cmd")
            .args(["/C", "echo", "houston"])
            .output()
            .expect("cmd /C echo must run");
        assert!(out.status.success());
        assert_eq!(String::from_utf8_lossy(&out.stdout).trim(), "houston");
    }

    #[test]
    fn the_git_command_runs_git() {
        let out = git().arg("--version").output().expect("git must run");
        assert!(out.status.success());
        assert!(
            String::from_utf8_lossy(&out.stdout).starts_with("git version"),
            "{out:?}"
        );
    }

    #[cfg(unix)]
    #[test]
    fn on_unix_the_helper_is_a_plain_command() {
        let out = command("echo")
            .arg("houston")
            .output()
            .expect("echo must run");
        assert!(out.status.success());
        assert_eq!(String::from_utf8_lossy(&out.stdout).trim(), "houston");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn the_tokio_twin_runs_and_captures_too() {
        let out = tokio_command("echo")
            .arg("houston")
            .output()
            .await
            .expect("echo must run");
        assert!(out.status.success());
        assert_eq!(String::from_utf8_lossy(&out.stdout).trim(), "houston");
    }
}
