//! The review-request queue: one row per pull request head, with the triage
//! reasons and the operator's state. A new head is a new row, so a re-push is
//! triaged again without erasing the previous request.

use anyhow::Result;
use houston_protocol as proto;
use rusqlite::{OptionalExtension, Row};

use super::{from_wire, wire_name, Db};

pub(super) fn migrate(conn: &rusqlite::Connection) -> Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS review_requests (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            host TEXT NOT NULL,
            repo TEXT NOT NULL,
            number INTEGER NOT NULL,
            head_sha TEXT NOT NULL,
            title TEXT NOT NULL,
            author TEXT NOT NULL,
            url TEXT NOT NULL,
            tier TEXT NOT NULL,
            reasons TEXT NOT NULL,
            state TEXT NOT NULL,
            workspace TEXT,
            provider TEXT,
            session_id INTEGER,
            first_seen_ms INTEGER NOT NULL,
            last_seen_ms INTEGER NOT NULL,
            absorbed INTEGER NOT NULL DEFAULT 0,
            source_updated_at TEXT,
            UNIQUE(host, repo, number, head_sha)
        );
        CREATE INDEX IF NOT EXISTS idx_review_requests_seen
            ON review_requests(first_seen_ms DESC, id DESC);",
    )?;
    super::add_column_if_missing(
        conn,
        "review_requests",
        "absorbed",
        "absorbed INTEGER NOT NULL DEFAULT 0",
    )?;
    super::add_column_if_missing(
        conn,
        "review_requests",
        "source_updated_at",
        "source_updated_at TEXT",
    )?;
    Ok(())
}

#[derive(Debug, Clone)]
pub struct ReviewRequestRow {
    pub id: i64,
    pub host: String,
    pub repo: String,
    pub number: u32,
    pub head_sha: String,
    pub title: String,
    pub author: String,
    pub url: String,
    pub tier: proto::ReviewTier,
    pub reasons: Vec<String>,
    pub state: proto::ReviewRequestState,
    pub workspace: Option<String>,
    pub provider: Option<proto::AgentKind>,
    pub session_id: Option<u32>,
    /// Recorded by the first poll after the mode was enabled: visible in the
    /// queue, never reviewed or notified about.
    pub absorbed: bool,
    /// The forge's own `updatedAt` for the pull request when its head was last
    /// resolved; an unchanged value skips the per-request `gh pr view`.
    pub source_updated_at: Option<String>,
    pub first_seen_ms: i64,
    pub last_seen_ms: i64,
}

pub struct ReviewRequestWrite<'a> {
    pub host: &'a str,
    pub repo: &'a str,
    pub number: u32,
    pub head_sha: &'a str,
    pub title: &'a str,
    pub author: &'a str,
    pub url: &'a str,
    pub tier: proto::ReviewTier,
    pub reasons: &'a [String],
    pub workspace: Option<&'a str>,
    pub provider: Option<proto::AgentKind>,
    pub absorbed: bool,
    pub updated_at: &'a str,
}

const SELECT: &str = "SELECT id, host, repo, number, head_sha, title, author, url, tier, reasons, \
    state, workspace, provider, session_id, first_seen_ms, last_seen_ms, absorbed, \
    source_updated_at FROM review_requests";

fn map(row: &Row<'_>) -> rusqlite::Result<ReviewRequestRow> {
    let id: i64 = row.get(0)?;
    let tier_raw: String = row.get(8)?;
    let reasons: String = row.get(9)?;
    let state_raw: String = row.get(10)?;
    let provider_raw: Option<String> = row.get(12)?;
    let tier = from_wire::<proto::ReviewTier>(&tier_raw).ok_or_else(|| {
        rusqlite::Error::FromSqlConversionFailure(
            0,
            rusqlite::types::Type::Text,
            format!("review_requests {id} has unknown tier {tier_raw:?} (expected a, b or c)")
                .into(),
        )
    })?;
    let state = from_wire::<proto::ReviewRequestState>(&state_raw).ok_or_else(|| {
        rusqlite::Error::FromSqlConversionFailure(
            0,
            rusqlite::types::Type::Text,
            format!(
                "review_requests {id} has unknown state {state_raw:?} (expected new, reviewing, \
                 reviewed or dismissed)"
            )
            .into(),
        )
    })?;
    let provider = provider_raw
        .map(|raw| {
            from_wire::<proto::AgentKind>(&raw).ok_or_else(|| {
                rusqlite::Error::FromSqlConversionFailure(
                    0,
                    rusqlite::types::Type::Text,
                    format!(
                        "review_requests {id} has unknown provider {raw:?} (expected an AgentKind)"
                    )
                    .into(),
                )
            })
        })
        .transpose()?;
    Ok(ReviewRequestRow {
        id,
        host: row.get(1)?,
        repo: row.get(2)?,
        number: row.get(3)?,
        head_sha: row.get(4)?,
        title: row.get(5)?,
        author: row.get(6)?,
        url: row.get(7)?,
        tier,
        reasons: serde_json::from_str(&reasons).unwrap_or_default(),
        state,
        workspace: row.get(11)?,
        provider,
        session_id: row.get(13)?,
        first_seen_ms: row.get(14)?,
        last_seen_ms: row.get(15)?,
        absorbed: row.get(16)?,
        source_updated_at: row.get(17)?,
    })
}

