//! Requests that arrived from outside (a Slack mention), the questions their
//! runs asked back, and the replies Houston owes the request's thread. The
//! outbox makes a reply at-least-once: a row is sent until Slack accepts it.
use anyhow::Result;
use rusqlite::{Connection, OptionalExtension};

use super::Db;

pub(super) fn migrate(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS intake_events (
            id          INTEGER PRIMARY KEY,
            source      TEXT    NOT NULL,
            external_id TEXT    NOT NULL,
            channel     TEXT    NOT NULL,
            ts          TEXT    NOT NULL,
            author      TEXT    NOT NULL,
            workspace   TEXT    NOT NULL,
            task_id     INTEGER,
            state       TEXT    NOT NULL,
            permalink   TEXT,
            queued_at   INTEGER,
            created_at  INTEGER NOT NULL,
            UNIQUE(source, external_id)
        );
        CREATE INDEX IF NOT EXISTS idx_intake_events_task ON intake_events(task_id);
        CREATE TABLE IF NOT EXISTS intake_questions (
            id           INTEGER PRIMARY KEY,
            intake_id    INTEGER NOT NULL,
            run_id       INTEGER NOT NULL,
            session_id   INTEGER NOT NULL,
            question     TEXT    NOT NULL,
            answer       TEXT,
            answered_by  TEXT,
            answer_ts    TEXT,
            created_at   INTEGER NOT NULL,
            answered_at  INTEGER,
            delivered_at INTEGER
        );
        CREATE INDEX IF NOT EXISTS idx_intake_questions_intake ON intake_questions(intake_id, id);
        CREATE TABLE IF NOT EXISTS intake_outbox (
            id         INTEGER PRIMARY KEY,
            intake_id  INTEGER NOT NULL,
            dedupe_key TEXT    NOT NULL UNIQUE,
            text       TEXT    NOT NULL,
            reaction   TEXT,
            posted_ts  TEXT,
            attempts   INTEGER NOT NULL DEFAULT 0,
            last_error TEXT,
            created_at INTEGER NOT NULL,
            sent_at    INTEGER
        );",
    )?;
    Ok(())
}

/// `pending` waits for the owner, `queued` was accepted while the working cap
/// was full, `started` has a run, `refused` names why in its first reply.
pub const STATE_PENDING: &str = "pending";
pub const STATE_QUEUED: &str = "queued";
pub const STATE_STARTED: &str = "started";
pub const STATE_REFUSED: &str = "refused";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IntakeRow {
    pub id: i64,
    pub source: String,
    pub channel: String,
    pub ts: String,
    pub author: String,
    pub workspace: String,
    pub task_id: Option<i64>,
    pub state: String,
    pub permalink: Option<String>,
    pub queued_at_ms: Option<i64>,
    pub created_at_ms: i64,
}

const INTAKE_COLUMNS: &str =
    "id, source, channel, ts, author, workspace, task_id, state, permalink, queued_at, created_at";

