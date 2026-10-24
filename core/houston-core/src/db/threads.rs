//! Houston's own history of thread sessions, one row per stored `ThreadEvent`. Rows
//! follow a session through respawn and restore and go when its row is closed or deleted.
use anyhow::{Context, Result};
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
            BEGIN DELETE FROM thread_events WHERE session_id = OLD.id; END;",
    )?;
    Ok(())
}

/// A replacement row takes its predecessor's history before the predecessor is closed.
pub(super) fn move_history(conn: &Connection, old: u32, new: u32) -> Result<()> {
    conn.execute(
        "UPDATE thread_events SET session_id = ?2 WHERE session_id = ?1",
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
