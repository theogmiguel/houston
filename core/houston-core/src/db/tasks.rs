//! The per-workspace task backlog: tasks, their numbers, acceptance items,
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
            workspace     TEXT    NOT NULL,
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
            UNIQUE(workspace, number)
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
            WHERE state IN ('preparing', 'running', 'waiting_for_input', 'validating');",
    )?;
    Ok(())
}

pub struct TaskRow {
    pub id: i64,
    pub workspace: String,
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
    pub workspace: String,
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
    pub started_at_ms: i64,
    pub ended_at_ms: Option<i64>,
}

/// The fields a new task is inserted with, already validated by the caller.
pub struct TaskWrite<'a> {
    pub workspace: &'a str,
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

fn map_task(r: &rusqlite::Row) -> rusqlite::Result<TaskRow> {
    let id: i64 = r.get(0)?;
    let status_raw: String = r.get(5)?;
    Ok(TaskRow {
        id,
        workspace: r.get(1)?,
        number: r.get(2)?,
        title: r.get(3)?,
        description: r.get(4)?,
        status: status_of(id, &status_raw)?,
        priority: priority_of(id, r.get(6)?)?,
        parent_id: r.get(7)?,
        ref_url: r.get(8)?,
        revision: r.get(9)?,
        created_by: r.get(10)?,
        created_at_ms: r.get(11)?,
        updated_at_ms: r.get(12)?,
        archived_at_ms: r.get(13)?,
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

    /// The workspace's tasks, newest number first, capped by the caller.
    pub fn list_tasks(&self, workspace: &str, limit: u32) -> Result<Vec<TaskSummaryRow>> {
        let conn = self.conn.lock().expect("db lock");
        let mut stmt = conn.prepare(
            "SELECT t.id, t.workspace, t.number, t.title, t.status, t.priority, t.parent_id, \
                    t.ref_url, t.revision, t.created_by, t.created_at, t.updated_at, \
                    t.archived_at,
                    (SELECT COUNT(*) FROM backlog_task_acceptance a WHERE a.task_id = t.id),
                    (SELECT COUNT(*) FROM backlog_task_acceptance a
                       WHERE a.task_id = t.id AND a.checked_at IS NOT NULL)
             FROM backlog_tasks t WHERE t.workspace = ?1 ORDER BY t.number DESC LIMIT ?2",
        )?;
        let rows = stmt
            .query_map(rusqlite::params![workspace, limit], map_summary)?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    /// The workspace's active tasks, newest number first, with the agent
    /// filters applied. Archived rows never appear; the cap is the caller's.
    pub fn query_tasks(&self, workspace: &str, q: &TaskQuery<'_>) -> Result<Vec<TaskSummaryRow>> {
        let mut sql =
            format!("{TASK_SUMMARY_SELECT} WHERE t.workspace = ?1 AND t.archived_at IS NULL");
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
            "{TASK_SUMMARY_SELECT} WHERE t.workspace = ?1 AND t.archived_at IS NULL
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

    /// One task of a workspace by its display number, for `HOU-<n>` keys.
    pub fn task_by_number(&self, workspace: &str, number: u32) -> Result<Option<TaskRow>> {
        let conn = self.conn.lock().expect("db lock");
        Ok(conn
            .query_row(
                &format!("{TASK_SELECT} WHERE workspace = ?1 AND number = ?2"),
                rusqlite::params![workspace, number],
                map_task,
            )
            .optional()?)
    }

    /// Per-status counts of the workspace's non-archived tasks.
    pub fn task_counts(&self, workspace: &str) -> Result<proto::TaskCounts> {
        let conn = self.conn.lock().expect("db lock");
        let mut stmt = conn.prepare(
            "SELECT status, COUNT(*) FROM backlog_tasks \
             WHERE workspace = ?1 AND archived_at IS NULL GROUP BY status",
        )?;
        let rows = stmt
            .query_map(rusqlite::params![workspace], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, u32>(1)?))
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        let mut counts = proto::TaskCounts::default();
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

    /// Every task of the workspace, archived included: the cap counts them all.
    pub fn task_count(&self, workspace: &str) -> Result<u32> {
        let conn = self.conn.lock().expect("db lock");
        Ok(conn.query_row(
            "SELECT COUNT(*) FROM backlog_tasks WHERE workspace = ?1",
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
        let mut stmt = conn.prepare(
            "SELECT id, task_id, attempt, kind, state, provider, reviewer, session_id, \
                    delegation_id, worktree_path, branch, base_commit, initial_revision, \
                    summary, started_at, ended_at \
             FROM backlog_task_runs WHERE task_id = ?1 ORDER BY id DESC LIMIT ?2",
        )?;
        let rows = stmt
            .query_map(rusqlite::params![task_id, limit], |r| {
                let id: i64 = r.get(0)?;
                let kind_raw: String = r.get(3)?;
                let state_raw: String = r.get(4)?;
                let provider_raw: String = r.get(5)?;
                let provider = from_wire::<proto::AgentKind>(&provider_raw).ok_or_else(|| {
                    rusqlite::Error::FromSqlConversionFailure(
                        0,
                        rusqlite::types::Type::Text,
                        format!(
                            "backlog_task_runs {id} has unknown provider {provider_raw:?} \
                             (expected an AgentKind)"
                        )
                        .into(),
                    )
                })?;
                let reviewer = match r.get::<_, Option<String>>(6)? {
                    Some(raw) => Some(from_wire::<proto::AgentKind>(&raw).ok_or_else(|| {
                        rusqlite::Error::FromSqlConversionFailure(
                            0,
                            rusqlite::types::Type::Text,
                            format!(
                                "backlog_task_runs {id} has unknown reviewer {raw:?} (expected \
                                 an AgentKind)"
                            )
                            .into(),
                        )
                    })?),
                    None => None,
                };
                Ok(TaskRunRow {
                    id,
                    task_id: r.get(1)?,
                    attempt: r.get(2)?,
                    kind: task_run_kind_of(id, &kind_raw)?,
                    state: task_run_state_of(id, &state_raw)?,
                    provider,
                    reviewer,
                    session_id: r.get(7)?,
                    delegation_id: r.get(8)?,
                    worktree_path: r.get(9)?,
                    branch: r.get(10)?,
                    base_commit: r.get(11)?,
                    initial_revision: r.get(12)?,
                    summary: r.get(13)?,
                    started_at_ms: r.get(14)?,
                    ended_at_ms: r.get(15)?,
                })
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    /// Creates a task and its acceptance items in one transaction. The number
    /// comes from `backlog_task_counters` and is never handed out twice.
    pub fn create_task(&self, w: &TaskWrite<'_>) -> Result<TaskRow> {
        let mut conn = self.conn.lock().expect("db lock");
        let tx = conn.transaction()?;
        tx.execute(
            "INSERT OR IGNORE INTO backlog_task_counters (workspace, next_number) VALUES (?1, 1)",
            rusqlite::params![w.workspace],
        )?;
        tx.execute(
            "UPDATE backlog_task_counters SET next_number = next_number + 1 WHERE workspace = ?1",
            rusqlite::params![w.workspace],
        )?;
        let next: i64 = tx.query_row(
            "SELECT next_number FROM backlog_task_counters WHERE workspace = ?1",
            rusqlite::params![w.workspace],
            |r| r.get(0),
        )?;
        let number = u32::try_from(next - 1).with_context(|| {
            format!(
                "workspace {:?} ran out of task numbers at {next} (expected a value in 1..=u32::MAX)",
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
                 parent_id = ?6, ref_url = ?7, revision = revision + 1, updated_at = ?8 \
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

    /// Deletes every backlog row of a removed workspace. Returns the number of
    /// tasks removed.
    pub fn remove_backlog_tasks(&self, workspace: &str) -> Result<usize> {
        let mut conn = self.conn.lock().expect("db lock");
        let tx = conn.transaction()?;
        let ids = "SELECT id FROM backlog_tasks WHERE workspace = ?1";
        for table in [
            "backlog_task_acceptance",
            "backlog_task_comments",
            "backlog_task_history",
            "backlog_task_runs",
        ] {
            tx.execute(
                &format!("DELETE FROM {table} WHERE task_id IN ({ids})"),
                rusqlite::params![workspace],
            )?;
        }
        tx.execute(
            &format!(
                "DELETE FROM backlog_task_blocks WHERE task_id IN ({ids}) \
                 OR blocked_by_id IN ({ids})"
            ),
            rusqlite::params![workspace],
        )?;
        let removed = tx.execute(
            "DELETE FROM backlog_tasks WHERE workspace = ?1",
            rusqlite::params![workspace],
        )?;
        tx.execute(
            "DELETE FROM backlog_task_counters WHERE workspace = ?1",
            rusqlite::params![workspace],
        )?;
        tx.commit()?;
        Ok(removed)
    }
}
