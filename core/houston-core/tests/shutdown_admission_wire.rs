#![cfg(all(unix, feature = "test-barriers"))]
mod common;

use houston_core::daemon::{CreateParams, Daemon, DaemonConfig};
use houston_protocol as proto;
use std::sync::{Arc, Barrier};
use std::time::{Duration, Instant};

#[test]
fn shutdown_waits_for_admitted_launch_and_concurrent_refusal_keeps_the_gate() {
    if std::env::var_os("HOUSTON_SHUTDOWN_ADMISSION_FIXTURE").is_none() {
        let home = tempfile::tempdir().unwrap();
        let status = common::hermetic_command(std::env::current_exe().unwrap(), home.path())
            .args([
                "--exact",
                "shutdown_waits_for_admitted_launch_and_concurrent_refusal_keeps_the_gate",
                "--nocapture",
            ])
            .env("HOUSTON_SHUTDOWN_ADMISSION_FIXTURE", "1")
            .status()
            .unwrap();
        assert!(status.success());
        return;
    }
    let state = tempfile::tempdir().unwrap();
    let daemon = Daemon::new(DaemonConfig {
        token: "fixture".into(),
        db_path: state.path().join("test.db"),
    })
    .unwrap();
    let spawned = Arc::new(Barrier::new(2));
    let release = Arc::new(Barrier::new(2));
    let entered = Arc::clone(&spawned);
    let unblock = Arc::clone(&release);
    daemon.set_startup_test(
        None,
        Box::new(move |_, _| {
            entered.wait();
            unblock.wait();
        }),
    );
    let creator = Arc::clone(&daemon);
    let project = state.path().to_path_buf();
    let creating = std::thread::spawn(move || {
        creator.create_session(CreateParams {
            agent: proto::AgentKind::Custom,
            project_dir: project,
            cmd: Some(vec!["/bin/sh".into(), "-c".into(), "read ignored".into()]),
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
    });
    spawned.wait();
    let stopper = Arc::clone(&daemon);
    let stopping = std::thread::spawn(move || stopper.manage_shutdown_if_idle());
    let deadline = Instant::now() + Duration::from_secs(5);
    while !daemon.is_shutting_down() {
        assert!(
            Instant::now() < deadline,
            "shutdown never claimed admission"
        );
        std::thread::yield_now();
    }
    let concurrent = daemon.manage_shutdown_if_idle();
    let gate_remained = daemon.is_shutting_down();
    release.wait();
    let session = creating.join().unwrap().unwrap();
    let first = stopping.join().unwrap();
    daemon.kill(session.id).unwrap();
    assert!(
        concurrent.is_err(),
        "a second shutdown must not claim the first shutdown's gate"
    );
    assert!(gate_remained, "concurrent refusal reopened admission");
    let failure = first.expect_err("idle shutdown must include the already admitted launch");
    assert_eq!(failure.unterminated, vec![session.id]);
    assert!(!state.path().join("clean-shutdown").exists());
    assert!(
        !daemon.is_shutting_down(),
        "the owning refusal must reopen admission"
    );
}
