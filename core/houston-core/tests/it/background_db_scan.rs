use houston_core::db::Db;
use rusqlite::{Connection, StatementStatus};

const PENDING_RECIPIENTS: &str = "SELECT DISTINCT to_session FROM pane_inbox \
    WHERE to_session != 0 AND resolved_at IS NULL \
    AND (delivered_at IS NULL OR kind IN ('question', 'blocked'))";

fn recipients_and_work(conn: &Connection) -> (Vec<u32>, i32) {
    let mut statement = conn.prepare(PENDING_RECIPIENTS).unwrap();
    let mut recipients = statement
        .query_map([], |row| row.get(0))
        .unwrap()
        .collect::<rusqlite::Result<Vec<u32>>>()
        .unwrap();
    recipients.sort_unstable();
    (recipients, statement.get_status(StatementStatus::VmStep))
}

#[test]
fn retained_results_do_not_expand_pending_recipient_work_after_upgrade() {
    let state = tempfile::tempdir().unwrap();
    let path = state.path().join("test.db");
    drop(Db::open(&path).unwrap());
    let mut conn = Connection::open(&path).unwrap();
    conn.execute_batch("DROP INDEX IF EXISTS pane_inbox_pending_recipients")
        .unwrap();
    let now = houston_core::hook_drop::now_ms();
    let tx = conn.transaction().unwrap();
    {
        let mut insert = tx
            .prepare("INSERT INTO pane_inbox (to_session, workspace, from_session, request_id, kind, summary, body, created_at, ready_at, delivered_at, delivered_via) VALUES (7, '/fixture', 8, ?1, 'result', 'completed', 'worker result', ?2, ?2, ?2, 'wait')")
            .unwrap();
        for round in 1..=4096 {
            insert.execute(rusqlite::params![round, now]).unwrap();
        }
    }
    tx.commit().unwrap();
    for (recipient, kind, delivered, resolved) in [
        (9, "result", false, false),
        (9, "progress", false, false),
        (10, "question", true, false),
        (11, "blocked", true, false),
        (12, "question", true, true),
        (0, "result", false, false),
    ] {
        conn.execute(
            "INSERT INTO pane_inbox (to_session, workspace, from_session, kind, summary, body, created_at, ready_at, delivered_at, delivered_via, resolved_at) VALUES (?1, '/fixture', 8, ?2, 'report', 'worker report', ?3, ?3, ?4, ?5, ?6)",
            rusqlite::params![recipient, kind, now, delivered.then_some(now), delivered.then_some("wait"), resolved.then_some(now)],
        )
        .unwrap();
    }
    let (before, legacy_work) = recipients_and_work(&conn);
    assert_eq!(before, vec![9, 10, 11]);
    assert!(
        legacy_work > 4096,
        "legacy fixture must scan retained history"
    );

    let db = Db::open(&path).unwrap();
    let (after, indexed_work) = recipients_and_work(&conn);
    assert_eq!(after, before);
    println!("pending recipients: retained=4096 legacy_vm_steps={legacy_work} indexed_vm_steps={indexed_work}");
    // Bound VM work, independent of machine speed, with only four pending entries.
    assert!(
        indexed_work < 100,
        "pending-recipient query spent {indexed_work} VM instructions on retained history"
    );
    let mut actual = db.inbox_pending_recipients().unwrap();
    actual.sort_unstable();
    assert_eq!(actual, after);

    for recipient in [10, 11] {
        let row = db.inbox_list_for_session(recipient).unwrap().pop().unwrap();
        assert_eq!(db.inbox_resolve(row.id, "answered", now + 1).unwrap(), 1);
    }
    assert_eq!(db.inbox_pending_recipients().unwrap(), vec![9]);
    let (remaining, work) = recipients_and_work(&conn);
    assert_eq!(remaining, vec![9]);
    assert!(work < 100);
}

#[test]
fn sent_tracker_revisions_do_not_expand_retry_work_after_upgrade() {
    let state = tempfile::tempdir().unwrap();
    let path = state.path().join("test.db");
    drop(Db::open(&path).unwrap());
    let mut conn = Connection::open(&path).unwrap();
    conn.execute_batch("DROP INDEX IF EXISTS task_tracker_outbox_pending")
        .unwrap();
    let payload = r#"{"external_id":"11111111-1111-1111-1111-111111111111","status":"done"}"#;
    let receipt =
        r#"{"external_id":"11111111-1111-1111-1111-111111111111","url":null,"remote_rev":null}"#;
    let tx = conn.transaction().unwrap();
    tx.execute("INSERT INTO backlog_tasks (id, workspace, number, title, status, revision, created_by, created_at, updated_at) VALUES (1, '/fixture', 1, 'tracker fixture', 'done', 4098, 'user', 1, 100)", []).unwrap();
    {
        let mut insert = tx
            .prepare("INSERT INTO task_tracker_outbox (workspace, task_id, provider, action, revision, payload, next_attempt_at_ms, receipt) VALUES ('/fixture', 1, 'notion', 'status', ?1, ?2, 100, ?3)")
            .unwrap();
        for revision in 1..=4096 {
            insert
                .execute(rusqlite::params![revision, payload, receipt])
                .unwrap();
        }
    }
    tx.commit().unwrap();
    for (revision, next_attempt) in [(4097, 100), (4098, 200)] {
        conn.execute("INSERT INTO task_tracker_outbox (workspace, task_id, provider, action, revision, payload, next_attempt_at_ms) VALUES ('/fixture', 1, 'notion', 'status', ?1, ?2, ?3)", rusqlite::params![revision, payload, next_attempt]).unwrap();
    }
    let query = "SELECT id, workspace, task_id, provider, action, revision, payload, attempts, last_error \
        FROM task_tracker_outbox WHERE receipt IS NULL AND next_attempt_at_ms <= ?1 ORDER BY id LIMIT ?2";
    let work = || {
        let mut statement = conn.prepare(query).unwrap();
        let revisions = statement
            .query_map([100, 25], |row| row.get::<_, i64>(5))
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap();
        (revisions, statement.get_status(StatementStatus::VmStep))
    };
    let (before, legacy_work) = work();
    assert_eq!(before, vec![4097]);
    assert!(
        legacy_work > 4096,
        "legacy fixture must scan sent revisions"
    );

    let db = Db::open(&path).unwrap();
    let (after, indexed_work) = work();
    assert_eq!(after, before);
    println!("pending tracker retries: retained=4096 legacy_vm_steps={legacy_work} indexed_vm_steps={indexed_work}");
    assert!(
        indexed_work < 100,
        "outbox retry query spent {indexed_work} VM instructions on sent revisions"
    );
    let due = db.task_tracker_outbox_pending(100, 25).unwrap();
    assert_eq!(due.len(), 1);
    assert_eq!(due[0].revision, 4097);
    db.task_tracker_outbox_sent(due[0].id, receipt, 101)
        .unwrap();
    let (after_send, work_after_send) = work();
    assert!(after_send.is_empty());
    assert!(work_after_send < 100);
    assert_eq!(
        db.task_tracker_outbox_pending(200, 25).unwrap()[0].revision,
        4098
    );
}
