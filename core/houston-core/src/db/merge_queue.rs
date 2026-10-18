use super::*;
use crate::merge_queue::QueueRow;
use rusqlite::params;

/// The merge log keeps a month: long enough to find what a revert needs, and
/// one verification at a time bounds it to a few hundred rows a day.
const MERGE_LOG_RETENTION_MS: i64 = 30 * 24 * 60 * 60 * 1000;
/// The settings key of the daemon-wide pause, beside each workspace's own.
const GLOBAL_PAUSE_KEY: &str = "merge_queue_paused";
/// The log's columns after its kinds widened for restacks, retargets and hand-offs.
const LOG_TABLE: &str = "CREATE TABLE IF NOT EXISTS merge_queue_log (
            id INTEGER PRIMARY KEY,
            workspace TEXT NOT NULL,
            kind TEXT NOT NULL CHECK (kind IN
                ('push', 'merge', 'park', 'restack', 'retarget', 'hand_off')),
            number INTEGER NOT NULL,
            repository TEXT NOT NULL,
            url TEXT NOT NULL,
            title TEXT,
            ref_name TEXT,
            old_sha TEXT,
            new_sha TEXT,
            head_sha TEXT,
            method TEXT,
            detail TEXT,
            unattended INTEGER NOT NULL DEFAULT 0,
            at INTEGER NOT NULL,
            fork_sha TEXT
        );
        CREATE INDEX IF NOT EXISTS merge_queue_log_workspace
            ON merge_queue_log(workspace, at);";

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
        CREATE TABLE IF NOT EXISTS merge_queue_settings (
            workspace TEXT PRIMARY KEY,
            merge_when_verified INTEGER NOT NULL DEFAULT 0,
            verification_command TEXT NOT NULL DEFAULT '',
            time_limit_minutes INTEGER NOT NULL,
            paused INTEGER NOT NULL DEFAULT 0,
            acknowledged_at INTEGER NOT NULL DEFAULT 0
        );",
    )?;
    widen_log_kinds(conn)?;
    conn.execute_batch(LOG_TABLE)?;
    add_column_if_missing(
        conn,
        "merge_queue_entries",
        "verification_json",
        "verification_json TEXT",
    )?;
    add_column_if_missing(
        conn,
        "merge_queue_entries",
        "failure_json",
        "failure_json TEXT",
    )?;
    add_column_if_missing(
        conn,
        "merge_queue_entries",
        "stacked_json",
        "stacked_json TEXT",
    )?;
    add_column_if_missing(
        conn,
        "merge_queue_entries",
        "github_json",
        "github_json TEXT",
    )?;
    add_column_if_missing(
        conn,
        "merge_queue_settings",
        "hand_off_json",
        "hand_off_json TEXT",
    )?;
    migrate_merge_history(conn)
}

/// The log's `kind` check once allowed only pushes, merges and parks. SQLite
/// cannot alter a check, so that table is copied into the wider one.
fn widen_log_kinds(conn: &Connection) -> Result<()> {
    let sql: Option<String> = conn
        .query_row(
            "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'merge_queue_log'",
            [],
            |r| r.get(0),
        )
        .optional()?;
    if sql.is_none_or(|sql| sql.contains("'restack'")) {
        return Ok(());
    }
    conn.execute_batch(&format!(
        "BEGIN;
        DROP INDEX IF EXISTS merge_queue_log_workspace;
        ALTER TABLE merge_queue_log RENAME TO merge_queue_log_narrow;
        {LOG_TABLE}
        INSERT INTO merge_queue_log (id, workspace, kind, number, repository, url, title,
            ref_name, old_sha, new_sha, head_sha, method, detail, unattended, at)
        SELECT id, workspace, kind, number, repository, url, title, ref_name, old_sha,
            new_sha, head_sha, method, detail, unattended, at
        FROM merge_queue_log_narrow;
        DROP TABLE merge_queue_log_narrow;
        COMMIT;"
    ))
    .context("widening merge_queue_log's kinds")?;
    Ok(())
}

