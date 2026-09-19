mod common;

use common::{connect_and_hello, start_daemon, start_daemon_with_handle, TOKEN};
use futures_util::SinkExt;
use houston_core::daemon::{Daemon, DaemonConfig};
use houston_protocol as proto;
use std::time::Duration;

fn interval(seconds: u32) -> proto::Cadence {
    proto::Cadence::Interval { seconds }
}

fn clock(hour: u8, minute: u8, weekdays: Option<Vec<u8>>) -> proto::Cadence {
    proto::Cadence::Clock {
        hour,
        minute,
        weekdays,
    }
}

fn routines_of(msg: proto::ServerMsg) -> Vec<proto::Routine> {
    let proto::ServerMsg::Routines { routines, .. } = msg else {
        panic!("expected Routines, got {msg:?}");
    };
    routines
}

struct Refusal {
    kind: proto::RoutineErrorKind,
    limit: Option<u32>,
    requested: Option<u32>,
}

fn refused(msg: proto::ServerMsg) -> Refusal {
    let proto::ServerMsg::RoutineRefused {
        kind,
        limit,
        requested,
        ..
    } = msg
    else {
        panic!("expected RoutineRefused, got {msg:?}");
    };
    Refusal {
        kind,
        limit,
        requested,
    }
}

fn create(daemon: &Daemon, name: &str, dir: Option<&std::path::Path>) -> proto::ServerMsg {
    daemon
        .routine_create_full(
            name,
            "run the sweep",
            interval(900),
            dir.map(|d| d.display().to_string()),
            Some(proto::AgentKind::Codex),
            Some("gpt-5.2".to_string()),
            Some(proto::ChatEffort::Low),
            None,
            None,
        )
        .unwrap()
}

fn created(daemon: &Daemon, name: &str) -> proto::Routine {
    routines_of(create(daemon, name, None))
        .into_iter()
        .find(|r| r.name == name)
        .expect("the routine just created is listed")
}

#[tokio::test]
async fn a_fresh_channel_has_no_routines() {
    let (_addr, _state, daemon) = start_daemon_with_handle().await;
    assert!(routines_of(daemon.routine_list()).is_empty());
    assert!(matches!(
        daemon.routine_runs_list(None),
        proto::ServerMsg::RoutineRuns { runs } if runs.is_empty()
    ));
}

#[tokio::test]
async fn creating_a_routine_fills_the_record() {
    let (_addr, state, daemon) = start_daemon_with_handle().await;
    let dir = state.path().join("standalone-dir");
    std::fs::create_dir_all(&dir).unwrap();
    let msg = create(&daemon, "Standalone sweep", Some(&dir));
    let list = routines_of(msg);
    assert_eq!(list.len(), 1);
    let r = &list[0];
    assert_eq!(r.engine, proto::AgentKind::Codex);
    assert_eq!(r.model.as_deref(), Some("gpt-5.2"));
    assert_eq!(r.effort, Some(proto::ChatEffort::Low));
    assert_eq!(r.workspace_id.as_deref(), Some(dir.to_str().unwrap()));
    assert_eq!(r.permission_mode, proto::ChatPermissionMode::AcceptEdits);
    assert!(!r.isolate);
    assert!(r.enabled);
    assert!(r.next_run_at_ms > 0);
    assert!(r.last_run_at_ms.is_none());
    assert_eq!(r.revision.len(), 16);
}

#[tokio::test]
async fn a_routine_needs_an_engine_and_says_so() {
    let (_addr, _state, daemon) = start_daemon_with_handle().await;
    let err = daemon
        .routine_create_full(
            "No engine",
            "run it",
            interval(900),
            None,
            None,
            None,
            None,
            None,
            None,
        )
        .unwrap_err();
    let text = format!("{err:#}");
    assert!(text.contains("engine"), "{text}");
}

#[tokio::test]
async fn full_access_without_isolation_is_refused_by_name() {
    let (_addr, _state, daemon) = start_daemon_with_handle().await;
    let err = daemon
        .routine_create_full(
            "Full access",
            "run it",
            interval(900),
            None,
            Some(proto::AgentKind::Claude),
            None,
            None,
            Some(proto::ChatPermissionMode::BypassPermissions),
            Some(false),
        )
        .unwrap_err();
    let text = format!("{err:#}");
    assert!(text.contains("isolat"), "{text}");
}

