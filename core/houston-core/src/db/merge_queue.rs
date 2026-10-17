use super::*;
use crate::merge_queue::{Facts, QueueRow};
use rusqlite::params;

/// Queue merges older than a week leave the history; the page shows one day.
const MERGE_HISTORY_RETENTION_MS: i64 = 7 * 24 * 60 * 60 * 1000;

pub(crate) fn init(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS merge_queue_entries (
            workspace TEXT NOT NULL,
            number INTEGER NOT NULL,
            repository TEXT NOT NULL,
            url TEXT NOT NULL,
            title TEXT,
            head_ref TEXT NOT NULL,
            head_sha TEXT NOT NULL,
            base_ref TEXT,
            depends_on INTEGER,
            session_id INTEGER,
            position INTEGER NOT NULL,
            enqueued_at INTEGER NOT NULL,
            facts_json TEXT,
            PRIMARY KEY (workspace, number)
        );
        CREATE TABLE IF NOT EXISTS merge_queue_merges (
            id INTEGER PRIMARY KEY,
            workspace TEXT NOT NULL,
            number INTEGER NOT NULL,
            repository TEXT NOT NULL,
            url TEXT NOT NULL,
            title TEXT,
            head_sha TEXT NOT NULL,
            base_ref TEXT,
            method TEXT NOT NULL,
            merged_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS merge_queue_merges_workspace
            ON merge_queue_merges(workspace, merged_at);",
    )?;
    Ok(())
}

const SELECT: &str = "SELECT workspace, number, repository, url, title, head_ref, head_sha,
    base_ref, depends_on, session_id, position, enqueued_at, facts_json FROM merge_queue_entries";

fn map_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<(QueueRow, Option<String>)> {
    Ok((
        QueueRow {
            workspace: row.get(0)?,
            number: row.get(1)?,
            repository: row.get(2)?,
            url: row.get(3)?,
            title: row.get(4)?,
            head_ref: row.get(5)?,
            head_sha: row.get(6)?,
            base_ref: row.get(7)?,
            depends_on: row.get(8)?,
            session_id: row.get(9)?,
            position: row.get(10)?,
            enqueued_at_ms: row.get(11)?,
            facts: None,
        },
        row.get(12)?,
    ))
}

fn entries_in(conn: &Connection, workspace: &str) -> Result<Vec<QueueRow>> {
    let mut stmt = conn.prepare(&format!("{SELECT} WHERE workspace = ?1 ORDER BY position"))?;
    let rows = stmt
        .query_map([workspace], map_row)?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    rows.into_iter()
        .map(|(mut row, facts)| {
            row.facts = facts
                .map(|json| serde_json::from_str::<Facts>(&json))
                .transpose()
                .with_context(|| {
                    format!(
                        "merge queue entry #{} of {workspace} has unreadable facts_json",
                        row.number
                    )
                })?;
            Ok(row)
        })
        .collect()
}

impl Db {
    /// The workspace's entries in enqueue order (not yet queue order; see
    /// `merge_queue::order`).
    pub fn merge_queue_entries(&self, workspace: &str) -> Result<Vec<QueueRow>> {
        let conn = self.conn.lock().expect("db lock");
        entries_in(&conn, workspace)
    }

    pub fn merge_queue_workspaces(&self) -> Result<Vec<String>> {
        let conn = self.conn.lock().expect("db lock");
        let mut stmt =
            conn.prepare("SELECT DISTINCT workspace FROM merge_queue_entries ORDER BY workspace")?;
        let rows = stmt
            .query_map([], |r| r.get(0))?
            .collect::<std::result::Result<Vec<String>, _>>()?;
        Ok(rows)
    }

