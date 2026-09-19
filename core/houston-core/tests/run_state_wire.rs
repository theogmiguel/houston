mod common;

use common::*;
use houston_core::daemon::{CreateParams, Daemon, DaemonConfig};
use houston_core::db::Db;
use houston_protocol as proto;
use std::sync::Arc;

static ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

fn boot_daemon(state_dir: &std::path::Path) -> Arc<Daemon> {
    Daemon::new(DaemonConfig {
        token: TOKEN.to_string(),
        db_path: state_dir.join("test.db"),
    })
    .unwrap()
}

fn create_session(daemon: &Arc<Daemon>, dir: &std::path::Path) -> u32 {
    daemon
        .create_session(CreateParams {
            agent: proto::AgentKind::Shell,
            project_dir: dir.to_path_buf(),
            cmd: None,
            cols: 80,
            rows: 24,
            cwd_from: None,
            shell_integration: false,
            auto_approve: false,
            acp: None,
            profile: None,
            prompt: None,
        })
        .unwrap()
        .id
}

fn seed_husk(state_dir: &std::path::Path, dir: &std::path::Path) {
    let db = Db::open(&state_dir.join("test.db")).unwrap();
    db.insert_session(&proto::SessionInfo {
        id: 1,
        agent: proto::AgentKind::Shell,
        project_dir: dir.display().to_string(),
        cwd: dir.display().to_string(),
        state: proto::SessionState::Running,
        title: "Husk-1".into(),
        codename: "Husk-1".into(),
        detected_agent: None,
        hidden: false,
        ssh_host: None,
        restore_deferred: None,
        status: None,
        swarm_agent: None,
        spawned_by: None,
        acp: None,
        live_children: 0,
        profile_label: None,
        children_waiting: 0,
        delegation: None,
        inbox_unread: 0,
        tags: vec![],
    })
    .unwrap();
}

#[test]
fn graceful_shutdown_reports_no_abnormal_exit() {
    let _env = ENV_LOCK.lock().unwrap();
    std::env::set_var("SHELL", "/bin/sh");
    let state = tempfile::tempdir().unwrap();
    let proj = tempfile::tempdir().unwrap();
    let daemon = Daemon::new(DaemonConfig {
        token: TOKEN.to_string(),
        db_path: state.path().join("test.db"),
    })
    .unwrap();
    create_session(&daemon, proj.path());
    daemon.persist_all();
    drop(daemon);

    let daemon2 = boot_daemon(state.path());
    let cause = daemon2.startup_cause();
    assert!(
        !cause.abnormal_exit,
        "a graceful persist_all() must not read as abnormal: {cause:?}"
    );
    let recovery = daemon2.recovery_summary().expect("husk present");
    assert!(
        !recovery.crashed,
        "graceful shutdown must not defer husks as a crash: {recovery:?}"
    );
}

#[test]
fn ungraceful_exit_reports_abnormal_exit_with_session_count_and_runtime() {
    let _env = ENV_LOCK.lock().unwrap();
    std::env::set_var("SHELL", "/bin/sh");
    let state = tempfile::tempdir().unwrap();
    let proj = tempfile::tempdir().unwrap();
    let daemon = Daemon::new(DaemonConfig {
        token: TOKEN.to_string(),
        db_path: state.path().join("test.db"),
    })
    .unwrap();
    create_session(&daemon, proj.path());
    create_session(&daemon, proj.path());
    drop(daemon);

    let daemon2 = boot_daemon(state.path());
    let cause = daemon2.startup_cause();
    assert!(
        cause.abnormal_exit,
        "a state file left behind by an ungraceful exit must read as abnormal: {cause:?}"
    );
    assert_eq!(
        cause.session_count,
        Some(2),
        "must carry the real session count from the last write: {cause:?}"
    );
    let runtime = cause
        .runtime_ms
        .expect("a plausible runtime must be present");
    assert!(
        runtime < 60_000,
        "runtime must be a plausible (small, test-scale) duration, got {runtime}ms"
    );
    let recovery = daemon2.recovery_summary().expect("husks present");
    assert!(
        recovery.crashed,
        "must still defer as a crash: {recovery:?}"
    );
}