#[tokio::test]
async fn isolation_outside_a_git_repo_is_refused_naming_the_directory() {
    let (_addr, state, daemon) = start_daemon_with_handle().await;
    let dir = state.path().join("not-a-repo");
    std::fs::create_dir_all(&dir).unwrap();
    let err = daemon
        .routine_create_full(
            "Isolated",
            "run it",
            interval(900),
            Some(dir.display().to_string()),
            Some(proto::AgentKind::Claude),
            None,
            None,
            None,
            Some(true),
        )
        .unwrap_err();
    let text = format!("{err:#}");
    assert!(text.contains(&dir.display().to_string()), "{text}");
}

#[tokio::test]
async fn the_total_cap_is_refused_naming_limit_and_requested() {
    let (_addr, state, daemon) = start_daemon_with_handle().await;
    {
        let conn = rusqlite::Connection::open(state.path().join("test.db")).unwrap();
        for i in 0..proto::ROUTINES_TOTAL {
            conn.execute(
                "INSERT INTO routines
                    (name, name_folded, prompt, cadence, enabled, engine, next_run_at_ms,
                     revision, created_at, updated_at)
                 VALUES (?1, ?1, 'x', '{\"type\":\"interval\",\"seconds\":900}', 0, 'shell',
                         0, 'r', 0, 0)",
                rusqlite::params![format!("filler-{i}")],
            )
            .unwrap();
        }
    }
    let refusal = refused(create(&daemon, "one too many", None));
    assert_eq!(refusal.kind, proto::RoutineErrorKind::Limit);
    assert_eq!(refusal.limit, Some(proto::ROUTINES_TOTAL));
    assert_eq!(refusal.requested, Some(proto::ROUTINES_TOTAL + 1));
}

#[tokio::test]
async fn a_duplicate_folded_name_is_refused() {
    let (_addr, _state, daemon) = start_daemon_with_handle().await;
    created(&daemon, "Nightly");
    let refusal = refused(create(&daemon, "  nightly  ", None));
    assert_eq!(refusal.kind, proto::RoutineErrorKind::DuplicateName);
    assert_eq!(routines_of(daemon.routine_list()).len(), 1);
}

#[tokio::test]
async fn a_stale_revision_is_a_conflict_and_changes_nothing() {
    let (_addr, _state, daemon) = start_daemon_with_handle().await;
    let routine = created(&daemon, "Nightly");
    let msg = daemon
        .routine_update_for_test(
            routine.id,
            &routine.revision,
            Some("Nightly 2".to_string()),
            None,
            None,
            None,
            None,
            None,
            None,
        )
        .unwrap();
    let updated = routines_of(msg)
        .into_iter()
        .find(|r| r.id == routine.id)
        .unwrap();
    assert_eq!(updated.name, "Nightly 2");

    let refusal = refused(
        daemon
            .routine_update_for_test(
                routine.id,
                &routine.revision,
                Some("Nightly 3".to_string()),
                None,
                None,
                None,
                None,
                None,
                None,
            )
            .unwrap(),
    );
    assert_eq!(refusal.kind, proto::RoutineErrorKind::Conflict);
    assert_eq!(
        routines_of(daemon.routine_list())
            .into_iter()
            .find(|r| r.id == routine.id)
            .unwrap()
            .name,
        "Nightly 2",
        "a conflict changes nothing"
    );
}

#[tokio::test]
async fn an_unknown_id_is_not_found_on_update_and_delete() {
    let (_addr, _state, daemon) = start_daemon_with_handle().await;
    let refusal = refused(
        daemon
            .routine_update_for_test(999, "r", None, None, None, None, None, None, None)
            .unwrap(),
    );
    assert_eq!(refusal.kind, proto::RoutineErrorKind::NotFound);
    let refusal = refused(daemon.routine_delete(999, "r").unwrap());
    assert_eq!(refusal.kind, proto::RoutineErrorKind::NotFound);
}

