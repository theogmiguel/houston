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
            PRIMARY KEY (workspace, key)
        );",
    )?;
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
}

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
            "SELECT key, state, decided_at_ms FROM harness_decisions WHERE workspace = ?1 \
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
        let conn = self.conn.lock().expect("db lock");
        if state == proto::HarnessFindingState::Open {
            conn.execute(
                "DELETE FROM harness_decisions WHERE workspace = ?1 AND key = ?2",
                rusqlite::params![workspace, key],
            )?;
        } else {
            conn.execute(
                "INSERT INTO harness_decisions (workspace, key, state, decided_at_ms) \
                 VALUES (?1, ?2, ?3, ?4) ON CONFLICT(workspace, key) DO UPDATE SET \
                 state = excluded.state, decided_at_ms = excluded.decided_at_ms",
                rusqlite::params![workspace, key, wire_name(&state)?, now_ms],
            )?;
        }
        Ok(())
    }
}
