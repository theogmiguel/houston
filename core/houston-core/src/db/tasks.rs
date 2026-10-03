//! The global task backlog: tasks, their numbers, acceptance items,
//! comments, history and runs. Tables carry a `backlog_` prefix, so the orphan
//! `tasks` / `task_events` tables a pre-tasks database may hold stay untouched.
use anyhow::{bail, Context, Result};
use houston_protocol as proto;
use rusqlite::{Connection, OptionalExtension};

use super::{from_wire, wire_name, Db};

pub(super) fn migrate(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS backlog_tasks (
            id            INTEGER PRIMARY KEY,
            workspace     TEXT,
            number        INTEGER NOT NULL,
            title         TEXT    NOT NULL,
            description   TEXT    NOT NULL DEFAULT '',
            status        TEXT    NOT NULL,
            priority      INTEGER NOT NULL DEFAULT 0,
            parent_id     INTEGER REFERENCES backlog_tasks(id),
            ref_url       TEXT,
            revision      INTEGER NOT NULL DEFAULT 1,
            created_by    TEXT    NOT NULL,
            created_at    INTEGER NOT NULL,
            updated_at    INTEGER NOT NULL,
            archived_at   INTEGER,
            UNIQUE(number)
        );
        CREATE INDEX IF NOT EXISTS idx_backlog_tasks_workspace_status
            ON backlog_tasks(workspace, status);
        CREATE TABLE IF NOT EXISTS backlog_task_counters (
            workspace   TEXT PRIMARY KEY,
            next_number INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS backlog_task_blocks (
            task_id       INTEGER NOT NULL,
            blocked_by_id INTEGER NOT NULL,
            PRIMARY KEY (task_id, blocked_by_id)
        );
        CREATE TABLE IF NOT EXISTS backlog_task_acceptance (
            id         INTEGER PRIMARY KEY,
            task_id    INTEGER NOT NULL,
            position   INTEGER NOT NULL,
            text       TEXT    NOT NULL,
            checked_at INTEGER,
            checked_by TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_backlog_task_acceptance_task
            ON backlog_task_acceptance(task_id, position);
        CREATE TABLE IF NOT EXISTS backlog_task_comments (
            id         INTEGER PRIMARY KEY,
            task_id    INTEGER NOT NULL,
            body       TEXT    NOT NULL,
            author     TEXT    NOT NULL,
            created_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_backlog_task_comments_task
            ON backlog_task_comments(task_id, id);
        CREATE TABLE IF NOT EXISTS backlog_task_history (
            id         INTEGER PRIMARY KEY,
            task_id    INTEGER NOT NULL,
            actor      TEXT    NOT NULL,
            action     TEXT    NOT NULL,
            changes    TEXT    NOT NULL,
            created_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_backlog_task_history_task
            ON backlog_task_history(task_id, id);
        CREATE TABLE IF NOT EXISTS backlog_task_runs (
            id               INTEGER PRIMARY KEY,
            task_id          INTEGER NOT NULL,
            attempt          INTEGER NOT NULL,
            kind             TEXT    NOT NULL,
            state            TEXT    NOT NULL,
            provider         TEXT    NOT NULL,
            reviewer         TEXT,
            session_id       INTEGER,
            delegation_id    INTEGER,
            worktree_path    TEXT,
            branch           TEXT,
            base_commit      TEXT,
            initial_revision INTEGER NOT NULL,
            summary          TEXT,
            started_at       INTEGER NOT NULL,
            ended_at         INTEGER
        );
        CREATE INDEX IF NOT EXISTS idx_backlog_task_runs_task
            ON backlog_task_runs(task_id, id);
        CREATE INDEX IF NOT EXISTS idx_backlog_task_runs_open
            ON backlog_task_runs(task_id)
            WHERE state IN ('preparing', 'running', 'waiting_for_input', 'validating');
        CREATE INDEX IF NOT EXISTS idx_backlog_task_runs_session
            ON backlog_task_runs(session_id);",
    )?;
    super::add_column_if_missing(conn, "backlog_task_runs", "reason", "reason TEXT")?;
    migrate_global_tasks(conn)?;
    Ok(())
}

fn migrate_global_tasks(conn: &Connection) -> Result<()> {
    let old_shape: bool = conn.query_row(
        "SELECT [notnull] FROM pragma_table_info('backlog_tasks') WHERE name = 'workspace'",
        [],
        |row| row.get(0),
    )?;
    let tx = conn.unchecked_transaction()?;
    tx.execute_batch("PRAGMA defer_foreign_keys = ON")?;
    if old_shape {
        let rows = {
            let mut stmt = tx.prepare("SELECT id, number FROM backlog_tasks ORDER BY id")?;
            let rows = stmt
                .query_map([], |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?)))?
                .collect::<std::result::Result<Vec<_>, _>>()?;
            rows
        };
        let mut maximum: i64 = tx.query_row(
            "SELECT COALESCE(MAX(number), 0) FROM backlog_tasks",
            [],
            |row| row.get(0),
        )?;
        let mut seen = std::collections::HashSet::new();
        tx.execute_batch("CREATE TABLE backlog_tasks_global (
            id INTEGER PRIMARY KEY, workspace TEXT, number INTEGER NOT NULL UNIQUE,
            title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', status TEXT NOT NULL,
            priority INTEGER NOT NULL DEFAULT 0, parent_id INTEGER REFERENCES backlog_tasks_global(id),
            ref_url TEXT, revision INTEGER NOT NULL DEFAULT 1, created_by TEXT NOT NULL,
            created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, archived_at INTEGER
        )")?;
        for (id, old) in rows {
            let number = if seen.insert(old) {
                old
            } else {
                maximum += 1;
                maximum
            };
            tx.execute("INSERT INTO backlog_tasks_global SELECT id, workspace, ?2, title, description, status, priority, parent_id, ref_url, revision, created_by, created_at, updated_at, archived_at FROM backlog_tasks WHERE id = ?1", rusqlite::params![id, number])?;
            if old != number {
                tx.execute("INSERT INTO backlog_task_history (task_id, actor, action, changes, created_at) VALUES (?1, 'houston:renumbered', 'houston:renumbered', ?2, (SELECT updated_at FROM backlog_tasks WHERE id = ?1))", rusqlite::params![id, serde_json::json!({"key": {"old": format!("HOU-{old}"), "new": format!("HOU-{number}")}}).to_string()])?;
            }
        }
        tx.execute_batch("DROP TABLE backlog_tasks; ALTER TABLE backlog_tasks_global RENAME TO backlog_tasks; CREATE INDEX idx_backlog_tasks_workspace_status ON backlog_tasks(workspace, status)")?;
    }
    tx.execute("INSERT INTO backlog_task_counters (workspace, next_number) VALUES ('all', MAX((SELECT COALESCE(MAX(number), 0) + 1 FROM backlog_tasks), (SELECT COALESCE(MAX(next_number), 1) FROM backlog_task_counters))) ON CONFLICT(workspace) DO UPDATE SET next_number = MAX(next_number, excluded.next_number)", [])?;
    tx.execute(
        "DELETE FROM backlog_task_counters WHERE workspace != 'all'",
        [],
    )?;
    tx.commit()?;
    Ok(())
}

/// The run states still in flight; the same set the partial index covers.
pub(crate) const OPEN_RUN_STATES: &str =
    "'preparing', 'running', 'waiting_for_input', 'validating'";

pub struct TaskRow {
    pub id: i64,
    pub workspace: Option<String>,
    pub number: u32,
    pub title: String,
    pub description: String,
    pub status: proto::TaskStatus,
    pub priority: proto::TaskPriority,
    pub parent_id: Option<i64>,
    pub ref_url: Option<String>,
    pub revision: i64,
    pub created_by: String,
    pub created_at_ms: i64,
    pub updated_at_ms: i64,
    pub archived_at_ms: Option<i64>,
}

/// A list row: everything `TaskRow` has but the description, plus the
/// acceptance tally the list shows.
pub struct TaskSummaryRow {
    pub id: i64,
    pub workspace: Option<String>,
    pub number: u32,
    pub title: String,
    pub status: proto::TaskStatus,
    pub priority: proto::TaskPriority,
    pub parent_id: Option<i64>,
    pub ref_url: Option<String>,
    pub revision: i64,
    pub created_by: String,
    pub created_at_ms: i64,
    pub updated_at_ms: i64,
    pub archived_at_ms: Option<i64>,
    pub acceptance_checked: u32,
    pub acceptance_total: u32,
}

pub struct TaskAcceptanceRow {
    pub id: i64,
    pub position: u32,
    pub text: String,
    pub checked_at_ms: Option<i64>,
    pub checked_by: Option<String>,
}

pub struct TaskCommentRow {
    pub id: i64,
    pub body: String,
    pub author: String,
    pub created_at_ms: i64,
}

pub struct TaskHistoryRow {
    pub id: i64,
    pub actor: String,
    pub action: String,
    pub changes: String,
    pub created_at_ms: i64,
}

pub struct TaskRunRow {
    pub id: i64,
    pub task_id: i64,
    pub attempt: u32,
    pub kind: proto::TaskRunKind,
    pub state: proto::TaskRunState,
    pub provider: proto::AgentKind,
    pub reviewer: Option<proto::AgentKind>,
    pub session_id: Option<u32>,
    pub delegation_id: Option<u32>,
    pub worktree_path: Option<String>,
    pub branch: Option<String>,
    pub base_commit: Option<String>,
    pub initial_revision: i64,
    pub summary: Option<String>,
    pub reason: Option<String>,
    pub started_at_ms: i64,
    pub ended_at_ms: Option<i64>,
}

/// The fields a new run is inserted with; `attempt` is allocated as the task's
/// next number inside the insert.
pub struct TaskRunWrite<'a> {
    pub task_id: i64,
    pub kind: proto::TaskRunKind,
    pub state: proto::TaskRunState,
    pub provider: proto::AgentKind,
    pub reviewer: Option<proto::AgentKind>,
    pub session_id: Option<u32>,
    pub delegation_id: Option<u32>,
    pub worktree_path: Option<&'a str>,
    pub branch: Option<&'a str>,
    pub base_commit: Option<&'a str>,
    pub initial_revision: i64,
    pub started_at_ms: i64,
}

