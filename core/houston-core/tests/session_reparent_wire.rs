mod common;

use common::*;
use houston_core::daemon::{CreateParams, Daemon, DaemonConfig};
use houston_core::db::Db;
use houston_protocol as proto;

#[tokio::test]
async fn reparenting_a_live_session_updates_every_in_memory_reader() {
    let (_addr, _dir, daemon) = start_daemon_with_handle().await;

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

    let mut rx = daemon.observe();
    daemon
        .reparent_session(info.id, new_dir.path())
        .expect("reparent must succeed for a live, non-swarm session");

    loop {
        if let proto::ServerMsg::SessionReparented {
            session,
            project_dir,
        } = next_broadcast_control(&mut rx).await
        {
            assert_eq!(session, info.id);
            assert_eq!(project_dir, new_dir.path().display().to_string());
            break;
        }
    }

    let listed = daemon
        .list()
        .into_iter()
        .find(|s| s.id == info.id)
        .expect("session must still be listed");
    assert_eq!(listed.project_dir, new_dir.path().display().to_string());

    daemon
        .workspace_add(&old_dir.path().display().to_string())
        .unwrap();
    daemon
        .workspace_remove(&old_dir.path().display().to_string())
        .unwrap();
    assert!(
        daemon.list().iter().any(|s| s.id == info.id),
        "the session lives at new_dir now, so removing old_dir's workspace must not kill it"
    );
}

#[test]
fn reparenting_a_restored_husk_persists_and_survives_a_reopen() {
    let state = tempfile::tempdir().unwrap();
    let db_path = state.path().join("test.db");
    let old_dir = tempfile::tempdir().unwrap();
    let new_dir = tempfile::tempdir().unwrap();
    {
        let db = Db::open(&db_path).unwrap();
        db.insert_session(&proto::SessionInfo {
            id: 50,
            agent: proto::AgentKind::Shell,
            project_dir: old_dir.path().display().to_string(),
            cwd: old_dir.path().display().to_string(),
            state: proto::SessionState::Interrupted,
            title: "Husk-50".into(),
            codename: "Husk-50".into(),
            detected_agent: None,
            hidden: false,
            ssh_host: None,
            restore_deferred: None,
            status: None,
            context: None,
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

    let daemon = Daemon::new(DaemonConfig {
        token: TOKEN.to_string(),
        db_path: db_path.clone(),
    })
    .unwrap();

    daemon.reparent_session(50, new_dir.path()).unwrap();

    let listed = daemon
        .list()
        .into_iter()
        .find(|s| s.id == 50)
        .expect("husk must still be listed");
    assert_eq!(listed.project_dir, new_dir.path().display().to_string());

    drop(daemon);
    let reopened = Daemon::new(DaemonConfig {
        token: TOKEN.to_string(),
        db_path: db_path.clone(),
    })
    .unwrap();
    let restored = reopened
        .list()
        .into_iter()
        .find(|s| s.id == 50)
        .expect("husk must be restored from the DB by a fresh daemon");
    assert_eq!(
        restored.project_dir,
        new_dir.path().display().to_string(),
        "sessions.project_dir must be persisted, not only mutated in memory"
    );
}

#[test]
fn reparent_refuses_a_swarm_tied_session() {
    let state = tempfile::tempdir().unwrap();
    let db_path = state.path().join("test.db");
    let new_dir = tempfile::tempdir().unwrap();
    let agent_id = {
        let db = Db::open(&db_path).unwrap();
        db.insert_session(&proto::SessionInfo {
            id: 1,
            agent: proto::AgentKind::Shell,
            project_dir: "/tmp".into(),
            cwd: "/tmp".into(),
            state: proto::SessionState::Interrupted,
            title: "Husk".into(),
            codename: "Husk".into(),
            detected_agent: None,
            hidden: false,
            ssh_host: None,
            restore_deferred: None,
            status: None,
            context: None,
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
        let roster = vec![proto::SwarmRosterEntry {
            label: "Coordinator".into(),
            role: proto::SwarmRole::Coordinator,
            agent: proto::AgentKind::Claude,
            auto_approve: true,
            plan_mode: false,
            model: None,
            custom_prompt: None,
            cmd: None,
        }];
        let (_swarm, agents) = db.swarm_create("S1", "/tmp/r", "g", &roster, 0).unwrap();
        db.swarm_agent_bind_session(agents[0].id, None, Some(1))
            .unwrap();
        agents[0].id
    };

    let daemon = Daemon::new(DaemonConfig {
        token: "test-token".into(),
        db_path,
    })
    .unwrap();

    let err = daemon
        .reparent_session(1, new_dir.path())
        .unwrap_err()
        .to_string();
    assert!(
        err.contains("session 1"),
        "error should name the session id: {err}"
    );
    assert!(
        err.contains(&format!("swarm agent {agent_id}")),
        "error should name the swarm agent id: {err}"
    );
    assert!(
        err.contains("cannot be reparented"),
        "error should name why this session is refused: {err}"
    );
}

#[tokio::test]
async fn reparent_refuses_a_target_that_is_not_a_directory() {
    let (_addr, _dir, daemon) = start_daemon_with_handle().await;
    let old_dir = tempfile::tempdir().unwrap();
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

    let bogus = old_dir.path().join("does-not-exist");
    let err = daemon
        .reparent_session(info.id, &bogus)
        .unwrap_err()
        .to_string();
    assert!(
        err.contains(&bogus.display().to_string()),
        "error must name the offending path: {err}"
    );
}

#[tokio::test]
async fn reparent_refuses_an_unknown_session_id() {
    let (_addr, _dir, daemon) = start_daemon_with_handle().await;
    let new_dir = tempfile::tempdir().unwrap();
    let err = daemon
        .reparent_session(999_999, new_dir.path())
        .unwrap_err()
        .to_string();
    assert!(
        err.contains("999999"),
        "error must name the offending session id: {err}"
    );
}
