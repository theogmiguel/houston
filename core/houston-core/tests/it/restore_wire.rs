#![cfg(unix)]

use crate::common;

use common::*;
use houston_core::daemon::{Daemon, DaemonConfig, SafeModeFlags};
use houston_core::db::Db;
use houston_core::host_env::HostEnv;
use houston_protocol as proto;

fn seed(state_dir: &std::path::Path, dirs: &[&std::path::Path], clean: bool) {
    let db = Db::open(&state_dir.join("test.db")).unwrap();
    for (i, dir) in dirs.iter().enumerate() {
        db.insert_session(&proto::SessionInfo {
            title_source: Default::default(),
            checkout: None,
            activity: None,
            id: (i + 1) as u32,
            agent: proto::AgentKind::Shell,
            project_dir: dir.display().to_string(),
            cwd: dir.display().to_string(),
            state: proto::SessionState::Running,
            title: format!("Husk-{}", i + 1),
            codename: format!("Husk-{}", i + 1),
            detected_agent: None,
            running_agent: None,
            hidden: false,
            ssh_host: None,
            restore_deferred: None,
            status: None,
            status_since_ms: None,
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
            session_origin: None,
            checkout_root: None,
            worktree: None,
            resumable: false,
            resume_notice: None,
            compactions: None,
            task: None,
            sleep_notice: None,
            latest_prompt: None,
            last_agent_message: None,
            slept_at_ms: None,
            limit: None,
            view: Default::default(),
            permission_mode: None,
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
    session_origin: Option<u32>,
) {
    let db = Db::open(&state_dir.join("test.db")).unwrap();
    db.insert_session(&proto::SessionInfo {
        title_source: Default::default(),
        checkout: None,
        activity: None,
        id,
        agent,
        project_dir: dir.display().to_string(),
        cwd: dir.display().to_string(),
        state: proto::SessionState::Running,
        title: format!("Husk-{id}"),
        codename: format!("Husk-{id}"),
        detected_agent: None,
        running_agent: None,
        hidden: false,
        ssh_host: None,
        restore_deferred: None,
        status: None,
        status_since_ms: None,
        context: None,
        swarm_agent: None,
        spawned_by,
        acp: None,
        live_children: 0,
        profile_label: None,
        children_waiting: 0,
        delegation: None,
        inbox_unread: 0,
        tags: vec![],
        session_origin,
        checkout_root: None,
        worktree: None,
        resumable: false,
        resume_notice: None,
        compactions: None,
        task: None,
        sleep_notice: None,
        latest_prompt: None,
        last_agent_message: None,
        slept_at_ms: None,
        limit: None,
        view: Default::default(),
        permission_mode: None,
    })
    .unwrap();
}

fn boot_and_list(
    state_dir: &std::path::Path,
    env: &HostEnv,
) -> (Vec<proto::SessionInfo>, Option<proto::RecoverySummary>) {
    let daemon = Daemon::new(DaemonConfig::new(
        TOKEN.to_string(),
        state_dir.join("test.db"),
        env.clone(),
    ))
    .unwrap();
    (daemon.list(), daemon.recovery_summary())
}

struct OwnedRestoreDaemon(std::sync::Arc<Daemon>);
impl Drop for OwnedRestoreDaemon {
    fn drop(&mut self) {
        for session in self.0.list() {
            if self.0.list().iter().any(|live| live.id == session.id) {
                self.0
                    .close(session.id)
                    .expect("close the owned restore fixture");
            }
        }
    }
}

struct LiveClaude {
    _dir: tempfile::TempDir,
    path: std::ffi::OsString,
}
impl LiveClaude {
    fn new(env: &HostEnv) -> Self {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let executable = dir.path().join("claude");
        std::fs::write(
            &executable,
            "#!/bin/sh\nprintf 'RESTORE-CLAUDE-READY\\n'\nexec /bin/cat\n",
        )
        .unwrap();
        std::fs::set_permissions(executable, std::fs::Permissions::from_mode(0o700)).unwrap();
        let mut paths = vec![dir.path().to_path_buf()];
        if let Some(previous) = env.var_os("PATH") {
            paths.extend(std::env::split_paths(previous));
        }
        Self {
            _dir: dir,
            path: std::env::join_paths(paths).unwrap(),
        }
    }

    fn env(&self, env: &HostEnv) -> HostEnv {
        env.with("PATH", Some(&self.path))
    }
}

fn boot_owned_restore(state: &std::path::Path, env: &HostEnv) -> OwnedRestoreDaemon {
    let daemon = Daemon::new(DaemonConfig::new(
        TOKEN.to_string(),
        state.join("test.db"),
        env.clone(),
    ))
    .unwrap();
    let owned = OwnedRestoreDaemon(daemon);
    let daemon = &owned.0;
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(15);
    loop {
        if daemon.list().iter().any(|session| {
            daemon
                .session_screen_for_test(session.id)
                .iter()
                .any(|line| line.contains("RESTORE-CLAUDE-READY"))
        }) {
            return owned;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "owned Claude never became ready: {:?}",
            daemon.list()
        );
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
}

#[test]
fn a_refused_durable_close_keeps_the_restored_pane_retryable() {
    let state = tempfile::tempdir().unwrap();
    let project = tempfile::tempdir().unwrap();
    seed(state.path(), &[project.path()], true);
    let path = state.path().join("test.db");
    let daemon = Daemon::new_with_safe_mode_flags_for_test(
        DaemonConfig::new(TOKEN.to_string(), path.clone(), common::base_env()),
        SafeModeFlags {
            disable_auto_restore: true,
            ..Default::default()
        },
    )
    .unwrap();
    assert!(daemon.list().iter().any(|s| s.id == 1));
    let conn = rusqlite::Connection::open(&path).unwrap();
    conn.execute_batch(
        "CREATE TRIGGER refuse_close BEFORE UPDATE OF state ON sessions
         WHEN NEW.state = 'closed' BEGIN SELECT RAISE(ABORT, 'injected close failure'); END;",
    )
    .unwrap();
    assert!(daemon
        .close(1)
        .unwrap_err()
        .to_string()
        .contains("injected close failure"));
    assert!(
        daemon.list().iter().any(|s| s.id == 1),
        "a refused close must keep its retry target"
    );
    conn.execute_batch("DROP TRIGGER refuse_close;").unwrap();
    daemon.close(1).unwrap();
    assert!(!daemon.list().iter().any(|s| s.id == 1));
    drop(daemon);
    let reopened = Daemon::new_with_safe_mode_flags_for_test(
        DaemonConfig::new(TOKEN.to_string(), path, common::base_env()),
        SafeModeFlags {
            disable_auto_restore: true,
            ..Default::default()
        },
    )
    .unwrap();
    assert!(
        !reopened.list().iter().any(|s| s.id == 1),
        "a successful retry stays closed after restart"
    );
}

#[test]
fn clean_shutdown_respawns_within_budget_and_defers_the_rest() {
    let env = common::base_env()
        .with("SHELL", Some("/bin/sh"))
        .with("HOUSTON_RESTORE_BUDGET", Some("2"))
        .without("HOUSTON_SAFE_MODE");

    let state = tempfile::tempdir().unwrap();
    let p1 = tempfile::tempdir().unwrap();
    let p2 = tempfile::tempdir().unwrap();
    let p3 = tempfile::tempdir().unwrap();
    seed(state.path(), &[p1.path(), p2.path(), p3.path()], true);

    let (sessions, recovery) = boot_and_list(state.path(), &env);
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
fn crash_restores_with_the_same_budget_as_clean_shutdown() {
    let env = common::base_env()
        .with("SHELL", Some("/bin/sh"))
        .without("HOUSTON_SAFE_MODE")
        .with("HOUSTON_RESTORE_BUDGET", Some("6"));

    let state = tempfile::tempdir().unwrap();
    let p1 = tempfile::tempdir().unwrap();
    seed(state.path(), &[p1.path()], false);

    let (sessions, recovery) = boot_and_list(state.path(), &env);
    assert_eq!(sessions.len(), 1);
    assert_eq!(sessions[0].restore_deferred, None);
    assert_eq!(sessions[0].state, proto::SessionState::Running);
    assert_eq!(sessions[0].session_origin, Some(1));
    let r = recovery.expect("summary");
    assert!(r.crashed);
    assert_eq!((r.respawned, r.deferred), (1, 0));
}

#[test]
fn invalid_cwd_is_deferred_not_respawned() {
    let env = common::base_env()
        .with("SHELL", Some("/bin/sh"))
        .without("HOUSTON_SAFE_MODE")
        .with("HOUSTON_RESTORE_BUDGET", Some("6"));

    let state = tempfile::tempdir().unwrap();
    let gone = tempfile::tempdir().unwrap();
    let gone_path = gone.path().to_path_buf();
    drop(gone);
    let db = Db::open(&state.path().join("test.db")).unwrap();
    db.insert_session(&proto::SessionInfo {
        title_source: Default::default(),
        checkout: None,
        activity: None,
        id: 1,
        agent: proto::AgentKind::Shell,
        project_dir: gone_path.display().to_string(),
        cwd: gone_path.display().to_string(),
        state: proto::SessionState::Running,
        title: "Ghost".into(),
        codename: "Ghost".into(),
        detected_agent: None,
        running_agent: None,
        hidden: false,
        ssh_host: None,
        restore_deferred: None,
        status: None,
        status_since_ms: None,
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
        session_origin: None,
        checkout_root: None,
        worktree: None,
        resumable: false,
        resume_notice: None,
        compactions: None,
        task: None,
        sleep_notice: None,
        latest_prompt: None,
        last_agent_message: None,
        slept_at_ms: None,
        limit: None,
        view: Default::default(),
        permission_mode: None,
    })
    .unwrap();
    drop(db);
    std::fs::write(state.path().join("clean-shutdown"), b"").unwrap();

    let (sessions, _) = boot_and_list(state.path(), &env);
    assert_eq!(
        sessions[0].restore_deferred,
        Some(proto::RestoreReason::InvalidCwd)
    );
}

#[cfg(unix)]
#[test]
fn one_failed_respawn_defers_only_that_husk() {
    // No `claude` on this PATH: the Claude husk restores first and fails to launch.
    let env = common::base_env()
        .with("SHELL", Some("/bin/sh"))
        .with("PATH", Some("/usr/bin:/bin"))
        .without("HOUSTON_SAFE_MODE")
        .with("HOUSTON_RESTORE_BUDGET", Some("6"));

    let state = tempfile::tempdir().unwrap();
    let p1 = tempfile::tempdir().unwrap();
    let p2 = tempfile::tempdir().unwrap();
    let p3 = tempfile::tempdir().unwrap();
    seed_one(
        state.path(),
        1,
        p1.path(),
        proto::AgentKind::Shell,
        None,
        None,
    );
    seed_one(
        state.path(),
        2,
        p2.path(),
        proto::AgentKind::Claude,
        None,
        None,
    );
    seed_one(
        state.path(),
        3,
        p3.path(),
        proto::AgentKind::Shell,
        None,
        None,
    );
    std::fs::write(state.path().join("clean-shutdown"), b"").unwrap();

    let daemon = OwnedRestoreDaemon(
        Daemon::new(DaemonConfig::new(
            TOKEN.to_string(),
            state.path().join("test.db"),
            env,
        ))
        .unwrap(),
    );
    let sessions = daemon.0.list();
    let failed = sessions
        .iter()
        .find(|s| s.id == 2)
        .expect("the failed husk is kept");
    assert_eq!(
        failed.restore_deferred,
        Some(proto::RestoreReason::SpawnFailed)
    );
    for origin in [1, 3] {
        let restored = sessions
            .iter()
            .find(|s| s.session_origin == Some(origin) && s.id != origin)
            .unwrap_or_else(|| {
                panic!("husk {origin} must restore after a sibling failed: {sessions:?}")
            });
        assert_eq!(restored.state, proto::SessionState::Running);
    }
    let r = daemon.0.recovery_summary().expect("summary");
    assert_eq!((r.respawned, r.deferred), (2, 1));
}

#[test]
fn legacy_and_dead_uncontained_roots_restore_without_acknowledgement() {
    let env = common::base_env()
        .with("SHELL", Some("/bin/sh"))
        .without("HOUSTON_SAFE_MODE");
    let state = tempfile::tempdir().unwrap();
    let p1 = tempfile::tempdir().unwrap();
    let p2 = tempfile::tempdir().unwrap();
    seed_one(
        state.path(),
        1,
        p1.path(),
        proto::AgentKind::Shell,
        None,
        None,
    );
    seed_one(
        state.path(),
        2,
        p2.path(),
        proto::AgentKind::Shell,
        None,
        None,
    );
    let mut root = houston_core::spawn::command("sleep")
        .arg("600")
        .spawn()
        .unwrap();
    let receipt = houston_core::recovery_process::ProcessIdentity::capture(Some(root.id()))
        .unwrap()
        .unwrap();
    assert!(receipt.uncontained_reason().is_some());
    root.kill().unwrap();
    root.wait().unwrap();
    rusqlite::Connection::open(state.path().join("test.db"))
        .unwrap()
        .execute(
            "UPDATE sessions SET process_identity = ?1 WHERE id = 2",
            [serde_json::to_string(&receipt).unwrap()],
        )
        .unwrap();

    let daemon = OwnedRestoreDaemon(
        Daemon::new(DaemonConfig::new(
            TOKEN.to_string(),
            state.path().join("test.db"),
            env,
        ))
        .unwrap(),
    );
    let sessions = daemon.0.list();
    for origin in [1, 2] {
        let restored = sessions
            .iter()
            .find(|s| s.session_origin == Some(origin))
            .unwrap_or_else(|| panic!("husk {origin} missing: {sessions:?}"));
        assert_ne!(restored.id, origin, "husk {origin} was not restored");
        assert_eq!(restored.state, proto::SessionState::Running);
        assert_eq!(restored.restore_deferred, None);
        assert!(
            !restored
                .resume_notice
                .as_deref()
                .is_some_and(|notice| notice.contains("ownership")),
            "{:?}",
            restored.resume_notice
        );
    }
    let r = daemon.0.recovery_summary().expect("summary");
    assert_eq!((r.respawned, r.deferred), (2, 0));
}

#[test]
fn safe_mode_defers_everything() {
    let env = common::base_env()
        .with("SHELL", Some("/bin/sh"))
        .with("HOUSTON_SAFE_MODE", Some("1"));

    let state = tempfile::tempdir().unwrap();
    let p1 = tempfile::tempdir().unwrap();
    seed(state.path(), &[p1.path()], true);

    let (sessions, _) = boot_and_list(state.path(), &env);
    assert_eq!(
        sessions[0].restore_deferred,
        Some(proto::RestoreReason::SafeMode)
    );
}

#[test]
fn choose_folder_respawn_overrides_the_cwd() {
    let env = common::base_env()
        .with("SHELL", Some("/bin/sh"))
        .without("HOUSTON_SAFE_MODE")
        .with("HOUSTON_RESTORE_BUDGET", Some("0"));

    let state = tempfile::tempdir().unwrap();
    let old_dir = tempfile::tempdir().unwrap();
    seed(state.path(), &[old_dir.path()], true);

    let daemon = Daemon::new(DaemonConfig::new(
        TOKEN.to_string(),
        state.path().join("test.db"),
        env.clone(),
    ))
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
        DaemonConfig::new(
            TOKEN.to_string(),
            state_dir.join("test.db"),
            common::base_env(),
        ),
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
        title_source: Default::default(),
        checkout: None,
        activity: None,
        id: 1,
        agent: proto::AgentKind::Shell,
        project_dir: gone_path.display().to_string(),
        cwd: gone_path.display().to_string(),
        state: proto::SessionState::Running,
        title: "Ghost".into(),
        codename: "Ghost".into(),
        detected_agent: None,
        running_agent: None,
        hidden: false,
        ssh_host: None,
        restore_deferred: None,
        status: None,
        status_since_ms: None,
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
        session_origin: None,
        checkout_root: None,
        worktree: None,
        resumable: false,
        resume_notice: None,
        compactions: None,
        task: None,
        sleep_notice: None,
        latest_prompt: None,
        last_agent_message: None,
        slept_at_ms: None,
        limit: None,
        view: Default::default(),
        permission_mode: None,
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
    let shell_env = common::base_env().with("SHELL", Some(&shell));
    seed(state_dir.path(), &[project.path()], true);

    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let daemon = Daemon::new_bound(
        DaemonConfig::new(
            TOKEN.to_string(),
            state_dir.path().join("test.db"),
            shell_env,
        ),
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
    let env = common::base_env()
        .with("SHELL", Some("/bin/sh"))
        .without("HOUSTON_RESTORE_BUDGET")
        .without("HOUSTON_SAFE_MODE");

    let provider = LiveClaude::new(&env);
    let env = provider.env(&env);
    let state = tempfile::tempdir().unwrap();
    let proj = tempfile::tempdir().unwrap();
    seed_one(
        state.path(),
        1,
        proj.path(),
        proto::AgentKind::Claude,
        None,
        None,
    );
    std::fs::write(state.path().join("clean-shutdown"), b"").unwrap();

    let owned = boot_owned_restore(state.path(), &env);
    let sessions = owned.0.list();
    let recovery = owned.0.recovery_summary();
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
fn a_restored_session_keeps_its_original_identity() {
    let env = common::base_env()
        .with("SHELL", Some("/bin/sh"))
        .without("HOUSTON_RESTORE_BUDGET")
        .without("HOUSTON_SAFE_MODE");

    let state = tempfile::tempdir().unwrap();
    let proj = tempfile::tempdir().unwrap();
    seed_one(
        state.path(),
        7,
        proj.path(),
        proto::AgentKind::Shell,
        None,
        None,
    );
    std::fs::write(state.path().join("clean-shutdown"), b"").unwrap();

    let (sessions, _) = boot_and_list(state.path(), &env);
    let restored = sessions
        .iter()
        .find(|s| s.title == "Husk-7")
        .expect("the restored pane is listed");
    assert_ne!(restored.id, 7, "respawn mints a new id: {restored:?}");
    assert_eq!(
        restored.session_origin,
        Some(7),
        "a client needs the original id to keep the pane's grid slot: {restored:?}"
    );
}

#[test]
fn boot_defers_an_unresumable_child_when_its_parent_starts_fresh() {
    let env = common::base_env()
        .with("SHELL", Some("/bin/sh"))
        .without("HOUSTON_RESTORE_BUDGET")
        .without("HOUSTON_SAFE_MODE");

    let provider = LiveClaude::new(&env);
    let env = provider.env(&env);
    let state = tempfile::tempdir().unwrap();
    let proj = tempfile::tempdir().unwrap();
    seed_one(
        state.path(),
        1,
        proj.path(),
        proto::AgentKind::Claude,
        None,
        None,
    );
    seed_one(
        state.path(),
        2,
        proj.path(),
        proto::AgentKind::Claude,
        Some(1),
        None,
    );
    std::fs::write(state.path().join("clean-shutdown"), b"").unwrap();

    let owned = boot_owned_restore(state.path(), &env);
    let sessions = owned.0.list();
    let summary = owned.0.recovery_summary();
    let child = sessions
        .iter()
        .find(|s| s.title == "Husk-2")
        .expect("unresumable child kept");
    assert_eq!(child.state, proto::SessionState::Interrupted);
    assert_eq!(
        child.restore_deferred,
        Some(proto::RestoreReason::SpawnFailed)
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
    assert_eq!(child.spawned_by, Some(parent.id));
    assert_ne!(parent.id, 1);
    assert!(
        summary.unwrap().deferred > 0,
        "recovery reports the child that cannot resume"
    );
}