/// The first merge queue kept only its merges, in `merge_queue_merges`; the
/// log keeps them as merge rows beside pushes and parks.
fn migrate_merge_history(conn: &Connection) -> Result<()> {
    let present: bool = conn.query_row(
        "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'merge_queue_merges'",
        [],
        |r| r.get::<_, i64>(0).map(|c| c > 0),
    )?;
    if !present {
        return Ok(());
    }
    conn.execute_batch(
        "BEGIN;
        INSERT INTO merge_queue_log (workspace, kind, number, repository, url, title,
            ref_name, head_sha, method, unattended, at)
        SELECT workspace, 'merge', number, repository, url, title, base_ref, head_sha,
            method, 0, merged_at
        FROM merge_queue_merges ORDER BY merged_at, id;
        DROP INDEX IF EXISTS merge_queue_merges_workspace;
        DROP TABLE merge_queue_merges;
        COMMIT;",
    )
    .context("moving merge_queue_merges into merge_queue_log")?;
    Ok(())
}

const SELECT: &str = "SELECT workspace, number, repository, url, title, head_ref, head_sha,
    base_ref, depends_on, session_id, position, enqueued_at, facts_json, verification_json,
    failure_json, stacked_json, github_json FROM merge_queue_entries";

type Raw = (QueueRow, [Option<String>; 5]);

fn map_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Raw> {
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
            verification: None,
            failure: None,
            stacked: None,
            github: None,
        },
        [
            row.get(12)?,
            row.get(13)?,
            row.get(14)?,
            row.get(15)?,
            row.get(16)?,
        ],
    ))
}

fn json_column<T: serde::de::DeserializeOwned>(
    json: Option<String>,
    row: &QueueRow,
    column: &str,
) -> Result<Option<T>> {
    json.map(|json| serde_json::from_str::<T>(&json))
        .transpose()
        .with_context(|| {
            format!(
                "merge queue entry #{} of {} has unreadable {column}",
                row.number, row.workspace
            )
        })
}

fn decode((mut row, [facts, verification, failure, stacked, github]): Raw) -> Result<QueueRow> {
    row.facts = json_column(facts, &row, "facts_json")?;
    row.verification = json_column(verification, &row, "verification_json")?;
    row.failure = json_column(failure, &row, "failure_json")?;
    row.stacked = json_column(stacked, &row, "stacked_json")?;
    row.github = json_column(github, &row, "github_json")?;
    Ok(row)
}

fn entries_in(conn: &Connection, workspace: &str) -> Result<Vec<QueueRow>> {
    let mut stmt = conn.prepare(&format!("{SELECT} WHERE workspace = ?1 ORDER BY position"))?;
    let rows = stmt
        .query_map([workspace], map_row)?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    rows.into_iter().map(decode).collect()
}

fn to_json<T: serde::Serialize>(value: Option<&T>) -> Result<Option<String>> {
    Ok(value.map(serde_json::to_string).transpose()?)
}

impl Db {
    /// The workspace's entries in enqueue order (not yet queue order; see
    /// `merge_queue::order`).
    pub fn merge_queue_entries(&self, workspace: &str) -> Result<Vec<QueueRow>> {
        let conn = self.conn.lock().expect("db lock");
        entries_in(&conn, workspace)
    }

