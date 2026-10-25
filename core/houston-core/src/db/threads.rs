//! Houston's own history of thread sessions, one row per stored `ThreadEvent`. Rows
//! follow a session through respawn and restore and go when its row is closed or deleted.
use anyhow::{bail, Context, Result};
use houston_protocol as proto;
use rusqlite::{Connection, OptionalExtension};

use super::Db;

pub(super) fn migrate(conn: &Connection) -> Result<()> {
    super::add_column_if_missing(
        conn,
        "sessions",
        "view",
        "view TEXT NOT NULL DEFAULT 'terminal'",
    )?;
    super::add_column_if_missing(conn, "sessions", "thread_group", "thread_group TEXT")?;
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS thread_events (
            session_id INTEGER NOT NULL,
            seq INTEGER NOT NULL,
            at_ms INTEGER NOT NULL,
            kind TEXT NOT NULL,
            PRIMARY KEY (session_id, seq)
        ) WITHOUT ROWID;
        DELETE FROM thread_events WHERE session_id NOT IN (SELECT id FROM sessions WHERE state != 'closed');
        CREATE TRIGGER IF NOT EXISTS thread_events_closed AFTER UPDATE OF state ON sessions
            WHEN NEW.state = 'closed' BEGIN DELETE FROM thread_events WHERE session_id = NEW.id; END;
        CREATE TRIGGER IF NOT EXISTS thread_events_deleted AFTER DELETE ON sessions
            BEGIN DELETE FROM thread_events WHERE session_id = OLD.id; END;
        CREATE TABLE IF NOT EXISTS thread_queue (
            session_id INTEGER NOT NULL,
            id TEXT NOT NULL,
            position INTEGER NOT NULL,
            text TEXT NOT NULL,
            state TEXT NOT NULL,
            hold_reason TEXT,
            created_at_ms INTEGER NOT NULL,
            PRIMARY KEY (session_id, id)
        ) WITHOUT ROWID;
        DELETE FROM thread_queue WHERE session_id NOT IN (SELECT id FROM sessions WHERE state != 'closed');
        CREATE TRIGGER IF NOT EXISTS thread_queue_closed AFTER UPDATE OF state ON sessions
            WHEN NEW.state = 'closed' BEGIN DELETE FROM thread_queue WHERE session_id = NEW.id; END;
        CREATE TRIGGER IF NOT EXISTS thread_queue_deleted AFTER DELETE ON sessions
            BEGIN DELETE FROM thread_queue WHERE session_id = OLD.id; END;",
    )?;
    Ok(())
}

/// Why a message left `queued` when its daemon stopped.
pub const THREAD_QUEUE_RESTART_REASON: &str = "Houston restarted before this message was sent.";

fn queue_state_name(state: proto::QueuedState) -> &'static str {
    match state {
        proto::QueuedState::Queued => "queued",
        proto::QueuedState::Held => "held",
    }
}

