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
    let (addr, state, daemon) = start_daemon_with_handle().await;
    let workspace = workspace(state.path());
    daemon.workspace_add(&workspace).unwrap();
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
    let (addr, state, daemon) = start_daemon_with_handle().await;
    let workspace = workspace(state.path());
    daemon.workspace_add(&workspace).unwrap();
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
async fn tasks_access_settings_gate_agents_without_hiding_the_global_user_backlog() {
    let (addr, state, daemon) = start_daemon_with_handle().await;
    let workspace = workspace(state.path());
    daemon.workspace_add(&workspace).unwrap();
    let mut ws = connect_and_hello(addr, TOKEN).await;
    for access in [proto::TasksAccess::Off, proto::TasksAccess::Read] {
        send(
            &mut ws,
            &proto::ClientMsg::TasksAccessSet {
                workspace: workspace.clone(),
                access,
            },
        )
        .await;
        assert!(matches!(
            next_task_reply(&mut ws).await,
            proto::ServerMsg::TasksAccess { .. }
        ));
        let (id, revision) =
            changed(save(&mut ws, &workspace, None, None, patch("User task")).await);
        let (tasks, _) = snapshot(&mut ws, "all").await;
        assert!(tasks.iter().any(|task| task.id == id));
        send(
            &mut ws,
            &proto::ClientMsg::TaskComment {
                id,
                body: "User comment".to_string(),
            },
        )
        .await;
        let (_, next_revision) = changed(next_task_reply(&mut ws).await);
        assert_eq!(next_revision, revision + 1);
        assert!(matches!(
            daemon
                .task_save_as(
                    &workspace,
                    None,
                    None,
                    patch("Agent task"),
                    "agent:test",
                    "task_create"
                )
                .unwrap(),
            proto::ServerMsg::TaskRefused { .. }
        ));
    }
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
        daemon.workspace_add(&workspace).unwrap();
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
async fn workspace_remove_unassigns_tasks_and_interrupts_runs() {
    let (_addr, state, daemon) = start_daemon_with_handle().await;
    let dir = state.path().join("project");
    std::fs::create_dir_all(&dir).unwrap();
    let workspace = dir.display().to_string();
    daemon.workspace_add(&workspace).unwrap();

    let proto::ServerMsg::TaskChanged { id, .. } = daemon
        .task_save(&workspace, None, None, patch("Retained"))
        .unwrap()
    else {
        panic!("expected TaskChanged");
    };
    assert!(matches!(
        daemon.task_get(id).unwrap(),
        proto::ServerMsg::TaskDetail { .. }
    ));

    let conn = rusqlite::Connection::open(state.path().join("test.db")).unwrap();
    conn.execute("INSERT INTO backlog_task_runs (task_id, attempt, kind, state, provider, initial_revision, started_at) VALUES (?1, 1, 'implementation', 'running', 'grok', 1, 0)", [id]).unwrap();
    daemon.workspace_remove(&workspace).unwrap();

    let proto::ServerMsg::TaskSnapshot { tasks, counts, .. } =
        daemon.task_snapshot(&workspace).unwrap()
    else {
        panic!("expected TaskSnapshot");
    };
    assert!(tasks.is_empty(), "{tasks:?}");
    assert_eq!(counts, proto::TaskCounts::default());
    let proto::ServerMsg::TaskDetail {
        task,
        history,
        runs,
        ..
    } = daemon.task_get(id).unwrap()
    else {
        panic!("expected retained TaskDetail");
    };
    assert_eq!(task.workspace, None);
    assert_eq!(task.key, "HOU-1");
    assert!(history
        .iter()
        .any(|entry| entry.actor == "houston:workspace-removed"));
    assert_eq!(runs[0].state, proto::TaskRunState::Interrupted);
    assert!(runs[0].reason.as_deref().unwrap().contains(&workspace));
    let proto::ServerMsg::TaskSnapshot { tasks, .. } = daemon.task_snapshot("unassigned").unwrap()
    else {
        panic!("expected snapshot");
    };
    assert_eq!(tasks.len(), 1);
}

#[test]
fn migration_preserves_rows_history_and_counter_without_reusing_numbers() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("old-tasks.db");
    let conn = rusqlite::Connection::open(&path).unwrap();
    conn.execute_batch("CREATE TABLE backlog_tasks (
        id INTEGER PRIMARY KEY, workspace TEXT NOT NULL, number INTEGER NOT NULL,
        title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', status TEXT NOT NULL,
        priority INTEGER NOT NULL DEFAULT 0, parent_id INTEGER REFERENCES backlog_tasks(id),
        ref_url TEXT, revision INTEGER NOT NULL DEFAULT 1, created_by TEXT NOT NULL,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, archived_at INTEGER,
        UNIQUE(workspace, number));
        CREATE TABLE backlog_task_counters (workspace TEXT PRIMARY KEY, next_number INTEGER NOT NULL);
        INSERT INTO backlog_task_counters VALUES ('/one', 30), ('/two', 2);
        INSERT INTO backlog_tasks VALUES (7, '/one', 1, 'first', 'brief', 'todo', 2, NULL, 'url', 9, 'user', 11, 12, NULL);
        INSERT INTO backlog_tasks VALUES (8, '/two', 1, 'second', '', 'todo', 0, 7, NULL, 4, 'user', 13, 14, NULL);
        INSERT INTO backlog_tasks VALUES (9, '/two', 5, 'unique', '', 'done', 0, NULL, NULL, 6, 'user', 15, 16, 17);
        CREATE TABLE backlog_task_history (id INTEGER PRIMARY KEY, task_id INTEGER NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL, changes TEXT NOT NULL, created_at INTEGER NOT NULL);
        INSERT INTO backlog_task_history VALUES (20, 8, 'user', 'create', '{}', 13);
        CREATE TABLE backlog_task_comments (id INTEGER PRIMARY KEY, task_id INTEGER NOT NULL, body TEXT NOT NULL, author TEXT NOT NULL, created_at INTEGER NOT NULL);
            INSERT INTO backlog_task_comments VALUES (21, 8, 'preserved', 'user', 14);
            CREATE TABLE backlog_task_acceptance (id INTEGER PRIMARY KEY, task_id INTEGER NOT NULL, position INTEGER NOT NULL, text TEXT NOT NULL, checked_at INTEGER, checked_by TEXT);
            INSERT INTO backlog_task_acceptance VALUES (22, 8, 0, 'keep checked', 14, 'user');
            CREATE TABLE backlog_task_blocks (task_id INTEGER NOT NULL, blocked_by_id INTEGER NOT NULL, PRIMARY KEY(task_id, blocked_by_id));
            INSERT INTO backlog_task_blocks VALUES (8, 7);
            CREATE TABLE backlog_task_runs (id INTEGER PRIMARY KEY, task_id INTEGER NOT NULL, attempt INTEGER NOT NULL, kind TEXT NOT NULL, state TEXT NOT NULL, provider TEXT NOT NULL, reviewer TEXT, session_id INTEGER, delegation_id INTEGER, worktree_path TEXT, branch TEXT, base_commit TEXT, initial_revision INTEGER NOT NULL, summary TEXT, started_at INTEGER NOT NULL, ended_at INTEGER);
            INSERT INTO backlog_task_runs VALUES (23, 8, 1, 'implementation', 'running', 'claude', NULL, NULL, NULL, NULL, NULL, NULL, 4, NULL, 14, NULL);").unwrap();
    drop(conn);
    let db = houston_core::db::Db::open(&path).unwrap();
    let conn = rusqlite::Connection::open(&path).unwrap();
    let rows: Vec<(i64, i64, i64, Option<i64>)> = conn
        .prepare("SELECT id, number, revision, parent_id FROM backlog_tasks ORDER BY id")
        .unwrap()
        .query_map([], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
        })
        .unwrap()
        .collect::<std::result::Result<_, _>>()
        .unwrap();
    assert_eq!(
        rows,
        vec![(7, 1, 9, None), (8, 6, 4, Some(7)), (9, 5, 6, None)]
    );
    assert_eq!(
        conn.query_row(
            "SELECT body FROM backlog_task_comments WHERE id = 21 AND task_id = 8",
            [],
            |row| row.get::<_, String>(0)
        )
        .unwrap(),
        "preserved"
    );
    assert_eq!(
        conn.query_row(
            "SELECT action FROM backlog_task_history WHERE id = 20",
            [],
            |row| row.get::<_, String>(0)
        )
        .unwrap(),
        "create"
    );
    assert_eq!(
        conn.query_row(
            "SELECT checked_at FROM backlog_task_acceptance WHERE id = 22",
            [],
            |row| row.get::<_, i64>(0)
        )
        .unwrap(),
        14
    );
    assert_eq!(
        conn.query_row(
            "SELECT blocked_by_id FROM backlog_task_blocks WHERE task_id = 8",
            [],
            |row| row.get::<_, i64>(0)
        )
        .unwrap(),
        7
    );
    assert_eq!(
        conn.query_row(
            "SELECT initial_revision FROM backlog_task_runs WHERE id = 23",
            [],
            |row| row.get::<_, i64>(0)
        )
        .unwrap(),
        4
    );
    let changes: String = conn.query_row("SELECT changes FROM backlog_task_history WHERE task_id = 8 AND actor = 'houston:renumbered'", [], |row| row.get(0)).unwrap();
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&changes).unwrap(),
        serde_json::json!({"key": {"old": "HOU-1", "new": "HOU-6"}})
    );
    assert_eq!(
        conn.query_row(
            "SELECT next_number FROM backlog_task_counters WHERE workspace = 'all'",
            [],
            |row| row.get::<_, i64>(0)
        )
        .unwrap(),
        30
    );
    conn.execute("UPDATE backlog_tasks SET workspace = NULL WHERE id = 8", [])
        .unwrap();
    assert!(conn
        .execute("UPDATE backlog_tasks SET number = 1 WHERE id = 8", [])
        .is_err());
    drop(db);
    drop(conn);
    let _db = houston_core::db::Db::open(&path).unwrap();
    let conn = rusqlite::Connection::open(&path).unwrap();
    assert_eq!(
        conn.query_row("SELECT COUNT(*) FROM backlog_task_history", [], |row| row
            .get::<_, i64>(
            0
        ))
        .unwrap(),
        2
    );
}

