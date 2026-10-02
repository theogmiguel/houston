mod common;

use common::{connect_and_hello, start_daemon_with_handle, TOKEN};
use futures_util::SinkExt;
use houston_core::daemon::{Daemon, DaemonConfig};
use houston_protocol as proto;
use tokio_tungstenite::tungstenite::Message;

fn patch(title: &str) -> proto::TaskPatch {
    proto::TaskPatch {
        title: Some(title.to_string()),
        ..Default::default()
    }
}

async fn send(ws: &mut common::WsStream, msg: &proto::ClientMsg) {
    ws.send(Message::text(serde_json::to_string(msg).unwrap()))
        .await
        .unwrap();
}

/// The next reply that belongs to the Tasks wire, skipping unrelated
/// broadcasts another test's connection may have queued.
async fn next_task_reply(ws: &mut common::WsStream) -> proto::ServerMsg {
    loop {
        let msg = common::next_control(ws).await;
        if matches!(
            msg,
            proto::ServerMsg::TaskSnapshot { .. }
                | proto::ServerMsg::TaskDetail { .. }
                | proto::ServerMsg::TaskChanged { .. }
                | proto::ServerMsg::TaskRefused { .. }
                | proto::ServerMsg::TasksAccess { .. }
                | proto::ServerMsg::Error { .. }
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
            workspace: workspace.to_string(),
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
            workspace: workspace.to_string(),
        },
    )
    .await;
    match next_task_reply(ws).await {
        proto::ServerMsg::TaskSnapshot { tasks, counts, .. } => (tasks, counts),
        other => panic!("expected TaskSnapshot, got {other:?}"),
    }
}

async fn detail(ws: &mut common::WsStream, id: i64) -> proto::ServerMsg {
    send(ws, &proto::ClientMsg::TaskGet { id }).await;
    next_task_reply(ws).await
}

fn workspace(state: &std::path::Path) -> String {
    let dir = state.join("project");
    std::fs::create_dir_all(&dir).unwrap();
    dir.display().to_string()
}

