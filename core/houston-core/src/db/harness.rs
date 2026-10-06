//! Harness review runs, the findings each one published, and the operator's
//! decisions on them. Decisions are keyed by workspace and finding key, not by
//! review, so a later review knows what was already dismissed or resolved.
use anyhow::Result;
use houston_protocol as proto;
use rusqlite::{Connection, OptionalExtension};

use super::{from_wire, wire_name, Db};

pub(super) fn migrate(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS harness_routines (
            workspace TEXT PRIMARY KEY,
            routine_id INTEGER NOT NULL UNIQUE
        );
        CREATE TABLE IF NOT EXISTS harness_reviews (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            workspace TEXT NOT NULL,
            routine_id INTEGER NOT NULL,
            run_id INTEGER NOT NULL UNIQUE,
            session_id INTEGER,
            status TEXT NOT NULL,
            run_dir TEXT NOT NULL,
            started_at_ms INTEGER NOT NULL,
            ended_at_ms INTEGER,
            window_since TEXT,
            window_until TEXT,
            sessions INTEGER,
            prompts INTEGER,
            cost_usd REAL,
            summary TEXT,
            error TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_harness_reviews_workspace
            ON harness_reviews(workspace, id DESC);
        CREATE TABLE IF NOT EXISTS harness_findings (
            review_id INTEGER NOT NULL,
            key TEXT NOT NULL,
            title TEXT NOT NULL,
            category TEXT NOT NULL,
            confidence TEXT NOT NULL,
            sessions TEXT NOT NULL,
            count INTEGER NOT NULL,
            quotes TEXT NOT NULL,
            recommendation_kind TEXT NOT NULL,
            target TEXT NOT NULL,
            recommendation TEXT NOT NULL,
            apply_prompt TEXT NOT NULL,
            PRIMARY KEY (review_id, key)
        );
        CREATE INDEX IF NOT EXISTS idx_harness_findings_key_review
            ON harness_findings(key, review_id);
        CREATE TABLE IF NOT EXISTS harness_decisions (
            workspace TEXT NOT NULL,
            key TEXT NOT NULL,
            state TEXT NOT NULL,
            decided_at_ms INTEGER NOT NULL,
            decided_by TEXT NOT NULL DEFAULT 'user',
            PRIMARY KEY (workspace, key)
        );",
    )?;
    add_column_if_missing(
        conn,
        "harness_decisions",
        "decided_by",
        "decided_by TEXT NOT NULL DEFAULT 'user'",
    )?;
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS harness_finding_tasks (
            workspace TEXT NOT NULL,
            key TEXT NOT NULL,
            task_id INTEGER NOT NULL,
            review_id INTEGER NOT NULL,
            created_at_ms INTEGER NOT NULL,
            PRIMARY KEY (workspace, key, task_id)
        );
        CREATE INDEX IF NOT EXISTS idx_harness_finding_tasks_task
            ON harness_finding_tasks(task_id);
        CREATE INDEX IF NOT EXISTS idx_harness_finding_tasks_finding
            ON harness_finding_tasks(workspace, key, created_at_ms DESC);
        CREATE TABLE IF NOT EXISTS harness_verifications (
            review_id INTEGER NOT NULL,
            key TEXT NOT NULL,
            task_id INTEGER NOT NULL,
            verdict TEXT NOT NULL,
            sessions_after INTEGER NOT NULL,
            evidence TEXT NOT NULL,
            PRIMARY KEY (review_id, key, task_id)
        );",
    )?;
    Ok(())
}

fn add_column_if_missing(
    conn: &Connection,
    table: &str,
    column: &str,
    column_def: &str,
) -> Result<()> {
    let present: bool = conn.query_row(
        "SELECT COUNT(*) FROM pragma_table_info(?1) WHERE name = ?2",
        rusqlite::params![table, column],
        |r| r.get::<_, i64>(0).map(|count| count > 0),
    )?;
    if !present {
        conn.execute(&format!("ALTER TABLE {table} ADD COLUMN {column_def}"), [])?;
    }
    Ok(())
}

pub(super) fn close_stale_reviews(conn: &Connection) -> Result<()> {
    let closed = conn.execute(
        "UPDATE harness_reviews SET status = 'failed', \
             error = 'the daemon stopped while this review was in flight', \
             ended_at_ms = MAX(started_at_ms, unixepoch() * 1000) \
         WHERE status = 'running'",
        [],
    )?;
    if closed > 0 {
        tracing::info!("closed {closed} harness review(s) a previous daemon left in flight");
    }
    Ok(())
}

