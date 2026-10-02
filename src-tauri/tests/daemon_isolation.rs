#![cfg(target_os = "linux")]
#![allow(clippy::disallowed_methods)]

#[path = "../src/daemon_isolation.rs"]
mod daemon_isolation;

#[test]
fn isolated_dummy_has_a_different_cgroup() {
    let probe = Command::new("systemd-run")
        .args(["--user", "--scope", "--quiet", "--", "/usr/bin/true"])
        .output();
    if !probe.as_ref().is_ok_and(|output| output.status.success()) {
        eprintln!("SKIPPED: user systemd scope unavailable: {probe:?}");
        return;
    }
    let temporary = tempfile::tempdir().unwrap();
    let pid_file = temporary.path().join("pid");
    let literal = "literal $HOME %h %i";
    let mut command = Command::new("/bin/sh");
    command
        .env("HOME", temporary.path())
        .env("USERPROFILE", temporary.path())
        .args(["-c", "echo $$ > \"$1.tmp\"; printf '%s' \"$2\" > \"$1.args\"; /usr/bin/mv \"$1.tmp\" \"$1\"; exec /usr/bin/sleep 60", "dummy"])
        .arg(&pid_file)
        .arg(literal);
    for key in std::env::vars_os().map(|(key, _)| key) {
        if key
            .to_str()
            .is_some_and(|key| key.starts_with("CARGO_BIN_EXE_"))
        {
            command.env_remove(key);
        }
    }
    let unit =
        daemon_isolation::start(&command, "test-isolation", &temporary.path().join("log")).unwrap();
    let mut fallback = if unit.is_none() {
        Some(command.spawn().unwrap())
    } else {
        None
    };
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(20);
    while !pid_file.exists() {
        assert!(std::time::Instant::now() < deadline, "dummy did not start");
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
    let pid = std::fs::read_to_string(&pid_file)
        .unwrap()
        .trim()
        .parse::<u32>()
        .unwrap();
    struct Guard(u32, Option<u64>);
    impl Drop for Guard {
        fn drop(&mut self) {
            let _ = houston_core::pid::signal_process_checked_identity(
                self.0,
                houston_core::pid::Signal::Kill,
                self.1,
            );
        }
    }
    let _guard = Guard(pid, houston_core::pid::process_creation_token(pid));
    assert_eq!(
        std::fs::read_to_string(pid_file.with_extension("args")).unwrap(),
        literal
    );
    let parent = std::fs::read_to_string("/proc/self/cgroup").unwrap();
    let child = std::fs::read_to_string(format!("/proc/{pid}/cgroup")).unwrap();
    if let Some(child) = fallback.as_mut() {
        child.kill().unwrap();
        child.wait().unwrap();
    }
    assert_ne!(parent, child, "the dummy must leave the caller's cgroup");
}

use std::process::Command;