/// One session's task binding: the newest run recorded with that session, and
/// the task it belongs to.
pub struct SessionTaskBindingRow {
    pub task: TaskRow,
    pub run: TaskRunRow,
}

/// The fields a new task is inserted with, already validated by the caller.
pub struct TaskWrite<'a> {
    pub workspace: Option<&'a str>,
    pub title: &'a str,
    pub description: &'a str,
    pub status: proto::TaskStatus,
    pub priority: proto::TaskPriority,
    pub parent_id: Option<i64>,
    pub ref_url: Option<&'a str>,
    pub created_by: &'a str,
    pub now_ms: i64,
    pub acceptance: &'a [String],
}

/// The full new state of an updated task; `changes` is the JSON diff recorded
/// in history. `acceptance` of `Some` replaces the whole item list. `action`
/// names the history verb: an edit is `update`, a claim is `claim`.
pub struct TaskUpdate<'a> {
    pub workspace: Option<&'a str>,
    pub id: i64,
    pub expected_revision: i64,
    pub title: &'a str,
    pub description: &'a str,
    pub status: proto::TaskStatus,
    pub priority: proto::TaskPriority,
    pub parent_id: Option<i64>,
    pub ref_url: Option<&'a str>,
    pub acceptance: Option<&'a [String]>,
    pub actor: &'a str,
    pub action: &'a str,
    pub changes: &'a str,
    pub now_ms: i64,
}

/// Filters for an agent-facing task list. `mine` is the actor that either
/// created the task or claimed it and is still working on it; `query` is a
/// case-insensitive substring over title and description.
pub struct TaskQuery<'a> {
    pub status: Option<proto::TaskStatus>,
    pub ready: bool,
    pub mine: Option<&'a str>,
    pub query: Option<&'a str>,
    pub limit: u32,
}

/// `LIKE` with `\` as the escape, so a `%` or `_` in a search box is a literal.
fn like_pattern(q: &str) -> String {
    let mut out = String::with_capacity(q.len() + 2);
    out.push('%');
    for ch in q.chars() {
        if matches!(ch, '%' | '_' | '\\') {
            out.push('\\');
        }
        out.push(ch);
    }
    out.push('%');
    out
}

const TASK_SUMMARY_SELECT: &str = "SELECT t.id, t.workspace, t.number, t.title, t.status, \
    t.priority, t.parent_id, t.ref_url, t.revision, t.created_by, t.created_at, t.updated_at, \
    t.archived_at,
    (SELECT COUNT(*) FROM backlog_task_acceptance a WHERE a.task_id = t.id),
    (SELECT COUNT(*) FROM backlog_task_acceptance a
       WHERE a.task_id = t.id AND a.checked_at IS NOT NULL)
    FROM backlog_tasks t";

