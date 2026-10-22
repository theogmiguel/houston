//! Night shift settings and the run ledger: one row per run, entries the
//! orchestrator records, and the user's answers to parked decisions.
use anyhow::{Context, Result};
use houston_protocol as proto;
use rusqlite::{Connection, OptionalExtension};

use super::{from_wire, wire_name, Db};

pub(super) fn migrate(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS night_shift_settings (
            routine_id INTEGER PRIMARY KEY,
            json TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS night_runs (
            run_id INTEGER PRIMARY KEY,
            routine_id INTEGER NOT NULL,
            workspace TEXT NOT NULL,
            report_path TEXT NOT NULL,
            summary TEXT,
            started_at_ms INTEGER NOT NULL,
            ended_at_ms INTEGER,
            interruptions_json TEXT NOT NULL DEFAULT '[]',
            cost_json TEXT NOT NULL DEFAULT '{}',
            trigger TEXT NOT NULL,
            phase TEXT NOT NULL,
            session_id INTEGER,
            wrap_up_at_ms INTEGER NOT NULL,
            hard_stop_at_ms INTEGER NOT NULL,
            wrap_up_sent INTEGER NOT NULL DEFAULT 0,
            report_published INTEGER NOT NULL DEFAULT 0,
            stop_reason TEXT,
            stop_detail TEXT,
            limited_json TEXT NOT NULL DEFAULT '[]',
            preflight_json TEXT NOT NULL DEFAULT '[]',
            keep_awake TEXT NOT NULL DEFAULT 'off',
            merge_order_json TEXT NOT NULL DEFAULT '[]',
            heartbeat_ms INTEGER
        );
        CREATE INDEX IF NOT EXISTS idx_night_runs_routine
            ON night_runs(routine_id, run_id DESC);
        CREATE TABLE IF NOT EXISTS night_entries (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            run_id INTEGER NOT NULL,
            kind TEXT NOT NULL CHECK(kind IN ('plan','pr','lesson','decision','deferred','flaky')),
            title TEXT NOT NULL,
            theme TEXT,
            status TEXT,
            pr_number INTEGER,
            visible INT NOT NULL DEFAULT 0,
            qa_passed INT NOT NULL DEFAULT 0,
            body TEXT NOT NULL DEFAULT '',
            created_at_ms INTEGER NOT NULL,
            decided_at_ms INTEGER,
            choice TEXT,
            gates_json TEXT NOT NULL DEFAULT '{}'
        );
        CREATE INDEX IF NOT EXISTS idx_night_entries_run ON night_entries(run_id, id);",
    )?;
    super::add_column_if_missing(
        conn,
        "night_runs",
        "crew_json",
        "crew_json TEXT NOT NULL DEFAULT '[]'",
    )?;
    Ok(())
}

/// A pane of a run's tree, recorded when it is spawned and kept after it
/// exits: membership does not depend on live parent links.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct NightMember {
    pub session: u32,
    /// The pane's first id; a respawn keeps it.
    pub origin: u32,
    pub provider: proto::AgentKind,
    pub first_seen_ms: i64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct NightRunRow {
    pub run_id: u32,
    pub routine_id: u32,
    pub workspace: String,
    pub trigger: proto::RoutineTrigger,
    pub phase: proto::NightRunPhase,
    pub session_id: Option<u32>,
    pub started_at_ms: i64,
    pub wrap_up_at_ms: i64,
    pub hard_stop_at_ms: i64,
    pub ended_at_ms: Option<i64>,
    pub report_path: String,
    pub report_published: bool,
    pub summary: Option<String>,
    pub wrap_up_sent: bool,
    pub stop_reason: Option<proto::NightStopReason>,
    pub stop_detail: Option<String>,
    pub interruptions: Vec<proto::NightInterruption>,
    pub cost: proto::NightCost,
    pub limited: Vec<proto::AgentKind>,
    pub preflight: Vec<proto::PreflightItem>,
    pub keep_awake: proto::NightKeepAwake,
    pub merge_order: Vec<u32>,
    /// Every pane the run started, the orchestrator first.
    pub crew: Vec<NightMember>,
}

