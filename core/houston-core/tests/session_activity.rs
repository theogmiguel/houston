use houston_core::daemon::{CreateParams, Daemon, DaemonConfig, Outbound};
use houston_core::hook_drop::{self, HookDrop};
use houston_protocol as proto;
use std::sync::Arc;
use std::time::Duration;

async fn apply_drop(daemon: &Arc<Daemon>, state: &std::path::Path, drop: HookDrop) {
    let path =
        hook_drop::write_drop(&hook_drop::drop_dir(state), &drop, hook_drop::now_ms()).unwrap();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    while path.exists() {
        assert!(
            tokio::time::Instant::now() < deadline,
            "hook drop was not consumed"
        );
        daemon.hook_drop_tick_for_test();
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

async fn next_activity(
    rx: &mut tokio::sync::broadcast::Receiver<Outbound>,
    session: u32,
) -> Option<proto::SessionActivity> {
    loop {
        let Outbound::Control(json) = rx.recv().await.unwrap() else {
            continue;
        };
        match serde_json::from_str::<proto::ServerMsg>(&json).unwrap() {
            proto::ServerMsg::SessionActivity { id, activity } if id == session => {
                return activity;
            }
            _ => {}
        }
    }
}

#[tokio::test]
async fn hook_activity_is_snapshotted_and_tool_bursts_are_coalesced() {
    let state = tempfile::tempdir().unwrap();
    let workspace = tempfile::tempdir().unwrap();
    let daemon = Daemon::new(DaemonConfig {
        token: "session-activity-test-token".into(),
        db_path: state.path().join("test.db"),
    })
    .unwrap();
    let mut rx = daemon.subscribe();
    let session = daemon
        .create_session(CreateParams {
            agent: proto::AgentKind::Custom,
            project_dir: workspace.path().to_path_buf(),
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

    apply_drop(
        &daemon,
        state.path(),
        HookDrop {
            agent: Some("claude".into()),
            event: "UserPromptSubmit".into(),
            session: session.id,
            prompt: Some("Fix the parser\nDo not include this line".into()),
            ..HookDrop::default()
        },
    )
    .await;
    let prompt_update = next_activity(&mut rx, session.id).await.unwrap();
    assert_eq!(prompt_update.prompt.as_deref(), Some("Fix the parser"));
    assert_eq!(prompt_update.model, None, "model is never guessed");

    apply_drop(
        &daemon,
        state.path(),
        HookDrop {
            agent: Some("claude".into()),
            event: "Stop".into(),
            session: session.id,
            last_message: Some("Parser fixed\nMore details".into()),
            ..HookDrop::default()
        },
    )
    .await;
    let message_update = next_activity(&mut rx, session.id).await.unwrap();
    assert_eq!(message_update.prompt.as_deref(), Some("Fix the parser"));
    assert_eq!(message_update.last_message.as_deref(), Some("Parser fixed"));
    assert_eq!(
        daemon
            .list()
            .into_iter()
            .find(|item| item.id == session.id)
            .unwrap()
            .activity,
        Some(message_update),
        "session snapshots include hook activity"
    );

    tokio::time::sleep(Duration::from_millis(550)).await;
    let burst_start = std::time::Instant::now();
    for (index, tool_name) in ["Read", "Edit", "Bash", "Search", "Write"]
        .into_iter()
        .enumerate()
    {
        apply_drop(
            &daemon,
            state.path(),
            HookDrop {
                agent: Some("claude".into()),
                event: "PreToolUse".into(),
                session: session.id,
                tool_name: Some(tool_name.into()),
                tool_use_id: Some(format!("tool-{index}")),
                ..HookDrop::default()
            },
        )
        .await;
    }

    let first_tool_update = tokio::time::timeout(
        Duration::from_millis(450),
        next_activity(&mut rx, session.id),
    )
    .await
    .expect("first tool update arrives immediately");
    assert_eq!(
        first_tool_update.as_ref().and_then(|a| a.tool.as_deref()),
        Some("Read")
    );
    // The window is measured from the first send, which happens no earlier than the burst
    // start; under load the burst itself can take most of the window to apply.
    let coalesced = tokio::time::timeout(
        Duration::from_millis(1_000),
        next_activity(&mut rx, session.id),
    )
    .await
    .expect("the coalesced latest state is sent at the window boundary")
    .unwrap();
    let elapsed = burst_start.elapsed();
    assert!(
        elapsed >= Duration::from_millis(500),
        "the burst emits at most one activity update during its first 500 ms window; the second arrived after {elapsed:?}"
    );
    assert_eq!(coalesced.tool.as_deref(), Some("Write"));
    daemon.close(session.id).ok();
}