pub struct HarnessReviewRow {
    pub id: u32,
    pub workspace: String,
    pub routine_id: u32,
    pub run_id: u32,
    pub session_id: Option<u32>,
    pub status: proto::HarnessReviewStatus,
    pub run_dir: String,
    pub started_at_ms: i64,
    pub ended_at_ms: Option<i64>,
    pub window: Option<(String, String)>,
    pub sessions: Option<u32>,
    pub prompts: Option<u32>,
    pub cost_usd: Option<f64>,
    pub summary: Option<String>,
    pub error: Option<String>,
    pub finding_count: u32,
}

/// What a publish records about the run, read from `findings.json`.
pub struct HarnessPublication<'a> {
    pub window: Option<(&'a str, &'a str)>,
    pub sessions: Option<u32>,
    pub prompts: Option<u32>,
    pub cost_usd: Option<f64>,
    pub summary: &'a str,
    pub findings: &'a [HarnessFindingWrite],
    pub verifications: &'a [HarnessVerificationWrite],
}

#[derive(Debug)]
pub struct HarnessVerificationWrite {
    pub key: String,
    pub task_id: i64,
    pub verdict: proto::HarnessVerdict,
    pub sessions_after: u32,
    pub evidence: Vec<String>,
}

pub struct HarnessTaskRow {
    pub task_id: i64,
    pub key: String,
    pub status: proto::TaskStatus,
    pub landed_at_ms: Option<i64>,
    pub review_id: u32,
    pub created_at_ms: i64,
}

pub struct HarnessVerificationRow {
    pub review_id: u32,
    pub review_ended_at_ms: i64,
    pub task_id: i64,
    pub verdict: proto::HarnessVerdict,
    pub sessions_after: u32,
    pub evidence: Vec<String>,
}

pub struct HarnessDecisionDetailRow {
    pub state: proto::HarnessFindingState,
    pub decided_at_ms: i64,
    pub decided_by: String,
}

#[derive(Debug)]
pub struct HarnessFindingWrite {
    pub key: String,
    pub title: String,
    pub category: String,
    pub confidence: String,
    pub sessions: Vec<String>,
    pub count: u32,
    pub quotes: Vec<String>,
    pub recommendation_kind: String,
    pub target: String,
    pub recommendation: String,
    pub apply_prompt: String,
}

/// A finding row with the end time of the review that published it.
pub struct HarnessFindingRow {
    pub review_id: u32,
    pub review_ended_at_ms: i64,
    pub finding: HarnessFindingWrite,
}

pub struct HarnessDecisionRow {
    pub key: String,
    pub state: proto::HarnessFindingState,
    pub decided_at_ms: i64,
    pub decided_by: String,
}

pub struct HarnessFindingTaskRow {
    pub task_id: i64,
    pub task_number: u32,
    pub status: proto::TaskStatus,
    pub created_at_ms: i64,
    pub landed_at_ms: Option<i64>,
    pub review_id: u32,
    pub sessions_since_landed: u32,
}

const REVIEW_SELECT: &str = "SELECT r.id, r.workspace, r.routine_id, r.run_id, r.session_id, \
    r.status, r.run_dir, r.started_at_ms, r.ended_at_ms, r.window_since, r.window_until, \
    r.sessions, r.prompts, r.cost_usd, r.summary, r.error, \
    (SELECT COUNT(*) FROM harness_findings f WHERE f.review_id = r.id) \
    FROM harness_reviews r";

fn map_review(r: &rusqlite::Row) -> rusqlite::Result<HarnessReviewRow> {
    let id: u32 = r.get(0)?;
    let status_raw: String = r.get(5)?;
    let status = from_wire::<proto::HarnessReviewStatus>(&status_raw).ok_or_else(|| {
        rusqlite::Error::FromSqlConversionFailure(
            5,
            rusqlite::types::Type::Text,
            format!(
                "harness_reviews {id} has unknown status {status_raw:?} (expected running, \
                 published or failed)"
            )
            .into(),
        )
    })?;
    let since: Option<String> = r.get(9)?;
    let until: Option<String> = r.get(10)?;
    Ok(HarnessReviewRow {
        id,
        workspace: r.get(1)?,
        routine_id: r.get(2)?,
        run_id: r.get(3)?,
        session_id: r.get(4)?,
        status,
        run_dir: r.get(6)?,
        started_at_ms: r.get(7)?,
        ended_at_ms: r.get(8)?,
        window: since.zip(until),
        sessions: r.get(11)?,
        prompts: r.get(12)?,
        cost_usd: r.get(13)?,
        summary: r.get(14)?,
        error: r.get(15)?,
        finding_count: r.get(16)?,
    })
}

