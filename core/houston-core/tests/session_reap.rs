use houston_core::daemon::{CreateParams, Daemon, DaemonConfig};
use houston_protocol as proto;
use std::path::Path;
use std::sync::Arc;

fn daemon(state_dir: &Path) -> Arc<Daemon> {
    Daemon::new(DaemonConfig {
        token: "test-token".to_string(),
        db_path: state_dir.join("test.db"),
    })
    .unwrap()
}

fn spawn_quiet(daemon: &Arc<Daemon>, dir: &Path) -> proto::SessionInfo {
    let info = daemon
        .create_session(CreateParams {
            agent: proto::AgentKind::Codex,
            project_dir: dir.to_path_buf(),
            cmd: Some(vec!["sleep".to_string(), "600".to_string()]),
            cols: 80,
            rows: 24,
            cwd_from: None,
            shell_integration: false,
            auto_approve: false,
            acp: None,
            profile: None,
            prompt: None,
        })
        .unwrap();
    assert_eq!(
        daemon.handle_hook_from(
            info.id,
            proto::AgentKind::Codex,
            "SessionStart",
            dir.to_str(),
        ),
        houston_core::hook_drop::DropVerdict::Applied,
    );
    info
}

fn poll<F: FnMut() -> bool>(what: &str, mut cond: F) {
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
    while !cond() {
        assert!(
            std::time::Instant::now() < deadline,
            "timed out waiting for: {what}"
        );
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
}

const LONG_AGO: u64 = 60 * 60 * 1000;

#[test]
fn reaps_only_when_the_session_is_hidden_on_every_connection() {
    let state = tempfile::tempdir().unwrap();
    let dir = tempfile::tempdir().unwrap();
    let d = daemon(state.path());
    let info = spawn_quiet(&d, dir.path());

    assert!(
        d.session_reap_candidates(0, LONG_AGO).is_empty(),
        "no connections means nothing is reapable"
    );

    let a = d.conn_register();
    let b = d.conn_register();

    assert!(d.session_reap_candidates(0, LONG_AGO).is_empty());

    d.conn_set_visibility(a, info.id, false);
    assert!(
        d.session_reap_candidates(0, LONG_AGO).is_empty(),
        "hidden on one connection is not hidden"
    );

    d.conn_set_visibility(b, info.id, false);
    poll("the quiet session becomes reapable", || {
        d.session_reap_candidates(0, LONG_AGO) == vec![info.id]
    });

    d.conn_set_visibility(a, info.id, true);
    assert!(d.session_reap_candidates(0, LONG_AGO).is_empty());

    d.close(info.id).unwrap();
}

#[test]
fn a_dropped_connection_stops_voting() {
    let state = tempfile::tempdir().unwrap();
    let dir = tempfile::tempdir().unwrap();
    let d = daemon(state.path());
    let info = spawn_quiet(&d, dir.path());

    let live = d.conn_register();
    let gone = d.conn_register();
    d.conn_set_visibility(gone, info.id, false);

    assert!(d.session_reap_candidates(0, LONG_AGO).is_empty());

    d.conn_set_visibility(live, info.id, false);
    poll("reapable once hidden everywhere", || {
        d.session_reap_candidates(0, LONG_AGO) == vec![info.id]
    });

    d.conn_forget(gone);
    assert_eq!(d.session_reap_candidates(0, LONG_AGO), vec![info.id]);

    d.conn_forget(live);
    assert!(
        d.session_reap_candidates(0, LONG_AGO).is_empty(),
        "with no connections left, nothing is reapable"
    );

    d.close(info.id).unwrap();
}

#[test]
fn never_reaps_a_session_that_is_still_doing_something() {
    let state = tempfile::tempdir().unwrap();
    let dir = tempfile::tempdir().unwrap();
    let d = daemon(state.path());

    let info = d
        .create_session(CreateParams {
            agent: proto::AgentKind::Codex,
            project_dir: dir.path().to_path_buf(),
            cmd: Some(vec![
                "sh".to_string(),
                "-c".to_string(),
                "sleep 600".to_string(),
            ]),
            cols: 80,
            rows: 24,
            cwd_from: None,
            shell_integration: false,
            auto_approve: false,
            acp: None,
            profile: None,
            prompt: None,
        })
        .unwrap();

    let conn = d.conn_register();
    d.conn_set_visibility(conn, info.id, false);

    poll("the pane really has a running child process", || {
        d.session_running_procs(&[info.id])
            .first()
            .and_then(|e| e.has_procs)
            .unwrap_or(false)
    });
    assert!(
        d.session_reap_candidates(0, LONG_AGO).is_empty(),
        "a session with a running child process is working, not idle"
    );

    d.close(info.id).unwrap();
}

#[test]
fn never_reaps_before_the_idle_window_has_actually_passed() {
    let state = tempfile::tempdir().unwrap();
    let dir = tempfile::tempdir().unwrap();
    let d = daemon(state.path());
    let info = spawn_quiet(&d, dir.path());
    let conn = d.conn_register();
    d.conn_set_visibility(conn, info.id, false);

    poll("reapable with a zero window", || {
        d.session_reap_candidates(0, LONG_AGO) == vec![info.id]
    });

    assert!(
        d.session_reap_candidates(15 * 60 * 1000, 0).is_empty(),
        "a session must be quiet for the WHOLE window before it is reapable"
    );

    d.close(info.id).unwrap();
}

#[test]
fn reaping_a_session_leaves_the_roster_through_the_real_close_path() {
    let state = tempfile::tempdir().unwrap();
    let dir = tempfile::tempdir().unwrap();
    let d = daemon(state.path());
    let info = spawn_quiet(&d, dir.path());
    let conn = d.conn_register();
    d.conn_set_visibility(conn, info.id, false);

    poll("reapable", || {
        d.session_reap_candidates(0, LONG_AGO) == vec![info.id]
    });

    d.close(info.id).unwrap();

    assert!(
        d.list().iter().all(|s| s.id != info.id),
        "the reaped session leaves the live roster"
    );
    assert!(
        d.session_reap_candidates(0, LONG_AGO).is_empty(),
        "and is not a candidate twice"
    );
}

#[test]
fn the_sweep_does_nothing_while_the_policy_is_off() {
    let state = tempfile::tempdir().unwrap();
    let dir = tempfile::tempdir().unwrap();
    let d = daemon(state.path());
    assert!(
        !d.session_policy().idle_reap_enabled,
        "reaping ships off by default"
    );

    let info = spawn_quiet(&d, dir.path());
    let conn = d.conn_register();
    d.conn_set_visibility(conn, info.id, false);
    poll("reapable by predicate", || {
        d.session_reap_candidates(0, LONG_AGO) == vec![info.id]
    });

    d.session_reap_sweep_for_test();
    assert!(
        d.list().iter().any(|s| s.id == info.id),
        "the sweep is inert while the policy is off"
    );

    d.session_policy_set(proto::SessionPolicy {
        idle_reap_enabled: true,
        idle_reap_minutes: 40_000,
    })
    .unwrap();
    d.session_reap_sweep_for_test();
    assert!(
        d.list().iter().any(|s| s.id == info.id),
        "a session younger than the configured delay survives"
    );

    d.close(info.id).unwrap();
}