#[tokio::test]
async fn delete_needs_the_current_revision_and_then_removes_the_row() {
    let (_addr, _state, daemon) = start_daemon_with_handle().await;
    let routine = created(&daemon, "Nightly");
    let refusal = refused(daemon.routine_delete(routine.id, "stale").unwrap());
    assert_eq!(refusal.kind, proto::RoutineErrorKind::Conflict);
    assert_eq!(routines_of(daemon.routine_list()).len(), 1);

    let msg = daemon
        .routine_delete(routine.id, &routine.revision)
        .unwrap();
    assert!(routines_of(msg).is_empty());
}

#[tokio::test]
async fn pausing_keeps_the_routine_and_resuming_recomputes_next_run() {
    let (_addr, _state, daemon) = start_daemon_with_handle().await;
    let routine = created(&daemon, "Nightly");
    let paused = routines_of(
        daemon
            .routine_update_for_test(
                routine.id,
                &routine.revision,
                None,
                None,
                None,
                Some(false),
                None,
                None,
                None,
            )
            .unwrap(),
    )
    .into_iter()
    .find(|r| r.id == routine.id)
    .unwrap();
    assert!(!paused.enabled);
    let old_next = paused.next_run_at_ms;

    let resumed = routines_of(
        daemon
            .routine_update_for_test(
                routine.id,
                &paused.revision,
                None,
                None,
                None,
                Some(true),
                None,
                None,
                None,
            )
            .unwrap(),
    )
    .into_iter()
    .find(|r| r.id == routine.id)
    .unwrap();
    assert!(resumed.enabled);
    assert!(
        resumed.next_run_at_ms >= old_next,
        "resuming recomputes the clock from now"
    );
}

#[tokio::test]
async fn a_null_workspace_id_clears_it_and_an_absent_one_keeps_it() {
    let (_addr, state, daemon) = start_daemon_with_handle().await;
    let dir = state.path().join("ws");
    std::fs::create_dir_all(&dir).unwrap();
    let routine = routines_of(create(&daemon, "Nightly", Some(&dir)))
        .into_iter()
        .next()
        .unwrap();

    let kept = routines_of(
        daemon
            .routine_update_for_test(
                routine.id,
                &routine.revision,
                None,
                None,
                None,
                None,
                None,
                None,
                None,
            )
            .unwrap(),
    )
    .into_iter()
    .find(|r| r.id == routine.id)
    .unwrap();
    assert_eq!(kept.workspace_id.as_deref(), Some(dir.to_str().unwrap()));

    let cleared = routines_of(
        daemon
            .routine_update_for_test(
                routine.id,
                &kept.revision,
                None,
                None,
                None,
                None,
                Some(None),
                None,
                None,
            )
            .unwrap(),
    )
    .into_iter()
    .find(|r| r.id == routine.id)
    .unwrap();
    assert_eq!(cleared.workspace_id, None);
}

#[tokio::test]
async fn out_of_range_values_are_errors_naming_the_bound() {
    let (_addr, _state, daemon) = start_daemon_with_handle().await;
    let err = daemon
        .routine_create_full(
            "Too fast",
            "run it",
            interval(proto::ROUTINE_MIN_INTERVAL_SECS - 1),
            None,
            Some(proto::AgentKind::Claude),
            None,
            None,
            None,
            None,
        )
        .unwrap_err();
    let text = format!("{err:#}");
    assert!(
        text.contains(&proto::ROUTINE_MIN_INTERVAL_SECS.to_string()),
        "{text}"
    );

    let err = daemon
        .routine_create_full(
            "Bad hour",
            "run it",
            clock(24, 0, None),
            None,
            Some(proto::AgentKind::Claude),
            None,
            None,
            None,
            None,
        )
        .unwrap_err();
    let text = format!("{err:#}");
    assert!(text.contains("24"), "{text}");
}

#[tokio::test]
async fn routines_survive_a_daemon_restart() {
    let state_dir = tempfile::tempdir().unwrap();
    let db_path = state_dir.path().join("test.db");
    let cfg = || DaemonConfig {
        token: TOKEN.to_string(),
        db_path: db_path.clone(),
    };
    let (id, revision) = {
        let daemon = Daemon::new(cfg()).unwrap();
        let routine = created(&daemon, "Nightly");
        (routine.id, routine.revision)
    };
    let daemon = Daemon::new(cfg()).unwrap();
    let after = routines_of(daemon.routine_list())
        .into_iter()
        .find(|r| r.id == id)
        .expect("the routine survives");
    assert_eq!(after.name, "Nightly");
    assert_eq!(after.revision, revision);
    assert_eq!(after.engine, proto::AgentKind::Codex);
}

