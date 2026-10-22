use super::*;
use crate::transfer::manifest::{PaneOrigin, TreeState};
use rusqlite::params;

pub(crate) fn init(conn: &Connection) -> Result<()> {
    add_column_if_missing(
        conn,
        "sessions",
        "transferred_at_ms",
        "transferred_at_ms INTEGER",
    )?;
    add_column_if_missing(
        conn,
        "sessions",
        "transfer_fork",
        "transfer_fork INTEGER NOT NULL DEFAULT 0",
    )?;
    // The same id can be both directions on one computer: a file imported where it was made.
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS workspace_transfers (
            id TEXT NOT NULL,
            direction TEXT NOT NULL CHECK (direction IN ('export', 'import')),
            workspace TEXT NOT NULL,
            created_at_ms INTEGER NOT NULL,
            PRIMARY KEY (id, direction)
        );
        CREATE TABLE IF NOT EXISTS workspace_transfer_checkouts (
            transfer_id TEXT NOT NULL,
            direction TEXT NOT NULL,
            key TEXT NOT NULL,
            path TEXT NOT NULL,
            tree_state TEXT,
            untracked TEXT NOT NULL,
            PRIMARY KEY (transfer_id, direction, key)
        );
        CREATE TABLE IF NOT EXISTS workspace_transfer_sessions (
            transfer_id TEXT NOT NULL,
            direction TEXT NOT NULL,
            local_session INTEGER NOT NULL,
            source_session INTEGER NOT NULL,
            conversation TEXT NOT NULL,
            transcript_path TEXT NOT NULL,
            transcript_sha256 TEXT NOT NULL,
            PRIMARY KEY (transfer_id, direction, local_session)
        );
        CREATE INDEX IF NOT EXISTS workspace_transfer_sessions_conversation
            ON workspace_transfer_sessions(conversation);",
    )?;
    Ok(())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TransferDirection {
    Export,
    Import,
}

impl TransferDirection {
    fn as_str(self) -> &'static str {
        match self {
            Self::Export => "export",
            Self::Import => "import",
        }
    }
}

#[derive(Debug, Clone)]
pub struct TransferCheckoutRecord {
    pub key: String,
    pub path: String,
    /// Recorded at export, for the return trip's unchanged-tree check.
    pub tree_state: Option<TreeState>,
    pub untracked: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct TransferSessionRecord {
    pub local_session: u32,
    pub source_session: u32,
    pub conversation: String,
    pub transcript_path: String,
    pub transcript_sha256: String,
}

#[derive(Debug, Clone)]
pub struct TransferRecord {
    pub id: String,
    pub direction: TransferDirection,
    pub workspace: String,
    pub created_at_ms: u64,
    pub checkouts: Vec<TransferCheckoutRecord>,
    pub sessions: Vec<TransferSessionRecord>,
}

impl Db {
    /// Records a transfer; an export also marks each exported pane as transferred.
    pub fn transfer_record(&self, record: &TransferRecord) -> Result<()> {
        let mut conn = self.conn.lock().expect("db lock");
        let tx = conn.transaction()?;
        let direction = record.direction.as_str();
        tx.execute(
            "INSERT OR REPLACE INTO workspace_transfers (id, direction, workspace, created_at_ms)
             VALUES (?1, ?2, ?3, ?4)",
            params![
                record.id,
                direction,
                record.workspace,
                record.created_at_ms as i64
            ],
        )?;
        for checkout in &record.checkouts {
            tx.execute(
                "INSERT OR REPLACE INTO workspace_transfer_checkouts
                    (transfer_id, direction, key, path, tree_state, untracked)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![
                    record.id,
                    direction,
                    checkout.key,
                    checkout.path,
                    checkout
                        .tree_state
                        .as_ref()
                        .map(serde_json::to_string)
                        .transpose()?,
                    serde_json::to_string(&checkout.untracked)?,
                ],
            )?;
        }
        for session in &record.sessions {
            tx.execute(
                "INSERT OR REPLACE INTO workspace_transfer_sessions
                    (transfer_id, direction, local_session, source_session, conversation,
                     transcript_path, transcript_sha256)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![
                    record.id,
                    direction,
                    session.local_session,
                    session.source_session,
                    session.conversation,
                    session.transcript_path,
                    session.transcript_sha256,
                ],
            )?;
            if record.direction == TransferDirection::Export {
                tx.execute(
                    "UPDATE sessions SET transferred_at_ms = ?2 WHERE id = ?1",
                    params![session.local_session, record.created_at_ms as i64],
                )?;
            }
        }
        tx.commit()?;
        Ok(())
    }

