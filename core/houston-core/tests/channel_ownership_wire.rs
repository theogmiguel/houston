#![cfg(unix)]
#![allow(clippy::disallowed_methods)]

use std::io::Read;
use std::process::{Command, Stdio};
use std::time::Duration;

#[path = "common/mod.rs"]
mod common;

fn bin() -> &'static str {
    env!("CARGO_BIN_EXE_houston-core")
}

#[test]
fn refuses_to_own_a_channel_when_houston_channel_is_unset() {
    let home = tempfile::tempdir().unwrap();

    let output = Command::new(bin())
        .env_clear()
        .env("HOME", home.path())
        .env("PATH", std::env::var("PATH").unwrap_or_default())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .expect("failed to spawn houston-core");

    assert!(
        !output.status.success(),
        "an unset HOUSTON_CHANNEL must refuse (nonzero exit), got status {:?}, \
         stdout: {}, stderr: {}",
        output.status,
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains("HOUSTON_CHANNEL"),
        "refusal must name the variable, got: {stderr}"
    );
    assert!(
        stderr.contains(".houston") && stderr.contains(".houston-dev"),
        "refusal must name both channel dirs, got: {stderr}"
    );
    assert!(
        !home.path().join(".houston").exists(),
        "a refusal must never create the release channel's state dir"
    );
    assert!(
        !home.path().join(".houston-dev").exists(),
        "a refusal must never create the dev channel's state dir either"
    );
}

#[test]
fn refuses_an_explicit_but_invalid_channel_value() {
    let home = tempfile::tempdir().unwrap();

    let output = Command::new(bin())
        .env_clear()
        .env("HOME", home.path())
        .env("PATH", std::env::var("PATH").unwrap_or_default())
        .env("HOUSTON_CHANNEL", "../etc")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .expect("failed to spawn houston-core");

    assert!(
        !output.status.success(),
        "an invalid explicit channel must refuse, got status {:?}",
        output.status
    );
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains("../etc"),
        "refusal must name the offending value, got: {stderr}"
    );
    assert!(
        !home.path().join(".houston").exists(),
        "an invalid channel must never create the release channel's state dir"
    );
}

#[test]
fn print_protocol_still_works_with_no_channel_set() {
    let home = tempfile::tempdir().unwrap();

    let output = Command::new(bin())
        .env_clear()
        .env("HOME", home.path())
        .env("PATH", std::env::var("PATH").unwrap_or_default())
        .arg("--print-protocol")
        .output()
        .expect("failed to spawn houston-core");

    assert!(
        output.status.success(),
        "--print-protocol must succeed with no channel set, got status {:?}, stderr: {}",
        output.status,
        String::from_utf8_lossy(&output.stderr)
    );
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert_eq!(
        stdout.trim(),
        houston_protocol::PROTOCOL_VERSION.to_string(),
        "must print exactly the protocol version, got: {stdout:?}"
    );
    assert!(
        !home.path().join(".houston").exists(),
        "--print-protocol must never create any channel's state dir"
    );
}

struct ChildGuard(u32);
impl Drop for ChildGuard {
    fn drop(&mut self) {
        let _ = houston_core::pid::signal_process(self.0, houston_core::pid::Signal::Term);
    }
}

#[test]
fn boots_normally_when_houston_channel_is_set_explicitly() {
    let home = tempfile::tempdir().unwrap();

    let mut child = {
        let mut cmd = common::hermetic_command(bin(), home.path());
        cmd.env("HOUSTON_CHANNEL", "dev")
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        cmd.spawn().expect("failed to spawn houston-core")
    };
    let _child_guard = ChildGuard(child.id());

    let cfg_path = home.path().join(".houston-dev").join("daemon.json");
    let deadline = std::time::Instant::now() + Duration::from_secs(10);
    while !cfg_path.exists() {
        assert!(
            std::time::Instant::now() < deadline,
            "daemon.json never appeared under the dev channel's state dir within 10s"
        );
        if let Ok(Some(status)) = child.try_wait() {
            let mut stderr = String::new();
            child
                .stderr
                .take()
                .unwrap()
                .read_to_string(&mut stderr)
                .ok();
            panic!("daemon exited early with {status:?} before writing daemon.json: {stderr}");
        }
        std::thread::sleep(Duration::from_millis(20));
    }

    assert!(
        !home.path().join(".houston").exists(),
        "an explicit dev channel must never touch the release channel's dir"
    );

    houston_core::pid::signal_process(child.id(), houston_core::pid::Signal::Term)
        .expect("signalling the spawned daemon");
    let _ = child.wait();
}