/// The SQL fragment every filtered query shares: `?1` is the workspace. A
/// task is ready when it is to-do and no blocker of it is still unfinished.
const READY_CLAUSE: &str = "t.status = 'todo' AND NOT EXISTS (
        SELECT 1 FROM backlog_task_blocks b
        JOIN backlog_tasks dep ON dep.id = b.blocked_by_id
        WHERE b.task_id = t.id AND dep.status NOT IN ('done', 'canceled'))";

const TASK_SELECT: &str = "SELECT id, workspace, number, title, description, status, priority, \
    parent_id, ref_url, revision, created_by, created_at, updated_at, archived_at \
    FROM backlog_tasks";

fn status_of(id: i64, raw: &str) -> rusqlite::Result<proto::TaskStatus> {
    from_wire::<proto::TaskStatus>(raw).ok_or_else(|| {
        rusqlite::Error::FromSqlConversionFailure(
            0,
            rusqlite::types::Type::Text,
            format!(
                "backlog_tasks {id} has unknown status {raw:?} (expected one of backlog, todo, \
                 in_progress, in_review, done, canceled)"
            )
            .into(),
        )
    })
}

fn priority_of(id: i64, value: i64) -> rusqlite::Result<proto::TaskPriority> {
    match value {
        0 => Ok(proto::TaskPriority::None),
        1 => Ok(proto::TaskPriority::Urgent),
        2 => Ok(proto::TaskPriority::High),
        3 => Ok(proto::TaskPriority::Medium),
        4 => Ok(proto::TaskPriority::Low),
        other => Err(rusqlite::Error::FromSqlConversionFailure(
            0,
            rusqlite::types::Type::Integer,
            format!("backlog_tasks {id} has unknown priority {other} (expected 0 none .. 4 low)")
                .into(),
        )),
    }
}

/// The stored integer of a priority: 0 none, 1 urgent .. 4 low.
fn priority_value(p: proto::TaskPriority) -> i64 {
    match p {
        proto::TaskPriority::None => 0,
        proto::TaskPriority::Urgent => 1,
        proto::TaskPriority::High => 2,
        proto::TaskPriority::Medium => 3,
        proto::TaskPriority::Low => 4,
    }
}

/// The columns `map_task_offset` reads, in order.
pub(crate) const TASK_COLUMNS: &str = "id, workspace, number, title, description, status, \
    priority, parent_id, ref_url, revision, created_by, created_at, updated_at, archived_at";
pub(crate) const TASK_COLUMN_COUNT: usize = 14;

/// The columns `map_task_run_offset` reads, in order.
pub(crate) const TASK_RUN_COLUMNS: &str = "id, task_id, attempt, kind, state, provider, reviewer, \
    session_id, delegation_id, worktree_path, branch, base_commit, initial_revision, summary, \
    reason, started_at, ended_at";
pub(crate) const TASK_RUN_COLUMN_COUNT: usize = 17;

const TASK_RUN_SELECT: &str = "SELECT id, task_id, attempt, kind, state, provider, reviewer, \
    session_id, delegation_id, worktree_path, branch, base_commit, initial_revision, summary, \
    reason, started_at, ended_at FROM backlog_task_runs";

/// The column list of a two-table join, qualified per alias.
fn prefixed_columns(columns: &str, alias: &str) -> String {
    columns
        .split(", ")
        .map(|c| format!("{alias}.{}", c.trim()))
        .collect::<Vec<_>>()
        .join(", ")
}

fn map_task(r: &rusqlite::Row) -> rusqlite::Result<TaskRow> {
    map_task_offset(r, 0)
}

fn map_task_offset(r: &rusqlite::Row, base: usize) -> rusqlite::Result<TaskRow> {
    let id: i64 = r.get(base)?;
    let status_raw: String = r.get(base + 5)?;
    Ok(TaskRow {
        id,
        workspace: r.get(base + 1)?,
        number: r.get(base + 2)?,
        title: r.get(base + 3)?,
        description: r.get(base + 4)?,
        status: status_of(id, &status_raw)?,
        priority: priority_of(id, r.get(base + 6)?)?,
        parent_id: r.get(base + 7)?,
        ref_url: r.get(base + 8)?,
        revision: r.get(base + 9)?,
        created_by: r.get(base + 10)?,
        created_at_ms: r.get(base + 11)?,
        updated_at_ms: r.get(base + 12)?,
        archived_at_ms: r.get(base + 13)?,
    })
}

fn map_task_run(r: &rusqlite::Row) -> rusqlite::Result<TaskRunRow> {
    map_task_run_offset(r, 0)
}

fn map_task_run_offset(r: &rusqlite::Row, base: usize) -> rusqlite::Result<TaskRunRow> {
    let id: i64 = r.get(base)?;
    let kind_raw: String = r.get(base + 3)?;
    let state_raw: String = r.get(base + 4)?;
    let provider_raw: String = r.get(base + 5)?;
    let provider = from_wire::<proto::AgentKind>(&provider_raw).ok_or_else(|| {
        rusqlite::Error::FromSqlConversionFailure(
            0,
            rusqlite::types::Type::Text,
            format!(
                "backlog_task_runs {id} has unknown provider {provider_raw:?} (expected an \
                 AgentKind)"
            )
            .into(),
        )
    })?;
    let reviewer = match r.get::<_, Option<String>>(base + 6)? {
        Some(raw) => Some(from_wire::<proto::AgentKind>(&raw).ok_or_else(|| {
            rusqlite::Error::FromSqlConversionFailure(
                0,
                rusqlite::types::Type::Text,
                format!(
                    "backlog_task_runs {id} has unknown reviewer {raw:?} (expected an AgentKind)"
                )
                .into(),
            )
        })?),
        None => None,
    };
    Ok(TaskRunRow {
        id,
        task_id: r.get(base + 1)?,
        attempt: r.get(base + 2)?,
        kind: task_run_kind_of(id, &kind_raw)?,
        state: task_run_state_of(id, &state_raw)?,
        provider,
        reviewer,
        session_id: r.get(base + 7)?,
        delegation_id: r.get(base + 8)?,
        worktree_path: r.get(base + 9)?,
        branch: r.get(base + 10)?,
        base_commit: r.get(base + 11)?,
        initial_revision: r.get(base + 12)?,
        summary: r.get(base + 13)?,
        reason: r.get(base + 14)?,
        started_at_ms: r.get(base + 15)?,
        ended_at_ms: r.get(base + 16)?,
    })
}

