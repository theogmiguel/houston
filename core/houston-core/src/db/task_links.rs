//! A task's links to the external items it mirrors: a Slack request, a GitHub
//! issue. `(provider, external_id)` is unique, so a redelivered or re-polled
//! item resolves to the task it already has instead of filing a second one.
use anyhow::Result;
use rusqlite::{Connection, OptionalExtension};

use super::Db;

pub(super) fn migrate(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS backlog_task_links (
            id          INTEGER PRIMARY KEY,
            task_id     INTEGER NOT NULL,
            provider    TEXT    NOT NULL,
            external_id TEXT    NOT NULL,
            url         TEXT,
            fetched_at  INTEGER,
            body_hash   TEXT,
            remote_rev  TEXT,
            synced_at   INTEGER,
            UNIQUE(provider, external_id)
        );
        CREATE INDEX IF NOT EXISTS idx_backlog_task_links_task
            ON backlog_task_links(task_id);
        CREATE TABLE IF NOT EXISTS backlog_task_link_outbox (
            id         INTEGER PRIMARY KEY,
            task_id    INTEGER NOT NULL,
            provider   TEXT    NOT NULL,
            dedupe_key TEXT    NOT NULL UNIQUE,
            kind       TEXT    NOT NULL,
            payload    TEXT    NOT NULL,
            attempts   INTEGER NOT NULL DEFAULT 0,
            last_error TEXT,
            created_at INTEGER NOT NULL,
            sent_at    INTEGER
        );",
    )?;
    // Requests filed before the links table existed keep their one link.
    conn.execute(
        "INSERT OR IGNORE INTO backlog_task_links (task_id, provider, external_id, url, \
             fetched_at) \
         SELECT task_id, source, external_id, permalink, created_at FROM intake_events \
         WHERE task_id IS NOT NULL",
        [],
    )?;
    Ok(())
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TaskLinkRow {
    pub id: i64,
    pub task_id: i64,
    pub provider: String,
    pub external_id: String,
    pub url: Option<String>,
    pub fetched_at_ms: Option<i64>,
    pub body_hash: Option<String>,
    pub remote_rev: Option<String>,
    pub synced_at_ms: Option<i64>,
}

/// One link as it is written: the snapshot fields are what the importer read.
#[derive(Clone, Copy)]
pub struct TaskLinkWrite<'a> {
    pub task_id: i64,
    pub provider: &'a str,
    pub external_id: &'a str,
    pub url: Option<&'a str>,
    pub fetched_at_ms: Option<i64>,
    pub body_hash: Option<&'a str>,
    pub remote_rev: Option<&'a str>,
}

/// A write Houston owes an external item, sent at least once: a row stays
/// pending until the provider accepts it or `OUTBOX_ATTEMPTS_MAX` is spent.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LinkOutboxRow {
    pub id: i64,
    pub task_id: i64,
    pub dedupe_key: String,
    pub kind: String,
    pub payload: String,
    pub attempts: u32,
}

/// Five tries cover a flaky network or a `gh` re-login; past that the row
/// keeps its last error and stops costing calls.
pub const OUTBOX_ATTEMPTS_MAX: u32 = 5;

const LINK_COLUMNS: &str =
    "id, task_id, provider, external_id, url, fetched_at, body_hash, remote_rev, synced_at";

fn link_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<TaskLinkRow> {
    Ok(TaskLinkRow {
        id: r.get(0)?,
        task_id: r.get(1)?,
        provider: r.get(2)?,
        external_id: r.get(3)?,
        url: r.get(4)?,
        fetched_at_ms: r.get(5)?,
        body_hash: r.get(6)?,
        remote_rev: r.get(7)?,
        synced_at_ms: r.get(8)?,
    })
}

/// Inserts a link unless `(provider, external_id)` already has one; `Ok(false)`
/// names the existing link, which is left as it is.
pub(super) fn insert_link(conn: &Connection, w: &TaskLinkWrite<'_>) -> Result<bool> {
    let changed = conn.execute(
        "INSERT OR IGNORE INTO backlog_task_links (task_id, provider, external_id, url, \
             fetched_at, body_hash, remote_rev) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        rusqlite::params![
            w.task_id,
            w.provider,
            w.external_id,
            w.url,
            w.fetched_at_ms,
            w.body_hash,
            w.remote_rev
        ],
    )?;
    Ok(changed > 0)
}