impl Db {
    /// Records one head. Returns the row and whether this call inserted it, so
    /// a first-run absorb can stay silent while a new request notifies.
    pub fn review_request_seen(
        &self,
        write: &ReviewRequestWrite<'_>,
        now_ms: i64,
    ) -> Result<(ReviewRequestRow, bool)> {
        let reasons = serde_json::to_string(write.reasons)?;
        let provider = write.provider.map(|p| wire_name(&p)).transpose()?;
        let conn = self.conn.lock().expect("db lock");
        let inserted = conn.execute(
            "INSERT OR IGNORE INTO review_requests
                (host, repo, number, head_sha, title, author, url, tier, reasons, state,
                 workspace, provider, session_id, first_seen_ms, last_seen_ms, absorbed,
                 source_updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 'new', ?10, ?11, NULL, ?12, ?12, ?13,
                     ?14)",
            rusqlite::params![
                write.host,
                write.repo,
                write.number,
                write.head_sha,
                write.title,
                write.author,
                write.url,
                wire_name(&write.tier)?,
                reasons,
                write.workspace,
                provider,
                now_ms,
                write.absorbed,
                write.updated_at,
            ],
        )? == 1;
        conn.execute(
            "UPDATE review_requests SET last_seen_ms = ?5, title = ?6, author = ?7, url = ?8, \
                 source_updated_at = ?9
             WHERE host = ?1 AND repo = ?2 AND number = ?3 AND head_sha = ?4",
            rusqlite::params![
                write.host,
                write.repo,
                write.number,
                write.head_sha,
                now_ms,
                write.title,
                write.author,
                write.url,
                write.updated_at,
            ],
        )?;
        let row = conn.query_row(
            &format!("{SELECT} WHERE host = ?1 AND repo = ?2 AND number = ?3 AND head_sha = ?4"),
            rusqlite::params![write.host, write.repo, write.number, write.head_sha],
            map,
        )?;
        Ok((row, inserted))
    }

    pub fn review_request_exists(
        &self,
        host: &str,
        repo: &str,
        number: u32,
        head_sha: &str,
    ) -> Result<bool> {
        let conn = self.conn.lock().expect("db lock");
        Ok(conn.query_row(
            "SELECT EXISTS (SELECT 1 FROM review_requests
             WHERE host = ?1 AND repo = ?2 AND number = ?3 AND head_sha = ?4)",
            rusqlite::params![host, repo, number, head_sha],
            |row| row.get(0),
        )?)
    }

    /// The newest head this pull request was resolved at, and the forge
    /// `updatedAt` that read saw. Equal `updatedAt` means nothing changed.
    pub fn review_request_latest_head(
        &self,
        host: &str,
        repo: &str,
        number: u32,
    ) -> Result<Option<(String, Option<String>)>> {
        let conn = self.conn.lock().expect("db lock");
        Ok(conn
            .query_row(
                "SELECT head_sha, source_updated_at FROM review_requests
                 WHERE host = ?1 AND repo = ?2 AND number = ?3
                 ORDER BY first_seen_ms DESC, id DESC LIMIT 1",
                rusqlite::params![host, repo, number],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?)
    }

    /// Records the forge timestamp for a pull request already in the queue, so
    /// a tick that learned nothing new makes no per-request read. The timestamp
    /// belongs to the pull request, not one head, so every row carries it.
    #[allow(clippy::too_many_arguments)]
    pub fn review_request_touch(
        &self,
        host: &str,
        repo: &str,
        number: u32,
        title: &str,
        author: &str,
        url: &str,
        updated_at: &str,
        now_ms: i64,
    ) -> Result<()> {
        let conn = self.conn.lock().expect("db lock");
        conn.execute(
            "UPDATE review_requests SET source_updated_at = ?4, last_seen_ms = ?5, title = ?6, \
                 author = ?7, url = ?8
             WHERE host = ?1 AND repo = ?2 AND number = ?3",
            rusqlite::params![host, repo, number, updated_at, now_ms, title, author, url],
        )?;
        Ok(())
    }

    pub fn review_requests(&self, limit: u32) -> Result<Vec<ReviewRequestRow>> {
        let conn = self.conn.lock().expect("db lock");
        let mut stmt = conn.prepare(&format!(
            "{SELECT} ORDER BY first_seen_ms DESC, id DESC LIMIT ?1"
        ))?;
        let rows = stmt
            .query_map([limit], map)?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    pub fn review_request(&self, id: i64) -> Result<Option<ReviewRequestRow>> {
        let conn = self.conn.lock().expect("db lock");
        Ok(conn
            .query_row(&format!("{SELECT} WHERE id = ?1"), [id], map)
            .optional()?)
    }

    pub fn review_request_set_state(
        &self,
        id: i64,
        state: proto::ReviewRequestState,
        session_id: Option<u32>,
    ) -> Result<bool> {
        let conn = self.conn.lock().expect("db lock");
        Ok(conn.execute(
            "UPDATE review_requests SET state = ?2, session_id = ?3 WHERE id = ?1",
            rusqlite::params![id, wire_name(&state)?, session_id],
        )? > 0)
    }
}