fn map_summary(r: &rusqlite::Row) -> rusqlite::Result<TaskSummaryRow> {
    let id: i64 = r.get(0)?;
    let status_raw: String = r.get(4)?;
    Ok(TaskSummaryRow {
        id,
        workspace: r.get(1)?,
        number: r.get(2)?,
        title: r.get(3)?,
        status: status_of(id, &status_raw)?,
        priority: priority_of(id, r.get(5)?)?,
        parent_id: r.get(6)?,
        ref_url: r.get(7)?,
        revision: r.get(8)?,
        created_by: r.get(9)?,
        created_at_ms: r.get(10)?,
        updated_at_ms: r.get(11)?,
        archived_at_ms: r.get(12)?,
        acceptance_total: r.get(13)?,
        acceptance_checked: r.get(14)?,
    })
}

fn task_run_kind_of(id: i64, raw: &str) -> rusqlite::Result<proto::TaskRunKind> {
    from_wire::<proto::TaskRunKind>(raw).ok_or_else(|| {
        rusqlite::Error::FromSqlConversionFailure(
            0,
            rusqlite::types::Type::Text,
            format!(
                "backlog_task_runs {id} has unknown kind {raw:?} (expected implementation or \
                 review)"
            )
            .into(),
        )
    })
}

fn task_run_state_of(id: i64, raw: &str) -> rusqlite::Result<proto::TaskRunState> {
    from_wire::<proto::TaskRunState>(raw).ok_or_else(|| {
        rusqlite::Error::FromSqlConversionFailure(
            0,
            rusqlite::types::Type::Text,
            format!(
                "backlog_task_runs {id} has unknown state {raw:?} (expected preparing, running, \
                 waiting_for_input, validating, handed_back, needs_review, failed, cancelled or \
                 interrupted)"
            )
            .into(),
        )
    })
}

impl Db {
    pub fn task(&self, id: i64) -> Result<Option<TaskRow>> {
        let conn = self.conn.lock().expect("db lock");
        Ok(conn
            .query_row(&format!("{TASK_SELECT} WHERE id = ?1"), [id], map_task)
            .optional()?)
    }