#[tokio::test]
async fn a_task_round_trip_over_the_wire() {
    let (addr, state, _daemon) = start_daemon_with_handle().await;
    let workspace = workspace(state.path());
    let mut ws = connect_and_hello(addr, TOKEN).await;

    let (first, first_rev) = changed(save(&mut ws, &workspace, None, None, patch("First")).await);
    assert_eq!(first_rev, 1);

    let (tasks, counts) = snapshot(&mut ws, &workspace).await;
    assert_eq!(tasks.len(), 1, "{tasks:?}");
    assert_eq!(tasks[0].key, "HOU-1");
    assert_eq!(tasks[0].title, "First");
    assert_eq!(tasks[0].status, proto::TaskStatus::Backlog);
    assert_eq!(counts.backlog, 1);

    let (second, second_rev) =
        changed(save(&mut ws, &workspace, None, None, patch("Second")).await);
    let (tasks, _) = snapshot(&mut ws, &workspace).await;
    assert_eq!(
        tasks.iter().find(|t| t.id == second).unwrap().key,
        "HOU-2",
        "the next task's number follows the counter"
    );

    let mut edit = patch("Second edited");
    edit.description = Some("now with a description".to_string());
    edit.priority = Some(proto::TaskPriority::Urgent);
    let (_, edited_rev) =
        changed(save(&mut ws, &workspace, Some(second), Some(second_rev), edit).await);
    assert_eq!(edited_rev, second_rev + 1);

    let stale = save(
        &mut ws,
        &workspace,
        Some(second),
        Some(second_rev),
        patch("Stale"),
    )
    .await;
    let proto::ServerMsg::TaskRefused {
        id,
        kind,
        expected,
        actual,
        message,
        ..
    } = stale
    else {
        panic!("expected TaskRefused, got {stale:?}");
    };
    assert_eq!(id, Some(second));
    assert_eq!(kind, proto::TaskErrorKind::Conflict);
    assert_eq!(expected, Some(second_rev));
    assert_eq!(actual, Some(edited_rev));
    assert!(message.contains("HOU-2"), "{message}");
    assert!(message.contains(&second_rev.to_string()), "{message}");
    assert!(message.contains(&edited_rev.to_string()), "{message}");

    let proto::ServerMsg::TaskDetail { task, history, .. } = detail(&mut ws, second).await else {
        panic!("expected TaskDetail");
    };
    assert_eq!(task.title, "Second edited");
    assert_eq!(task.description, "now with a description");
    assert_eq!(task.priority, proto::TaskPriority::Urgent);
    assert!(!history.is_empty(), "the edit is recorded in history");

    send(
        &mut ws,
        &proto::ClientMsg::TaskArchive {
            id: second,
            archived: true,
            expected_revision: edited_rev,
        },
    )
    .await;
    let (_, archived_rev) = changed(next_task_reply(&mut ws).await);
    assert_eq!(archived_rev, edited_rev + 1);
    let (tasks, counts) = snapshot(&mut ws, &workspace).await;
    assert_eq!(counts.backlog, 1, "only First stays active");
    assert!(
        tasks
            .iter()
            .find(|t| t.id == second)
            .unwrap()
            .archived_at_ms
            .is_some(),
        "an archived task keeps its row and its flag"
    );

    let mut third_patch = patch("Third");
    third_patch.acceptance = Some(vec!["one".to_string(), "two".to_string()]);
    let (third, third_rev) = changed(save(&mut ws, &workspace, None, None, third_patch).await);
    let (tasks, _) = snapshot(&mut ws, &workspace).await;
    assert_eq!(
        tasks.iter().find(|t| t.id == third).unwrap().key,
        "HOU-3",
        "archiving never hands a number out twice"
    );
    assert_eq!(third_rev, 1);

    send(
        &mut ws,
        &proto::ClientMsg::TaskArchive {
            id: second,
            archived: false,
            expected_revision: archived_rev,
        },
    )
    .await;
    let (_, restored_rev) = changed(next_task_reply(&mut ws).await);
    assert_eq!(restored_rev, archived_rev + 1);
    let (_, counts) = snapshot(&mut ws, &workspace).await;
    assert_eq!(
        counts.backlog, 3,
        "the restore returns it to the active list"
    );

    send(
        &mut ws,
        &proto::ClientMsg::TaskComment {
            id: third,
            body: "looking at this".to_string(),
        },
    )
    .await;
    let (_, commented_rev) = changed(next_task_reply(&mut ws).await);
    let proto::ServerMsg::TaskDetail {
        task,
        acceptance,
        comments,
        ..
    } = detail(&mut ws, third).await
    else {
        panic!("expected TaskDetail");
    };
    assert_eq!(comments.len(), 1);
    assert_eq!(comments[0].body, "looking at this");
    assert_eq!(comments[0].author, "user");
    assert_eq!(task.revision, commented_rev);

    let item = acceptance[0].id;
    send(
        &mut ws,
        &proto::ClientMsg::TaskCheck {
            id: third,
            item,
            checked: true,
        },
    )
    .await;
    let (_, checked_rev) = changed(next_task_reply(&mut ws).await);
    assert_eq!(checked_rev, commented_rev + 1);
    let proto::ServerMsg::TaskDetail {
        task, acceptance, ..
    } = detail(&mut ws, third).await
    else {
        panic!("expected TaskDetail");
    };
    assert_eq!(task.revision, checked_rev);
    assert!(acceptance[0].checked_at_ms.is_some());
    assert_eq!(acceptance[0].checked_by.as_deref(), Some("user"));
    let (tasks, _) = snapshot(&mut ws, &workspace).await;
    let third_row = tasks.iter().find(|t| t.id == third).unwrap();
    assert_eq!(third_row.acceptance_checked, 1);
    assert_eq!(third_row.acceptance_total, 2);
    let _ = first;
}

