#![cfg(unix)]

mod common;

use common::*;
use houston_core::daemon::{CreateParams, Daemon, DaemonConfig};
use houston_core::db::Db;
use houston_protocol as proto;
use std::path::PathBuf;
use std::sync::{Arc, OnceLock};

static SERIAL: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
static SHIM: OnceLock<PathBuf> = OnceLock::new();

fn shim_dir() -> PathBuf {
    SHIM.get_or_init(|| {
        let dir = tempfile::tempdir().expect("shim tempdir").keep();
        #[cfg(windows)]
        {
            let ps1 = "$ErrorActionPreference = 'Stop'\n\
                       while ($true) { Start-Sleep -Seconds 3600 }\n";
            std::fs::write(dir.join("claude.ps1"), ps1).unwrap();
            std::fs::write(
                dir.join("claude.cmd"),
                "@powershell -NoProfile -ExecutionPolicy Bypass -File \"%~dp0claude.ps1\" %*\r\n",
            )
            .unwrap();
        }
        #[cfg(unix)]
        {
            let path = dir.join("claude");
            std::fs::write(&path, "#!/bin/sh\nexec cat\n").unwrap();
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        let sep = if cfg!(windows) { ";" } else { ":" };
        let path_env = std::env::var("PATH").unwrap_or_default();
        std::env::set_var("PATH", format!("{}{sep}{path_env}", dir.display()));
        dir
    })
    .clone()
}

fn create_custom_session(daemon: &Arc<Daemon>, dir: &std::path::Path, cmd: Vec<&str>) -> u32 {
    daemon
        .create_session(CreateParams {
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

fn create_shell_session_no_integration(daemon: &Arc<Daemon>, dir: &std::path::Path) -> u32 {
    daemon
        .create_session(CreateParams {
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

fn boot_daemon(db_path: std::path::PathBuf) -> Arc<Daemon> {
    Daemon::new(DaemonConfig {
        token: TOKEN.to_string(),
        db_path,
    })
    .unwrap()
}

#[tokio::test]
async fn session_cwd_resolves_the_live_directory() {
    let _serial = SERIAL.lock().await;
    let state_dir = tempfile::tempdir().unwrap();
    let daemon = boot_daemon(state_dir.path().join("test.db"));
    let tmp = tempfile::tempdir().unwrap();

    let id = create_custom_session(&daemon, tmp.path(), vec!["sleep", "30"]);

    let cwd = daemon.session_cwd(id).unwrap();
    assert_eq!(
        std::fs::canonicalize(&cwd).unwrap(),
        std::fs::canonicalize(tmp.path()).unwrap()
    );

    let err = daemon.session_cwd(9999).unwrap_err().to_string();
    assert!(err.contains("9999"), "error must name the id: {err}");

    daemon.kill(id).ok();
}

#[tokio::test]
async fn reopen_with_shell_replaces_a_live_shell_session() {
    let _serial = SERIAL.lock().await;
    let state_dir = tempfile::tempdir().unwrap();
    let daemon = boot_daemon(state_dir.path().join("test.db"));
    let tmp = tempfile::tempdir().unwrap();

    let mut rx = daemon.observe();

    #[cfg(unix)]
    let fake = tmp.path().join("fakeshell");
    #[cfg(unix)]
    std::fs::write(&fake, "#!/bin/sh\necho REOPENED-WITH-OVERRIDE\nsleep 30\n").unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&fake, std::fs::Permissions::from_mode(0o755)).unwrap();
    }
    #[cfg(windows)]
    let fake = tmp.path().join("fakeshell.cmd");
    #[cfg(windows)]
    std::fs::write(
        &fake,
        "@echo off\r\necho REOPENED-WITH-OVERRIDE\r\nping -n 31 127.0.0.1 > nul\r\n",
    )
    .unwrap();

    let old_id = create_shell_session_no_integration(&daemon, tmp.path());

    let err = daemon
        .respawn(old_id, false, None, None, false)
        .unwrap_err()
        .to_string();
    assert!(err.contains("still running"), "{err}");

    let fresh = daemon
        .respawn(old_id, false, None, Some(fake.display().to_string()), false)
        .unwrap();
    assert_ne!(fresh.id, old_id);
    assert_eq!(fresh.agent, proto::AgentKind::Shell);
    collect_broadcast_until(&mut rx, fresh.id, "REOPENED-WITH-OVERRIDE").await;

    daemon.kill(fresh.id).ok();
}

#[tokio::test]
async fn shell_override_on_a_live_non_shell_session_refuses_without_killing() {
    let _serial = SERIAL.lock().await;
    let state_dir = tempfile::tempdir().unwrap();
    let daemon = boot_daemon(state_dir.path().join("test.db"));
    let tmp = tempfile::tempdir().unwrap();

    let agent_id = create_custom_session(&daemon, tmp.path(), vec!["sleep", "30"]);

    let err = daemon
        .respawn(agent_id, false, None, Some("/bin/sh".to_string()), false)
        .unwrap_err()
        .to_string();
    assert!(
        err.contains("only applies to shell sessions"),
        "wrong error: {err}"
    );

    let err = daemon
        .respawn(agent_id, false, None, None, false)
        .unwrap_err()
        .to_string();
    assert!(
        err.contains("still running"),
        "session must still be alive after the refused reopen: {err}"
    );

    daemon.kill(agent_id).ok();
}

#[tokio::test]
async fn shell_override_error_cases_fail_loud() {
    let _serial = SERIAL.lock().await;
    let state_dir = tempfile::tempdir().unwrap();
    let daemon = boot_daemon(state_dir.path().join("test.db"));
    let tmp = tempfile::tempdir().unwrap();

    let custom_id = create_custom_session(&daemon, tmp.path(), vec!["true"]);
    wait_for_state(&daemon, custom_id, proto::SessionState::Exited).await;
    let err = daemon
        .respawn(custom_id, false, None, Some("/bin/sh".to_string()), false)
        .unwrap_err()
        .to_string();
    assert!(
        err.contains("only applies to shell sessions"),
        "wrong error: {err}"
    );

    let shell_id = create_shell_session_no_integration(&daemon, tmp.path());
    daemon.kill(shell_id).ok();
    let err = daemon
        .respawn(
            shell_id,
            false,
            None,
            Some("/nonexistent/tr-fake-shell".to_string()),
            false,
        )
        .unwrap_err()
        .to_string();
    assert!(err.contains("/nonexistent/tr-fake-shell"), "{err}");

    let flat = tmp.path().join("notashell");
    std::fs::write(&flat, "data").unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&flat, std::fs::Permissions::from_mode(0o644)).unwrap();
        let err = daemon
            .respawn(
                shell_id,
                false,
                None,
                Some(flat.display().to_string()),
                false,
            )
            .unwrap_err()
            .to_string();
        assert!(err.contains("not executable"), "{err}");
    }
}

#[tokio::test]
async fn respawn_refuses_a_swarm_tied_session() {
    let _serial = SERIAL.lock().await;
    let state = tempfile::tempdir().unwrap();
    let db_path = state.path().join("test.db");
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
        .respawn(1, true, None, None, false)
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
        err.contains("not respawn"),
        "error should name the path not taken (swarm resume, not respawn): {err}"
    );
}

#[tokio::test]
async fn force_restarts_a_live_session_that_a_plain_respawn_refuses() {
    let _serial = SERIAL.lock().await;
    let state_dir = tempfile::tempdir().unwrap();
    let daemon = boot_daemon(state_dir.path().join("test.db"));
    let tmp = tempfile::tempdir().unwrap();

    let live_id = create_custom_session(&daemon, tmp.path(), vec!["sleep", "30"]);

    let err = daemon
        .respawn(live_id, false, None, None, false)
        .unwrap_err()
        .to_string();
    assert!(err.contains("still running"), "{err}");
    assert!(
        err.contains("force"),
        "the refusal must name the way through: {err}"
    );

    let fresh = daemon.respawn(live_id, false, None, None, true).unwrap();
    assert_ne!(fresh.id, live_id);
    assert_eq!(fresh.agent, proto::AgentKind::Custom);

    daemon.kill(fresh.id).ok();
}

#[tokio::test]
async fn a_long_opening_prompt_is_written_to_a_prompt_file() {
    let _serial = SERIAL.lock().await;
    shim_dir();
    let state_dir = tempfile::tempdir().unwrap();
    let daemon = boot_daemon(state_dir.path().join("test.db"));
    let tmp = tempfile::tempdir().unwrap();

    let prompt = "x".repeat(houston_core::launch::PROMPT_FILE_THRESHOLD + 1);
    let info = daemon
        .create_session(CreateParams {
            agent: proto::AgentKind::Claude,
            project_dir: tmp.path().to_path_buf(),
            cmd: None,
            cols: 80,
            rows: 24,
            cwd_from: None,
            shell_integration: false,
            auto_approve: false,
            acp: None,
            profile: None,
            prompt: Some(prompt.clone()),
        })
        .unwrap();

    let written = tmp
        .path()
        .join(".houston")
        .join("prompts")
        .join("prompt-session.md");
    assert!(written.is_file(), "no prompt file at {}", written.display());
    assert_eq!(std::fs::read_to_string(&written).unwrap(), prompt);
    assert_eq!(
        std::fs::read_to_string(
            tmp.path()
                .join(".houston")
                .join("prompts")
                .join(".gitignore")
        )
        .unwrap(),
        "*\n"
    );

    daemon.kill(info.id).ok();
}