    /// Scoped global tasks, newest number first, capped by the caller.
    pub fn list_tasks(&self, workspace: &str, limit: u32) -> Result<Vec<TaskSummaryRow>> {
        let conn = self.conn.lock().expect("db lock");
        let mut stmt = conn.prepare(
            "SELECT t.id, t.workspace, t.number, t.title, t.status, t.priority, t.parent_id, \
                    t.ref_url, t.revision, t.created_by, t.created_at, t.updated_at, \
                    t.archived_at,
                    (SELECT COUNT(*) FROM backlog_task_acceptance a WHERE a.task_id = t.id),
                    (SELECT COUNT(*) FROM backlog_task_acceptance a
                       WHERE a.task_id = t.id AND a.checked_at IS NOT NULL)
             FROM backlog_tasks t WHERE (?1 = 'all' OR (?1 = 'unassigned' AND t.workspace IS NULL) OR t.workspace = ?1) ORDER BY t.number DESC LIMIT ?2",
        )?;
        let rows = stmt
            .query_map(rusqlite::params![workspace, limit], map_summary)?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    /// Scoped active tasks, newest number first, with the agent
    /// filters applied. Archived rows never appear; the cap is the caller's.
    pub fn query_tasks(&self, workspace: &str, q: &TaskQuery<'_>) -> Result<Vec<TaskSummaryRow>> {
        let mut sql =
            format!("{TASK_SUMMARY_SELECT} WHERE (?1 = 'all' OR (?1 = 'unassigned' AND t.workspace IS NULL) OR t.workspace = ?1) AND t.archived_at IS NULL");
        let mut values: Vec<rusqlite::types::Value> = vec![workspace.to_string().into()];
        if let Some(status) = q.status {
            values.push(wire_name(&status)?.into());
            sql.push_str(&format!(" AND t.status = ?{}", values.len()));
        }
        if q.ready {
            sql.push_str(&format!(" AND ({READY_CLAUSE})"));
        }
        if let Some(actor) = q.mine {
            values.push(actor.to_string().into());
            let n = values.len();
            sql.push_str(&format!(
                " AND (t.created_by = ?{n} OR (t.status = 'in_progress' AND EXISTS (
                       SELECT 1 FROM backlog_task_history h
                       WHERE h.task_id = t.id AND h.actor = ?{n} AND h.action = 'claim')))"
            ));
        }
        if let Some(query) = q.query {
            values.push(like_pattern(query).into());
            let n = values.len();
            sql.push_str(&format!(
                " AND (t.title LIKE ?{n} ESCAPE '\\' OR t.description LIKE ?{n} ESCAPE '\\')"
            ));
        }
        sql.push_str(" ORDER BY t.number DESC");
        values.push(i64::from(q.limit).into());
        sql.push_str(&format!(" LIMIT ?{}", values.len()));
        let conn = self.conn.lock().expect("db lock");
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt
            .query_map(rusqlite::params_from_iter(values.iter()), map_summary)?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    /// The workspace's ready tasks, highest priority first (`urgent .. low`,
    /// no priority last), oldest number first within a priority.
    pub fn ready_tasks(&self, workspace: &str, limit: u32) -> Result<Vec<TaskSummaryRow>> {
        let sql = format!(
            "{TASK_SUMMARY_SELECT} WHERE (?1 = 'all' OR (?1 = 'unassigned' AND t.workspace IS NULL) OR t.workspace = ?1) AND t.archived_at IS NULL
             AND ({READY_CLAUSE})
             ORDER BY CASE WHEN t.priority = 0 THEN 5 ELSE t.priority END ASC, t.number ASC
             LIMIT ?2"
        );
        let conn = self.conn.lock().expect("db lock");
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt
            .query_map(rusqlite::params![workspace, limit], map_summary)?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    /// One task by its globally unique `HOU-<n>` display number.
    pub fn task_by_number(&self, _workspace: &str, number: u32) -> Result<Option<TaskRow>> {
        let conn = self.conn.lock().expect("db lock");
        Ok(conn
            .query_row(
                &format!("{TASK_SELECT} WHERE number = ?1"),
                rusqlite::params![number],
                map_task,
            )
            .optional()?)
    }

    /// Per-status counts of scoped non-archived tasks, plus the ready
    /// pool (todo with no unfinished blocker) the queue picks from.
    pub fn task_counts(&self, workspace: &str) -> Result<proto::TaskCounts> {
        let conn = self.conn.lock().expect("db lock");
        let ready: u32 = conn.query_row(
            &format!(
                "SELECT COUNT(*) FROM backlog_tasks t WHERE (?1 = 'all' OR (?1 = 'unassigned' AND t.workspace IS NULL) OR t.workspace = ?1) AND \
                 t.archived_at IS NULL AND ({READY_CLAUSE})"
            ),
            [workspace],
            |r| r.get(0),
        )?;
        let mut stmt = conn.prepare(
            "SELECT status, COUNT(*) FROM backlog_tasks \
             WHERE (?1 = 'all' OR (?1 = 'unassigned' AND workspace IS NULL) OR workspace = ?1) AND archived_at IS NULL GROUP BY status",
        )?;
        let rows = stmt
            .query_map(rusqlite::params![workspace], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, u32>(1)?))
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        let mut counts = proto::TaskCounts {
            ready,
            ..proto::TaskCounts::default()
        };
        for (raw, n) in rows {
            let status = from_wire::<proto::TaskStatus>(&raw).ok_or_else(|| {
                anyhow::anyhow!(
                    "backlog_tasks of {workspace:?} has unknown status {raw:?} (expected one of \
                     backlog, todo, in_progress, in_review, done, canceled)"
                )
            })?;
            match status {
                proto::TaskStatus::Backlog => counts.backlog = n,
                proto::TaskStatus::Todo => counts.todo = n,
                proto::TaskStatus::InProgress => counts.in_progress = n,
                proto::TaskStatus::InReview => counts.in_review = n,
                proto::TaskStatus::Done => counts.done = n,
                proto::TaskStatus::Canceled => counts.canceled = n,
            }
        }
        Ok(counts)
    }

    pub fn task_acceptance(&self, task_id: i64) -> Result<Vec<TaskAcceptanceRow>> {
        let conn = self.conn.lock().expect("db lock");
        let mut stmt = conn.prepare(
            "SELECT id, position, text, checked_at, checked_by FROM backlog_task_acceptance \
             WHERE task_id = ?1 ORDER BY position, id",
        )?;
        let rows = stmt
            .query_map([task_id], |r| {
                Ok(TaskAcceptanceRow {
                    id: r.get(0)?,
                    position: r.get(1)?,
                    text: r.get(2)?,
                    checked_at_ms: r.get(3)?,
                    checked_by: r.get(4)?,
                })
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    /// The task's comments, newest first, capped by the caller.
    pub fn task_comments(&self, task_id: i64, limit: u32) -> Result<Vec<TaskCommentRow>> {
        let conn = self.conn.lock().expect("db lock");
        let mut stmt = conn.prepare(
            "SELECT id, body, author, created_at FROM backlog_task_comments \
             WHERE task_id = ?1 ORDER BY id DESC LIMIT ?2",
        )?;
        let rows = stmt
            .query_map(rusqlite::params![task_id, limit], |r| {
                Ok(TaskCommentRow {
                    id: r.get(0)?,
                    body: r.get(1)?,
                    author: r.get(2)?,
                    created_at_ms: r.get(3)?,
                })
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    /// Every scoped task, archived included: the cap counts them all.
    pub fn task_count(&self, workspace: &str) -> Result<u32> {
        let conn = self.conn.lock().expect("db lock");
        Ok(conn.query_row(
            "SELECT COUNT(*) FROM backlog_tasks WHERE (?1 = 'all' OR (?1 = 'unassigned' AND workspace IS NULL) OR workspace = ?1)",
            [workspace],
            |r| r.get(0),
        )?)
    }

    pub fn task_comment_count(&self, task_id: i64) -> Result<u32> {
        let conn = self.conn.lock().expect("db lock");
        Ok(conn.query_row(
            "SELECT COUNT(*) FROM backlog_task_comments WHERE task_id = ?1",
            [task_id],
            |r| r.get(0),
        )?)
    }

    /// The task's history, newest first, capped by the caller.
    pub fn task_history(&self, task_id: i64, limit: u32) -> Result<Vec<TaskHistoryRow>> {
        let conn = self.conn.lock().expect("db lock");
        let mut stmt = conn.prepare(
            "SELECT id, actor, action, changes, created_at FROM backlog_task_history \
             WHERE task_id = ?1 ORDER BY id DESC LIMIT ?2",
        )?;
        let rows = stmt
            .query_map(rusqlite::params![task_id, limit], |r| {
                Ok(TaskHistoryRow {
                    id: r.get(0)?,
                    actor: r.get(1)?,
                    action: r.get(2)?,
                    changes: r.get(3)?,
                    created_at_ms: r.get(4)?,
                })
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    /// The task's runs, newest first, capped by the caller.
    pub fn task_runs(&self, task_id: i64, limit: u32) -> Result<Vec<TaskRunRow>> {
        let conn = self.conn.lock().expect("db lock");
        let mut stmt = conn.prepare(&format!(
            "{TASK_RUN_SELECT} WHERE task_id = ?1 ORDER BY id DESC LIMIT ?2"
        ))?;
        let rows = stmt
            .query_map(rusqlite::params![task_id, limit], map_task_run)?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    pub fn task_run(&self, id: i64) -> Result<Option<TaskRunRow>> {
        let conn = self.conn.lock().expect("db lock");
        Ok(conn
            .query_row(
                &format!("{TASK_RUN_SELECT} WHERE id = ?1"),
                [id],
                map_task_run,
            )
            .optional()?)
    }

    /// The task's newest implementation run still in flight, if any.
    pub fn open_task_run_for_task(&self, task_id: i64) -> Result<Option<TaskRunRow>> {
        let conn = self.conn.lock().expect("db lock");
        Ok(conn
            .query_row(
                &format!(
                    "{TASK_RUN_SELECT} WHERE task_id = ?1 AND kind = 'implementation' \
                     AND state IN ({OPEN_RUN_STATES}) ORDER BY id DESC LIMIT 1"
                ),
                [task_id],
                map_task_run,
            )
            .optional()?)
    }

    /// The newest open run bound to `delegation_id`, whatever its kind: the
    /// child a `pane_submit` settles.
    pub fn open_task_run_for_delegation(&self, delegation_id: u32) -> Result<Option<TaskRunRow>> {
        let conn = self.conn.lock().expect("db lock");
        Ok(conn
            .query_row(
                &format!(
                    "{TASK_RUN_SELECT} WHERE delegation_id = ?1 AND state IN \
                     ({OPEN_RUN_STATES}) ORDER BY id DESC LIMIT 1"
                ),
                [delegation_id],
                map_task_run,
            )
            .optional()?)
    }

    /// The task's newest implementation run, open or closed: the reviewer reads
    /// its branch, worktree and summary.
    pub fn latest_implementation_run(&self, task_id: i64) -> Result<Option<TaskRunRow>> {
        let conn = self.conn.lock().expect("db lock");
        Ok(conn
            .query_row(
                &format!(
                    "{TASK_RUN_SELECT} WHERE task_id = ?1 AND kind = 'implementation' \
                     ORDER BY id DESC LIMIT 1"
                ),
                [task_id],
                map_task_run,
            )
            .optional()?)
    }

    /// The newest open run bound to `session_id`, whatever its kind.
    pub fn open_task_run_for_session(&self, session_id: u32) -> Result<Option<TaskRunRow>> {
        let conn = self.conn.lock().expect("db lock");
        Ok(conn
            .query_row(
                &format!(
                    "{TASK_RUN_SELECT} WHERE session_id = ?1 AND state IN ({OPEN_RUN_STATES}) \
                     ORDER BY id DESC LIMIT 1"
                ),
                [session_id],
                map_task_run,
            )
            .optional()?)
    }

    /// Every open run, oldest first: the restart reconcile walks them.
    pub fn open_task_runs(&self) -> Result<Vec<TaskRunRow>> {
        let conn = self.conn.lock().expect("db lock");
        let mut stmt = conn.prepare(&format!(
            "{TASK_RUN_SELECT} WHERE state IN ({OPEN_RUN_STATES}) ORDER BY id"
        ))?;
        let rows = stmt
            .query_map([], map_task_run)?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    /// Inserts one run; `attempt` is the task's next number, allocated in the
    /// same statement so two starts cannot take the same one.
    pub fn create_task_run(&self, w: &TaskRunWrite<'_>) -> Result<TaskRunRow> {
        let conn = self.conn.lock().expect("db lock");
        conn.execute(
            "INSERT INTO backlog_task_runs \
                (task_id, attempt, kind, state, provider, reviewer, session_id, delegation_id, \
                 worktree_path, branch, base_commit, initial_revision, summary, reason, \
                 started_at, ended_at) \
             VALUES (?1, (SELECT COALESCE(MAX(attempt), 0) + 1 FROM backlog_task_runs \
                          WHERE task_id = ?1), \
                     ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, NULL, NULL, ?12, NULL)",
            rusqlite::params![
                w.task_id,
                wire_name(&w.kind)?,
                wire_name(&w.state)?,
                wire_name(&w.provider)?,
                w.reviewer.map(|r| wire_name(&r)).transpose()?,
                w.session_id,
                w.delegation_id,
                w.worktree_path,
                w.branch,
                w.base_commit,
                w.initial_revision,
                w.started_at_ms,
            ],
        )?;
        let id = conn.last_insert_rowid();
        drop(conn);
        self.task_run(id)?
            .with_context(|| format!("run {id} disappeared inside its own insert"))
    }

    /// Moves one run; `ended` stamps `ended_at`. `reason` is replaced either
    /// way, so a resume or a merge clears an earlier one.
    pub fn task_run_set_state(
        &self,
        run_id: i64,
        state: proto::TaskRunState,
        reason: Option<&str>,
        ended: bool,
        now_ms: i64,
    ) -> Result<bool> {
        let conn = self.conn.lock().expect("db lock");
        let changed = conn.execute(
            "UPDATE backlog_task_runs SET state = ?2, reason = ?3, \
                 ended_at = CASE WHEN ?4 THEN ?5 ELSE ended_at END \
             WHERE id = ?1",
            rusqlite::params![run_id, wire_name(&state)?, reason, ended, now_ms],
        )?;
        Ok(changed > 0)
    }

    /// Clears `ended_at`: a stop that failed to kill its pane puts the run
    /// back among the open ones.
    pub fn task_run_clear_ended(&self, run_id: i64) -> Result<()> {
        let conn = self.conn.lock().expect("db lock");
        conn.execute(
            "UPDATE backlog_task_runs SET ended_at = NULL WHERE id = ?1",
            [run_id],
        )?;
        Ok(())
    }

    /// Binds a run to the pane that will work it.
    pub fn task_run_set_session(
        &self,
        run_id: i64,
        session_id: u32,
        state: proto::TaskRunState,
    ) -> Result<()> {
        let conn = self.conn.lock().expect("db lock");
        conn.execute(
            "UPDATE backlog_task_runs SET session_id = ?2, state = ?3 WHERE id = ?1",
            rusqlite::params![run_id, session_id, wire_name(&state)?],
        )?;
        Ok(())
    }

    /// Re-bases a run's drift guard after the start's own status move; the
    /// move is part of starting, not a change the run should warn about.
    pub fn task_run_set_initial_revision(&self, run_id: i64, revision: i64) -> Result<()> {
        let conn = self.conn.lock().expect("db lock");
        conn.execute(
            "UPDATE backlog_task_runs SET initial_revision = ?2 WHERE id = ?1",
            rusqlite::params![run_id, revision],
        )?;
        Ok(())
    }

    /// Records the delegation an orchestrated run's child reports through.
    pub fn task_run_set_delegation(&self, run_id: i64, delegation_id: i64) -> Result<()> {
        let conn = self.conn.lock().expect("db lock");
        conn.execute(
            "UPDATE backlog_task_runs SET delegation_id = ?2 WHERE id = ?1",
            rusqlite::params![run_id, delegation_id],
        )?;
        Ok(())
    }

    /// Records the worktree a review run reads; it is created after the run row
    /// exists, so the review attempt names its own tree.
    pub fn task_run_set_worktree(&self, run_id: i64, worktree_path: &str) -> Result<()> {
        let conn = self.conn.lock().expect("db lock");
        conn.execute(
            "UPDATE backlog_task_runs SET worktree_path = ?2 WHERE id = ?1",
            rusqlite::params![run_id, worktree_path],
        )?;
        Ok(())
    }

    /// Sets a run's visible reason; `Ok(false)` when it already said that, so
    /// the PR watch does not broadcast the same failure every tick.
    pub fn task_run_set_reason(&self, run_id: i64, reason: Option<&str>) -> Result<bool> {
        let conn = self.conn.lock().expect("db lock");
        let changed = conn.execute(
            "UPDATE backlog_task_runs SET reason = ?2 WHERE id = ?1 AND reason IS NOT ?2",
            rusqlite::params![run_id, reason],
        )?;
        Ok(changed > 0)
    }

    pub fn task_run_set_summary(&self, run_id: i64, summary: &str) -> Result<()> {
        let conn = self.conn.lock().expect("db lock");
        conn.execute(
            "UPDATE backlog_task_runs SET summary = ?2 WHERE id = ?1",
            rusqlite::params![run_id, summary],
        )?;
        Ok(())
    }

    /// The newest run recorded with `session_id`, with its task.
    pub fn task_binding_for_session(
        &self,
        session_id: u32,
    ) -> Result<Option<SessionTaskBindingRow>> {
        Ok(self
            .task_bindings()?
            .into_iter()
            .find(|binding| binding.run.session_id == Some(session_id)))
    }

    /// Every session-to-task binding, newest run per session. One query for a
    /// whole `session_list`, not one per session.
    pub fn task_bindings(&self) -> Result<Vec<SessionTaskBindingRow>> {
        let conn = self.conn.lock().expect("db lock");
        let mut stmt = conn.prepare(&format!(
            "SELECT {}, {} FROM backlog_task_runs r JOIN backlog_tasks t ON t.id = r.task_id \
             WHERE r.session_id IS NOT NULL ORDER BY r.id DESC",
            prefixed_columns(TASK_RUN_COLUMNS, "r"),
            prefixed_columns(TASK_COLUMNS, "t"),
        ))?;
        let rows = stmt
            .query_map([], |r| {
                let run = map_task_run(r)?;
                let task = map_task_offset(r, TASK_RUN_COLUMN_COUNT)?;
                Ok(SessionTaskBindingRow { task, run })
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        let mut seen = std::collections::HashSet::new();
        Ok(rows
            .into_iter()
            .filter(|binding| binding.run.session_id.is_some_and(|id| seen.insert(id)))
            .collect())
    }

    /// The in-review tasks that have a recorded run with a branch to watch:
    /// (task, newest such run).
    pub fn tasks_in_review_with_runs(&self) -> Result<Vec<(TaskRow, TaskRunRow)>> {
        let conn = self.conn.lock().expect("db lock");
        let mut stmt = conn.prepare(&format!(
            "SELECT {}, {} FROM backlog_tasks t JOIN backlog_task_runs r ON r.id = (\
                 SELECT id FROM backlog_task_runs WHERE task_id = t.id AND branch IS NOT NULL \
                 ORDER BY id DESC LIMIT 1) \
             WHERE t.status = 'in_review' AND t.archived_at IS NULL ORDER BY t.id",
            prefixed_columns(TASK_COLUMNS, "t"),
            prefixed_columns(TASK_RUN_COLUMNS, "r"),
        ))?;
        let rows = stmt
            .query_map([], |r| {
                let task = map_task(r)?;
                let run = map_task_run_offset(r, TASK_COLUMN_COUNT)?;
                Ok((task, run))
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    /// Whether the user changed the task's status after `since_ms`; a derived
    /// status move never overwrites that.
    pub fn task_user_status_changed_since(&self, task_id: i64, since_ms: i64) -> Result<bool> {
        let conn = self.conn.lock().expect("db lock");
        Ok(conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM backlog_task_history \
             WHERE task_id = ?1 AND created_at >= ?2 AND actor = 'user' \
             AND changes LIKE '%\"status\"%')",
            rusqlite::params![task_id, since_ms],
            |r| r.get(0),
        )?)
    }

    /// One history row without touching the task or its revision: a run's
    /// start or a derived note that is not itself a field change.
    pub fn record_task_history(
        &self,
        task_id: i64,
        actor: &str,
        action: &str,
        changes: &str,
        now_ms: i64,
    ) -> Result<()> {
        let conn = self.conn.lock().expect("db lock");
        conn.execute(
            "INSERT INTO backlog_task_history (task_id, actor, action, changes, created_at) \
             VALUES (?1, ?2, ?3, ?4, ?5)",
            rusqlite::params![task_id, actor, action, changes, now_ms],
        )?;
        Ok(())
    }

    /// Creates a task and its acceptance items in one transaction. The number
    /// comes from `backlog_task_counters` and is never handed out twice.
    pub fn create_task(&self, w: &TaskWrite<'_>) -> Result<TaskRow> {
        let mut conn = self.conn.lock().expect("db lock");
        let tx = conn.transaction()?;
        tx.execute("UPDATE backlog_task_counters SET next_number = next_number + 1 WHERE workspace = 'all'", [])?;
        let next: i64 = tx.query_row(
            "SELECT next_number FROM backlog_task_counters WHERE workspace = 'all'",
            [],
            |r| r.get(0),
        )?;
        let number = u32::try_from(next - 1).with_context(|| {
            format!(
                "global backlog with workspace {:?} ran out of task numbers at {next} (expected a value in 1..=u32::MAX)",
                w.workspace
            )
        })?;
        tx.execute(
            "INSERT INTO backlog_tasks \
                (workspace, number, title, description, status, priority, parent_id, ref_url, \
                 revision, created_by, created_at, updated_at) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 1, ?9, ?10, ?10)",
            rusqlite::params![
                w.workspace,
                number,
                w.title,
                w.description,
                wire_name(&w.status)?,
                priority_value(w.priority),
                w.parent_id,
                w.ref_url,
                w.created_by,
                w.now_ms,
            ],
        )?;
        let id = tx.last_insert_rowid();
        for (position, text) in w.acceptance.iter().enumerate() {
            tx.execute(
                "INSERT INTO backlog_task_acceptance (task_id, position, text) VALUES (?1, ?2, ?3)",
                rusqlite::params![id, position as i64, text],
            )?;
        }
        tx.execute(
            "INSERT INTO backlog_task_history (task_id, actor, action, changes, created_at) \
             VALUES (?1, ?2, 'create', '{}', ?3)",
            rusqlite::params![id, w.created_by, w.now_ms],
        )?;
        tx.commit()?;
        drop(conn);
        self.task(id)?
            .with_context(|| format!("task {id} disappeared inside its own create transaction"))
    }

    /// Applies a full update guarded by revision. `Ok(false)` is a concurrent
    /// change: nothing was written.
    pub fn update_task(&self, u: &TaskUpdate<'_>) -> Result<bool> {
        let mut conn = self.conn.lock().expect("db lock");
        let tx = conn.transaction()?;
        let changed = tx.execute(
            "UPDATE backlog_tasks SET title = ?2, description = ?3, status = ?4, priority = ?5, \
                 parent_id = ?6, ref_url = ?7, revision = revision + 1, updated_at = ?8, workspace = ?10 \
             WHERE id = ?1 AND revision = ?9",
            rusqlite::params![
                u.id,
                u.title,
                u.description,
                wire_name(&u.status)?,
                priority_value(u.priority),
                u.parent_id,
                u.ref_url,
                u.now_ms,
                u.expected_revision,
                u.workspace,
            ],
        )?;
        if changed == 0 {
            return Ok(false);
        }
        if let Some(items) = u.acceptance {
            tx.execute(
                "DELETE FROM backlog_task_acceptance WHERE task_id = ?1",
                rusqlite::params![u.id],
            )?;
            for (position, text) in items.iter().enumerate() {
                tx.execute(
                    "INSERT INTO backlog_task_acceptance (task_id, position, text) \
                     VALUES (?1, ?2, ?3)",
                    rusqlite::params![u.id, position as i64, text],
                )?;
            }
        }
        tx.execute(
            "INSERT INTO backlog_task_history (task_id, actor, action, changes, created_at) \
             VALUES (?1, ?2, ?3, ?4, ?5)",
            rusqlite::params![u.id, u.actor, u.action, u.changes, u.now_ms],
        )?;
        tx.commit()?;
        Ok(true)
    }

    /// Records a comment, bumps the task's revision and writes history.
    pub fn add_task_comment(&self, id: i64, body: &str, author: &str, now_ms: i64) -> Result<()> {
        let mut conn = self.conn.lock().expect("db lock");
        let tx = conn.transaction()?;
        tx.execute(
            "INSERT INTO backlog_task_comments (task_id, body, author, created_at) \
             VALUES (?1, ?2, ?3, ?4)",
            rusqlite::params![id, body, author, now_ms],
        )?;
        let comment_id = tx.last_insert_rowid();
        let changed = tx.execute(
            "UPDATE backlog_tasks SET revision = revision + 1, updated_at = ?2 WHERE id = ?1",
            rusqlite::params![id, now_ms],
        )?;
        if changed == 0 {
            bail!("task {id} disappeared while adding a comment");
        }
        tx.execute(
            "INSERT INTO backlog_task_history (task_id, actor, action, changes, created_at) \
             VALUES (?1, ?2, 'comment', ?3, ?4)",
            rusqlite::params![
                id,
                author,
                serde_json::json!({ "comment": comment_id }).to_string(),
                now_ms
            ],
        )?;
        tx.commit()?;
        Ok(())
    }

    /// Ticks one acceptance item and bumps the task's revision. `Ok(false)`
    /// names no such item on that task.
    pub fn set_task_acceptance_checked(
        &self,
        id: i64,
        item: i64,
        checked: bool,
        actor: &str,
        now_ms: i64,
    ) -> Result<bool> {
        let mut conn = self.conn.lock().expect("db lock");
        let tx = conn.transaction()?;
        let text: Option<String> = tx
            .query_row(
                "SELECT text FROM backlog_task_acceptance WHERE id = ?1 AND task_id = ?2",
                rusqlite::params![item, id],
                |r| r.get(0),
            )
            .optional()?;
        let Some(text) = text else {
            return Ok(false);
        };
        tx.execute(
            "UPDATE backlog_task_acceptance SET checked_at = ?3, checked_by = ?4 \
             WHERE id = ?1 AND task_id = ?2",
            rusqlite::params![
                item,
                id,
                checked.then_some(now_ms),
                checked.then_some(actor)
            ],
        )?;
        let changed = tx.execute(
            "UPDATE backlog_tasks SET revision = revision + 1, updated_at = ?2 WHERE id = ?1",
            rusqlite::params![id, now_ms],
        )?;
        if changed == 0 {
            bail!("task {id} disappeared while checking one of its acceptance items");
        }
        tx.execute(
            "INSERT INTO backlog_task_history (task_id, actor, action, changes, created_at) \
             VALUES (?1, ?2, ?3, ?4, ?5)",
            rusqlite::params![
                id,
                actor,
                if checked { "check" } else { "uncheck" },
                serde_json::json!({ "item": item, "text": text }).to_string(),
                now_ms
            ],
        )?;
        tx.commit()?;
        Ok(true)
    }

    /// Archives or restores a task guarded by revision. `Ok(false)` is a
    /// concurrent change: nothing was written.
    pub fn set_task_archived(
        &self,
        id: i64,
        expected_revision: i64,
        archived: bool,
        actor: &str,
        now_ms: i64,
    ) -> Result<bool> {
        let mut conn = self.conn.lock().expect("db lock");
        let tx = conn.transaction()?;
        let changed = tx.execute(
            "UPDATE backlog_tasks SET archived_at = ?2, revision = revision + 1, updated_at = ?3 \
             WHERE id = ?1 AND revision = ?4",
            rusqlite::params![id, archived.then_some(now_ms), now_ms, expected_revision],
        )?;
        if changed == 0 {
            return Ok(false);
        }
        tx.execute(
            "INSERT INTO backlog_task_history (task_id, actor, action, changes, created_at) \
             VALUES (?1, ?2, ?3, '{}', ?4)",
            rusqlite::params![
                id,
                actor,
                if archived { "archive" } else { "restore" },
                now_ms
            ],
        )?;
        tx.commit()?;
        Ok(true)
    }

    /// Unassigns retained tasks and interrupts their open runs.
    pub fn remove_backlog_tasks(&self, workspace: &str) -> Result<usize> {
        let mut conn = self.conn.lock().expect("db lock");
        let tx = conn.transaction()?;
        let now_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)?
            .as_millis() as i64;
        let reason = format!("workspace {workspace:?} was removed");
        tx.execute(&format!("UPDATE backlog_task_runs SET state = 'interrupted', reason = ?2, ended_at = ?3 WHERE task_id IN (SELECT id FROM backlog_tasks WHERE workspace = ?1) AND state IN ({OPEN_RUN_STATES})"), rusqlite::params![workspace, reason, now_ms])?;
        tx.execute("INSERT INTO backlog_task_history (task_id, actor, action, changes, created_at) SELECT id, 'houston:workspace-removed', 'houston:workspace-removed', ?2, ?3 FROM backlog_tasks WHERE workspace = ?1", rusqlite::params![workspace, serde_json::json!({"workspace": {"old": workspace, "new": null}}).to_string(), now_ms])?;
        let changed = tx.execute("UPDATE backlog_tasks SET workspace = NULL, revision = revision + 1, updated_at = ?2 WHERE workspace = ?1", rusqlite::params![workspace, now_ms])?;
        tx.commit()?;
        Ok(changed)
    }
}
