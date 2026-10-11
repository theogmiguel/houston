//! WSL's user systemd refuses KillUnit with InvalidArgs while the scope's processes die.
//! The scope failure is process-wide here, so these tests live in their own binary.
#![cfg(target_os = "linux")]

mod common;

use common::TOKEN;
use houston_core::daemon::{CreateParams, Daemon, DaemonConfig};
use houston_protocol as proto;
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

static SCOPE_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

fn daemon(state_dir: &Path) -> Arc<Daemon> {
    Daemon::new(DaemonConfig {
        token: TOKEN.to_string(),
        db_path: state_dir.join("test.db"),
    })
    .unwrap()
}

/// A shell whose root pid is written to `root.pid` in `dir`.
fn create_sleeper(d: &Arc<Daemon>, dir: &Path) -> (u32, u32) {
    let id = d
        .create_session(CreateParams {
            agent: proto::AgentKind::Custom,
            project_dir: dir.to_path_buf(),
            cmd: Some(
                ["sh", "-c", "echo $$ > root.pid; exec sleep 100"]
                    .map(String::from)
                    .to_vec(),
            ),
            cols: 80,
            rows: 24,
            cwd_from: None,
            shell_integration: false,
            auto_approve: false,
            acp: None,
            profile: None,
            prompt: None,
            model: None,
            effort: None,
        })
        .unwrap()
        .id;
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    let root = loop {
        if let Some(pid) = std::fs::read_to_string(dir.join("root.pid"))
            .ok()
            .and_then(|value| value.trim().parse::<u32>().ok())
        {
            break pid;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "PTY fixture did not start"
        );
        std::thread::sleep(Duration::from_millis(10));
    };
    (id, root)
}

fn running(pid: u32) -> bool {
    std::fs::read_to_string(format!("/proc/{pid}/stat")).is_ok_and(|stat| {
        stat[stat.rfind(')').unwrap() + 2..]
            .split_whitespace()
            .next()
            != Some("Z")
    })
}

fn wait_gone(pid: u32) {
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    while running(pid) {
        assert!(std::time::Instant::now() < deadline, "pid {pid} still runs");
        std::thread::sleep(Duration::from_millis(10));
    }
}

#[test]
fn a_failed_scope_stop_still_kills_the_session() {
    let _scope = SCOPE_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let state = tempfile::tempdir().unwrap();
    let proj = tempfile::tempdir().unwrap();
    let d = daemon(state.path());
    let (id, root) = create_sleeper(&d, proj.path());

    houston_core::session_isolation::fail_scope_termination_for_test(true);
    let killed = d.kill(id);
    houston_core::session_isolation::fail_scope_termination_for_test(false);

    killed.expect("the PTY fallback stops the session");
    wait_gone(root);
}

#[test]
fn shutdown_completes_when_a_scope_stop_fails() {
    let _scope = SCOPE_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let state = tempfile::tempdir().unwrap();
    let proj = tempfile::tempdir().unwrap();
    let d = daemon(state.path());
    let (_, root) = create_sleeper(&d, proj.path());
    d.reap_set_exit_hook_for_test(Box::new(|| {}));

    houston_core::session_isolation::fail_scope_termination_for_test(true);
    let result = d.manage_shutdown();
    houston_core::session_isolation::fail_scope_termination_for_test(false);

    let ok = match result {
        Ok(ok) => ok,
        Err(failure) => panic!("shutdown failed: {}", failure.reason),
    };
    assert_eq!(ok.stopped_sessions, 1);
    assert!(state.path().join("clean-shutdown").exists());
    wait_gone(root);
}
