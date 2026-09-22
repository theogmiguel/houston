#![cfg(unix)]
#![allow(clippy::disallowed_methods)]

mod common;

use common::start_daemon_with_handle;
use houston_core::daemon::{CreateParams, Daemon};
use houston_core::hook_drop::HookDrop;
use houston_core::mcp_creds::McpScope;
use houston_protocol as proto;
use std::io::Write as _;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

static SERIAL: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
async fn serial() -> tokio::sync::MutexGuard<'static, ()> {
    SERIAL.lock().await
}

fn helper_bin() -> &'static str {
    env!("CARGO_BIN_EXE_houston-core")
}

static SHIM: std::sync::OnceLock<PathBuf> = std::sync::OnceLock::new();

fn shim_dir() -> PathBuf {
    SHIM.get_or_init(|| {
        let dir = tempfile::tempdir().expect("shim tempdir").keep();
        for name in ["codex", "opencode", "grok", "cursor-agent", "agy"] {
            let path = dir.join(name);
            std::fs::write(
                &path,
                "#!/bin/sh\nprintf 'ARGV:%s\\n' \"$*\"\necho FIXTURE-READY\nstty -echo 2>/dev/null\nexec cat\n",
            )
            .unwrap();
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
            }
        }
        let sep = if cfg!(windows) { ";" } else { ":" };
        let path_env = std::env::var("PATH").unwrap_or_default();
        std::env::set_var("PATH", format!("{}{sep}{path_env}", dir.display()));
        dir
    })
    .clone()
}

fn fixture(provider: &str, name: &str) -> String {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/hooks")
        .join(provider)
        .join(name);
    std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("reading {}: {e}", path.display()))
}

async fn run_hook(event: &str, slug: &str, session: u32, stdin: String) -> HookDrop {
    let home = tempfile::tempdir().unwrap();
    let (event, slug, stdin) = (event.to_string(), slug.to_string(), stdin);
    let home_path = home.path().to_path_buf();
    tokio::task::spawn_blocking(move || {
        let mut cmd = houston_core::spawn::command(helper_bin());
        cmd.arg("hook")
            .arg(&event)
            .arg("--agent")
            .arg(&slug)
            .arg("--houston-managed");
        cmd.env_clear();
        cmd.env("HOME", &home_path);
        cmd.env("HOUSTON_CHANNEL", "paritytest");
        cmd.env("TR_SESSION", session.to_string());
        cmd.stdin(std::process::Stdio::piped());
        cmd.stdout(std::process::Stdio::null());
        cmd.stderr(std::process::Stdio::piped());
        let mut child = cmd.spawn().expect("spawning the hook helper");
        child
            .stdin
            .as_mut()
            .unwrap()
            .write_all(stdin.as_bytes())
            .unwrap();
        drop(child.stdin.take());
        let out = child.wait_with_output().unwrap();
        assert!(
            out.status.success(),
            "hook {event}: helper exited {:?}: {}",
            out.status,
            String::from_utf8_lossy(&out.stderr)
        );
        let dir = houston_core::hook_drop::drop_dir(&home_path.join(".houston-paritytest"));
        let names: Vec<String> = std::fs::read_dir(&dir)
            .unwrap_or_else(|e| panic!("reading the helper's drop dir {}: {e}", dir.display()))
            .flatten()
            .filter_map(|e| e.file_name().to_str().map(String::from))
            .filter(|n| houston_core::hook_drop::parse_drop_name(n).is_some())
            .collect();
        assert_eq!(
            names.len(),
            1,
            "the helper writes exactly one drop: {names:?}"
        );
        let bytes = std::fs::read(dir.join(&names[0])).unwrap();
        serde_json::from_slice(&bytes).expect("the helper's drop parses")
    })
    .await
    .expect("the helper run must not panic")
}

