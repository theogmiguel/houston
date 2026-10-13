mod common;

use common::start_daemon_with_handle;
use houston_core::daemon::{CreateParams, Daemon};
use houston_core::hook_drop::{self, HookDrop};
use houston_protocol as proto;
use std::path::Path;
use std::time::Duration;

#[test]
fn native_mod_reports_reach_the_helper_on_both_platforms() {
    use std::io::Write as _;
    use std::process::Stdio;
    let home = tempfile::tempdir().unwrap();
    for event in [
        houston_core::claude_turns::START,
        houston_core::claude_turns::INTERRUPTED,
    ] {
        let mut command = common::hermetic_command(env!("CARGO_BIN_EXE_tr-helper"), home.path());
        let mut child = command
            .args(["hook", event, "--houston-managed=fixture"])
            .env("TR_SESSION", "7")
            .env("HOUSTON_CHANNEL", "fixture")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        child
            .stdin
            .take()
            .unwrap()
            .write_all(br#"{"session_id":"root","turn_id":"turn"}"#)
            .unwrap();
        let output = child.wait_with_output().unwrap();
        assert!(output.status.success(), "{output:?}");
        assert!(output.stdout.is_empty(), "{output:?}");
        assert!(output.stderr.is_empty(), "{output:?}");
    }
    let dir = hook_drop::drop_dir(&home.path().join(".houston-fixture"));
    let drops: Vec<HookDrop> = std::fs::read_dir(dir)
        .unwrap()
        .map(|entry| {
            serde_json::from_slice(&std::fs::read(entry.unwrap().path()).unwrap()).unwrap()
        })
        .collect();
    assert_eq!(drops.len(), 2);
    for drop in drops {
        assert_eq!(drop.session, 7);
        assert_eq!(drop.session_id.as_deref(), Some("root"));
        assert_eq!(drop.prompt_id.as_deref(), Some("turn"));
        assert_eq!(drop.transcript_path, None);
        assert_eq!(drop.last_message, None);
    }
}

fn drop_for(event: &str, session: u32) -> HookDrop {
    HookDrop {
        event: event.into(),
        session,
        ..Default::default()
    }
}

fn a_pane(daemon: &std::sync::Arc<Daemon>) -> (proto::SessionInfo, tempfile::TempDir) {
    let dir = tempfile::tempdir().unwrap();
    #[cfg(unix)]
    let cmd = vec!["sleep".into(), "60".into()];
    #[cfg(windows)]
    let cmd = vec![
        "powershell.exe".into(),
        "-NoProfile".into(),
        "-Command".into(),
        "Start-Sleep -Seconds 60".into(),
    ];
    let info = daemon
        .create_session(CreateParams {
            agent: proto::AgentKind::Custom,
            project_dir: dir.path().to_path_buf(),
            cmd: Some(cmd),
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

async fn drop_and_await_apply(state: &Path, drop: &HookDrop) {
    let path =
        hook_drop::write_drop(&hook_drop::drop_dir(state), drop, hook_drop::now_ms()).unwrap();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
    while path.exists() {
        assert!(
            tokio::time::Instant::now() < deadline,
            "native drop was never applied: {}",
            path.display()
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

#[tokio::test]
async fn claude_native_interrupt_closes_only_the_current_main_turn() {
    let (_addr, state, daemon) = start_daemon_with_handle().await;
    let (info, _dir) = a_pane(&daemon);
    let native = |event: &str, conversation: &str, turn: &str| HookDrop {
        session_id: Some(conversation.into()),
        prompt_id: Some(turn.into()),
        ..drop_for(event, info.id)
    };
    let start = houston_core::claude_turns::START;
    let interrupt = houston_core::claude_turns::INTERRUPTED;
    drop_and_await_apply(state.path(), &drop_for("UserPromptSubmit", info.id)).await;
    drop_and_await_apply(state.path(), &native(start, "root", "one")).await;
    let mut sidechain = native(interrupt, "root", "one");
    sidechain.agent_id = Some("subagent".into());
    drop_and_await_apply(state.path(), &sidechain).await;
    assert_eq!(
        daemon.session_status(info.id).unwrap(),
        Some(proto::AgentStatus::Working)
    );

    drop_and_await_apply(state.path(), &drop_for("UserPromptSubmit", info.id)).await;
    drop_and_await_apply(state.path(), &native(start, "root", "two")).await;
    for stale in [
        native(interrupt, "root", "one"),
        native(interrupt, "other", "two"),
        drop_for(interrupt, info.id),
    ] {
        drop_and_await_apply(state.path(), &stale).await;
        assert_eq!(
            daemon.session_status(info.id).unwrap(),
            Some(proto::AgentStatus::Working)
        );
    }
    drop_and_await_apply(state.path(), &native(interrupt, "root", "two")).await;
    assert_eq!(
        daemon.session_status(info.id).unwrap(),
        Some(proto::AgentStatus::Idle)
    );
    // A replay after the next submitted prompt cannot finish that new request.
    drop_and_await_apply(state.path(), &drop_for("UserPromptSubmit", info.id)).await;
    drop_and_await_apply(state.path(), &native(interrupt, "root", "two")).await;
    assert_eq!(
        daemon.session_status(info.id).unwrap(),
        Some(proto::AgentStatus::Working)
    );
    daemon.close(info.id).unwrap();
}

#[tokio::test]
async fn claude_native_interrupt_releases_a_staged_handback_to_its_parent() {
    if std::env::var_os("CLAUDE_TURN_SPAWN_FIXTURE").is_none() {
        let home = tempfile::tempdir().unwrap();
        let bin = home.path().join("bin");
        std::fs::create_dir(&bin).unwrap();
        for provider in ["claude", "codex", "agy", "opencode", "cursor-agent", "grok"] {
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let path = bin.join(provider);
                let script = if provider == "claude" {
                    "#!/bin/sh\nif [ \"$1\" = '--version' ]; then echo 2.1.296; exit 0; fi\nexec sleep 60\n"
                } else {
                    "#!/bin/sh\nexit 1\n"
                };
                std::fs::write(&path, script).unwrap();
                std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).unwrap();
            }
            #[cfg(windows)]
            {
                let script = if provider == "claude" {
                    "@echo off\r\nif \"%~1\"==\"--version\" (echo 2.1.296& exit /b 0)\r\npowershell.exe -NoProfile -Command \"Start-Sleep -Seconds 60\"\r\n"
                } else {
                    "@exit /b 1\r\n"
                };
                std::fs::write(bin.join(format!("{provider}.cmd")), script).unwrap();
            }
        }
        let mut command = common::hermetic_command(std::env::current_exe().unwrap(), home.path());
        let inherited = command
            .get_envs()
            .find(|(key, _)| *key == "PATH")
            .and_then(|(_, value)| value)
            .unwrap()
            .to_string_lossy()
            .into_owned();
        let separator = if cfg!(windows) { ';' } else { ':' };
        let status = command
            .args([
                "--exact",
                "claude_native_interrupt_releases_a_staged_handback_to_its_parent",
                "--nocapture",
            ])
            .env("PATH", format!("{}{separator}{inherited}", bin.display()))
            .env("CLAUDE_TURN_SPAWN_FIXTURE", "1")
            .status()
            .unwrap();
        assert!(status.success());
        return;
    }
    let (_addr, state, daemon) = start_daemon_with_handle().await;
    let (parent, _parent_dir) = a_pane(&daemon);
    daemon.workspace_add(&parent.project_dir).unwrap();
    daemon.orchestration_set(true).unwrap();
    let child = daemon
        .orchestrate_spawn(
            parent.id,
            proto::AgentKind::Claude,
            None,
            None,
            "Fixture task".to_string().into(),
            Some(false),
            None,
            Some("interrupt-fixture".into()),
        )
        .unwrap();
    assert_eq!(child.spawned_by, Some(parent.id));
    let db = houston_core::db::Db::open(&state.path().join("test.db")).unwrap();
    drop_and_await_apply(state.path(), &drop_for("UserPromptSubmit", child.id)).await;
    let round = db.delegation_for_child(child.id).unwrap().unwrap().round;
    let native = |event: &str| HookDrop {
        session_id: Some("root".into()),
        prompt_id: Some("current-turn".into()),
        ..drop_for(event, child.id)
    };
    drop_and_await_apply(state.path(), &native(houston_core::claude_turns::START)).await;
    daemon
        .orchestrate_submit(child.id, "preserved partial result".to_string().into())
        .unwrap();
    assert!(db
        .inbox_pending_result(parent.id, child.id, round)
        .unwrap()
        .is_some());
    drop_and_await_apply(
        state.path(),
        &native(houston_core::claude_turns::INTERRUPTED),
    )
    .await;
    assert!(db
        .inbox_pending_result(parent.id, child.id, round)
        .unwrap()
        .is_none());
    assert!(db
        .inbox_round_has_result(parent.id, child.id, round)
        .unwrap());
    assert_eq!(
        db.delegation_for_child(child.id).unwrap().unwrap().state,
        "done"
    );
    daemon.close(child.id).unwrap();
    daemon.close(parent.id).unwrap();
}

#[tokio::test]
async fn claude_native_interrupt_unblocks_the_instruction_queue_without_fabricating_a_result() {
    let (_addr, state, daemon) = start_daemon_with_handle().await;
    let (parent, _parent_dir) = a_pane(&daemon);
    let (child, _child_dir) = a_pane(&daemon);
    let db = houston_core::db::Db::open(&state.path().join("test.db")).unwrap();
    db.delegation_create(
        parent.id,
        child.id,
        Some("queue-fixture"),
        "task",
        hook_drop::now_ms(),
    )
    .unwrap();
    daemon.orchestration_set(true).unwrap();
    drop_and_await_apply(state.path(), &drop_for("UserPromptSubmit", child.id)).await;
    let round = db.delegation_for_child(child.id).unwrap().unwrap().round;
    let native = |event: &str| HookDrop {
        session_id: Some("root".into()),
        prompt_id: Some("turn".into()),
        ..drop_for(event, child.id)
    };
    drop_and_await_apply(state.path(), &native(houston_core::claude_turns::START)).await;
    let (acceptance, _, _) = daemon
        .orchestrate_instruction_request(
            parent.id,
            child.id,
            "next task",
            Some("next-task"),
            Some("queue"),
        )
        .unwrap();
    assert_eq!(acceptance.state, proto::InstructionState::Queued);
    drop_and_await_apply(
        state.path(),
        &native(houston_core::claude_turns::INTERRUPTED),
    )
    .await;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
    loop {
        let instruction = db
            .instruction_row(&acceptance.instruction_id)
            .unwrap()
            .unwrap();
        if instruction.info.state == proto::InstructionState::Delivered {
            break;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "interrupted turn kept the next instruction queued: {:?}",
            instruction.info
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert!(!db
        .inbox_round_has_result(parent.id, child.id, round)
        .unwrap());
    daemon.close(child.id).unwrap();
    daemon.close(parent.id).unwrap();
}
