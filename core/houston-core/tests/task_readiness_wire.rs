//! Readiness, blockers and a parent's progress over the control wire.

mod common;

use common::{connect_and_hello, start_daemon_with_handle, TOKEN};
use futures_util::SinkExt;
use houston_protocol as proto;
use tokio_tungstenite::tungstenite::Message;

async fn send(ws: &mut common::WsStream, msg: &proto::ClientMsg) {
    ws.send(Message::text(serde_json::to_string(msg).unwrap()))
        .await
        .unwrap();
}

async fn next_task_reply(ws: &mut common::WsStream) -> proto::ServerMsg {
    loop {
        let msg = common::next_control(ws).await;
        if matches!(
            msg,
            proto::ServerMsg::TaskSnapshot { .. }
                | proto::ServerMsg::TaskDetail { .. }
                | proto::ServerMsg::TaskChanged { .. }
                | proto::ServerMsg::TaskRefused { .. }
        ) {
            return msg;
        }
    }
}

async fn save(
    ws: &mut common::WsStream,
    workspace: &str,
    id: Option<i64>,
    expected_revision: Option<i64>,
    patch: proto::TaskPatch,
) -> proto::ServerMsg {
    send(
        ws,
        &proto::ClientMsg::TaskSave {
            workspace: (!workspace.is_empty()).then(|| workspace.to_string()),
            id,
            expected_revision,
            patch,
        },
    )
    .await;
    next_task_reply(ws).await
}

fn changed(msg: proto::ServerMsg) -> (i64, i64) {
    let proto::ServerMsg::TaskChanged { id, revision, .. } = msg else {
        panic!("expected TaskChanged, got {msg:?}");
    };
    (id, revision)
}

async fn snapshot(
    ws: &mut common::WsStream,
    workspace: &str,
) -> (Vec<proto::TaskSummary>, proto::TaskCounts) {
    send(
        ws,
        &proto::ClientMsg::TaskSnapshot {
            scope: workspace.to_string(),
        },
    )
    .await;
    match next_task_reply(ws).await {
        proto::ServerMsg::TaskSnapshot { tasks, counts, .. } => (tasks, counts),
        other => panic!("expected TaskSnapshot, got {other:?}"),
    }
}

fn todo(title: &str, acceptance: &[&str]) -> proto::TaskPatch {
    proto::TaskPatch {
        title: Some(title.to_string()),
        status: Some(proto::TaskStatus::Todo),
        acceptance: Some(acceptance.iter().map(|s| s.to_string()).collect()),
        ..Default::default()
    }
}

async fn rig() -> (common::WsStream, String, tempfile::TempDir) {
    let (addr, state, daemon) = start_daemon_with_handle().await;
    let dir = state.path().join("project");
    std::fs::create_dir_all(&dir).unwrap();
    let workspace = dir.display().to_string();
    daemon.workspace_add(&workspace).unwrap();
    (connect_and_hello(addr, TOKEN).await, workspace, state)
}

#[tokio::test]
async fn ready_needs_a_workspace_a_criterion_and_no_open_question() {
    let (mut ws, workspace, _state) = rig().await;
    changed(save(&mut ws, &workspace, None, None, todo("No criteria", &[])).await);
    let (asks, asks_rev) = changed(
        save(
            &mut ws,
            &workspace,
            None,
            None,
            todo("Asks", &["Works", "[?] Which endpoint?"]),
        )
        .await,
    );
    changed(save(&mut ws, "", None, None, todo("Unassigned", &["Works"])).await);
    changed(save(&mut ws, &workspace, None, None, todo("Ready", &["Works"])).await);

    let (_, counts) = snapshot(&mut ws, "all").await;
    assert_eq!(counts.todo, 4);
    assert_eq!(counts.ready, 1, "only the task with all three is ready");

    // Rewriting the question into a criterion makes the task ready.
    changed(
        save(
            &mut ws,
            &workspace,
            Some(asks),
            Some(asks_rev),
            proto::TaskPatch {
                acceptance: Some(vec!["Works".into(), "Uses /v2".into()]),
                ..Default::default()
            },
        )
        .await,
    );
    let (_, counts) = snapshot(&mut ws, "all").await;
    assert_eq!(counts.ready, 2);
}

async fn task(ws: &mut common::WsStream, id: i64) -> proto::Task {
    send(ws, &proto::ClientMsg::TaskGet { id }).await;
    match next_task_reply(ws).await {
        proto::ServerMsg::TaskDetail { task, .. } => task,
        other => panic!("expected TaskDetail, got {other:?}"),
    }
}

#[tokio::test]
async fn blockers_are_written_refused_on_a_cycle_and_hold_readiness() {
    let (mut ws, workspace, _state) = rig().await;
    let (first, _) = changed(save(&mut ws, &workspace, None, None, todo("First", &["Done"])).await);
    let (second, second_rev) = changed(
        save(
            &mut ws,
            &workspace,
            None,
            None,
            proto::TaskPatch {
                blocked_by: Some(vec![first]),
                ..todo("Second", &["Done"])
            },
        )
        .await,
    );
    assert_eq!(task(&mut ws, second).await.blocked_by, vec![first]);
    let (_, counts) = snapshot(&mut ws, &workspace).await;
    assert_eq!(counts.ready, 1, "the blocked task waits for its blocker");

    // First blocked by second closes a cycle.
    let refused = save(
        &mut ws,
        &workspace,
        Some(first),
        Some(1),
        proto::TaskPatch {
            blocked_by: Some(vec![second]),
            ..Default::default()
        },
    )
    .await;
    let proto::ServerMsg::TaskRefused { kind, message, .. } = refused else {
        panic!("expected TaskRefused, got {refused:?}");
    };
    assert_eq!(kind, proto::TaskErrorKind::Cycle);
    assert!(
        message.contains("HOU-2") && message.contains("cycle"),
        "{message}"
    );

    // A task cannot block itself, and a missing blocker is named.
    let refused = save(
        &mut ws,
        &workspace,
        Some(second),
        Some(second_rev),
        proto::TaskPatch {
            blocked_by: Some(vec![999]),
            ..Default::default()
        },
    )
    .await;
    let proto::ServerMsg::TaskRefused { kind, message, .. } = refused else {
        panic!("expected TaskRefused, got {refused:?}");
    };
    assert_eq!(kind, proto::TaskErrorKind::Invalid);
    assert!(message.contains("999"), "{message}");

    changed(
        save(
            &mut ws,
            &workspace,
            Some(first),
            Some(1),
            proto::TaskPatch {
                status: Some(proto::TaskStatus::Done),
                ..Default::default()
            },
        )
        .await,
    );
    let (_, counts) = snapshot(&mut ws, &workspace).await;
    assert_eq!(counts.ready, 1, "a finished blocker releases the task");

    // `[]` clears the list.
    changed(
        save(
            &mut ws,
            &workspace,
            Some(second),
            Some(second_rev),
            proto::TaskPatch {
                blocked_by: Some(Vec::new()),
                ..Default::default()
            },
        )
        .await,
    );
    assert!(task(&mut ws, second).await.blocked_by.is_empty());
}