fn json_list(raw: &str) -> Vec<String> {
    serde_json::from_str(raw).unwrap_or_default()
}

impl Db {
    /// The workspace's harness routine, if its mapping names a routine that
    /// still exists.
    pub fn harness_routine_id(&self, workspace: &str) -> Result<Option<u32>> {
        let conn = self.conn.lock().expect("db lock");
        Ok(conn
            .query_row(
                "SELECT h.routine_id FROM harness_routines h \
                 JOIN routines r ON r.id = h.routine_id WHERE h.workspace = ?1",
                rusqlite::params![workspace],
                |r| r.get(0),
            )
            .optional()?)
    }

    pub fn harness_workspace_of_routine(&self, routine_id: u32) -> Result<Option<String>> {
        let conn = self.conn.lock().expect("db lock");
        Ok(conn
            .query_row(
                "SELECT workspace FROM harness_routines WHERE routine_id = ?1",
                rusqlite::params![routine_id],
                |r| r.get(0),
            )
            .optional()?)
    }

    pub fn harness_finding_exists(&self, workspace: &str, key: &str) -> Result<bool> {
        let conn = self.conn.lock().expect("db lock");
        Ok(conn.query_row(
            "SELECT EXISTS(
                 SELECT 1 FROM harness_findings f
                 JOIN harness_reviews r ON r.id = f.review_id
                 WHERE r.workspace = ?1 AND r.status = ?2 AND f.key = ?3
             )",
            rusqlite::params![
                workspace,
                wire_name(&proto::HarnessReviewStatus::Published)?,
                key
            ],
            |r| r.get(0),
        )?)
    }

    /// Replaces a mapping whose routine was deleted.
    pub fn set_harness_routine(&self, workspace: &str, routine_id: u32) -> Result<()> {
        let conn = self.conn.lock().expect("db lock");
        conn.execute(
            "INSERT INTO harness_routines (workspace, routine_id) VALUES (?1, ?2) \
             ON CONFLICT(workspace) DO UPDATE SET routine_id = excluded.routine_id",
            rusqlite::params![workspace, routine_id],
        )?;
        Ok(())
    }

    pub fn create_harness_review(
        &self,
        workspace: &str,
        routine_id: u32,
        run_id: u32,
        run_dir: &str,
        started_at_ms: i64,
    ) -> Result<u32> {
        let conn = self.conn.lock().expect("db lock");
        conn.execute(
            "INSERT INTO harness_reviews \
                (workspace, routine_id, run_id, status, run_dir, started_at_ms) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            rusqlite::params![
                workspace,
                routine_id,
                run_id,
                wire_name(&proto::HarnessReviewStatus::Running)?,
                run_dir,
                started_at_ms,
            ],
        )?;
        Ok(conn.last_insert_rowid() as u32)
    }

    pub fn set_harness_review_session(&self, run_id: u32, session_id: u32) -> Result<()> {
        let conn = self.conn.lock().expect("db lock");
        conn.execute(
            "UPDATE harness_reviews SET session_id = ?2 WHERE run_id = ?1",
            rusqlite::params![run_id, session_id],
        )?;
        Ok(())
    }

    pub fn harness_review(&self, id: u32) -> Result<Option<HarnessReviewRow>> {
        let conn = self.conn.lock().expect("db lock");
        Ok(conn
            .query_row(
                &format!("{REVIEW_SELECT} WHERE r.id = ?1"),
                rusqlite::params![id],
                map_review,
            )
            .optional()?)
    }

    pub fn harness_review_by_run(&self, run_id: u32) -> Result<Option<HarnessReviewRow>> {
        let conn = self.conn.lock().expect("db lock");
        Ok(conn
            .query_row(
                &format!("{REVIEW_SELECT} WHERE r.run_id = ?1"),
                rusqlite::params![run_id],
                map_review,
            )
            .optional()?)
    }

    pub fn list_harness_reviews(
        &self,
        workspace: &str,
        limit: u32,
    ) -> Result<Vec<HarnessReviewRow>> {
        let conn = self.conn.lock().expect("db lock");
        let mut stmt = conn.prepare(&format!(
            "{REVIEW_SELECT} WHERE r.workspace = ?1 ORDER BY r.id DESC LIMIT ?2"
        ))?;
        let rows = stmt
            .query_map(rusqlite::params![workspace, limit], map_review)?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    /// Records a publish in one transaction; a second publish of the same run
    /// replaces the first one's findings.
    pub fn publish_harness_review(
        &self,
        review_id: u32,
        p: &HarnessPublication<'_>,
        now_ms: i64,
    ) -> Result<()> {
        let mut conn = self.conn.lock().expect("db lock");
        let tx = conn.transaction()?;
        tx.execute(
            "UPDATE harness_reviews SET status = ?2, ended_at_ms = ?3, window_since = ?4, \
             window_until = ?5, sessions = ?6, prompts = ?7, cost_usd = ?8, summary = ?9, \
             error = NULL WHERE id = ?1",
            rusqlite::params![
                review_id,
                wire_name(&proto::HarnessReviewStatus::Published)?,
                now_ms,
                p.window.map(|w| w.0),
                p.window.map(|w| w.1),
                p.sessions,
                p.prompts,
                p.cost_usd,
                p.summary,
            ],
        )?;
        tx.execute(
            "DELETE FROM harness_findings WHERE review_id = ?1",
            rusqlite::params![review_id],
        )?;
        for f in p.findings {
            tx.execute(
                "INSERT INTO harness_findings (review_id, key, title, category, confidence, \
                 sessions, count, quotes, recommendation_kind, target, recommendation, \
                 apply_prompt) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
                rusqlite::params![
                    review_id,
                    f.key,
                    f.title,
                    f.category,
                    f.confidence,
                    serde_json::to_string(&f.sessions)?,
                    f.count,
                    serde_json::to_string(&f.quotes)?,
                    f.recommendation_kind,
                    f.target,
                    f.recommendation,
                    f.apply_prompt,
                ],
            )?;
        }
        tx.execute(
            "DELETE FROM harness_verifications WHERE review_id = ?1",
            rusqlite::params![review_id],
        )?;
        let workspace: String = tx.query_row(
            "SELECT workspace FROM harness_reviews WHERE id = ?1",
            rusqlite::params![review_id],
            |r| r.get(0),
        )?;
        for v in p.verifications {
            let verdict = wire_name(&v.verdict)?;
            tx.execute(
                "INSERT INTO harness_verifications \
                 (review_id, key, task_id, verdict, sessions_after, evidence) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                rusqlite::params![
                    review_id,
                    v.key,
                    v.task_id,
                    verdict,
                    v.sessions_after,
                    serde_json::to_string(&v.evidence)?,
                ],
            )?;
            match v.verdict {
                proto::HarnessVerdict::Gone => {
                    tx.execute(
                        "INSERT INTO harness_decisions \
                         (workspace, key, state, decided_at_ms, decided_by) \
                         VALUES (?1, ?2, 'resolved', ?3, ?4) \
                         ON CONFLICT(workspace, key) DO UPDATE SET state = excluded.state, \
                         decided_at_ms = excluded.decided_at_ms, decided_by = excluded.decided_by",
                        rusqlite::params![workspace, v.key, now_ms, format!("review:{review_id}")],
                    )?;
                }
                proto::HarnessVerdict::StillPresent => {
                    tx.execute(
                        "DELETE FROM harness_decisions WHERE workspace = ?1 AND key = ?2",
                        rusqlite::params![workspace, v.key],
                    )?;
                }
                proto::HarnessVerdict::Inconclusive => {}
            }
        }
        tx.commit()?;
        Ok(())
    }

    /// Marks a review that is still running as failed; a published one keeps
    /// its state. Returns whether the row changed.
    pub fn fail_harness_review(&self, run_id: u32, error: &str, now_ms: i64) -> Result<bool> {
        let conn = self.conn.lock().expect("db lock");
        let changed = conn.execute(
            "UPDATE harness_reviews SET status = ?2, error = ?3, ended_at_ms = ?4 \
             WHERE run_id = ?1 AND status = ?5",
            rusqlite::params![
                run_id,
                wire_name(&proto::HarnessReviewStatus::Failed)?,
                error,
                now_ms,
                wire_name(&proto::HarnessReviewStatus::Running)?,
            ],
        )?;
        Ok(changed > 0)
    }

    /// The newest published finding for each key, ordered by review.
    pub fn harness_findings(&self, workspace: &str) -> Result<Vec<HarnessFindingRow>> {
        let conn = self.conn.lock().expect("db lock");
        let mut stmt = conn.prepare(
            "SELECT f.review_id, r.ended_at_ms, f.key, f.title, f.category, f.confidence, \
             f.sessions, f.count, f.quotes, f.recommendation_kind, f.target, \
             f.recommendation, f.apply_prompt \
             FROM harness_findings f JOIN harness_reviews r ON r.id = f.review_id \
             WHERE r.workspace = ?1 AND r.status = ?2 \
               AND NOT EXISTS (
                   SELECT 1 FROM harness_findings newer \
                   JOIN harness_reviews newer_review ON newer_review.id = newer.review_id \
                   WHERE newer_review.workspace = r.workspace \
                     AND newer_review.status = ?2 AND newer.key = f.key \
                     AND newer_review.id > r.id
               ) \
             ORDER BY f.review_id DESC, f.rowid",
        )?;
        let rows = stmt
            .query_map(
                rusqlite::params![
                    workspace,
                    wire_name(&proto::HarnessReviewStatus::Published)?
                ],
                |r| {
                    Ok(HarnessFindingRow {
                        review_id: r.get(0)?,
                        review_ended_at_ms: r.get::<_, Option<i64>>(1)?.unwrap_or(0),
                        finding: HarnessFindingWrite {
                            key: r.get(2)?,
                            title: r.get(3)?,
                            category: r.get(4)?,
                            confidence: r.get(5)?,
                            sessions: json_list(&r.get::<_, String>(6)?),
                            count: r.get(7)?,
                            quotes: json_list(&r.get::<_, String>(8)?),
                            recommendation_kind: r.get(9)?,
                            target: r.get(10)?,
                            recommendation: r.get(11)?,
                            apply_prompt: r.get(12)?,
                        },
                    })
                },
            )?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    pub fn harness_decisions(&self, workspace: &str) -> Result<Vec<HarnessDecisionRow>> {
        let conn = self.conn.lock().expect("db lock");
        let mut stmt = conn.prepare(
            "SELECT key, state, decided_at_ms, decided_by FROM harness_decisions WHERE workspace = ?1 \
             ORDER BY key",
        )?;
        let rows = stmt
            .query_map(rusqlite::params![workspace], |r| {
                let key: String = r.get(0)?;
                let raw: String = r.get(1)?;
                let state = from_wire::<proto::HarnessFindingState>(&raw).ok_or_else(|| {
                    rusqlite::Error::FromSqlConversionFailure(
                        1,
                        rusqlite::types::Type::Text,
                        format!(
                            "harness decision {key:?} has unknown state {raw:?} (expected \
                             dismissed or resolved)"
                        )
                        .into(),
                    )
                })?;
                Ok(HarnessDecisionRow {
                    key,
                    state,
                    decided_at_ms: r.get(2)?,
                    decided_by: r.get(3)?,
                })
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    /// `Open` withdraws the decision.
    pub fn set_harness_decision(
        &self,
        workspace: &str,
        key: &str,
        state: proto::HarnessFindingState,
        now_ms: i64,
    ) -> Result<()> {
        self.set_harness_decision_by(workspace, key, state, now_ms, "user")
    }

    pub fn set_harness_decision_by(
        &self,
        workspace: &str,
        key: &str,
        state: proto::HarnessFindingState,
        now_ms: i64,
        decided_by: &str,
    ) -> Result<()> {
        let conn = self.conn.lock().expect("db lock");
        if state == proto::HarnessFindingState::Open {
            conn.execute(
                "DELETE FROM harness_decisions WHERE workspace = ?1 AND key = ?2",
                rusqlite::params![workspace, key],
            )?;
        } else {
            conn.execute(
                "INSERT INTO harness_decisions (workspace, key, state, decided_at_ms, decided_by) \
                 VALUES (?1, ?2, ?3, ?4, ?5) ON CONFLICT(workspace, key) DO UPDATE SET \
                 state = excluded.state, decided_at_ms = excluded.decided_at_ms, \
                 decided_by = excluded.decided_by",
                rusqlite::params![workspace, key, wire_name(&state)?, now_ms, decided_by],
            )?;
        }
        Ok(())
    }

    pub fn latest_published_harness_review(&self, workspace: &str) -> Result<Option<u32>> {
        let conn = self.conn.lock().expect("db lock");
        Ok(conn.query_row(
            "SELECT MAX(id) FROM harness_reviews WHERE workspace = ?1 AND status = 'published'",
            rusqlite::params![workspace],
            |r| r.get(0),
        )?)
    }

    pub fn harness_workspaces(&self) -> Result<Vec<String>> {
        let conn = self.conn.lock().expect("db lock");
        let mut stmt =
            conn.prepare("SELECT DISTINCT workspace FROM harness_reviews ORDER BY workspace")?;
        let rows = stmt
            .query_map([], |r| r.get(0))?
            .collect::<rusqlite::Result<_>>()?;
        Ok(rows)
    }

    pub fn harness_seen_review_id(&self, workspace: &str) -> Result<u32> {
        let key = format!("harness_seen:{workspace}");
        let conn = self.conn.lock().expect("db lock");
        let raw: Option<String> = conn
            .query_row("SELECT value FROM settings WHERE key = ?1", [key], |r| {
                r.get(0)
            })
            .optional()?;
        Ok(raw.and_then(|value| value.parse().ok()).unwrap_or(0))
    }

    pub fn advance_harness_seen_review_id(&self, workspace: &str, review_id: u32) -> Result<u32> {
        let key = format!("harness_seen:{workspace}");
        let conn = self.conn.lock().expect("db lock");
        conn.execute(
            "INSERT INTO settings (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE \
             SET value = CAST(MAX(CAST(settings.value AS INTEGER), CAST(excluded.value AS INTEGER)) AS TEXT)",
            rusqlite::params![key, review_id],
        )?;
        let value = conn.query_row("SELECT value FROM settings WHERE key = ?1", [key], |r| {
            r.get::<_, String>(0)
        })?;
        Ok(value.parse().unwrap_or(0))
    }

    pub fn harness_finding_tasks(
        &self,
        workspace: &str,
        key: &str,
    ) -> Result<Vec<HarnessFindingTaskRow>> {
        let conn = self.conn.lock().expect("db lock");
        let mut stmt = conn.prepare(
            "SELECT t.id, t.number, t.status, l.created_at_ms, l.review_id, \
             COALESCE((SELECT MAX(h.created_at) FROM backlog_task_history h \
                       WHERE h.task_id = t.id AND h.action = 'pr_merged'), \
                      CASE WHEN t.status = 'done' THEN t.updated_at END), \
             (SELECT COUNT(*) FROM sessions s WHERE \
                (t.status = 'done' OR EXISTS (SELECT 1 FROM backlog_task_history h \
                                              WHERE h.task_id = t.id AND h.action = 'pr_merged')) \
                AND s.created_at > COALESCE((SELECT MAX(h.created_at) FROM backlog_task_history h \
                                         WHERE h.task_id = t.id AND h.action = 'pr_merged'), t.updated_at) \
                AND s.agent IN ('claude', 'codex') \
                AND (s.project_dir = ?1 OR substr(s.project_dir, 1, length(?1) + 1) = ?1 || '/') \
                AND NOT EXISTS (SELECT 1 FROM backlog_task_runs tr \
                                WHERE tr.task_id = t.id AND tr.session_id = s.id) \
                AND NOT EXISTS (SELECT 1 FROM harness_reviews hr WHERE hr.session_id = s.id)) \
             FROM harness_finding_tasks l JOIN backlog_tasks t ON t.id = l.task_id \
             WHERE l.workspace = ?1 AND l.key = ?2 ORDER BY l.created_at_ms DESC",
        )?;
        let rows = stmt.query_map(rusqlite::params![workspace, key], |r| {
            let task_id: i64 = r.get(0)?;
            let status_raw: String = r.get(2)?;
            let status = from_wire::<proto::TaskStatus>(&status_raw).ok_or_else(|| {
                rusqlite::Error::FromSqlConversionFailure(
                    2,
                    rusqlite::types::Type::Text,
                    format!("task {task_id} has unknown status {status_raw:?} (expected TaskStatus)").into(),
                )
            })?;
            Ok(HarnessFindingTaskRow {
                task_id,
                task_number: r.get(1)?,
                status,
                created_at_ms: r.get(3)?,
                review_id: r.get(4)?,
                landed_at_ms: r.get(5)?,
                sessions_since_landed: r.get(6)?,
            })
        })?.collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }

    pub fn harness_task_origin(&self, task_id: i64) -> Result<Option<proto::TaskOrigin>> {
        let conn = self.conn.lock().expect("db lock");
        let row = conn
            .query_row(
                "SELECT workspace, key, review_id FROM harness_finding_tasks \
             WHERE task_id = ?1 ORDER BY created_at_ms LIMIT 1",
                rusqlite::params![task_id],
                |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, String>(1)?,
                        r.get::<_, u32>(2)?,
                    ))
                },
            )
            .optional()?;
        Ok(row.map(
            |(workspace, key, review_id)| proto::TaskOrigin::HarnessFinding {
                workspace,
                key,
                review_id,
            },
        ))
    }

    pub fn harness_task_origins(
        &self,
    ) -> Result<std::collections::HashMap<i64, proto::TaskOrigin>> {
        let conn = self.conn.lock().expect("db lock");
        let mut stmt = conn.prepare(
            "SELECT l.task_id, l.workspace, l.key, l.review_id FROM harness_finding_tasks l \
             WHERE l.created_at_ms = (SELECT MAX(newer.created_at_ms) \
               FROM harness_finding_tasks newer WHERE newer.task_id = l.task_id)",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok((
                r.get::<_, i64>(0)?,
                proto::TaskOrigin::HarnessFinding {
                    workspace: r.get(1)?,
                    key: r.get(2)?,
                    review_id: r.get(3)?,
                },
            ))
        })?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    pub fn latest_harness_verification(
        &self,
        workspace: &str,
        key: &str,
    ) -> Result<Option<HarnessVerificationRow>> {
        let conn = self.conn.lock().expect("db lock");
        let row = conn.query_row(
            "SELECT v.review_id, r.ended_at_ms, v.task_id, v.verdict, v.sessions_after, v.evidence \
             FROM harness_verifications v JOIN harness_reviews r ON r.id = v.review_id \
             WHERE r.workspace = ?1 AND v.key = ?2 ORDER BY v.review_id DESC LIMIT 1",
            rusqlite::params![workspace, key],
            |r| {
                let raw: String = r.get(3)?;
                let verdict = from_wire::<proto::HarnessVerdict>(&raw).ok_or_else(|| {
                    rusqlite::Error::FromSqlConversionFailure(3, rusqlite::types::Type::Text,
                        format!("verification has unknown verdict {raw:?} (expected gone, still_present or inconclusive)").into())
                })?;
                Ok(HarnessVerificationRow {
                    review_id: r.get(0)?,
                    review_ended_at_ms: r.get::<_, Option<i64>>(1)?.unwrap_or(0),
                    task_id: r.get(2)?, verdict,
                    sessions_after: r.get(4)?, evidence: json_list(&r.get::<_, String>(5)?),
                })
            },
        ).optional()?;
        Ok(row)
    }

    pub fn harness_unread_session_counts(
        &self,
        workspace: &str,
        since_ms: i64,
        until_ms: i64,
    ) -> Result<Vec<(proto::AgentKind, u32)>> {
        let conn = self.conn.lock().expect("db lock");
        let mut stmt = conn.prepare(
            "SELECT agent, COUNT(*) FROM sessions WHERE \
             (project_dir = ?1 OR substr(project_dir, 1, length(?1) + 1) = ?1 || '/') \
             AND created_at >= ?2 \
             AND created_at < ?3 AND agent IN ('opencode', 'cursor', 'grok', 'antigravity') \
             GROUP BY agent ORDER BY agent",
        )?;
        let rows = stmt.query_map(rusqlite::params![workspace, since_ms, until_ms], |r| {
            let raw: String = r.get(0)?;
            let agent = from_wire::<proto::AgentKind>(&raw).ok_or_else(|| {
                rusqlite::Error::FromSqlConversionFailure(
                    0,
                    rusqlite::types::Type::Text,
                    format!("sessions has unknown agent {raw:?} (expected AgentKind)").into(),
                )
            })?;
            Ok((agent, r.get(1)?))
        })?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }
}
