use crate::common;

use common::*;
use houston_core::daemon::{CreateParams, Daemon, DaemonConfig};
use houston_protocol as proto;
use std::sync::Arc;

#[cfg(windows)]
fn print_then_idle(marker: &str) -> Vec<String> {
    [
        "cmd",
        "/C",
        &format!("echo {marker} & ping -n 61 127.0.0.1 > nul"),
    ]
    .map(String::from)
    .to_vec()
}

#[cfg(not(windows))]
fn print_then_idle(marker: &str) -> Vec<String> {
    ["sh", "-c", &format!("echo {marker}; sleep 60")]
        .map(String::from)
        .to_vec()
}

fn boot(db_path: &std::path::Path) -> Arc<Daemon> {
    Daemon::new(DaemonConfig::new(
        TOKEN.to_string(),
        db_path.to_path_buf(),
        common::base_env().with("HOUSTON_SAFE_MODE", Some("1")),
    ))
    .unwrap()
}

/// Runs a pane that prints `marker`, applies `before_crash`, then drops the daemon
/// without `persist_all` — no clean-shutdown marker, as after a kill — and returns
/// the restored husk's replay from a fresh daemon on the same state.
async fn crash_and_restore(marker: &str, before_crash: impl FnOnce(&Arc<Daemon>)) -> String {
    let state_dir = tempfile::tempdir().unwrap();
    let db_path = state_dir.path().join("test.db");
    let project = tempfile::tempdir().unwrap();

    let id = {
        let daemon = boot(&db_path);
        let mut rx = daemon.observe();
        let id = daemon
            .create_session(CreateParams {
                agent: proto::AgentKind::Custom,
                project_dir: project.path().to_path_buf(),
                cmd: Some(print_then_idle(marker)),
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
        collect_broadcast_until(&mut rx, id, marker).await;
        before_crash(&daemon);
        id
    };

    rusqlite::Connection::open(&db_path)
        .unwrap()
        .execute("UPDATE sessions SET agent = 'shell' WHERE id = ?1", [id])
        .unwrap();
    let daemon = boot(&db_path);
    assert!(
        daemon.startup_cause().abnormal_exit,
        "the restart must read as a crash: {:?}",
        daemon.startup_cause()
    );
    let husk = daemon
        .list()
        .into_iter()
        .find(|s| s.id == id)
        .expect("husk restored");
    assert_eq!(husk.state, proto::SessionState::Interrupted);
    String::from_utf8_lossy(&daemon.scrollback(id, None).unwrap().data).into_owned()
}

#[tokio::test]
async fn a_crash_after_a_periodic_checkpoint_restores_the_pane_scrollback() {
    let replay = crash_and_restore("periodic-ckpt-marker", |daemon| {
        assert_eq!(
            daemon.checkpoint_dirty_scrollback(),
            1,
            "a pane with output is written"
        );
        assert_eq!(
            daemon.checkpoint_dirty_scrollback(),
            0,
            "a pane with no output since its last checkpoint is not rewritten"
        );
    })
    .await;
    assert!(
        replay.contains("periodic-ckpt-marker"),
        "the husk replays the checkpointed scrollback: {replay:?}"
    );
}

#[tokio::test]
async fn a_crash_before_any_checkpoint_restores_no_scrollback() {
    let replay = crash_and_restore("unsaved-ckpt-marker", |_| {}).await;
    assert!(
        !replay.contains("unsaved-ckpt-marker"),
        "without a checkpoint the crash loses the output: {replay:?}"
    );
}
