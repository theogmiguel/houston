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

#[cfg(test)]
mod tests {
    use super::*;

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