    /// Every entry of every workspace, for the rail's parked counts.
    pub fn merge_queue_all_entries(&self) -> Result<Vec<QueueRow>> {
        let conn = self.conn.lock().expect("db lock");
        let mut stmt = conn.prepare(&format!("{SELECT} ORDER BY workspace, position"))?;
        let rows = stmt
            .query_map([], map_row)?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        rows.into_iter().map(decode).collect()
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
        let facts = to_json(row.facts.as_ref())?;
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
        let facts = to_json(row.facts.as_ref())?;
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

    /// Records a passed verification, or clears it with `None`.
    pub fn merge_queue_set_verification(
        &self,
        workspace: &str,
        number: u32,
        verification: Option<&proto::MergeQueueVerification>,
    ) -> Result<bool> {
        let json = to_json(verification)?;
        Ok(self.conn.lock().expect("db lock").execute(
            "UPDATE merge_queue_entries SET verification_json = ?3
             WHERE workspace = ?1 AND number = ?2",
            params![workspace, number, json],
        )? > 0)
    }

    /// Records why an entry left the line, or puts it back with `None`.
    pub fn merge_queue_set_failure(
        &self,
        workspace: &str,
        number: u32,
        failure: Option<&proto::MergeQueueFailure>,
    ) -> Result<bool> {
        let json = to_json(failure)?;
        Ok(self.conn.lock().expect("db lock").execute(
            "UPDATE merge_queue_entries SET failure_json = ?3
             WHERE workspace = ?1 AND number = ?2",
            params![workspace, number, json],
        )? > 0)
    }

    pub fn merge_queue_remove(&self, workspace: &str, number: u32) -> Result<bool> {
        Ok(self.conn.lock().expect("db lock").execute(
            "DELETE FROM merge_queue_entries WHERE workspace = ?1 AND number = ?2",
            params![workspace, number],
        )? > 0)
    }

    /// A merged dependency is satisfied: its dependents stop waiting on it and
    /// keep `stacked`, what it was, for their restack. A native stack's layers
    /// get `None`: GitHub restacks those itself.
    pub fn merge_queue_clear_dependency(
        &self,
        workspace: &str,
        number: u32,
        stacked: Option<&crate::merge_queue::Stacked>,
    ) -> Result<()> {
        let json = to_json(stacked)?;
        self.conn.lock().expect("db lock").execute(
            "UPDATE merge_queue_entries SET depends_on = NULL, stacked_json = ?3
             WHERE workspace = ?1 AND depends_on = ?2",
            params![workspace, number, json],
        )?;
        Ok(())
    }

    /// Records what was handed to GitHub, or clears it with `None`.
    pub fn merge_queue_set_github(
        &self,
        workspace: &str,
        number: u32,
        hold: Option<&proto::MergeQueueGitHubHold>,
    ) -> Result<bool> {
        let json = to_json(hold)?;
        Ok(self.conn.lock().expect("db lock").execute(
            "UPDATE merge_queue_entries SET github_json = ?3
             WHERE workspace = ?1 AND number = ?2",
            params![workspace, number, json],
        )? > 0)
    }

    /// The hand-off path the workspace's reads last reported.
    pub fn merge_queue_hand_off(
        &self,
        workspace: &str,
    ) -> Result<Option<proto::MergeQueueHandOffInfo>> {
        let json: Option<String> = self
            .conn
            .lock()
            .expect("db lock")
            .query_row(
                "SELECT hand_off_json FROM merge_queue_settings WHERE workspace = ?1",
                [workspace],
                |r| r.get(0),
            )
            .optional()?
            .flatten();
        json.map(|j| {
            serde_json::from_str(&j).with_context(|| {
                format!("the cached merge queue hand-off of {workspace} is unreadable: {j:?}")
            })
        })
        .transpose()
    }

    pub fn merge_queue_set_hand_off(
        &self,
        workspace: &str,
        info: &proto::MergeQueueHandOffInfo,
    ) -> Result<()> {
        self.conn.lock().expect("db lock").execute(
            "INSERT INTO merge_queue_settings (workspace, time_limit_minutes, hand_off_json)
             VALUES (?1, ?2, ?3)
             ON CONFLICT(workspace) DO UPDATE SET hand_off_json = excluded.hand_off_json",
            params![
                workspace,
                proto::MERGE_QUEUE_TIME_LIMIT_DEFAULT_MINUTES,
                serde_json::to_string(info)?
            ],
        )?;
        Ok(())
    }

    /// The workspace's settings; a workspace never set is off with no command.
    pub fn merge_queue_settings(&self, workspace: &str) -> Result<proto::MergeQueueSettings> {
        let conn = self.conn.lock().expect("db lock");
        let row = conn
            .query_row(
                "SELECT merge_when_verified, verification_command, time_limit_minutes, paused
                 FROM merge_queue_settings WHERE workspace = ?1",
                [workspace],
                |r| {
                    Ok(proto::MergeQueueSettings {
                        merge_when_verified: r.get(0)?,
                        verification_command: r.get(1)?,
                        time_limit_minutes: r.get(2)?,
                        paused: r.get(3)?,
                    })
                },
            )
            .optional()?;
        Ok(row.unwrap_or(proto::MergeQueueSettings {
            merge_when_verified: false,
            verification_command: String::new(),
            time_limit_minutes: proto::MERGE_QUEUE_TIME_LIMIT_DEFAULT_MINUTES,
            paused: false,
        }))
    }

    /// Stores the policy, command and limit; the pause is kept as it is.
    pub fn merge_queue_settings_set(
        &self,
        workspace: &str,
        settings: &proto::MergeQueueSettings,
    ) -> Result<()> {
        self.conn.lock().expect("db lock").execute(
            "INSERT INTO merge_queue_settings
                 (workspace, merge_when_verified, verification_command, time_limit_minutes)
             VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(workspace) DO UPDATE SET
                 merge_when_verified = excluded.merge_when_verified,
                 verification_command = excluded.verification_command,
                 time_limit_minutes = excluded.time_limit_minutes",
            params![
                workspace,
                settings.merge_when_verified,
                settings.verification_command,
                settings.time_limit_minutes
            ],
        )?;
        Ok(())
    }

    pub fn merge_queue_set_paused(&self, workspace: &str, paused: bool) -> Result<()> {
        self.conn.lock().expect("db lock").execute(
            "INSERT INTO merge_queue_settings (workspace, time_limit_minutes, paused)
             VALUES (?1, ?2, ?3)
             ON CONFLICT(workspace) DO UPDATE SET paused = excluded.paused",
            params![
                workspace,
                proto::MERGE_QUEUE_TIME_LIMIT_DEFAULT_MINUTES,
                paused
            ],
        )?;
        Ok(())
    }

    pub fn merge_queue_global_paused(&self) -> Result<bool> {
        Ok(self.get_setting(GLOBAL_PAUSE_KEY)?.as_deref() == Some("1"))
    }

    pub fn merge_queue_set_global_paused(&self, paused: bool) -> Result<()> {
        self.set_setting(GLOBAL_PAUSE_KEY, if paused { "1" } else { "0" })
    }

    /// The user has seen the workspace's unattended merges and parks up to `at_ms`.
    pub fn merge_queue_acknowledge(&self, workspace: &str, at_ms: i64) -> Result<()> {
        self.conn.lock().expect("db lock").execute(
            "INSERT INTO merge_queue_settings (workspace, time_limit_minutes, acknowledged_at)
             VALUES (?1, ?2, ?3)
             ON CONFLICT(workspace) DO UPDATE SET acknowledged_at = excluded.acknowledged_at",
            params![
                workspace,
                proto::MERGE_QUEUE_TIME_LIMIT_DEFAULT_MINUTES,
                at_ms
            ],
        )?;
        Ok(())
    }

    /// Unattended merges and parks since the user last acknowledged them.
    pub fn merge_queue_away(&self, workspace: &str) -> Result<proto::MergeQueueAway> {
        let conn = self.conn.lock().expect("db lock");
        let since: i64 = conn
            .query_row(
                "SELECT acknowledged_at FROM merge_queue_settings WHERE workspace = ?1",
                [workspace],
                |r| r.get(0),
            )
            .optional()?
            .unwrap_or(0);
        Ok(conn.query_row(
            "SELECT
                 COALESCE(SUM(kind = 'merge'), 0),
                 COALESCE(SUM(kind = 'park'), 0),
                 MAX(CASE WHEN kind = 'merge' THEN at END)
             FROM merge_queue_log
             WHERE workspace = ?1 AND unattended = 1 AND at > ?2",
            params![workspace, since],
            |r| {
                Ok(proto::MergeQueueAway {
                    merged: r.get(0)?,
                    parked: r.get(1)?,
                    last_merge_at_ms: r.get(2)?,
                })
            },
        )?)
    }

    pub fn merge_queue_log_record(
        &self,
        workspace: &str,
        entry: &proto::MergeQueueLogEntry,
    ) -> Result<()> {
        let kind = wire_name(&entry.kind)?;
        let method = entry.method.as_ref().map(wire_name).transpose()?;
        let conn = self.conn.lock().expect("db lock");
        conn.execute(
            "INSERT INTO merge_queue_log (workspace, kind, number, repository, url, title,
                 ref_name, old_sha, new_sha, head_sha, method, detail, unattended, at, fork_sha)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)",
            params![
                workspace,
                kind,
                entry.number,
                entry.repository,
                entry.url,
                entry.title,
                entry.ref_name,
                entry.old_sha,
                entry.new_sha,
                entry.head_sha,
                method,
                entry.detail,
                entry.unattended,
                entry.at_ms,
                entry.fork_sha,
            ],
        )?;
        conn.execute(
            "DELETE FROM merge_queue_log WHERE at < ?1",
            [entry.at_ms - MERGE_LOG_RETENTION_MS],
        )?;
        Ok(())
    }

    /// Log rows since `since_ms`, newest first, at most `limit`; with `number`,
    /// only that pull request's.
    pub fn merge_queue_log(
        &self,
        workspace: &str,
        since_ms: i64,
        limit: u32,
        number: Option<u32>,
    ) -> Result<Vec<proto::MergeQueueLogEntry>> {
        let conn = self.conn.lock().expect("db lock");
        let mut stmt = conn.prepare(
            "SELECT kind, number, repository, url, title, ref_name, old_sha, new_sha, head_sha,
                 method, detail, unattended, at, fork_sha
             FROM merge_queue_log
             WHERE workspace = ?1 AND at >= ?2 AND (?4 IS NULL OR number = ?4)
             ORDER BY at DESC, id DESC LIMIT ?3",
        )?;
        let rows = stmt
            .query_map(params![workspace, since_ms, limit, number], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, Option<String>>(9)?,
                    proto::MergeQueueLogEntry {
                        kind: proto::MergeQueueLogKind::Merge,
                        number: r.get(1)?,
                        repository: r.get(2)?,
                        url: r.get(3)?,
                        title: r.get(4)?,
                        ref_name: r.get(5)?,
                        old_sha: r.get(6)?,
                        new_sha: r.get(7)?,
                        head_sha: r.get(8)?,
                        method: None,
                        detail: r.get(10)?,
                        unattended: r.get(11)?,
                        at_ms: r.get(12)?,
                        fork_sha: r.get(13)?,
                    },
                ))
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        rows.into_iter()
            .map(|(kind, method, mut entry)| {
                entry.kind = from_wire(&kind).ok_or_else(|| {
                    anyhow::anyhow!(
                        "merge log row for #{} has kind {kind:?}; expected push, merge, park, restack, retarget or hand_off",
                        entry.number
                    )
                })?;
                entry.method = method
                    .map(|m| {
                        from_wire(&m).ok_or_else(|| {
                            anyhow::anyhow!(
                                "merge log row for #{} has merge method {m:?}; expected merge, squash or rebase",
                                entry.number
                            )
                        })
                    })
                    .transpose()?;
                Ok(entry)
            })
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

