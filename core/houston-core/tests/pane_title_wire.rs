#![cfg(unix)]

mod common;

use houston_core::daemon::{CreateParams, Daemon, DaemonConfig};
use houston_core::db::Db;
use houston_core::orchestrate::Brief;
use houston_protocol as proto;
use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};

use common::{next_broadcast_control, start_daemon_with_handle};
use futures_util::SinkExt;
use tokio_tungstenite::tungstenite::Message;

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
        title_source: Default::default(),
        checkout: None,
        activity: None,
        id,
        agent: proto::AgentKind::Claude,
        project_dir: ws.display().to_string(),
        cwd: ws.display().to_string(),
        state: proto::SessionState::Interrupted,
        title: title.to_string(),
        codename: title.to_string(),
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
            model: None,
            effort: None,
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
            proto::ServerMsg::SessionRenamed { session, title, .. } if session == id => {
                assert_eq!(title, "Fixing the auth bug");
                break;
            }
            _ => continue,
        }
    }

    daemon.kill(info.id).ok();
}

#[tokio::test]
async fn reported_agent_status_has_a_runtime_timestamp_in_session_info() {
    shim_dir();
    let (_addr, state, daemon) = start_daemon_with_handle().await;
    let ws = state.path().join("ws");
    std::fs::create_dir_all(&ws).unwrap();

    let info = spawn(&daemon, &ws, proto::AgentKind::Claude, None);
    let since = info
        .status_since_ms
        .expect("reported status has a timestamp");
    assert!(since > 0);
    let listed = daemon
        .list()
        .into_iter()
        .find(|session| session.id == info.id)
        .unwrap();
    assert_eq!(listed.status_since_ms, Some(since));

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
    db.insert_session_with_title_source(
        &stored_session(1, &ws, "Are we protected against people doing"),
        Some("prompt"),
    )
    .unwrap();
    db.acknowledge_uncontained_recovery(1).unwrap();
    drop(db);

    let daemon = Daemon::new(DaemonConfig {
        token: "title-test".into(),
        db_path,
    })
    .unwrap();
    let replacement = daemon
        .list()
        .into_iter()
        .filter(|s| s.session_origin == Some(1))
        .max_by_key(|s| s.id)
        .expect("the pane restores automatically");
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
    daemon.name_pane_from_prompt(child.id, "First delegated prompt");
    assert_eq!(title_of(&daemon, child.id), "codex-mcp-register");
    assert_eq!(
        daemon
            .list()
            .into_iter()
            .find(|s| s.id == child.id)
            .unwrap()
            .title_source,
        proto::TitleSource::Role
    );
    daemon
        .write_stdin(child.id, b"\x1b]2;Native delegated task\x07\n")
        .unwrap();
    wait_until("native title to outrank role", || {
        title_of(&daemon, child.id) == "Native delegated task"
    })
    .await;
    daemon.rename(child.id, "Manual delegated name").unwrap();
    daemon.reset_title(child.id).unwrap();
    assert_eq!(title_of(&daemon, child.id), "Native delegated task");
    assert_eq!(
        daemon
            .list()
            .into_iter()
            .find(|s| s.id == child.id)
            .unwrap()
            .title_source,
        proto::TitleSource::Cli
    );
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

#[tokio::test]
async fn reset_recomputes_stored_first_prompt_and_latest_cli_after_user_override() {
    let (addr, state, daemon) = start_daemon_with_handle().await;
    let ws = state.path().join("reset-ws");
    std::fs::create_dir_all(&ws).unwrap();
    let info = spawn(
        &daemon,
        &ws,
        proto::AgentKind::Custom,
        Some(vec![
            "sh".into(),
            "-c".into(),
            "stty -echo; exec cat".into(),
        ]),
    );
    daemon
        .name_pane_from_prompt(info.id, "Can you please fix authentication")
        .unwrap();
    assert_eq!(title_of(&daemon, info.id), "Fix authentication");
    assert_eq!(
        daemon
            .list()
            .into_iter()
            .find(|s| s.id == info.id)
            .unwrap()
            .title_source,
        proto::TitleSource::Prompt
    );
    daemon.rename(info.id, "My name").unwrap();
    let detail = daemon.orchestrate_get(info.id, info.id).unwrap();
    assert_eq!(detail.info.title, "My name");
    assert_eq!(detail.info.title_source, proto::TitleSource::User);
    daemon.name_pane_from_prompt(info.id, "A later prompt must not replace the first");
    let mut connection = common::connect_and_hello(addr, common::TOKEN).await;
    let _ = common::next_control(&mut connection).await;
    connection
        .send(Message::text(
            serde_json::to_string(&proto::ClientMsg::SessionTitleReset { session: info.id })
                .unwrap(),
        ))
        .await
        .unwrap();
    loop {
        if let proto::ServerMsg::SessionRenamed {
            session,
            title,
            title_source,
        } = common::next_control(&mut connection).await
        {
            if session == info.id {
                assert_eq!(title, "Fix authentication");
                assert_eq!(title_source, proto::TitleSource::Prompt);
                break;
            }
        }
    }
    assert_eq!(title_of(&daemon, info.id), "Fix authentication");
    daemon
        .rename(info.id, "Native authentication title")
        .unwrap();
    daemon
        .write_stdin(info.id, b"\x1b]2;Native authentication title\x07\n")
        .unwrap();
    let db = Db::open(&state.path().join("test.db")).unwrap();
    wait_until("native candidate stored beneath user override", || {
        db.session_title_candidates(info.id)
            .unwrap()
            .iter()
            .any(|(source, title)| {
                *source == proto::TitleSource::Cli && title == "Native authentication title"
            })
    })
    .await;
    assert_eq!(title_of(&daemon, info.id), "Native authentication title");
    assert_eq!(
        daemon
            .list()
            .into_iter()
            .find(|s| s.id == info.id)
            .unwrap()
            .title_source,
        proto::TitleSource::User
    );
    daemon.reset_title(info.id).unwrap();
    assert_eq!(title_of(&daemon, info.id), "Native authentication title");
    assert_eq!(
        daemon
            .list()
            .into_iter()
            .find(|s| s.id == info.id)
            .unwrap()
            .title_source,
        proto::TitleSource::Cli
    );
    daemon.kill(info.id).unwrap();
}

#[tokio::test]
async fn hidden_handoff_pane_can_reset_its_manual_title() {
    let (_addr, state, daemon) = start_daemon_with_handle().await;
    let source = spawn(
        &daemon,
        state.path(),
        proto::AgentKind::Custom,
        Some(vec!["sh".into(), "-c".into(), "exec cat".into()]),
    );
    let identity = state.path().join("hidden-generator-session");
    let request = daemon
        .handoff_generate(
            source.id,
            proto::AgentKind::Custom,
            Some(vec![
                "sh".into(),
                "-c".into(),
                "printf '%s' \"$HOUSTON_SESSION\" > \"$1\"; read -r release; printf '<<<START>>>\\n## Summary\\nfixture\\n<<<END>>>\\n'"
                    .into(),
                "handoff-reset-fixture".into(),
                identity.display().to_string(),
            ]),
        )
        .unwrap();
    wait_until(
        "the hidden generator to publish its actual session id",
        || {
            std::fs::read_to_string(&identity)
                .ok()
                .and_then(|id| id.parse::<u32>().ok())
                .is_some()
        },
    )
    .await;
    let hidden: u32 = std::fs::read_to_string(identity).unwrap().parse().unwrap();
    let detail = daemon.orchestrate_get(hidden, hidden).unwrap();
    assert!(detail.info.hidden);
    assert_eq!(detail.info.codename, "handoff-custom");
    assert!(!daemon.list().iter().any(|info| info.id == hidden));
    daemon.rename(hidden, "Manual handoff name").unwrap();
    let detail = daemon.orchestrate_get(hidden, hidden).unwrap();
    assert_eq!(detail.info.title, "Manual handoff name");
    daemon.reset_title(hidden).unwrap();
    let detail = daemon.orchestrate_get(hidden, hidden).unwrap();
    assert_eq!(detail.info.title, "handoff-custom");
    assert_eq!(detail.info.title_source, proto::TitleSource::Codename);
    assert_eq!(
        daemon
            .name_pane_from_prompt(hidden, "First hidden prompt")
            .as_deref(),
        Some("First hidden prompt")
    );
    daemon.rename(hidden, "Manual override again").unwrap();
    daemon.name_pane_from_prompt(hidden, "Later hidden prompt");
    assert_eq!(
        daemon.orchestrate_get(hidden, hidden).unwrap().info.title,
        "Manual override again"
    );
    daemon.reset_title(hidden).unwrap();
    let detail = daemon.orchestrate_get(hidden, hidden).unwrap();
    assert_eq!(detail.info.title, "First hidden prompt");
    assert_eq!(detail.info.title_source, proto::TitleSource::Prompt);
    // The hidden generator persists its row for ownership receipts, never title candidates.
    let db = Db::open(&state.path().join("test.db")).unwrap();
    assert_eq!(
        db.session_final(hidden).unwrap(),
        Some((proto::SessionState::Running, None))
    );
    assert!(!db.session_is_closed(hidden).unwrap());
    let candidates = db.session_title_candidates(hidden).unwrap();
    assert!(candidates.is_empty(), "{candidates:?}");
    let mut observer = daemon.observe();
    daemon.write_stdin(hidden, b"done\n").unwrap();
    loop {
        match next_broadcast_control(&mut observer).await {
            proto::ServerMsg::HandoffDone { request: done, .. } if done == request => break,
            proto::ServerMsg::HandoffError {
                request: failed,
                message,
            } if failed == request => {
                panic!("handoff fixture failed: {message}");
            }
            _ => {}
        }
    }
    assert!(daemon.orchestrate_get(hidden, hidden).is_err());
    wait_until("the finished hidden generator row to close", || {
        db.session_is_closed(hidden).unwrap()
    })
    .await;
    assert!(db.session_title_candidates(hidden).unwrap().is_empty());
    daemon.close(source.id).unwrap();
}

#[tokio::test]
async fn legacy_manual_title_without_provenance_stays_locked_until_reset() {
    let state = tempfile::tempdir().unwrap();
    let db_path = state.path().join("legacy-titles.db");
    let db = Db::open(&db_path).unwrap();
    let mut stored = stored_session(1, state.path(), "Manual project overview");
    stored.codename = "Max".into();
    db.insert_session(&stored).unwrap();
    db.acknowledge_uncontained_recovery(1).unwrap();
    assert_eq!(db.session_title_source(1).unwrap(), None);
    let daemon = Daemon::new_with_safe_mode_flags_for_test(
        DaemonConfig {
            token: "legacy-title".into(),
            db_path,
        },
        houston_core::daemon::SafeModeFlags {
            disable_auto_restore: true,
            ..Default::default()
        },
    )
    .unwrap();
    let listed = daemon.list().into_iter().find(|s| s.id == 1).unwrap();
    assert_eq!(listed.title, "Manual project overview");
    assert_eq!(listed.title_source, proto::TitleSource::User);
    daemon.name_pane_from_prompt(1, "Later prompt candidate");
    let listed = daemon.list().into_iter().find(|s| s.id == 1).unwrap();
    assert_eq!(listed.title, "Manual project overview");
    assert_eq!(listed.title_source, proto::TitleSource::User);
    daemon.reset_title(1).unwrap();
    let listed = daemon.list().into_iter().find(|s| s.id == 1).unwrap();
    assert_eq!(listed.title, "Later prompt candidate");
    assert_eq!(listed.title_source, proto::TitleSource::Prompt);
    daemon.close(1).unwrap();
}

#[tokio::test]
async fn refused_restored_title_reset_keeps_the_manual_name_locked() {
    let state = tempfile::tempdir().unwrap();
    let db_path = state.path().join("titles.db");
    let db = Db::open(&db_path).unwrap();
    let mut stored = stored_session(1, state.path(), "My stable title");
    stored.codename = "Max".into();
    db.insert_session_with_title_source(&stored, Some("user"))
        .unwrap();
    db.save_title_candidate(1, proto::TitleSource::Prompt, "Original task")
        .unwrap();
    db.acknowledge_uncontained_recovery(1).unwrap();
    let daemon = Daemon::new_with_safe_mode_flags_for_test(
        DaemonConfig {
            token: "refused-title-reset".into(),
            db_path: db_path.clone(),
        },
        houston_core::daemon::SafeModeFlags {
            disable_auto_restore: true,
            ..Default::default()
        },
    )
    .unwrap();
    let conn = rusqlite::Connection::open(&db_path).unwrap();
    conn.execute_batch(
        "CREATE TRIGGER refuse_title_update BEFORE UPDATE OF title ON sessions
         BEGIN SELECT RAISE(FAIL, 'title update refused by fixture'); END;",
    )
    .unwrap();
    assert!(daemon.reset_title(1).is_err());
    let listed = daemon.list().into_iter().find(|s| s.id == 1).unwrap();
    assert_eq!(listed.title, "My stable title");
    assert_eq!(listed.title_source, proto::TitleSource::User);
    assert_eq!(db.session_title_source(1).unwrap().as_deref(), Some("user"));

    conn.execute_batch("DROP TRIGGER refuse_title_update")
        .unwrap();
    daemon.name_pane_from_prompt(1, "Later task");
    assert_eq!(title_of(&daemon, 1), "My stable title");
    daemon.reset_title(1).unwrap();
    assert_eq!(title_of(&daemon, 1), "Original task");
    daemon.close(1).unwrap();
}

#[tokio::test]
async fn user_title_and_candidates_survive_boot_restore() {
    shim_dir();
    let state = tempfile::tempdir().unwrap();
    let ws = state.path().join("user-restore");
    std::fs::create_dir_all(&ws).unwrap();
    let db_path = state.path().join("titles.db");
    let db = Db::open(&db_path).unwrap();
    let mut stored = stored_session(1, &ws, "My stable title");
    stored.codename = "Max".into();
    db.insert_session_with_title_source(&stored, Some("user"))
        .unwrap();
    db.save_title_candidate(1, proto::TitleSource::Prompt, "Original task")
        .unwrap();
    db.acknowledge_uncontained_recovery(1).unwrap();
    drop(db);
    let daemon = Daemon::new(DaemonConfig {
        token: "restore-title".into(),
        db_path: db_path.clone(),
    })
    .unwrap();
    let replacement = daemon
        .list()
        .into_iter()
        .filter(|s| s.session_origin == Some(1))
        .max_by_key(|s| s.id)
        .unwrap();
    assert_ne!(replacement.id, 1);
    assert_eq!(replacement.title, "My stable title");
    assert_eq!(replacement.title_source, proto::TitleSource::User);
    daemon.name_pane_from_prompt(replacement.id, "Later prompt");
    let db = Db::open(&db_path).unwrap();
    wait_until("restored CLI title candidate", || {
        db.session_title_candidates(replacement.id)
            .unwrap()
            .iter()
            .any(|(source, _)| *source == proto::TitleSource::Cli)
    })
    .await;
    assert_eq!(title_of(&daemon, replacement.id), "My stable title");
    daemon.reset_title(replacement.id).unwrap();
    assert_eq!(title_of(&daemon, replacement.id), "Reviewing the parser");
    daemon.kill(replacement.id).unwrap();
}

#[tokio::test]
async fn antigravity_status_window_titles_never_name_the_pane() {
    let (_addr, state, daemon) = start_daemon_with_handle().await;
    let ws = state.path().join("antigravity-title");
    std::fs::create_dir_all(&ws).unwrap();
    let writer = title_writer(
        state.path(),
        "antigravity-window",
        "Sonnet Thinking about authentication",
    );
    let info = spawn(
        &daemon,
        &ws,
        proto::AgentKind::Antigravity,
        Some(vec![writer.display().to_string()]),
    );
    daemon.name_pane_from_prompt(info.id, "Fix authentication");
    daemon
        .write_stdin(info.id, b"title-reader-barrier\n")
        .unwrap();
    wait_until("fixture output to reach the reader", || {
        daemon
            .session_screen_for_test(info.id)
            .iter()
            .any(|line| line.contains("title-reader-barrier"))
    })
    .await;
    assert_eq!(title_of(&daemon, info.id), "Fix authentication");
    assert_eq!(
        daemon
            .list()
            .into_iter()
            .find(|s| s.id == info.id)
            .unwrap()
            .title_source,
        proto::TitleSource::Prompt
    );
    assert!(!Db::open(&state.path().join("test.db"))
        .unwrap()
        .session_title_candidates(info.id)
        .unwrap()
        .iter()
        .any(|(source, _)| *source == proto::TitleSource::Cli));
    daemon.kill(info.id).unwrap();
}
