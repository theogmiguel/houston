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

/// Capture with caller-owned stdin and an 8 MiB combined output limit.
/// Linux retains process-group ownership through cleanup; other platforms refuse.
/// See docs/internals/daemon.md for cancellation boundaries.
pub fn output_within_with_stdin(
    mut cmd: std::process::Command,
    timeout: std::time::Duration,
    stdin: std::process::Stdio,
) -> std::io::Result<Option<std::process::Output>> {
    cmd.stdin(stdin);
    #[cfg(target_os = "linux")]
    {
        bounded_linux::capture(cmd, timeout)
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = (cmd, timeout);
        Err(std::io::Error::new(
            std::io::ErrorKind::Unsupported,
            format!("bounded subprocess capture is unsupported on {}; expected Linux process-group ownership", std::env::consts::OS),
        ))
    }
}

#[cfg(target_os = "linux")]
mod bounded_linux {
    use std::io::{self, Read};
    use std::os::fd::{AsRawFd, RawFd};
    use std::os::unix::process::CommandExt;
    use std::process::{Child, Command, Output, Stdio};
    use std::time::{Duration, Instant};

    // Background metadata/diagnostics must not allocate without a bound.
    const OUTPUT_LIMIT: usize = 8 * 1024 * 1024;

    struct OwnedChild {
        child: Child,
        reaped: bool,
    }

    impl OwnedChild {
        fn terminate(&mut self) -> io::Result<()> {
            // No wait/try_wait has reaped this child: its PID still anchors the
            // group even when it is a zombie. Identity is released only after kill.
            crate::pid::signal_unreaped_child_group(&self.child, crate::pid::Signal::Kill)
                .map_err(io::Error::other)
        }
    }

    impl Drop for OwnedChild {
        fn drop(&mut self) {
            if !self.reaped {
                if self.terminate().is_err() {
                    let _ = self.child.kill();
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

    fn read_pipe(pipe: &mut impl Read, bytes: &mut Vec<u8>, total: &mut usize) -> io::Result<bool> {
        let mut buf = [0; 8192];
        // One chunk per pass keeps a busy stdout from starving stderr/deadline.
        match pipe.read(&mut buf) {
            Ok(0) => Ok(true),
            Ok(n) => {
                *total += n;
                if *total > OUTPUT_LIMIT {
                    return Err(io::Error::other(format!(
                        "subprocess capture requested {total} bytes; combined output limit is {OUTPUT_LIMIT} bytes"
                    )));
                }
                bytes.extend_from_slice(&buf[..n]);
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

    pub(super) fn capture(mut cmd: Command, timeout: Duration) -> io::Result<Option<Output>> {
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
        let mut out = Vec::new();
        let mut err = Vec::new();
        let mut total = 0;
        let mut out_done = false;
        let mut err_done = false;
        loop {
            if start.elapsed() >= timeout {
                return Ok(None);
            }
            if !out_done {
                out_done = read_pipe(&mut stdout, &mut out, &mut total)?;
            }
            if !err_done {
                err_done = read_pipe(&mut stderr, &mut err, &mut total)?;
            }
            if out_done && err_done && crate::pid::unreaped_child_exited(&child.child)? {
                child.terminate()?;
                let status = child.child.wait()?;
                // Drop must never signal the now-reaped identity.
                child.reaped = true;
                return Ok(Some(Output {
                    status,
                    stdout: out,
                    stderr: err,
                }));
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

    #[cfg(not(target_os = "linux"))]
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

    #[tokio::test]
    async fn the_tokio_twin_runs_and_captures_too() {
        #[cfg(windows)]
        let out = tokio_command("cmd")
            .args(["/C", "echo", "houston"])
            .output()
            .await
            .expect("cmd /C echo must run");
        #[cfg(unix)]
        let out = tokio_command("echo")
            .arg("houston")
            .output()
            .await
            .expect("echo must run");
        assert!(out.status.success());
        assert_eq!(String::from_utf8_lossy(&out.stdout).trim(), "houston");
    }
}
