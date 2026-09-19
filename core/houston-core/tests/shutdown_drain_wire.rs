mod common;

use common::TOKEN;
use houston_core::daemon::{CreateParams, Daemon, DaemonConfig};
use houston_protocol as proto;
use std::sync::Arc;

static ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

fn daemon(state_dir: &std::path::Path) -> Arc<Daemon> {
    Daemon::new(DaemonConfig {
        token: TOKEN.to_string(),
        db_path: state_dir.join("test.db"),
    })
    .unwrap()
}

fn create_custom(d: &Arc<Daemon>, dir: &std::path::Path, cmd: Vec<&str>) -> u32 {
    d.create_session(CreateParams {
        agent: proto::AgentKind::Custom,
        project_dir: dir.to_path_buf(),
        cmd: Some(cmd.into_iter().map(String::from).collect()),
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
async fn a_session_ignoring_sighup_and_sigterm_is_reported_unterminated_with_no_marker() {
    let state = tempfile::tempdir().unwrap();
    let proj = tempfile::tempdir().unwrap();
    let d = daemon(state.path());
    let id = create_custom(
        &d,
        proj.path(),
        vec!["sh", "-c", "trap '' TERM HUP; sleep 100"],
    );
    tokio::time::sleep(std::time::Duration::from_millis(200)).await;

    d.reap_set_exit_hook_for_test(Box::new(|| {}));
    let result = {
        let _env = ENV_LOCK.lock().unwrap();
        std::env::set_var("HOUSTON_SHUTDOWN_DRAIN_MS", "200");
        let result = d.manage_shutdown();
        std::env::remove_var("HOUSTON_SHUTDOWN_DRAIN_MS");
        result
    };
    assert!(
        result.is_err(),
        "a session that never confirms exit must not read as a successful stop"
    );
    let failure = result.unwrap_err();
    assert_eq!(
        failure.unterminated,
        vec![id],
        "the response must name exactly the session that never confirmed exit"
    );
    assert!(
        failure.reason.contains("did not confirm exit"),
        "{}",
        failure.reason
    );
    assert!(
        !state.path().join("clean-shutdown").exists(),
        "a failed shutdown must never write the clean-shutdown marker"
    );
}

#[tokio::test]
async fn an_ordinary_session_confirms_exit_within_the_bound_and_the_marker_is_written() {
    let state = tempfile::tempdir().unwrap();
    let proj = tempfile::tempdir().unwrap();
    let d = daemon(state.path());
    let id = create_custom(&d, proj.path(), vec!["sh", "-c", "sleep 30"]);

    d.reap_set_exit_hook_for_test(Box::new(|| {}));
    let result = d.manage_shutdown();
    let ok = result.expect("an ordinary session must shut down cleanly");
    assert!(ok.ok);
    assert_eq!(ok.stopped_sessions, 1);
    let _ = id;
    assert!(
        state.path().join("clean-shutdown").exists(),
        "a successful shutdown must write the clean-shutdown marker"
    );
}