#[cfg(test)]
mod tests {
    use super::*;

    /// The shape PR 1 of the merge queue left: merges in their own table.
    const PR1_SCHEMA: &str = "CREATE TABLE merge_queue_merges (
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
        CREATE INDEX merge_queue_merges_workspace ON merge_queue_merges(workspace, merged_at);";

    #[test]
    fn merges_recorded_by_the_first_queue_move_into_the_log() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("houston.db");
        {
            let conn = Connection::open(&path).unwrap();
            conn.execute_batch(PR1_SCHEMA).unwrap();
            for (n, at) in [(11, 1_000), (12, 2_000)] {
                conn.execute(
                    "INSERT INTO merge_queue_merges (workspace, number, repository, url, title,
                         head_sha, base_ref, method, merged_at)
                     VALUES ('/work', ?1, 'owner/repo', 'https://github.com/owner/repo/pull/1',
                         'Change', ?2, 'main', 'squash', ?3)",
                    params![n, "a".repeat(40), at],
                )
                .unwrap();
            }
        }
        let db = Db::open(&path).unwrap();
        let log = db.merge_queue_log("/work", 0, 10, None).unwrap();
        assert_eq!(
            log.iter().map(|e| e.number).collect::<Vec<_>>(),
            [12, 11],
            "{log:?}"
        );
        assert!(log.iter().all(|e| e.kind == proto::MergeQueueLogKind::Merge
            && e.method == Some(proto::PrMergeMethod::Squash)
            && e.ref_name.as_deref() == Some("main")
            && e.head_sha.as_deref() == Some(&*"a".repeat(40))
            && !e.unattended));
        let conn = db.conn.lock().unwrap();
        let left: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE name LIKE 'merge_queue_merges%'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(left, 0, "the old table and its index are gone");
        drop(conn);
        drop(db);
        // Opening again finds nothing to move and keeps the rows.
        let db = Db::open(&path).unwrap();
        assert_eq!(db.merge_queue_log("/work", 0, 10, None).unwrap().len(), 2);
    }

    #[test]
    fn a_log_from_before_restacks_keeps_its_rows_and_takes_the_new_kinds() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("houston.db");
        {
            let conn = Connection::open(&path).unwrap();
            conn.execute_batch(
                "CREATE TABLE merge_queue_log (
                    id INTEGER PRIMARY KEY,
                    workspace TEXT NOT NULL,
                    kind TEXT NOT NULL CHECK (kind IN ('push', 'merge', 'park')),
                    number INTEGER NOT NULL,
                    repository TEXT NOT NULL,
                    url TEXT NOT NULL,
                    title TEXT,
                    ref_name TEXT,
                    old_sha TEXT,
                    new_sha TEXT,
                    head_sha TEXT,
                    method TEXT,
                    detail TEXT,
                    unattended INTEGER NOT NULL DEFAULT 0,
                    at INTEGER NOT NULL
                );
                CREATE INDEX merge_queue_log_workspace ON merge_queue_log(workspace, at);
                INSERT INTO merge_queue_log (workspace, kind, number, repository, url,
                    old_sha, new_sha, unattended, at)
                VALUES ('/w', 'push', 4, 'owner/repo', 'u', 'old', 'new', 1, 5);",
            )
            .unwrap();
        }
        let db = Db::open(&path).unwrap();
        let mut restack = db.merge_queue_log("/w", 0, 10, None).unwrap().remove(0);
        assert_eq!(restack.kind, proto::MergeQueueLogKind::Push);
        assert_eq!(restack.old_sha.as_deref(), Some("old"));
        restack.kind = proto::MergeQueueLogKind::Restack;
        restack.fork_sha = Some("fork".into());
        restack.at_ms = 6;
        db.merge_queue_log_record("/w", &restack).unwrap();
        let log = db.merge_queue_log("/w", 0, 10, None).unwrap();
        assert_eq!(log[0].kind, proto::MergeQueueLogKind::Restack);
        assert_eq!(log[0].fork_sha.as_deref(), Some("fork"));
        let conn = db.conn.lock().unwrap();
        let narrow: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE name = 'merge_queue_log_narrow'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(narrow, 0);
    }

    #[test]
    fn away_counts_only_unattended_rows_since_the_acknowledgement() {
        let dir = tempfile::tempdir().unwrap();
        let db = Db::open(&dir.path().join("houston.db")).unwrap();
        let row = |kind, at, unattended| proto::MergeQueueLogEntry {
            kind,
            number: 1,
            repository: "owner/repo".into(),
            url: "u".into(),
            title: None,
            ref_name: None,
            old_sha: None,
            new_sha: None,
            head_sha: None,
            method: None,
            detail: None,
            unattended,
            at_ms: at,
            fork_sha: None,
        };
        db.merge_queue_log_record("/w", &row(proto::MergeQueueLogKind::Merge, 10, true))
            .unwrap();
        db.merge_queue_log_record("/w", &row(proto::MergeQueueLogKind::Push, 11, true))
            .unwrap();
        db.merge_queue_log_record("/w", &row(proto::MergeQueueLogKind::Park, 12, true))
            .unwrap();
        db.merge_queue_log_record("/w", &row(proto::MergeQueueLogKind::Merge, 13, false))
            .unwrap();
        let away = db.merge_queue_away("/w").unwrap();
        assert_eq!(
            (away.merged, away.parked, away.last_merge_at_ms),
            (1, 1, Some(10))
        );
        db.merge_queue_acknowledge("/w", 12).unwrap();
        assert_eq!(
            db.merge_queue_away("/w").unwrap(),
            proto::MergeQueueAway::default()
        );
    }
}
