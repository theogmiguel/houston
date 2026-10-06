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
            ON backlog_task_links(task_id);",
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
pub struct TaskLinkWrite<'a> {
    pub task_id: i64,
    pub provider: &'a str,
    pub external_id: &'a str,
    pub url: Option<&'a str>,
    pub fetched_at_ms: Option<i64>,
    pub body_hash: Option<&'a str>,
    pub remote_rev: Option<&'a str>,
}

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