/// A pre-PR-68 table (`agent_id NOT NULL`) plus its bot: the boot migration
/// must inherit engine/model/effort/directory from the bot once, then drop
/// every bot column and table without losing the routine.
#[tokio::test]
async fn a_bot_owned_routine_migrates_to_standalone_with_its_execution_fields() {
    let state_dir = tempfile::tempdir().unwrap();
    let db_path = state_dir.path().join("test.db");
    {
        let conn = rusqlite::Connection::open(&db_path).unwrap();
        conn.execute_batch(
            "CREATE TABLE named_agents (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                engine TEXT NOT NULL,
                notes TEXT NOT NULL DEFAULT '',
                about_you TEXT NOT NULL DEFAULT '',
                skills TEXT NOT NULL DEFAULT '[]',
                memory_budget INTEGER NOT NULL,
                reflection_mode TEXT NOT NULL DEFAULT 'off',
                allow_agent_scheduling INTEGER NOT NULL DEFAULT 0,
                disabled_plugin_ids TEXT NOT NULL DEFAULT '[]',
                schema_version INTEGER NOT NULL DEFAULT 1,
                revision INTEGER NOT NULL DEFAULT 0,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                working_dir TEXT,
                purpose TEXT NOT NULL DEFAULT '',
                default_model TEXT,
                default_effort TEXT,
                default_permission_mode TEXT,
                default_plan INTEGER NOT NULL DEFAULT 0,
                allow_agent_messaging INTEGER NOT NULL DEFAULT 0,
                avatar TEXT,
                thread_id INTEGER,
                title TEXT NOT NULL DEFAULT '',
                notify INTEGER NOT NULL DEFAULT 1,
                retain_detail_days INTEGER NOT NULL DEFAULT 30
            );
            INSERT INTO named_agents
                (name, engine, memory_budget, working_dir, default_model, default_effort,
                 created_at, updated_at)
            VALUES ('Scout', 'codex', 2200, '/tmp/scout-dir', 'gpt-5.2', 'low', 0, 0);
            CREATE TABLE routines (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                agent_id INTEGER NOT NULL,
                name TEXT NOT NULL,
                name_folded TEXT NOT NULL,
                prompt TEXT NOT NULL,
                cadence TEXT NOT NULL,
                enabled INTEGER NOT NULL DEFAULT 1,
                author TEXT NOT NULL DEFAULT 'builder',
                workspace_id TEXT,
                next_run_at_ms INTEGER NOT NULL,
                last_run_at_ms INTEGER,
                last_run_session_id INTEGER,
                last_error TEXT,
                revision TEXT NOT NULL,
                permission_mode TEXT NOT NULL DEFAULT 'accept_edits',
                isolate INTEGER NOT NULL DEFAULT 0,
                last_outcome TEXT,
                continue_context INTEGER NOT NULL DEFAULT 0,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            );
            INSERT INTO routines
                (agent_id, name, name_folded, prompt, cadence, enabled, author,
                 next_run_at_ms, last_error, last_outcome, revision, created_at, updated_at)
            VALUES (1, 'Legacy sweep', 'legacy sweep', 'run the sweep',
                    '{\"type\":\"interval\",\"seconds\":900}', 1, 'agent', 0,
                    'conversation archive full', 'archive_full', 'rev-legacy', 0, 0);
            CREATE TABLE routine_runs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                routine_id INTEGER NOT NULL,
                trigger TEXT NOT NULL,
                status TEXT NOT NULL,
                session_id INTEGER,
                thread_id INTEGER,
                error TEXT,
                started_at_ms INTEGER NOT NULL,
                ended_at_ms INTEGER
            );
            INSERT INTO routine_runs
                (routine_id, trigger, status, thread_id, error, started_at_ms)
            VALUES (1, 'schedule', 'archive_full', 7, 'conversation archive full', 0);
            CREATE TABLE chat_threads (id INTEGER);
            CREATE TABLE chat_messages (id INTEGER);
            CREATE TABLE agent_messages (id INTEGER);
            CREATE TABLE agent_skill_sources (id INTEGER);",
        )
        .unwrap();
    }

    let daemon = Daemon::new(DaemonConfig {
        token: TOKEN.to_string(),
        db_path: db_path.clone(),
    })
    .unwrap();
    let list = routines_of(daemon.routine_list());
    assert_eq!(list.len(), 1, "the routine is preserved");
    let r = &list[0];
    assert_eq!(r.name, "Legacy sweep");
    assert_eq!(
        r.engine,
        proto::AgentKind::Codex,
        "engine inherited from the bot"
    );
    assert_eq!(r.model.as_deref(), Some("gpt-5.2"));
    assert_eq!(r.effort, Some(proto::ChatEffort::Low));
    assert_eq!(
        r.workspace_id.as_deref(),
        Some("/tmp/scout-dir"),
        "directory inherited from the bot"
    );

    let proto::ServerMsg::RoutineRuns { runs } = daemon.routine_runs_list(Some(r.id)) else {
        unreachable!()
    };
    assert_eq!(runs.len(), 1, "run history is preserved");
    assert_eq!(runs[0].status, proto::RoutineRunStatus::Failed);
    assert_eq!(
        runs[0].error.as_deref(),
        Some("the previous run could not complete before routines became standalone")
    );
    assert_eq!(r.last_outcome, Some(proto::RoutineOutcome::Failed));
    assert_eq!(
        r.last_error.as_deref(),
        Some("the previous run could not complete before routines became standalone")
    );

    let conn = rusqlite::Connection::open(&db_path).unwrap();
    let columns: Vec<String> = conn
        .prepare("SELECT name FROM pragma_table_info('routines')")
        .unwrap()
        .query_map([], |row| row.get(0))
        .unwrap()
        .map(|r| r.unwrap())
        .collect();
    for gone in ["agent_id", "thread_id", "continue_context", "author"] {
        assert!(
            !columns.iter().any(|c| c == gone),
            "routines still carries {gone}: {columns:?}"
        );
    }
    for table in [
        "named_agents",
        "agent_messages",
        "agent_skill_sources",
        "chat_threads",
        "chat_messages",
    ] {
        let n: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?1",
                rusqlite::params![table],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(n, 0, "{table} must be dropped");
    }
}

