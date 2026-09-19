mod common;

use common::*;
use houston_core::daemon::CreateParams;
use houston_protocol as proto;

fn with_broken_sessions_table<T>(db_path: &std::path::Path, f: impl FnOnce() -> T) -> T {
    let conn = rusqlite::Connection::open(db_path).expect("second handle on the test DB");
    conn.execute_batch("ALTER TABLE sessions RENAME TO sessions_hidden_by_test")
        .expect("hiding the sessions table");
    let out = f();
    conn.execute_batch("ALTER TABLE sessions_hidden_by_test RENAME TO sessions")
        .expect("restoring the sessions table");
    out
}

#[tokio::test]
async fn a_failed_rename_write_leaves_the_in_memory_title_alone() {
    let (_addr, state_dir, daemon) = start_daemon_with_handle().await;
    let project = tempfile::tempdir().unwrap();
    let info = daemon
        .create_session(CreateParams {
            agent: proto::AgentKind::Shell,
            project_dir: project.path().to_path_buf(),
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
        .unwrap();
    let original = daemon
        .list()
        .into_iter()
        .find(|s| s.id == info.id)
        .expect("session must be listed")
        .title;

    let err = with_broken_sessions_table(&state_dir.path().join("test.db"), || {
        daemon
            .rename(info.id, "a-title-that-must-not-stick")
            .expect_err("the DB write must fail while the table is hidden")
    });
    assert!(
        format!("{err:#}").contains("sessions"),
        "the error must name what failed, got {err:#}"
    );

    let after = daemon
        .list()
        .into_iter()
        .find(|s| s.id == info.id)
        .expect("session must still be listed")
        .title;
    assert_eq!(
        after, original,
        "a rename whose row never landed must not be visible in memory either — \
         that split is what a restart used to resolve silently"
    );
}

#[tokio::test]
async fn a_failed_reparent_write_leaves_the_in_memory_project_dir_alone() {
    let (_addr, state_dir, daemon) = start_daemon_with_handle().await;
    let old_dir = tempfile::tempdir().unwrap();
    let new_dir = tempfile::tempdir().unwrap();
    let info = daemon
        .create_session(CreateParams {
            agent: proto::AgentKind::Shell,
            project_dir: old_dir.path().to_path_buf(),
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
        .unwrap();

    let err = with_broken_sessions_table(&state_dir.path().join("test.db"), || {
        daemon
            .reparent_session(info.id, new_dir.path())
            .expect_err("the DB write must fail while the table is hidden")
    });
    assert!(
        format!("{err:#}").contains("sessions"),
        "the error must name what failed, got {err:#}"
    );

    let listed = daemon
        .list()
        .into_iter()
        .find(|s| s.id == info.id)
        .expect("session must still be listed");
    assert_eq!(
        listed.project_dir,
        old_dir.path().display().to_string(),
        "list() must not report a move whose row never landed"
    );
    daemon
        .reparent_session(info.id, new_dir.path())
        .expect("a healthy DB must accept the same move");
    let moved = daemon
        .list()
        .into_iter()
        .find(|s| s.id == info.id)
        .expect("session must still be listed");
    assert_eq!(moved.project_dir, new_dir.path().display().to_string());
}