fn queue_rows(conn: &Connection, session: u32) -> Result<Vec<proto::ThreadQueuedMessage>> {
    let mut stmt = conn.prepare(
        "SELECT id, text, state, hold_reason, created_at_ms FROM thread_queue
         WHERE session_id = ?1 ORDER BY position",
    )?;
    let rows = stmt
        .query_map([session], |row| {
            Ok(proto::ThreadQueuedMessage {
                id: row.get(0)?,
                text: row.get(1)?,
                state: match row.get::<_, String>(2)?.as_str() {
                    "queued" => proto::QueuedState::Queued,
                    _ => proto::QueuedState::Held,
                },
                hold_reason: row.get(3)?,
                created_at_ms: row.get::<_, i64>(4)? as u64,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

/// Refuses a queue that would exceed `THREAD_QUEUE_MAX_ITEMS` or `THREAD_QUEUE_MAX_BYTES`;
/// `replaced` is a message whose text `text` replaces.
fn ensure_queue_room(
    conn: &Connection,
    session: u32,
    verb: &str,
    replaced: Option<&str>,
    text: &str,
) -> Result<()> {
    let (items, bytes): (i64, i64) = conn.query_row(
        "SELECT COUNT(*), COALESCE(SUM(LENGTH(CAST(text AS BLOB))), 0) FROM thread_queue
         WHERE session_id = ?1 AND id IS NOT ?2",
        rusqlite::params![session, replaced],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )?;
    let items = items as usize;
    if replaced.is_none() && items >= proto::THREAD_QUEUE_MAX_ITEMS {
        bail!(
            "{verb} refused for session {session}: the queue holds {items} messages, the limit \
             (THREAD_QUEUE_MAX_ITEMS) is {}; send or remove one to queue a message",
            proto::THREAD_QUEUE_MAX_ITEMS
        );
    }
    let total = bytes as usize + text.len();
    if total > proto::THREAD_QUEUE_MAX_BYTES {
        bail!(
            "{verb} refused for session {session}: the queue would hold {total} bytes, over the \
             {} byte limit (THREAD_QUEUE_MAX_BYTES); send or remove a message to queue a message",
            proto::THREAD_QUEUE_MAX_BYTES
        );
    }
    Ok(())
}

/// A replacement row takes its predecessor's history and queue before the predecessor is closed.
pub(super) fn move_history(conn: &Connection, old: u32, new: u32) -> Result<()> {
    conn.execute(
        "UPDATE thread_events SET session_id = ?2 WHERE session_id = ?1",
        [old, new],
    )?;
    conn.execute(
        "UPDATE thread_queue SET session_id = ?2 WHERE session_id = ?1",
        [old, new],
    )?;
    Ok(())
}

fn view_from_str(view: &str) -> proto::SessionView {
    match view {
        "thread" => proto::SessionView::Thread,
        _ => proto::SessionView::Terminal,
    }
}

pub(super) fn view_of(conn: &Connection, id: u32) -> Result<proto::SessionView> {
    let view: Option<String> = conn
        .query_row("SELECT view FROM sessions WHERE id = ?1", [id], |row| {
            row.get(0)
        })
        .optional()?;
    Ok(view
        .as_deref()
        .map_or(proto::SessionView::Terminal, view_from_str))
}

pub(super) fn parse_view(view: Option<String>) -> proto::SessionView {
    view.as_deref()
        .map_or(proto::SessionView::Terminal, view_from_str)
}

impl Db {
    /// A row that is not closed: closed sessions keep no thread history.
    pub fn session_exists(&self, id: u32) -> Result<bool> {
        let conn = self.conn.lock().expect("db lock");
        Ok(conn
            .query_row(
                "SELECT 1 FROM sessions WHERE id = ?1 AND state != 'closed'",
                [id],
                |_| Ok(()),
            )
            .optional()?
            .is_some())
    }

    /// The process group of the thread's current Claude, as JSON (`ThreadGroup`).
    pub fn set_thread_group(&self, id: u32, group: &str) -> Result<()> {
        let conn = self.conn.lock().expect("db lock");
        conn.execute(
            "UPDATE sessions SET thread_group = ?2 WHERE id = ?1",
            rusqlite::params![id, group],
        )?;
        Ok(())
    }

    /// The daemon ended the thread's process tree itself; nothing is left to reclaim.
    pub fn clear_thread_group(&self, id: u32) -> Result<()> {
        let conn = self.conn.lock().expect("db lock");
        conn.execute(
            "UPDATE sessions SET thread_group = NULL WHERE id = ?1",
            [id],
        )?;
        Ok(())
    }

    /// Whether the stored history ends inside a turn: a user message with no later turn end.
    pub fn thread_turn_left_open(&self, session: u32) -> Result<bool> {
        let conn = self.conn.lock().expect("db lock");
        let last_of = |kind: &str| -> Result<Option<i64>> {
            Ok(conn.query_row(
                "SELECT MAX(seq) FROM thread_events \
                 WHERE session_id = ?1 AND json_extract(kind, '$.type') = ?2",
                rusqlite::params![session, kind],
                |row| row.get(0),
            )?)
        };
        let message = last_of("user_message")?;
        let end = last_of("turn_end")?;
        Ok(message.is_some_and(|message| end.is_none_or(|end| end < message)))
    }

    pub fn thread_group(&self, id: u32) -> Result<Option<String>> {
        let conn = self.conn.lock().expect("db lock");
        Ok(conn
            .query_row(
                "SELECT thread_group FROM sessions WHERE id = ?1",
                [id],
                |row| row.get(0),
            )
            .optional()?
            .flatten())
    }

    pub fn session_view(&self, id: u32) -> Result<proto::SessionView> {
        let conn = self.conn.lock().expect("db lock");
        view_of(&conn, id)
    }

    /// Stores one event; returns the bytes of JSON it added.
    pub fn thread_event_insert(&self, session: u32, event: &proto::ThreadEvent) -> Result<u64> {
        let kind = serde_json::to_string(&event.kind)?;
        let conn = self.conn.lock().expect("db lock");
        conn.execute(
            "INSERT OR REPLACE INTO thread_events (session_id, seq, at_ms, kind) VALUES (?1, ?2, ?3, ?4)",
            rusqlite::params![session, event.seq as i64, event.at_ms as i64, kind],
        )
        .with_context(|| format!("storing thread event {} of session {session}", event.seq))?;
        Ok(kind.len() as u64)
    }

    /// Permission requests in the history that never got a resolution: their process ended
    /// with a daemon that stopped before it could record one.
    pub fn thread_unresolved_approvals(&self, session: u32) -> Result<Vec<String>> {
        let conn = self.conn.lock().expect("db lock");
        let mut stmt = conn.prepare(
            "SELECT json_extract(kind, '$.request_id') FROM thread_events
             WHERE session_id = ?1 AND json_extract(kind, '$.type') = 'approval_request'
               AND json_extract(kind, '$.request_id') NOT IN (
                 SELECT json_extract(kind, '$.request_id') FROM thread_events
                 WHERE session_id = ?1 AND json_extract(kind, '$.type') = 'approval_resolved')
             ORDER BY seq",
        )?;
        let ids = stmt
            .query_map([session], |row| row.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(ids)
    }

    /// Stored events and their JSON bytes.
    pub fn thread_usage(&self, session: u32) -> Result<(u64, u64)> {
        let conn = self.conn.lock().expect("db lock");
        Ok(conn.query_row(
            "SELECT COUNT(*), COALESCE(SUM(LENGTH(CAST(kind AS BLOB))), 0) FROM thread_events WHERE session_id = ?1",
            [session],
            |row| Ok((row.get::<_, i64>(0)? as u64, row.get::<_, i64>(1)? as u64)),
        )?)
    }

    pub fn thread_max_seq(&self, session: u32) -> Result<Option<u64>> {
        let conn = self.conn.lock().expect("db lock");
        let max: Option<i64> = conn.query_row(
            "SELECT MAX(seq) FROM thread_events WHERE session_id = ?1",
            [session],
            |row| row.get(0),
        )?;
        Ok(max.map(|seq| seq as u64))
    }

    /// Deletes the oldest events until at most `keep_events` and `keep_bytes` remain, then
    /// stores `notice` just before the oldest survivor. Returns the new (events, bytes).
    pub fn thread_prune(
        &self,
        session: u32,
        keep_events: u64,
        keep_bytes: u64,
        notice: &str,
        now_ms: u64,
    ) -> Result<(u64, u64)> {
        let mut conn = self.conn.lock().expect("db lock");
        let tx = conn.transaction()?;
        let cutoff = {
            let mut stmt = tx.prepare(
                "SELECT seq, LENGTH(CAST(kind AS BLOB)) FROM thread_events WHERE session_id = ?1 ORDER BY seq DESC",
            )?;
            let mut rows = stmt.query([session])?;
            let (mut events, mut bytes) = (0u64, 0u64);
            let mut cutoff = None;
            while let Some(row) = rows.next()? {
                let (seq, len): (i64, i64) = (row.get(0)?, row.get(1)?);
                if events + 1 > keep_events || bytes + len as u64 > keep_bytes {
                    cutoff = Some(seq);
                    break;
                }
                events += 1;
                bytes += len as u64;
            }
            cutoff
        };
        if let Some(cutoff) = cutoff {
            tx.execute(
                "DELETE FROM thread_events WHERE session_id = ?1 AND seq <= ?2",
                rusqlite::params![session, cutoff],
            )?;
            let oldest: Option<i64> = tx.query_row(
                "SELECT MIN(seq) FROM thread_events WHERE session_id = ?1",
                [session],
                |row| row.get(0),
            )?;
            let kind = serde_json::to_string(&proto::ThreadEventKind::Notice {
                text: notice.to_string(),
            })?;
            tx.execute(
                "INSERT INTO thread_events (session_id, seq, at_ms, kind) VALUES (?1, ?2, ?3, ?4)",
                rusqlite::params![
                    session,
                    oldest.unwrap_or(cutoff + 1) - 1,
                    now_ms as i64,
                    kind
                ],
            )?;
        }
        let usage = tx.query_row(
            "SELECT COUNT(*), COALESCE(SUM(LENGTH(CAST(kind AS BLOB))), 0) FROM thread_events WHERE session_id = ?1",
            [session],
            |row| Ok((row.get::<_, i64>(0)? as u64, row.get::<_, i64>(1)? as u64)),
        )?;
        tx.commit()?;
        Ok(usage)
    }

    pub fn thread_queue(&self, session: u32) -> Result<Vec<proto::ThreadQueuedMessage>> {
        let conn = self.conn.lock().expect("db lock");
        queue_rows(&conn, session)
    }

    /// Appends a message within the queue limits; returns the queue after it.
    pub fn thread_queue_push(
        &self,
        session: u32,
        verb: &str,
        message: &proto::ThreadQueuedMessage,
    ) -> Result<Vec<proto::ThreadQueuedMessage>> {
        let mut conn = self.conn.lock().expect("db lock");
        let tx = conn.transaction()?;
        ensure_queue_room(&tx, session, verb, None, &message.text)?;
        tx.execute(
            "INSERT INTO thread_queue (session_id, id, position, text, state, hold_reason, created_at_ms)
             VALUES (?1, ?2, (SELECT COALESCE(MAX(position), 0) + 1 FROM thread_queue WHERE session_id = ?1),
                     ?3, ?4, ?5, ?6)",
            rusqlite::params![
                session,
                message.id,
                message.text,
                queue_state_name(message.state),
                message.hold_reason,
                message.created_at_ms as i64
            ],
        )
        .with_context(|| format!("queueing message {} of session {session}", message.id))?;
        let rows = queue_rows(&tx, session)?;
        tx.commit()?;
        Ok(rows)
    }

    /// Replaces a waiting message's text in place; `None` when no such message waits.
    pub fn thread_queue_edit(
        &self,
        session: u32,
        id: &str,
        text: &str,
    ) -> Result<Option<Vec<proto::ThreadQueuedMessage>>> {
        let mut conn = self.conn.lock().expect("db lock");
        let tx = conn.transaction()?;
        let changed = tx.execute(
            "UPDATE thread_queue SET text = ?3 WHERE session_id = ?1 AND id = ?2",
            rusqlite::params![session, id, text],
        )?;
        if changed == 0 {
            return Ok(None);
        }
        ensure_queue_room(&tx, session, "thread_queue_edit", Some(id), text)?;
        let rows = queue_rows(&tx, session)?;
        tx.commit()?;
        Ok(Some(rows))
    }

    /// Removes a message; `None` when no such message waits.
    pub fn thread_queue_remove(
        &self,
        session: u32,
        id: &str,
    ) -> Result<Option<Vec<proto::ThreadQueuedMessage>>> {
        let conn = self.conn.lock().expect("db lock");
        let removed = conn.execute(
            "DELETE FROM thread_queue WHERE session_id = ?1 AND id = ?2",
            rusqlite::params![session, id],
        )?;
        if removed == 0 {
            return Ok(None);
        }
        Ok(Some(queue_rows(&conn, session)?))
    }

    /// Takes one message out of the queue before it is written: `id`, or with `None` the
    /// head when it is `queued` (a held head stops the drain, so order is kept). A taken
    /// message is gone from the table, so a second take of it finds nothing.
    pub fn thread_queue_take(
        &self,
        session: u32,
        id: Option<&str>,
    ) -> Result<Option<(proto::ThreadQueuedMessage, Vec<proto::ThreadQueuedMessage>)>> {
        let mut conn = self.conn.lock().expect("db lock");
        let tx = conn.transaction()?;
        let rows = queue_rows(&tx, session)?;
        let taken = match id {
            Some(id) => rows.iter().find(|row| row.id == id),
            None => rows
                .first()
                .filter(|row| row.state == proto::QueuedState::Queued),
        };
        let Some(taken) = taken.cloned() else {
            return Ok(None);
        };
        tx.execute(
            "DELETE FROM thread_queue WHERE session_id = ?1 AND id = ?2",
            rusqlite::params![session, taken.id],
        )?;
        let rows = queue_rows(&tx, session)?;
        tx.commit()?;
        Ok(Some((taken, rows)))
    }

    /// Puts a taken message back at the head as `held`, for a write that failed. The
    /// limits do not apply: the message was counted before it was taken.
    pub fn thread_queue_restore(
        &self,
        session: u32,
        message: &proto::ThreadQueuedMessage,
        reason: &str,
    ) -> Result<Vec<proto::ThreadQueuedMessage>> {
        let mut conn = self.conn.lock().expect("db lock");
        let tx = conn.transaction()?;
        tx.execute(
            "INSERT OR REPLACE INTO thread_queue
                 (session_id, id, position, text, state, hold_reason, created_at_ms)
             VALUES (?1, ?2, (SELECT COALESCE(MIN(position), 1) - 1 FROM thread_queue WHERE session_id = ?1),
                     ?3, 'held', ?4, ?5)",
            rusqlite::params![
                session,
                message.id,
                message.text,
                reason,
                message.created_at_ms as i64
            ],
        )?;
        let rows = queue_rows(&tx, session)?;
        tx.commit()?;
        Ok(rows)
    }

    /// Holds every `queued` message with `reason`; returns the queue when anything changed.
    pub fn thread_queue_hold(
        &self,
        session: u32,
        reason: &str,
    ) -> Result<Option<Vec<proto::ThreadQueuedMessage>>> {
        let conn = self.conn.lock().expect("db lock");
        let held = conn.execute(
            "UPDATE thread_queue SET state = 'held', hold_reason = ?2
             WHERE session_id = ?1 AND state = 'queued'",
            rusqlite::params![session, reason],
        )?;
        if held == 0 {
            return Ok(None);
        }
        Ok(Some(queue_rows(&conn, session)?))
    }

    /// Daemon start: nothing a previous daemon queued is sent until the user sends it.
    pub fn thread_queue_recover(&self) -> Result<usize> {
        let conn = self.conn.lock().expect("db lock");
        Ok(conn.execute(
            "UPDATE thread_queue SET state = 'held', hold_reason = ?1 WHERE state = 'queued'",
            [THREAD_QUEUE_RESTART_REASON],
        )?)
    }

    /// Up to `limit` events before `before_seq` (the newest when `None`), oldest first,
    /// and whether earlier ones remain.
    pub fn thread_events_page(
        &self,
        session: u32,
        before_seq: Option<u64>,
        limit: u32,
    ) -> Result<(Vec<proto::ThreadEvent>, bool)> {
        let conn = self.conn.lock().expect("db lock");
        let before = before_seq.map_or(i64::MAX, |seq| seq.min(i64::MAX as u64) as i64);
        let mut stmt = conn.prepare(
            "SELECT seq, at_ms, kind FROM thread_events WHERE session_id = ?1 AND seq < ?2
             ORDER BY seq DESC LIMIT ?3",
        )?;
        let rows = stmt
            .query_map(
                rusqlite::params![session, before, i64::from(limit) + 1],
                |row| {
                    Ok((
                        row.get::<_, i64>(0)?,
                        row.get::<_, i64>(1)?,
                        row.get::<_, String>(2)?,
                    ))
                },
            )?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        let has_more = rows.len() > limit as usize;
        let mut events = Vec::with_capacity(rows.len().min(limit as usize));
        for (seq, at_ms, kind) in rows.into_iter().take(limit as usize) {
            match serde_json::from_str(&kind) {
                Ok(kind) => events.push(proto::ThreadEvent {
                    seq: seq as u64,
                    at_ms: at_ms as u64,
                    kind,
                }),
                Err(error) => tracing::warn!(
                    "thread event {seq} of session {session} is unreadable ({error}); skipped"
                ),
            }
        }
        events.reverse();
        Ok((events, has_more))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn notice(seq: u64) -> proto::ThreadEvent {
        proto::ThreadEvent {
            seq,
            at_ms: seq,
            kind: proto::ThreadEventKind::Notice {
                text: format!("event {seq}"),
            },
        }
    }

    fn queued(id: &str, text: &str) -> proto::ThreadQueuedMessage {
        proto::ThreadQueuedMessage {
            id: id.into(),
            text: text.into(),
            state: proto::QueuedState::Queued,
            hold_reason: None,
            created_at_ms: 1,
        }
    }

    fn ids(rows: &[proto::ThreadQueuedMessage]) -> Vec<&str> {
        rows.iter().map(|row| row.id.as_str()).collect()
    }

    #[test]
    fn the_queue_keeps_order_and_a_taken_message_is_gone() {
        let tmp = tempfile::tempdir().unwrap();
        let db = Db::open(&tmp.path().join("t.db")).unwrap();
        db.thread_queue_push(4, "thread_send", &queued("a", "one"))
            .unwrap();
        let rows = db
            .thread_queue_push(4, "thread_send", &queued("b", "two"))
            .unwrap();
        assert_eq!(ids(&rows), ["a", "b"]);
        let (taken, rest) = db.thread_queue_take(4, None).unwrap().unwrap();
        assert_eq!((taken.id.as_str(), ids(&rest)), ("a", vec!["b"]));
        assert!(db.thread_queue_take(4, Some("a")).unwrap().is_none());
        let rows = db.thread_queue_restore(4, &taken, "write failed").unwrap();
        assert_eq!(
            ids(&rows),
            ["a", "b"],
            "a failed write goes back to the head"
        );
        assert_eq!(rows[0].state, proto::QueuedState::Held);
        assert!(
            db.thread_queue_take(4, None).unwrap().is_none(),
            "a held head stops the drain"
        );
        let rows = db.thread_queue_edit(4, "b", "TWO").unwrap().unwrap();
        assert_eq!(rows[1].text, "TWO");
        assert!(db.thread_queue_edit(4, "zz", "x").unwrap().is_none());
        let rows = db.thread_queue_remove(4, "a").unwrap().unwrap();
        assert_eq!(ids(&rows), ["b"]);
        assert!(
            db.thread_queue(5).unwrap().is_empty(),
            "queues are per session"
        );
    }

    #[test]
    fn queue_limits_name_the_limit_and_the_actual_value() {
        let tmp = tempfile::tempdir().unwrap();
        let db = Db::open(&tmp.path().join("t.db")).unwrap();
        for n in 0..proto::THREAD_QUEUE_MAX_ITEMS {
            db.thread_queue_push(4, "thread_send", &queued(&n.to_string(), "x"))
                .unwrap();
        }
        let full = db
            .thread_queue_push(4, "thread_send", &queued("over", "x"))
            .unwrap_err()
            .to_string();
        assert!(
            full.contains("holds 16 messages") && full.contains("THREAD_QUEUE_MAX_ITEMS"),
            "{full}"
        );
        assert!(full.contains("queue a message"), "{full}");
        let big = "y".repeat(proto::THREAD_QUEUE_MAX_BYTES);
        let over = db.thread_queue_edit(4, "0", &big).unwrap_err().to_string();
        assert!(
            over.contains(&format!("{} bytes", proto::THREAD_QUEUE_MAX_BYTES + 15))
                && over.contains("THREAD_QUEUE_MAX_BYTES"),
            "{over}"
        );
        assert_eq!(
            db.thread_queue(4).unwrap()[0].text,
            "x",
            "a refused edit changes nothing"
        );
    }

    #[test]
    fn a_restarted_daemon_holds_what_was_queued() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("t.db");
        let db = Db::open(&path).unwrap();
        db.thread_queue_push(4, "thread_send", &queued("a", "one"))
            .unwrap();
        assert!(db.thread_queue_hold(4, "stopped").unwrap().is_some());
        assert!(db.thread_queue_hold(4, "again").unwrap().is_none());
        db.thread_queue_push(4, "thread_send", &queued("b", "two"))
            .unwrap();
        assert_eq!(db.thread_queue_recover().unwrap(), 1);
        let rows = db.thread_queue(4).unwrap();
        assert_eq!(
            rows.iter()
                .map(|row| (row.state, row.hold_reason.as_deref()))
                .collect::<Vec<_>>(),
            [
                (proto::QueuedState::Held, Some("stopped")),
                (proto::QueuedState::Held, Some(THREAD_QUEUE_RESTART_REASON))
            ]
        );
    }

    #[test]
    fn pruning_keeps_the_newest_events_behind_one_notice() {
        let tmp = tempfile::tempdir().unwrap();
        let db = Db::open(&tmp.path().join("t.db")).unwrap();
        for seq in 1..=10 {
            db.thread_event_insert(4, &notice(seq)).unwrap();
        }
        db.thread_event_insert(5, &notice(1)).unwrap();
        let (events, _) = db
            .thread_prune(4, 4, u64::MAX, "earlier removed", 99)
            .unwrap();
        assert_eq!(events, 5);
        let (page, has_more) = db.thread_events_page(4, None, 500).unwrap();
        assert!(!has_more);
        assert_eq!(
            page.iter().map(|e| e.seq).collect::<Vec<_>>(),
            [6, 7, 8, 9, 10]
        );
        assert_eq!(
            page[0].kind,
            proto::ThreadEventKind::Notice {
                text: "earlier removed".into()
            }
        );
        assert_eq!(
            db.thread_usage(5).unwrap().0,
            1,
            "other sessions are untouched"
        );
        let (older, has_more) = db.thread_events_page(4, Some(9), 2).unwrap();
        assert!(has_more);
        assert_eq!(older.iter().map(|e| e.seq).collect::<Vec<_>>(), [7, 8]);
    }
}
