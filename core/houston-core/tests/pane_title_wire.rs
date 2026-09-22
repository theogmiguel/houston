#![cfg(unix)]

mod common;

use houston_core::daemon::{CreateParams, Daemon, DaemonConfig};
use houston_core::db::Db;
use houston_core::orchestrate::Brief;
use houston_protocol as proto;
use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};

use common::{next_broadcast_control, start_daemon_with_handle};

static SHIMS: OnceLock<PathBuf> = OnceLock::new();

fn shim_dir() -> PathBuf {
    SHIMS
        .get_or_init(|| {
            let dir = tempfile::tempdir().expect("shim tempdir").keep();
            for (name, title) in [("claude", "◐ Reviewing the parser"), ("grok", "")] {
                let path = dir.join(name);
                std::fs::write(
                    &path,
                    format!("#!/bin/sh\nprintf '\\033]2;{title}\\007'\nstty -echo 2>/dev/null\nexec cat\n"),
                )
                .unwrap();
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
            }
            let path = std::env::var("PATH").unwrap_or_default();
            std::env::set_var("PATH", format!("{}:{path}", dir.display()));
            dir
        })
        .clone()
}

fn title_writer(dir: &Path, name: &str, title: &str) -> PathBuf {
    let path = dir.join(name);
    std::fs::write(
        &path,
        format!("#!/bin/sh\nprintf '\\033]2;{title}\\007'\nexec cat\n"),
    )
    .unwrap();
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
    path
}

fn burst_title_writer(dir: &Path, name: &str) -> PathBuf {
    let path = dir.join(name);
    std::fs::write(
        &path,
        "#!/bin/sh\nprintf '\\033]2;first\\007'\nsleep 0.1\nprintf '\\033]2;latest\\007'\nexec cat\n",
    )
    .unwrap();
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
    path
}

fn stored_session(id: u32, ws: &Path, title: &str) -> proto::SessionInfo {
    proto::SessionInfo {
        id,
        agent: proto::AgentKind::Claude,
        project_dir: ws.display().to_string(),
        cwd: ws.display().to_string(),
        state: proto::SessionState::Interrupted,
        title: title.to_string(),
        codename: title.to_string(),
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
    }
}

fn spawn(
    daemon: &Arc<Daemon>,
    ws: &Path,
    agent: proto::AgentKind,
    cmd: Option<Vec<String>>,
) -> proto::SessionInfo {
    daemon
        .create_session(CreateParams {
            agent,
            project_dir: ws.to_path_buf(),
            cmd,
            cols: 80,
            rows: 24,
            cwd_from: None,
            shell_integration: false,
            auto_approve: false,
            acp: None,
            profile: None,
            prompt: None,
        })
        .expect("the pane spawns")
}

fn title_of(daemon: &Arc<Daemon>, id: u32) -> String {
    daemon
        .list()
        .into_iter()
        .find(|s| s.id == id)
        .map(|s| s.title)
        .expect("the pane is on the roster")
}

async fn wait_until(what: &str, mut f: impl FnMut() -> bool) {
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(20);
    while std::time::Instant::now() < deadline {
        if f() {
            return;
        }
        tokio::time::sleep(std::time::Duration::from_millis(25)).await;
    }
    panic!("timed out waiting for {what}");
}

#[tokio::test]
async fn a_clis_own_window_title_becomes_the_panes_name_and_is_broadcast() {
    let (_addr, state, daemon) = start_daemon_with_handle().await;
    let ws = state.path().join("ws");
    std::fs::create_dir_all(&ws).unwrap();
    let exe = title_writer(state.path(), "titler", "Fixing the auth bug");

    let mut rx = daemon.observe();
    let info = spawn(
        &daemon,
        &ws,
        proto::AgentKind::Custom,
        Some(vec![
            "sh".into(),
            "-c".into(),
            "read -r release; exec \"$1\"".into(),
            "title-fixture".into(),
            exe.display().to_string(),
        ]),
    );
    assert_eq!(
        title_of(&daemon, info.id),
        info.title,
        "a codename until the CLI says otherwise"
    );
    daemon.write_stdin(info.id, b"continue\n").unwrap();

    let d = daemon.clone();
    let id = info.id;
    wait_until("the CLI's title to name the pane", move || {
        title_of(&d, id) == "Fixing the auth bug"
    })
    .await;

    loop {
        match next_broadcast_control(&mut rx).await {
            proto::ServerMsg::SessionRenamed { session, title } if session == id => {
                assert_eq!(title, "Fixing the auth bug");
                break;
            }
            _ => continue,
        }
    }

    daemon.kill(info.id).ok();
}