#[tokio::test]
async fn refusals_are_direct_replies_and_successes_are_broadcast() {
    let (addr, _state) = start_daemon().await;
    let mut a = connect_and_hello(addr, TOKEN).await;
    let mut b = connect_and_hello(addr, TOKEN).await;
    let create = |name: &str| {
        serde_json::to_string(&proto::ClientMsg::RoutineCreate {
            name: name.to_string(),
            prompt: "run it".to_string(),
            cadence: interval(900),
            workspace_id: None,
            engine: Some(proto::AgentKind::Claude),
            model: None,
            effort: None,
            permission_mode: None,
            isolate: None,
        })
        .unwrap()
    };
    a.send(tokio_tungstenite::tungstenite::Message::text(create(
        "Nightly",
    )))
    .await
    .unwrap();
    let on_a = routines_of(next_routine_reply(&mut a).await);
    let on_b = routines_of(next_routine_reply(&mut b).await);
    assert_eq!(on_a, on_b, "a successful create reaches both connections");
    assert_eq!(on_a.len(), 1);

    a.send(tokio_tungstenite::tungstenite::Message::text(create(
        "nightly",
    )))
    .await
    .unwrap();
    let refusal = refused(next_routine_reply(&mut a).await);
    assert_eq!(refusal.kind, proto::RoutineErrorKind::DuplicateName);
}

async fn next_routine_reply(ws: &mut common::WsStream) -> proto::ServerMsg {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    loop {
        let msg = tokio::time::timeout_at(deadline, futures_util::StreamExt::next(ws))
            .await
            .expect("timed out waiting for a routine reply")
            .expect("the socket is open")
            .expect("a frame arrives");
        let tokio_tungstenite::tungstenite::Message::Text(text) = msg else {
            continue;
        };
        let parsed: proto::ServerMsg = serde_json::from_str(&text).unwrap();
        if matches!(
            parsed,
            proto::ServerMsg::Routines { .. } | proto::ServerMsg::RoutineRefused { .. }
        ) {
            return parsed;
        }
    }
}
