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

/// `Command::output` with a deadline, for a background job that must finish: past
/// `timeout` the child is killed and `Ok(None)` returned. Stdin is closed, so a child
/// that would prompt reads EOF instead of waiting for an answer nobody can give.
pub fn output_within(
    mut cmd: std::process::Command,
    timeout: std::time::Duration,
) -> std::io::Result<Option<std::process::Output>> {
    use std::io::Read;
    use std::process::Stdio;
    let mut child = cmd
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;
    let drain = |pipe: Option<Box<dyn Read + Send>>| {
        std::thread::spawn(move || {
            let mut buf = Vec::new();
            if let Some(mut pipe) = pipe {
                let _ = pipe.read_to_end(&mut buf);
            }
            buf
        })
    };
    let stdout = drain(child.stdout.take().map(|p| Box::new(p) as _));
    let stderr = drain(child.stderr.take().map(|p| Box::new(p) as _));
    let start = std::time::Instant::now();
    let status = loop {
        if let Some(status) = child.try_wait()? {
            break status;
        }
        if start.elapsed() >= timeout {
            let _ = child.kill();
            let _ = child.wait();
            // A grandchild may still hold the pipes; the readers end when it does.
            return Ok(None);
        }
        std::thread::sleep(std::time::Duration::from_millis(25));
    };
    Ok(Some(std::process::Output {
        status,
        stdout: stdout.join().unwrap_or_default(),
        stderr: stderr.join().unwrap_or_default(),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
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