    /// The export this computer recorded under `id`.
    pub fn transfer_export(&self, id: &str) -> Result<Option<TransferRecord>> {
        let conn = self.conn.lock().expect("db lock");
        let Some((workspace, created_at_ms)) = conn
            .query_row(
                "SELECT workspace, created_at_ms FROM workspace_transfers
                 WHERE id = ?1 AND direction = 'export'",
                [id],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)),
            )
            .optional()?
        else {
            return Ok(None);
        };
        let mut statement = conn.prepare(
            "SELECT key, path, tree_state, untracked FROM workspace_transfer_checkouts
             WHERE transfer_id = ?1 AND direction = 'export' ORDER BY key",
        )?;
        let checkouts = statement
            .query_map([id], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, String>(3)?,
                ))
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?
            .into_iter()
            .map(|(key, path, state, untracked)| {
                Ok(TransferCheckoutRecord {
                    key,
                    path,
                    tree_state: state.map(|s| serde_json::from_str(&s)).transpose()?,
                    untracked: serde_json::from_str(&untracked)?,
                })
            })
            .collect::<Result<Vec<_>>>()?;
        let mut statement = conn.prepare(
            "SELECT local_session, source_session, conversation, transcript_path, transcript_sha256
             FROM workspace_transfer_sessions
             WHERE transfer_id = ?1 AND direction = 'export' ORDER BY local_session",
        )?;
        let sessions = statement
            .query_map([id], |row| {
                Ok(TransferSessionRecord {
                    local_session: row.get(0)?,
                    source_session: row.get(1)?,
                    conversation: row.get(2)?,
                    transcript_path: row.get(3)?,
                    transcript_sha256: row.get(4)?,
                })
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        Ok(Some(TransferRecord {
            id: id.to_string(),
            direction: TransferDirection::Export,
            workspace,
            created_at_ms: created_at_ms as u64,
            checkouts,
            sessions,
        }))
    }

    /// The latest import that brought `conversation` to this computer.
    pub fn transfer_conversation_origin(&self, conversation: &str) -> Result<Option<PaneOrigin>> {
        let conn = self.conn.lock().expect("db lock");
        Ok(conn
            .query_row(
                "SELECT transfer_id, source_session FROM workspace_transfer_sessions
                 WHERE conversation = ?1 AND direction = 'import'
                 ORDER BY rowid DESC LIMIT 1",
                [conversation],
                |row| {
                    Ok(PaneOrigin {
                        transfer_id: row.get(0)?,
                        session: row.get(1)?,
                    })
                },
            )
            .optional()?)
    }

    /// The latest import that restored the checkout at `path` under `key`.
    pub fn transfer_checkout_origin(&self, path: &str, key: &str) -> Result<Option<String>> {
        let conn = self.conn.lock().expect("db lock");
        Ok(conn
            .query_row(
                "SELECT transfer_id FROM workspace_transfer_checkouts
                 WHERE path = ?1 AND key = ?2 AND direction = 'import'
                 ORDER BY rowid DESC LIMIT 1",
                [path, key],
                |row| row.get(0),
            )
            .optional()?)
    }

    /// When the pane's conversation left in a transfer, and whether the pane continues
    /// a conversation that had left.
    pub fn session_transfer_mark(&self, id: u32) -> Result<(Option<u64>, bool)> {
        let conn = self.conn.lock().expect("db lock");
        Ok(conn
            .query_row(
                "SELECT transferred_at_ms, transfer_fork FROM sessions WHERE id = ?1",
                [id],
                |row| Ok((row.get::<_, Option<i64>>(0)?, row.get::<_, bool>(1)?)),
            )
            .optional()?
            .map(|(at, fork)| (at.map(|at| at as u64), fork))
            .unwrap_or((None, false)))
    }

    pub fn set_session_transfer_fork(&self, id: u32) -> Result<()> {
        let conn = self.conn.lock().expect("db lock");
        conn.execute("UPDATE sessions SET transfer_fork = 1 WHERE id = ?1", [id])?;
        Ok(())
    }

    pub fn clear_session_transferred(&self, id: u32) -> Result<()> {
        let conn = self.conn.lock().expect("db lock");
        conn.execute(
            "UPDATE sessions SET transferred_at_ms = NULL WHERE id = ?1",
            [id],
        )?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_export_marks_its_panes_and_reads_back() {
        let dir = tempfile::tempdir().unwrap();
        let db = Db::open(&dir.path().join("t.db")).unwrap();
        let info = crate::db::tests::info(7, proto::SessionState::Exited);
        db.insert_session(&info).unwrap();
        let state = TreeState {
            head: "h".into(),
            paths: [("a".into(), "1".into())].into(),
        };
        db.transfer_record(&TransferRecord {
            id: "t1".into(),
            direction: TransferDirection::Export,
            workspace: "/w".into(),
            created_at_ms: 42,
            checkouts: vec![TransferCheckoutRecord {
                key: "main".into(),
                path: "/w".into(),
                tree_state: Some(state.clone()),
                untracked: vec!["u".into()],
            }],
            sessions: vec![TransferSessionRecord {
                local_session: 7,
                source_session: 7,
                conversation: "c".into(),
                transcript_path: "/t".into(),
                transcript_sha256: "s".into(),
            }],
        })
        .unwrap();
        assert_eq!(db.session_transfer_mark(7).unwrap(), (Some(42), false));
        let export = db.transfer_export("t1").unwrap().unwrap();
        assert_eq!(export.checkouts[0].tree_state.as_ref(), Some(&state));
        assert_eq!(export.sessions[0].conversation, "c");
        assert!(db.transfer_export("t2").unwrap().is_none());
        assert!(db.transfer_conversation_origin("c").unwrap().is_none());
        db.clear_session_transferred(7).unwrap();
        db.set_session_transfer_fork(7).unwrap();
        assert_eq!(db.session_transfer_mark(7).unwrap(), (None, true));
    }
}
