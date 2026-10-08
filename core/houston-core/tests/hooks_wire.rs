#![cfg(unix)]

mod common;

use houston_core::daemon::{CreateParams, Daemon, DaemonConfig};
use houston_core::hook_drop::{self, HookDrop};
use houston_protocol as proto;
use std::path::{Path, PathBuf};
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use common::{next_broadcast_control, start_daemon, start_daemon_with_handle, TOKEN};

fn drop_for(event: &str, session: u32) -> HookDrop {
    HookDrop {
        v: hook_drop::DROP_V,
        event: event.to_string(),
        session,
        cwd: None,
        agent: None,
        prompt: None,
        ..Default::default()
    }
}

fn drop_from(agent: &str, event: &str, session: u32) -> HookDrop {
    HookDrop {
        agent: Some(agent.to_string()),
        ..drop_for(event, session)
    }
}

fn drop_dir(state: &Path) -> PathBuf {
    hook_drop::drop_dir(state)
}

fn write_drop(state: &Path, d: &HookDrop) -> PathBuf {
    hook_drop::write_drop(&drop_dir(state), d, hook_drop::now_ms()).unwrap()
}

async fn drop_and_await_apply(state: &Path, d: &HookDrop) {
    let path = write_drop(state, d);
    let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
    while path.exists() {
        assert!(
            tokio::time::Instant::now() < deadline,
            "the daemon never applied {} — the drop file is still on disk",
            path.display()
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

async fn expect_status(
    rx: &mut houston_core::frame_queue::Observer,
    session: u32,
) -> proto::AgentStatus {
    loop {
        match next_broadcast_control(rx).await {
            proto::ServerMsg::AgentStatus { session: s, status } if s == session => {
                return status;
            }
            proto::ServerMsg::Error { message, .. } => panic!("daemon error: {message}"),
            _ => continue,
        }
    }
}

fn a_pane(daemon: &std::sync::Arc<Daemon>) -> (proto::SessionInfo, tempfile::TempDir) {
    let dir = tempfile::tempdir().unwrap();
    let info = daemon
        .create_session(CreateParams {
            agent: proto::AgentKind::Custom,
            project_dir: dir.path().to_path_buf(),
            cmd: Some(vec!["sleep".into(), "30".into()]),
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
        .unwrap();
    (info, dir)
}

#[tokio::test]
async fn a_correlation_hook_cannot_leave_a_pane_spawning_forever() {
    let (_addr, _state, daemon) = common::start_daemon_without_mail_loop().await;
    let dir = tempfile::tempdir().unwrap();
    let info = daemon
        .create_session(CreateParams {
            agent: proto::AgentKind::Codex,
            project_dir: dir.path().to_path_buf(),
            cmd: Some(vec!["sh".into(), "-c".into(), "exec sleep 30".into()]),
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
        .unwrap();
    assert_eq!(
        daemon.session_status(info.id).unwrap(),
        Some(proto::AgentStatus::Spawning),
    );

    assert_eq!(
        daemon.handle_hook_from(
            info.id,
            proto::AgentKind::Codex,
            "SessionEnd",
            dir.path().to_str(),
        ),
        hook_drop::DropVerdict::Applied,
    );
    daemon.expire_spawn_grace_for_test(info.id);
    assert_eq!(
        daemon.session_status(info.id).unwrap(),
        Some(proto::AgentStatus::Unavailable),
        "a correlation-only hook is not lifecycle evidence",
    );

    daemon.handle_hook_from(
        info.id,
        proto::AgentKind::Codex,
        "UserPromptSubmit",
        dir.path().to_str(),
    );
    assert_eq!(
        daemon.session_status(info.id).unwrap(),
        Some(proto::AgentStatus::Working),
        "late lifecycle evidence recovers an unavailable status",
    );
    daemon.kill(info.id).ok();
}

#[tokio::test]
async fn a_late_session_start_cannot_end_an_active_turn() {
    let (_addr, state, daemon) = start_daemon_with_handle().await;
    let dir = tempfile::tempdir().unwrap();
    let create = || {
        daemon
            .create_session(CreateParams {
                agent: proto::AgentKind::Codex,
                project_dir: dir.path().to_path_buf(),
                cmd: Some(vec!["sh".into(), "-c".into(), "exec sleep 30".into()]),
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
    };
    let info = create();
    assert_eq!(info.status, Some(proto::AgentStatus::Spawning));
    let startup = drop_from("codex", "SessionStart", info.id);
    drop_and_await_apply(state.path(), &startup).await;
    assert_eq!(
        daemon.session_status(info.id).unwrap(),
        Some(proto::AgentStatus::Idle)
    );
    drop_and_await_apply(
        state.path(),
        &drop_from("codex", "UserPromptSubmit", info.id),
    )
    .await;
    drop_and_await_apply(state.path(), &startup).await;
    assert_eq!(
        daemon.session_status(info.id).unwrap(),
        Some(proto::AgentStatus::Working)
    );
    drop_and_await_apply(
        state.path(),
        &drop_from("codex", "PermissionRequest", info.id),
    )
    .await;
    drop_and_await_apply(state.path(), &startup).await;
    assert_eq!(
        daemon.session_status(info.id).unwrap(),
        Some(proto::AgentStatus::NeedsInput)
    );

    let late = create();
    daemon.expire_spawn_grace_for_test(late.id);
    assert_eq!(
        daemon.session_status(late.id).unwrap(),
        Some(proto::AgentStatus::Unavailable)
    );
    drop_and_await_apply(state.path(), &drop_from("codex", "SessionStart", late.id)).await;
    assert_eq!(
        daemon.session_status(late.id).unwrap(),
        Some(proto::AgentStatus::Idle)
    );
    daemon.close(info.id).unwrap();
    daemon.close(late.id).unwrap();
}

#[tokio::test]
async fn a_live_hook_refreshes_its_panes_mcp_credential() {
    let (_addr, _state, daemon) = start_daemon_with_handle().await;
    let (info, dir) = a_pane(&daemon);
    let token = daemon.mcp_creds.issue(houston_core::mcp_creds::McpScope {
        session_id: info.id,
        workspace_id: dir.path().display().to_string(),
    });
    tokio::time::sleep(Duration::from_millis(20)).await;
    let (_, _, before) = daemon.mcp_creds.export_for_session(info.id).unwrap();
    assert_eq!(
        daemon.handle_hook_from(info.id, proto::AgentKind::Codex, "UserPromptSubmit", None),
        hook_drop::DropVerdict::Applied,
    );
    let (_, _, after) = daemon.mcp_creds.export_for_session(info.id).unwrap();
    assert!(
        after > before,
        "reported activity must renew the credential's liveness window"
    );
    assert_eq!(
        daemon.mcp_creds.resolve(&token).unwrap().session_id,
        info.id
    );
    daemon.close(info.id).unwrap();
}

#[tokio::test]
#[cfg(target_os = "linux")]
async fn close_terminates_a_hup_ignoring_foreground_tree_and_revokes_its_token() {
    let (_addr, state, daemon) = start_daemon_with_handle().await;
    let dir = tempfile::tempdir().unwrap();
    let info = daemon.create_session(CreateParams {
        agent: proto::AgentKind::Custom,
        project_dir: dir.path().to_path_buf(),
        cmd: Some(vec!["sh".into(), "-m".into(), "-c".into(),
            r#"trap '' HUP TERM; echo $$ > root.pid; sh -c 'trap "" HUP TERM; echo $$ > child.pid; while :; do sleep 1; done'"#.into()]),
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
    }).unwrap();
    let token = daemon.mcp_creds.issue(houston_core::mcp_creds::McpScope {
        session_id: info.id,
        workspace_id: info.project_dir.clone(),
    });
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    let pids = loop {
        let root = std::fs::read_to_string(dir.path().join("root.pid"))
            .ok()
            .and_then(|value| value.trim().parse::<u32>().ok());
        let child = std::fs::read_to_string(dir.path().join("child.pid"))
            .ok()
            .and_then(|value| value.trim().parse::<u32>().ok());
        if let (Some(root), Some(child)) = (root, child) {
            break [root, child];
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "PTY fixture did not start"
        );
        tokio::time::sleep(Duration::from_millis(10)).await;
    };
    struct Cleanup(Vec<(u32, Option<u64>)>);
    impl Drop for Cleanup {
        fn drop(&mut self) {
            for (pid, creation) in &self.0 {
                let _ = houston_core::pid::signal_process_checked_identity(
                    *pid,
                    houston_core::pid::Signal::Kill,
                    *creation,
                );
            }
        }
    }
    let _cleanup = Cleanup(
        pids.iter()
            .map(|pid| (*pid, houston_core::pid::process_creation_token(*pid)))
            .collect(),
    );
    let root_stat = std::fs::read_to_string(format!("/proc/{}/stat", pids[0])).unwrap();
    let child_stat = std::fs::read_to_string(format!("/proc/{}/stat", pids[1])).unwrap();
    let group = |stat: &str| {
        stat[stat.rfind(')').unwrap() + 2..]
            .split_whitespace()
            .nth(2)
            .unwrap()
            .parse::<u32>()
            .unwrap()
    };
    assert_ne!(
        group(&root_stat),
        group(&child_stat),
        "foreground child needs its own job group"
    );
    daemon.close(info.id).unwrap();
    assert!(
        daemon.mcp_creds.resolve(&token).is_none(),
        "closed ownership revokes the token immediately"
    );
    let connection = rusqlite::Connection::open_with_flags(
        state.path().join("test.db"),
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .unwrap();
    let closed: String = connection
        .query_row(
            "SELECT state FROM sessions WHERE id = ?1",
            [info.id],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(closed, "closed");
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    loop {
        let alive = pids.iter().any(|pid| {
            std::fs::read_to_string(format!("/proc/{pid}/stat")).is_ok_and(|stat| {
                stat[stat.rfind(')').unwrap() + 2..]
                    .split_whitespace()
                    .next()
                    != Some("Z")
            })
        });
        if !alive {
            break;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "closed pane left an owned process alive: {pids:?}"
        );
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

#[tokio::test]
async fn hook_events_drive_status() {
    let (_addr, state, daemon) = start_daemon_with_handle().await;
    let (info, _dir) = a_pane(&daemon);
    assert!(
        info.status.is_none(),
        "a non-Claude pane starts with no status"
    );
    let mut rx = daemon.observe();

    drop_and_await_apply(state.path(), &drop_for("UserPromptSubmit", info.id)).await;
    assert_eq!(
        expect_status(&mut rx, info.id).await,
        proto::AgentStatus::Working
    );

    drop_and_await_apply(state.path(), &drop_for("Stop", info.id)).await;
    assert_eq!(
        expect_status(&mut rx, info.id).await,
        proto::AgentStatus::Idle
    );

    drop_and_await_apply(state.path(), &drop_for("UserPromptSubmit", info.id)).await;
    assert_eq!(
        expect_status(&mut rx, info.id).await,
        proto::AgentStatus::Working
    );
    drop_and_await_apply(state.path(), &drop_for("Notification", info.id)).await;
    assert_eq!(
        expect_status(&mut rx, info.id).await,
        proto::AgentStatus::NeedsInput
    );

    daemon.kill(info.id).ok();
}

#[tokio::test]
async fn a_post_stop_notification_does_not_stick_the_pane_at_needs_input() {
    let (_addr, state, daemon) = start_daemon_with_handle().await;
    let (info, _dir) = a_pane(&daemon);
    let mut rx = daemon.observe();

    drop_and_await_apply(state.path(), &drop_for("Stop", info.id)).await;
    assert_eq!(
        expect_status(&mut rx, info.id).await,
        proto::AgentStatus::Idle
    );

    drop_and_await_apply(state.path(), &drop_for("Notification", info.id)).await;

    drop_and_await_apply(state.path(), &drop_for("UserPromptSubmit", info.id)).await;
    assert_eq!(
        expect_status(&mut rx, info.id).await,
        proto::AgentStatus::Working,
        "a Notification arriving after Stop (no prompt since) is the idle \
         nudge, not a permission block — it must not stick the pane at \
         NeedsInput and block every later orchestrate_prompt"
    );

    assert_eq!(
        daemon.session_status(info.id).unwrap(),
        Some(proto::AgentStatus::Working)
    );

    daemon.kill(info.id).ok();
}

#[tokio::test]
async fn an_explicit_permission_request_is_not_suppressed_while_idle() {
    let (_addr, state, daemon) = start_daemon_with_handle().await;
    let (info, _dir) = a_pane(&daemon);
    let mut rx = daemon.observe();

    drop_and_await_apply(state.path(), &drop_for("Stop", info.id)).await;
    while expect_status(&mut rx, info.id).await != proto::AgentStatus::Idle {}

    drop_and_await_apply(state.path(), &drop_for("PermissionRequest", info.id)).await;
    assert_eq!(
        expect_status(&mut rx, info.id).await,
        proto::AgentStatus::NeedsInput,
        "an explicit permission request is authoritative even if the prompt-start hook was missed"
    );

    daemon.kill(info.id).ok();
}

#[tokio::test]
async fn claude_question_tool_blocks_until_the_matching_tool_finishes() {
    let (_addr, state, daemon) = start_daemon_with_handle().await;
    let (info, _dir) = a_pane(&daemon);
    let mut rx = daemon.observe();

    drop_and_await_apply(state.path(), &drop_for("UserPromptSubmit", info.id)).await;
    assert_eq!(
        expect_status(&mut rx, info.id).await,
        proto::AgentStatus::Working
    );

    let question = HookDrop {
        event: "PreToolUse".into(),
        tool_name: Some("AskUserQuestion".into()),
        tool_use_id: Some("toolu-question-1".into()),
        ..drop_for("PreToolUse", info.id)
    };
    drop_and_await_apply(state.path(), &question).await;
    assert_eq!(
        expect_status(&mut rx, info.id).await,
        proto::AgentStatus::NeedsInput
    );

    let unrelated = HookDrop {
        event: "PostToolUse".into(),
        tool_name: Some("Read".into()),
        tool_use_id: Some("toolu-read-1".into()),
        ..drop_for("PostToolUse", info.id)
    };
    drop_and_await_apply(state.path(), &unrelated).await;
    assert_eq!(
        daemon.session_status(info.id).unwrap(),
        Some(proto::AgentStatus::NeedsInput)
    );

    let answer = HookDrop {
        event: "PostToolUse".into(),
        tool_name: Some("AskUserQuestion".into()),
        tool_use_id: Some("toolu-question-1".into()),
        ..drop_for("PostToolUse", info.id)
    };
    drop_and_await_apply(state.path(), &answer).await;
    assert_eq!(
        expect_status(&mut rx, info.id).await,
        proto::AgentStatus::Working
    );

    daemon.kill(info.id).ok();
}

#[tokio::test]
async fn claude_mcp_elicitation_blocks_until_its_result() {
    let (_addr, state, daemon) = start_daemon_with_handle().await;
    let (info, _dir) = a_pane(&daemon);
    let mut rx = daemon.observe();

    drop_and_await_apply(state.path(), &drop_for("UserPromptSubmit", info.id)).await;
    assert_eq!(
        expect_status(&mut rx, info.id).await,
        proto::AgentStatus::Working
    );
    let first_elicitation = HookDrop {
        request_id: Some("elicitation-a".into()),
        ..drop_for("Elicitation", info.id)
    };
    drop_and_await_apply(state.path(), &first_elicitation).await;
    assert_eq!(
        expect_status(&mut rx, info.id).await,
        proto::AgentStatus::NeedsInput
    );
    let second_elicitation = HookDrop {
        request_id: Some("elicitation-b".into()),
        ..drop_for("Elicitation", info.id)
    };
    drop_and_await_apply(state.path(), &second_elicitation).await;
    let unrelated_denial = HookDrop {
        tool_use_id: Some("toolu-unrelated".into()),
        tool_name: Some("Bash".into()),
        ..drop_for("PermissionDenied", info.id)
    };
    drop_and_await_apply(state.path(), &unrelated_denial).await;
    assert_eq!(
        daemon.session_status(info.id).unwrap(),
        Some(proto::AgentStatus::NeedsInput),
        "an unrelated permission result must not clear the elicitation"
    );
    let second_result = HookDrop {
        request_id: Some("elicitation-b".into()),
        ..drop_for("ElicitationResult", info.id)
    };
    drop_and_await_apply(state.path(), &second_result).await;
    assert_eq!(
        daemon.session_status(info.id).unwrap(),
        Some(proto::AgentStatus::NeedsInput),
        "an out-of-order result must leave the other elicitation open"
    );
    let first_result = HookDrop {
        request_id: Some("elicitation-a".into()),
        ..drop_for("ElicitationResult", info.id)
    };
    drop_and_await_apply(state.path(), &first_result).await;
    assert_eq!(
        expect_status(&mut rx, info.id).await,
        proto::AgentStatus::Working
    );

    daemon.kill(info.id).ok();
}

#[tokio::test]
async fn a_stop_failure_settles_the_pane_at_idle() {
    let (_addr, state, daemon) = start_daemon_with_handle().await;
    let (info, _dir) = a_pane(&daemon);
    let mut rx = daemon.observe();

    drop_and_await_apply(state.path(), &drop_for("UserPromptSubmit", info.id)).await;
    assert_eq!(
        expect_status(&mut rx, info.id).await,
        proto::AgentStatus::Working
    );
    drop_and_await_apply(state.path(), &drop_for("StopFailure", info.id)).await;
    assert_eq!(
        expect_status(&mut rx, info.id).await,
        proto::AgentStatus::Idle
    );

    daemon.kill(info.id).ok();
}

#[tokio::test]
async fn a_late_hook_cannot_mutate_an_ended_pane() {
    let (_addr, state, daemon) = start_daemon_with_handle().await;
    let (info, _dir) = a_pane(&daemon);

    drop_and_await_apply(state.path(), &drop_for("UserPromptSubmit", info.id)).await;
    assert_eq!(
        daemon.session_status(info.id).unwrap(),
        Some(proto::AgentStatus::Working)
    );
    daemon.kill(info.id).expect("kill pane");

    drop_and_await_apply(state.path(), &drop_for("Stop", info.id)).await;
    assert_eq!(
        daemon.session_status(info.id).unwrap(),
        Some(proto::AgentStatus::Working),
        "a delayed hook after process exit must not rewrite lifecycle state"
    );
}

#[tokio::test]
async fn a_providers_own_event_name_drives_status_and_a_foreign_one_does_not() {
    let (_addr, state, daemon) = start_daemon_with_handle().await;
    let (info, _dir) = a_pane(&daemon);
    let mut rx = daemon.observe();

    drop_and_await_apply(state.path(), &drop_from("cursor", "stop", info.id)).await;
    assert_eq!(
        expect_status(&mut rx, info.id).await,
        proto::AgentStatus::Idle
    );

    drop_and_await_apply(state.path(), &drop_from("cursor", "Notification", info.id)).await;
    drop_and_await_apply(state.path(), &drop_for("UserPromptSubmit", info.id)).await;
    assert_eq!(
        expect_status(&mut rx, info.id).await,
        proto::AgentStatus::Working,
        "the next status must be the Claude prompt's Working — a NeedsInput here would mean \
         Cursor borrowed Claude's event names"
    );

    daemon.kill(info.id).ok();
}

#[tokio::test]
async fn antigravitys_mid_turn_events_never_end_the_turn() {
    let (_addr, state, daemon) = start_daemon_with_handle().await;
    let (info, _dir) = a_pane(&daemon);
    let mut rx = daemon.observe();

    drop_and_await_apply(
        state.path(),
        &drop_from("antigravity", "PreInvocation", info.id),
    )
    .await;
    assert_eq!(
        expect_status(&mut rx, info.id).await,
        proto::AgentStatus::Working
    );

    for mid_turn in [
        "PostInvocation",
        "PreToolUse",
        "PostToolUse",
        "PostInvocation",
    ] {
        drop_and_await_apply(state.path(), &drop_from("antigravity", mid_turn, info.id)).await;
        assert_eq!(
            daemon.session_status(info.id).unwrap(),
            Some(proto::AgentStatus::Working),
            "{mid_turn} fires mid-turn: it must neither end the turn nor read as a block"
        );
    }

    drop_and_await_apply(state.path(), &drop_from("antigravity", "Stop", info.id)).await;
    assert_eq!(
        expect_status(&mut rx, info.id).await,
        proto::AgentStatus::Idle
    );

    daemon.kill(info.id).ok();
}

#[tokio::test]
async fn claude_hook_consent_uninstalls_for_real_and_stays_off() {
    let (_addr, _state, daemon) = start_daemon_with_handle().await;
    let ws = tempfile::tempdir().unwrap();
    daemon
        .workspace_add(&ws.path().display().to_string())
        .expect("add workspace");

    let settings = ws.path().join(".claude").join("settings.local.json");
    let read = || std::fs::read_to_string(&settings).unwrap_or_default();
    assert!(
        read().contains("houston-managed"),
        "adding a workspace installs the hooks by default: {}",
        read()
    );

    let mut root: serde_json::Value = serde_json::from_str(&read()).expect("json");
    root["hooks"]["Stop"]
        .as_array_mut()
        .expect("Stop array")
        .push(serde_json::json!({"hooks":[{"type":"command","command":"my-own-hook"}]}));
    std::fs::write(&settings, serde_json::to_string_pretty(&root).unwrap()).unwrap();

    let rows = daemon.agent_hooks_set(proto::AgentKind::Claude, false);
    let claude = rows
        .iter()
        .find(|r| r.provider == proto::AgentKind::Claude)
        .expect("a claude row");
    assert!(!claude.enabled, "consent is off");
    assert!(
        !claude.installed,
        "and the file no longer carries Houston's hooks"
    );
    assert!(!read().contains("houston-managed"), "{}", read());
    assert!(
        read().contains("my-own-hook"),
        "the user's own hook survives an uninstall: {}",
        read()
    );

    daemon.install_workspace_hooks(&ws.path().display().to_string());
    daemon.install_all_workspace_hooks();
    assert!(
        !read().contains("houston-managed"),
        "off means off across a reopen and a boot refresh: {}",
        read()
    );

    let rows = daemon.agent_hooks_set(proto::AgentKind::Claude, true);
    assert!(
        rows.iter()
            .find(|r| r.provider == proto::AgentKind::Claude)
            .expect("a claude row")
            .installed
    );
    assert!(read().contains("houston-managed"), "{}", read());
}

#[tokio::test]
async fn the_new_providers_report_their_own_file_and_start_off() {
    let (_addr, _state, daemon) = start_daemon_with_handle().await;
    let rows = daemon.agent_hooks_state();
    assert_eq!(
        rows.len(),
        houston_core::agent_hooks::PROVIDERS.len() + 1,
        "one row per installer provider, plus Claude's own"
    );
    for row in &rows {
        if row.provider == proto::AgentKind::Claude {
            assert_eq!(row.scope, proto::AgentHookScope::Workspace);
            assert!(row.enabled, "Claude is grandfathered on");
            continue;
        }
        assert_eq!(row.scope, proto::AgentHookScope::Global);
        assert!(
            !row.enabled,
            "{:?} must not be on before anyone said so",
            row.provider
        );
        assert!(
            !row.path.is_empty(),
            "{:?} must name the file it would write BEFORE it writes it",
            row.provider
        );
    }
}

#[tokio::test]
async fn two_events_in_one_millisecond_apply_in_the_order_they_happened() {
    let (_addr, state, daemon) = common::start_daemon_without_mail_loop().await;
    let (info, _dir) = a_pane(&daemon);
    let mut rx = daemon.observe();

    let dir = drop_dir(state.path());
    let ms = hook_drop::now_ms();
    hook_drop::write_drop(&dir, &drop_for("UserPromptSubmit", info.id), ms).unwrap();
    hook_drop::write_drop(&dir, &drop_for("Stop", info.id), ms).unwrap();

    assert_eq!(daemon.hook_drop_tick_for_test(), 2, "both must apply");

    assert_eq!(
        expect_status(&mut rx, info.id).await,
        proto::AgentStatus::Working,
        "UserPromptSubmit happened first, so Working must be broadcast first"
    );
    assert_eq!(
        expect_status(&mut rx, info.id).await,
        proto::AgentStatus::Idle,
        "…and Stop second — an inverted pair leaves the pane wrong forever"
    );
}

#[tokio::test]
async fn a_broken_swarm_listing_never_stops_a_drop_file_from_applying() {
    let (_addr, state, daemon) = common::start_daemon_without_mail_loop().await;
    let (info, _dir) = a_pane(&daemon);
    let mut rx = daemon.observe();

    let conn = rusqlite::Connection::open(state.path().join("test.db")).unwrap();
    conn.execute_batch("ALTER TABLE swarms RENAME TO swarms_hidden")
        .unwrap();
    let err = daemon
        .swarm_list()
        .expect_err("precondition: the daemon's own list_swarms must actually be failing");
    assert!(
        err.to_string().contains("swarms"),
        "precondition: unexpected failure {err:#}"
    );

    let path = write_drop(state.path(), &drop_for("UserPromptSubmit", info.id));
    let _delay = daemon.swarm_mail_tick_for_test();

    assert!(
        !path.exists(),
        "the drop file was not applied while list_swarms was failing: {} still on disk",
        path.display()
    );
    assert_eq!(
        expect_status(&mut rx, info.id).await,
        proto::AgentStatus::Working,
        "hook events are v19 ground truth — an unrelated DB failure must not freeze a pane"
    );

    conn.execute_batch("ALTER TABLE swarms_hidden RENAME TO swarms")
        .unwrap();
}

#[tokio::test]
async fn an_unapplied_file_for_an_untracked_session_is_never_deleted_while_fresh() {
    let (_addr, state, daemon) = common::start_daemon_without_mail_loop().await;
    let (info, _dir) = a_pane(&daemon);
    let mut rx = daemon.observe();

    let unknown = info.id + 500;
    let orphan = write_drop(state.path(), &drop_for("Stop", unknown));
    let live = write_drop(state.path(), &drop_for("UserPromptSubmit", info.id));

    for round in 0..3 {
        let applied = daemon.hook_drop_tick_for_test();
        assert!(
            orphan.exists(),
            "round {round}: an unapplied file must survive — its pane may just not be \
             restored yet, and only the age sweep may collect it"
        );
        assert_eq!(
            applied,
            if round == 0 { 1 } else { 0 },
            "round {round}: only the live session's file is ever applied"
        );
    }
    assert!(!live.exists(), "an applied file is deleted");
    assert_eq!(
        expect_status(&mut rx, info.id).await,
        proto::AgentStatus::Working
    );
}

#[test]
fn boot_collects_a_stale_drop_file_and_keeps_a_fresh_one() {
    let state = tempfile::tempdir().unwrap();
    let dir = drop_dir(state.path());
    let now = hook_drop::now_ms();
    let stale = hook_drop::write_drop(
        &dir,
        &drop_for("Stop", 1),
        now - hook_drop::MAX_AGE_MS - 60_000,
    )
    .unwrap();
    let fresh = hook_drop::write_drop(&dir, &drop_for("UserPromptSubmit", 1), now).unwrap();

    let _daemon = Daemon::new(DaemonConfig {
        token: TOKEN.to_string(),
        db_path: state.path().join("test.db"),
    })
    .unwrap();

    assert!(
        !stale.exists(),
        "a three-day-old Stop must be collected, never applied to whatever pane \
         now holds that id"
    );
    assert!(
        fresh.exists(),
        "a recent event must survive the relaunch — no session is restored yet, so \
         the durability gate keeps it for the tick that can apply it"
    );
}

#[cfg(unix)]
#[tokio::test]
async fn boot_creates_the_drop_dir_private() {
    use std::os::unix::fs::PermissionsExt;
    let (_addr, state, _daemon) = common::start_daemon_without_mail_loop().await;
    let mode = std::fs::metadata(drop_dir(state.path()))
        .unwrap()
        .permissions()
        .mode()
        & 0o777;
    assert_eq!(mode, 0o700, "got {mode:o}");
}

#[tokio::test]
async fn boot_points_the_launcher_and_workspaces_bake_it() {
    let (_addr, state, daemon) = start_daemon_with_handle().await;
    let state_dir = state.path();
    let launcher = state_dir.join("bin").join("claude-hook");
    assert!(!launcher.exists(), "nothing points it before boot does");

    daemon.install_all_workspace_hooks();
    assert!(
        launcher.exists(),
        "boot must point the launcher even with zero workspaces"
    );
    #[cfg(unix)]
    assert_eq!(
        std::fs::canonicalize(&launcher).unwrap(),
        std::fs::canonicalize(std::env::current_exe().unwrap()).unwrap(),
        "the launcher must resolve to the binary that booted"
    );
    #[cfg(windows)]
    {
        let launcher_bytes = std::fs::read(&launcher).unwrap();
        let exe_bytes = std::fs::read(std::env::current_exe().unwrap()).unwrap();
        assert_eq!(
            launcher_bytes, exe_bytes,
            "the launcher copy must carry the binary that booted"
        );
    }

    let ws = tempfile::tempdir().unwrap();
    daemon
        .workspace_add(&ws.path().display().to_string())
        .unwrap();
    let settings: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string(ws.path().join(".claude/settings.local.json")).unwrap(),
    )
    .unwrap();
    let cmd = settings["hooks"]["Stop"][0]["hooks"][0]["command"]
        .as_str()
        .unwrap()
        .to_string();
    assert!(
        cmd.contains(&houston_core::exe_path::command_spelling(&launcher)),
        "the workspace must bake the launcher (command spelling): {cmd}"
    );
    assert!(
        !cmd.contains(&std::env::current_exe().unwrap().display().to_string()),
        "the workspace must NOT bake the binary path: {cmd}"
    );
}

#[tokio::test]
async fn hook_cwd_is_recorded_and_a_bad_one_never_costs_the_status_event() {
    let (_addr, state, daemon) = start_daemon_with_handle().await;
    let (info, dir) = a_pane(&daemon);
    let mut rx = daemon.observe();
    assert_eq!(daemon.last_hook_cwd(info.id), None, "nothing reported yet");

    let workspace = dir.path().display().to_string();
    let mut d = drop_for("UserPromptSubmit", info.id);
    d.cwd = Some(workspace.clone());
    drop_and_await_apply(state.path(), &d).await;
    assert_eq!(
        expect_status(&mut rx, info.id).await,
        proto::AgentStatus::Working
    );
    assert_eq!(
        daemon.last_hook_cwd(info.id).as_deref(),
        Some(workspace.as_str()),
        "the reported workspace must reach the daemon"
    );

    for bad in [None, Some("relative/path".to_string())] {
        let mut d = drop_for("Stop", info.id);
        d.cwd = bad.clone();
        drop_and_await_apply(state.path(), &d).await;
        assert_eq!(
            expect_status(&mut rx, info.id).await,
            proto::AgentStatus::Idle,
            "a cwd we refuse must not cost the status event (cwd {bad:?})"
        );
        assert_eq!(
            daemon.last_hook_cwd(info.id).as_deref(),
            Some(workspace.as_str()),
            "and must not overwrite the last good one (cwd {bad:?})"
        );
        drop_and_await_apply(state.path(), &drop_for("UserPromptSubmit", info.id)).await;
        assert_eq!(
            expect_status(&mut rx, info.id).await,
            proto::AgentStatus::Working
        );
    }

    daemon.kill(info.id).ok();
}

#[tokio::test]
async fn the_hook_route_is_gone_and_ws_is_the_only_one_left() {
    let (addr, _state) = start_daemon().await;
    let status = post_status(addr, "/hook").await;
    assert!(
        status == 404 || status == 405,
        "POST /hook must not be served any more, got {status}"
    );
    assert_eq!(
        post_status(addr, "/swarm/mail").await,
        status,
        "…and it is not special: every retired POST route answers the same"
    );
}

async fn post_status(addr: std::net::SocketAddr, path: &str) -> u16 {
    let mut stream = tokio::net::TcpStream::connect(addr).await.unwrap();
    let body = "{}";
    let req = format!(
        "POST {path} HTTP/1.1\r\n\
         Host: 127.0.0.1\r\n\
         Content-Type: application/json\r\n\
         Content-Length: {}\r\n\
         Connection: close\r\n\r\n\
         {body}",
        body.len()
    );
    stream.write_all(req.as_bytes()).await.unwrap();
    let mut resp = String::new();
    stream.read_to_string(&mut resp).await.unwrap();
    resp.split_whitespace()
        .nth(1)
        .and_then(|s| s.parse().ok())
        .unwrap_or(0)
}

async fn expect_running(
    rx: &mut houston_core::frame_queue::Observer,
    session: u32,
) -> Option<proto::AgentKind> {
    loop {
        match next_broadcast_control(rx).await {
            proto::ServerMsg::AgentRunning { session: s, agent } if s == session => {
                return agent;
            }
            proto::ServerMsg::Error { message, .. } => panic!("daemon error: {message}"),
            _ => continue,
        }
    }
}

#[tokio::test]
async fn a_shell_reports_the_agent_cli_it_runs_until_that_cli_ends() {
    let (_addr, state, daemon) = start_daemon_with_handle().await;
    let dir = tempfile::tempdir().unwrap();
    let info = daemon
        .create_session(CreateParams {
            agent: proto::AgentKind::Shell,
            project_dir: dir.path().to_path_buf(),
            cmd: None,
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
        .unwrap();
    let mut rx = daemon.observe();

    drop_and_await_apply(state.path(), &drop_from("codex", "SessionStart", info.id)).await;
    assert_eq!(
        expect_running(&mut rx, info.id).await,
        Some(proto::AgentKind::Codex)
    );
    let listed = daemon
        .list()
        .into_iter()
        .find(|s| s.id == info.id)
        .expect("the shell is listed");
    assert_eq!(listed.agent, proto::AgentKind::Shell);
    assert_eq!(listed.running_agent, Some(proto::AgentKind::Codex));

    drop_and_await_apply(state.path(), &drop_from("codex", "SessionEnd", info.id)).await;
    assert_eq!(expect_running(&mut rx, info.id).await, None);

    daemon.kill(info.id).ok();
}