fn intake_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<IntakeRow> {
    Ok(IntakeRow {
        id: r.get(0)?,
        source: r.get(1)?,
        channel: r.get(2)?,
        ts: r.get(3)?,
        author: r.get(4)?,
        workspace: r.get(5)?,
        task_id: r.get(6)?,
        state: r.get(7)?,
        permalink: r.get(8)?,
        queued_at_ms: r.get(9)?,
        created_at_ms: r.get(10)?,
    })
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct QuestionRow {
    pub id: i64,
    pub intake_id: i64,
    pub run_id: i64,
    pub session_id: u32,
    pub question: String,
    pub answer: Option<String>,
    pub answered_by: Option<String>,
    pub created_at_ms: i64,
}

const QUESTION_COLUMNS: &str =
    "id, intake_id, run_id, session_id, question, answer, answered_by, created_at";

fn question_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<QuestionRow> {
    Ok(QuestionRow {
        id: r.get(0)?,
        intake_id: r.get(1)?,
        run_id: r.get(2)?,
        session_id: r.get(3)?,
        question: r.get(4)?,
        answer: r.get(5)?,
        answered_by: r.get(6)?,
        created_at_ms: r.get(7)?,
    })
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OutboxRow {
    pub id: i64,
    pub intake_id: i64,
    pub text: String,
    pub reaction: Option<String>,
    pub attempts: u32,
}

pub struct IntakeWrite<'a> {
    pub source: &'a str,
    pub channel: &'a str,
    pub ts: &'a str,
    pub author: &'a str,
    pub workspace: &'a str,
    pub state: &'a str,
    pub now_ms: i64,
}

impl Db {
    /// `Ok(None)` when the same message was already recorded: Slack redelivers
    /// and the reconnect catch-up replays, so a duplicate is ordinary.
    pub fn intake_insert(&self, w: &IntakeWrite<'_>) -> Result<Option<IntakeRow>> {
        let conn = self.conn.lock().expect("db lock");
        let external_id = format!("{}:{}", w.channel, w.ts);
        let inserted = conn.execute(
            "INSERT OR IGNORE INTO intake_events \
                (source, external_id, channel, ts, author, workspace, state, created_at) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            rusqlite::params![
                w.source,
                external_id,
                w.channel,
                w.ts,
                w.author,
                w.workspace,
                w.state,
                w.now_ms
            ],
        )?;
        if inserted == 0 {
            return Ok(None);
        }
        let id = conn.last_insert_rowid();
        Ok(Some(conn.query_row(
            &format!("SELECT {INTAKE_COLUMNS} FROM intake_events WHERE id = ?1"),
            [id],
            intake_row,
        )?))
    }

    pub fn intake(&self, id: i64) -> Result<Option<IntakeRow>> {
        let conn = self.conn.lock().expect("db lock");
        Ok(conn
            .query_row(
                &format!("SELECT {INTAKE_COLUMNS} FROM intake_events WHERE id = ?1"),
                [id],
                intake_row,
            )
            .optional()?)
    }

    pub fn intake_by_message(
        &self,
        source: &str,
        channel: &str,
        ts: &str,
    ) -> Result<Option<IntakeRow>> {
        let conn = self.conn.lock().expect("db lock");
        Ok(conn
            .query_row(
                &format!("SELECT {INTAKE_COLUMNS} FROM intake_events WHERE source = ?1 AND external_id = ?2"),
                rusqlite::params![source, format!("{channel}:{ts}")],
                intake_row,
            )
            .optional()?)
    }

    pub fn intake_for_task(&self, task_id: i64) -> Result<Option<IntakeRow>> {
        let conn = self.conn.lock().expect("db lock");
        Ok(conn
            .query_row(
                &format!("SELECT {INTAKE_COLUMNS} FROM intake_events WHERE task_id = ?1 ORDER BY id DESC LIMIT 1"),
                [task_id],
                intake_row,
            )
            .optional()?)
    }

    pub fn intake_set_task(&self, id: i64, task_id: i64, permalink: Option<&str>) -> Result<()> {
        let conn = self.conn.lock().expect("db lock");
        conn.execute(
            "UPDATE intake_events SET task_id = ?2, permalink = ?3 WHERE id = ?1",
            rusqlite::params![id, task_id, permalink],
        )?;
        Ok(())
    }

    /// Moves a request between states; `queued_at` is stamped on entering the
    /// queue and kept, so the queue is first accepted, first started.
    pub fn intake_set_state(&self, id: i64, state: &str, now_ms: i64) -> Result<()> {
        let conn = self.conn.lock().expect("db lock");
        conn.execute(
            "UPDATE intake_events SET state = ?2, \
               queued_at = CASE WHEN ?2 = 'queued' THEN COALESCE(queued_at, ?3) ELSE queued_at END \
             WHERE id = ?1",
            rusqlite::params![id, state, now_ms],
        )?;
        Ok(())
    }

    /// Accepted requests waiting for a working slot, oldest acceptance first.
    pub fn intake_queue(&self) -> Result<Vec<IntakeRow>> {
        let conn = self.conn.lock().expect("db lock");
        let mut stmt = conn.prepare(&format!(
            "SELECT {INTAKE_COLUMNS} FROM intake_events WHERE state = 'queued' ORDER BY queued_at, id"
        ))?;
        let rows = stmt
            .query_map([], intake_row)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }

    /// Every request with a task, for the task list's origin and queue column.
    pub fn intake_by_task(&self) -> Result<Vec<IntakeRow>> {
        let conn = self.conn.lock().expect("db lock");
        let mut stmt = conn.prepare(&format!(
            "SELECT {INTAKE_COLUMNS} FROM intake_events WHERE task_id IS NOT NULL ORDER BY id"
        ))?;
        let rows = stmt
            .query_map([], intake_row)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }

    pub fn intake_question_insert(
        &self,
        intake_id: i64,
        run_id: i64,
        session_id: u32,
        question: &str,
        now_ms: i64,
    ) -> Result<i64> {
        let conn = self.conn.lock().expect("db lock");
        conn.execute(
            "INSERT INTO intake_questions (intake_id, run_id, session_id, question, created_at) \
             VALUES (?1, ?2, ?3, ?4, ?5)",
            rusqlite::params![intake_id, run_id, session_id, question, now_ms],
        )?;
        Ok(conn.last_insert_rowid())
    }

    /// The question of `intake_id` still waiting for an answer, if any.
    pub fn intake_open_question(&self, intake_id: i64) -> Result<Option<QuestionRow>> {
        let conn = self.conn.lock().expect("db lock");
        Ok(conn
            .query_row(
                &format!(
                    "SELECT {QUESTION_COLUMNS} FROM intake_questions \
                     WHERE intake_id = ?1 AND answer IS NULL ORDER BY id DESC LIMIT 1"
                ),
                [intake_id],
                question_row,
            )
            .optional()?)
    }

    /// `Ok(false)` when the question already had an answer: the first eligible
    /// reply wins, later ones are ignored.
    pub fn intake_answer(
        &self,
        question_id: i64,
        answer: &str,
        by: &str,
        answer_ts: &str,
        now_ms: i64,
    ) -> Result<bool> {
        let conn = self.conn.lock().expect("db lock");
        Ok(conn.execute(
            "UPDATE intake_questions SET answer = ?2, answered_by = ?3, answer_ts = ?4, answered_at = ?5 \
             WHERE id = ?1 AND answer IS NULL",
            rusqlite::params![question_id, answer, by, answer_ts, now_ms],
        )? > 0)
    }

    /// Answered questions not yet typed into their pane.
    pub fn intake_undelivered_answers(&self) -> Result<Vec<QuestionRow>> {
        let conn = self.conn.lock().expect("db lock");
        let mut stmt = conn.prepare(&format!(
            "SELECT {QUESTION_COLUMNS} FROM intake_questions \
             WHERE answer IS NOT NULL AND delivered_at IS NULL ORDER BY id"
        ))?;
        let rows = stmt
            .query_map([], question_row)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }

    pub fn intake_mark_delivered(&self, question_id: i64, now_ms: i64) -> Result<()> {
        let conn = self.conn.lock().expect("db lock");
        conn.execute(
            "UPDATE intake_questions SET delivered_at = ?2 WHERE id = ?1",
            rusqlite::params![question_id, now_ms],
        )?;
        Ok(())
    }

    /// Runs whose newest question is unanswered: they wait on a person, so the
    /// working cap does not count them.
    pub fn intake_runs_waiting_for_answer(&self) -> Result<Vec<i64>> {
        let conn = self.conn.lock().expect("db lock");
        let mut stmt =
            conn.prepare("SELECT DISTINCT run_id FROM intake_questions WHERE answer IS NULL")?;
        let rows = stmt
            .query_map([], |r| r.get(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }

    /// `Ok(false)` when a reply with this key was already queued, so a replayed
    /// event or a repeated transition never posts twice.
    pub fn intake_outbox_push(
        &self,
        intake_id: i64,
        key: &str,
        text: &str,
        reaction: Option<&str>,
        now_ms: i64,
    ) -> Result<bool> {
        let conn = self.conn.lock().expect("db lock");
        Ok(conn.execute(
            "INSERT OR IGNORE INTO intake_outbox (intake_id, dedupe_key, text, reaction, created_at) \
             VALUES (?1, ?2, ?3, ?4, ?5)",
            rusqlite::params![intake_id, key, text, reaction, now_ms],
        )? > 0)
    }

    pub fn intake_outbox_pending(&self, limit: u32) -> Result<Vec<OutboxRow>> {
        let conn = self.conn.lock().expect("db lock");
        let mut stmt = conn.prepare(
            "SELECT id, intake_id, text, reaction, attempts FROM intake_outbox \
             WHERE sent_at IS NULL ORDER BY id LIMIT ?1",
        )?;
        let rows = stmt
            .query_map([limit], |r| {
                Ok(OutboxRow {
                    id: r.get(0)?,
                    intake_id: r.get(1)?,
                    text: r.get(2)?,
                    reaction: r.get(3)?,
                    attempts: r.get(4)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }

    pub fn intake_outbox_sent(&self, id: i64, posted_ts: Option<&str>, now_ms: i64) -> Result<()> {
        let conn = self.conn.lock().expect("db lock");
        conn.execute(
            "UPDATE intake_outbox SET sent_at = ?2, posted_ts = ?3, last_error = NULL WHERE id = ?1",
            rusqlite::params![id, now_ms, posted_ts],
        )?;
        Ok(())
    }

    pub fn intake_outbox_failed(&self, id: i64, error: &str) -> Result<()> {
        let conn = self.conn.lock().expect("db lock");
        conn.execute(
            "UPDATE intake_outbox SET attempts = attempts + 1, last_error = ?2 WHERE id = ?1",
            rusqlite::params![id, error],
        )?;
        Ok(())
    }

    pub fn intake_outbox_has(&self, key: &str) -> Result<bool> {
        let conn = self.conn.lock().expect("db lock");
        Ok(conn
            .query_row(
                "SELECT 1 FROM intake_outbox WHERE dedupe_key = ?1",
                [key],
                |_| Ok(()),
            )
            .optional()?
            .is_some())
    }

    /// The `ts` of a question's thread post, so a reply can be matched to it.
    pub fn intake_outbox_posted_ts(&self, key: &str) -> Result<Option<String>> {
        let conn = self.conn.lock().expect("db lock");
        Ok(conn
            .query_row(
                "SELECT posted_ts FROM intake_outbox WHERE dedupe_key = ?1",
                [key],
                |r| r.get(0),
            )
            .optional()?
            .flatten())
    }

    pub fn task_run_set_pr_url(&self, run_id: i64, pr_url: Option<&str>) -> Result<()> {
        let conn = self.conn.lock().expect("db lock");
        conn.execute(
            "UPDATE backlog_task_runs SET pr_url = ?2 WHERE id = ?1",
            rusqlite::params![run_id, pr_url],
        )?;
        Ok(())
    }
}