#[tokio::test]
async fn global_keys_snapshot_scopes_and_optional_workspace_patch_over_wire() {
    let (addr, state, daemon) = start_daemon_with_handle().await;
    let first_workspace = workspace(state.path());
    let second_dir = state.path().join("other");
    std::fs::create_dir_all(&second_dir).unwrap();
    let second_workspace = second_dir.display().to_string();
    daemon.workspace_add(&first_workspace).unwrap();
    daemon.workspace_add(&second_workspace).unwrap();
    let mut ws = connect_and_hello(addr, TOKEN).await;
    let (first, _) = changed(
        save(
            &mut ws,
            &first_workspace,
            None,
            None,
            patch("First workspace"),
        )
        .await,
    );
    let (second, _) = changed(
        save(
            &mut ws,
            &second_workspace,
            None,
            None,
            patch("Second workspace"),
        )
        .await,
    );
    let (unassigned, revision) = changed(save(&mut ws, "", None, None, patch("Unassigned")).await);
    let (all, counts) = snapshot(&mut ws, "all").await;
    assert_eq!(counts.backlog, 3);
    let keys: std::collections::HashSet<_> = all.iter().map(|task| task.key.as_str()).collect();
    assert_eq!(
        keys,
        std::collections::HashSet::from(["HOU-1", "HOU-2", "HOU-3"])
    );
    assert_eq!(
        snapshot(&mut ws, &first_workspace)
            .await
            .0
            .iter()
            .map(|task| task.id)
            .collect::<Vec<_>>(),
        vec![first]
    );
    assert_eq!(
        snapshot(&mut ws, &second_workspace)
            .await
            .0
            .iter()
            .map(|task| task.id)
            .collect::<Vec<_>>(),
        vec![second]
    );
    assert_eq!(snapshot(&mut ws, "unassigned").await.0[0].id, unassigned);
    let (_, assigned_revision) = changed(
        save(
            &mut ws,
            "",
            Some(unassigned),
            Some(revision),
            proto::TaskPatch {
                workspace: Some(Some(second_workspace.clone())),
                ..Default::default()
            },
        )
        .await,
    );
    assert!(snapshot(&mut ws, "unassigned").await.0.is_empty());
    assert_eq!(snapshot(&mut ws, &second_workspace).await.0.len(), 2);
    let (_, cleared_revision) = changed(
        save(
            &mut ws,
            &second_workspace,
            Some(unassigned),
            Some(assigned_revision),
            proto::TaskPatch {
                workspace: Some(None),
                ..Default::default()
            },
        )
        .await,
    );
    let proto::ServerMsg::TaskDetail { task, history, .. } = detail(&mut ws, unassigned).await
    else {
        panic!("expected detail");
    };
    assert_eq!(task.workspace, None);
    assert_eq!(task.key, "HOU-3", "assignment never changes the key");
    assert!(history
        .iter()
        .any(|entry| entry.changes.contains("workspace")));
    let invalid = state.path().join("unregistered").display().to_string();
    let proto::ServerMsg::TaskRefused { message, .. } = save(
        &mut ws,
        "",
        Some(unassigned),
        Some(cleared_revision),
        proto::TaskPatch {
            workspace: Some(Some(invalid.clone())),
            ..Default::default()
        },
    )
    .await
    else {
        panic!("expected refusal");
    };
    assert!(
        message.contains(&invalid) && message.contains("registered workspace path"),
        "{message}"
    );
    assert_eq!(
        daemon.task_id_for_key(&first_workspace, "HOU-2").unwrap(),
        Some(second)
    );
}