impl Db {
    /// The task's links, oldest first.
    pub fn task_links(&self, task_id: i64) -> Result<Vec<TaskLinkRow>> {
        let conn = self.conn.lock().expect("db lock");
        let mut stmt = conn.prepare(&format!(
            "SELECT {LINK_COLUMNS} FROM backlog_task_links WHERE task_id = ?1 ORDER BY id"
        ))?;
        let rows = stmt
            .query_map([task_id], link_row)?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    /// Every link of one provider, oldest first: a connector's write-back walks them.
    pub fn task_links_of(&self, provider: &str) -> Result<Vec<TaskLinkRow>> {
        let conn = self.conn.lock().expect("db lock");
        let mut stmt = conn.prepare(&format!(
            "SELECT {LINK_COLUMNS} FROM backlog_task_links WHERE provider = ?1 ORDER BY id"
        ))?;
        let rows = stmt
            .query_map([provider], link_row)?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    pub fn task_link_by_external(
        &self,
        provider: &str,
        external_id: &str,
    ) -> Result<Option<TaskLinkRow>> {
        let conn = self.conn.lock().expect("db lock");
        Ok(conn
            .query_row(
                &format!(
                    "SELECT {LINK_COLUMNS} FROM backlog_task_links \
                     WHERE provider = ?1 AND external_id = ?2"
                ),
                rusqlite::params![provider, external_id],
                link_row,
            )
            .optional()?)
    }

    pub fn task_link_insert(&self, w: &TaskLinkWrite<'_>) -> Result<bool> {
        let conn = self.conn.lock().expect("db lock");
        insert_link(&conn, w)
    }

    /// Records a fresh read of the external item without touching the task:
    /// the task's own text is the user's once filed.
    pub fn task_link_refreshed(
        &self,
        id: i64,
        fetched_at_ms: i64,
        body_hash: &str,
        remote_rev: Option<&str>,
    ) -> Result<()> {
        let conn = self.conn.lock().expect("db lock");
        conn.execute(
            "UPDATE backlog_task_links SET fetched_at = ?2, body_hash = ?3, remote_rev = ?4 \
             WHERE id = ?1",
            rusqlite::params![id, fetched_at_ms, body_hash, remote_rev],
        )?;
        Ok(())
    }

    /// Queues one write; `Ok(false)` when `dedupe_key` was queued before, so a
    /// state that keeps deriving the same write queues it once.
    pub fn link_outbox_push(
        &self,
        task_id: i64,
        provider: &str,
        dedupe_key: &str,
        kind: &str,
        payload: &str,
        now_ms: i64,
    ) -> Result<bool> {
        let conn = self.conn.lock().expect("db lock");
        let changed = conn.execute(
            "INSERT OR IGNORE INTO backlog_task_link_outbox \
                 (task_id, provider, dedupe_key, kind, payload, created_at) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            rusqlite::params![task_id, provider, dedupe_key, kind, payload, now_ms],
        )?;
        Ok(changed > 0)
    }

    /// The provider's unsent writes with tries left, oldest first.
    pub fn link_outbox_pending(&self, provider: &str) -> Result<Vec<LinkOutboxRow>> {
        let conn = self.conn.lock().expect("db lock");
        let mut stmt = conn.prepare(
            "SELECT id, task_id, dedupe_key, kind, payload, attempts \
             FROM backlog_task_link_outbox \
             WHERE provider = ?1 AND sent_at IS NULL AND attempts < ?2 ORDER BY id",
        )?;
        let rows = stmt
            .query_map(rusqlite::params![provider, OUTBOX_ATTEMPTS_MAX], |r| {
                Ok(LinkOutboxRow {
                    id: r.get(0)?,
                    task_id: r.get(1)?,
                    dedupe_key: r.get(2)?,
                    kind: r.get(3)?,
                    payload: r.get(4)?,
                    attempts: r.get(5)?,
                })
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    pub fn link_outbox_sent(&self, id: i64, now_ms: i64) -> Result<()> {
        let conn = self.conn.lock().expect("db lock");
        conn.execute(
            "UPDATE backlog_task_link_outbox SET sent_at = ?2, last_error = NULL WHERE id = ?1",
            rusqlite::params![id, now_ms],
        )?;
        Ok(())
    }

    pub fn link_outbox_failed(&self, id: i64, error: &str) -> Result<()> {
        let conn = self.conn.lock().expect("db lock");
        conn.execute(
            "UPDATE backlog_task_link_outbox SET attempts = attempts + 1, last_error = ?2 \
             WHERE id = ?1",
            rusqlite::params![id, error],
        )?;
        Ok(())
    }

    /// Stamps the last write Houston made to the external item.
    pub fn task_link_synced(&self, id: i64, synced_at_ms: i64) -> Result<()> {
        let conn = self.conn.lock().expect("db lock");
        conn.execute(
            "UPDATE backlog_task_links SET synced_at = ?2 WHERE id = ?1",
            rusqlite::params![id, synced_at_ms],
        )?;
        Ok(())
    }
}