#[tokio::test]
async fn a_description_over_the_cap_is_refused_naming_limit_actual_and_operation() {
    let (addr, state, _daemon) = start_daemon_with_handle().await;
    let workspace = workspace(state.path());
    let mut ws = connect_and_hello(addr, TOKEN).await;

    let (id, rev) = changed(save(&mut ws, &workspace, None, None, patch("Capped")).await);
    let too_long = "x".repeat(proto::TASK_DESCRIPTION_MAX + 1);
    let msg = save(
        &mut ws,
        &workspace,
        Some(id),
        Some(rev),
        proto::TaskPatch {
            description: Some(too_long),
            ..Default::default()
        },
    )
    .await;
    let proto::ServerMsg::TaskRefused {
        id: refused_id,
        kind,
        limit,
        requested,
        message,
        ..
    } = msg
    else {
        panic!("expected TaskRefused, got {msg:?}");
    };
    assert_eq!(refused_id, Some(id));
    assert_eq!(kind, proto::TaskErrorKind::Limit);
    assert_eq!(limit, Some(proto::TASK_DESCRIPTION_MAX as u32));
    assert_eq!(requested, Some(proto::TASK_DESCRIPTION_MAX as u64 + 1));
    assert!(message.contains("task_save"), "{message}");
    assert!(
        message.contains(&(proto::TASK_DESCRIPTION_MAX + 1).to_string()),
        "{message}"
    );

    let proto::ServerMsg::TaskDetail { task, .. } = detail(&mut ws, id).await else {
        panic!("expected TaskDetail");
    };
    assert_eq!(task.description, "", "a refused write changes nothing");
    assert_eq!(task.revision, rev);
}

#[tokio::test]
async fn tasks_access_off_and_read_are_refused_naming_settings() {
    let (addr, state, _daemon) = start_daemon_with_handle().await;
    let workspace = workspace(state.path());
    let mut ws = connect_and_hello(addr, TOKEN).await;

    send(
        &mut ws,
        &proto::ClientMsg::TasksAccessGet {
            workspace: workspace.clone(),
        },
    )
    .await;
    let proto::ServerMsg::TasksAccess { access, .. } = next_task_reply(&mut ws).await else {
        panic!("expected TasksAccess");
    };
    assert_eq!(access, proto::TasksAccess::Write, "write is the default");

    let (id, rev) = changed(save(&mut ws, &workspace, None, None, patch("Guarded")).await);

    send(
        &mut ws,
        &proto::ClientMsg::TasksAccessSet {
            workspace: workspace.clone(),
            access: proto::TasksAccess::Off,
        },
    )
    .await;
    let proto::ServerMsg::TasksAccess { access, .. } = next_task_reply(&mut ws).await else {
        panic!("expected TasksAccess");
    };
    assert_eq!(access, proto::TasksAccess::Off);

    let msg = save(&mut ws, &workspace, None, None, patch("Refused")).await;
    let proto::ServerMsg::TaskRefused { kind, message, .. } = msg else {
        panic!("expected TaskRefused, got {msg:?}");
    };
    assert_eq!(kind, proto::TaskErrorKind::AccessOff);
    assert!(message.contains("Settings ▸ Tasks"), "{message}");
    assert!(message.contains("off"), "{message}");

    send(
        &mut ws,
        &proto::ClientMsg::TaskSnapshot {
            workspace: workspace.clone(),
        },
    )
    .await;
    let proto::ServerMsg::TaskRefused { kind, message, .. } = next_task_reply(&mut ws).await else {
        panic!("expected TaskRefused");
    };
    assert_eq!(kind, proto::TaskErrorKind::AccessOff);
    assert!(message.contains("Settings ▸ Tasks"), "{message}");

    send(
        &mut ws,
        &proto::ClientMsg::TasksAccessSet {
            workspace: workspace.clone(),
            access: proto::TasksAccess::Read,
        },
    )
    .await;
    let proto::ServerMsg::TasksAccess { access, .. } = next_task_reply(&mut ws).await else {
        panic!("expected TasksAccess");
    };
    assert_eq!(access, proto::TasksAccess::Read);

    let (tasks, _) = snapshot(&mut ws, &workspace).await;
    assert_eq!(tasks.len(), 1, "read access still lists");
    let msg = save(&mut ws, &workspace, None, None, patch("Refused")).await;
    let proto::ServerMsg::TaskRefused { kind, message, .. } = msg else {
        panic!("expected TaskRefused, got {msg:?}");
    };
    assert_eq!(kind, proto::TaskErrorKind::ReadOnly);
    assert!(message.contains("Settings ▸ Tasks"), "{message}");
    assert!(message.contains("read"), "{message}");

    send(
        &mut ws,
        &proto::ClientMsg::TaskComment {
            id,
            body: "not allowed".to_string(),
        },
    )
    .await;
    let proto::ServerMsg::TaskRefused { kind, .. } = next_task_reply(&mut ws).await else {
        panic!("expected TaskRefused");
    };
    assert_eq!(kind, proto::TaskErrorKind::ReadOnly);

    send(
        &mut ws,
        &proto::ClientMsg::TaskArchive {
            id,
            archived: true,
            expected_revision: rev,
        },
    )
    .await;
    let proto::ServerMsg::TaskRefused { kind, .. } = next_task_reply(&mut ws).await else {
        panic!("expected TaskRefused");
    };
    assert_eq!(kind, proto::TaskErrorKind::ReadOnly);

    send(
        &mut ws,
        &proto::ClientMsg::TasksAccessSet {
            workspace: workspace.clone(),
            access: proto::TasksAccess::Write,
        },
    )
    .await;
    let proto::ServerMsg::TasksAccess { access, .. } = next_task_reply(&mut ws).await else {
        panic!("expected TasksAccess");
    };
    assert_eq!(access, proto::TasksAccess::Write);
    let (_, resumed_rev) = changed(
        save(
            &mut ws,
            &workspace,
            Some(id),
            Some(rev),
            patch("Guarded again"),
        )
        .await,
    );
    assert_eq!(resumed_rev, rev + 1);
}

