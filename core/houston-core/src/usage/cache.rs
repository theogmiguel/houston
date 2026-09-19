use std::path::{Path, PathBuf};

use houston_protocol as proto;
use rusqlite::Connection;

use super::transcripts::UsageRecord;

/// Bumped whenever a parser change alters what a given file parses to. Getting
/// this wrong is silent and permanent: stale rows keep serving the old reading
/// of a file that will never change again. Stored in `PRAGMA user_version`.
pub const SCAN_CACHE_VERSION: u32 = 2;

/// Rows for a file older than this are dropped on prune: `USAGE_MAX_WINDOW_DAYS`
/// is the widest window the wire accepts, so such a transcript is unreachable
/// and its rows are pure growth.
fn retention_ms() -> i64 {
    i64::from(proto::USAGE_MAX_WINDOW_DAYS) * 24 * 60 * 60 * 1_000
}

pub fn scan_cache_path(state_dir: &Path) -> PathBuf {
    state_dir.join("usage").join("scan-cache.sqlite")
}

fn legacy_json_path(state_dir: &Path) -> PathBuf {
    state_dir.join("usage").join("scan-cache.json")
}

const SCHEMA: &str = "
    CREATE TABLE IF NOT EXISTS scan_file (
        id       INTEGER PRIMARY KEY,
        path     TEXT NOT NULL UNIQUE,
        size     INTEGER NOT NULL,
        mtime_ms INTEGER NOT NULL,
        provider TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS scan_record (
        file_id           INTEGER NOT NULL REFERENCES scan_file(id) ON DELETE CASCADE,
        timestamp_ms      INTEGER NOT NULL,
        model             TEXT NOT NULL,
        session_id        TEXT NOT NULL,
        uncached_input    INTEGER NOT NULL,
        cached_input      INTEGER NOT NULL,
        cache_creation    INTEGER NOT NULL,
        output            INTEGER NOT NULL,
        reasoning         INTEGER NOT NULL,
        dedupe_key        INTEGER,
        reported_cost_usd REAL
    );
    CREATE INDEX IF NOT EXISTS scan_record_file ON scan_record(file_id);
";

pub struct ScanCacheDb {
    conn: Option<Connection>,
    in_transaction: bool,
}

impl ScanCacheDb {
    pub fn open(state_dir: &Path) -> Self {
        let path = scan_cache_path(state_dir);
        match Self::open_inner(&path) {
            Ok(conn) => {
                let _ = std::fs::remove_file(legacy_json_path(state_dir));
                Self {
                    conn: Some(conn),
                    in_transaction: false,
                }
            }
            Err(e) => {
                tracing::debug!(
                    "usage scan cache at {} is unusable ({e:#}); re-parsing transcripts",
                    path.display()
                );
                Self {
                    conn: None,
                    in_transaction: false,
                }
            }
        }
    }

    fn open_inner(path: &Path) -> rusqlite::Result<Connection> {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir).map_err(|e| {
                rusqlite::Error::InvalidPath(PathBuf::from(format!("{}: {e}", dir.display())))
            })?;
        }
        let conn = Connection::open(path)?;
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "synchronous", "NORMAL")?;
        conn.pragma_update(None, "temp_store", "MEMORY")?;
        conn.pragma_update(None, "foreign_keys", true)?;
        conn.busy_timeout(std::time::Duration::from_secs(5))?;

        let version: u32 = conn.pragma_query_value(None, "user_version", |row| row.get(0))?;
        if version != SCAN_CACHE_VERSION {
            conn.execute_batch(
                "DROP TABLE IF EXISTS scan_record; DROP TABLE IF EXISTS scan_file;",
            )?;
            conn.pragma_update(None, "user_version", SCAN_CACHE_VERSION)?;
        }
        conn.execute_batch(SCHEMA)?;
        Ok(conn)
    }

    /// Hits only on the exact `(path, size, mtime, provider)`: a transcript is
    /// append-only, so size or mtime moving means new lines, and the provider is
    /// part of the key because the two parsers read the same bytes differently.
    pub fn lookup(
        &self,
        path: &str,
        size: u64,
        mtime_ms: i64,
        provider: proto::UsageProvider,
    ) -> Option<Vec<UsageRecord>> {
        let conn = self.conn.as_ref()?;
        match Self::lookup_inner(conn, path, size, mtime_ms, provider) {
            Ok(hit) => hit,
            Err(e) => {
                tracing::debug!("usage scan cache lookup for {path} failed ({e:#}); re-parsing");
                None
            }
        }
    }

    fn lookup_inner(
        conn: &Connection,
        path: &str,
        size: u64,
        mtime_ms: i64,
        provider: proto::UsageProvider,
    ) -> rusqlite::Result<Option<Vec<UsageRecord>>> {
        let mut find = conn.prepare_cached(
            "SELECT id FROM scan_file
              WHERE path = ?1 AND size = ?2 AND mtime_ms = ?3 AND provider = ?4",
        )?;
        let id: i64 = match find
            .query_row(
                rusqlite::params![path, size as i64, mtime_ms, provider_key(provider)],
                |row| row.get(0),
            )
            .ok()
        {
            Some(id) => id,
            None => return Ok(None),
        };

        let mut rows = conn.prepare_cached(
            "SELECT timestamp_ms, model, session_id, uncached_input, cached_input,
                    cache_creation, output, reasoning, dedupe_key, reported_cost_usd
               FROM scan_record WHERE file_id = ?1",
        )?;
        let records = rows
            .query_map([id], |row| {
                Ok(UsageRecord {
                    provider,
                    timestamp_ms: row.get(0)?,
                    model: row.get(1)?,
                    session_id: row.get(2)?,
                    totals: proto::UsageTokenTotals {
                        uncached_input_tokens: row.get::<_, i64>(3)? as u64,
                        cached_input_tokens: row.get::<_, i64>(4)? as u64,
                        cache_creation_tokens: row.get::<_, i64>(5)? as u64,
                        output_tokens: row.get::<_, i64>(6)? as u64,
                        reasoning_tokens: row.get::<_, i64>(7)? as u64,
                    },
                    reported_cost_usd: row.get(9)?,
                    dedupe_key: row.get::<_, Option<i64>>(8)?.map(|k| k as u64),
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(Some(records))
    }

    pub fn store(
        &mut self,
        path: &str,
        size: u64,
        mtime_ms: i64,
        provider: proto::UsageProvider,
        records: &[UsageRecord],
    ) {
        self.begin();
        let Some(conn) = self.conn.as_ref() else {
            return;
        };
        if let Err(e) = Self::store_inner(conn, path, size, mtime_ms, provider, records) {
            tracing::debug!(
                "usage scan cache store for {path} failed ({e:#}); continuing uncached"
            );
            self.disable();
        }
    }

    fn store_inner(
        conn: &Connection,
        path: &str,
        size: u64,
        mtime_ms: i64,
        provider: proto::UsageProvider,
        records: &[UsageRecord],
    ) -> rusqlite::Result<()> {
        conn.prepare_cached("DELETE FROM scan_file WHERE path = ?1")?
            .execute([path])?;
        conn.prepare_cached(
            "INSERT INTO scan_file (path, size, mtime_ms, provider) VALUES (?1, ?2, ?3, ?4)",
        )?
        .execute(rusqlite::params![
            path,
            size as i64,
            mtime_ms,
            provider_key(provider)
        ])?;
        let id = conn.last_insert_rowid();

        let mut insert = conn.prepare_cached(
            "INSERT INTO scan_record
                (file_id, timestamp_ms, model, session_id, uncached_input, cached_input,
                 cache_creation, output, reasoning, dedupe_key, reported_cost_usd)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
        )?;
        for r in records {
            insert.execute(rusqlite::params![
                id,
                r.timestamp_ms,
                r.model,
                r.session_id,
                r.totals.uncached_input_tokens as i64,
                r.totals.cached_input_tokens as i64,
                r.totals.cache_creation_tokens as i64,
                r.totals.output_tokens as i64,
                r.totals.reasoning_tokens as i64,
                r.dedupe_key.map(|k| k as i64),
                r.reported_cost_usd
            ])?;
        }
        Ok(())
    }

    pub fn prune(&mut self, now_ms: i64) {
        let cutoff = now_ms - retention_ms();
        self.begin();
        let Some(conn) = self.conn.as_ref() else {
            return;
        };
        let pruned = conn
            .prepare_cached("DELETE FROM scan_file WHERE mtime_ms < ?1")
            .and_then(|mut s| s.execute([cutoff]));
        match pruned {
            Ok(0) => {}
            Ok(n) => tracing::debug!("usage scan cache: dropped {n} unreachable transcript(s)"),
            Err(e) => {
                tracing::debug!("usage scan cache prune failed ({e:#}); continuing");
                self.disable();
            }
        }
    }

    pub fn flush(&mut self) {
        if !self.in_transaction {
            return;
        }
        self.in_transaction = false;
        let Some(conn) = self.conn.as_ref() else {
            return;
        };
        if let Err(e) = conn.execute_batch("COMMIT") {
            tracing::debug!("committing the usage scan cache failed ({e:#}); discarding it");
            self.disable();
        }
    }

    fn begin(&mut self) {
        if self.in_transaction {
            return;
        }
        let Some(conn) = self.conn.as_ref() else {
            return;
        };
        match conn.execute_batch("BEGIN IMMEDIATE") {
            Ok(()) => self.in_transaction = true,
            Err(e) => {
                tracing::debug!("usage scan cache could not begin a write ({e:#}); continuing");
                self.disable();
            }
        }
    }

    fn disable(&mut self) {
        self.conn = None;
        self.in_transaction = false;
    }
}

/// The wire spelling, not a positional integer, so a stored row is readable in
/// `sqlite3` and cannot silently change meaning if the enum's order changes.
fn provider_key(provider: proto::UsageProvider) -> &'static str {
    match provider {
        proto::UsageProvider::Claude => "claude",
        proto::UsageProvider::Codex => "codex",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const DAY_MS: i64 = 24 * 60 * 60 * 1_000;

    fn record(model: &str, session: &str, dedupe: Option<u64>) -> UsageRecord {
        UsageRecord {
            provider: proto::UsageProvider::Claude,
            timestamp_ms: 1_787_836_744_123,
            model: model.into(),
            session_id: session.into(),
            totals: proto::UsageTokenTotals {
                uncached_input_tokens: 1,
                cached_input_tokens: 2,
                cache_creation_tokens: 3,
                output_tokens: 4,
                reasoning_tokens: 5,
            },
            reported_cost_usd: Some(0.5),
            dedupe_key: dedupe,
        }
    }

    #[test]
    fn round_trips_every_field_a_record_carries() {
        let dir = tempfile::tempdir().expect("tempdir");
        let mut db = ScanCacheDb::open(dir.path());
        let records = vec![
            record("claude-opus-5", "s1", Some(0xdead_beef)),
            record("claude-opus-5", "s2", None),
        ];
        db.store(
            "/home/u/.claude/projects/a.jsonl",
            4_096,
            1_787_836_744_000,
            proto::UsageProvider::Claude,
            &records,
        );
        db.flush();

        let back = ScanCacheDb::open(dir.path());
        assert_eq!(
            back.lookup(
                "/home/u/.claude/projects/a.jsonl",
                4_096,
                1_787_836_744_000,
                proto::UsageProvider::Claude
            ),
            Some(records)
        );
    }

    #[test]
    fn a_dedupe_key_survives_the_full_u64_range() {
        let dir = tempfile::tempdir().expect("tempdir");
        let mut db = ScanCacheDb::open(dir.path());
        let records = vec![record("m", "s", Some(u64::MAX))];
        db.store("/a.jsonl", 1, 1, proto::UsageProvider::Claude, &records);
        db.flush();
        let back = db
            .lookup("/a.jsonl", 1, 1, proto::UsageProvider::Claude)
            .expect("hit");
        assert_eq!(back[0].dedupe_key, Some(u64::MAX));
    }

    #[test]
    fn a_moved_file_misses_on_every_part_of_the_key() {
        let dir = tempfile::tempdir().expect("tempdir");
        let mut db = ScanCacheDb::open(dir.path());
        db.store(
            "/a.jsonl",
            10,
            20,
            proto::UsageProvider::Claude,
            &[record("m", "s", None)],
        );
        db.flush();

        assert!(db
            .lookup("/a.jsonl", 10, 20, proto::UsageProvider::Claude)
            .is_some());
        assert!(
            db.lookup("/a.jsonl", 11, 20, proto::UsageProvider::Claude)
                .is_none(),
            "an appended transcript grew"
        );
        assert!(
            db.lookup("/a.jsonl", 10, 21, proto::UsageProvider::Claude)
                .is_none(),
            "a rewritten transcript moved its mtime"
        );
        assert!(
            db.lookup("/a.jsonl", 10, 20, proto::UsageProvider::Codex)
                .is_none(),
            "the two parsers read the same bytes differently"
        );
    }

    #[test]
    fn re_storing_a_path_replaces_its_reading_rather_than_appending() {
        let dir = tempfile::tempdir().expect("tempdir");
        let mut db = ScanCacheDb::open(dir.path());
        db.store(
            "/a.jsonl",
            10,
            20,
            proto::UsageProvider::Claude,
            &[record("m", "s", None), record("m", "s", None)],
        );
        db.store(
            "/a.jsonl",
            30,
            40,
            proto::UsageProvider::Claude,
            &[record("m", "s", None)],
        );
        db.flush();
        assert_eq!(
            db.lookup("/a.jsonl", 30, 40, proto::UsageProvider::Claude)
                .map(|r| r.len()),
            Some(1),
            "the old reading must not survive alongside the new one"
        );
    }

    #[test]
    fn rows_past_the_reachable_window_are_dropped_on_prune() {
        let dir = tempfile::tempdir().expect("tempdir");
        let now = 100 * DAY_MS;
        let mut db = ScanCacheDb::open(dir.path());
        db.store(
            "/fresh.jsonl",
            1,
            now - DAY_MS,
            proto::UsageProvider::Claude,
            &[record("m", "s", None)],
        );
        let unreachable = now - (i64::from(proto::USAGE_MAX_WINDOW_DAYS) + 1) * DAY_MS;
        db.store(
            "/unreachable.jsonl",
            1,
            unreachable,
            proto::UsageProvider::Claude,
            &[record("m", "s", None)],
        );
        db.prune(now);
        db.flush();

        assert!(db
            .lookup(
                "/fresh.jsonl",
                1,
                now - DAY_MS,
                proto::UsageProvider::Claude
            )
            .is_some());
        assert!(
            db.lookup(
                "/unreachable.jsonl",
                1,
                unreachable,
                proto::UsageProvider::Claude
            )
            .is_none(),
            "a transcript older than the widest window can never be asked for again"
        );
        let conn = db.conn.as_ref().expect("open");
        let orphans: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM scan_record
                  WHERE file_id NOT IN (SELECT id FROM scan_file)",
                [],
                |row| row.get(0),
            )
            .expect("count");
        assert_eq!(
            orphans, 0,
            "the cascade must take the records with the file"
        );
    }

    #[test]
    fn a_version_bump_discards_the_old_reading_rather_than_serving_it() {
        let dir = tempfile::tempdir().expect("tempdir");
        let mut db = ScanCacheDb::open(dir.path());
        db.store(
            "/a.jsonl",
            10,
            20,
            proto::UsageProvider::Claude,
            &[record("m", "s", None)],
        );
        db.flush();
        drop(db);

        let conn = Connection::open(scan_cache_path(dir.path())).expect("open");
        conn.pragma_update(None, "user_version", SCAN_CACHE_VERSION + 1)
            .expect("bump");
        drop(conn);

        let back = ScanCacheDb::open(dir.path());
        assert!(
            back.lookup("/a.jsonl", 10, 20, proto::UsageProvider::Claude)
                .is_none(),
            "a stale version must not be served"
        );
    }

    #[test]
    fn every_unusable_cache_degrades_to_re_parsing_rather_than_failing() {
        let dir = tempfile::tempdir().expect("tempdir");
        std::fs::create_dir_all(scan_cache_path(dir.path())).expect("mkdir");
        let mut db = ScanCacheDb::open(dir.path());
        assert!(db
            .lookup("/a.jsonl", 1, 1, proto::UsageProvider::Claude)
            .is_none());
        db.store(
            "/a.jsonl",
            1,
            1,
            proto::UsageProvider::Claude,
            &[record("m", "s", None)],
        );
        db.prune(0);
        db.flush();
        assert!(db
            .lookup("/a.jsonl", 1, 1, proto::UsageProvider::Claude)
            .is_none());
    }

    #[test]
    fn the_pre_v2_json_blob_is_removed_rather_than_stranded() {
        let dir = tempfile::tempdir().expect("tempdir");
        let legacy = legacy_json_path(dir.path());
        std::fs::create_dir_all(legacy.parent().unwrap()).expect("mkdir");
        std::fs::write(&legacy, b"{\"version\":1}").expect("write");
        let _db = ScanCacheDb::open(dir.path());
        assert!(
            !legacy.exists(),
            "the old blob is dead weight in every existing state directory"
        );
    }
}
