//! Questions an agent asks about a task that was not filed from Slack, answered
//! in the app, and the counts the factory caps compare against.
use anyhow::Result;
use rusqlite::{Connection, OptionalExtension};

use super::Db;

pub(super) fn migrate(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS backlog_task_questions (
            id           INTEGER PRIMARY KEY,
            task_id      INTEGER NOT NULL,
            run_id       INTEGER NOT NULL,
            session_id   INTEGER NOT NULL,
            form         TEXT    NOT NULL,
            answer       TEXT,
            created_at   INTEGER NOT NULL,
            answered_at  INTEGER,
            delivered_at INTEGER
        );
        CREATE INDEX IF NOT EXISTS idx_backlog_task_questions_task
            ON backlog_task_questions(task_id, id);",
    )?;
    Ok(())
}

pub struct TaskQuestionRow {
    pub id: i64,
    pub task_id: i64,
    pub run_id: i64,
    pub session_id: u32,
    /// A `QuestionForm` as JSON.
    pub form: String,
    pub answer: Option<String>,
    pub created_at_ms: i64,
}

/// A run's pull request number and URL.
pub type TaskPr = (Option<u32>, Option<String>);

const QUESTION_COLUMNS: &str = "id, task_id, run_id, session_id, form, answer, created_at";

/// A question counts only while the run that asked it is open.
const OPEN_QUESTION_RUN: &str = "EXISTS (SELECT 1 FROM backlog_task_runs r \
     WHERE r.id = q.run_id AND r.state IN ('preparing', 'running', 'waiting_for_input', 'validating'))";

fn question_row(r: &rusqlite::Row) -> rusqlite::Result<TaskQuestionRow> {
    Ok(TaskQuestionRow {
        id: r.get(0)?,
        task_id: r.get(1)?,
        run_id: r.get(2)?,
        session_id: r.get(3)?,
        form: r.get(4)?,
        answer: r.get(5)?,
        created_at_ms: r.get(6)?,
    })
}

impl Db {
    /// Records a handback's proof on its run; a field the handback omits keeps
    /// what an earlier handback of the run stored.
    pub fn task_run_set_proof(
        &self,
        run_id: i64,
        pr_number: Option<u32>,
        pr_url: Option<&str>,
        pushed_sha: Option<&str>,
        evidence: &str,
    ) -> Result<()> {
        let conn = self.conn.lock().expect("db lock");
        conn.execute(
            "UPDATE backlog_task_runs SET pr_number = coalesce(?2, pr_number), \
             pr_url = coalesce(?3, pr_url), pushed_sha = coalesce(?4, pushed_sha), evidence = ?5 \
             WHERE id = ?1",
            rusqlite::params![run_id, pr_number, pr_url, pushed_sha, evidence],
        )?;
        Ok(())
    }

    pub fn task_question_insert(
        &self,
        task_id: i64,
        run_id: i64,
        session_id: u32,
        form: &str,
        now_ms: i64,
    ) -> Result<i64> {
        let conn = self.conn.lock().expect("db lock");
        conn.execute(
            "INSERT INTO backlog_task_questions (task_id, run_id, session_id, form, created_at) \
             VALUES (?1, ?2, ?3, ?4, ?5)",
            rusqlite::params![task_id, run_id, session_id, form, now_ms],
        )?;
        Ok(conn.last_insert_rowid())
    }

    pub fn task_question(&self, id: i64) -> Result<Option<TaskQuestionRow>> {
        let conn = self.conn.lock().expect("db lock");
        Ok(conn
            .query_row(
                &format!("SELECT {QUESTION_COLUMNS} FROM backlog_task_questions WHERE id = ?1"),
                [id],
                question_row,
            )
            .optional()?)
    }

    /// Every unanswered question whose run is still open, newest per task
    /// last; a question outlives its run only as history.
    pub fn task_open_questions(&self) -> Result<Vec<TaskQuestionRow>> {
        let conn = self.conn.lock().expect("db lock");
        let mut stmt = conn.prepare(&format!(
            "SELECT {QUESTION_COLUMNS} FROM backlog_task_questions q \
             WHERE answer IS NULL AND {OPEN_QUESTION_RUN} ORDER BY id"
        ))?;
        let rows = stmt
            .query_map([], question_row)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }

    /// `Ok(false)` when the question already had an answer (the first wins) or
    /// its run has ended.
    pub fn task_question_answer(&self, id: i64, answer: &str, now_ms: i64) -> Result<bool> {
        let conn = self.conn.lock().expect("db lock");
        Ok(conn.execute(
            &format!(
                "UPDATE backlog_task_questions AS q SET answer = ?2, answered_at = ?3 \
                 WHERE id = ?1 AND answer IS NULL AND {OPEN_QUESTION_RUN}"
            ),
            rusqlite::params![id, answer, now_ms],
        )? > 0)
    }

    /// Answered questions not yet typed into their pane.
    pub fn task_questions_undelivered(&self) -> Result<Vec<TaskQuestionRow>> {
        let conn = self.conn.lock().expect("db lock");
        let mut stmt = conn.prepare(&format!(
            "SELECT {QUESTION_COLUMNS} FROM backlog_task_questions q \
             WHERE answer IS NOT NULL AND delivered_at IS NULL AND {OPEN_QUESTION_RUN} ORDER BY id"
        ))?;
        let rows = stmt
            .query_map([], question_row)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }

    pub fn task_question_delivered(&self, id: i64, now_ms: i64) -> Result<()> {
        let conn = self.conn.lock().expect("db lock");
        conn.execute(
            "UPDATE backlog_task_questions SET delivered_at = ?2 WHERE id = ?1",
            rusqlite::params![id, now_ms],
        )?;
        Ok(())
    }

    /// Each task's newest run that recorded a pull request.
    pub fn task_latest_prs(&self) -> Result<std::collections::HashMap<i64, TaskPr>> {
        let conn = self.conn.lock().expect("db lock");
        let mut stmt = conn.prepare(
            "SELECT task_id, pr_number, pr_url FROM backlog_task_runs \
             WHERE pr_number IS NOT NULL OR pr_url IS NOT NULL ORDER BY id",
        )?;
        let rows = stmt
            .query_map([], |r| Ok((r.get(0)?, (r.get(1)?, r.get(2)?))))?
            .collect::<rusqlite::Result<Vec<(i64, TaskPr)>>>()?;
        Ok(rows.into_iter().collect())
    }

    /// Live implementation runs across every workspace: the number the global
    /// live-run cap compares against.
    pub fn factory_live_runs(&self) -> Result<u32> {
        let conn = self.conn.lock().expect("db lock");
        Ok(conn.query_row(
            &format!(
                "SELECT COUNT(*) FROM backlog_task_runs WHERE kind = 'implementation' \
                 AND state IN ({})",
                super::tasks::OPEN_RUN_STATES
            ),
            [],
            |r| r.get(0),
        )?)
    }

    /// Tasks waiting on a person: in review, waiting for input, or with an open
    /// question. `except` leaves out the task a start would clear.
    pub fn factory_needs_you(&self, except: Option<i64>) -> Result<u32> {
        let conn = self.conn.lock().expect("db lock");
        Ok(conn.query_row(
            "SELECT COUNT(*) FROM backlog_tasks t WHERE t.archived_at IS NULL \
             AND t.id IS NOT ?1 AND (
                t.status = 'in_review'
                OR EXISTS (SELECT 1 FROM backlog_task_runs r WHERE r.task_id = t.id
                    AND r.kind = 'implementation' AND r.state = 'waiting_for_input')
                OR EXISTS (SELECT 1 FROM backlog_task_questions q
                    JOIN backlog_task_runs qr ON qr.id = q.run_id
                    WHERE q.task_id = t.id AND q.answer IS NULL
                    AND qr.state IN ('preparing', 'running', 'waiting_for_input', 'validating'))
                OR EXISTS (SELECT 1 FROM intake_questions iq JOIN intake_events e
                    ON e.id = iq.intake_id JOIN backlog_task_runs ir ON ir.id = iq.run_id
                    WHERE e.task_id = t.id AND iq.answer IS NULL
                    AND ir.state IN ('preparing', 'running', 'waiting_for_input', 'validating')))",
            [except],
            |r| r.get(0),
        )?)
    }
}
