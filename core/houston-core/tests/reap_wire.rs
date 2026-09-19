mod common;

use common::TOKEN;
use houston_core::daemon::{CreateParams, Daemon, DaemonConfig};
use houston_protocol as proto;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

static GRACE_ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

fn daemon(state_dir: &std::path::Path) -> Arc<Daemon> {
    Daemon::new(DaemonConfig {
        token: TOKEN.to_string(),
        db_path: state_dir.join("test.db"),
    })
    .unwrap()
}

fn create_session(d: &Arc<Daemon>, dir: &std::path::Path) -> u32 {
    d.create_session(CreateParams {
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

#[tokio::test]
async fn a_daemon_that_never_receives_a_client_arms_on_boot() {
    let state = tempfile::tempdir().unwrap();
    std::env::set_var("SHELL", "/bin/sh");
    let d = daemon(state.path());
    let (armed, deadline) = d.reap_status();
    assert!(armed, "a never-connected boot must arm the reap task");
    assert!(deadline.is_some());
}

#[tokio::test]
async fn a_connected_client_holds_off_the_arm_and_the_last_forget_arms_it() {
    let state = tempfile::tempdir().unwrap();
    let d = daemon(state.path());
    let conn = d.conn_register();
    assert!(
        !d.reap_status().0,
        "a registered client must cancel the boot-time arm"
    );
    d.conn_forget(conn);
    assert!(
        d.reap_status().0,
        "the last client detaching must re-arm the reap task"
    );
}

#[tokio::test]
async fn reconnecting_cancels_an_armed_reap() {
    let state = tempfile::tempdir().unwrap();
    let d = daemon(state.path());
    assert!(d.reap_status().0, "never-connected boot arms");
    let _conn = d.conn_register();
    assert!(
        !d.reap_status().0,
        "a fresh connection must cancel the armed reap task"
    );
}

#[tokio::test]
async fn a_live_session_holds_off_the_arm_and_its_exit_arms_it() {
    let state = tempfile::tempdir().unwrap();
    let proj = tempfile::tempdir().unwrap();
    std::env::set_var("SHELL", "/bin/sh");
    let d = daemon(state.path());
    let id = create_session(&d, proj.path());
    assert!(
        !d.reap_status().0,
        "a live session must cancel the boot-time arm"
    );
    d.kill(id).expect("killing the session");
    assert!(
        d.reap_status().0,
        "the last live session ending must re-arm the reap task"
    );
}

#[tokio::test]
async fn an_enabled_routine_holds_off_the_arm_disabling_it_arms_the_reap() {
    let state = tempfile::tempdir().unwrap();
    let d = daemon(state.path());
    assert!(d.reap_status().0, "no routine yet: boot-time arm holds");

    d.routine_create_for_test(
        "keepalive",
        "noop",
        proto::Cadence::Interval { seconds: 86_400 },
        None,
        proto::AgentKind::Claude,
        None,
        None,
    )
    .unwrap();
    assert!(
        !d.reap_status().0,
        "an enabled routine must cancel the armed reap task"
    );

    let proto::ServerMsg::Routines { routines, .. } = d.routine_list() else {
        panic!("expected Routines");
    };
    let created = routines
        .iter()
        .find(|r| r.name == "keepalive")
        .expect("the routine just created");
    d.routine_update_for_test(
        created.id,
        &created.revision,
        None,
        None,
        None,
        Some(false),
        None,
        None,
        None,
    )
    .unwrap();
    assert!(
        d.reap_status().0,
        "disabling the only enabled routine must re-arm the reap task"
    );
}

#[tokio::test]
async fn the_reap_grace_override_changes_the_reported_deadline() {
    let _env = GRACE_ENV_LOCK.lock().unwrap();
    std::env::set_var("HOUSTON_REAP_GRACE_MS", "999999");
    let state = tempfile::tempdir().unwrap();
    let d = daemon(state.path());
    let (armed, deadline_ms) = d.reap_status();
    std::env::remove_var("HOUSTON_REAP_GRACE_MS");
    assert!(armed);
    let now = houston_core::daemon::now_unix_ms();
    let remaining = deadline_ms.unwrap() - now;
    assert!(
        remaining > 900_000,
        "the env override must reach the armed deadline, got {remaining}ms remaining"
    );
}

#[tokio::test]
async fn an_uncancelled_reap_actually_fires_after_its_grace() {
    let state = tempfile::tempdir().unwrap();
    let d = {
        let _env = GRACE_ENV_LOCK.lock().unwrap();
        std::env::set_var("HOUSTON_REAP_GRACE_MS", "30");
        let d = daemon(state.path());
        std::env::remove_var("HOUSTON_REAP_GRACE_MS");
        d
    };

    let fired = Arc::new(AtomicBool::new(false));
    {
        let fired = fired.clone();
        d.reap_set_exit_hook_for_test(Box::new(move || {
            fired.store(true, Ordering::SeqCst);
        }));
    }

    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(5);
    while !fired.load(Ordering::SeqCst) {
        assert!(
            tokio::time::Instant::now() < deadline,
            "the reap task never fired within its grace period"
        );
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
}

#[tokio::test]
async fn a_fired_reap_removes_the_discovery_files() {
    let state = tempfile::tempdir().unwrap();
    let daemon_json = state.path().join("daemon.json");
    let supervisor_json = state.path().join("supervisor.json");
    std::fs::write(&daemon_json, b"{}").unwrap();
    std::fs::write(&supervisor_json, b"{}").unwrap();

    let d = {
        let _env = GRACE_ENV_LOCK.lock().unwrap();
        std::env::set_var("HOUSTON_REAP_GRACE_MS", "30");
        let d = daemon(state.path());
        std::env::remove_var("HOUSTON_REAP_GRACE_MS");
        d
    };

    let fired = Arc::new(AtomicBool::new(false));
    {
        let fired = fired.clone();
        d.reap_set_exit_hook_for_test(Box::new(move || {
            fired.store(true, Ordering::SeqCst);
        }));
    }

    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(5);
    while !fired.load(Ordering::SeqCst) {
        assert!(
            tokio::time::Instant::now() < deadline,
            "the reap task never fired within its grace period"
        );
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }

    assert!(
        !daemon_json.exists(),
        "a fired reap must remove daemon.json, the same as an orderly stop"
    );
    assert!(
        !supervisor_json.exists(),
        "a fired reap must remove supervisor.json, the same as an orderly stop"
    );
    assert!(
        state.path().join("clean-shutdown").exists(),
        "a fired reap must still leave the clean-shutdown marker behind"
    );
}

#[tokio::test]
async fn a_spawn_racing_the_deadline_wins_and_the_reap_does_not_fire() {
    std::env::set_var("SHELL", "/bin/sh");
    let state = tempfile::tempdir().unwrap();
    let proj = tempfile::tempdir().unwrap();
    let d = {
        let _env = GRACE_ENV_LOCK.lock().unwrap();
        std::env::set_var("HOUSTON_REAP_GRACE_MS", "60");
        let d = daemon(state.path());
        std::env::remove_var("HOUSTON_REAP_GRACE_MS");
        d
    };
    assert!(
        d.reap_status().0,
        "never-connected boot arms with a 60ms deadline"
    );

    let fired = Arc::new(AtomicBool::new(false));
    {
        let fired = fired.clone();
        d.reap_set_exit_hook_for_test(Box::new(move || {
            fired.store(true, Ordering::SeqCst);
        }));
    }

    tokio::time::sleep(std::time::Duration::from_millis(45)).await;
    let id = create_session(&d, proj.path());

    tokio::time::sleep(std::time::Duration::from_millis(200)).await;
    assert!(
        !fired.load(Ordering::SeqCst),
        "a spawn racing the reap deadline must win: the daemon must not exit"
    );
    assert!(
        !d.reap_status().0,
        "the live session created by the spawn must leave the reap unarmed"
    );
    let _ = id;
}
