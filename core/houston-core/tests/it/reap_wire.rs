use crate::common;

use common::TOKEN;
use houston_core::daemon::{CreateParams, Daemon, DaemonConfig};
use houston_protocol as proto;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

fn daemon(state_dir: &std::path::Path) -> Arc<Daemon> {
    daemon_with(state_dir, &[])
}

fn daemon_with(state_dir: &std::path::Path, vars: &[(&str, &str)]) -> Arc<Daemon> {
    let env = vars
        .iter()
        .fold(common::capture_env(), |env, (k, v)| env.with(k, Some(*v)));
    Daemon::new(DaemonConfig::new(
        TOKEN.to_string(),
        state_dir.join("test.db"),
        env,
    ))
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
        model: None,
        effort: None,
    })
    .unwrap()
    .id
}

#[tokio::test]
async fn a_daemon_that_never_receives_a_client_arms_on_boot() {
    let state = tempfile::tempdir().unwrap();
    let d = daemon_with(state.path(), &[("SHELL", "/bin/sh")]);
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
    let d = daemon_with(state.path(), &[("SHELL", "/bin/sh")]);
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
    let state = tempfile::tempdir().unwrap();
    let d = daemon_with(state.path(), &[("HOUSTON_REAP_GRACE_MS", "999999")]);
    let (armed, deadline_ms) = d.reap_status();
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
    let d = daemon_with(state.path(), &[("HOUSTON_REAP_GRACE_MS", "30")]);

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

    let d = daemon_with(state.path(), &[("HOUSTON_REAP_GRACE_MS", "30")]);

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
    let state = tempfile::tempdir().unwrap();
    let proj = tempfile::tempdir().unwrap();
    let d = daemon_with(state.path(), &[("HOUSTON_REAP_GRACE_MS", "60")]);
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

#[tokio::test]
async fn failed_idle_shutdown_capture_does_not_exit_and_retries() {
    if common::process_var_os("HOUSTON_REAP_RETRY_FIXTURE").is_none() {
        let home = tempfile::tempdir().unwrap();
        let status = common::hermetic_command(std::env::current_exe().unwrap(), home.path())
            .args([
                "--exact",
                &common::exact_path(
                    module_path!(),
                    "failed_idle_shutdown_capture_does_not_exit_and_retries",
                ),
                "--nocapture",
            ])
            .env("HOUSTON_REAP_RETRY_FIXTURE", "1")
            .env("HOUSTON_REAP_GRACE_MS", "100")
            .status()
            .unwrap();
        assert!(status.success());
        return;
    }
    let state = tempfile::tempdir().unwrap();
    let d = daemon(state.path());
    let initial_deadline = d.reap_status().1;
    let marker = state.path().join("clean-shutdown");
    std::fs::create_dir(&marker).unwrap();
    let fired = Arc::new(AtomicBool::new(false));
    let reported = Arc::clone(&fired);
    d.reap_set_exit_hook_for_test(Box::new(move || reported.store(true, Ordering::SeqCst)));
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        while !fired.load(Ordering::SeqCst) && d.reap_status().1 == initial_deadline {
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("first idle shutdown attempt");
    assert!(
        !fired.load(Ordering::SeqCst),
        "failed marker write must not exit as clean"
    );
    assert!(
        !d.is_shutting_down(),
        "failed capture must reopen admission"
    );
    std::fs::remove_dir(marker).unwrap();
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        while !fired.load(Ordering::SeqCst) {
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("idle shutdown must retry after a transient capture failure");
}
