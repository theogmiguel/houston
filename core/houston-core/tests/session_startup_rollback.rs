#![cfg(all(target_os = "linux", feature = "test-barriers"))]

mod common;

use houston_core::daemon::{CreateParams, Daemon, DaemonConfig, RespawnConversation};
use houston_protocol as proto;
use std::{
    path::Path,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

fn parameters(project: &Path, shell: bool) -> CreateParams {
    CreateParams {
        agent: if shell {
            proto::AgentKind::Shell
        } else {
            proto::AgentKind::Codex
        },
        project_dir: project.to_path_buf(),
        cmd: (!shell).then(|| {
            vec![
                "/bin/sh".into(),
                project.join("fixture").display().to_string(),
            ]
        }),
        cols: 80,
        rows: 24,
        cwd_from: None,
        shell_integration: shell,
        auto_approve: false,
        acp: None,
        profile: None,
        prompt: None,
        model: None,
        effort: None,
    }
}

fn observe(
    daemon: &Arc<Daemon>,
    project: &Path,
    fault: Option<&'static str>,
) -> Arc<Mutex<Vec<(u32, u32)>>> {
    let receipts = Arc::new(Mutex::new(Vec::new()));
    let output = Arc::clone(&receipts);
    let project = project.to_path_buf();
    daemon.set_startup_test(
        fault,
        Box::new(move |id, pid| {
            output.lock().unwrap().push((id, pid));
            let receipt = project.join(format!("receipt-{id}"));
            let deadline = Instant::now() + Duration::from_secs(5);
            loop {
                if let Ok(body) = std::fs::read_to_string(&receipt) {
                    assert_eq!(
                        body.trim().parse::<u32>().unwrap(),
                        pid,
                        "fixture must report the exact owned process"
                    );
                    break;
                }
                assert!(
                    Instant::now() < deadline,
                    "fixture never reached startup receipt for {id}/{pid}"
                );
                std::thread::sleep(Duration::from_millis(5));
            }
        }),
    );
    receipts
}

fn assert_reaped(pid: u32) {
    use nix::{
        sys::wait::{waitpid, WaitPidFlag},
        unistd::Pid,
    };
    assert!(
        !Path::new(&format!("/proc/{pid}")).exists(),
        "owned process {pid} survived failed startup"
    );
    assert_eq!(
        waitpid(
            Pid::from_raw(i32::try_from(pid).unwrap()),
            Some(WaitPidFlag::WNOHANG)
        ),
        Err(nix::errno::Errno::ECHILD),
        "owned process {pid} was not reaped"
    );
}

#[test]
fn startup_failures_are_owned_and_transactional() {
    if std::env::var_os("HOUSTON_STARTUP_FIXTURE").is_none() {
        let home = tempfile::tempdir().unwrap();
        let status = common::hermetic_command(std::env::current_exe().unwrap(), home.path())
            .args([
                "--exact",
                "startup_failures_are_owned_and_transactional",
                "--nocapture",
            ])
            .env("HOUSTON_STARTUP_FIXTURE", "1")
            .status()
            .unwrap();
        assert!(status.success());
        return;
    }
    // The driver runs with a temporary HOME and provider-refusal shims.
    use std::os::unix::fs::PermissionsExt;
    let project = tempfile::tempdir().unwrap();
    let script =
        "#!/bin/sh\nprintf '%s\\n' \"$$\" > \"$PWD/receipt-$HOUSTON_SESSION\"\nread ignored\n";
    std::fs::write(project.path().join("fixture"), script).unwrap();
    let shell = project.path().join("bash");
    std::fs::write(&shell, script).unwrap();
    std::fs::set_permissions(&shell, std::fs::Permissions::from_mode(0o700)).unwrap();
    std::env::set_var("SHELL", &shell);
    let state = tempfile::tempdir().unwrap();
    let database = state.path().join("test.db");
    let daemon = Daemon::new(DaemonConfig {
        token: "test-token".into(),
        db_path: database.clone(),
    })
    .unwrap();
    daemon.set_port(1); // Mint local credentials without running an MCP server.
    let conn = rusqlite::Connection::open(&database).unwrap();
    let baseline_receipts = observe(&daemon, project.path(), None);
    let baseline = daemon
        .create_session(parameters(project.path(), false))
        .unwrap();
    let baseline_pid = baseline_receipts.lock().unwrap()[0].1;
    let baseline_credentials = daemon.mcp_creds.len();
    let mut events = daemon.subscribe();
    for (fault, sql) in [
        (None, "CREATE TRIGGER startup_failure BEFORE INSERT ON sessions BEGIN SELECT RAISE(ABORT, 'injected insert failure'); END"),
        (None, "CREATE TRIGGER startup_failure BEFORE UPDATE OF profile_config_dir ON sessions BEGIN SELECT RAISE(ABORT, 'injected profile failure'); END"),
        (Some("after-spawn"), ""),
        (Some("reader-thread"), ""),
        (Some("wait-thread"), ""),
    ] {
        for shell in [false, true] {
            if !sql.is_empty() { conn.execute_batch(sql).unwrap(); }
            let receipts = observe(&daemon, project.path(), fault);
            assert!(daemon.create_session(parameters(project.path(), shell)).is_err());
            let (id, pid) = receipts.lock().unwrap()[0];
            assert_reaped(pid);
            assert!(daemon.session_cwd(id).is_err());
            assert!(!state.path().join(format!("shell-integration/sessions/{id}/token")).exists());
            assert!(!state.path().join(format!("hooks/pane-settings/{id}.json")).exists());
            while let Ok(event) = events.try_recv() {
                if let houston_core::daemon::Outbound::Control(body) = event {
                    assert!(!matches!(serde_json::from_str::<proto::ServerMsg>(&body).unwrap(), proto::ServerMsg::SessionCreated { .. }), "failed session was advertised");
                }
            }
            assert!(!daemon.list().iter().any(|session| session.id == id));
            assert_eq!(conn.query_row("SELECT COUNT(*) FROM sessions WHERE id = ?1", [id], |row| row.get::<_, u32>(0)).unwrap(), 0);
            assert_eq!(daemon.mcp_creds.len(), baseline_credentials);
            assert!(Path::new(&format!("/proc/{baseline_pid}")).exists(), "unrelated session was killed");
            if !sql.is_empty() { conn.execute_batch("DROP TRIGGER startup_failure").unwrap(); }
        }
    }
    // Orchestration uses a synthetic provider executable inside the isolated HOME.
    let shims = std::path::PathBuf::from(std::env::var_os("HOME").unwrap()).join("provider-shims");
    std::fs::write(shims.join("codex"), script).unwrap();
    daemon
        .workspace_add(project.path().to_str().unwrap())
        .unwrap();
    daemon.orchestration_set(true).unwrap();
    daemon.set_orchestration_caps(4, 2).unwrap();
    conn.execute_batch("CREATE TRIGGER startup_failure BEFORE UPDATE OF profile_config_dir ON sessions BEGIN SELECT RAISE(ABORT, 'orchestration profile failure'); END").unwrap();
    let receipts = observe(&daemon, project.path(), None);
    assert!(daemon
        .orchestrate_spawn(
            baseline.id,
            proto::AgentKind::Codex,
            None,
            None,
            houston_core::orchestrate::Brief::from("fixture task".to_string()),
            Some(false),
            None,
            Some("rollback-child".into())
        )
        .is_err());
    let (id, pid) = receipts.lock().unwrap()[0];
    assert_reaped(pid);
    assert!(daemon.session_cwd(id).is_err());
    assert!(daemon
        .open_delegations()
        .iter()
        .all(|row| row.child_session != id));
    assert_eq!(daemon.mcp_creds.len(), baseline_credentials);
    conn.execute_batch("DROP TRIGGER startup_failure").unwrap();
    // Hidden handoff generators use the same owned worker-startup rollback.
    for fault in ["reader-thread", "wait-thread"] {
        let receipts = observe(&daemon, project.path(), Some(fault));
        assert!(daemon
            .handoff_generate(
                baseline.id,
                proto::AgentKind::Custom,
                Some(vec![
                    "/bin/sh".into(),
                    project.path().join("fixture").display().to_string()
                ])
            )
            .is_err());
        let (id, pid) = receipts.lock().unwrap()[0];
        assert_reaped(pid);
        assert!(daemon.session_cwd(id).is_err());
        assert_eq!(
            conn.query_row("SELECT COUNT(*) FROM sessions WHERE id = ?1", [id], |row| {
                row.get::<_, u32>(0)
            })
            .unwrap(),
            0
        );
    }
    // A reused ID must leave the existing row intact and never start workers.
    let db = houston_core::db::Db::open(&database).unwrap();
    assert!(db
        .insert_session_for_startup(&baseline, "user", Some("/fixture-profile"), || panic!(
            "duplicate ID started workers"
        ))
        .is_err());
    assert_eq!(
        conn.query_row(
            "SELECT profile_config_dir FROM sessions WHERE id = ?1",
            [baseline.id],
            |row| row.get::<_, Option<String>>(0)
        )
        .unwrap(),
        None
    );
    let receipts = observe(&daemon, project.path(), Some("reader-handle"));
    assert!(daemon
        .create_session(parameters(project.path(), false))
        .is_err());
    assert!(
        receipts.lock().unwrap().is_empty(),
        "fallible handles must be prepared before spawn"
    );
    assert_eq!(daemon.mcp_creds.len(), baseline_credentials);

    // Respawn allocates a new ID; its failure must preserve the old durable pane.
    daemon.kill(baseline.id).unwrap();
    let before: String = conn
        .query_row(
            "SELECT state || ':' || title || ':' || codename FROM sessions WHERE id = ?1",
            [baseline.id],
            |row| row.get(0),
        )
        .unwrap();
    conn.execute_batch("CREATE TRIGGER startup_failure BEFORE INSERT ON sessions BEGIN SELECT RAISE(ABORT, 'respawn failure'); END").unwrap();
    let receipts = observe(&daemon, project.path(), None);
    assert!(daemon
        .respawn_with(
            baseline.id,
            false,
            None,
            None,
            false,
            RespawnConversation::Fresh
        )
        .is_err());
    let (_, pid) = receipts.lock().unwrap()[0];
    assert_reaped(pid);
    let after: String = conn
        .query_row(
            "SELECT state || ':' || title || ':' || codename FROM sessions WHERE id = ?1",
            [baseline.id],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(before, after);
    assert!(daemon
        .list()
        .iter()
        .any(|session| session.id == baseline.id));
    conn.execute_batch("DROP TRIGGER startup_failure").unwrap();
    daemon.close(baseline.id).unwrap();
}