#[test]
fn expected_restart_is_not_an_abnormal_exit() {
    let _env = ENV_LOCK.lock().unwrap();
    std::env::set_var("SHELL", "/bin/sh");
    let state = tempfile::tempdir().unwrap();
    let proj = tempfile::tempdir().unwrap();
    let daemon = Daemon::new(DaemonConfig {
        token: TOKEN.to_string(),
        db_path: state.path().join("test.db"),
    })
    .unwrap();
    create_session(&daemon, proj.path());
    daemon.expect_restart();
    drop(daemon);

    let daemon2 = boot_daemon(state.path());
    let cause = daemon2.startup_cause();
    assert!(
        !cause.abnormal_exit,
        "expect_restart() must suppress the abnormal-exit verdict: {cause:?}"
    );
    assert!(cause.expected_restart, "must echo the flag: {cause:?}");
    assert_eq!(cause.session_count, Some(1));
    let recovery = daemon2.recovery_summary().expect("husk present");
    assert!(
        !recovery.crashed,
        "an expected restart must not defer husks as a crash: {recovery:?}"
    );
}

#[test]
fn old_empty_marker_file_reads_as_clean_cause_unknown() {
    let state = tempfile::tempdir().unwrap();
    let proj = tempfile::tempdir().unwrap();
    seed_husk(state.path(), proj.path());
    std::fs::write(state.path().join("clean-shutdown"), b"").unwrap();

    let daemon = boot_daemon(state.path());
    let cause = daemon.startup_cause();
    assert!(
        !cause.abnormal_exit,
        "an old-format empty marker must read as clean: {cause:?}"
    );
    assert_eq!(cause.session_count, None, "no data to recover: {cause:?}");
    assert_eq!(cause.runtime_ms, None);
    let recovery = daemon.recovery_summary().expect("husk present");
    assert!(
        !recovery.crashed,
        "upgrading over an old empty marker must never report a crash: {recovery:?}"
    );
}

#[test]
fn corrupt_run_state_detail_never_changes_the_verdict() {
    let cases: &[(&str, &[u8])] = &[
        ("garbage bytes", b"not json at all"),
        ("truncated JSON", b"{\"schema_version\":1,\"started_at\":123"),
        (
            "unsupported schema_version",
            br#"{"schema_version":999,"started_at":1,"last_seen_at":2,"session_count":1,"swarm_count":0,"expected_restart":false}"#,
        ),
    ];
    for (label, bytes) in cases {
        for marker_present in [true, false] {
            let state = tempfile::tempdir().unwrap();
            let proj = tempfile::tempdir().unwrap();
            seed_husk(state.path(), proj.path());
            std::fs::write(state.path().join("run-state.json"), bytes).unwrap();
            if marker_present {
                std::fs::write(state.path().join("clean-shutdown"), b"").unwrap();
            }

            let daemon = boot_daemon(state.path());
            let cause = daemon.startup_cause();
            assert_eq!(
                cause.abnormal_exit, !marker_present,
                "{label} (marker present={marker_present}): a corrupt run-state.json must \
                 never move the verdict off the marker's presence: {cause:?}"
            );
            assert_eq!(
                cause.session_count, None,
                "{label}: corrupt detail must read back as no detail: {cause:?}"
            );
            assert_eq!(cause.runtime_ms, None);
            let recovery = daemon.recovery_summary().expect("husk present");
            assert_eq!(
                recovery.crashed, !marker_present,
                "{label} (marker present={marker_present}): recovery.crashed must follow the \
                 marker alone: {recovery:?}"
            );
        }
    }
}

#[test]
fn heartbeat_after_persist_all_does_not_turn_a_clean_shutdown_into_a_crash() {
    let _env = ENV_LOCK.lock().unwrap();
    std::env::set_var("SHELL", "/bin/sh");
    let state = tempfile::tempdir().unwrap();
    let proj = tempfile::tempdir().unwrap();
    let daemon = Daemon::new(DaemonConfig {
        token: TOKEN.to_string(),
        db_path: state.path().join("test.db"),
    })
    .unwrap();
    create_session(&daemon, proj.path());
    daemon.persist_all();
    daemon.write_run_state_for_test();
    drop(daemon);

    let daemon2 = boot_daemon(state.path());
    let cause = daemon2.startup_cause();
    assert!(
        !cause.abnormal_exit,
        "a heartbeat write racing after persist_all's clean marker must not read as a crash: \
         {cause:?}"
    );
    let recovery = daemon2.recovery_summary().expect("husk present");
    assert!(
        !recovery.crashed,
        "must not defer husks as a crash: {recovery:?}"
    );
}

#[test]
fn missing_state_file_still_reports_abnormal_exit_cause_unknown() {
    let state = tempfile::tempdir().unwrap();
    let proj = tempfile::tempdir().unwrap();
    seed_husk(state.path(), proj.path());

    let daemon = boot_daemon(state.path());
    let cause = daemon.startup_cause();
    assert!(
        cause.abnormal_exit,
        "absence must still read as a crash: {cause:?}"
    );
    assert_eq!(cause.session_count, None, "nothing to read: {cause:?}");
    let recovery = daemon.recovery_summary().expect("husk present");
    assert!(recovery.crashed);
}