#[tokio::test]
async fn a_restored_prompt_named_pane_accepts_its_clis_title() {
    shim_dir();
    let state = tempfile::tempdir().unwrap();
    let ws = state.path().join("ws");
    std::fs::create_dir_all(&ws).unwrap();
    let db_path = state.path().join("test.db");
    let db = Db::open(&db_path).unwrap();
    db.insert_session(&stored_session(
        1,
        &ws,
        "Are we protected against people doing",
    ))
    .unwrap();
    drop(db);

    let daemon = Daemon::new(DaemonConfig {
        token: "title-test".into(),
        db_path,
    })
    .unwrap();
    let replacement = daemon.respawn(1, false, None, None, false).unwrap();
    let d = daemon.clone();
    let id = replacement.id;
    wait_until("the restored pane to accept the CLI title", move || {
        title_of(&d, id) == "Reviewing the parser"
    })
    .await;
    daemon.kill(replacement.id).ok();
}

#[tokio::test]
async fn a_spawned_child_uses_its_role_until_its_cli_names_it() {
    shim_dir();
    let (_addr, state, daemon) = start_daemon_with_handle().await;
    let ws = state.path().join("role-ws");
    std::fs::create_dir_all(&ws).unwrap();
    daemon.workspace_add(&ws.display().to_string()).unwrap();
    daemon.orchestration_set(true).unwrap();
    let parent = spawn(
        &daemon,
        &ws,
        proto::AgentKind::Custom,
        Some(vec!["sh".into(), "-c".into(), "exec cat".into()]),
    );
    let child = daemon
        .orchestrate_spawn(
            parent.id,
            proto::AgentKind::Grok,
            None,
            None,
            Brief::from("register the server".to_string()),
            Some(false),
            None,
            Some("codex-mcp-register".to_string()),
        )
        .unwrap();
    assert_eq!(title_of(&daemon, child.id), "codex-mcp-register");
    daemon.kill(child.id).ok();
    daemon.kill(parent.id).ok();
}

#[tokio::test]
async fn the_cli_title_floor_keeps_the_latest_write() {
    let (_addr, state, daemon) = start_daemon_with_handle().await;
    let ws = state.path().join("ws");
    std::fs::create_dir_all(&ws).unwrap();
    let exe = burst_title_writer(state.path(), "burst-titler");
    let info = spawn(
        &daemon,
        &ws,
        proto::AgentKind::Custom,
        Some(vec![exe.display().to_string()]),
    );
    let d = daemon.clone();
    let id = info.id;
    wait_until("the latest title in the rate-limit window", move || {
        title_of(&d, id) == "latest"
    })
    .await;
    daemon.kill(info.id).ok();
}

#[tokio::test]
async fn a_user_rename_before_the_title_wins_and_stays() {
    let (_addr, state, daemon) = start_daemon_with_handle().await;
    let ws = state.path().join("ws");
    std::fs::create_dir_all(&ws).unwrap();
    let exe = title_writer(state.path(), "titler-2", "Whatever the CLI thinks");

    let info = spawn(
        &daemon,
        &ws,
        proto::AgentKind::Custom,
        Some(vec![exe.display().to_string()]),
    );
    daemon.rename(info.id, "Mine").unwrap();

    let d = daemon.clone();
    let id = info.id;
    wait_until("the pane to produce output", move || {
        d.list().into_iter().any(|s| s.id == id)
    })
    .await;
    tokio::time::sleep(std::time::Duration::from_millis(500)).await;

    assert_eq!(
        title_of(&daemon, info.id),
        "Mine",
        "a name the user typed is final"
    );
    daemon.kill(info.id).ok();
}

#[tokio::test]
async fn a_shell_pane_ignores_the_title_its_shell_writes() {
    let (_addr, state, daemon) = start_daemon_with_handle().await;
    let ws = state.path().join("ws");
    std::fs::create_dir_all(&ws).unwrap();
    let shell = title_writer(state.path(), "shellish", "~/projects/houston");
    std::env::set_var("SHELL", shell.display().to_string());

    let info = spawn(&daemon, &ws, proto::AgentKind::Shell, None);
    tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    assert_eq!(
        title_of(&daemon, info.id),
        info.title,
        "a shell pane keeps its codename"
    );
    daemon.kill(info.id).ok();
}