    /// Inserts `row` at the tail, or updates an entry already queued in place.
    /// `check` sees the current entries under the same lock, so two enqueues
    /// cannot both pass the bound or form a cycle between them.
    pub fn merge_queue_enqueue(
        &self,
        row: &QueueRow,
        check: impl FnOnce(&[QueueRow]) -> Result<()>,
    ) -> Result<()> {
        let mut conn = self.conn.lock().expect("db lock");
        let tx = conn.transaction()?;
        check(&entries_in(&tx, &row.workspace)?)?;
        let facts = row.facts.as_ref().map(serde_json::to_string).transpose()?;
        tx.execute(
            "INSERT INTO merge_queue_entries (workspace, number, repository, url, title,
                 head_ref, head_sha, base_ref, depends_on, session_id, position, enqueued_at,
                 facts_json)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10,
                 (SELECT COALESCE(MAX(position), 0) + 1 FROM merge_queue_entries
                  WHERE workspace = ?1), ?11, ?12)
             ON CONFLICT(workspace, number) DO UPDATE SET
                 repository = excluded.repository, url = excluded.url, title = excluded.title,
                 head_ref = excluded.head_ref, head_sha = excluded.head_sha,
                 base_ref = excluded.base_ref, depends_on = excluded.depends_on,
                 facts_json = excluded.facts_json",
            params![
                row.workspace,
                row.number,
                row.repository,
                row.url,
                row.title,
                row.head_ref,
                row.head_sha,
                row.base_ref,
                row.depends_on,
                row.session_id,
                row.enqueued_at_ms,
                facts,
            ],
        )?;
        tx.commit()?;
        Ok(())
    }

    /// Records what the latest GitHub read said about a queued pull request.
    pub fn merge_queue_set_read(&self, row: &QueueRow) -> Result<bool> {
        let facts = row.facts.as_ref().map(serde_json::to_string).transpose()?;
        Ok(self.conn.lock().expect("db lock").execute(
            "UPDATE merge_queue_entries SET title = ?3, head_ref = ?4, head_sha = ?5,
                 base_ref = ?6, facts_json = ?7
             WHERE workspace = ?1 AND number = ?2",
            params![
                row.workspace,
                row.number,
                row.title,
                row.head_ref,
                row.head_sha,
                row.base_ref,
                facts
            ],
        )? > 0)
    }

    pub fn merge_queue_remove(&self, workspace: &str, number: u32) -> Result<bool> {
        Ok(self.conn.lock().expect("db lock").execute(
            "DELETE FROM merge_queue_entries WHERE workspace = ?1 AND number = ?2",
            params![workspace, number],
        )? > 0)
    }

    /// A merged dependency is satisfied: its dependents stop waiting on it.
    pub fn merge_queue_clear_dependency(&self, workspace: &str, number: u32) -> Result<()> {
        self.conn.lock().expect("db lock").execute(
            "UPDATE merge_queue_entries SET depends_on = NULL
             WHERE workspace = ?1 AND depends_on = ?2",
            params![workspace, number],
        )?;
        Ok(())
    }

    pub fn merge_queue_record_merge(
        &self,
        workspace: &str,
        merge: &proto::MergeQueueMerge,
    ) -> Result<()> {
        let method = wire_name(&merge.method)?;
        let conn = self.conn.lock().expect("db lock");
        conn.execute(
            "INSERT INTO merge_queue_merges (workspace, number, repository, url, title,
                 head_sha, base_ref, method, merged_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![
                workspace,
                merge.number,
                merge.repository,
                merge.url,
                merge.title,
                merge.head_sha,
                merge.base_ref,
                method,
                merge.merged_at_ms,
            ],
        )?;
        conn.execute(
            "DELETE FROM merge_queue_merges WHERE merged_at < ?1",
            [merge.merged_at_ms - MERGE_HISTORY_RETENTION_MS],
        )?;
        Ok(())
    }

    /// Queue merges since `since_ms`, newest first, at most `limit`.
    pub fn merge_queue_merges(
        &self,
        workspace: &str,
        since_ms: i64,
        limit: u32,
    ) -> Result<Vec<proto::MergeQueueMerge>> {
        let conn = self.conn.lock().expect("db lock");
        let mut stmt = conn.prepare(
            "SELECT number, repository, url, title, head_sha, base_ref, method, merged_at
             FROM merge_queue_merges WHERE workspace = ?1 AND merged_at >= ?2
             ORDER BY merged_at DESC, id DESC LIMIT ?3",
        )?;
        let rows = stmt
            .query_map(params![workspace, since_ms, limit], |r| {
                Ok((
                    r.get::<_, u32>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, Option<String>>(3)?,
                    r.get::<_, String>(4)?,
                    r.get::<_, Option<String>>(5)?,
                    r.get::<_, String>(6)?,
                    r.get::<_, i64>(7)?,
                ))
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        rows.into_iter()
            .map(
                |(number, repository, url, title, head_sha, base_ref, method, merged_at_ms)| {
                    Ok(proto::MergeQueueMerge {
                        number,
                        repository,
                        url,
                        title,
                        head_sha,
                        base_ref,
                        method: from_wire(&method).ok_or_else(|| {
                            anyhow::anyhow!(
                                "merge queue history row #{number} has merge method {method:?}; expected merge, squash or rebase"
                            )
                        })?,
                        merged_at_ms,
                    })
                },
            )
            .collect()
    }

    /// The task Slice in `workspace` whose newest implementation run is on
    /// `branch` or handed back `url`, and the state of its newest review run.
    /// `None` means the pull request is not a task Slice's.
    pub fn merge_queue_slice_review(
        &self,
        workspace: &str,
        branch: &str,
        url: &str,
    ) -> Result<Option<(String, Option<proto::TaskRunState>)>> {
        let conn = self.conn.lock().expect("db lock");
        let task: Option<(i64, u32)> = conn
            .query_row(
                "SELECT t.id, t.number FROM backlog_task_runs r
                 JOIN backlog_tasks t ON t.id = r.task_id
                 JOIN backlog_task_domain d ON d.task_id = t.id AND d.kind = 'slice'
                 WHERE t.workspace = ?1 AND r.kind = 'implementation'
                   AND (r.branch = ?2 OR r.pr_url = ?3)
                 ORDER BY r.id DESC LIMIT 1",
                params![workspace, branch, url],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;
        let Some((task_id, number)) = task else {
            return Ok(None);
        };
        let state: Option<String> = conn
            .query_row(
                "SELECT state FROM backlog_task_runs WHERE task_id = ?1 AND kind = 'review'
                 ORDER BY id DESC LIMIT 1",
                [task_id],
                |r| r.get(0),
            )
            .optional()?;
        let state = state
            .map(|raw| {
                from_wire::<proto::TaskRunState>(&raw).ok_or_else(|| {
                    anyhow::anyhow!("task run state {raw:?} is not a known TaskRunState")
                })
            })
            .transpose()?;
        Ok(Some((crate::daemon::Daemon::task_key(number), state)))
    }
}