async fn apply_drop(state_dir: &Path, drop: HookDrop) {
    let event = drop.event.clone();
    let session = drop.session;
    let path = houston_core::hook_drop::write_drop(
        &houston_core::hook_drop::drop_dir(state_dir),
        &drop,
        houston_core::daemon::now_ms(),
    )
    .unwrap();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
    while path.exists() {
        assert!(
            tokio::time::Instant::now() < deadline,
            "{event} drop never applied to session {session}"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

async fn drive(state_dir: &Path, event: &str, slug: &str, session: u32, stdin: String) {
    let drop = run_hook(event, slug, session, stdin).await;
    apply_drop(state_dir, drop).await;
}

fn pane(daemon: &Arc<Daemon>, agent: proto::AgentKind) -> (proto::SessionInfo, tempfile::TempDir) {
    let dir = tempfile::tempdir().unwrap();
    let info = daemon
        .create_session(CreateParams {
            agent,
            project_dir: dir.path().to_path_buf(),
            cmd: (agent != proto::AgentKind::Codex).then(|| vec!["sleep".into(), "30".into()]),
            cols: 80,
            rows: 24,
            cwd_from: None,
            shell_integration: false,
            auto_approve: false,
            acp: None,
            profile: None,
            prompt: None,
        })
        .expect("fixture pane spawns");
    (info, dir)
}

async fn next_status(
    rx: &mut houston_core::frame_queue::Observer,
    session: u32,
) -> proto::AgentStatus {
    loop {
        match common::next_broadcast_control(rx).await {
            proto::ServerMsg::AgentStatus { session: s, status } if s == session => return status,
            proto::ServerMsg::Error { message, .. } => panic!("daemon error: {message}"),
            _ => continue,
        }
    }
}

mod codex {
    use super::*;

    const SLUG: &str = "codex";

    fn f(name: &str) -> String {
        fixture("codex", name)
    }

    #[tokio::test]
    async fn codex_turn_end_is_one_row() {
        let _guard = serial().await;
        shim_dir();
        let (_addr, state, daemon) = start_daemon_with_handle().await;
        let (info, _dir) = pane(&daemon, proto::AgentKind::Codex);

        drive(
            state.path(),
            "SessionStart",
            SLUG,
            info.id,
            f("codex-0.153.4-01-SessionStart.json"),
        )
        .await;
        assert_eq!(
            daemon.session_status(info.id).unwrap(),
            Some(proto::AgentStatus::Idle)
        );

        drive(
            state.path(),
            "UserPromptSubmit",
            SLUG,
            info.id,
            f("codex-0.153.4-02-UserPromptSubmit.json"),
        )
        .await;
        assert_eq!(
            daemon.session_status(info.id).unwrap(),
            Some(proto::AgentStatus::Working)
        );

        drive(
            state.path(),
            "SubagentStart",
            SLUG,
            info.id,
            f("codex-0.153.4-05-SubagentStart.json"),
        )
        .await;
        assert_eq!(
            daemon.session_status(info.id).unwrap(),
            Some(proto::AgentStatus::Working),
            "SubagentStart must not move the pane"
        );
        drive(
            state.path(),
            "SubagentStop",
            SLUG,
            info.id,
            f("codex-0.153.4-06-SubagentStop.json"),
        )
        .await;
        assert_eq!(
            daemon.session_status(info.id).unwrap(),
            Some(proto::AgentStatus::Working),
            "SubagentStop must not move the pane"
        );

        let mut rx = daemon.observe();
        drive(
            state.path(),
            "Stop",
            SLUG,
            info.id,
            f("codex-0.153.4-03-Stop.json"),
        )
        .await;
        let mut saw_idle = 0;
        let mut saw_finished = 0;
        let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
        while tokio::time::Instant::now() < deadline && saw_finished == 0 {
            match tokio::time::timeout(
                Duration::from_millis(200),
                common::next_broadcast_control(&mut rx),
            )
            .await
            {
                Ok(proto::ServerMsg::AgentStatus { session, status }) if session == info.id => {
                    assert_eq!(status, proto::AgentStatus::Idle);
                    saw_idle += 1;
                }
                Ok(proto::ServerMsg::AgentNotice { session, kind }) if session == info.id => {
                    assert_eq!(kind, proto::AgentNoticeKind::Finished);
                    saw_finished += 1;
                }
                Ok(proto::ServerMsg::Error { message, .. }) => panic!("daemon error: {message}"),
                Ok(_) => continue,
                Err(_) => break,
            }
        }
        assert_eq!(
            saw_idle, 1,
            "exactly one turn end, not one per correlation event"
        );
        assert_eq!(saw_finished, 1, "exactly one Finished notice");
    }

    #[tokio::test]
    async fn codex_block_is_reported_or_named_as_missing() {
        let _guard = serial().await;
        shim_dir();
        let (_addr, state, daemon) = start_daemon_with_handle().await;
        let (info, _dir) = pane(&daemon, proto::AgentKind::Codex);
        drive(
            state.path(),
            "UserPromptSubmit",
            SLUG,
            info.id,
            f("codex-0.153.4-02-UserPromptSubmit.json"),
        )
        .await;

        let mut rx = daemon.observe();
        drive(
            state.path(),
            "PermissionRequest",
            SLUG,
            info.id,
            f("codex-0.153.4-04-PermissionRequest.json"),
        )
        .await;
        assert_eq!(
            next_status(&mut rx, info.id).await,
            proto::AgentStatus::NeedsInput
        );
        assert_eq!(
            houston_core::orchestrate::capability_note(proto::AgentKind::Codex),
            None,
            "codex reports a block; nothing is missing"
        );
    }

    #[tokio::test]
    async fn codex_request_user_input_blocks_until_its_tool_returns() {
        let _guard = serial().await;
        shim_dir();
        let (_addr, state, daemon) = start_daemon_with_handle().await;
        let (info, _dir) = pane(&daemon, proto::AgentKind::Codex);
        drive(
            state.path(),
            "UserPromptSubmit",
            SLUG,
            info.id,
            f("codex-0.153.4-02-UserPromptSubmit.json"),
        )
        .await;

        let mut rx = daemon.observe();
        drive(
            state.path(),
            "PreToolUse",
            SLUG,
            info.id,
            f("codex-docs-07-PreToolUse-request_user_input.json"),
        )
        .await;
        assert_eq!(
            next_status(&mut rx, info.id).await,
            proto::AgentStatus::NeedsInput
        );

        let unrelated = f("codex-docs-08-PostToolUse-request_user_input.json")
            .replace("request_user_input", "update_plan");
        drive(state.path(), "PostToolUse", SLUG, info.id, unrelated).await;
        assert_eq!(
            daemon.session_status(info.id).unwrap(),
            Some(proto::AgentStatus::NeedsInput),
            "an unrelated tool completion cannot dismiss the question"
        );

        drive(
            state.path(),
            "PostToolUse",
            SLUG,
            info.id,
            f("codex-docs-08-PostToolUse-request_user_input.json"),
        )
        .await;
        assert_eq!(
            next_status(&mut rx, info.id).await,
            proto::AgentStatus::Working,
            "answering request_user_input resumes the same turn"
        );
    }

    #[tokio::test]
    async fn codex_permission_request_needs_its_matching_bash_completion() {
        let _guard = serial().await;
        shim_dir();
        let (_addr, state, daemon) = start_daemon_with_handle().await;
        let (info, _dir) = pane(&daemon, proto::AgentKind::Codex);
        drive(
            state.path(),
            "UserPromptSubmit",
            SLUG,
            info.id,
            f("codex-0.153.4-02-UserPromptSubmit.json"),
        )
        .await;

        let mut rx = daemon.observe();
        drive(
            state.path(),
            "PermissionRequest",
            SLUG,
            info.id,
            f("codex-0.155.1-04-PermissionRequest-Bash.json"),
        )
        .await;
        assert_eq!(
            next_status(&mut rx, info.id).await,
            proto::AgentStatus::NeedsInput
        );

        let unrelated = f("codex-0.155.1-08-PostToolUse-Bash.json")
            .replace("cargo test --workspace", "bun run test");
        drive(state.path(), "PostToolUse", SLUG, info.id, unrelated).await;
        assert_eq!(
            daemon.session_status(info.id).unwrap(),
            Some(proto::AgentStatus::NeedsInput),
            "a Bash completion for another command cannot dismiss the permission"
        );

        drive(
            state.path(),
            "PostToolUse",
            SLUG,
            info.id,
            f("codex-0.155.1-08-PostToolUse-Bash.json"),
        )
        .await;
        assert_eq!(
            next_status(&mut rx, info.id).await,
            proto::AgentStatus::Working,
            "the matching Bash completion resumes the same turn"
        );
    }

    #[tokio::test]
    async fn codex_permission_commands_in_one_turn_resolve_independently() {
        let _guard = serial().await;
        shim_dir();
        let (_addr, state, daemon) = start_daemon_with_handle().await;
        let (info, _dir) = pane(&daemon, proto::AgentKind::Codex);
        drive(
            state.path(),
            "UserPromptSubmit",
            SLUG,
            info.id,
            f("codex-0.153.4-02-UserPromptSubmit.json"),
        )
        .await;

        let mut rx = daemon.observe();
        drive(
            state.path(),
            "PermissionRequest",
            SLUG,
            info.id,
            f("codex-0.155.1-04-PermissionRequest-Bash.json"),
        )
        .await;
        assert_eq!(
            next_status(&mut rx, info.id).await,
            proto::AgentStatus::NeedsInput
        );

        let permission_b = f("codex-0.155.1-04-PermissionRequest-Bash.json")
            .replace("cargo test --workspace", "bun run test");
        drive(
            state.path(),
            "PermissionRequest",
            SLUG,
            info.id,
            permission_b,
        )
        .await;
        assert_eq!(
            daemon.session_status(info.id).unwrap(),
            Some(proto::AgentStatus::NeedsInput),
            "a second Codex permission in the same turn keeps the pane blocked"
        );

        let completion_b = f("codex-0.155.1-08-PostToolUse-Bash.json")
            .replace("cargo test --workspace", "bun run test");
        drive(state.path(), "PostToolUse", SLUG, info.id, completion_b).await;
        assert_eq!(
            daemon.session_status(info.id).unwrap(),
            Some(proto::AgentStatus::NeedsInput),
            "completing B cannot dismiss A"
        );

        drive(
            state.path(),
            "PostToolUse",
            SLUG,
            info.id,
            f("codex-0.155.1-08-PostToolUse-Bash.json"),
        )
        .await;
        assert_eq!(
            next_status(&mut rx, info.id).await,
            proto::AgentStatus::Working,
            "completing A resumes the turn after B already completed"
        );
    }

    #[tokio::test]
    async fn codex_interrupt_returns_to_idle_without_completion() {
        let _guard = serial().await;
        shim_dir();
        let (_addr, state, daemon) = start_daemon_with_handle().await;
        let (info, _dir) = pane(&daemon, proto::AgentKind::Codex);

        drive(
            state.path(),
            "UserPromptSubmit",
            SLUG,
            info.id,
            f("codex-0.153.4-02-UserPromptSubmit.json"),
        )
        .await;
        assert_eq!(
            daemon.session_status(info.id).unwrap(),
            Some(proto::AgentStatus::Working)
        );

        let mut rx = daemon.observe();
        drive(
            state.path(),
            "Interrupt",
            SLUG,
            info.id,
            f("codex-docs-09-Interrupt.json"),
        )
        .await;
        assert_eq!(
            next_status(&mut rx, info.id).await,
            proto::AgentStatus::Idle
        );
        assert!(
            tokio::time::timeout(
                Duration::from_millis(150),
                common::next_broadcast_control(&mut rx),
            )
            .await
            .is_err(),
            "interrupting a turn must not announce a completed result"
        );
    }

    #[tokio::test]
    async fn codex_child_gets_pane_submit_and_workspace_info() {
        let _guard = serial().await;
        shim_dir();
        let (addr, _state, daemon) = start_daemon_with_handle().await;
        let dir = tempfile::tempdir().unwrap();
        daemon
            .workspace_add(&dir.path().display().to_string())
            .unwrap();
        daemon.orchestration_set(true).unwrap();

        let (parent, _parent_dir) = pane(&daemon, proto::AgentKind::Custom);
        let parent_workspace = parent.project_dir.clone();
        let parent_token = daemon.mcp_creds.issue(McpScope {
            session_id: parent.id,
            workspace_id: parent_workspace.clone(),
        });
        let (status, body) = orchestrate_spawn(
            addr,
            &parent_token,
            serde_json::json!({"kind": "codex", "prompt": "leaf brief"}),
        )
        .await;
        assert_eq!(status, 200, "spawn body: {body}");
        let child = body["session_id"].as_u64().unwrap() as u32;
        let child_token = daemon.mcp_creds.issue(McpScope {
            session_id: child,
            workspace_id: parent_workspace.clone(),
        });

        let res = mcp_call(
            addr,
            &child_token,
            serde_json::json!({"jsonrpc": "2.0", "id": 1, "method": "tools/list", "params": {}}),
        )
        .await;
        let tools = res["result"]["tools"]
            .as_array()
            .unwrap_or_else(|| panic!("no tools array: {res}"));
        let mut names: Vec<&str> = tools.iter().filter_map(|t| t["name"].as_str()).collect();
        names.sort_unstable();
        assert_eq!(
            names,
            vec!["call_tool", "list_tools"],
            "codex is gateway-served: {res}"
        );

        let call = |name: &'static str| {
            mcp_call(
                addr,
                &child_token,
                serde_json::json!({
                    "jsonrpc": "2.0", "id": 2, "method": "tools/call",
                    "params": {"name": "call_tool", "arguments": {"name": name, "args": {}}}
                }),
            )
        };

        let spawn_attempt = call("pane_spawn").await;
        assert_eq!(
            spawn_attempt["result"]["isError"], true,
            "a leaf must not reach pane_spawn through call_tool: {spawn_attempt}"
        );
        let text = spawn_attempt["result"]["content"][0]["text"]
            .as_str()
            .unwrap_or_default();
        assert!(
            text.contains("pane_submit") && text.contains("workspace_info"),
            "the refusal names the leaf's own two tools: {text}"
        );

        let info_attempt = call("workspace_info").await;
        assert_ne!(
            info_attempt["result"]["isError"], true,
            "workspace_info is one of the leaf's own two tools: {info_attempt}"
        );
    }

    #[tokio::test]
    async fn codex_interrupted_turn_and_broken_hook_file_do_not_strand_the_parent() {
        let _guard = serial().await;
        shim_dir();
        let (addr, state, daemon) = start_daemon_with_handle().await;
        let dir = tempfile::tempdir().unwrap();
        daemon
            .workspace_add(&dir.path().display().to_string())
            .unwrap();
        daemon.orchestration_set(true).unwrap();

        let (parent, _parent_dir) = pane(&daemon, proto::AgentKind::Custom);
        let parent_workspace = parent.project_dir.clone();
        let parent_token = daemon.mcp_creds.issue(McpScope {
            session_id: parent.id,
            workspace_id: parent_workspace.clone(),
        });
        let (status, body) = orchestrate_spawn(
            addr,
            &parent_token,
            serde_json::json!({"kind": "codex", "prompt": "will be interrupted"}),
        )
        .await;
        assert_eq!(status, 200, "spawn body: {body}");
        let child = body["session_id"].as_u64().unwrap() as u32;

        drive(
            state.path(),
            "UserPromptSubmit",
            SLUG,
            child,
            f("codex-0.153.4-02-UserPromptSubmit.json"),
        )
        .await;
        assert_eq!(
            daemon.session_status(child).unwrap(),
            Some(proto::AgentStatus::Working)
        );

        let garbage_dir = houston_core::hook_drop::drop_dir(state.path());
        std::fs::create_dir_all(&garbage_dir).unwrap();
        std::fs::write(
            garbage_dir.join(format!("{}-000000-000000.json", child)),
            b"{ not json",
        )
        .unwrap();
        tokio::time::sleep(Duration::from_millis(300)).await;

        drive(
            state.path(),
            "SubagentStart",
            SLUG,
            child,
            f("codex-0.153.4-05-SubagentStart.json"),
        )
        .await;
        assert_eq!(
            daemon.session_status(child).unwrap(),
            Some(proto::AgentStatus::Working),
            "the daemon is still alive and applying this session's drops"
        );

        daemon
            .session_kill_checked(child, false)
            .expect("session_kill_checked");
        let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
        loop {
            let rows = daemon.inbox_rows_for_test(parent.id);
            if rows
                .iter()
                .any(|r| r.kind == "exited" || r.kind == "operator_note")
            {
                break;
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "the parent never learned its child was killed mid-turn: {rows:?}"
            );
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }
}

mod opencode {
    use super::*;

    const SLUG: &str = "opencode";

    fn f(name: &str) -> String {
        fixture("opencode", name)
    }

    #[tokio::test]
    async fn opencode_turn_end_is_one_row() {
        let _guard = serial().await;
        let (_addr, state, daemon) = start_daemon_with_handle().await;
        let (info, _dir) = pane(&daemon, proto::AgentKind::Opencode);

        drive(
            state.path(),
            "session.created",
            SLUG,
            info.id,
            f("opencode-1.18.27-01-session.created.json"),
        )
        .await;
        assert_eq!(
            daemon.session_status(info.id).unwrap(),
            Some(proto::AgentStatus::Idle)
        );

        drive(
            state.path(),
            "message.updated",
            SLUG,
            info.id,
            f("opencode-1.18.27-02-message.updated.json"),
        )
        .await;
        assert_eq!(
            daemon.session_status(info.id).unwrap(),
            Some(proto::AgentStatus::Working)
        );

        drive(
            state.path(),
            "SubagentStop",
            SLUG,
            info.id,
            f("opencode-1.18.27-05-SubagentStop.json"),
        )
        .await;
        assert_eq!(
            daemon.session_status(info.id).unwrap(),
            Some(proto::AgentStatus::Working),
            "a child session's own idle must not move the pane"
        );

        let mut rx = daemon.observe();
        drive(
            state.path(),
            "session.idle",
            SLUG,
            info.id,
            f("opencode-1.18.27-03-session.idle.json"),
        )
        .await;
        let mut saw_idle = 0;
        let mut saw_finished = 0;
        let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
        while tokio::time::Instant::now() < deadline && saw_finished == 0 {
            match tokio::time::timeout(
                Duration::from_millis(200),
                common::next_broadcast_control(&mut rx),
            )
            .await
            {
                Ok(proto::ServerMsg::AgentStatus { session, status }) if session == info.id => {
                    assert_eq!(status, proto::AgentStatus::Idle);
                    saw_idle += 1;
                }
                Ok(proto::ServerMsg::AgentNotice { session, kind }) if session == info.id => {
                    assert_eq!(kind, proto::AgentNoticeKind::Finished);
                    saw_finished += 1;
                }
                Ok(proto::ServerMsg::Error { message, .. }) => panic!("daemon error: {message}"),
                Ok(_) => continue,
                Err(_) => break,
            }
        }
        assert_eq!(
            saw_idle, 1,
            "exactly one turn end, not one per correlation event"
        );
        assert_eq!(saw_finished, 1, "exactly one Finished notice");
    }

    #[tokio::test]
    async fn opencode_block_is_reported_or_named_as_missing() {
        let _guard = serial().await;
        let (_addr, state, daemon) = start_daemon_with_handle().await;
        let (info, _dir) = pane(&daemon, proto::AgentKind::Opencode);
        drive(
            state.path(),
            "message.updated",
            SLUG,
            info.id,
            f("opencode-1.18.27-02-message.updated.json"),
        )
        .await;

        let mut rx = daemon.observe();
        drive(
            state.path(),
            "permission.asked",
            SLUG,
            info.id,
            f("opencode-1.18.27-04-permission.asked.json"),
        )
        .await;
        assert_eq!(
            next_status(&mut rx, info.id).await,
            proto::AgentStatus::NeedsInput
        );
        drive(
            state.path(),
            "permission.replied",
            SLUG,
            info.id,
            r#"{"session_id":"ses_root01"}"#.to_string(),
        )
        .await;
        assert_eq!(
            next_status(&mut rx, info.id).await,
            proto::AgentStatus::Working,
            "answering a permission resumes the same turn"
        );
        let note = houston_core::orchestrate::capability_note(proto::AgentKind::Opencode);
        assert!(
            !note.as_deref().unwrap_or_default().contains("a block"),
            "opencode reports a block; the note must not claim it cannot: {note:?}"
        );
    }

    #[tokio::test]
    async fn opencode_question_blocks_until_answered() {
        let _guard = serial().await;
        let (_addr, state, daemon) = start_daemon_with_handle().await;
        let (info, _dir) = pane(&daemon, proto::AgentKind::Opencode);
        drive(
            state.path(),
            "message.updated",
            SLUG,
            info.id,
            f("opencode-1.18.27-02-message.updated.json"),
        )
        .await;

        let mut rx = daemon.observe();
        drive(
            state.path(),
            "question.asked",
            SLUG,
            info.id,
            f("opencode-1.18.31-06-question.asked.json"),
        )
        .await;
        assert_eq!(
            next_status(&mut rx, info.id).await,
            proto::AgentStatus::NeedsInput
        );
        drive(
            state.path(),
            "question.replied",
            SLUG,
            info.id,
            f("opencode-1.18.31-07-question.replied.json"),
        )
        .await;
        assert_eq!(
            next_status(&mut rx, info.id).await,
            proto::AgentStatus::Working
        );
    }

    #[tokio::test]
    async fn opencode_stays_blocked_until_every_keyed_request_is_answered() {
        let _guard = serial().await;
        let (_addr, state, daemon) = start_daemon_with_handle().await;
        let (info, _dir) = pane(&daemon, proto::AgentKind::Opencode);
        drive(
            state.path(),
            "message.updated",
            SLUG,
            info.id,
            f("opencode-1.18.27-02-message.updated.json"),
        )
        .await;

        let mut rx = daemon.observe();
        drive(
            state.path(),
            "permission.asked",
            SLUG,
            info.id,
            r#"{"session_id":"ses_child01","request_id":"permission-1","message":"bash"}"#
                .to_string(),
        )
        .await;
        assert_eq!(
            next_status(&mut rx, info.id).await,
            proto::AgentStatus::NeedsInput
        );
        drive(
            state.path(),
            "question.asked",
            SLUG,
            info.id,
            r#"{"session_id":"ses_child02","request_id":"question-1","message":"Choose"}"#
                .to_string(),
        )
        .await;
        drive(
            state.path(),
            "session.status",
            SLUG,
            info.id,
            r#"{"session_id":"ses_root01"}"#.to_string(),
        )
        .await;
        assert_eq!(
            daemon.session_status(info.id).unwrap(),
            Some(proto::AgentStatus::NeedsInput),
            "a provider busy pulse must not obscure a pending human request"
        );
        drive(
            state.path(),
            "permission.replied",
            SLUG,
            info.id,
            r#"{"session_id":"ses_child01","request_id":"permission-1"}"#.to_string(),
        )
        .await;
        assert!(
            tokio::time::timeout(Duration::from_millis(150), next_status(&mut rx, info.id))
                .await
                .is_err(),
            "resolving one request must not hide another open question"
        );
        assert_eq!(
            daemon.session_status(info.id).unwrap(),
            Some(proto::AgentStatus::NeedsInput)
        );

        drive(
            state.path(),
            "question.replied",
            SLUG,
            info.id,
            r#"{"session_id":"ses_child02","request_id":"question-1"}"#.to_string(),
        )
        .await;
        assert_eq!(
            next_status(&mut rx, info.id).await,
            proto::AgentStatus::Working
        );
    }

    #[tokio::test]
    async fn opencode_status_and_error_are_authoritative_without_duplicate_completion() {
        let _guard = serial().await;
        let (_addr, state, daemon) = start_daemon_with_handle().await;
        let (info, _dir) = pane(&daemon, proto::AgentKind::Opencode);
        let mut rx = daemon.observe();

        drive(
            state.path(),
            "session.status",
            SLUG,
            info.id,
            r#"{"session_id":"ses_root01"}"#.to_string(),
        )
        .await;
        assert_eq!(
            next_status(&mut rx, info.id).await,
            proto::AgentStatus::Working
        );

        drive(
            state.path(),
            "session.error",
            SLUG,
            info.id,
            f("opencode-1.18.31-08-session.error.json"),
        )
        .await;
        let mut saw_idle = false;
        let mut saw_error = false;
        while !(saw_idle && saw_error) {
            match common::next_broadcast_control(&mut rx).await {
                proto::ServerMsg::AgentStatus { session, status } if session == info.id => {
                    assert_eq!(status, proto::AgentStatus::Idle);
                    saw_idle = true;
                }
                proto::ServerMsg::AgentNotice { session, kind } if session == info.id => {
                    assert_eq!(kind, proto::AgentNoticeKind::Error);
                    saw_error = true;
                }
                proto::ServerMsg::Error { message, .. } => panic!("daemon error: {message}"),
                _ => continue,
            }
        }

        drive(
            state.path(),
            "session.idle",
            SLUG,
            info.id,
            f("opencode-1.18.27-03-session.idle.json"),
        )
        .await;
        assert!(
            tokio::time::timeout(
                Duration::from_millis(150),
                common::next_broadcast_control(&mut rx),
            )
            .await
            .is_err(),
            "the legacy idle emitted after session.error must not create a second notice"
        );
    }

    #[tokio::test]
    async fn opencode_child_gets_pane_submit_and_workspace_info() {
        let _guard = serial().await;
        shim_dir();
        let (addr, _state, daemon) = start_daemon_with_handle().await;
        let dir = tempfile::tempdir().unwrap();
        daemon
            .workspace_add(&dir.path().display().to_string())
            .unwrap();
        daemon.orchestration_set(true).unwrap();

        let (parent, _parent_dir) = pane(&daemon, proto::AgentKind::Custom);
        let parent_workspace = parent.project_dir.clone();
        let parent_token = daemon.mcp_creds.issue(McpScope {
            session_id: parent.id,
            workspace_id: parent_workspace.clone(),
        });
        let (status, body) = orchestrate_spawn(
            addr,
            &parent_token,
            serde_json::json!({"kind": "opencode", "prompt": "leaf brief"}),
        )
        .await;
        assert_eq!(status, 200, "spawn body: {body}");
        let child = body["session_id"].as_u64().unwrap() as u32;
        let child_token = daemon.mcp_creds.issue(McpScope {
            session_id: child,
            workspace_id: parent_workspace.clone(),
        });

        let res = mcp_call(
            addr,
            &child_token,
            serde_json::json!({"jsonrpc": "2.0", "id": 1, "method": "tools/list", "params": {}}),
        )
        .await;
        let tools = res["result"]["tools"]
            .as_array()
            .unwrap_or_else(|| panic!("no tools array: {res}"));
        let mut names: Vec<&str> = tools.iter().filter_map(|t| t["name"].as_str()).collect();
        names.sort_unstable();
        assert_eq!(names, vec!["pane_submit", "workspace_info"], "{res}");
    }

    #[tokio::test]
    async fn opencode_interrupted_turn_and_broken_hook_file_do_not_strand_the_parent() {
        let _guard = serial().await;
        shim_dir();
        let (addr, state, daemon) = start_daemon_with_handle().await;
        let dir = tempfile::tempdir().unwrap();
        daemon
            .workspace_add(&dir.path().display().to_string())
            .unwrap();
        daemon.orchestration_set(true).unwrap();

        let (parent, _parent_dir) = pane(&daemon, proto::AgentKind::Custom);
        let parent_workspace = parent.project_dir.clone();
        let parent_token = daemon.mcp_creds.issue(McpScope {
            session_id: parent.id,
            workspace_id: parent_workspace.clone(),
        });
        let (status, body) = orchestrate_spawn(
            addr,
            &parent_token,
            serde_json::json!({"kind": "opencode", "prompt": "will be interrupted"}),
        )
        .await;
        assert_eq!(status, 200, "spawn body: {body}");
        let child = body["session_id"].as_u64().unwrap() as u32;

        drive(
            state.path(),
            "message.updated",
            SLUG,
            child,
            f("opencode-1.18.27-02-message.updated.json"),
        )
        .await;
        assert_eq!(
            daemon.session_status(child).unwrap(),
            Some(proto::AgentStatus::Working)
        );

        let garbage_dir = houston_core::hook_drop::drop_dir(state.path());
        std::fs::create_dir_all(&garbage_dir).unwrap();
        std::fs::write(
            garbage_dir.join(format!("{}-000000-000000.json", child)),
            b"{ not json",
        )
        .unwrap();
        tokio::time::sleep(Duration::from_millis(300)).await;

        drive(
            state.path(),
            "SubagentStop",
            SLUG,
            child,
            f("opencode-1.18.27-05-SubagentStop.json"),
        )
        .await;
        assert_eq!(
            daemon.session_status(child).unwrap(),
            Some(proto::AgentStatus::Working),
            "the daemon is still alive and applying this session's drops"
        );

        daemon
            .session_kill_checked(child, false)
            .expect("session_kill_checked");
        let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
        loop {
            let rows = daemon.inbox_rows_for_test(parent.id);
            if rows
                .iter()
                .any(|r| r.kind == "exited" || r.kind == "operator_note")
            {
                break;
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "the parent never learned its child was killed mid-turn: {rows:?}"
            );
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }
}

async fn run_claude_path_hook_with_env(event: &str, session: u32, extra_env: &[(&str, &str)]) {
    let home = tempfile::tempdir().unwrap();
    let (event, extra_env) = (
        event.to_string(),
        extra_env
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect::<Vec<_>>(),
    );
    let home_path = home.path().to_path_buf();
    tokio::task::spawn_blocking(move || {
        let mut cmd = houston_core::spawn::command(helper_bin());
        cmd.arg("hook").arg(&event).arg("--houston-managed");
        cmd.env_clear();
        cmd.env("HOME", &home_path);
        cmd.env("HOUSTON_CHANNEL", "paritytest");
        cmd.env("TR_SESSION", session.to_string());
        for (k, v) in &extra_env {
            cmd.env(k, v);
        }
        cmd.stdin(std::process::Stdio::piped());
        cmd.stdout(std::process::Stdio::null());
        cmd.stderr(std::process::Stdio::piped());
        let mut child = cmd.spawn().expect("spawning the hook helper");
        child.stdin.as_mut().unwrap().write_all(b"{}").unwrap();
        drop(child.stdin.take());
        let out = child.wait_with_output().unwrap();
        assert!(
            out.status.success(),
            "hook {event}: helper exited {:?}: {}",
            out.status,
            String::from_utf8_lossy(&out.stderr)
        );
        let dir = houston_core::hook_drop::drop_dir(&home_path.join(".houston-paritytest"));
        let names: Vec<String> = std::fs::read_dir(&dir)
            .map(|it| {
                it.flatten()
                    .filter_map(|e| e.file_name().to_str().map(String::from))
                    .filter(|n| houston_core::hook_drop::parse_drop_name(n).is_some())
                    .collect()
            })
            .unwrap_or_default();
        assert!(
            names.is_empty(),
            "expected no drop written, found: {names:?}"
        );
    })
    .await
    .expect("the helper run must not panic");
}

mod grok {
    use super::*;

    const SLUG: &str = "grok";

    fn f(name: &str) -> String {
        fixture("grok", name)
    }

    #[tokio::test]
    async fn grok_turn_end_is_one_row() {
        let _guard = serial().await;
        let (_addr, state, daemon) = start_daemon_with_handle().await;
        let (info, _dir) = pane(&daemon, proto::AgentKind::Grok);

        drive(
            state.path(),
            "SessionStart",
            SLUG,
            info.id,
            f("grok-docs-01-SessionStart.json"),
        )
        .await;
        assert_eq!(
            daemon.session_status(info.id).unwrap(),
            Some(proto::AgentStatus::Idle)
        );

        drive(
            state.path(),
            "UserPromptSubmit",
            SLUG,
            info.id,
            f("grok-docs-02-UserPromptSubmit.json"),
        )
        .await;
        assert_eq!(
            daemon.session_status(info.id).unwrap(),
            Some(proto::AgentStatus::Working)
        );

        drive(
            state.path(),
            "SubagentStart",
            SLUG,
            info.id,
            f("grok-docs-05-SubagentStart.json"),
        )
        .await;
        assert_eq!(
            daemon.session_status(info.id).unwrap(),
            Some(proto::AgentStatus::Working),
            "SubagentStart must not move the pane"
        );
        drive(
            state.path(),
            "SubagentStop",
            SLUG,
            info.id,
            f("grok-docs-06-SubagentStop.json"),
        )
        .await;
        assert_eq!(
            daemon.session_status(info.id).unwrap(),
            Some(proto::AgentStatus::Working),
            "SubagentStop must not move the pane"
        );

        let mut rx = daemon.observe();
        drive(
            state.path(),
            "Stop",
            SLUG,
            info.id,
            f("grok-docs-03-Stop.json"),
        )
        .await;
        let mut saw_idle = 0;
        let mut saw_finished = 0;
        let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
        while tokio::time::Instant::now() < deadline && saw_finished == 0 {
            match tokio::time::timeout(
                Duration::from_millis(200),
                common::next_broadcast_control(&mut rx),
            )
            .await
            {
                Ok(proto::ServerMsg::AgentStatus { session, status }) if session == info.id => {
                    assert_eq!(status, proto::AgentStatus::Idle);
                    saw_idle += 1;
                }
                Ok(proto::ServerMsg::AgentNotice { session, kind }) if session == info.id => {
                    assert_eq!(kind, proto::AgentNoticeKind::Finished);
                    saw_finished += 1;
                }
                Ok(proto::ServerMsg::Error { message, .. }) => panic!("daemon error: {message}"),
                Ok(_) => continue,
                Err(_) => break,
            }
        }
        assert_eq!(
            saw_idle, 1,
            "exactly one turn end, not one per correlation event"
        );
        assert_eq!(saw_finished, 1, "exactly one Finished notice");
    }

    #[tokio::test]
    async fn grok_block_is_reported_or_named_as_missing() {
        let _guard = serial().await;
        let (_addr, state, daemon) = start_daemon_with_handle().await;
        let (info, _dir) = pane(&daemon, proto::AgentKind::Grok);
        drive(
            state.path(),
            "UserPromptSubmit",
            SLUG,
            info.id,
            f("grok-docs-02-UserPromptSubmit.json"),
        )
        .await;

        let mut rx = daemon.observe();
        drive(
            state.path(),
            "Notification",
            SLUG,
            info.id,
            f("grok-docs-04-Notification.json"),
        )
        .await;
        assert_eq!(
            next_status(&mut rx, info.id).await,
            proto::AgentStatus::NeedsInput
        );
        let note = houston_core::orchestrate::capability_note(proto::AgentKind::Grok);
        assert!(
            !note.as_deref().unwrap_or_default().contains("a block"),
            "grok reports a block; the note must not claim it cannot: {note:?}"
        );
    }

    #[tokio::test]
    async fn grok_child_gets_pane_submit_and_workspace_info() {
        let _guard = serial().await;
        shim_dir();
        let (addr, _state, daemon) = start_daemon_with_handle().await;
        let dir = tempfile::tempdir().unwrap();
        daemon
            .workspace_add(&dir.path().display().to_string())
            .unwrap();
        daemon.orchestration_set(true).unwrap();

        let (parent, _parent_dir) = pane(&daemon, proto::AgentKind::Custom);
        let parent_workspace = parent.project_dir.clone();
        let parent_token = daemon.mcp_creds.issue(McpScope {
            session_id: parent.id,
            workspace_id: parent_workspace.clone(),
        });
        let (status, body) = orchestrate_spawn(
            addr,
            &parent_token,
            serde_json::json!({"kind": "grok", "prompt": "leaf brief"}),
        )
        .await;
        assert_eq!(status, 200, "spawn body: {body}");
        let child = body["session_id"].as_u64().unwrap() as u32;
        let child_token = daemon.mcp_creds.issue(McpScope {
            session_id: child,
            workspace_id: parent_workspace.clone(),
        });

        let res = mcp_call(
            addr,
            &child_token,
            serde_json::json!({"jsonrpc": "2.0", "id": 1, "method": "tools/list", "params": {}}),
        )
        .await;
        let tools = res["result"]["tools"]
            .as_array()
            .unwrap_or_else(|| panic!("no tools array: {res}"));
        let mut names: Vec<&str> = tools.iter().filter_map(|t| t["name"].as_str()).collect();
        names.sort_unstable();
        assert_eq!(names, vec!["pane_submit", "workspace_info"], "{res}");
    }

    #[tokio::test]
    async fn grok_interrupted_turn_and_broken_hook_file_do_not_strand_the_parent() {
        let _guard = serial().await;
        shim_dir();
        let (addr, state, daemon) = start_daemon_with_handle().await;
        let dir = tempfile::tempdir().unwrap();
        daemon
            .workspace_add(&dir.path().display().to_string())
            .unwrap();
        daemon.orchestration_set(true).unwrap();

        let (parent, _parent_dir) = pane(&daemon, proto::AgentKind::Custom);
        let parent_workspace = parent.project_dir.clone();
        let parent_token = daemon.mcp_creds.issue(McpScope {
            session_id: parent.id,
            workspace_id: parent_workspace.clone(),
        });
        let (status, body) = orchestrate_spawn(
            addr,
            &parent_token,
            serde_json::json!({"kind": "grok", "prompt": "will be interrupted"}),
        )
        .await;
        assert_eq!(status, 200, "spawn body: {body}");
        let child = body["session_id"].as_u64().unwrap() as u32;

        drive(
            state.path(),
            "UserPromptSubmit",
            SLUG,
            child,
            f("grok-docs-02-UserPromptSubmit.json"),
        )
        .await;
        assert_eq!(
            daemon.session_status(child).unwrap(),
            Some(proto::AgentStatus::Working)
        );

        let garbage_dir = houston_core::hook_drop::drop_dir(state.path());
        std::fs::create_dir_all(&garbage_dir).unwrap();
        std::fs::write(
            garbage_dir.join(format!("{}-000000-000000.json", child)),
            b"{ not json",
        )
        .unwrap();
        tokio::time::sleep(Duration::from_millis(300)).await;

        drive(
            state.path(),
            "SubagentStart",
            SLUG,
            child,
            f("grok-docs-05-SubagentStart.json"),
        )
        .await;
        assert_eq!(
            daemon.session_status(child).unwrap(),
            Some(proto::AgentStatus::Working),
            "the daemon is still alive and applying this session's drops"
        );

        daemon
            .session_kill_checked(child, false)
            .expect("session_kill_checked");
        let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
        loop {
            let rows = daemon.inbox_rows_for_test(parent.id);
            if rows
                .iter()
                .any(|r| r.kind == "exited" || r.kind == "operator_note")
            {
                break;
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "the parent never learned its child was killed mid-turn: {rows:?}"
            );
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }

    #[tokio::test]
    async fn a_claude_hook_fired_by_grok_writes_nothing() {
        let _guard = serial().await;
        let (_addr, _state, daemon) = start_daemon_with_handle().await;
        let (info, _dir) = pane(&daemon, proto::AgentKind::Grok);
        run_claude_path_hook_with_env("Stop", info.id, &[("GROK_SESSION_ID", "sess-grok-docs-01")])
            .await;
    }
}

mod cursor {
    use super::*;

    const SLUG: &str = "cursor";

    fn f(name: &str) -> String {
        fixture("cursor", name)
    }

    #[tokio::test]
    async fn cursor_turn_end_is_one_row() {
        let _guard = serial().await;
        let (_addr, state, daemon) = start_daemon_with_handle().await;
        let (info, _dir) = pane(&daemon, proto::AgentKind::Cursor);

        drive(
            state.path(),
            "sessionStart",
            SLUG,
            info.id,
            f("cursor-docs-01-sessionStart.json"),
        )
        .await;
        assert_eq!(
            daemon.session_status(info.id).unwrap(),
            Some(proto::AgentStatus::Idle)
        );

        drive(
            state.path(),
            "beforeSubmitPrompt",
            SLUG,
            info.id,
            f("cursor-docs-02-beforeSubmitPrompt.json"),
        )
        .await;
        assert_eq!(
            daemon.session_status(info.id).unwrap(),
            Some(proto::AgentStatus::Working)
        );

        drive(
            state.path(),
            "subagentStart",
            SLUG,
            info.id,
            f("cursor-docs-05-subagentStart.json"),
        )
        .await;
        assert_eq!(
            daemon.session_status(info.id).unwrap(),
            Some(proto::AgentStatus::Working),
            "subagentStart must not move the pane"
        );
        drive(
            state.path(),
            "subagentStop",
            SLUG,
            info.id,
            f("cursor-docs-06-subagentStop.json"),
        )
        .await;
        assert_eq!(
            daemon.session_status(info.id).unwrap(),
            Some(proto::AgentStatus::Working),
            "subagentStop must not move the pane"
        );
        drive(
            state.path(),
            "afterAgentResponse",
            SLUG,
            info.id,
            f("cursor-docs-04-afterAgentResponse.json"),
        )
        .await;
        assert_eq!(
            daemon.session_status(info.id).unwrap(),
            Some(proto::AgentStatus::Working),
            "afterAgentResponse fires after every assistant message, not only the turn's last one"
        );

        let mut rx = daemon.observe();
        drive(
            state.path(),
            "stop",
            SLUG,
            info.id,
            f("cursor-docs-03-stop.json"),
        )
        .await;
        let mut saw_idle = 0;
        let mut saw_finished = 0;
        let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
        while tokio::time::Instant::now() < deadline && saw_finished == 0 {
            match tokio::time::timeout(
                Duration::from_millis(200),
                common::next_broadcast_control(&mut rx),
            )
            .await
            {
                Ok(proto::ServerMsg::AgentStatus { session, status }) if session == info.id => {
                    assert_eq!(status, proto::AgentStatus::Idle);
                    saw_idle += 1;
                }
                Ok(proto::ServerMsg::AgentNotice { session, kind }) if session == info.id => {
                    assert_eq!(kind, proto::AgentNoticeKind::Finished);
                    saw_finished += 1;
                }
                Ok(proto::ServerMsg::Error { message, .. }) => panic!("daemon error: {message}"),
                Ok(_) => continue,
                Err(_) => break,
            }
        }
        assert_eq!(
            saw_idle, 1,
            "exactly one turn end, not one per correlation event"
        );
        assert_eq!(saw_finished, 1, "exactly one Finished notice");
    }

    #[tokio::test]
    async fn cursor_block_is_reported_or_named_as_missing() {
        let _guard = serial().await;
        let events = houston_core::agent_events::events_for(proto::AgentKind::Cursor);
        assert!(
            !events
                .iter()
                .any(|(_, ev)| *ev == houston_core::agent_events::AgentEvent::NeedsInput),
            "cursor has no NeedsInput row in its own event table: {events:?}"
        );
        let note = houston_core::orchestrate::capability_note(proto::AgentKind::Cursor);
        assert!(
            note.as_deref()
                .unwrap_or_default()
                .contains("cannot report a block"),
            "cursor cannot report a block; the note must say so: {note:?}"
        );
    }

    #[tokio::test]
    async fn cursor_child_gets_pane_submit_and_workspace_info() {
        let _guard = serial().await;
        shim_dir();
        let (addr, _state, daemon) = start_daemon_with_handle().await;
        let dir = tempfile::tempdir().unwrap();
        daemon
            .workspace_add(&dir.path().display().to_string())
            .unwrap();
        daemon.orchestration_set(true).unwrap();

        let (parent, _parent_dir) = pane(&daemon, proto::AgentKind::Custom);
        let parent_workspace = parent.project_dir.clone();
        let parent_token = daemon.mcp_creds.issue(McpScope {
            session_id: parent.id,
            workspace_id: parent_workspace.clone(),
        });
        let (status, body) = orchestrate_spawn(
            addr,
            &parent_token,
            serde_json::json!({"kind": "cursor", "prompt": "leaf brief"}),
        )
        .await;
        assert_eq!(status, 200, "spawn body: {body}");
        let child = body["session_id"].as_u64().unwrap() as u32;
        let child_token = daemon.mcp_creds.issue(McpScope {
            session_id: child,
            workspace_id: parent_workspace.clone(),
        });

        let res = mcp_call(
            addr,
            &child_token,
            serde_json::json!({"jsonrpc": "2.0", "id": 1, "method": "tools/list", "params": {}}),
        )
        .await;
        let tools = res["result"]["tools"]
            .as_array()
            .unwrap_or_else(|| panic!("no tools array: {res}"));
        let mut names: Vec<&str> = tools.iter().filter_map(|t| t["name"].as_str()).collect();
        names.sort_unstable();
        assert_eq!(names, vec!["pane_submit", "workspace_info"], "{res}");
    }

    #[tokio::test]
    async fn cursor_interrupted_turn_and_broken_hook_file_do_not_strand_the_parent() {
        let _guard = serial().await;
        shim_dir();
        let (addr, state, daemon) = start_daemon_with_handle().await;
        let dir = tempfile::tempdir().unwrap();
        daemon
            .workspace_add(&dir.path().display().to_string())
            .unwrap();
        daemon.orchestration_set(true).unwrap();

        let (parent, _parent_dir) = pane(&daemon, proto::AgentKind::Custom);
        let parent_workspace = parent.project_dir.clone();
        let parent_token = daemon.mcp_creds.issue(McpScope {
            session_id: parent.id,
            workspace_id: parent_workspace.clone(),
        });
        let (status, body) = orchestrate_spawn(
            addr,
            &parent_token,
            serde_json::json!({"kind": "cursor", "prompt": "will be interrupted"}),
        )
        .await;
        assert_eq!(status, 200, "spawn body: {body}");
        let child = body["session_id"].as_u64().unwrap() as u32;

        drive(
            state.path(),
            "beforeSubmitPrompt",
            SLUG,
            child,
            f("cursor-docs-02-beforeSubmitPrompt.json"),
        )
        .await;
        assert_eq!(
            daemon.session_status(child).unwrap(),
            Some(proto::AgentStatus::Working)
        );

        let garbage_dir = houston_core::hook_drop::drop_dir(state.path());
        std::fs::create_dir_all(&garbage_dir).unwrap();
        std::fs::write(
            garbage_dir.join(format!("{}-000000-000000.json", child)),
            b"{ not json",
        )
        .unwrap();
        tokio::time::sleep(Duration::from_millis(300)).await;

        drive(
            state.path(),
            "subagentStart",
            SLUG,
            child,
            f("cursor-docs-05-subagentStart.json"),
        )
        .await;
        assert_eq!(
            daemon.session_status(child).unwrap(),
            Some(proto::AgentStatus::Working),
            "the daemon is still alive and applying this session's drops"
        );

        daemon
            .session_kill_checked(child, false)
            .expect("session_kill_checked");
        let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
        loop {
            let rows = daemon.inbox_rows_for_test(parent.id);
            if rows
                .iter()
                .any(|r| r.kind == "exited" || r.kind == "operator_note")
            {
                break;
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "the parent never learned its child was killed mid-turn: {rows:?}"
            );
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }
}

mod antigravity {
    use super::*;

    const SLUG: &str = "antigravity";

    fn f_with_transcript(name: &str, transcript: &Path) -> String {
        let mut v: serde_json::Value =
            serde_json::from_str(&fixture("antigravity", name)).expect("fixture parses");
        v["transcriptPath"] = serde_json::json!(transcript.display().to_string());
        v.to_string()
    }

    fn write_transcript(dir: &tempfile::TempDir, last_message: &str) -> PathBuf {
        static SEQ: std::sync::OnceLock<std::sync::atomic::AtomicUsize> =
            std::sync::OnceLock::new();
        let n = SEQ
            .get_or_init(|| std::sync::atomic::AtomicUsize::new(0))
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let path = dir.path().join(format!("transcript-{n}.jsonl"));
        std::fs::write(
            &path,
            format!(
                "{{\"role\":\"user\",\"content\":\"hi\"}}\n\
             {{\"role\":\"assistant\",\"content\":\"{last_message}\"}}\n"
            ),
        )
        .expect("writing the transcript");
        path
    }

    #[tokio::test]
    async fn antigravity_turn_end_is_one_row() {
        let _guard = serial().await;
        let (_addr, state, daemon) = start_daemon_with_handle().await;
        let (info, _dir) = pane(&daemon, proto::AgentKind::Antigravity);
        let transcript_dir = tempfile::tempdir().unwrap();
        let transcript = write_transcript(&transcript_dir, "root turn done");

        drive(
            state.path(),
            "SessionStart",
            SLUG,
            info.id,
            f_with_transcript("antigravity-1.1.26-01-SessionStart.json", &transcript),
        )
        .await;
        assert_eq!(
            daemon.session_status(info.id).unwrap(),
            Some(proto::AgentStatus::Idle)
        );

        drive(
            state.path(),
            "PreInvocation",
            SLUG,
            info.id,
            f_with_transcript("antigravity-1.1.26-02-PreInvocation.json", &transcript),
        )
        .await;
        assert_eq!(
            daemon.session_status(info.id).unwrap(),
            Some(proto::AgentStatus::Working)
        );

        let sub_transcript = write_transcript(&transcript_dir, "sub turn done");
        drive(
            state.path(),
            "SessionStart",
            SLUG,
            info.id,
            f_with_transcript(
                "antigravity-1.1.26-07-SessionStart-subagent.json",
                &sub_transcript,
            ),
        )
        .await;
        assert_eq!(
            daemon.session_status(info.id).unwrap(),
            Some(proto::AgentStatus::Working),
            "a sub-agent's own SessionStart must not move the root pane"
        );
        drive(
            state.path(),
            "Stop",
            SLUG,
            info.id,
            f_with_transcript("antigravity-1.1.26-08-Stop-subagent.json", &sub_transcript),
        )
        .await;
        assert_eq!(
            daemon.session_status(info.id).unwrap(),
            Some(proto::AgentStatus::Working),
            "a sub-agent's own Stop must not move the root pane"
        );

        drive(
            state.path(),
            "Stop",
            SLUG,
            info.id,
            f_with_transcript("antigravity-1.1.26-09-Stop-parked.json", &transcript),
        )
        .await;
        assert_eq!(
            daemon.session_status(info.id).unwrap(),
            Some(proto::AgentStatus::Working),
            "fullyIdle:false must not end the turn"
        );

        let mut rx = daemon.observe();
        drive(
            state.path(),
            "Stop",
            SLUG,
            info.id,
            f_with_transcript("antigravity-1.1.26-03-Stop.json", &transcript),
        )
        .await;
        let mut saw_idle = 0;
        let mut saw_finished = 0;
        let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
        while tokio::time::Instant::now() < deadline && saw_finished == 0 {
            match tokio::time::timeout(
                Duration::from_millis(200),
                common::next_broadcast_control(&mut rx),
            )
            .await
            {
                Ok(proto::ServerMsg::AgentStatus { session, status }) if session == info.id => {
                    assert_eq!(status, proto::AgentStatus::Idle);
                    saw_idle += 1;
                }
                Ok(proto::ServerMsg::AgentNotice { session, kind }) if session == info.id => {
                    assert_eq!(kind, proto::AgentNoticeKind::Finished);
                    saw_finished += 1;
                }
                Ok(proto::ServerMsg::Error { message, .. }) => panic!("daemon error: {message}"),
                Ok(_) => continue,
                Err(_) => break,
            }
        }
        assert_eq!(
            saw_idle, 1,
            "exactly one turn end, not one per sub-agent or parked Stop"
        );
        assert_eq!(saw_finished, 1, "exactly one Finished notice");
        assert_eq!(
            daemon.last_hook_message(info.id).as_deref(),
            Some("root turn done"),
            "the last message reached the daemon from the CLI's own transcript file, \
             never the screen"
        );
    }

    #[tokio::test]
    async fn antigravity_block_is_reported_or_named_as_missing() {
        let _guard = serial().await;
        let (_addr, state, daemon) = start_daemon_with_handle().await;
        let (info, _dir) = pane(&daemon, proto::AgentKind::Antigravity);
        let transcript_dir = tempfile::tempdir().unwrap();
        let transcript = write_transcript(&transcript_dir, "unused");

        drive(
            state.path(),
            "PreInvocation",
            SLUG,
            info.id,
            f_with_transcript("antigravity-1.1.26-02-PreInvocation.json", &transcript),
        )
        .await;

        drive(
            state.path(),
            "PreToolUse",
            SLUG,
            info.id,
            f_with_transcript(
                "antigravity-1.1.26-06-PreToolUse-read_file.json",
                &transcript,
            ),
        )
        .await;
        assert_eq!(
            daemon.session_status(info.id).unwrap(),
            Some(proto::AgentStatus::Working),
            "an ordinary tool call must not block"
        );

        let mut rx = daemon.observe();
        drive(
            state.path(),
            "PreToolUse",
            SLUG,
            info.id,
            f_with_transcript(
                "antigravity-1.1.26-04-PreToolUse-ask_question.json",
                &transcript,
            ),
        )
        .await;
        assert_eq!(
            next_status(&mut rx, info.id).await,
            proto::AgentStatus::NeedsInput
        );
        assert_eq!(
            houston_core::orchestrate::capability_note(proto::AgentKind::Antigravity),
            None,
            "antigravity reports all six answers; nothing is missing"
        );

        drive(
            state.path(),
            "PostToolUse",
            SLUG,
            info.id,
            f_with_transcript(
                "antigravity-1.1.26-05-PostToolUse-ask_question.json",
                &transcript,
            ),
        )
        .await;
        assert_eq!(
            daemon.session_status(info.id).unwrap(),
            Some(proto::AgentStatus::Working),
            "answering the question resumes the active turn"
        );
        drive(
            state.path(),
            "Stop",
            SLUG,
            info.id,
            f_with_transcript("antigravity-1.1.26-03-Stop.json", &transcript),
        )
        .await;
        assert_eq!(
            daemon.session_status(info.id).unwrap(),
            Some(proto::AgentStatus::Idle),
            "the turn ends cleanly after PostToolUse closed the episode"
        );
    }

    #[tokio::test]
    async fn antigravity_child_gets_pane_submit_and_workspace_info() {
        let _guard = serial().await;
        shim_dir();
        let (addr, _state, daemon) = start_daemon_with_handle().await;
        let dir = tempfile::tempdir().unwrap();
        daemon
            .workspace_add(&dir.path().display().to_string())
            .unwrap();
        daemon.orchestration_set(true).unwrap();

        let (parent, _parent_dir) = pane(&daemon, proto::AgentKind::Custom);
        let parent_workspace = parent.project_dir.clone();
        let parent_token = daemon.mcp_creds.issue(McpScope {
            session_id: parent.id,
            workspace_id: parent_workspace.clone(),
        });
        let (status, body) = orchestrate_spawn(
            addr,
            &parent_token,
            serde_json::json!({"kind": "antigravity", "prompt": "leaf brief"}),
        )
        .await;
        assert_eq!(status, 200, "spawn body: {body}");
        let child = body["session_id"].as_u64().unwrap() as u32;
        let child_token = daemon.mcp_creds.issue(McpScope {
            session_id: child,
            workspace_id: parent_workspace.clone(),
        });

        let res = mcp_call(
            addr,
            &child_token,
            serde_json::json!({"jsonrpc": "2.0", "id": 1, "method": "tools/list", "params": {}}),
        )
        .await;
        let tools = res["result"]["tools"]
            .as_array()
            .unwrap_or_else(|| panic!("no tools array: {res}"));
        let mut names: Vec<&str> = tools.iter().filter_map(|t| t["name"].as_str()).collect();
        names.sort_unstable();
        assert_eq!(names, vec!["pane_submit", "workspace_info"], "{res}");
    }

    #[tokio::test]
    async fn antigravity_interrupted_turn_and_broken_hook_file_do_not_strand_the_parent() {
        let _guard = serial().await;
        shim_dir();
        let (addr, state, daemon) = start_daemon_with_handle().await;
        let dir = tempfile::tempdir().unwrap();
        daemon
            .workspace_add(&dir.path().display().to_string())
            .unwrap();
        daemon.orchestration_set(true).unwrap();
        let transcript_dir = tempfile::tempdir().unwrap();
        let transcript = write_transcript(&transcript_dir, "unused");

        let (parent, _parent_dir) = pane(&daemon, proto::AgentKind::Custom);
        let parent_workspace = parent.project_dir.clone();
        let parent_token = daemon.mcp_creds.issue(McpScope {
            session_id: parent.id,
            workspace_id: parent_workspace,
        });
        let (status, body) = orchestrate_spawn(
            addr,
            &parent_token,
            serde_json::json!({"kind": "antigravity", "prompt": "will be interrupted"}),
        )
        .await;
        assert_eq!(status, 200, "spawn body: {body}");
        let child = body["session_id"].as_u64().unwrap() as u32;

        drive(
            state.path(),
            "PreInvocation",
            SLUG,
            child,
            f_with_transcript("antigravity-1.1.26-02-PreInvocation.json", &transcript),
        )
        .await;
        assert_eq!(
            daemon.session_status(child).unwrap(),
            Some(proto::AgentStatus::Working)
        );

        let garbage_dir = houston_core::hook_drop::drop_dir(state.path());
        std::fs::create_dir_all(&garbage_dir).unwrap();
        std::fs::write(
            garbage_dir.join(format!("{}-000000-000000.json", child)),
            b"{ not json",
        )
        .unwrap();
        tokio::time::sleep(Duration::from_millis(300)).await;

        let sub_transcript = write_transcript(&transcript_dir, "sub turn done");
        drive(
            state.path(),
            "SessionStart",
            SLUG,
            child,
            f_with_transcript(
                "antigravity-1.1.26-07-SessionStart-subagent.json",
                &sub_transcript,
            ),
        )
        .await;
        assert_eq!(
            daemon.session_status(child).unwrap(),
            Some(proto::AgentStatus::Working),
            "the daemon is still alive and applying this session's drops"
        );

        daemon
            .session_kill_checked(child, false)
            .expect("session_kill_checked");
        let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
        loop {
            let rows = daemon.inbox_rows_for_test(parent.id);
            if rows
                .iter()
                .any(|r| r.kind == "exited" || r.kind == "operator_note")
            {
                break;
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "the parent never learned its child was killed mid-turn: {rows:?}"
            );
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }
}

async fn http_json(
    addr: SocketAddr,
    method: &str,
    path: &str,
    token: &str,
    body: Option<serde_json::Value>,
) -> (u16, serde_json::Value) {
    let (method, path, token) = (method.to_string(), path.to_string(), token.to_string());
    tokio::task::spawn_blocking(move || {
        use std::io::{Read, Write};
        let payload = body.map(|b| b.to_string()).unwrap_or_default();
        let mut stream = std::net::TcpStream::connect(addr).unwrap();
        let mut head = format!(
            "{method} {path} HTTP/1.1\r\nHost: {addr}\r\nConnection: close\r\n\
             Authorization: Bearer {token}\r\nContent-Type: application/json\r\n\
             Content-Length: {}\r\n\r\n",
            payload.len()
        );
        if payload.is_empty() {
            head = head.replace("Content-Length: 0\r\n\r\n", "\r\n");
        }
        stream.write_all(head.as_bytes()).unwrap();
        stream.write_all(payload.as_bytes()).unwrap();
        let mut raw = String::new();
        stream.read_to_string(&mut raw).unwrap();
        let (head, resp) = raw.split_once("\r\n\r\n").expect("http head/body split");
        let status: u16 = head
            .split_whitespace()
            .nth(1)
            .and_then(|s| s.parse().ok())
            .expect("http status line");
        let value: serde_json::Value =
            serde_json::from_str(resp.trim_start()).unwrap_or(serde_json::Value::Null);
        (status, value)
    })
    .await
    .unwrap()
}

async fn orchestrate_spawn(
    addr: SocketAddr,
    token: &str,
    body: serde_json::Value,
) -> (u16, serde_json::Value) {
    http_json(addr, "POST", "/orchestrate/spawn", token, Some(body)).await
}

async fn mcp_call(addr: SocketAddr, token: &str, body: serde_json::Value) -> serde_json::Value {
    let (status, value) = http_json(addr, "POST", "/mcp", token, Some(body)).await;
    assert_eq!(status, 200, "mcp call: {value}");
    value
}