const RUN_SELECT: &str = "SELECT run_id, routine_id, workspace, trigger, phase, session_id, \
    started_at_ms, wrap_up_at_ms, hard_stop_at_ms, ended_at_ms, report_path, report_published, \
    summary, wrap_up_sent, stop_reason, stop_detail, interruptions_json, cost_json, \
    limited_json, preflight_json, keep_awake, merge_order_json, crew_json FROM night_runs";

fn bad(col: usize, what: String) -> rusqlite::Error {
    rusqlite::Error::FromSqlConversionFailure(col, rusqlite::types::Type::Text, what.into())
}

fn json_col<T: serde::de::DeserializeOwned>(
    r: &rusqlite::Row,
    col: usize,
    run_id: u32,
) -> rusqlite::Result<T> {
    let raw: String = r.get(col)?;
    serde_json::from_str(&raw).map_err(|e| {
        bad(
            col,
            format!("night_runs {run_id} column {col} {raw:?}: {e}"),
        )
    })
}

fn wire_col<T: serde::de::DeserializeOwned>(
    r: &rusqlite::Row,
    col: usize,
    run_id: u32,
) -> rusqlite::Result<T> {
    let raw: String = r.get(col)?;
    from_wire(&raw).ok_or_else(|| {
        bad(
            col,
            format!("night_runs {run_id} column {col} has unknown value {raw:?}"),
        )
    })
}

fn map_run(r: &rusqlite::Row) -> rusqlite::Result<NightRunRow> {
    let run_id: u32 = r.get(0)?;
    let stop_reason: Option<String> = r.get(14)?;
    Ok(NightRunRow {
        run_id,
        routine_id: r.get(1)?,
        workspace: r.get(2)?,
        trigger: wire_col(r, 3, run_id)?,
        phase: wire_col(r, 4, run_id)?,
        session_id: r.get(5)?,
        started_at_ms: r.get(6)?,
        wrap_up_at_ms: r.get(7)?,
        hard_stop_at_ms: r.get(8)?,
        ended_at_ms: r.get(9)?,
        report_path: r.get(10)?,
        report_published: r.get::<_, i64>(11)? != 0,
        summary: r.get(12)?,
        wrap_up_sent: r.get::<_, i64>(13)? != 0,
        stop_reason: stop_reason.as_deref().and_then(from_wire),
        stop_detail: r.get(15)?,
        interruptions: json_col(r, 16, run_id)?,
        cost: json_col(r, 17, run_id)?,
        limited: json_col(r, 18, run_id)?,
        preflight: json_col(r, 19, run_id)?,
        keep_awake: wire_col(r, 20, run_id)?,
        merge_order: json_col(r, 21, run_id)?,
        crew: json_col(r, 22, run_id)?,
    })
}

const ENTRY_SELECT: &str = "SELECT id, run_id, kind, title, theme, status, pr_number, visible, \
    qa_passed, body, created_at_ms, decided_at_ms, choice, gates_json FROM night_entries";

fn map_entry(r: &rusqlite::Row) -> rusqlite::Result<proto::NightEntry> {
    let id: u32 = r.get(0)?;
    let kind_raw: String = r.get(2)?;
    let gates_raw: String = r.get(13)?;
    Ok(proto::NightEntry {
        id,
        run_id: r.get(1)?,
        kind: from_wire(&kind_raw)
            .ok_or_else(|| bad(2, format!("night_entries {id} has kind {kind_raw:?}")))?,
        title: r.get(3)?,
        theme: r.get(4)?,
        status: r.get(5)?,
        pr_number: r.get(6)?,
        visible: r.get::<_, i64>(7)? != 0,
        qa_passed: r.get::<_, i64>(8)? != 0,
        body: r.get(9)?,
        gates: serde_json::from_str(&gates_raw)
            .map_err(|e| bad(13, format!("night_entries {id} gates {gates_raw:?}: {e}")))?,
        created_at_ms: r.get(10)?,
        decided_at_ms: r.get(11)?,
        choice: r.get(12)?,
    })
}

