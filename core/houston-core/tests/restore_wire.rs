#![cfg(unix)]

mod common;

use common::*;
use houston_core::daemon::{Daemon, DaemonConfig, SafeModeFlags};
use houston_core::db::Db;
use houston_protocol as proto;

static ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

fn env_lock() -> std::sync::MutexGuard<'static, ()> {
    ENV_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn seed(state_dir: &std::path::Path, dirs: &[&std::path::Path], clean: bool) {
    let db = Db::open(&state_dir.join("test.db")).unwrap();
    for (i, dir) in dirs.iter().enumerate() {
        db.insert_session(&proto::SessionInfo {
            id: (i + 1) as u32,
            agent: proto::AgentKind::Shell,
            project_dir: dir.display().to_string(),
            cwd: dir.display().to_string(),
            state: proto::SessionState::Running,
            title: format!("Husk-{}", i + 1),
            codename: format!("Husk-{}", i + 1),
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
    if clean {
        std::fs::write(state_dir.join("clean-shutdown"), b"").unwrap();
    }
}

fn seed_one(
    state_dir: &std::path::Path,
    id: u32,
    dir: &std::path::Path,
    agent: proto::AgentKind,
    spawned_by: Option<u32>,
) {
    let db = Db::open(&state_dir.join("test.db")).unwrap();
    db.insert_session(&proto::SessionInfo {
        id,
        agent,
        project_dir: dir.display().to_string(),
        cwd: dir.display().to_string(),
        state: proto::SessionState::Running,
        title: format!("Husk-{id}"),
        codename: format!("Husk-{id}"),
        detected_agent: None,
        hidden: false,
        ssh_host: None,
        restore_deferred: None,
        status: None,
        swarm_agent: None,
        spawned_by,
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

fn boot_and_list(
    state_dir: &std::path::Path,
) -> (Vec<proto::SessionInfo>, Option<proto::RecoverySummary>) {
    let daemon = Daemon::new(DaemonConfig {
        token: TOKEN.to_string(),
        db_path: state_dir.join("test.db"),
    })
    .unwrap();
    (daemon.list(), daemon.recovery_summary())
}

#[test]
fn clean_shutdown_respawns_within_budget_and_defers_the_rest() {
    let _env = env_lock();
    std::env::set_var("SHELL", "/bin/sh");
    std::env::set_var("HOUSTON_RESTORE_BUDGET", "2");
    std::env::remove_var("HOUSTON_SAFE_MODE");

    let state = tempfile::tempdir().unwrap();
    let p1 = tempfile::tempdir().unwrap();
    let p2 = tempfile::tempdir().unwrap();
    let p3 = tempfile::tempdir().unwrap();
    seed(state.path(), &[p1.path(), p2.path(), p3.path()], true);

    let (sessions, recovery) = boot_and_list(state.path());
    let running: Vec<_> = sessions
        .iter()
        .filter(|s| s.state == proto::SessionState::Running)
        .collect();
    let deferred: Vec<_> = sessions
        .iter()
        .filter(|s| s.restore_deferred.is_some())
        .collect();
    assert_eq!(running.len(), 2, "budget of 2: {sessions:?}");
    assert_eq!(deferred.len(), 1);
    assert_eq!(
        deferred[0].restore_deferred,
        Some(proto::RestoreReason::Budget)
    );
    assert!(
        deferred[0].title == "Husk-1",
        "oldest deferred: {deferred:?}"
    );
    let r = recovery.expect("recovery summary present");
    assert_eq!((r.respawned, r.deferred, r.crashed), (2, 1, false));
}

#[test]
fn crash_defers_everything() {
    let _env = env_lock();
    std::env::set_var("SHELL", "/bin/sh");
    std::env::remove_var("HOUSTON_SAFE_MODE");
    std::env::set_var("HOUSTON_RESTORE_BUDGET", "6");

    let state = tempfile::tempdir().unwrap();
    let p1 = tempfile::tempdir().unwrap();
    seed(state.path(), &[p1.path()], false);

    let (sessions, recovery) = boot_and_list(state.path());
    assert_eq!(sessions.len(), 1);
    assert_eq!(
        sessions[0].restore_deferred,
        Some(proto::RestoreReason::PreviousCrash)
    );
    assert_eq!(sessions[0].state, proto::SessionState::Interrupted);
    let r = recovery.expect("summary");
    assert!(r.crashed);
    assert_eq!(r.respawned, 0);
}

#[test]
fn invalid_cwd_is_deferred_not_respawned() {
    let _env = env_lock();
    std::env::set_var("SHELL", "/bin/sh");
    std::env::remove_var("HOUSTON_SAFE_MODE");
    std::env::set_var("HOUSTON_RESTORE_BUDGET", "6");

    let state = tempfile::tempdir().unwrap();
    let gone = tempfile::tempdir().unwrap();
    let gone_path = gone.path().to_path_buf();
    drop(gone);
    let db = Db::open(&state.path().join("test.db")).unwrap();
    db.insert_session(&proto::SessionInfo {
        id: 1,
        agent: proto::AgentKind::Shell,
        project_dir: gone_path.display().to_string(),
        cwd: gone_path.display().to_string(),
        state: proto::SessionState::Running,
        title: "Ghost".into(),
        codename: "Ghost".into(),
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
    drop(db);
    std::fs::write(state.path().join("clean-shutdown"), b"").unwrap();

    let (sessions, _) = boot_and_list(state.path());
    assert_eq!(
        sessions[0].restore_deferred,
        Some(proto::RestoreReason::InvalidCwd)
    );
}

#[cfg(unix)]
#[test]
fn spawn_failure_trips_the_circuit_breaker() {
    let _env = env_lock();
    std::env::set_var("SHELL", "/nonexistent/houston-test-shell");
    std::env::remove_var("HOUSTON_SAFE_MODE");
    std::env::set_var("HOUSTON_RESTORE_BUDGET", "6");

    let state = tempfile::tempdir().unwrap();
    let p1 = tempfile::tempdir().unwrap();
    let p2 = tempfile::tempdir().unwrap();
    seed(state.path(), &[p1.path(), p2.path()], true);

    let (sessions, recovery) = boot_and_list(state.path());
    assert_eq!(sessions.len(), 2, "both husks kept: {sessions:?}");
    let reasons: Vec<_> = sessions.iter().map(|s| s.restore_deferred).collect();
    assert_eq!(
        reasons
            .iter()
            .filter(|r| **r == Some(proto::RestoreReason::SpawnFailed))
            .count(),
        1,
        "exactly the attempted husk carries spawn-failed: {sessions:?}"
    );
    assert_eq!(
        reasons
            .iter()
            .filter(|r| **r == Some(proto::RestoreReason::CircuitBreaker))
            .count(),
        1,
        "the husk behind it was never attempted: {sessions:?}"
    );
    let r = recovery.expect("summary");
    assert_eq!((r.respawned, r.deferred), (0, 2));
}

#[test]
fn safe_mode_defers_everything() {
    let _env = env_lock();
    std::env::set_var("SHELL", "/bin/sh");
    std::env::set_var("HOUSTON_SAFE_MODE", "1");

    let state = tempfile::tempdir().unwrap();
    let p1 = tempfile::tempdir().unwrap();
    seed(state.path(), &[p1.path()], true);

    let (sessions, _) = boot_and_list(state.path());
    assert_eq!(
        sessions[0].restore_deferred,
        Some(proto::RestoreReason::SafeMode)
    );
    std::env::remove_var("HOUSTON_SAFE_MODE");
}

#[test]
fn choose_folder_respawn_overrides_the_cwd() {
    let _env = env_lock();
    std::env::set_var("SHELL", "/bin/sh");
    std::env::remove_var("HOUSTON_SAFE_MODE");
    std::env::set_var("HOUSTON_RESTORE_BUDGET", "0");

    let state = tempfile::tempdir().unwrap();
    let old_dir = tempfile::tempdir().unwrap();
    seed(state.path(), &[old_dir.path()], true);

    let daemon = Daemon::new(DaemonConfig {
        token: TOKEN.to_string(),
        db_path: state.path().join("test.db"),
    })
    .unwrap();

    let new_dir = tempfile::tempdir().unwrap();
    let fresh = daemon
        .respawn(1, false, Some(new_dir.path().to_path_buf()), None, false)
        .unwrap();
    assert_eq!(fresh.cwd, new_dir.path().display().to_string());

    let err = daemon
        .respawn(
            fresh.id,
            false,
            Some(std::path::PathBuf::from("/nonexistent/tr-choose")),
            None,
            false,
        )
        .unwrap_err()
        .to_string();
    assert!(err.contains("/nonexistent/tr-choose"), "{err}");
}

fn boot_and_list_with_flags(
    state_dir: &std::path::Path,
    flags: SafeModeFlags,
) -> (Vec<proto::SessionInfo>, Option<proto::RecoverySummary>) {
    let daemon = Daemon::new_with_safe_mode_flags_for_test(
        DaemonConfig {
            token: TOKEN.to_string(),
            db_path: state_dir.join("test.db"),
        },
        flags,
    )
    .unwrap();
    (daemon.list(), daemon.recovery_summary())
}

#[test]
fn disable_auto_restore_flag_alone_defers_everything() {
    let state = tempfile::tempdir().unwrap();
    let p1 = tempfile::tempdir().unwrap();
    seed(state.path(), &[p1.path()], true);

    let flags = SafeModeFlags {
        disable_auto_restore: true,
        ..Default::default()
    };
    let (sessions, recovery) = boot_and_list_with_flags(state.path(), flags);
    assert_eq!(
        sessions[0].restore_deferred,
        Some(proto::RestoreReason::SafeMode)
    );
    let r = recovery.expect("recovery summary present");
    assert_eq!((r.respawned, r.deferred, r.crashed), (0, 1, false));
}

#[test]
fn no_flags_set_runs_normal_restore_policy() {
    let state = tempfile::tempdir().unwrap();
    let gone = tempfile::tempdir().unwrap();
    let gone_path = gone.path().to_path_buf();
    drop(gone);

    let db = Db::open(&state.path().join("test.db")).unwrap();
    db.insert_session(&proto::SessionInfo {
        id: 1,
        agent: proto::AgentKind::Shell,
        project_dir: gone_path.display().to_string(),
        cwd: gone_path.display().to_string(),
        state: proto::SessionState::Running,
        title: "Ghost".into(),
        codename: "Ghost".into(),
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
    drop(db);
    std::fs::write(state.path().join("clean-shutdown"), b"").unwrap();

    let (sessions, _) = boot_and_list_with_flags(state.path(), SafeModeFlags::default());
    assert_eq!(
        sessions[0].restore_deferred,
        Some(proto::RestoreReason::InvalidCwd),
        "no flags set must reach the normal per-candidate checks, not the \
         safe-mode defer-everything branch: {:?}",
        sessions[0]
    );
}

#[cfg(unix)]
#[test]
fn restored_shell_pane_gets_the_mcp_credential() {
    use std::os::unix::fs::PermissionsExt;
    let _env = env_lock();
    let state_dir = tempfile::tempdir().unwrap();
    let project = tempfile::tempdir().unwrap();
    let dump = state_dir.path().join("env.txt");
    let shell = state_dir.path().join("dump-shell.sh");
    std::fs::write(
        &shell,
        format!("#!/bin/sh\nenv > '{}'\nsleep 30\n", dump.display()),
    )
    .unwrap();
    std::fs::set_permissions(&shell, std::fs::Permissions::from_mode(0o755)).unwrap();
    std::env::set_var("SHELL", &shell);
    std::env::remove_var("HOUSTON_RESTORE_BUDGET");
    std::env::remove_var("HOUSTON_SAFE_MODE");
    seed(state_dir.path(), &[project.path()], true);

    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let daemon = Daemon::new_bound(
        DaemonConfig {
            token: TOKEN.to_string(),
            db_path: state_dir.path().join("test.db"),
        },
        port,
    )
    .unwrap();
    let restored = daemon.list();
    assert_eq!(
        restored
            .iter()
            .filter(|s| s.state == proto::SessionState::Running)
            .count(),
        1,
        "sanity: the husk was respawned: {restored:?}"
    );

    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
    let env = loop {
        if let Ok(s) = std::fs::read_to_string(&dump) {
            if s.contains("HOUSTON_SESSION=") {
                break s;
            }
        }
        assert!(
            std::time::Instant::now() < deadline,
            "the respawned pane never dumped its environment to {}",
            dump.display()
        );
        std::thread::sleep(std::time::Duration::from_millis(50));
    };
    let expect_url = format!(
        "{}={}",
        houston_core::mcp_launch::URL_ENV,
        houston_core::mcp_launch::endpoint(port)
    );
    assert!(
        env.lines().any(|l| l == expect_url),
        "restored pane env lacks `{expect_url}` — the credential was minted before the port was known:\n{env}"
    );
    let token_prefix = format!("{}=", houston_core::mcp_launch::CODEX_TOKEN_ENV);
    assert!(
        env.lines()
            .any(|l| l.starts_with(&token_prefix) && l.len() > token_prefix.len()),
        "restored pane env lacks a non-empty `{token_prefix}`:\n{env}"
    );
}

#[test]
fn an_agent_husk_comes_back_live_and_never_as_a_corpse() {
    let _env = env_lock();
    std::env::set_var("SHELL", "/bin/sh");
    std::env::remove_var("HOUSTON_RESTORE_BUDGET");
    std::env::remove_var("HOUSTON_SAFE_MODE");

    let state = tempfile::tempdir().unwrap();
    let proj = tempfile::tempdir().unwrap();
    seed_one(state.path(), 1, proj.path(), proto::AgentKind::Claude, None);
    std::fs::write(state.path().join("clean-shutdown"), b"").unwrap();

    let (sessions, recovery) = boot_and_list(state.path());
    let husk = sessions
        .iter()
        .find(|s| s.agent == proto::AgentKind::Claude)
        .expect("the Claude pane is still in the roster");
    assert_eq!(
        husk.state,
        proto::SessionState::Running,
        "an agent pane must come back live, not Interrupted: {husk:?}"
    );
    assert_eq!(
        husk.restore_deferred, None,
        "nothing defers an agent husk any more: {husk:?}"
    );
    let r = recovery.expect("recovery summary present");
    assert_eq!((r.respawned, r.deferred, r.crashed), (1, 0, false));
}

#[test]
fn boot_closes_an_orchestrated_child_rather_than_leaving_a_husk() {
    let _env = env_lock();
    std::env::set_var("SHELL", "/bin/sh");
    std::env::remove_var("HOUSTON_RESTORE_BUDGET");
    std::env::remove_var("HOUSTON_SAFE_MODE");

    let state = tempfile::tempdir().unwrap();
    let proj = tempfile::tempdir().unwrap();
    seed_one(state.path(), 1, proj.path(), proto::AgentKind::Claude, None);
    seed_one(
        state.path(),
        2,
        proj.path(),
        proto::AgentKind::Claude,
        Some(1),
    );
    std::fs::write(state.path().join("clean-shutdown"), b"").unwrap();

    let (sessions, _) = boot_and_list(state.path());
    assert!(
        sessions.iter().all(|s| s.title != "Husk-2"),
        "the orchestrated child leaves the roster entirely: {sessions:?}"
    );
    let parent = sessions
        .iter()
        .find(|s| s.title == "Husk-1")
        .expect("parent listed");
    assert_eq!(
        parent.state,
        proto::SessionState::Running,
        "and its parent still comes back live: {parent:?}"
    );
}