#[tokio::test]
async fn tasks_survive_a_daemon_restart() {
    let state_dir = tempfile::tempdir().unwrap();
    let db_path = state_dir.path().join("test.db");
    let dir = state_dir.path().join("project");
    std::fs::create_dir_all(&dir).unwrap();
    let workspace = dir.display().to_string();
    let cfg = || DaemonConfig {
        token: TOKEN.to_string(),
        db_path: db_path.clone(),
    };

    let (id, revision) = {
        let daemon = Daemon::new(cfg()).unwrap();
        let proto::ServerMsg::TaskChanged { id, revision, .. } = daemon
            .task_save(&workspace, None, None, patch("Persisted"))
            .unwrap()
        else {
            panic!("expected TaskChanged");
        };
        (id, revision)
    };

    let daemon = Daemon::new(cfg()).unwrap();
    let proto::ServerMsg::TaskSnapshot { tasks, counts, .. } =
        daemon.task_snapshot(&workspace).unwrap()
    else {
        panic!("expected TaskSnapshot");
    };
    let row = tasks
        .iter()
        .find(|t| t.id == id)
        .expect("the task survives");
    assert_eq!(row.key, "HOU-1");
    assert_eq!(row.revision, revision);
    assert_eq!(counts.backlog, 1);

    let proto::ServerMsg::TaskChanged { id: next, .. } = daemon
        .task_save(&workspace, None, None, patch("Next"))
        .unwrap()
    else {
        panic!("expected TaskChanged");
    };
    let proto::ServerMsg::TaskSnapshot { tasks, .. } = daemon.task_snapshot(&workspace).unwrap()
    else {
        panic!("expected TaskSnapshot");
    };
    assert_eq!(
        tasks.iter().find(|t| t.id == next).unwrap().key,
        "HOU-2",
        "the counter continues across the restart"
    );
}

#[tokio::test]
async fn workspace_remove_deletes_its_tasks() {
    let (_addr, state, daemon) = start_daemon_with_handle().await;
    let dir = state.path().join("project");
    std::fs::create_dir_all(&dir).unwrap();
    let workspace = dir.display().to_string();
    daemon.workspace_add(&workspace).unwrap();

    let proto::ServerMsg::TaskChanged { id, .. } = daemon
        .task_save(&workspace, None, None, patch("Doomed"))
        .unwrap()
    else {
        panic!("expected TaskChanged");
    };
    assert!(matches!(
        daemon.task_get(id).unwrap(),
        proto::ServerMsg::TaskDetail { .. }
    ));

    daemon.workspace_remove(&workspace).unwrap();

    let proto::ServerMsg::TaskSnapshot { tasks, counts, .. } =
        daemon.task_snapshot(&workspace).unwrap()
    else {
        panic!("expected TaskSnapshot");
    };
    assert!(tasks.is_empty(), "{tasks:?}");
    assert_eq!(counts, proto::TaskCounts::default());
    let proto::ServerMsg::TaskRefused { kind, .. } = daemon.task_get(id).unwrap() else {
        panic!("expected TaskRefused");
    };
    assert_eq!(kind, proto::TaskErrorKind::NotFound);
}