/// A new ledger entry, or the fields `night_pr` replaces on an existing one.
pub struct NightEntryWrite<'a> {
    pub run_id: u32,
    pub kind: proto::NightEntryKind,
    pub title: &'a str,
    pub theme: Option<&'a str>,
    pub status: Option<&'a str>,
    pub pr_number: Option<u32>,
    pub visible: bool,
    pub body: &'a str,
    pub gates: proto::NightGates,
    pub now_ms: i64,
}

impl Db {
    pub fn night_shift_routine_id(&self, workspace: &str) -> Result<Option<u32>> {
        let conn = self.conn.lock().expect("db lock");
        Ok(conn
            .query_row(
                "SELECT id FROM routines WHERE kind = 'night_shift' AND workspace_id = ?1 \
                 ORDER BY id LIMIT 1",
                [workspace],
                |r| r.get(0),
            )
            .optional()?)
    }

    /// Marks the routine as Night shift and stores its settings, together.
    pub fn set_night_shift_routine(&self, routine_id: u32, json: &str) -> Result<()> {
        let conn = self.conn.lock().expect("db lock");
        let tx = conn.unchecked_transaction()?;
        tx.execute(
            "INSERT INTO night_shift_settings (routine_id, json) VALUES (?1, ?2) \
             ON CONFLICT(routine_id) DO UPDATE SET json = excluded.json",
            rusqlite::params![routine_id, json],
        )?;
        tx.execute(
            "UPDATE routines SET kind = 'night_shift' WHERE id = ?1",
            [routine_id],
        )?;
        tx.commit()?;
        Ok(())
    }

    pub fn night_shift_settings_json(&self, routine_id: u32) -> Result<Option<String>> {
        let conn = self.conn.lock().expect("db lock");
        Ok(conn
            .query_row(
                "SELECT json FROM night_shift_settings WHERE routine_id = ?1",
                [routine_id],
                |r| r.get(0),
            )
            .optional()?)
    }

    /// Moves a routine's next scheduled run without recording a run.
    pub fn set_routine_next_run_at(&self, routine_id: u32, at_ms: i64) -> Result<()> {
        let conn = self.conn.lock().expect("db lock");
        conn.execute(
            "UPDATE routines SET next_run_at_ms = ?2 WHERE id = ?1",
            rusqlite::params![routine_id, at_ms],
        )?;
        Ok(())
    }

    pub fn night_shift_settings_exist(&self, routine_id: u32) -> Result<bool> {
        Ok(self.night_shift_settings_json(routine_id)?.is_some())
    }

