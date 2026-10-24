//! A session's view and the turns it took in terminal view, which a later switch to the
//! thread view reports as one notice (Houston never reads the transcript behind them).
use anyhow::{Context, Result};
use houston_protocol as proto;
use rusqlite::{Connection, OptionalExtension};

use super::Db;

pub(super) fn migrate(conn: &Connection) -> Result<()> {
    super::add_column_if_missing(
        conn,
        "sessions",
        "terminal_turns",
        "terminal_turns INTEGER NOT NULL DEFAULT 0",
    )
}

impl Db {
    pub fn set_session_view(&self, id: u32, view: proto::SessionView) -> Result<()> {
        let conn = self.conn.lock().expect("db lock");
        let changed = conn
            .execute(
                "UPDATE sessions SET view = ?2 WHERE id = ?1",
                rusqlite::params![id, view.as_str()],
            )
            .with_context(|| format!("storing view {} for session {id}", view.as_str()))?;
        if changed == 0 {
            anyhow::bail!("session {id} has no row to store view {} on", view.as_str());
        }
        Ok(())
    }

    pub fn terminal_turns(&self, id: u32) -> Result<u64> {
        let conn = self.conn.lock().expect("db lock");
        let turns: Option<i64> = conn
            .query_row(
                "SELECT terminal_turns FROM sessions WHERE id = ?1",
                [id],
                |row| row.get(0),
            )
            .optional()?;
        Ok(turns.unwrap_or(0).max(0) as u64)
    }

    /// Counts one turn end of a session in terminal view.
    pub fn add_terminal_turn(&self, id: u32) -> Result<()> {
        let conn = self.conn.lock().expect("db lock");
        conn.execute(
            "UPDATE sessions SET terminal_turns = terminal_turns + 1 WHERE id = ?1 AND view = 'terminal'",
            [id],
        )?;
        Ok(())
    }

    pub fn set_terminal_turns(&self, id: u32, turns: u64) -> Result<()> {
        let conn = self.conn.lock().expect("db lock");
        conn.execute(
            "UPDATE sessions SET terminal_turns = ?2 WHERE id = ?1",
            rusqlite::params![id, turns as i64],
        )?;
        Ok(())
    }

    /// Flips a session's view and, with `notice`, stores it after the session's history, in
    /// one transaction. Returns the notice's seq.
    pub fn begin_view_switch(
        &self,
        id: u32,
        view: proto::SessionView,
        notice: Option<&str>,
        now_ms: u64,
    ) -> Result<Option<u64>> {
        let mut conn = self.conn.lock().expect("db lock");
        let tx = conn.transaction()?;
        let seq = match notice {
            Some(text) => {
                let max: Option<i64> = tx.query_row(
                    "SELECT MAX(seq) FROM thread_events WHERE session_id = ?1",
                    [id],
                    |row| row.get(0),
                )?;
                let seq = max.map_or(1, |max| max as u64 + 1);
                let kind = serde_json::to_string(&proto::ThreadEventKind::Notice {
                    text: text.to_string(),
                })?;
                tx.execute(
                    "INSERT INTO thread_events (session_id, seq, at_ms, kind) VALUES (?1, ?2, ?3, ?4)",
                    rusqlite::params![id, seq as i64, now_ms as i64, kind],
                )?;
                Some(seq)
            }
            None => None,
        };
        let changed = tx.execute(
            "UPDATE sessions SET view = ?2 WHERE id = ?1",
            rusqlite::params![id, view.as_str()],
        )?;
        if changed == 0 {
            anyhow::bail!("session {id} has no row to store view {} on", view.as_str());
        }
        tx.commit()
            .with_context(|| format!("storing view {} for session {id}", view.as_str()))?;
        Ok(seq)
    }

    /// Undoes `begin_view_switch` after a failed respawn, in one transaction.
    pub fn undo_view_switch(
        &self,
        id: u32,
        view: proto::SessionView,
        notice_seq: Option<u64>,
    ) -> Result<()> {
        let mut conn = self.conn.lock().expect("db lock");
        let tx = conn.transaction()?;
        if let Some(seq) = notice_seq {
            tx.execute(
                "DELETE FROM thread_events WHERE session_id = ?1 AND seq = ?2",
                rusqlite::params![id, seq as i64],
            )?;
        }
        tx.execute(
            "UPDATE sessions SET view = ?2 WHERE id = ?1",
            rusqlite::params![id, view.as_str()],
        )?;
        tx.commit()?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::super::Db;
    use houston_protocol as proto;

    fn db_with_session(id: u32, view: proto::SessionView) -> (tempfile::TempDir, Db) {
        let dir = tempfile::tempdir().unwrap();
        let db = Db::open(&dir.path().join("houston.db")).unwrap();
        let mut info = super::super::tests::info(id, proto::SessionState::Running);
        info.view = view;
        db.insert_session(&info).unwrap();
        (dir, db)
    }

    #[test]
    fn counts_turns_only_in_terminal_view() {
        let (_dir, db) = db_with_session(4, proto::SessionView::Terminal);
        db.add_terminal_turn(4).unwrap();
        db.add_terminal_turn(4).unwrap();
        assert_eq!(db.terminal_turns(4).unwrap(), 2);
        db.set_session_view(4, proto::SessionView::Thread).unwrap();
        db.add_terminal_turn(4).unwrap();
        assert_eq!(db.terminal_turns(4).unwrap(), 2);
        assert_eq!(db.session_view(4).unwrap(), proto::SessionView::Thread);
    }

    #[test]
    fn a_view_switch_writes_its_notice_with_the_view_and_undoes_both() {
        let (_dir, db) = db_with_session(4, proto::SessionView::Terminal);
        let seq = db
            .begin_view_switch(4, proto::SessionView::Thread, Some("2 turns"), 9)
            .unwrap();
        assert_eq!(seq, Some(1));
        assert_eq!(db.session_view(4).unwrap(), proto::SessionView::Thread);
        db.undo_view_switch(4, proto::SessionView::Terminal, seq)
            .unwrap();
        assert_eq!(db.session_view(4).unwrap(), proto::SessionView::Terminal);
        assert_eq!(db.thread_max_seq(4).unwrap(), None);
        let missing = db
            .begin_view_switch(9, proto::SessionView::Thread, Some("lost"), 9)
            .unwrap_err();
        assert!(missing.to_string().contains("session 9"), "{missing:#}");
        assert_eq!(
            db.thread_max_seq(9).unwrap(),
            None,
            "the notice rolls back with the view"
        );
    }

    #[test]
    fn refuses_a_view_for_a_missing_row() {
        let (_dir, db) = db_with_session(4, proto::SessionView::Terminal);
        let error = db
            .set_session_view(9, proto::SessionView::Thread)
            .unwrap_err();
        assert!(error.to_string().contains("session 9"), "{error:#}");
    }
}
