mod common;

use common::TOKEN;
use houston_core::daemon::{CreateParams, Daemon, DaemonConfig};
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

#[test]
fn checkpoint_alone_does_not_mark_clean_so_a_later_crash_still_reads_abnormal() {
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
    daemon
        .checkpoint_scrollback()
        .expect("checkpoint must succeed against a real state dir");
    drop(daemon);

    let daemon2 = boot_daemon(state.path());
    let cause = daemon2.startup_cause();
    assert!(
        cause.abnormal_exit,
        "a checkpoint must never read as a clean shutdown on its own: {cause:?}"
    );
}

#[test]
fn mark_clean_shutdown_alone_reads_clean_on_the_next_boot() {
    let state = tempfile::tempdir().unwrap();
    let daemon = Daemon::new(DaemonConfig {
        token: TOKEN.to_string(),
        db_path: state.path().join("test.db"),
    })
    .unwrap();
    daemon
        .mark_clean_shutdown()
        .expect("marking clean shutdown must succeed against a real state dir");
    drop(daemon);

    let daemon2 = boot_daemon(state.path());
    let cause = daemon2.startup_cause();
    assert!(
        !cause.abnormal_exit,
        "mark_clean_shutdown alone must read as a clean shutdown: {cause:?}"
    );
}

#[test]
fn checkpoint_then_mark_clean_reads_clean_on_the_next_boot() {
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
    daemon.checkpoint_scrollback().unwrap();
    daemon.mark_clean_shutdown().unwrap();
    drop(daemon);

    let daemon2 = boot_daemon(state.path());
    let cause = daemon2.startup_cause();
    assert!(
        !cause.abnormal_exit,
        "checkpoint then mark_clean_shutdown must read as an orderly shutdown: {cause:?}"
    );
}

#[test]
fn checkpoint_failure_surfaces_as_an_error() {
    let _env = ENV_LOCK.lock().unwrap();
    std::env::set_var("SHELL", "/bin/sh");
    let state = tempfile::tempdir().unwrap();
    let proj = tempfile::tempdir().unwrap();
    let daemon = Daemon::new(DaemonConfig {
        token: TOKEN.to_string(),
        db_path: state.path().join("test.db"),
    })
    .unwrap();
    let _id = create_session(&daemon, proj.path());
    std::thread::sleep(std::time::Duration::from_millis(300));

    std::fs::remove_dir_all(state.path().join("scrollback"))
        .expect("removing the scrollback dir to force a write failure");

    let result = daemon.checkpoint_scrollback();
    assert!(
        result.is_err(),
        "a checkpoint that cannot write its ring must surface an error, not silently succeed"
    );
}