    pub fn create_night_run(&self, row: &NightRunRow) -> Result<()> {
        let conn = self.conn.lock().expect("db lock");
        conn.execute(
            "INSERT INTO night_runs (run_id, routine_id, workspace, report_path, started_at_ms, \
             trigger, phase, wrap_up_at_ms, hard_stop_at_ms, preflight_json) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            rusqlite::params![
                row.run_id,
                row.routine_id,
                row.workspace,
                row.report_path,
                row.started_at_ms,
                wire_name(&row.trigger)?,
                wire_name(&row.phase)?,
                row.wrap_up_at_ms,
                row.hard_stop_at_ms,
                serde_json::to_string(&row.preflight)?,
            ],
        )?;
        drop(conn);
        self.save_night_run(row)
    }

    /// Writes every mutable column of `row`; callers serialize their
    /// read-modify-write on the daemon's Night shift lock.
    pub fn save_night_run(&self, row: &NightRunRow) -> Result<()> {
        let conn = self.conn.lock().expect("db lock");
        conn.execute(
            "UPDATE night_runs SET phase = ?2, session_id = ?3, wrap_up_at_ms = ?4, \
             hard_stop_at_ms = ?5, ended_at_ms = ?6, report_published = ?7, summary = ?8, \
             wrap_up_sent = ?9, stop_reason = ?10, stop_detail = ?11, interruptions_json = ?12, \
             cost_json = ?13, limited_json = ?14, preflight_json = ?15, keep_awake = ?16, \
             merge_order_json = ?17, crew_json = ?18 WHERE run_id = ?1",
            rusqlite::params![
                row.run_id,
                wire_name(&row.phase)?,
                row.session_id,
                row.wrap_up_at_ms,
                row.hard_stop_at_ms,
                row.ended_at_ms,
                row.report_published as i64,
                row.summary,
                row.wrap_up_sent as i64,
                row.stop_reason.map(|r| wire_name(&r)).transpose()?,
                row.stop_detail,
                serde_json::to_string(&row.interruptions)?,
                serde_json::to_string(&row.cost)?,
                serde_json::to_string(&row.limited)?,
                serde_json::to_string(&row.preflight)?,
                wire_name(&row.keep_awake)?,
                serde_json::to_string(&row.merge_order)?,
                serde_json::to_string(&row.crew)?,
            ],
        )
        .with_context(|| format!("saving night run {}", row.run_id))?;
        Ok(())
    }

    pub fn night_run(&self, run_id: u32) -> Result<Option<NightRunRow>> {
        let conn = self.conn.lock().expect("db lock");
        Ok(conn
            .query_row(
                &format!("{RUN_SELECT} WHERE run_id = ?1"),
                [run_id],
                map_run,
            )
            .optional()?)
    }

    pub fn night_runs_of_routine(&self, routine_id: u32, limit: u32) -> Result<Vec<NightRunRow>> {
        let conn = self.conn.lock().expect("db lock");
        let mut stmt = conn.prepare(&format!(
            "{RUN_SELECT} WHERE routine_id = ?1 ORDER BY run_id DESC LIMIT ?2"
        ))?;
        let rows = stmt
            .query_map(rusqlite::params![routine_id, limit], map_run)?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    /// Runs that started and have not settled.
    pub fn night_runs_in_flight(&self) -> Result<Vec<NightRunRow>> {
        let conn = self.conn.lock().expect("db lock");
        let mut stmt = conn.prepare(&format!(
            "{RUN_SELECT} WHERE ended_at_ms IS NULL AND phase IN ('running', 'wrapping_up') \
             ORDER BY run_id"
        ))?;
        let rows = stmt
            .query_map([], map_run)?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    pub fn insert_night_entry(&self, w: &NightEntryWrite<'_>) -> Result<u32> {
        let conn = self.conn.lock().expect("db lock");
        conn.execute(
            "INSERT INTO night_entries (run_id, kind, title, theme, status, pr_number, visible, \
             body, created_at_ms, gates_json) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            rusqlite::params![
                w.run_id,
                wire_name(&w.kind)?,
                w.title,
                w.theme,
                w.status,
                w.pr_number,
                w.visible as i64,
                w.body,
                w.now_ms,
                serde_json::to_string(&w.gates)?,
            ],
        )?;
        Ok(conn.last_insert_rowid() as u32)
    }

    pub fn update_night_entry(&self, id: u32, w: &NightEntryWrite<'_>) -> Result<()> {
        let conn = self.conn.lock().expect("db lock");
        conn.execute(
            "UPDATE night_entries SET title = ?2, theme = ?3, status = ?4, pr_number = ?5, \
             visible = ?6, body = ?7, gates_json = ?8 WHERE id = ?1",
            rusqlite::params![
                id,
                w.title,
                w.theme,
                w.status,
                w.pr_number,
                w.visible as i64,
                w.body,
                serde_json::to_string(&w.gates)?,
            ],
        )?;
        Ok(())
    }

    pub fn set_night_entry_gates(&self, id: u32, gates: &proto::NightGates) -> Result<()> {
        let conn = self.conn.lock().expect("db lock");
        conn.execute(
            "UPDATE night_entries SET gates_json = ?2 WHERE id = ?1",
            rusqlite::params![id, serde_json::to_string(gates)?],
        )?;
        Ok(())
    }

    pub fn night_entry(&self, id: u32) -> Result<Option<proto::NightEntry>> {
        let conn = self.conn.lock().expect("db lock");
        Ok(conn
            .query_row(&format!("{ENTRY_SELECT} WHERE id = ?1"), [id], map_entry)
            .optional()?)
    }

    pub fn night_entries(&self, run_id: u32) -> Result<Vec<proto::NightEntry>> {
        let conn = self.conn.lock().expect("db lock");
        let mut stmt = conn.prepare(&format!("{ENTRY_SELECT} WHERE run_id = ?1 ORDER BY id"))?;
        let rows = stmt
            .query_map([run_id], map_entry)?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    pub fn night_entry_count(&self, run_id: u32) -> Result<u32> {
        let conn = self.conn.lock().expect("db lock");
        Ok(conn.query_row(
            "SELECT COUNT(*) FROM night_entries WHERE run_id = ?1",
            [run_id],
            |r| r.get(0),
        )?)
    }

    /// Deferred, rejected, lesson and flaky entries of the routine's runs
    /// before `before_run`, newest first.
    pub fn night_digest(
        &self,
        routine_id: u32,
        before_run: u32,
        limit: u32,
    ) -> Result<Vec<proto::NightEntry>> {
        let conn = self.conn.lock().expect("db lock");
        let mut stmt = conn.prepare(&format!(
            "{ENTRY_SELECT} WHERE run_id IN \
                (SELECT run_id FROM night_runs WHERE routine_id = ?1 AND run_id < ?2) \
             AND (kind IN ('deferred', 'lesson', 'flaky') \
                  OR status IN ('rejected', 'closed') \
                  OR lower(trim(coalesce(choice, ''))) LIKE 'reject%') \
             ORDER BY created_at_ms DESC, id DESC LIMIT ?3"
        ))?;
        let rows = stmt
            .query_map(rusqlite::params![routine_id, before_run, limit], map_entry)?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    /// Flaky test names recorded for the routine, any run.
    pub fn night_flaky_tests(&self, routine_id: u32) -> Result<Vec<String>> {
        let conn = self.conn.lock().expect("db lock");
        let mut stmt = conn.prepare(
            "SELECT DISTINCT title FROM night_entries WHERE kind = 'flaky' AND run_id IN \
             (SELECT run_id FROM night_runs WHERE routine_id = ?1)",
        )?;
        let rows = stmt
            .query_map([routine_id], |r| r.get(0))?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    /// Records the answer once; `Err(first)` names the earlier answer.
    pub fn decide_night_entry(
        &self,
        id: u32,
        choice: &str,
        now_ms: i64,
    ) -> Result<std::result::Result<(), String>> {
        let conn = self.conn.lock().expect("db lock");
        let tx = conn.unchecked_transaction()?;
        let first: Option<Option<String>> = tx
            .query_row(
                "SELECT choice FROM night_entries WHERE id = ?1",
                [id],
                |r| r.get(0),
            )
            .optional()?;
        let Some(first) = first else {
            anyhow::bail!("no Night shift ledger entry {id}");
        };
        if let Some(first) = first {
            return Ok(Err(first));
        }
        tx.execute(
            "UPDATE night_entries SET choice = ?2, decided_at_ms = ?3 WHERE id = ?1",
            rusqlite::params![id, choice, now_ms],
        )?;
        tx.commit()?;
        Ok(Ok(()))
    }

    /// The last instant the daemon saw the run alive; restart recovery dates
    /// the interruption from it.
    pub fn set_night_heartbeat(&self, run_id: u32, at_ms: i64) -> Result<()> {
        let conn = self.conn.lock().expect("db lock");
        conn.execute(
            "UPDATE night_runs SET heartbeat_ms = ?2 WHERE run_id = ?1",
            rusqlite::params![run_id, at_ms],
        )?;
        Ok(())
    }

    pub fn night_heartbeat(&self, run_id: u32) -> Result<Option<i64>> {
        let conn = self.conn.lock().expect("db lock");
        Ok(conn
            .query_row(
                "SELECT heartbeat_ms FROM night_runs WHERE run_id = ?1",
                [run_id],
                |r| r.get(0),
            )
            .optional()?
            .flatten())
    }

    pub fn set_night_entry_qa_passed(&self, id: u32) -> Result<bool> {
        let conn = self.conn.lock().expect("db lock");
        Ok(conn.execute(
            "UPDATE night_entries SET qa_passed = 1 WHERE id = ?1 AND qa_passed = 0",
            [id],
        )? > 0)
    }
}
