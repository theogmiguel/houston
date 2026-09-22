use crate::scope::MailMessage;
use anyhow::{Context, Result};
use houston_protocol as proto;
use rusqlite::{Connection, OptionalExtension};
use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::Mutex;

#[derive(Debug, Clone)]
pub struct SkillPushRow {
    pub tool: String,
    pub skill: String,
    pub path: String,
    pub pushed_digest: String,
    pub backup_content: Option<Vec<u8>>,
    pub pushed_at: i64,
}

pub struct Db {
    conn: Mutex<Connection>,
}

fn state_str(s: proto::SessionState) -> &'static str {
    match s {
        proto::SessionState::Running => "running",
        proto::SessionState::Exited => "exited",
        proto::SessionState::Killed => "killed",
        proto::SessionState::Interrupted => "interrupted",
    }
}

// Matches only SQLite's damage codes, never a message substring: the healer repairs
// corruption by throwing rows away, so a typo'd column must not be mistaken for one.
fn is_corruption(err: &rusqlite::Error) -> bool {
    match err {
        rusqlite::Error::SqliteFailure(e, _) => matches!(
            e.code,
            rusqlite::ErrorCode::DatabaseCorrupt | rusqlite::ErrorCode::NotADatabase
        ),
        _ => false,
    }
}

// Runs at open, on a probe, and never returns an error. command_history is the one
// table here that is a convenience — losing it costs recall, not work — so it is the
// only table "discard and recreate" may touch, and a failure to heal must not stop boot.
fn heal_command_history(conn: &Connection) {
    let probe = conn.query_row(
        "SELECT count(*) FROM (SELECT cmd FROM command_history ORDER BY workspace, id LIMIT 64)",
        [],
        |r| r.get::<_, i64>(0),
    );
    let Err(e) = probe else { return };
    if !is_corruption(&e) {
        tracing::warn!("command-history probe failed without a corruption code: {e}");
        return;
    }
    tracing::error!(
        "command history is corrupt ({e}); quarantining it — saved commands are lost, \
         nothing else is touched"
    );
    quarantine_command_history(conn);
}

fn quarantine_command_history(conn: &Connection) {
    if let Err(e) = conn.execute_batch(DISCARD_COMMAND_HISTORY) {
        tracing::error!("discarding the corrupt command_history table: {e}");
    }
    if let Err(e) = conn.execute_batch(CREATE_COMMAND_HISTORY) {
        tracing::error!("recreating command_history after quarantine: {e}");
    }
}

const DISCARD_COMMAND_HISTORY: &str = "DROP TABLE IF EXISTS command_history;";

const CREATE_COMMAND_HISTORY: &str = "CREATE TABLE IF NOT EXISTS command_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        workspace TEXT NOT NULL,
        session_id INTEGER NOT NULL,
        cwd TEXT NOT NULL,
        cmd TEXT NOT NULL,
        exit_code INTEGER,
        shell TEXT NOT NULL,
        git_branch TEXT,
        started_at INTEGER NOT NULL,
        ended_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_cmdhist_ws ON command_history(workspace, id);";

fn add_column_if_missing(
    conn: &Connection,
    table: &str,
    column: &str,
    column_def: &str,
) -> Result<()> {
    let present: bool = conn.query_row(
        "SELECT COUNT(*) FROM pragma_table_info(?1) WHERE name = ?2",
        rusqlite::params![table, column],
        |r| r.get::<_, i64>(0).map(|c| c > 0),
    )?;
    if !present {
        conn.execute(&format!("ALTER TABLE {table} ADD COLUMN {column_def}"), [])?;
    }
    Ok(())
}

fn migrate_staged_results_into_the_inbox(conn: &Connection) -> Result<()> {
    let present: bool = conn.query_row(
        "SELECT COUNT(*) FROM pragma_table_info('delegations') WHERE name = 'staged_result'",
        [],
        |r| r.get::<_, i64>(0).map(|c| c > 0),
    )?;
    if !present {
        return Ok(());
    }
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    conn.execute_batch("BEGIN IMMEDIATE")?;
    let moved = conn.execute(
        "INSERT INTO pane_inbox
            (to_session, workspace, from_session, request_id, kind, urgent, summary, body,
             artifacts, superseded, provisional, reason, created_at, ready_at)
         SELECT d.parent_session,
                COALESCE((SELECT s.project_dir FROM sessions s WHERE s.id = d.child_session), ''),
                d.child_session,
                d.round,
                'result',
                0,
                'a result the last daemon was still holding',
                d.staged_result,
                '[]',
                d.staged_superseded,
                0,
                'migrated',
                ?1,
                ?1
         FROM delegations d WHERE d.staged_result IS NOT NULL",
        rusqlite::params![now],
    )?;
    conn.execute_batch(
        "ALTER TABLE delegations DROP COLUMN staged_result;
         ALTER TABLE delegations DROP COLUMN staged_superseded;
         COMMIT",
    )?;
    if moved > 0 {
        tracing::info!("moved {moved} staged delegation result(s) into the pane inbox");
    }
    Ok(())
}

fn strand_legacy_worktree_swarms(conn: &Connection) -> Result<()> {
    let stranded: Vec<(i64, String, String, String)> = conn
        .prepare("SELECT id, root_dir, worktree_dir, branch FROM swarms WHERE worktree_dir != ''")?
        .query_map([], |r| {
            Ok((
                r.get::<_, i64>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, String>(3)?,
            ))
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    for (id, root_dir, worktree_dir, branch) in &stranded {
        tracing::warn!(
            "swarm {id} (root_dir {root_dir:?}) was stranded by the reference-parity \
             worktree removal; its legacy worktree {worktree_dir:?} on branch {branch:?} \
             is left on disk and must be cleaned up by hand"
        );
    }
    if !stranded.is_empty() {
        conn.execute(
            "UPDATE swarms SET
                    status = CASE WHEN status IN ('active', 'idle') THEN 'error' ELSE status END,
                    completed_at = CASE
                        WHEN status IN ('active', 'idle') THEN COALESCE(completed_at, unixepoch())
                        ELSE completed_at
                    END,
                    worktree_dir = '',
                    branch = ''
             WHERE worktree_dir != ''",
            [],
        )?;
    }
    Ok(())
}

fn migrate_pending_swarm_mail_into_the_inbox(conn: &Connection) -> Result<()> {
    let swarms: Vec<(u64, String)> = conn
        .prepare("SELECT id, root_dir FROM swarms")?
        .query_map([], |r| {
            Ok((r.get::<_, i64>(0)? as u64, r.get::<_, String>(1)?))
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;

    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);

    let mut migrated = 0u64;
    for (swarm_id, root_dir) in swarms {
        let layout = crate::scope::ScopeLayout::new(Path::new(&root_dir), swarm_id);
        let inbox_labels = match std::fs::read_dir(layout.scope.join("inbox")) {
            Ok(rd) => rd,
            Err(_) => continue,
        };
        for label_entry in inbox_labels.flatten() {
            let label_dir = label_entry.path();
            let files = match std::fs::read_dir(&label_dir) {
                Ok(rd) => rd,
                Err(_) => continue,
            };
            for file_entry in files.flatten() {
                let path = file_entry.path();
                if path.extension().and_then(|e| e.to_str()) != Some("json") {
                    continue;
                }
                let bytes = match std::fs::read(&path) {
                    Ok(b) => b,
                    Err(e) => {
                        tracing::warn!(
                            "migrating stranded swarm mail {}: {e:#} — left in place",
                            path.display()
                        );
                        continue;
                    }
                };
                let mail = match MailMessage::from_bytes(&bytes) {
                    Ok(m) => m,
                    Err(e) => {
                        tracing::warn!(
                            "migrating stranded swarm mail {}: {e:#} — left in place",
                            path.display()
                        );
                        continue;
                    }
                };
                let row = match crate::orchestrate::inbox_row_new(
                    0,
                    &root_dir,
                    None,
                    None,
                    crate::orchestrate::InboxKind::Mail,
                    &format!("Mail from {}", mail.from),
                    &mail.body,
                    Vec::new(),
                    false,
                    None,
                    Some("migrated"),
                    true,
                ) {
                    Ok(row) => row,
                    Err(e) => {
                        tracing::warn!(
                            "migrating stranded swarm mail {}: {e:#} — left in place",
                            path.display()
                        );
                        continue;
                    }
                };
                insert_inbox_row(conn, &row, now)?;
                if std::fs::remove_file(&path).is_ok() {
                    migrated += 1;
                }
            }
        }
    }
    if migrated > 0 {
        tracing::info!("migrated {migrated} stranded swarm mail file(s) into the pane inbox");
    }
    Ok(())
}

/// Rebuilds an old `routines` table (`agent_id` `NOT NULL`) with the
/// first-class shape, backfilled from each owning bot in the same statement.
/// A nullable table is left alone, so running twice re-inherits nothing.
fn migrate_routines_to_first_class(conn: &Connection) -> Result<()> {
    let agent_id_not_null: bool = conn.query_row(
        "SELECT COUNT(*) FROM pragma_table_info('routines') \
         WHERE name = 'agent_id' AND \"notnull\" = 1",
        [],
        |r| r.get::<_, i64>(0).map(|c| c > 0),
    )?;
    if !agent_id_not_null {
        return Ok(());
    }
    conn.execute_batch(
        "ALTER TABLE routines RENAME TO routines_legacy;
         CREATE TABLE routines (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            agent_id INTEGER,
            name TEXT NOT NULL,
            name_folded TEXT NOT NULL,
            prompt TEXT NOT NULL,
            cadence TEXT NOT NULL,
            enabled INTEGER NOT NULL DEFAULT 1,
            author TEXT NOT NULL DEFAULT 'builder',
            workspace_id TEXT,
            engine TEXT NOT NULL DEFAULT 'claude',
            model TEXT,
            effort TEXT,
            next_run_at_ms INTEGER NOT NULL,
            last_run_at_ms INTEGER,
            last_run_session_id INTEGER,
            last_error TEXT,
            revision TEXT NOT NULL,
            permission_mode TEXT NOT NULL DEFAULT 'accept_edits',
            isolate INTEGER NOT NULL DEFAULT 0,
            last_outcome TEXT,
            continue_context INTEGER NOT NULL DEFAULT 0,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
         );
         INSERT INTO routines
            (id, agent_id, name, name_folded, prompt, cadence, enabled, author,
             workspace_id, engine, model, effort, next_run_at_ms, last_run_at_ms,
             last_run_session_id, last_error, revision, permission_mode, isolate,
             last_outcome, continue_context, created_at, updated_at)
         SELECT l.id, l.agent_id, l.name, l.name_folded, l.prompt, l.cadence, l.enabled,
                l.author,
                COALESCE(l.workspace_id,
                         (SELECT a.working_dir FROM named_agents a WHERE a.id = l.agent_id)),
                COALESCE((SELECT a.engine FROM named_agents a WHERE a.id = l.agent_id),
                         'claude'),
                (SELECT a.default_model FROM named_agents a WHERE a.id = l.agent_id),
                (SELECT a.default_effort FROM named_agents a WHERE a.id = l.agent_id),
                l.next_run_at_ms, l.last_run_at_ms, l.last_run_session_id, l.last_error,
                l.revision, l.permission_mode, l.isolate, l.last_outcome,
                l.continue_context, l.created_at, l.updated_at
         FROM routines_legacy l;
         DROP TABLE routines_legacy;
         CREATE UNIQUE INDEX IF NOT EXISTS idx_routines_agent_name
             ON routines(agent_id, name_folded);
         CREATE UNIQUE INDEX IF NOT EXISTS idx_routines_standalone_name
             ON routines(name_folded) WHERE agent_id IS NULL;",
    )?;
    tracing::info!("routines now own their execution: migrated from bot-inherited settings");
    Ok(())
}

/// Rebuilds `routines` without the bot columns and `routine_runs` without
/// `thread_id`, then drops the five bot tables. The data is copied, never
/// re-derived; keyed on `agent_id`'s presence, so a second open is a no-op.
fn migrate_routines_to_standalone(conn: &Connection) -> Result<()> {
    let has_column = |table: &str, column: &str| -> Result<bool> {
        Ok(conn.query_row(
            "SELECT COUNT(*) FROM pragma_table_info(?1) WHERE name = ?2",
            rusqlite::params![table, column],
            |r| r.get::<_, i64>(0).map(|c| c > 0),
        )?)
    };
    if has_column("routines", "agent_id")? {
        conn.execute_batch(
            "ALTER TABLE routines RENAME TO routines_bot_owned;
             CREATE TABLE routines (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                name_folded TEXT NOT NULL,
                prompt TEXT NOT NULL,
                cadence TEXT NOT NULL,
                enabled INTEGER NOT NULL DEFAULT 1,
                workspace_id TEXT,
                engine TEXT NOT NULL DEFAULT 'claude',
                model TEXT,
                effort TEXT,
                next_run_at_ms INTEGER NOT NULL,
                last_run_at_ms INTEGER,
                last_run_session_id INTEGER,
                last_error TEXT,
                revision TEXT NOT NULL,
                permission_mode TEXT NOT NULL DEFAULT 'accept_edits',
                isolate INTEGER NOT NULL DEFAULT 0,
                last_outcome TEXT,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
             );
             INSERT INTO routines
                (id, name, name_folded, prompt, cadence, enabled, workspace_id, engine,
                 model, effort, next_run_at_ms, last_run_at_ms, last_run_session_id,
                 last_error, revision, permission_mode, isolate, last_outcome,
                 created_at, updated_at)
             SELECT id, name, name_folded, prompt, cadence, enabled, workspace_id, engine,
                    model, effort, next_run_at_ms, last_run_at_ms, last_run_session_id,
                    CASE WHEN last_outcome = 'archive_full'
                         THEN 'the previous run could not complete before routines became standalone'
                         ELSE last_error END,
                    revision, permission_mode, isolate,
                    CASE WHEN last_outcome = 'archive_full' THEN 'failed' ELSE last_outcome END,
                    created_at, updated_at
             FROM routines_bot_owned;
             DROP TABLE routines_bot_owned;
             CREATE UNIQUE INDEX IF NOT EXISTS idx_routines_name
                 ON routines(name_folded);",
        )?;
        tracing::info!("routines are standalone now: bot ownership dropped, execution fields kept");
    }
    if has_column("routine_runs", "thread_id")? {
        conn.execute_batch(
            "ALTER TABLE routine_runs RENAME TO routine_runs_threaded;
             CREATE TABLE routine_runs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                routine_id INTEGER NOT NULL,
                trigger TEXT NOT NULL,
                status TEXT NOT NULL,
                session_id INTEGER,
                error TEXT,
                started_at_ms INTEGER NOT NULL,
                ended_at_ms INTEGER
             );
             INSERT INTO routine_runs
                (id, routine_id, trigger, status, session_id, error, started_at_ms, ended_at_ms)
             SELECT id, routine_id, trigger,
                    CASE WHEN status = 'archive_full' THEN 'failed' ELSE status END,
                    session_id,
                    CASE WHEN status = 'archive_full'
                         THEN 'the previous run could not complete before routines became standalone'
                         ELSE error END,
                    started_at_ms, ended_at_ms
             FROM routine_runs_threaded;
             DROP TABLE routine_runs_threaded;
             CREATE INDEX IF NOT EXISTS idx_routine_runs_routine
                 ON routine_runs(routine_id, id DESC);",
        )?;
    }
    conn.execute_batch(
        "DROP TABLE IF EXISTS agent_messages;
         DROP TABLE IF EXISTS agent_skill_sources;
         DROP TABLE IF EXISTS chat_messages;
         DROP TABLE IF EXISTS chat_threads;
         DROP TABLE IF EXISTS named_agents;",
    )?;
    Ok(())
}

/// A row still `running` at open was in flight when its daemon stopped: it
/// ended then, and with no honest outcome it is `failed`.
fn close_stale_routine_runs(conn: &Connection) -> Result<()> {
    let closed = conn.execute(
        "UPDATE routine_runs SET status = 'failed', \
             error = 'the daemon stopped while this run was in flight', \
             ended_at_ms = MAX(started_at_ms, unixepoch() * 1000) \
         WHERE status = 'running'",
        [],
    )?;
    if closed > 0 {
        tracing::info!("closed {closed} routine run(s) a previous daemon left in flight");
    }
    Ok(())
}

pub(crate) fn wire_name<T: serde::Serialize>(v: &T) -> Result<String> {
    Ok(serde_json::to_string(v)?.trim_matches('"').to_string())
}

pub(crate) fn from_wire<T: serde::de::DeserializeOwned>(s: &str) -> Option<T> {
    serde_json::from_str(&format!("\"{s}\"")).ok()
}

const SWARM_SELECT: &str = "SELECT id, name, root_dir, goal, status, created_at, \
            budget_minutes, activated_at, completed_at FROM swarms";

struct RawSwarmRow {
    id: u64,
    name: String,
    root_dir: String,
    goal: String,
    status: String,
    created_at: i64,
    budget_minutes: u32,
    activated_at: Option<i64>,
    completed_at: Option<i64>,
}

impl RawSwarmRow {
    fn into_info(self, severity: proto::SwarmSeverity) -> Result<proto::SwarmInfo> {
        let status = from_wire::<proto::SwarmStatus>(&self.status).ok_or_else(|| {
            anyhow::anyhow!(
                "swarm {} has unknown status {:?} (expected a SwarmStatus wire name)",
                self.id,
                self.status
            )
        })?;
        Ok(proto::SwarmInfo {
            id: self.id,
            name: self.name,
            root_dir: self.root_dir,
            goal: self.goal,
            status,
            created_at: self.created_at as u64,
            budget_minutes: self.budget_minutes,
            activated_at: self.activated_at.map(|t| t as u64),
            completed_at: self.completed_at.map(|t| t as u64),
            severity,
        })
    }
}

fn map_swarm_row(r: &rusqlite::Row) -> rusqlite::Result<RawSwarmRow> {
    Ok(RawSwarmRow {
        id: r.get(0)?,
        name: r.get(1)?,
        root_dir: r.get(2)?,
        goal: r.get(3)?,
        status: r.get(4)?,
        created_at: r.get(5)?,
        budget_minutes: r.get(6)?,
        activated_at: r.get(7)?,
        completed_at: r.get(8)?,
    })
}

fn swarm_severity_for(conn: &Connection, swarm: u64) -> Result<proto::SwarmSeverity> {
    let has_error: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM swarm_agents WHERE swarm_id = ?1 AND status = 'error')",
        rusqlite::params![swarm],
        |r| r.get(0),
    )?;
    if has_error {
        return Ok(proto::SwarmSeverity::Error);
    }
    let has_escalation: bool = conn.query_row(
        "SELECT EXISTS(
             SELECT 1 FROM swarm_messages m JOIN swarms s ON s.id = m.swarm_id
             WHERE m.swarm_id = ?1 AND m.kind = 'escalation' AND s.status = 'active'
               AND (m.resolvable = 0 OR m.resolved = 0)
         )",
        rusqlite::params![swarm],
        |r| r.get(0),
    )?;
    Ok(if has_escalation {
        proto::SwarmSeverity::Escalation
    } else {
        proto::SwarmSeverity::None
    })
}

fn swarm_severities(conn: &Connection) -> Result<HashMap<u64, proto::SwarmSeverity>> {
    let mut out = HashMap::new();
    let mut stmt = conn.prepare(
        "SELECT DISTINCT m.swarm_id FROM swarm_messages m
         JOIN swarms s ON s.id = m.swarm_id
         WHERE m.kind = 'escalation' AND s.status = 'active'
           AND (m.resolvable = 0 OR m.resolved = 0)",
    )?;
    for id in stmt
        .query_map([], |r| r.get::<_, u64>(0))?
        .collect::<std::result::Result<Vec<_>, _>>()?
    {
        out.insert(id, proto::SwarmSeverity::Escalation);
    }
    let mut stmt =
        conn.prepare("SELECT DISTINCT swarm_id FROM swarm_agents WHERE status = 'error'")?;
    for id in stmt
        .query_map([], |r| r.get::<_, u64>(0))?
        .collect::<std::result::Result<Vec<_>, _>>()?
    {
        out.insert(id, proto::SwarmSeverity::Error);
    }
    Ok(out)
}

fn swarm_row(conn: &Connection, id: u64) -> Result<proto::SwarmInfo> {
    let raw = conn
        .query_row(
            &format!("{SWARM_SELECT} WHERE id = ?1"),
            rusqlite::params![id],
            map_swarm_row,
        )
        .optional()?;
    match raw {
        Some(raw) => {
            let severity = swarm_severity_for(conn, id)?;
            raw.into_info(severity)
        }
        None => anyhow::bail!("no swarm with id {id}"),
    }
}

const SWARM_AGENT_SELECT: &str = "SELECT id, swarm_id, label, role, agent, session_id,
        auto_approve, custom_prompt, cmd, status, activity, created_at, model, plan_mode
     FROM swarm_agents";

fn map_swarm_agent_row(r: &rusqlite::Row) -> rusqlite::Result<(u64, RawSwarmAgent)> {
    Ok((
        r.get(0)?,
        RawSwarmAgent {
            swarm: r.get(1)?,
            label: r.get(2)?,
            role: r.get(3)?,
            agent: r.get(4)?,
            session: r.get(5)?,
            auto_approve: r.get(6)?,
            custom_prompt: r.get(7)?,
            cmd: r.get(8)?,
            status: r.get(9)?,
            activity: r.get(10)?,
            created_at: r.get(11)?,
            model: r.get(12)?,
            plan_mode: r.get(13)?,
        },
    ))
}

struct RawSwarmAgent {
    swarm: u64,
    label: String,
    role: String,
    agent: String,
    session: Option<u32>,
    auto_approve: bool,
    custom_prompt: Option<String>,
    cmd: Option<String>,
    status: String,
    activity: Option<String>,
    created_at: i64,
    model: Option<String>,
    plan_mode: bool,
}

impl RawSwarmAgent {
    fn into_info(self, id: u64) -> Result<proto::SwarmAgentInfo> {
        let role = from_wire::<proto::SwarmRole>(&self.role).ok_or_else(|| {
            anyhow::anyhow!(
                "swarm agent {id} has unknown role {:?} (expected a SwarmRole wire name)",
                self.role
            )
        })?;
        let agent = from_wire::<proto::AgentKind>(&self.agent).ok_or_else(|| {
            anyhow::anyhow!(
                "swarm agent {id} has unknown agent kind {:?} (expected an AgentKind wire name)",
                self.agent
            )
        })?;
        let status = from_wire::<proto::SwarmAgentStatus>(&self.status).ok_or_else(|| {
            anyhow::anyhow!(
                "swarm agent {id} has unknown status {:?} (expected a SwarmAgentStatus wire name)",
                self.status
            )
        })?;
        let cmd = match &self.cmd {
            None => None,
            Some(s) => Some(serde_json::from_str::<Vec<String>>(s).map_err(|_| {
                anyhow::anyhow!(
                    "swarm agent {id} has a non-argv cmd column (expected a JSON string array): {s:?}"
                )
            })?),
        };
        Ok(proto::SwarmAgentInfo {
            id,
            swarm: self.swarm,
            label: self.label,
            role,
            agent,
            session: self.session,
            auto_approve: self.auto_approve,
            plan_mode: self.plan_mode,
            model: self.model,
            custom_prompt: self.custom_prompt,
            cmd,
            status,
            activity: self.activity,
            created_at: self.created_at as u64,
        })
    }
}

pub struct SwarmAgentPolicyRow {
    pub id: u64,
    pub status: proto::SwarmAgentStatus,
    pub last_activity_at: Option<u64>,
    pub respawn_count: u32,
}

pub struct AgentProfileRow {
    pub id: u32,
    pub agent: String,
    pub name: String,
    pub config_dir: String,
}

pub struct RoutineRow {
    pub id: u32,
    pub name: String,
    pub name_folded: String,
    pub prompt: String,
    pub cadence: proto::Cadence,
    pub enabled: bool,
    pub workspace_id: Option<String>,
    pub engine: proto::AgentKind,
    pub model: Option<String>,
    pub effort: Option<proto::ChatEffort>,
    pub next_run_at_ms: i64,
    pub last_run_at_ms: Option<i64>,
    pub last_run_session_id: Option<u32>,
    pub last_error: Option<String>,
    pub permission_mode: proto::ChatPermissionMode,
    pub isolate: bool,
    pub last_outcome: Option<proto::RoutineOutcome>,
    pub revision: String,
}

pub struct DelegationRow {
    pub id: i64,
    pub parent_session: u32,
    pub child_session: u32,
    pub role: Option<String>,
    pub state: String,
    pub stalled: bool,
    pub brief: String,
    pub created_at: u64,
    pub updated_at: u64,
    pub ended_at: Option<u64>,
    pub stop_reason: Option<String>,
    pub no_handback_reported: bool,
    pub no_handback_suppressed: u32,
    pub round: u32,
    pub reusable: bool,
    pub cleanup_after: Option<u64>,
}

pub struct RoutineRunRow {
    pub id: u32,
    pub routine_id: u32,
    pub trigger: proto::RoutineTrigger,
    pub status: proto::RoutineRunStatus,
    pub session_id: Option<u32>,
    pub error: Option<String>,
    pub started_at_ms: i64,
    pub ended_at_ms: Option<i64>,
}

pub struct RoutineWrite<'a> {
    pub name: &'a str,
    pub name_folded: &'a str,
    pub prompt: &'a str,
    pub cadence_json: &'a str,
    pub enabled: bool,
    pub workspace_id: Option<&'a str>,
    pub engine: &'a str,
    pub model: Option<&'a str>,
    pub effort: Option<&'a str>,
    pub next_run_at_ms: i64,
    pub permission_mode: &'a str,
    pub isolate: bool,
    pub revision: &'a str,
}

const DELEGATION_SELECT: &str = "SELECT id, parent_session, child_session, role, state, stalled, \
    brief, created_at, updated_at, ended_at, stop_reason, \
    no_handback_reported, no_handback_suppressed, round, reusable, cleanup_after FROM delegations";

fn map_delegation_row(r: &rusqlite::Row) -> rusqlite::Result<DelegationRow> {
    Ok(DelegationRow {
        id: r.get(0)?,
        parent_session: r.get(1)?,
        child_session: r.get(2)?,
        role: r.get(3)?,
        state: r.get(4)?,
        stalled: r.get::<_, i64>(5)? != 0,
        brief: r.get(6)?,
        created_at: r.get::<_, i64>(7)? as u64,
        updated_at: r.get::<_, i64>(8)? as u64,
        ended_at: r.get::<_, Option<i64>>(9)?.map(|t| t as u64),
        stop_reason: r.get(10)?,
        no_handback_reported: r.get::<_, i64>(11)? != 0,
        no_handback_suppressed: r.get(12)?,
        round: r.get(13)?,
        reusable: r.get::<_, i64>(14)? != 0,
        cleanup_after: r.get::<_, Option<i64>>(15)?.map(|t| t as u64),
    })
}

#[derive(Debug, Clone)]
pub struct InboxRow {
    pub id: i64,
    pub to_session: u32,
    pub original_to: Option<u32>,
    pub workspace: String,
    pub from_session: Option<u32>,
    pub request_id: Option<u32>,
    pub kind: String,
    pub urgent: bool,
    pub summary: String,
    pub body: String,
    pub artifacts: Vec<String>,
    pub superseded: u32,
    pub provisional: bool,
    pub corrects: Option<i64>,
    pub reason: Option<String>,
    pub created_at: u64,
    pub ready_at: Option<u64>,
    pub resolved_at: Option<u64>,
    pub reserved_at: Option<u64>,
    pub delivery_id: Option<String>,
    pub delivered_at: Option<u64>,
    pub delivered_via: Option<String>,
    pub confirmed_at: Option<u64>,
    pub attempts: u32,
    pub from_codename: Option<String>,
    pub from_role: Option<String>,
}

#[derive(Debug)]
pub struct NewInboxRow {
    pub to_session: u32,
    pub workspace: String,
    pub from_session: Option<u32>,
    pub request_id: Option<u32>,
    pub kind: String,
    pub urgent: bool,
    pub summary: String,
    pub body: String,
    pub artifacts: Vec<String>,
    pub provisional: bool,
    pub corrects: Option<i64>,
    pub reason: Option<String>,
    pub ready: bool,
}

#[derive(Debug, Default, PartialEq, Eq)]
pub struct InboxRecovery {
    pub reservations_released: u32,
    pub pastes_requeued: u32,
    pub operator_requeued: u32,
    pub readdressed: u32,
}

const INBOX_SELECT: &str = "SELECT id, to_session, original_to, workspace, from_session, \
    request_id, kind, urgent, summary, body, artifacts, superseded, provisional, corrects, \
    reason, created_at, ready_at, resolved_at, reserved_at, delivery_id, delivered_at, \
    delivered_via, confirmed_at, attempts, from_codename, from_role FROM pane_inbox";

// A row a door is not holding: never reserved, or reserved longer ago than
// INBOX_RESERVATION_MS so that door is presumed dead. Shared by the reserve claim
// and the insert-replace check — an expired reservation must not read as held.
const INBOX_UNRESERVED_OR_EXPIRED: &str = "(reserved_at IS NULL OR reserved_at < ?)";

fn map_inbox_row(r: &rusqlite::Row) -> rusqlite::Result<InboxRow> {
    let artifacts_json: String = r.get(10)?;
    let artifacts: Vec<String> = serde_json::from_str(&artifacts_json).map_err(|e| {
        rusqlite::Error::FromSqlConversionFailure(10, rusqlite::types::Type::Text, Box::new(e))
    })?;
    Ok(InboxRow {
        id: r.get(0)?,
        to_session: r.get(1)?,
        original_to: r.get(2)?,
        workspace: r.get(3)?,
        from_session: r.get(4)?,
        request_id: r.get(5)?,
        kind: r.get(6)?,
        urgent: r.get::<_, i64>(7)? != 0,
        summary: r.get(8)?,
        body: r.get(9)?,
        artifacts,
        superseded: r.get(11)?,
        provisional: r.get::<_, i64>(12)? != 0,
        corrects: r.get(13)?,
        reason: r.get(14)?,
        created_at: r.get::<_, i64>(15)? as u64,
        ready_at: r.get::<_, Option<i64>>(16)?.map(|t| t as u64),
        resolved_at: r.get::<_, Option<i64>>(17)?.map(|t| t as u64),
        reserved_at: r.get::<_, Option<i64>>(18)?.map(|t| t as u64),
        delivery_id: r.get(19)?,
        delivered_at: r.get::<_, Option<i64>>(20)?.map(|t| t as u64),
        delivered_via: r.get(21)?,
        confirmed_at: r.get::<_, Option<i64>>(22)?.map(|t| t as u64),
        attempts: r.get(23)?,
        from_codename: r.get(24)?,
        from_role: r.get(25)?,
    })
}

const ROUTINE_SELECT: &str = "SELECT id, name, name_folded, prompt, cadence, enabled, \
    workspace_id, engine, model, effort, next_run_at_ms, last_run_at_ms, \
    last_run_session_id, last_error, revision, permission_mode, isolate, last_outcome \
    FROM routines";

fn map_routine_row(r: &rusqlite::Row) -> rusqlite::Result<RoutineRow> {
    let id: u32 = r.get(0)?;
    let cadence_raw: String = r.get(4)?;
    let cadence: proto::Cadence = serde_json::from_str(&cadence_raw).map_err(|e| {
        rusqlite::Error::FromSqlConversionFailure(
            4,
            rusqlite::types::Type::Text,
            format!("routines {id} has an unreadable cadence column {cadence_raw:?}: {e}").into(),
        )
    })?;
    let engine_raw: String = r.get(7)?;
    let engine = from_wire::<proto::AgentKind>(&engine_raw).ok_or_else(|| {
        rusqlite::Error::FromSqlConversionFailure(
            7,
            rusqlite::types::Type::Text,
            format!(
                "routines {id} has unknown engine {engine_raw:?} (expected an AgentKind wire name)"
            )
            .into(),
        )
    })?;
    let model: Option<String> = r.get(8)?;
    let effort: Option<proto::ChatEffort> = r
        .get::<_, Option<String>>(9)?
        .as_deref()
        .and_then(from_wire);
    Ok(RoutineRow {
        id,
        name: r.get(1)?,
        name_folded: r.get(2)?,
        prompt: r.get(3)?,
        cadence,
        enabled: r.get::<_, i64>(5)? != 0,
        workspace_id: r.get(6)?,
        engine,
        model,
        effort,
        next_run_at_ms: r.get(10)?,
        last_run_at_ms: r.get(11)?,
        last_run_session_id: r.get(12)?,
        last_error: r.get(13)?,
        revision: r.get(14)?,
        permission_mode: {
            let raw: String = r.get(15)?;
            from_wire::<proto::ChatPermissionMode>(&raw).unwrap_or_else(|| {
                tracing::warn!(
                    "routines {id} has unknown permission_mode {raw:?}; \
                     reading it as accept_edits, the weaker of the two a routine may hold"
                );
                proto::ChatPermissionMode::AcceptEdits
            })
        },
        isolate: r.get::<_, i64>(16)? != 0,
        last_outcome: r
            .get::<_, Option<String>>(17)?
            .as_deref()
            .and_then(from_wire),
    })
}

fn swarm_agent_row(conn: &Connection, id: u64) -> Result<proto::SwarmAgentInfo> {
    let raw = conn
        .query_row(
            &format!("{SWARM_AGENT_SELECT} WHERE id = ?1"),
            rusqlite::params![id],
            map_swarm_agent_row,
        )
        .optional()?;
    match raw {
        Some((id, raw)) => raw.into_info(id),
        None => anyhow::bail!("no swarm agent with id {id}"),
    }
}

fn list_swarm_agent_rows(conn: &Connection, swarm: u64) -> Result<Vec<proto::SwarmAgentInfo>> {
    let mut stmt = conn.prepare(&format!(
        "{SWARM_AGENT_SELECT} WHERE swarm_id = ?1 ORDER BY id"
    ))?;
    let rows = stmt
        .query_map(rusqlite::params![swarm], map_swarm_agent_row)?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    rows.into_iter()
        .map(|(id, raw)| raw.into_info(id))
        .collect()
}

fn validate_swarm_roster_entry(e: &proto::SwarmRosterEntry) -> Result<()> {
    anyhow::ensure!(
        !e.label.trim().is_empty() && e.label.len() <= 40,
        "swarm agent label {:?} must be 1–40 chars",
        e.label
    );
    anyhow::ensure!(
        !e.label.starts_with('@'),
        "swarm agent label {:?} must not start with '@' (reserved for @all/@operator)",
        e.label
    );
    anyhow::ensure!(
        !(e.auto_approve && e.plan_mode),
        "swarm agent {:?} sets both auto_approve and plan_mode — pick one (plan is read-only, \
         skip-permissions is full access)",
        e.label
    );
    Ok(())
}

pub const MAX_SWARM_AGENTS: usize = 12;

fn ensure_swarm_capacity(conn: &Connection, swarm: u64, adding: usize) -> Result<()> {
    let existing: usize = conn.query_row(
        "SELECT COUNT(*) FROM swarm_agents WHERE swarm_id = ?1",
        rusqlite::params![swarm],
        |r| r.get(0),
    )?;
    anyhow::ensure!(
        existing + adding <= MAX_SWARM_AGENTS,
        "swarm {swarm} would have {} agents — the per-swarm limit is {}",
        existing + adding,
        MAX_SWARM_AGENTS
    );
    Ok(())
}

fn insert_swarm_agent(conn: &Connection, swarm: u64, e: &proto::SwarmRosterEntry) -> Result<u64> {
    validate_swarm_roster_entry(e)?;
    let cmd_json = e.cmd.as_ref().map(serde_json::to_string).transpose()?;
    conn.execute(
        "INSERT INTO swarm_agents
            (swarm_id, label, role, agent, auto_approve, plan_mode, model, custom_prompt, cmd, status, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 'idle', unixepoch())",
        rusqlite::params![
            swarm,
            e.label,
            wire_name(&e.role)?,
            wire_name(&e.agent)?,
            e.auto_approve,
            e.plan_mode,
            e.model,
            e.custom_prompt,
            cmd_json,
        ],
    )
    .with_context(|| format!("adding swarm agent {:?} (label taken?)", e.label))?;
    Ok(conn.last_insert_rowid() as u64)
}

const SWARM_MSG_SELECT: &str =
    "SELECT id, swarm_id, sender, recipient, body, kind, created_at FROM swarm_messages";

struct RawSwarmMsg {
    id: u64,
    swarm: u64,
    from: String,
    to: String,
    body: String,
    kind: String,
    created_at: i64,
}

impl RawSwarmMsg {
    fn into_info(self) -> Result<proto::SwarmMessage> {
        let kind = from_wire::<proto::SwarmMsgKind>(&self.kind).ok_or_else(|| {
            anyhow::anyhow!(
                "swarm message {} has unknown kind {:?} (expected a SwarmMsgKind wire name)",
                self.id,
                self.kind
            )
        })?;
        Ok(proto::SwarmMessage {
            id: self.id,
            swarm: self.swarm,
            from: self.from,
            to: self.to,
            body: self.body,
            kind,
            created_at: self.created_at as u64,
        })
    }
}

fn map_swarm_msg_row(r: &rusqlite::Row) -> rusqlite::Result<RawSwarmMsg> {
    Ok(RawSwarmMsg {
        id: r.get(0)?,
        swarm: r.get(1)?,
        from: r.get(2)?,
        to: r.get(3)?,
        body: r.get(4)?,
        kind: r.get(5)?,
        created_at: r.get(6)?,
    })
}

pub enum SwarmMailIngest {
    New(proto::SwarmMessage),
    Replay(proto::SwarmMessage),
}

impl SwarmMailIngest {
    pub fn message(&self) -> &proto::SwarmMessage {
        match self {
            SwarmMailIngest::New(m) | SwarmMailIngest::Replay(m) => m,
        }
    }
}

fn swarm_mail_mismatches(
    stored: &RawSwarmMsg,
    msg: &MailMessage,
    kind_wire: &str,
) -> Vec<&'static str> {
    let mut out = Vec::new();
    if stored.from != msg.from {
        out.push("from");
    }
    if stored.to != msg.to {
        out.push("to");
    }
    if stored.body != msg.body {
        out.push("body");
    }
    if stored.kind != kind_wire {
        out.push("kind");
    }
    out
}

// SQLite's documented maximum for bound variables is 32766; chunked one short of it
// because each of these `IN (...)` statements also spends a placeholder on swarm_id.
const SQL_IN_CHUNK_SIZE: usize = 32766 - 1;

fn ids_present_in_table(
    conn: &Connection,
    table: &str,
    id_column: &str,
    swarm: u64,
    candidate_ids: &[String],
) -> Result<HashSet<String>> {
    let mut out = HashSet::new();
    for chunk in candidate_ids.chunks(SQL_IN_CHUNK_SIZE) {
        let placeholders = vec!["?"; chunk.len()].join(",");
        let sql = format!(
            "SELECT {id_column} FROM {table} WHERE swarm_id = ? AND {id_column} IN ({placeholders})"
        );
        let mut stmt = conn.prepare(&sql)?;
        let params: Vec<&dyn rusqlite::ToSql> = std::iter::once(&swarm as &dyn rusqlite::ToSql)
            .chain(chunk.iter().map(|s| s as &dyn rusqlite::ToSql))
            .collect();
        let ids = stmt
            .query_map(params.as_slice(), |r| r.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<String>>>()?;
        out.extend(ids);
    }
    Ok(out)
}

// Db::open retries a busy migration with linear backoff: these ten retries sum to
// ~1375 ms, measured to survive the full core suite where a 375 ms budget did not.
const OPEN_BUSY_RETRIES: u32 = 10;
const OPEN_BUSY_BACKOFF_MS: u64 = 25;

fn is_busy(err: &anyhow::Error) -> bool {
    matches!(
        err.downcast_ref::<rusqlite::Error>(),
        Some(rusqlite::Error::SqliteFailure(e, _))
            if e.code == rusqlite::ErrorCode::DatabaseBusy
                || e.code == rusqlite::ErrorCode::DatabaseLocked
    )
}

pub const SCHEMA_VERSION: u32 = 2;

impl Db {
    pub fn open(path: &Path) -> Result<Self> {
        let mut attempt = 0;
        loop {
            match Self::open_once(path) {
                Err(e) if is_busy(&e) && attempt < OPEN_BUSY_RETRIES => {
                    attempt += 1;
                    std::thread::sleep(std::time::Duration::from_millis(
                        OPEN_BUSY_BACKOFF_MS * u64::from(attempt),
                    ));
                }
                Err(e) if is_busy(&e) => {
                    let waited: u64 = (1..=OPEN_BUSY_RETRIES)
                        .map(|n| OPEN_BUSY_BACKOFF_MS * u64::from(n))
                        .sum();
                    return Err(e).with_context(|| {
                        format!(
                            "opening sqlite db at {}: still busy after {} retries over {} ms - another process is writing this database continuously",
                            path.display(),
                            OPEN_BUSY_RETRIES,
                            waited
                        )
                    });
                }
                other => return other,
            }
        }
    }

    fn open_once(path: &Path) -> Result<Self> {
        let conn = Connection::open(path)
            .with_context(|| format!("opening sqlite db at {}", path.display()))?;
        conn.pragma_update(None, "journal_mode", "WAL")
            .with_context(|| format!("setting journal_mode=WAL on {}", path.display()))?;
        conn.pragma_update(None, "synchronous", "NORMAL")
            .with_context(|| format!("setting synchronous=NORMAL on {}", path.display()))?;
        conn.pragma_update(None, "cache_size", -8_000)
            .with_context(|| format!("setting cache_size on {}", path.display()))?;
        conn.pragma_update(None, "temp_store", "MEMORY")
            .with_context(|| format!("setting temp_store on {}", path.display()))?;
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS workspaces (
                path TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                added_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS sessions (
                id INTEGER PRIMARY KEY,
                agent TEXT NOT NULL,
                project_dir TEXT NOT NULL,
                cwd TEXT NOT NULL,
                state TEXT NOT NULL,
                exit_code INTEGER,
                created_at INTEGER NOT NULL,
                ended_at INTEGER
            );",
        )?;
        add_column_if_missing(&conn, "sessions", "title", "title TEXT")?;
        add_column_if_missing(&conn, "sessions", "codename", "codename TEXT")?;
        add_column_if_missing(&conn, "sessions", "title_source", "title_source TEXT")?;
        add_column_if_missing(&conn, "sessions", "detected_agent", "detected_agent TEXT")?;
        add_column_if_missing(&conn, "sessions", "ssh_host", "ssh_host TEXT")?;
        add_column_if_missing(&conn, "sessions", "spawned_by", "spawned_by INTEGER")?;
        add_column_if_missing(&conn, "sessions", "acp", "acp TEXT")?;
        add_column_if_missing(&conn, "sessions", "profile_label", "profile_label TEXT")?;
        add_column_if_missing(&conn, "sessions", "approval_mode", "approval_mode TEXT")?;
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS tags (
                id INTEGER PRIMARY KEY,
                name TEXT NOT NULL COLLATE NOCASE UNIQUE,
                color TEXT NOT NULL,
                created_at INTEGER NOT NULL
            );",
        )?;
        add_column_if_missing(&conn, "sessions", "tags", "tags TEXT NOT NULL DEFAULT '[]'")?;
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS ssh_profiles (
                name TEXT PRIMARY KEY,
                host TEXT NOT NULL,
                port INTEGER NOT NULL,
                user TEXT NOT NULL,
                auth_kind TEXT NOT NULL,
                identity_file TEXT,
                created_at INTEGER NOT NULL
            );",
        )?;
        add_column_if_missing(&conn, "ssh_profiles", "default_dir", "default_dir TEXT")?;
        add_column_if_missing(&conn, "ssh_profiles", "startup_cmd", "startup_cmd TEXT")?;
        add_column_if_missing(
            &conn,
            "ssh_profiles",
            "last_used_at",
            "last_used_at INTEGER",
        )?;
        add_column_if_missing(
            &conn,
            "ssh_profiles",
            "passphrase_profile",
            "passphrase_profile TEXT",
        )?;
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS tasks (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                workspace TEXT NOT NULL,
                client_key TEXT,
                title TEXT NOT NULL,
                instructions TEXT NOT NULL,
                acceptance TEXT,
                status TEXT NOT NULL,
                priority TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            );
            CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_client_key
                ON tasks(workspace, client_key) WHERE client_key IS NOT NULL;
            CREATE INDEX IF NOT EXISTS idx_tasks_ws ON tasks(workspace, id);
            CREATE TABLE IF NOT EXISTS task_events (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                task_id INTEGER NOT NULL,
                kind TEXT NOT NULL,
                body TEXT,
                created_at INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_task_events ON task_events(task_id, id);",
        )?;
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS settings (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );",
        )?;
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS agent_profiles (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                agent TEXT NOT NULL,
                name TEXT NOT NULL,
                config_dir TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                UNIQUE(agent, name)
            );",
        )?;
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS mcp_managed (
                tool TEXT NOT NULL,
                name TEXT NOT NULL,
                PRIMARY KEY (tool, name)
            );",
        )?;
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS workspace_hooks (
                path TEXT PRIMARY KEY,
                created_file INTEGER NOT NULL,
                created_hooks INTEGER NOT NULL,
                installed_at INTEGER NOT NULL
            );",
        )?;
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS skill_pushes (
                tool TEXT NOT NULL,
                skill TEXT NOT NULL,
                path TEXT NOT NULL,
                pushed_digest TEXT NOT NULL,
                backup_content BLOB,
                pushed_at INTEGER NOT NULL,
                PRIMARY KEY (tool, skill)
            );",
        )?;
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS routines (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                name_folded TEXT NOT NULL,
                prompt TEXT NOT NULL,
                cadence TEXT NOT NULL,
                enabled INTEGER NOT NULL DEFAULT 1,
                workspace_id TEXT,
                engine TEXT NOT NULL DEFAULT 'claude',
                model TEXT,
                effort TEXT,
                next_run_at_ms INTEGER NOT NULL,
                last_run_at_ms INTEGER,
                last_run_session_id INTEGER,
                last_error TEXT,
                revision TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            );
            CREATE UNIQUE INDEX IF NOT EXISTS idx_routines_name
                ON routines(name_folded);
            CREATE TABLE IF NOT EXISTS routine_runs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                routine_id INTEGER NOT NULL,
                trigger TEXT NOT NULL,
                status TEXT NOT NULL,
                session_id INTEGER,
                error TEXT,
                started_at_ms INTEGER NOT NULL,
                ended_at_ms INTEGER
            );
            CREATE INDEX IF NOT EXISTS idx_routine_runs_routine
                ON routine_runs(routine_id, id DESC);",
        )?;
        add_column_if_missing(
            &conn,
            "routines",
            "permission_mode",
            "permission_mode TEXT NOT NULL DEFAULT 'accept_edits'",
        )?;
        add_column_if_missing(
            &conn,
            "routines",
            "isolate",
            "isolate INTEGER NOT NULL DEFAULT 0",
        )?;
        add_column_if_missing(&conn, "routines", "last_outcome", "last_outcome TEXT")?;
        add_column_if_missing(
            &conn,
            "routines",
            "engine",
            "engine TEXT NOT NULL DEFAULT 'claude'",
        )?;
        add_column_if_missing(&conn, "routines", "model", "model TEXT")?;
        add_column_if_missing(&conn, "routines", "effort", "effort TEXT")?;
        // A pre-PR-68 table predates these two; the first-class migration reads
        // them, so they must exist before it runs. Both are dropped again below.
        add_column_if_missing(
            &conn,
            "routines",
            "continue_context",
            "continue_context INTEGER NOT NULL DEFAULT 0",
        )?;
        add_column_if_missing(&conn, "routines", "thread_id", "thread_id INTEGER")?;
        migrate_routines_to_first_class(&conn)?;
        migrate_routines_to_standalone(&conn)?;
        close_stale_routine_runs(&conn)?;
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS command_history (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                workspace TEXT NOT NULL,
                session_id INTEGER NOT NULL,
                cwd TEXT NOT NULL,
                cmd TEXT NOT NULL,
                exit_code INTEGER,
                shell TEXT NOT NULL,
                git_branch TEXT,
                started_at INTEGER NOT NULL,
                ended_at INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_cmdhist_ws ON command_history(workspace, id);",
        )?;
        heal_command_history(&conn);
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS swarms (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                root_dir TEXT NOT NULL,
                goal TEXT NOT NULL,
                status TEXT NOT NULL,
                -- worktree_dir/branch: retained-but-dead to all normal
                -- operation now that the worktree/branch machinery is
                -- removed. Read/written by exactly one
                -- thing — the `strand_legacy_worktree_swarms` boot sweep —
                -- and by nothing else. Declared here too so a brand-new DB
                -- and an `add_column_if_missing`-upgraded one agree on
                -- schema from one CREATE TABLE statement, not two code
                -- paths that can drift out of sync.
                worktree_dir TEXT NOT NULL DEFAULT '',
                branch TEXT NOT NULL DEFAULT '',
                created_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS swarm_agents (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                swarm_id INTEGER NOT NULL,
                label TEXT NOT NULL,
                role TEXT NOT NULL,
                agent TEXT NOT NULL,
                session_id INTEGER,
                auto_approve INTEGER NOT NULL,
                custom_prompt TEXT,
                cmd TEXT,
                status TEXT NOT NULL,
                activity TEXT,
                created_at INTEGER NOT NULL
            );
            CREATE UNIQUE INDEX IF NOT EXISTS idx_swarm_agents_label
                ON swarm_agents(swarm_id, label);
            -- swarm_goals / swarm_tasks are deliberately absent: they backed
            -- the plan board cut on 2026-08-23 with the rest of the HoustonSwarm
            -- ceremony (see the Cuts section of docs/internals/daemon.md), and
            -- nothing has read either table since. The primary goal text swarm_goals
            -- duplicated lives in swarms.goal, the column every reader already
            -- used. Pre-existing databases keep their (unread) tables: dropping
            -- them would delete user rows to save nothing.
            CREATE TABLE IF NOT EXISTS swarm_messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                swarm_id INTEGER NOT NULL,
                sender TEXT NOT NULL,
                recipient TEXT NOT NULL,
                body TEXT NOT NULL,
                kind TEXT NOT NULL,
                created_at INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_swarm_messages
                ON swarm_messages(swarm_id, id);
            CREATE TABLE IF NOT EXISTS swarm_deliveries (
                message_id INTEGER NOT NULL,
                swarm_id INTEGER NOT NULL,
                recipient TEXT NOT NULL,
                consumed INTEGER NOT NULL DEFAULT 0,
                PRIMARY KEY (message_id, recipient)
            );
            CREATE INDEX IF NOT EXISTS idx_swarm_deliveries_pending
                ON swarm_deliveries(swarm_id, recipient, consumed);",
        )?;
        add_column_if_missing(
            &conn,
            "swarms",
            "worktree_dir",
            "worktree_dir TEXT NOT NULL DEFAULT ''",
        )?;
        add_column_if_missing(&conn, "swarms", "branch", "branch TEXT NOT NULL DEFAULT ''")?;
        strand_legacy_worktree_swarms(&conn)?;
        add_column_if_missing(
            &conn,
            "swarms",
            "budget_minutes",
            "budget_minutes INTEGER NOT NULL DEFAULT 0",
        )?;
        add_column_if_missing(&conn, "swarms", "activated_at", "activated_at INTEGER")?;
        add_column_if_missing(&conn, "swarms", "completed_at", "completed_at INTEGER")?;
        conn.execute(
            "UPDATE swarms SET completed_at = COALESCE(
                    (SELECT MAX(m.created_at) FROM swarm_messages m WHERE m.swarm_id = swarms.id),
                    unixepoch())
             WHERE completed_at IS NULL AND status IN ('completed', 'error')",
            [],
        )?;
        add_column_if_missing(
            &conn,
            "swarm_messages",
            "resolvable",
            "resolvable INTEGER NOT NULL DEFAULT 0",
        )?;
        add_column_if_missing(
            &conn,
            "swarm_messages",
            "resolved",
            "resolved INTEGER NOT NULL DEFAULT 0",
        )?;
        add_column_if_missing(
            &conn,
            "swarm_messages",
            "subject_agent",
            "subject_agent INTEGER",
        )?;
        add_column_if_missing(&conn, "swarm_messages", "wire_id", "wire_id TEXT")?;
        conn.execute("DROP INDEX IF EXISTS idx_swarm_messages_wire_id", [])?;
        conn.execute(
            "CREATE UNIQUE INDEX IF NOT EXISTS idx_swarm_messages_swarm_wire_id
                ON swarm_messages(swarm_id, wire_id)",
            [],
        )?;
        add_column_if_missing(
            &conn,
            "swarm_agents",
            "respawn_count",
            "respawn_count INTEGER NOT NULL DEFAULT 0",
        )?;
        add_column_if_missing(
            &conn,
            "swarm_agents",
            "last_activity_at",
            "last_activity_at INTEGER",
        )?;
        add_column_if_missing(&conn, "swarm_agents", "model", "model TEXT")?;
        add_column_if_missing(
            &conn,
            "swarm_agents",
            "plan_mode",
            "plan_mode INTEGER NOT NULL DEFAULT 0",
        )?;
        add_column_if_missing(
            &conn,
            "swarm_agents",
            "native_session_id",
            "native_session_id TEXT",
        )?;
        add_column_if_missing(&conn, "swarm_agents", "config_dir", "config_dir TEXT")?;
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS swarm_plan_events_applied (
                swarm_id INTEGER NOT NULL,
                event_id TEXT NOT NULL,
                applied_at INTEGER NOT NULL,
                PRIMARY KEY (swarm_id, event_id)
            );",
        )?;
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS delegations (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                parent_session INTEGER NOT NULL,
                child_session INTEGER NOT NULL,
                role TEXT,
                state TEXT NOT NULL,
                stalled INTEGER NOT NULL DEFAULT 0,
                brief TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                ended_at INTEGER,
                stop_reason TEXT,
                no_handback_reported INTEGER NOT NULL DEFAULT 0,
                no_handback_suppressed INTEGER NOT NULL DEFAULT 0,
                round INTEGER NOT NULL DEFAULT 1,
                reusable INTEGER NOT NULL DEFAULT 1,
                cleanup_after INTEGER
            );
            CREATE INDEX IF NOT EXISTS delegations_parent ON delegations(parent_session);
            CREATE UNIQUE INDEX IF NOT EXISTS delegations_child ON delegations(child_session);",
        )?;
        add_column_if_missing(
            &conn,
            "delegations",
            "no_handback_reported",
            "no_handback_reported INTEGER NOT NULL DEFAULT 0",
        )?;
        add_column_if_missing(
            &conn,
            "delegations",
            "no_handback_suppressed",
            "no_handback_suppressed INTEGER NOT NULL DEFAULT 0",
        )?;
        add_column_if_missing(
            &conn,
            "delegations",
            "round",
            "round INTEGER NOT NULL DEFAULT 1",
        )?;
        add_column_if_missing(
            &conn,
            "delegations",
            "reusable",
            "reusable INTEGER NOT NULL DEFAULT 1",
        )?;
        add_column_if_missing(
            &conn,
            "delegations",
            "cleanup_after",
            "cleanup_after INTEGER",
        )?;
        // Three timestamps, three meanings: created_at is persisted, delivered_at is sent,
        // confirmed_at is proven — and what "sent" is worth depends on delivered_via, since
        // only paste/operator can prove landing while wait/stop_hook are final on send.
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS pane_inbox (
                id            INTEGER PRIMARY KEY AUTOINCREMENT,
                to_session    INTEGER NOT NULL,
                original_to   INTEGER,
                workspace     TEXT    NOT NULL,
                from_session  INTEGER,
                request_id    INTEGER,
                kind          TEXT    NOT NULL,
                urgent        INTEGER NOT NULL DEFAULT 0,
                summary       TEXT    NOT NULL,
                body          TEXT    NOT NULL,
                artifacts     TEXT    NOT NULL DEFAULT '[]',
                superseded    INTEGER NOT NULL DEFAULT 0,
                provisional   INTEGER NOT NULL DEFAULT 0,
                corrects      INTEGER,
                reason        TEXT,
                created_at    INTEGER NOT NULL,
                ready_at      INTEGER,
                resolved_at   INTEGER,
                reserved_at   INTEGER,
                delivery_id   TEXT,
                delivered_at  INTEGER,
                delivered_via TEXT,
                confirmed_at  INTEGER,
                attempts      INTEGER NOT NULL DEFAULT 0,
                from_codename TEXT,
                from_role     TEXT
            );
            CREATE INDEX IF NOT EXISTS pane_inbox_eligible
                ON pane_inbox(to_session, created_at)
                WHERE delivered_at IS NULL AND resolved_at IS NULL;
            CREATE INDEX IF NOT EXISTS pane_inbox_workspace
                ON pane_inbox(workspace, created_at) WHERE to_session = 0;",
        )?;
        add_column_if_missing(&conn, "pane_inbox", "from_codename", "from_codename TEXT")?;
        add_column_if_missing(&conn, "pane_inbox", "from_role", "from_role TEXT")?;
        migrate_staged_results_into_the_inbox(&conn)?;
        migrate_pending_swarm_mail_into_the_inbox(&conn)?;
        conn.execute(
            "UPDATE pane_inbox
             SET from_codename = COALESCE(
                     from_codename,
                     (SELECT substr(COALESCE(NULLIF(s.codename, ''), NULLIF(s.title, '')), 1, 40)
                        FROM sessions s WHERE s.id = pane_inbox.from_session)
                 ),
                 from_role = COALESCE(
                     from_role,
                     (SELECT substr(d.role, 1, 32)
                        FROM delegations d WHERE d.child_session = pane_inbox.from_session)
                 )
             WHERE from_session IS NOT NULL
               AND (from_codename IS NULL OR from_role IS NULL)",
            [],
        )?;
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    pub fn mark_live_as_interrupted(&self) -> Result<usize> {
        let conn = self.conn.lock().expect("db lock");
        let n = conn.execute(
            "UPDATE sessions SET state = 'interrupted', ended_at = unixepoch()
             WHERE state IN ('running', 'working', 'awaiting_input', 'awaiting_approval')",
            [],
        )?;
        Ok(n)
    }

    pub fn list_interrupted(&self) -> Result<Vec<proto::SessionInfo>> {
        let conn = self.conn.lock().expect("db lock");
        let mut stmt = conn.prepare(
            "SELECT id, agent, project_dir, cwd, title, codename, title_source, detected_agent, ssh_host,
                    (SELECT sa.id FROM swarm_agents sa WHERE sa.session_id = sessions.id),
                    spawned_by, acp, profile_label, tags
             FROM sessions
             WHERE state = 'interrupted' AND agent != 'custom'
                   AND NOT EXISTS (SELECT 1 FROM swarm_agents sa WHERE sa.session_id = sessions.id)
             ORDER BY id",
        )?;
        let rows = stmt
            .query_map([], |r| {
                Ok((
                    r.get::<_, u32>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, String>(3)?,
                    r.get::<_, Option<String>>(4)?.unwrap_or_default(),
                    r.get::<_, Option<String>>(5)?.unwrap_or_default(),
                    r.get::<_, Option<String>>(6)?,
                    r.get::<_, Option<String>>(7)?,
                    r.get::<_, Option<String>>(8)?,
                    r.get::<_, Option<u64>>(9)?,
                    r.get::<_, Option<u32>>(10)?,
                    r.get::<_, Option<String>>(11)?,
                    r.get::<_, Option<String>>(12)?,
                    r.get::<_, String>(13)?,
                ))
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        drop(stmt);
        let mut used: std::collections::HashSet<String> = rows
            .iter()
            .filter_map(|(_, _, _, _, title, codename, _, _, _, _, _, _, _, _)| {
                if codename.is_empty() {
                    (!title.is_empty()).then(|| title.clone())
                } else {
                    Some(codename.clone())
                }
            })
            .collect();
        let mut out = Vec::with_capacity(rows.len());
        for (
            id,
            agent,
            project_dir,
            cwd,
            title,
            mut codename,
            title_source,
            detected,
            ssh_host,
            swarm_agent,
            spawned_by,
            acp,
            profile_label,
            tags_json,
        ) in rows
        {
            if codename.is_empty() && !title.is_empty() {
                if title_source.as_deref() == Some("codename") {
                    codename = title.clone();
                } else {
                    codename = crate::pane_name::pick_codename(&used);
                }
                used.insert(codename.clone());
                if let Err(e) = conn.execute(
                    "UPDATE sessions SET codename = ?2 WHERE id = ?1",
                    rusqlite::params![id, codename],
                ) {
                    tracing::warn!("backfilling the codename for session {id}: {e}");
                }
            }
            match serde_json::from_str::<proto::AgentKind>(&format!("\"{agent}\"")) {
                Ok(kind) => out.push(proto::SessionInfo {
                    id,
                    agent: kind,
                    project_dir,
                    cwd,
                    state: proto::SessionState::Interrupted,
                    title,
                    codename,
                    detected_agent: detected.and_then(|d| {
                        serde_json::from_str::<proto::AgentKind>(&format!("\"{d}\"")).ok()
                    }),
                    hidden: false,
                    ssh_host,
                    restore_deferred: None,
                    status: None,
                    context: None,
                    swarm_agent,
                    spawned_by,
                    acp,
                    live_children: 0,
                    profile_label,
                    children_waiting: 0,
                    delegation: None,
                    inbox_unread: 0,
                    tags: serde_json::from_str(&tags_json)
                        .unwrap_or_else(|e| {
                            tracing::warn!(
                                "session {id} has unreadable tags {tags_json:?}: {e}; restoring with none"
                            );
                            Vec::new()
                        }),
                }),
                Err(_) => tracing::warn!(
                    "session {id} has unknown agent {agent:?} in the db; not restoring it"
                ),
            }
        }
        Ok(out)
    }

    pub fn mark_closed(&self, id: u32) -> Result<()> {
        let conn = self.conn.lock().expect("db lock");
        conn.execute(
            "UPDATE sessions SET state = 'closed' WHERE id = ?1",
            rusqlite::params![id],
        )?;
        Ok(())
    }

    pub fn session_is_closed(&self, id: u32) -> Result<bool> {
        let conn = self.conn.lock().expect("db lock");
        Ok(conn
            .query_row(
                "SELECT state FROM sessions WHERE id = ?1",
                rusqlite::params![id],
                |row| row.get::<_, String>(0),
            )
            .optional()?
            .is_some_and(|state| state == "closed"))
    }

    pub fn next_session_id(&self) -> Result<u32> {
        let conn = self.conn.lock().expect("db lock");
        let max: Option<i64> = conn.query_row("SELECT MAX(id) FROM sessions", [], |r| r.get(0))?;
        Ok((max.unwrap_or(0) as u32) + 1)
    }

    pub fn insert_session(&self, info: &proto::SessionInfo) -> Result<()> {
        self.insert_session_with_title_source(info, None)
    }

    pub fn insert_session_with_title_source(
        &self,
        info: &proto::SessionInfo,
        title_source: Option<&str>,
    ) -> Result<()> {
        let conn = self.conn.lock().expect("db lock");
        conn.execute(
            "INSERT INTO sessions (id, agent, project_dir, cwd, state, title, codename, title_source,
                                   ssh_host, spawned_by, acp, profile_label, tags, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, unixepoch())",
            rusqlite::params![
                info.id,
                serde_json::to_string(&info.agent)?.trim_matches('"'),
                info.project_dir,
                info.cwd,
                state_str(info.state),
                info.title,
                info.codename,
                title_source,
                info.ssh_host,
                info.spawned_by,
                info.acp,
                info.profile_label,
                serde_json::to_string(&info.tags)?,
            ],
        )?;
        Ok(())
    }
    pub fn save_ssh_profile(&self, p: &proto::SshProfile) -> Result<()> {
        let (auth_kind, identity_file, passphrase_profile) = match &p.auth {
            proto::SshAuth::Agent => ("agent", None, None),
            proto::SshAuth::IdentityFile {
                path,
                passphrase_profile,
            } => (
                "identity_file",
                Some(path.as_str()),
                passphrase_profile.as_deref(),
            ),
            proto::SshAuth::Password { .. } => ("password", None, None),
            proto::SshAuth::SshConfig => ("ssh_config", None, None),
        };
        let conn = self.conn.lock().expect("db lock");
        conn.execute(
            "INSERT INTO ssh_profiles
                (name, host, port, user, auth_kind, identity_file, created_at,
                 default_dir, startup_cmd, passphrase_profile)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, unixepoch(), ?7, ?8, ?9)
             ON CONFLICT(name) DO UPDATE SET host = ?2, port = ?3, user = ?4,
                    auth_kind = ?5, identity_file = ?6, default_dir = ?7,
                    startup_cmd = ?8, passphrase_profile = ?9",
            rusqlite::params![
                p.name,
                p.host,
                p.port,
                p.user,
                auth_kind,
                identity_file,
                p.default_dir,
                p.startup_cmd,
                passphrase_profile
            ],
        )?;
        Ok(())
    }

    pub fn delete_ssh_profile(&self, name: &str) -> Result<()> {
        let conn = self.conn.lock().expect("db lock");
        let n = conn.execute(
            "DELETE FROM ssh_profiles WHERE name = ?1",
            rusqlite::params![name],
        )?;
        if n == 0 {
            anyhow::bail!("no ssh profile named {name:?}");
        }
        Ok(())
    }

    pub fn touch_ssh_profile(&self, name: &str) -> Result<()> {
        let conn = self.conn.lock().expect("db lock");
        conn.execute(
            "UPDATE ssh_profiles SET last_used_at = unixepoch() WHERE name = ?1",
            rusqlite::params![name],
        )?;
        Ok(())
    }

    pub fn list_ssh_profiles(&self) -> Result<Vec<proto::SshProfile>> {
        let conn = self.conn.lock().expect("db lock");
        let mut stmt = conn.prepare(
            "SELECT name, host, port, user, auth_kind, identity_file,
                    default_dir, startup_cmd, last_used_at, passphrase_profile
             FROM ssh_profiles ORDER BY name",
        )?;
        let rows = stmt
            .query_map([], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, u16>(2)?,
                    r.get::<_, String>(3)?,
                    r.get::<_, String>(4)?,
                    r.get::<_, Option<String>>(5)?,
                    r.get::<_, Option<String>>(6)?,
                    r.get::<_, Option<String>>(7)?,
                    r.get::<_, Option<i64>>(8)?,
                    r.get::<_, Option<String>>(9)?,
                ))
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        let mut out = Vec::with_capacity(rows.len());
        for (
            name,
            host,
            port,
            user,
            auth_kind,
            identity_file,
            default_dir,
            startup_cmd,
            last_used_at,
            passphrase_profile,
        ) in rows
        {
            let auth = match (auth_kind.as_str(), identity_file) {
                ("agent", _) => proto::SshAuth::Agent,
                ("identity_file", Some(path)) => proto::SshAuth::IdentityFile {
                    path,
                    passphrase_profile,
                },
                ("password", _) => proto::SshAuth::Password {
                    profile: name.clone(),
                },
                ("ssh_config", _) => proto::SshAuth::SshConfig,
                (kind, file) => {
                    tracing::warn!(
                        "ssh profile {name:?} has invalid auth ({kind:?}, {file:?}); skipping"
                    );
                    continue;
                }
            };
            out.push(proto::SshProfile {
                name,
                host,
                port,
                user,
                auth,
                default_dir,
                startup_cmd,
                last_used_at: last_used_at.map(|t| t as u64),
                has_credential: false,
            });
        }
        Ok(out)
    }

    pub fn update_session_detected(&self, id: u32, agent: proto::AgentKind) -> Result<()> {
        let conn = self.conn.lock().expect("db lock");
        let n = conn.execute(
            "UPDATE sessions SET detected_agent = ?2 WHERE id = ?1",
            rusqlite::params![id, serde_json::to_string(&agent)?.trim_matches('"')],
        )?;
        if n == 0 {
            anyhow::bail!("no session row with id {id} to record detected agent {agent:?}");
        }
        Ok(())
    }

    pub fn update_session_title(&self, id: u32, title: &str) -> Result<()> {
        self.update_session_title_with_source(id, title, None)
    }

    pub fn update_session_title_with_source(
        &self,
        id: u32,
        title: &str,
        title_source: Option<&str>,
    ) -> Result<()> {
        let conn = self.conn.lock().expect("db lock");
        let n = conn.execute(
            "UPDATE sessions
             SET title = ?2, title_source = COALESCE(?3, title_source)
             WHERE id = ?1",
            rusqlite::params![id, title, title_source],
        )?;
        if n == 0 {
            anyhow::bail!("no session row with id {id} to rename to {title:?}");
        }
        Ok(())
    }

    pub fn session_title_source(&self, id: u32) -> Result<Option<String>> {
        let conn = self.conn.lock().expect("db lock");
        conn.query_row(
            "SELECT title_source FROM sessions WHERE id = ?1",
            rusqlite::params![id],
            |r| r.get(0),
        )
        .optional()
        .map(|source| source.flatten())
        .map_err(Into::into)
    }

    pub fn update_session_codename(&self, id: u32, codename: &str) -> Result<()> {
        let conn = self.conn.lock().expect("db lock");
        let n = conn.execute(
            "UPDATE sessions SET codename = ?2 WHERE id = ?1",
            rusqlite::params![id, codename],
        )?;
        if n == 0 {
            anyhow::bail!("no session row with id {id} to record codename {codename:?}");
        }
        Ok(())
    }

    pub fn session_codename(&self, id: u32) -> Result<Option<String>> {
        let conn = self.conn.lock().expect("db lock");
        Ok(conn
            .query_row(
                "SELECT COALESCE(NULLIF(codename, ''), NULLIF(title, ''))
                 FROM sessions WHERE id = ?1",
                rusqlite::params![id],
                |r| r.get(0),
            )
            .optional()?)
    }

    pub fn tag_list(&self) -> Result<Vec<proto::TagInfo>> {
        let conn = self.conn.lock().expect("db lock");
        let mut stmt = conn.prepare("SELECT id, name, color FROM tags ORDER BY id")?;
        let rows = stmt
            .query_map([], |r| {
                Ok(proto::TagInfo {
                    id: r.get(0)?,
                    name: r.get(1)?,
                    color: r.get(2)?,
                })
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    pub fn tag_create(&self, name: &str, color: &str) -> Result<proto::TagInfo> {
        let conn = self.conn.lock().expect("db lock");
        conn.execute(
            "INSERT INTO tags (name, color, created_at) VALUES (?1, ?2, unixepoch())",
            rusqlite::params![name, color],
        )
        .map_err(|e| match &e {
            rusqlite::Error::SqliteFailure(m, _)
                if m.code == rusqlite::ErrorCode::ConstraintViolation =>
            {
                anyhow::anyhow!("tag name {name:?} already exists (unique, case-insensitive)")
            }
            _ => anyhow::Error::new(e),
        })?;
        Ok(proto::TagInfo {
            id: conn.last_insert_rowid() as u32,
            name: name.to_string(),
            color: color.to_string(),
        })
    }

    pub fn tag_update(&self, id: u32, name: &str, color: &str) -> Result<()> {
        let conn = self.conn.lock().expect("db lock");
        let n = conn
            .execute(
                "UPDATE tags SET name = ?2, color = ?3 WHERE id = ?1",
                rusqlite::params![id, name, color],
            )
            .map_err(|e| match &e {
                rusqlite::Error::SqliteFailure(m, _)
                    if m.code == rusqlite::ErrorCode::ConstraintViolation =>
                {
                    anyhow::anyhow!("tag name {name:?} already exists (unique, case-insensitive)")
                }
                _ => anyhow::Error::new(e),
            })?;
        if n == 0 {
            anyhow::bail!("no tag row with id {id} to rename to {name:?}");
        }
        Ok(())
    }

    pub fn tag_delete(&self, id: u32) -> Result<Vec<u32>> {
        let mut conn = self.conn.lock().expect("db lock");
        let tx = conn.transaction()?;
        let mut changed = Vec::new();
        {
            let mut stmt = tx.prepare("SELECT id, tags FROM sessions WHERE tags != '[]'")?;
            let mut rows = stmt.query([])?;
            while let Some(row) = rows.next()? {
                let session_id: u32 = row.get(0)?;
                let json: String = row.get(1)?;
                let tags: Vec<u32> = serde_json::from_str(&json).map_err(|e| {
                    anyhow::anyhow!("session {session_id} has unreadable tags {json:?}: {e}")
                })?;
                if !tags.contains(&id) {
                    continue;
                }
                let kept: Vec<u32> = tags.into_iter().filter(|t| *t != id).collect();
                let n = tx.execute(
                    "UPDATE sessions SET tags = ?2 WHERE id = ?1",
                    rusqlite::params![session_id, serde_json::to_string(&kept)?],
                )?;
                if n != 1 {
                    anyhow::bail!(
                        "detaching tag {id} from session {session_id} touched {n} rows (expected 1)"
                    );
                }
                changed.push(session_id);
            }
        }
        tx.execute("DELETE FROM tags WHERE id = ?1", rusqlite::params![id])?;
        tx.commit()?;
        Ok(changed)
    }

    pub fn set_session_tags(&self, id: u32, tags: &[u32]) -> Result<()> {
        let json = serde_json::to_string(tags)?;
        let conn = self.conn.lock().expect("db lock");
        let n = conn.execute(
            "UPDATE sessions SET tags = ?2 WHERE id = ?1",
            rusqlite::params![id, json],
        )?;
        if n == 0 {
            anyhow::bail!("no session row with id {id} to set tags to {tags:?}");
        }
        Ok(())
    }

    pub fn update_session_project_dir(&self, id: u32, project_dir: &str) -> Result<()> {
        let mut conn = self.conn.lock().expect("db lock");
        let tx = conn.transaction()?;
        let n = tx.execute(
            "UPDATE sessions SET project_dir = ?2 WHERE id = ?1",
            rusqlite::params![id, project_dir],
        )?;
        if n == 0 {
            anyhow::bail!("no session row with id {id} to reparent to {project_dir:?}");
        }
        tx.commit()?;
        Ok(())
    }

    pub fn update_session_state(
        &self,
        id: u32,
        state: proto::SessionState,
        exit_code: Option<i32>,
    ) -> Result<()> {
        let conn = self.conn.lock().expect("db lock");
        let ended = !state.is_live();
        conn.execute(
            "UPDATE sessions SET state = ?2, exit_code = COALESCE(?3, exit_code),
                    ended_at = CASE WHEN ?4 THEN unixepoch() ELSE ended_at END
             WHERE id = ?1",
            rusqlite::params![id, state_str(state), exit_code, ended],
        )?;
        Ok(())
    }

    pub fn session_final(&self, id: u32) -> Result<Option<(proto::SessionState, Option<i32>)>> {
        let conn = self.conn.lock().expect("db lock");
        let row = conn
            .query_row(
                "SELECT state, exit_code FROM sessions WHERE id = ?1",
                rusqlite::params![id],
                |r| Ok((r.get::<_, String>(0)?, r.get::<_, Option<i32>>(1)?)),
            )
            .optional()?;
        Ok(row.map(|(s, code)| {
            let state = match s.as_str() {
                "killed" => proto::SessionState::Killed,
                "interrupted" => proto::SessionState::Interrupted,
                "exited" => proto::SessionState::Exited,
                _ => proto::SessionState::Running,
            };
            (state, code)
        }))
    }

    pub fn add_workspace(&self, path: &str, name: &str) -> Result<()> {
        let conn = self.conn.lock().expect("db lock");
        conn.execute(
            "INSERT INTO workspaces (path, name, added_at) VALUES (?1, ?2, unixepoch())
             ON CONFLICT(path) DO NOTHING",
            rusqlite::params![path, name],
        )?;
        Ok(())
    }

    pub fn remove_workspace(&self, path: &str) -> Result<()> {
        let conn = self.conn.lock().expect("db lock");
        let n = conn.execute(
            "DELETE FROM workspaces WHERE path = ?1",
            rusqlite::params![path],
        )?;
        if n == 0 {
            anyhow::bail!("no workspace row with path {path:?} to remove");
        }
        Ok(())
    }

    pub fn rename_workspace(&self, path: &str, name: &str) -> Result<()> {
        let conn = self.conn.lock().expect("db lock");
        let n = conn.execute(
            "UPDATE workspaces SET name = ?2 WHERE path = ?1",
            rusqlite::params![path, name],
        )?;
        if n == 0 {
            anyhow::bail!("no workspace row with path {path:?} to rename");
        }
        Ok(())
    }

    pub fn mcp_managed_names(&self, tool: &str) -> Result<Vec<String>> {
        let conn = self.conn.lock().expect("db lock");
        let mut stmt =
            conn.prepare("SELECT name FROM mcp_managed WHERE tool = ?1 ORDER BY name")?;
        let rows = stmt.query_map([tool], |r| r.get::<_, String>(0))?;
        Ok(rows.filter_map(|r| r.ok()).collect())
    }

    pub fn set_mcp_managed(&self, tool: &str, names: &[String]) -> Result<()> {
        let mut conn = self.conn.lock().expect("db lock");
        let tx = conn.transaction()?;
        tx.execute("DELETE FROM mcp_managed WHERE tool = ?1", [tool])?;
        for name in names {
            tx.execute(
                "INSERT OR REPLACE INTO mcp_managed (tool, name) VALUES (?1, ?2)",
                rusqlite::params![tool, name],
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    pub fn record_skill_push(
        &self,
        tool: &str,
        skill: &str,
        path: &str,
        digest: &str,
        backup_content: Option<&[u8]>,
        pushed_at: i64,
    ) -> Result<()> {
        let conn = self.conn.lock().expect("db lock");
        conn.execute(
            "INSERT INTO skill_pushes (tool, skill, path, pushed_digest, backup_content, pushed_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT(tool, skill) DO UPDATE SET
                 path = ?3, pushed_digest = ?4, backup_content = ?5, pushed_at = ?6",
            rusqlite::params![tool, skill, path, digest, backup_content, pushed_at],
        )?;
        Ok(())
    }

    pub fn skill_push(&self, tool: &str, skill: &str) -> Result<Option<SkillPushRow>> {
        let conn = self.conn.lock().expect("db lock");
        conn.query_row(
            "SELECT tool, skill, path, pushed_digest, backup_content, pushed_at
             FROM skill_pushes WHERE tool = ?1 AND skill = ?2",
            rusqlite::params![tool, skill],
            |r| {
                Ok(SkillPushRow {
                    tool: r.get(0)?,
                    skill: r.get(1)?,
                    path: r.get(2)?,
                    pushed_digest: r.get(3)?,
                    backup_content: r.get(4)?,
                    pushed_at: r.get(5)?,
                })
            },
        )
        .optional()
        .map_err(Into::into)
    }

    pub fn list_skill_pushes(&self) -> Result<Vec<SkillPushRow>> {
        let conn = self.conn.lock().expect("db lock");
        let mut stmt = conn.prepare(
            "SELECT tool, skill, path, pushed_digest, backup_content, pushed_at
             FROM skill_pushes ORDER BY pushed_at DESC",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok(SkillPushRow {
                tool: r.get(0)?,
                skill: r.get(1)?,
                path: r.get(2)?,
                pushed_digest: r.get(3)?,
                backup_content: r.get(4)?,
                pushed_at: r.get(5)?,
            })
        })?;
        Ok(rows.filter_map(|r| r.ok()).collect())
    }

    pub fn delete_skill_push(&self, tool: &str, skill: &str) -> Result<()> {
        let conn = self.conn.lock().expect("db lock");
        conn.execute(
            "DELETE FROM skill_pushes WHERE tool = ?1 AND skill = ?2",
            rusqlite::params![tool, skill],
        )?;
        Ok(())
    }

    pub fn record_workspace_hooks(
        &self,
        path: &str,
        created_file: bool,
        created_hooks: bool,
    ) -> Result<()> {
        let conn = self.conn.lock().expect("db lock");
        conn.execute(
            "INSERT INTO workspace_hooks (path, created_file, created_hooks, installed_at)
             VALUES (?1, ?2, ?3, unixepoch())
             ON CONFLICT(path) DO NOTHING",
            rusqlite::params![path, created_file as i64, created_hooks as i64],
        )?;
        Ok(())
    }

    pub fn workspace_hooks_ownership(&self, path: &str) -> Result<Option<(bool, bool)>> {
        let conn = self.conn.lock().expect("db lock");
        let row = conn
            .query_row(
                "SELECT created_file, created_hooks FROM workspace_hooks WHERE path = ?1",
                rusqlite::params![path],
                |r| Ok((r.get::<_, i64>(0)? != 0, r.get::<_, i64>(1)? != 0)),
            )
            .optional()?;
        Ok(row)
    }

    pub fn delete_workspace_hooks(&self, path: &str) -> Result<()> {
        let conn = self.conn.lock().expect("db lock");
        conn.execute(
            "DELETE FROM workspace_hooks WHERE path = ?1",
            rusqlite::params![path],
        )?;
        Ok(())
    }

    pub fn session_project_dir(&self, id: u32) -> Result<Option<String>> {
        let conn = self.conn.lock().expect("db lock");
        Ok(conn
            .query_row(
                "SELECT project_dir FROM sessions WHERE id = ?1",
                rusqlite::params![id],
                |r| r.get(0),
            )
            .optional()?)
    }

    pub fn session_created_at(&self, id: u32) -> Option<u64> {
        let conn = self.conn.lock().expect("db lock");
        conn.query_row(
            "SELECT created_at FROM sessions WHERE id = ?1",
            rusqlite::params![id],
            |r| r.get::<_, i64>(0),
        )
        .ok()
        .map(|t| t as u64)
    }

    // Rows kept per workspace — the newest survive the prune. Bounds autocomplete
    // latency and DB growth, since command history is regenerable recall, not work.
    pub const COMMAND_HISTORY_CAP: usize = 2000;

    #[allow(clippy::too_many_arguments)]
    pub fn insert_command(
        &self,
        workspace: &str,
        session_id: u32,
        cwd: &str,
        cmd: &str,
        exit_code: Option<i32>,
        shell: &str,
        git_branch: Option<&str>,
        started_at: u64,
        ended_at: u64,
    ) -> Result<()> {
        let (cmd, _) = crate::sanitize::redact_command_secrets(cmd);
        let cmd = cmd.as_str();
        let conn = self.conn.lock().expect("db lock");
        let tx = conn.unchecked_transaction()?;
        tx.prepare_cached(
            "INSERT INTO command_history
             (workspace, session_id, cwd, cmd, exit_code, shell, git_branch, started_at, ended_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        )?
        .execute(rusqlite::params![
            workspace, session_id, cwd, cmd, exit_code, shell, git_branch, started_at, ended_at
        ])?;
        tx.prepare_cached(
            "DELETE FROM command_history WHERE workspace = ?1 AND id <= (
                 SELECT id FROM command_history WHERE workspace = ?1
                 ORDER BY id DESC LIMIT 1 OFFSET ?2
             )",
        )?
        .execute(rusqlite::params![
            workspace,
            Self::COMMAND_HISTORY_CAP as i64
        ])?;
        tx.commit()?;
        Ok(())
    }

    pub fn clear_command_history(&self, workspace: Option<&str>) -> Result<usize> {
        let conn = self.conn.lock().expect("db lock");
        let n = match workspace {
            Some(ws) => conn.execute(
                "DELETE FROM command_history WHERE workspace = ?1",
                rusqlite::params![ws],
            )?,
            None => conn.execute("DELETE FROM command_history", [])?,
        };
        Ok(n)
    }

    pub fn command_history_count(&self, workspace: Option<&str>) -> Result<usize> {
        let conn = self.conn.lock().expect("db lock");
        let n: i64 = match workspace {
            Some(ws) => conn.query_row(
                "SELECT COUNT(*) FROM command_history WHERE workspace = ?1",
                rusqlite::params![ws],
                |r| r.get(0),
            )?,
            None => conn.query_row("SELECT COUNT(*) FROM command_history", [], |r| r.get(0))?,
        };
        Ok(n as usize)
    }

    pub fn get_setting(&self, key: &str) -> Result<Option<String>> {
        let conn = self.conn.lock().expect("db lock");
        let v = conn
            .query_row(
                "SELECT value FROM settings WHERE key = ?1",
                rusqlite::params![key],
                |r| r.get::<_, String>(0),
            )
            .optional()?;
        Ok(v)
    }

    pub fn set_setting(&self, key: &str, value: &str) -> Result<()> {
        let conn = self.conn.lock().expect("db lock");
        conn.execute(
            "INSERT INTO settings (key, value) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = ?2",
            rusqlite::params![key, value],
        )?;
        Ok(())
    }

    pub fn delete_setting(&self, key: &str) -> Result<()> {
        let conn = self.conn.lock().expect("db lock");
        conn.execute(
            "DELETE FROM settings WHERE key = ?1",
            rusqlite::params![key],
        )?;
        Ok(())
    }

    /// The one pull request manually associated with a project directory. The
    /// settings table is already the (key, payload) store, so the association
    /// needs no table of its own; the directory rides in the key.
    fn pull_request_link_key(dir: &str) -> String {
        format!("pull_request_link:{dir}")
    }

    pub fn pull_request_link(&self, dir: &str) -> Result<Option<proto::PullRequestLink>> {
        let Some(raw) = self.get_setting(&Self::pull_request_link_key(dir))? else {
            return Ok(None);
        };
        serde_json::from_str(&raw).map(Some).map_err(|e| {
            anyhow::anyhow!("stored pull request link for {dir:?} is not valid JSON: {e}")
        })
    }

    pub fn set_pull_request_link(&self, dir: &str, link: &proto::PullRequestLink) -> Result<()> {
        let raw = serde_json::to_string(link).map_err(|e| {
            anyhow::anyhow!("serializing pull request #{} for {dir:?}: {e}", link.number)
        })?;
        self.set_setting(&Self::pull_request_link_key(dir), &raw)
    }

    /// Returns the association that was cleared, so the caller can name it.
    pub fn clear_pull_request_link(&self, dir: &str) -> Result<Option<proto::PullRequestLink>> {
        let existing = self.pull_request_link(dir)?;
        self.delete_setting(&Self::pull_request_link_key(dir))?;
        Ok(existing)
    }

    pub fn list_agent_profiles(&self, agent: &str) -> Result<Vec<AgentProfileRow>> {
        let conn = self.conn.lock().expect("db lock");
        let mut stmt = conn.prepare(
            "SELECT id, agent, name, config_dir FROM agent_profiles \
             WHERE agent = ?1 ORDER BY name",
        )?;
        let rows = stmt.query_map(rusqlite::params![agent], |r| {
            Ok(AgentProfileRow {
                id: r.get::<_, i64>(0)? as u32,
                agent: r.get(1)?,
                name: r.get(2)?,
                config_dir: r.get(3)?,
            })
        })?;
        Ok(rows.filter_map(|r| r.ok()).collect())
    }

    pub fn upsert_agent_profile(
        &self,
        id: Option<u32>,
        agent: &str,
        name: &str,
        config_dir: &str,
    ) -> Result<u32> {
        let conn = self.conn.lock().expect("db lock");
        match id {
            Some(id) => {
                conn.execute(
                    "UPDATE agent_profiles SET name = ?2, config_dir = ?3 WHERE id = ?1",
                    rusqlite::params![id, name, config_dir],
                )?;
                Ok(id)
            }
            None => {
                conn.execute(
                    "INSERT INTO agent_profiles (agent, name, config_dir, created_at)
                     VALUES (?1, ?2, ?3, unixepoch())",
                    rusqlite::params![agent, name, config_dir],
                )?;
                Ok(conn.last_insert_rowid() as u32)
            }
        }
    }

    pub fn agent_profile_agent(&self, id: u32) -> Result<Option<String>> {
        let conn = self.conn.lock().expect("db lock");
        Ok(conn
            .query_row(
                "SELECT agent FROM agent_profiles WHERE id = ?1",
                rusqlite::params![id],
                |r| r.get(0),
            )
            .optional()?)
    }

    pub fn delete_agent_profile(&self, id: u32, agent: &str) -> Result<()> {
        let conn = self.conn.lock().expect("db lock");
        conn.execute(
            "DELETE FROM agent_profiles WHERE id = ?1",
            rusqlite::params![id],
        )?;
        let key = format!("active_agent_profile:{agent}");
        let active: Option<String> = conn
            .query_row(
                "SELECT value FROM settings WHERE key = ?1",
                rusqlite::params![key],
                |r| r.get(0),
            )
            .optional()?;
        if active.as_deref() == Some(id.to_string().as_str()) {
            conn.execute(
                "DELETE FROM settings WHERE key = ?1",
                rusqlite::params![key],
            )?;
        }
        Ok(())
    }

    pub fn active_agent_profile(&self, agent: &str) -> Result<Option<AgentProfileRow>> {
        let conn = self.conn.lock().expect("db lock");
        let key = format!("active_agent_profile:{agent}");
        let id: Option<i64> = conn
            .query_row(
                "SELECT value FROM settings WHERE key = ?1",
                rusqlite::params![key],
                |r| r.get::<_, String>(0),
            )
            .optional()?
            .and_then(|v| v.parse::<i64>().ok());
        let Some(id) = id else { return Ok(None) };
        Ok(conn
            .query_row(
                "SELECT id, agent, name, config_dir FROM agent_profiles WHERE id = ?1",
                rusqlite::params![id],
                |r| {
                    Ok(AgentProfileRow {
                        id: r.get::<_, i64>(0)? as u32,
                        agent: r.get(1)?,
                        name: r.get(2)?,
                        config_dir: r.get(3)?,
                    })
                },
            )
            .optional()?)
    }

    pub fn set_active_agent_profile(&self, agent: &str, id: Option<u32>) -> Result<()> {
        let conn = self.conn.lock().expect("db lock");
        let key = format!("active_agent_profile:{agent}");
        match id {
            Some(id) => conn.execute(
                "INSERT INTO settings (key, value) VALUES (?1, ?2)
                 ON CONFLICT(key) DO UPDATE SET value = ?2",
                rusqlite::params![key, id.to_string()],
            )?,
            None => conn.execute(
                "DELETE FROM settings WHERE key = ?1",
                rusqlite::params![key],
            )?,
        };
        Ok(())
    }

    pub fn list_routines(&self) -> Result<Vec<RoutineRow>> {
        let conn = self.conn.lock().expect("db lock");
        let mut stmt = conn.prepare(&format!("{ROUTINE_SELECT} ORDER BY name_folded"))?;
        let rows = stmt
            .query_map([], map_routine_row)?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    pub fn routine(&self, id: u32) -> Result<Option<RoutineRow>> {
        let conn = self.conn.lock().expect("db lock");
        Ok(conn
            .query_row(
                &format!("{ROUTINE_SELECT} WHERE id = ?1"),
                rusqlite::params![id],
                map_routine_row,
            )
            .optional()?)
    }

    /// How many routines exist; `ROUTINES_TOTAL` is the only cap.
    pub fn routine_total_count(&self) -> Result<u32> {
        let conn = self.conn.lock().expect("db lock");
        conn.query_row("SELECT COUNT(*) FROM routines", [], |r| r.get(0))
            .map_err(Into::into)
    }

    pub fn routine_name_taken(&self, name_folded: &str, except: Option<u32>) -> Result<bool> {
        let conn = self.conn.lock().expect("db lock");
        let n: i64 = conn.query_row(
            "SELECT COUNT(*) FROM routines WHERE name_folded = ?1 \
             AND (?2 IS NULL OR id != ?2)",
            rusqlite::params![name_folded, except],
            |r| r.get(0),
        )?;
        Ok(n > 0)
    }

    pub fn create_routine(&self, w: &RoutineWrite<'_>) -> Result<u32> {
        let conn = self.conn.lock().expect("db lock");
        conn.execute(
            "INSERT INTO routines
                (name, name_folded, prompt, cadence, enabled, workspace_id,
                 engine, model, effort, next_run_at_ms, revision, permission_mode, isolate,
                 created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, \
                     unixepoch(), unixepoch())",
            rusqlite::params![
                w.name,
                w.name_folded,
                w.prompt,
                w.cadence_json,
                w.enabled as i64,
                w.workspace_id,
                w.engine,
                w.model,
                w.effort,
                w.next_run_at_ms,
                w.revision,
                w.permission_mode,
                w.isolate as i64,
            ],
        )?;
        Ok(conn.last_insert_rowid() as u32)
    }

    pub fn update_routine(&self, id: u32, w: &RoutineWrite<'_>) -> Result<bool> {
        let conn = self.conn.lock().expect("db lock");
        let changed = conn.execute(
            "UPDATE routines SET
                name = ?2, name_folded = ?3, prompt = ?4, cadence = ?5, enabled = ?6,
                workspace_id = ?7, engine = ?8, model = ?9, effort = ?10,
                next_run_at_ms = ?11, revision = ?12, permission_mode = ?13, isolate = ?14,
                updated_at = unixepoch()
             WHERE id = ?1",
            rusqlite::params![
                id,
                w.name,
                w.name_folded,
                w.prompt,
                w.cadence_json,
                w.enabled as i64,
                w.workspace_id,
                w.engine,
                w.model,
                w.effort,
                w.next_run_at_ms,
                w.revision,
                w.permission_mode,
                w.isolate as i64,
            ],
        )?;
        Ok(changed > 0)
    }

    pub fn routines_due(&self, now_ms: i64) -> Result<Vec<RoutineRow>> {
        let conn = self.conn.lock().expect("db lock");
        let mut stmt = conn.prepare(&format!(
            "{ROUTINE_SELECT} WHERE enabled = 1 AND next_run_at_ms <= ?1 \
             ORDER BY next_run_at_ms, id"
        ))?;
        let rows = stmt
            .query_map(rusqlite::params![now_ms], map_routine_row)?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    pub fn next_enabled_routine_run_at(&self) -> Result<Option<i64>> {
        let conn = self.conn.lock().expect("db lock");
        conn.query_row(
            "SELECT MIN(next_run_at_ms) FROM routines WHERE enabled = 1",
            [],
            |row| row.get(0),
        )
        .map_err(Into::into)
    }

    pub fn enabled_routine_count(&self) -> Result<u32> {
        let conn = self.conn.lock().expect("db lock");
        conn.query_row("SELECT COUNT(*) FROM routines WHERE enabled = 1", [], |r| {
            r.get(0)
        })
        .map_err(Into::into)
    }

    pub fn record_routine_run_start(
        &self,
        id: u32,
        session_id: Option<u32>,
        at_ms: i64,
        next_run_at_ms: i64,
    ) -> Result<bool> {
        let conn = self.conn.lock().expect("db lock");
        let n = conn.execute(
            "UPDATE routines SET
                last_run_at_ms = ?2,
                last_run_session_id = ?3,
                next_run_at_ms = ?4,
                updated_at = unixepoch()
             WHERE id = ?1",
            rusqlite::params![id, at_ms, session_id, next_run_at_ms],
        )?;
        Ok(n > 0)
    }

    pub fn record_routine_run_end(
        &self,
        id: u32,
        outcome: proto::RoutineOutcome,
        error: Option<&str>,
    ) -> Result<bool> {
        let conn = self.conn.lock().expect("db lock");
        let n = conn.execute(
            "UPDATE routines SET last_outcome = ?2, last_error = ?3, updated_at = unixepoch() \
             WHERE id = ?1",
            rusqlite::params![id, wire_name(&outcome)?, error],
        )?;
        Ok(n > 0)
    }

    const ROUTINE_RUN_SELECT: &'static str = "SELECT id, routine_id, trigger, status, session_id, \
        error, started_at_ms, ended_at_ms FROM routine_runs";

    fn map_routine_run_row(r: &rusqlite::Row) -> rusqlite::Result<RoutineRunRow> {
        let id: u32 = r.get(0)?;
        let trigger_raw: String = r.get(2)?;
        let status_raw: String = r.get(3)?;
        let trigger = from_wire::<proto::RoutineTrigger>(&trigger_raw).ok_or_else(|| {
            rusqlite::Error::FromSqlConversionFailure(
                2,
                rusqlite::types::Type::Text,
                format!(
                    "routine_runs {id} has unknown trigger {trigger_raw:?} (expected a \
                     RoutineTrigger wire name)"
                )
                .into(),
            )
        })?;
        let status = from_wire::<proto::RoutineRunStatus>(&status_raw).ok_or_else(|| {
            rusqlite::Error::FromSqlConversionFailure(
                3,
                rusqlite::types::Type::Text,
                format!(
                    "routine_runs {id} has unknown status {status_raw:?} (expected a \
                     RoutineRunStatus wire name)"
                )
                .into(),
            )
        })?;
        Ok(RoutineRunRow {
            id,
            routine_id: r.get(1)?,
            trigger,
            status,
            session_id: r.get(4)?,
            error: r.get(5)?,
            started_at_ms: r.get(6)?,
            ended_at_ms: r.get(7)?,
        })
    }

    pub fn create_routine_run(
        &self,
        routine_id: u32,
        trigger: proto::RoutineTrigger,
        started_at_ms: i64,
    ) -> Result<u32> {
        let conn = self.conn.lock().expect("db lock");
        conn.execute(
            "INSERT INTO routine_runs
                (routine_id, trigger, status, started_at_ms)
             VALUES (?1, ?2, ?3, ?4)",
            rusqlite::params![
                routine_id,
                wire_name(&trigger)?,
                wire_name(&proto::RoutineRunStatus::Running)?,
                started_at_ms,
            ],
        )?;
        Ok(conn.last_insert_rowid() as u32)
    }

    pub fn set_routine_run_session(&self, run_id: u32, session_id: u32) -> Result<bool> {
        let conn = self.conn.lock().expect("db lock");
        let changed = conn.execute(
            "UPDATE routine_runs SET session_id = ?2 WHERE id = ?1",
            rusqlite::params![run_id, session_id],
        )?;
        Ok(changed > 0)
    }

    pub fn finish_routine_run(
        &self,
        run_id: u32,
        status: proto::RoutineRunStatus,
        error: Option<&str>,
        ended_at_ms: i64,
    ) -> Result<bool> {
        let conn = self.conn.lock().expect("db lock");
        let changed = conn.execute(
            "UPDATE routine_runs SET status = ?2, error = ?3, ended_at_ms = ?4 WHERE id = ?1",
            rusqlite::params![run_id, wire_name(&status)?, error, ended_at_ms],
        )?;
        Ok(changed > 0)
    }

    pub fn routine_run(&self, run_id: u32) -> Result<Option<RoutineRunRow>> {
        let conn = self.conn.lock().expect("db lock");
        Ok(conn
            .query_row(
                &format!("{} WHERE id = ?1", Self::ROUTINE_RUN_SELECT),
                rusqlite::params![run_id],
                Self::map_routine_run_row,
            )
            .optional()?)
    }

    /// Newest first. `routine_id` absent lists the latest runs of every
    /// routine; `limit` is the caller's `ROUTINE_RUNS_PAGE`.
    pub fn list_routine_runs(
        &self,
        routine_id: Option<u32>,
        limit: u32,
    ) -> Result<Vec<RoutineRunRow>> {
        let conn = self.conn.lock().expect("db lock");
        let mut stmt = conn.prepare(&match routine_id {
            Some(_) => format!(
                "{} WHERE routine_id = ?1 ORDER BY id DESC LIMIT ?2",
                Self::ROUTINE_RUN_SELECT
            ),
            None => format!("{} ORDER BY id DESC LIMIT ?1", Self::ROUTINE_RUN_SELECT),
        })?;
        let rows = match routine_id {
            Some(id) => stmt
                .query_map(rusqlite::params![id, limit], Self::map_routine_run_row)?
                .collect::<std::result::Result<Vec<_>, _>>()?,
            None => stmt
                .query_map(rusqlite::params![limit], Self::map_routine_run_row)?
                .collect::<std::result::Result<Vec<_>, _>>()?,
        };
        Ok(rows)
    }

    pub fn routine_by_run_session(&self, session_id: u32) -> Result<Option<RoutineRow>> {
        let conn = self.conn.lock().expect("db lock");
        Ok(conn
            .query_row(
                &format!("{ROUTINE_SELECT} WHERE last_run_session_id = ?1"),
                rusqlite::params![session_id],
                map_routine_row,
            )
            .optional()?)
    }

    pub fn delete_routine(&self, id: u32) -> Result<bool> {
        let conn = self.conn.lock().expect("db lock");
        let changed = conn.execute("DELETE FROM routines WHERE id = ?1", rusqlite::params![id])?;
        Ok(changed > 0)
    }

    pub fn delegation_create(
        &self,
        parent: u32,
        child: u32,
        role: Option<&str>,
        brief: &str,
        now: u64,
    ) -> Result<i64> {
        // Rows created before lifecycle was exposed remain reusable. This keeps
        // restored delegations from being closed merely because they predate the
        // temporary-child default.
        self.delegation_create_with_lifecycle(parent, child, role, brief, true, now)
    }

    pub fn delegation_create_with_lifecycle(
        &self,
        parent: u32,
        child: u32,
        role: Option<&str>,
        brief: &str,
        reusable: bool,
        now: u64,
    ) -> Result<i64> {
        let conn = self.conn.lock().expect("db lock");
        conn.execute(
            "INSERT INTO delegations
                (parent_session, child_session, role, state, brief, created_at, updated_at, round,
                 reusable, cleanup_after)
             VALUES (?1, ?2, ?5, 'spawning', ?3, ?4, ?4, 1, ?6, NULL)
             ON CONFLICT(child_session) DO UPDATE SET
                parent_session = ?1, role = ?5, state = 'spawning', stalled = 0,
                brief = ?3, updated_at = ?4, ended_at = NULL, stop_reason = NULL, round = 1,
                reusable = ?6, cleanup_after = NULL",
            rusqlite::params![parent, child, brief, now as i64, role, reusable as i64],
        )?;
        Ok(conn.query_row(
            "SELECT id FROM delegations WHERE child_session = ?1",
            rusqlite::params![child],
            |r| r.get(0),
        )?)
    }

    pub fn delegation_for_child(&self, child: u32) -> Result<Option<DelegationRow>> {
        let conn = self.conn.lock().expect("db lock");
        Ok(conn
            .query_row(
                &format!("{DELEGATION_SELECT} WHERE child_session = ?1"),
                rusqlite::params![child],
                map_delegation_row,
            )
            .optional()?)
    }

    pub fn delegation_parent_of(&self, child: u32) -> Result<Option<u32>> {
        let conn = self.conn.lock().expect("db lock");
        Ok(conn
            .query_row(
                "SELECT parent_session FROM delegations WHERE child_session = ?1",
                rusqlite::params![child],
                |r| r.get(0),
            )
            .optional()?)
    }

    pub fn delegations_for_parent(&self, parent: u32) -> Result<Vec<DelegationRow>> {
        let conn = self.conn.lock().expect("db lock");
        let mut stmt = conn.prepare(&format!(
            "{DELEGATION_SELECT} WHERE parent_session = ?1 ORDER BY id"
        ))?;
        let rows = stmt
            .query_map(rusqlite::params![parent], map_delegation_row)?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    pub fn delegation_set_state(&self, child: u32, state: &str, now: u64) -> Result<()> {
        let conn = self.conn.lock().expect("db lock");
        conn.execute(
            "UPDATE delegations SET state = ?2, cleanup_after = NULL, updated_at = ?3
             WHERE child_session = ?1",
            rusqlite::params![child, state, now as i64],
        )?;
        Ok(())
    }

    pub fn delegation_reopen(&self, child: u32, state: &str, now: u64) -> Result<()> {
        let conn = self.conn.lock().expect("db lock");
        conn.execute(
            "UPDATE delegations SET
                state = ?2, stop_reason = NULL, ended_at = NULL,
                no_handback_reported = 0, no_handback_suppressed = 0, updated_at = ?3,
                round = round + 1, cleanup_after = NULL
             WHERE child_session = ?1",
            rusqlite::params![child, state, now as i64],
        )?;
        Ok(())
    }

    pub fn delegation_round(&self, child: u32) -> Result<Option<u32>> {
        let conn = self.conn.lock().expect("db lock");
        Ok(conn
            .query_row(
                "SELECT round FROM delegations WHERE child_session = ?1",
                rusqlite::params![child],
                |r| r.get::<_, i64>(0),
            )
            .optional()?
            .map(|v| v as u32))
    }

    pub fn delegation_set_stalled(&self, child: u32, stalled: bool, now: u64) -> Result<()> {
        let conn = self.conn.lock().expect("db lock");
        conn.execute(
            "UPDATE delegations SET stalled = ?2, updated_at = ?3 WHERE child_session = ?1",
            rusqlite::params![child, stalled as i64, now as i64],
        )?;
        Ok(())
    }

    pub fn delegation_set_no_handback(
        &self,
        child: u32,
        reported: bool,
        suppressed: u32,
        now: u64,
    ) -> Result<()> {
        let conn = self.conn.lock().expect("db lock");
        conn.execute(
            "UPDATE delegations SET
                no_handback_reported = ?2, no_handback_suppressed = ?3, updated_at = ?4
             WHERE child_session = ?1",
            rusqlite::params![child, reported as i64, suppressed, now as i64],
        )?;
        Ok(())
    }

    pub fn delegation_finish(
        &self,
        child: u32,
        state: &str,
        stop_reason: Option<&str>,
        now: u64,
    ) -> Result<()> {
        let conn = self.conn.lock().expect("db lock");
        conn.execute(
            "UPDATE delegations SET state = ?2, stop_reason = ?3, ended_at = ?4, updated_at = ?4,
                no_handback_reported = 0, no_handback_suppressed = 0, cleanup_after = NULL
             WHERE child_session = ?1",
            rusqlite::params![child, state, stop_reason, now as i64],
        )?;
        Ok(())
    }

    pub fn delegations_open(&self) -> Result<Vec<DelegationRow>> {
        let conn = self.conn.lock().expect("db lock");
        let mut stmt = conn.prepare(&format!(
            "{DELEGATION_SELECT} WHERE state NOT IN ('done', 'failed', 'cancelled', 'unknown') \
             ORDER BY id"
        ))?;
        let rows = stmt
            .query_map([], map_delegation_row)?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    pub fn delegations_cleanup_due(&self, now: u64) -> Result<Vec<DelegationRow>> {
        let conn = self.conn.lock().expect("db lock");
        let mut stmt = conn.prepare(&format!(
            "{DELEGATION_SELECT} WHERE reusable = 0 AND state = 'done'
             AND cleanup_after IS NOT NULL AND cleanup_after <= ?1 ORDER BY id"
        ))?;
        let rows = stmt
            .query_map(rusqlite::params![now as i64], map_delegation_row)?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    pub fn delegations_cleanup_pending(&self) -> Result<bool> {
        let conn = self.conn.lock().expect("db lock");
        let pending: i64 = conn.query_row(
            "SELECT EXISTS(
                 SELECT 1 FROM delegations
                 WHERE reusable = 0 AND state = 'done' AND cleanup_after IS NOT NULL
             )",
            [],
            |r| r.get(0),
        )?;
        Ok(pending != 0)
    }

    pub fn delegation_set_cleanup_after(
        &self,
        child: u32,
        cleanup_after: Option<u64>,
        now: u64,
    ) -> Result<()> {
        let conn = self.conn.lock().expect("db lock");
        conn.execute(
            "UPDATE delegations SET cleanup_after = ?2, updated_at = ?3
             WHERE child_session = ?1",
            rusqlite::params![child, cleanup_after.map(|t| t as i64), now as i64],
        )?;
        Ok(())
    }

    pub fn inbox_reserve(
        &self,
        to_session: u32,
        now: u64,
        max_rows: u32,
        max_bytes: usize,
    ) -> Result<Option<(String, Vec<InboxRow>)>> {
        self.inbox_reserve_matching(to_session, now, max_rows, max_bytes, None, None)
    }

    pub fn inbox_reserve_matching(
        &self,
        to_session: u32,
        now: u64,
        max_rows: u32,
        max_bytes: usize,
        from_session: Option<u32>,
        kind: Option<&str>,
    ) -> Result<Option<(String, Vec<InboxRow>)>> {
        let conn = self.conn.lock().expect("db lock");
        let now_i = now as i64;
        let cutoff = now_i - crate::orchestrate::INBOX_RESERVATION_MS as i64;
        let mut sql = format!(
            "{INBOX_SELECT} WHERE to_session = ?1 AND ready_at IS NOT NULL AND ready_at <= ?2 \
             AND delivered_at IS NULL AND resolved_at IS NULL \
             AND {INBOX_UNRESERVED_OR_EXPIRED}"
        );
        let mut params: Vec<rusqlite::types::Value> = vec![
            rusqlite::types::Value::Integer(to_session as i64),
            rusqlite::types::Value::Integer(now_i),
            rusqlite::types::Value::Integer(cutoff),
        ];
        if let Some(from) = from_session {
            sql.push_str(&format!(" AND from_session = ?{}", params.len() + 1));
            params.push(rusqlite::types::Value::Integer(from as i64));
        }
        if let Some(k) = kind {
            sql.push_str(&format!(
                " AND (kind = ?{} OR urgent = 1)",
                params.len() + 1
            ));
            params.push(rusqlite::types::Value::Text(k.to_string()));
        }
        sql.push_str(" ORDER BY created_at, id");
        let candidates = {
            let mut stmt = conn.prepare(&sql)?;
            let rows = stmt
                .query_map(rusqlite::params_from_iter(params.iter()), map_inbox_row)?
                .collect::<std::result::Result<Vec<_>, _>>()?;
            rows
        };
        if candidates.is_empty() {
            return Ok(None);
        }
        let mut chosen = Vec::new();
        let mut bytes = 0usize;
        for row in candidates {
            if !chosen.is_empty() {
                if chosen.len() as u32 >= max_rows {
                    break;
                }
                let row_bytes = row.summary.len() + row.body.len();
                if bytes + row_bytes > max_bytes {
                    break;
                }
                bytes += row_bytes;
            } else {
                bytes += row.summary.len() + row.body.len();
            }
            chosen.push(row);
        }
        let delivery_id = uuid::Uuid::new_v4().to_string();
        let ids: Vec<i64> = chosen.iter().map(|r| r.id).collect();
        let placeholders = ids.iter().map(|_| "?").collect::<Vec<_>>().join(",");
        let sql = format!(
            "UPDATE pane_inbox SET reserved_at = ?, delivery_id = ?, attempts = attempts + 1
             WHERE id IN ({placeholders}) AND ready_at IS NOT NULL AND ready_at <= ? \
             AND delivered_at IS NULL AND resolved_at IS NULL \
             AND {INBOX_UNRESERVED_OR_EXPIRED}"
        );
        let mut params: Vec<rusqlite::types::Value> = vec![
            rusqlite::types::Value::Integer(now_i),
            rusqlite::types::Value::Text(delivery_id.clone()),
        ];
        params.extend(ids.iter().map(|id| rusqlite::types::Value::Integer(*id)));
        params.push(rusqlite::types::Value::Integer(now_i));
        params.push(rusqlite::types::Value::Integer(cutoff));
        conn.execute(&sql, rusqlite::params_from_iter(params.iter()))?;
        for row in &mut chosen {
            row.reserved_at = Some(now);
            row.delivery_id = Some(delivery_id.clone());
            row.attempts += 1;
        }
        Ok(Some((delivery_id, chosen)))
    }

    pub fn inbox_count_matching(
        &self,
        to_session: u32,
        now: u64,
        from_session: Option<u32>,
        kind: Option<&str>,
    ) -> Result<u32> {
        let conn = self.conn.lock().expect("db lock");
        let now_i = now as i64;
        let cutoff = now_i - crate::orchestrate::INBOX_RESERVATION_MS as i64;
        let mut sql = format!(
            "SELECT COUNT(*) FROM pane_inbox \
             WHERE to_session = ?1 AND ready_at IS NOT NULL AND ready_at <= ?2 \
             AND delivered_at IS NULL AND resolved_at IS NULL \
             AND {INBOX_UNRESERVED_OR_EXPIRED}"
        );
        let mut params: Vec<rusqlite::types::Value> = vec![
            rusqlite::types::Value::Integer(to_session as i64),
            rusqlite::types::Value::Integer(now_i),
            rusqlite::types::Value::Integer(cutoff),
        ];
        if let Some(from) = from_session {
            sql.push_str(&format!(" AND from_session = ?{}", params.len() + 1));
            params.push(rusqlite::types::Value::Integer(from as i64));
        }
        if let Some(k) = kind {
            sql.push_str(&format!(
                " AND (kind = ?{} OR urgent = 1)",
                params.len() + 1
            ));
            params.push(rusqlite::types::Value::Text(k.to_string()));
        }
        Ok(
            conn.query_row(&sql, rusqlite::params_from_iter(params.iter()), |r| {
                r.get::<_, i64>(0)
            })? as u32,
        )
    }

    pub fn inbox_mark_delivered(&self, delivery_id: &str, via: &str, now: u64) -> Result<usize> {
        let conn = self.conn.lock().expect("db lock");
        Ok(conn.execute(
            "UPDATE pane_inbox SET delivered_at = ?2, delivered_via = ?3
             WHERE delivery_id = ?1 AND delivered_at IS NULL",
            rusqlite::params![delivery_id, now as i64, via],
        )?)
    }

    pub fn inbox_confirm(&self, delivery_id: &str, now: u64) -> Result<usize> {
        let conn = self.conn.lock().expect("db lock");
        Ok(conn.execute(
            "UPDATE pane_inbox SET confirmed_at = ?2
             WHERE delivery_id = ?1 AND delivered_at IS NOT NULL",
            rusqlite::params![delivery_id, now as i64],
        )?)
    }

    pub fn inbox_rows_by_delivery(&self, delivery_id: &str) -> Result<Vec<InboxRow>> {
        let conn = self.conn.lock().expect("db lock");
        let mut stmt = conn.prepare(&format!("{INBOX_SELECT} WHERE delivery_id = ?1"))?;
        let rows = stmt
            .query_map(rusqlite::params![delivery_id], map_inbox_row)?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    pub fn inbox_resolve(&self, id: i64, reason: &str, now: u64) -> Result<usize> {
        let conn = self.conn.lock().expect("db lock");
        Ok(conn.execute(
            "UPDATE pane_inbox SET resolved_at = ?2, reason = ?3 WHERE id = ?1 AND resolved_at IS NULL",
            rusqlite::params![id, now as i64, reason],
        )?)
    }

    pub fn inbox_get(&self, id: i64) -> Result<Option<InboxRow>> {
        let conn = self.conn.lock().expect("db lock");
        Ok(conn
            .query_row(
                &format!("{INBOX_SELECT} WHERE id = ?1"),
                rusqlite::params![id],
                map_inbox_row,
            )
            .optional()?)
    }

    pub fn inbox_readdress_to_operator(&self, id: i64, reason: &str) -> Result<()> {
        let conn = self.conn.lock().expect("db lock");
        conn.execute(
            "UPDATE pane_inbox SET original_to = to_session, to_session = 0, reason = ?2,
                reserved_at = NULL, delivery_id = NULL
             WHERE id = ?1",
            rusqlite::params![id, reason],
        )?;
        Ok(())
    }

    // Boot recovery: release every reservation (the door that held it is gone) and requeue
    // only unconfirmed paste/operator rows, whose landing the daemon cannot prove — while
    // wait/stop_hook are final the moment they were sent and stay untouched.
    pub fn inbox_recover_after_restart(&self, live_sessions: &[u32]) -> Result<InboxRecovery> {
        let conn = self.conn.lock().expect("db lock");
        let reservations_released = conn.execute(
            "UPDATE pane_inbox SET reserved_at = NULL, delivery_id = NULL WHERE reserved_at IS NOT NULL",
            [],
        )? as u32;
        let pastes_requeued = conn.execute(
            "UPDATE pane_inbox SET delivered_at = NULL, delivered_via = NULL, delivery_id = NULL
             WHERE delivered_via = 'paste' AND confirmed_at IS NULL",
            [],
        )? as u32;
        let operator_requeued = conn.execute(
            "UPDATE pane_inbox SET delivered_at = NULL, delivered_via = NULL
             WHERE delivered_via = 'operator' AND confirmed_at IS NULL",
            [],
        )? as u32;
        let live_list = if live_sessions.is_empty() {
            "-1".to_string()
        } else {
            live_sessions
                .iter()
                .map(|s| s.to_string())
                .collect::<Vec<_>>()
                .join(",")
        };
        let dead_parent_ids: Vec<i64> = {
            let sql = format!(
                "SELECT id FROM pane_inbox
                 WHERE delivered_at IS NULL AND resolved_at IS NULL
                       AND to_session != 0 AND to_session NOT IN ({live_list})"
            );
            let mut stmt = conn.prepare(&sql)?;
            let ids = stmt
                .query_map([], |r| r.get(0))?
                .collect::<std::result::Result<Vec<_>, _>>()?;
            ids
        };
        let readdressed = dead_parent_ids.len() as u32;
        for id in dead_parent_ids {
            conn.execute(
                "UPDATE pane_inbox SET original_to = to_session, to_session = 0, reason = 'parent_dead',
                    reserved_at = NULL, delivery_id = NULL
                 WHERE id = ?1",
                rusqlite::params![id],
            )?;
        }
        Ok(InboxRecovery {
            reservations_released,
            pastes_requeued,
            operator_requeued,
            readdressed,
        })
    }

    pub fn inbox_list_operator(&self, workspace: &str) -> Result<Vec<InboxRow>> {
        let conn = self.conn.lock().expect("db lock");
        let mut stmt = conn.prepare(&format!(
            "{INBOX_SELECT} WHERE to_session = 0 AND workspace = ?1 ORDER BY created_at, id"
        ))?;
        let rows = stmt
            .query_map(rusqlite::params![workspace], map_inbox_row)?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    pub fn inbox_list_for_session(&self, to_session: u32) -> Result<Vec<InboxRow>> {
        let conn = self.conn.lock().expect("db lock");
        let mut stmt = conn.prepare(&format!(
            "{INBOX_SELECT} WHERE to_session = ?1 ORDER BY created_at, id"
        ))?;
        let rows = stmt
            .query_map(rusqlite::params![to_session], map_inbox_row)?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    pub fn inbox_pending_count(&self, to_session: u32) -> Result<u32> {
        let conn = self.conn.lock().expect("db lock");
        Ok(conn.query_row(
            "SELECT COUNT(*) FROM pane_inbox
             WHERE to_session = ?1 AND delivered_at IS NULL AND resolved_at IS NULL",
            rusqlite::params![to_session],
            |r| r.get::<_, i64>(0),
        )? as u32)
    }

    pub fn inbox_ack_operator(&self, id: i64, now: u64) -> Result<bool> {
        let conn = self.conn.lock().expect("db lock");
        let changed = conn.execute(
            "UPDATE pane_inbox SET delivered_at = ?2, delivered_via = 'operator', confirmed_at = ?2
             WHERE id = ?1 AND to_session = 0",
            rusqlite::params![id, now as i64],
        )?;
        Ok(changed > 0)
    }

    pub fn inbox_insert(&self, row: &NewInboxRow, now: u64) -> Result<i64> {
        let conn = self.conn.lock().expect("db lock");
        insert_inbox_row(&conn, row, now)
    }

    pub fn inbox_release(&self, delivery_id: &str) -> Result<usize> {
        let conn = self.conn.lock().expect("db lock");
        Ok(conn.execute(
            "UPDATE pane_inbox SET reserved_at = NULL, delivery_id = NULL
             WHERE delivery_id = ?1 AND delivered_at IS NULL",
            rusqlite::params![delivery_id],
        )?)
    }

    pub fn inbox_prune_operator(&self, max_rows: u32) -> Result<usize> {
        let conn = self.conn.lock().expect("db lock");
        let total: i64 = conn.query_row(
            "SELECT COUNT(*) FROM pane_inbox WHERE to_session = 0",
            [],
            |r| r.get(0),
        )?;
        let over = total - i64::from(max_rows);
        if over <= 0 {
            return Ok(0);
        }
        Ok(conn.execute(
            "DELETE FROM pane_inbox WHERE id IN (
                 SELECT id FROM pane_inbox
                 WHERE to_session = 0 AND confirmed_at IS NOT NULL
                 ORDER BY created_at, id LIMIT ?1
             )",
            rusqlite::params![over],
        )?)
    }

    // Age counts from the door's own notion of finished: delivered_at for the doors final
    // on send, confirmed_at for those proven only once confirmed. A row with neither was
    // never delivered and is never touched.
    pub fn inbox_prune_expired(&self, now: u64, retention_ms: u64) -> Result<usize> {
        let cutoff = now.saturating_sub(retention_ms) as i64;
        let conn = self.conn.lock().expect("db lock");
        Ok(conn.execute(
            "DELETE FROM pane_inbox
             WHERE (delivered_via IN ('wait', 'stop_hook') AND delivered_at < ?1)
                OR (confirmed_at IS NOT NULL AND confirmed_at < ?1)",
            rusqlite::params![cutoff],
        )?)
    }

    pub fn inbox_pending_result(
        &self,
        to_session: u32,
        from_session: u32,
        request_id: u32,
    ) -> Result<Option<i64>> {
        let conn = self.conn.lock().expect("db lock");
        Ok(conn
            .query_row(
                "SELECT id FROM pane_inbox
                 WHERE to_session = ?1 AND from_session = ?2 AND request_id = ?3
                       AND kind = 'result' AND ready_at IS NULL
                       AND delivered_at IS NULL AND resolved_at IS NULL
                 ORDER BY id DESC LIMIT 1",
                rusqlite::params![to_session, from_session, request_id],
                |r| r.get(0),
            )
            .optional()?)
    }

    pub fn inbox_round_has_result(
        &self,
        to_session: u32,
        from_session: u32,
        request_id: u32,
    ) -> Result<bool> {
        let conn = self.conn.lock().expect("db lock");
        let count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM pane_inbox
             WHERE from_session = ?2 AND request_id = ?3 AND kind = 'result'
               AND (to_session = ?1 OR (to_session = 0 AND original_to = ?1))",
            rusqlite::params![to_session, from_session, request_id],
            |r| r.get(0),
        )?;
        Ok(count > 0)
    }

    pub fn inbox_round_handed_back(
        &self,
        to_session: u32,
        from_session: u32,
        request_id: u32,
    ) -> Result<bool> {
        let conn = self.conn.lock().expect("db lock");
        let n: i64 = conn.query_row(
            "SELECT COUNT(*) FROM pane_inbox
             WHERE to_session = ?1 AND from_session = ?2 AND request_id = ?3
                   AND kind = 'result'",
            rusqlite::params![to_session, from_session, request_id],
            |r| r.get(0),
        )?;
        Ok(n > 0)
    }

    pub fn inbox_undelivered_result(
        &self,
        to_session: u32,
        from_session: u32,
    ) -> Result<Option<u32>> {
        let conn = self.conn.lock().expect("db lock");
        Ok(conn
            .query_row(
                "SELECT superseded FROM pane_inbox
                 WHERE to_session = ?1 AND from_session = ?2 AND kind = 'result'
                       AND delivered_at IS NULL AND resolved_at IS NULL
                 ORDER BY id DESC LIMIT 1",
                rusqlite::params![to_session, from_session],
                |r| r.get::<_, i64>(0),
            )
            .optional()?
            .map(|v| v as u32))
    }

    pub fn inbox_has_undelivered(
        &self,
        to_session: u32,
        from_session: u32,
        kind: &str,
    ) -> Result<bool> {
        let conn = self.conn.lock().expect("db lock");
        Ok(conn.query_row(
            "SELECT COUNT(*) FROM pane_inbox
             WHERE to_session = ?1 AND from_session = ?2 AND kind = ?3
                   AND delivered_at IS NULL AND resolved_at IS NULL",
            rusqlite::params![to_session, from_session, kind],
            |r| r.get::<_, i64>(0).map(|c| c > 0),
        )?)
    }

    pub fn inbox_child_summary(
        &self,
        to_parent: u32,
        from_child: u32,
    ) -> Result<(u32, u32, Option<i64>)> {
        let conn = self.conn.lock().expect("db lock");
        let (owed, provisional): (i64, i64) = conn.query_row(
            "SELECT COUNT(*), COALESCE(SUM(provisional), 0) FROM pane_inbox
             WHERE to_session = ?1 AND from_session = ?2
                   AND delivered_at IS NULL AND resolved_at IS NULL",
            rusqlite::params![to_parent, from_child],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )?;
        let last_result: Option<i64> = conn
            .query_row(
                "SELECT id FROM pane_inbox
                 WHERE to_session = ?1 AND from_session = ?2 AND kind = 'result'
                       AND corrects IS NULL
                 ORDER BY id DESC LIMIT 1",
                rusqlite::params![to_parent, from_child],
                |r| r.get(0),
            )
            .optional()?;
        let corrected_by = match last_result {
            Some(id) => conn
                .query_row(
                    "SELECT id FROM pane_inbox WHERE corrects = ?1 ORDER BY id DESC LIMIT 1",
                    rusqlite::params![id],
                    |r| r.get(0),
                )
                .optional()?,
            None => None,
        };
        Ok((owed as u32, provisional as u32, corrected_by))
    }

    pub fn inbox_clear_provisional(&self, id: i64, now: u64) -> Result<bool> {
        let conn = self.conn.lock().expect("db lock");
        let cutoff = now as i64 - crate::orchestrate::INBOX_RESERVATION_MS as i64;
        let changed = conn.execute(
            &format!(
                "UPDATE pane_inbox SET provisional = 0
                 WHERE id = ?1 AND delivered_at IS NULL AND resolved_at IS NULL
                       AND {INBOX_UNRESERVED_OR_EXPIRED}"
            ),
            rusqlite::params![id, cutoff],
        )?;
        Ok(changed > 0)
    }

    pub fn inbox_get_undelivered(
        &self,
        to_session: u32,
        from_session: u32,
        kind: &str,
    ) -> Result<Option<i64>> {
        let conn = self.conn.lock().expect("db lock");
        Ok(conn
            .query_row(
                "SELECT id FROM pane_inbox
                 WHERE to_session = ?1 AND from_session = ?2 AND kind = ?3
                       AND delivered_at IS NULL AND resolved_at IS NULL
                 ORDER BY id DESC LIMIT 1",
                rusqlite::params![to_session, from_session, kind],
                |r| r.get(0),
            )
            .optional()?)
    }

    pub fn inbox_refresh_undelivered(
        &self,
        to_session: u32,
        from_session: u32,
        kind: &str,
        summary: &str,
        body: &str,
        now: u64,
    ) -> Result<bool> {
        let conn = self.conn.lock().expect("db lock");
        let cutoff = now as i64 - crate::orchestrate::INBOX_RESERVATION_MS as i64;
        let changed = conn.execute(
            &format!(
                "UPDATE pane_inbox SET summary = ?4, body = ?5
                 WHERE to_session = ?1 AND from_session = ?2 AND kind = ?3
                       AND delivered_at IS NULL AND resolved_at IS NULL
                       AND {INBOX_UNRESERVED_OR_EXPIRED}"
            ),
            rusqlite::params![to_session, from_session, kind, summary, body, cutoff],
        )?;
        Ok(changed > 0)
    }

    pub fn inbox_resolve_undelivered(
        &self,
        to_session: u32,
        from_session: u32,
        kind: &str,
        reason: &str,
        now: u64,
    ) -> Result<usize> {
        let conn = self.conn.lock().expect("db lock");
        Ok(conn.execute(
            "UPDATE pane_inbox SET resolved_at = ?4, reason = ?5
             WHERE to_session = ?1 AND from_session = ?2 AND kind = ?3
                   AND delivered_at IS NULL AND resolved_at IS NULL",
            rusqlite::params![to_session, from_session, kind, now as i64, reason],
        )?)
    }

    // The row flip and the delegation update share one transaction: "stored" and
    // "eligible" are kept apart so a result cannot reach the parent while the delegation
    // still reads working, and a crash between two writes is how that happens.
    pub fn delegation_close_round(
        &self,
        child: u32,
        state: &str,
        stop_reason: Option<&str>,
        closed: bool,
        handback: RoundHandback<'_>,
        now: u64,
    ) -> Result<Option<i64>> {
        let mut conn = self.conn.lock().expect("db lock");
        let tx = conn.transaction()?;
        let row_id = match handback {
            RoundHandback::Ready {
                id,
                provisional,
                reason,
            } => {
                tx.execute(
                    "UPDATE pane_inbox
                     SET ready_at = ?2, provisional = ?3, reason = COALESCE(?4, reason)
                     WHERE id = ?1 AND ready_at IS NULL",
                    rusqlite::params![id, now as i64, provisional as i64, reason],
                )?;
                Some(id)
            }
            RoundHandback::Write(row) => Some(insert_inbox_row(&tx, row, now)?),
            RoundHandback::Nothing => None,
        };
        if closed {
            tx.execute(
                "UPDATE delegations SET state = ?2, stop_reason = ?3, ended_at = ?4,
                    updated_at = ?4, no_handback_reported = 0, no_handback_suppressed = 0,
                    cleanup_after = NULL
                 WHERE child_session = ?1",
                rusqlite::params![child, state, stop_reason, now as i64],
            )?;
        } else {
            tx.execute(
                "UPDATE delegations SET state = ?2, updated_at = ?3 WHERE child_session = ?1",
                rusqlite::params![child, state, now as i64],
            )?;
        }
        tx.commit()?;
        Ok(row_id)
    }

    pub fn delegation_bump_round(&self, child: u32, now: u64) -> Result<Option<u32>> {
        let conn = self.conn.lock().expect("db lock");
        conn.execute(
            "UPDATE delegations SET round = round + 1, cleanup_after = NULL, updated_at = ?2
             WHERE child_session = ?1",
            rusqlite::params![child, now as i64],
        )?;
        Ok(conn
            .query_row(
                "SELECT round FROM delegations WHERE child_session = ?1",
                rusqlite::params![child],
                |r| r.get::<_, i64>(0),
            )
            .optional()?
            .map(|v| v as u32))
    }
}

pub enum RoundHandback<'a> {
    Ready {
        id: i64,
        provisional: bool,
        reason: Option<&'a str>,
    },
    Write(&'a NewInboxRow),
    Nothing,
}

fn insert_inbox_row(conn: &Connection, row: &NewInboxRow, now: u64) -> Result<i64> {
    let artifacts_json = serde_json::to_string(&row.artifacts)?;
    let ready_at = row.ready.then_some(now as i64);
    if row.kind == "result" && row.reason.is_none() && row.corrects.is_none() {
        if let Some(request_id) = row.request_id {
            let cutoff = now as i64 - crate::orchestrate::INBOX_RESERVATION_MS as i64;
            let existing: Option<i64> = conn
                .query_row(
                    &format!(
                        "SELECT id FROM pane_inbox
                             WHERE to_session = ?1 AND from_session IS ?2 AND request_id = ?3
                                   AND kind = 'result'
                                   AND {INBOX_UNRESERVED_OR_EXPIRED}
                                   AND delivered_at IS NULL AND resolved_at IS NULL"
                    ),
                    rusqlite::params![row.to_session, row.from_session, request_id, cutoff],
                    |r| r.get(0),
                )
                .optional()?;
            if let Some(id) = existing {
                conn.execute(
                    "UPDATE pane_inbox SET
                            body = ?2, summary = ?3, artifacts = ?4, superseded = superseded + 1,
                            from_codename = COALESCE(
                                from_codename,
                                (SELECT substr(COALESCE(NULLIF(s.codename, ''), NULLIF(s.title, '')), 1, 40)
                                   FROM sessions s WHERE s.id = ?5)
                            ),
                            from_role = COALESCE(
                                from_role,
                                (SELECT substr(d.role, 1, 32)
                                   FROM delegations d WHERE d.child_session = ?5)
                            )
                         WHERE id = ?1",
                    rusqlite::params![id, row.body, row.summary, artifacts_json, row.from_session],
                )?;
                return Ok(id);
            }
        }
    }
    conn.execute(
        "INSERT INTO pane_inbox
                (to_session, workspace, from_session, request_id, kind, urgent, summary, body,
                 artifacts, provisional, corrects, reason, created_at, ready_at,
                 from_codename, from_role)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14,
                     (SELECT substr(COALESCE(NULLIF(s.codename, ''), NULLIF(s.title, '')), 1, 40)
                        FROM sessions s WHERE s.id = ?3),
                     (SELECT substr(d.role, 1, 32)
                        FROM delegations d WHERE d.child_session = ?3))",
        rusqlite::params![
            row.to_session,
            row.workspace,
            row.from_session,
            row.request_id,
            row.kind,
            row.urgent as i64,
            row.summary,
            row.body,
            artifacts_json,
            row.provisional as i64,
            row.corrects,
            row.reason,
            now as i64,
            ready_at,
        ],
    )?;
    Ok(conn.last_insert_rowid())
}

impl Db {
    pub fn session_set_approval_mode(&self, id: u32, mode: &str) -> Result<()> {
        let conn = self.conn.lock().expect("db lock");
        conn.execute(
            "UPDATE sessions SET approval_mode = ?2 WHERE id = ?1",
            rusqlite::params![id, mode],
        )?;
        Ok(())
    }

    pub fn session_approval_mode(&self, id: u32) -> Result<Option<String>> {
        let conn = self.conn.lock().expect("db lock");
        Ok(conn
            .query_row(
                "SELECT approval_mode FROM sessions WHERE id = ?1",
                rusqlite::params![id],
                |r| r.get::<_, Option<String>>(0),
            )
            .optional()?
            .flatten())
    }

    pub fn list_workspaces(&self) -> Result<Vec<proto::Workspace>> {
        let conn = self.conn.lock().expect("db lock");
        let mut stmt = conn.prepare("SELECT path, name FROM workspaces ORDER BY name")?;
        let rows = stmt
            .query_map([], |r| {
                Ok(proto::Workspace {
                    path: r.get(0)?,
                    name: r.get(1)?,
                })
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    pub fn swarm_create(
        &self,
        name: &str,
        root_dir: &str,
        goal: &str,
        roster: &[proto::SwarmRosterEntry],
        budget_minutes: u32,
    ) -> Result<(proto::SwarmInfo, Vec<proto::SwarmAgentInfo>)> {
        anyhow::ensure!(
            roster.len() <= MAX_SWARM_AGENTS,
            "roster has {} agents — the per-swarm limit is {}",
            roster.len(),
            MAX_SWARM_AGENTS
        );
        let mut conn = self.conn.lock().expect("db lock");
        let tx = conn.transaction()?;
        tx.execute(
            "INSERT INTO swarms (name, root_dir, goal, status, budget_minutes, created_at)
             VALUES (?1, ?2, ?3, 'idle', ?4, unixepoch())",
            rusqlite::params![name, root_dir, goal, budget_minutes],
        )?;
        let swarm_id = tx.last_insert_rowid() as u64;
        for e in roster {
            insert_swarm_agent(&tx, swarm_id, e)?;
        }
        tx.commit()?;
        let info = swarm_row(&conn, swarm_id)?;
        let agents = list_swarm_agent_rows(&conn, swarm_id)?;
        Ok((info, agents))
    }

    pub fn list_swarms(&self) -> Result<Vec<proto::SwarmInfo>> {
        let conn = self.conn.lock().expect("db lock");
        let severities = swarm_severities(&conn)?;
        let mut stmt = conn.prepare(&format!("{SWARM_SELECT} ORDER BY id"))?;
        let rows = stmt
            .query_map([], map_swarm_row)?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        rows.into_iter()
            .map(|r| {
                let severity = severities
                    .get(&r.id)
                    .copied()
                    .unwrap_or(proto::SwarmSeverity::None);
                r.into_info(severity)
            })
            .collect()
    }

    pub fn get_swarm(&self, id: u64) -> Result<proto::SwarmInfo> {
        let conn = self.conn.lock().expect("db lock");
        swarm_row(&conn, id)
    }

    pub fn swarm_set_status(
        &self,
        id: u64,
        status: proto::SwarmStatus,
    ) -> Result<proto::SwarmInfo> {
        let conn = self.conn.lock().expect("db lock");
        let n = conn.execute(
            "UPDATE swarms SET status = ?2,
                    completed_at = CASE
                        WHEN ?2 IN ('completed', 'error') THEN COALESCE(completed_at, unixepoch())
                        ELSE NULL
                    END
             WHERE id = ?1",
            rusqlite::params![id, wire_name(&status)?],
        )?;
        anyhow::ensure!(n == 1, "no swarm with id {id}");
        swarm_row(&conn, id)
    }

    pub fn swarm_set_activated_at(&self, id: u64) -> Result<proto::SwarmInfo> {
        let conn = self.conn.lock().expect("db lock");
        conn.execute(
            "UPDATE swarms SET activated_at = unixepoch() WHERE id = ?1 AND activated_at IS NULL",
            rusqlite::params![id],
        )?;
        swarm_row(&conn, id)
    }

    pub fn swarm_set_goal(&self, id: u64, goal: &str) -> Result<proto::SwarmInfo> {
        let mut conn = self.conn.lock().expect("db lock");
        let tx = conn.transaction()?;
        let n = tx.execute(
            "UPDATE swarms SET goal = ?2 WHERE id = ?1",
            rusqlite::params![id, goal],
        )?;
        anyhow::ensure!(n == 1, "no swarm with id {id}");
        tx.commit()?;
        swarm_row(&conn, id)
    }

    pub fn swarm_remove(&self, id: u64) -> Result<()> {
        let mut conn = self.conn.lock().expect("db lock");
        let tx = conn.transaction()?;
        let n = tx.execute("DELETE FROM swarms WHERE id = ?1", rusqlite::params![id])?;
        anyhow::ensure!(n == 1, "no swarm with id {id}");
        tx.execute(
            "DELETE FROM swarm_agents WHERE swarm_id = ?1",
            rusqlite::params![id],
        )?;
        tx.execute(
            "DELETE FROM swarm_messages WHERE swarm_id = ?1",
            rusqlite::params![id],
        )?;
        tx.execute(
            "DELETE FROM swarm_deliveries WHERE swarm_id = ?1",
            rusqlite::params![id],
        )?;
        tx.commit()?;
        Ok(())
    }

    pub fn swarm_agent_add(
        &self,
        swarm: u64,
        entry: &proto::SwarmRosterEntry,
    ) -> Result<proto::SwarmAgentInfo> {
        let conn = self.conn.lock().expect("db lock");
        swarm_row(&conn, swarm)?;
        ensure_swarm_capacity(&conn, swarm, 1)?;
        let id = insert_swarm_agent(&conn, swarm, entry)?;
        swarm_agent_row(&conn, id)
    }

    pub fn swarm_agent_update(
        &self,
        agent: u64,
        entry: &proto::SwarmRosterEntry,
    ) -> Result<proto::SwarmAgentInfo> {
        validate_swarm_roster_entry(entry)?;
        let mut conn = self.conn.lock().expect("db lock");
        let tx = conn.transaction()?;
        let old = swarm_agent_row(&tx, agent)?;
        tx.execute(
            "UPDATE swarm_agents SET label = ?2, role = ?3, agent = ?4,
                    auto_approve = ?5, plan_mode = ?6, model = ?7, custom_prompt = ?8, cmd = ?9
             WHERE id = ?1",
            rusqlite::params![
                agent,
                entry.label,
                wire_name(&entry.role)?,
                wire_name(&entry.agent)?,
                entry.auto_approve,
                entry.plan_mode,
                entry.model,
                entry.custom_prompt,
                entry.cmd.as_ref().map(serde_json::to_string).transpose()?,
            ],
        )?;
        if old.label != entry.label {
            tx.execute(
                "UPDATE swarm_deliveries SET recipient = ?3
                 WHERE swarm_id = ?1 AND recipient = ?2",
                rusqlite::params![old.swarm, old.label, entry.label],
            )?;
        }
        tx.commit()?;
        swarm_agent_row(&conn, agent)
    }

    pub fn swarm_agent(&self, agent: u64) -> Result<proto::SwarmAgentInfo> {
        let conn = self.conn.lock().expect("db lock");
        swarm_agent_row(&conn, agent)
    }

    pub fn swarm_agent_by_session(&self, session: u32) -> Result<Option<proto::SwarmAgentInfo>> {
        let conn = self.conn.lock().expect("db lock");
        let id: Option<u64> = conn
            .query_row(
                "SELECT id FROM swarm_agents WHERE session_id = ?1",
                rusqlite::params![session],
                |r| r.get(0),
            )
            .optional()?;
        id.map(|id| swarm_agent_row(&conn, id)).transpose()
    }

    pub fn list_swarm_agents(&self, swarm: u64) -> Result<Vec<proto::SwarmAgentInfo>> {
        let conn = self.conn.lock().expect("db lock");
        list_swarm_agent_rows(&conn, swarm)
    }

    pub fn swarm_agent_bind_session(
        &self,
        agent: u64,
        expected: Option<u32>,
        session: Option<u32>,
    ) -> Result<proto::SwarmAgentInfo> {
        let conn = self.conn.lock().expect("db lock");
        let n = conn.execute(
            "UPDATE swarm_agents SET session_id = ?3 WHERE id = ?1 AND session_id IS ?2",
            rusqlite::params![agent, expected, session],
        )?;
        anyhow::ensure!(
            n == 1,
            "swarm agent {agent} session_id changed concurrently (expected {expected:?})"
        );
        swarm_agent_row(&conn, agent)
    }

    pub fn swarm_agent_set_status(
        &self,
        agent: u64,
        status: proto::SwarmAgentStatus,
    ) -> Result<proto::SwarmAgentInfo> {
        let conn = self.conn.lock().expect("db lock");
        let n = conn.execute(
            "UPDATE swarm_agents SET status = ?2 WHERE id = ?1",
            rusqlite::params![agent, wire_name(&status)?],
        )?;
        anyhow::ensure!(n == 1, "no swarm agent with id {agent}");
        swarm_agent_row(&conn, agent)
    }

    pub fn swarm_message_insert(
        &self,
        swarm: u64,
        from: &str,
        to: &str,
        body: &str,
        kind: proto::SwarmMsgKind,
        deliver_to: &[String],
    ) -> Result<proto::SwarmMessage> {
        self.swarm_message_insert_resolvable(swarm, from, to, body, kind, deliver_to, None)
    }

    #[allow(clippy::too_many_arguments)]
    pub fn swarm_message_insert_resolvable(
        &self,
        swarm: u64,
        from: &str,
        to: &str,
        body: &str,
        kind: proto::SwarmMsgKind,
        deliver_to: &[String],
        subject_agent: Option<u64>,
    ) -> Result<proto::SwarmMessage> {
        let mut conn = self.conn.lock().expect("db lock");
        let tx = conn.transaction()?;
        tx.execute(
            "INSERT INTO swarm_messages
                (swarm_id, sender, recipient, body, kind, created_at, resolvable, subject_agent)
             VALUES (?1, ?2, ?3, ?4, ?5, unixepoch(), ?6, ?7)",
            rusqlite::params![
                swarm,
                from,
                to,
                body,
                wire_name(&kind)?,
                subject_agent.is_some(),
                subject_agent
            ],
        )?;
        let msg_id = tx.last_insert_rowid() as u64;
        for r in deliver_to {
            tx.execute(
                "INSERT OR IGNORE INTO swarm_deliveries (message_id, swarm_id, recipient)
                 VALUES (?1, ?2, ?3)",
                rusqlite::params![msg_id, swarm, r],
            )?;
        }
        tx.commit()?;
        let msg = conn.query_row(
            &format!("{SWARM_MSG_SELECT} WHERE id = ?1"),
            rusqlite::params![msg_id],
            map_swarm_msg_row,
        )?;
        msg.into_info()
    }

    pub fn swarm_mail_ingest(
        &self,
        swarm: u64,
        msg: &MailMessage,
        deliver_to: &[String],
    ) -> Result<SwarmMailIngest> {
        let kind_wire = wire_name(&msg.kind)?;
        let mut conn = self.conn.lock().expect("db lock");
        let tx = conn.transaction()?;

        let existing_id: Option<u64> = tx
            .query_row(
                "SELECT id FROM swarm_messages WHERE swarm_id = ?1 AND wire_id = ?2",
                rusqlite::params![swarm, msg.id],
                |r| r.get(0),
            )
            .optional()?;

        let (msg_id, is_new) = match existing_id {
            Some(id) => (id, false),
            None => {
                let created_at: i64 = if msg.timestamp_ms == 0 {
                    match std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH) {
                        Ok(d) => d.as_secs() as i64,
                        Err(e) => {
                            tracing::warn!(
                                "swarm mail ingest wire_id={:?}: system clock is before \
                                 UNIX_EPOCH ({e}); falling back to created_at=0",
                                msg.id
                            );
                            0
                        }
                    }
                } else {
                    (msg.timestamp_ms / 1000) as i64
                };
                tx.execute(
                    "INSERT INTO swarm_messages
                        (swarm_id, sender, recipient, body, kind, created_at, wire_id)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                    rusqlite::params![
                        swarm, msg.from, msg.to, msg.body, kind_wire, created_at, msg.id
                    ],
                )?;
                (tx.last_insert_rowid() as u64, true)
            }
        };

        for r in deliver_to {
            tx.execute(
                "INSERT OR IGNORE INTO swarm_deliveries (message_id, swarm_id, recipient)
                 VALUES (?1, ?2, ?3)",
                rusqlite::params![msg_id, swarm, r],
            )?;
        }
        tx.commit()?;

        let stored = conn.query_row(
            &format!("{SWARM_MSG_SELECT} WHERE id = ?1"),
            rusqlite::params![msg_id],
            map_swarm_msg_row,
        )?;

        if !is_new {
            let mismatches = swarm_mail_mismatches(&stored, msg, &kind_wire);
            if !mismatches.is_empty() {
                tracing::warn!(
                    "swarm mail replay wire_id={:?} differs from stored message {} in {}: \
                     stored row wins",
                    msg.id,
                    msg_id,
                    mismatches.join(", ")
                );
            }
        }

        let info = stored.into_info()?;
        Ok(if is_new {
            SwarmMailIngest::New(info)
        } else {
            SwarmMailIngest::Replay(info)
        })
    }

    pub fn swarm_resolve_stuck_escalations(&self, agent: u64) -> Result<usize> {
        let conn = self.conn.lock().expect("db lock");
        let n = conn.execute(
            "UPDATE swarm_messages SET resolved = 1
             WHERE subject_agent = ?1 AND resolvable = 1 AND resolved = 0",
            rusqlite::params![agent],
        )?;
        Ok(n)
    }

    pub fn swarm_agent_set_respawn_count(&self, agent: u64, count: u32) -> Result<()> {
        let conn = self.conn.lock().expect("db lock");
        let n = conn.execute(
            "UPDATE swarm_agents SET respawn_count = ?2 WHERE id = ?1",
            rusqlite::params![agent, count],
        )?;
        anyhow::ensure!(n == 1, "no swarm agent with id {agent}");
        Ok(())
    }

    pub fn swarm_agent_touch_activity(&self, agent: u64, at_ms: u64) -> Result<()> {
        let conn = self.conn.lock().expect("db lock");
        let n = conn.execute(
            "UPDATE swarm_agents SET last_activity_at = ?2 WHERE id = ?1",
            rusqlite::params![agent, at_ms as i64],
        )?;
        anyhow::ensure!(n == 1, "no swarm agent with id {agent}");
        Ok(())
    }

    pub fn list_swarm_agent_policy_rows(&self) -> Result<Vec<SwarmAgentPolicyRow>> {
        let conn = self.conn.lock().expect("db lock");
        let mut stmt =
            conn.prepare("SELECT id, status, last_activity_at, respawn_count FROM swarm_agents")?;
        let rows = stmt
            .query_map([], |r| {
                let status: String = r.get(1)?;
                Ok((
                    r.get::<_, u64>(0)?,
                    status,
                    r.get::<_, Option<i64>>(2)?,
                    r.get::<_, u32>(3)?,
                ))
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        rows.into_iter()
            .map(|(id, status, last_activity_at, respawn_count)| {
                let status = from_wire::<proto::SwarmAgentStatus>(&status).ok_or_else(|| {
                    anyhow::anyhow!(
                        "swarm agent {id} has unknown status {:?} (expected a SwarmAgentStatus wire name)",
                        status
                    )
                })?;
                Ok(SwarmAgentPolicyRow {
                    id,
                    status,
                    last_activity_at: last_activity_at.map(|t| t as u64),
                    respawn_count,
                })
            })
            .collect()
    }

    pub fn swarm_inbox_take(
        &self,
        swarm: u64,
        label: &str,
        peek: bool,
    ) -> Result<Vec<proto::SwarmMessage>> {
        let mut conn = self.conn.lock().expect("db lock");
        let tx = conn.transaction()?;
        let msgs = {
            let mut stmt = tx.prepare(&format!(
                "{SWARM_MSG_SELECT} WHERE id IN (
                    SELECT message_id FROM swarm_deliveries
                    WHERE swarm_id = ?1 AND recipient = ?2 AND consumed = 0
                 ) ORDER BY id"
            ))?;
            let rows = stmt
                .query_map(rusqlite::params![swarm, label], map_swarm_msg_row)?
                .collect::<std::result::Result<Vec<_>, _>>()?;
            rows.into_iter()
                .map(|r| r.into_info())
                .collect::<Result<Vec<_>>>()?
        };
        if !peek {
            tx.execute(
                "UPDATE swarm_deliveries SET consumed = 1
                 WHERE swarm_id = ?1 AND recipient = ?2 AND consumed = 0",
                rusqlite::params![swarm, label],
            )?;
        }
        tx.commit()?;
        Ok(msgs)
    }

    pub fn swarm_delivery_mark_consumed(
        &self,
        swarm: u64,
        recipient: &str,
        wire_id: &str,
    ) -> Result<bool> {
        let conn = self.conn.lock().expect("db lock");
        let n = conn.execute(
            "UPDATE swarm_deliveries SET consumed = 1
             WHERE swarm_id = ?1 AND recipient = ?2 AND consumed = 0
               AND message_id IN (
                   SELECT id FROM swarm_messages WHERE swarm_id = ?1 AND wire_id = ?3
               )",
            rusqlite::params![swarm, recipient, wire_id],
        )?;
        Ok(n > 0)
    }

    pub fn swarm_deliveries_mark_consumed_batch(
        &self,
        swarm: u64,
        recipient: &str,
        wire_ids: &[&str],
    ) -> Result<usize> {
        if wire_ids.is_empty() {
            return Ok(0);
        }
        let conn = self.conn.lock().expect("db lock");
        let tx = conn.unchecked_transaction()?;
        let mut total = 0usize;
        {
            let mut stmt = tx.prepare(
                "UPDATE swarm_deliveries SET consumed = 1
                 WHERE swarm_id = ?1 AND recipient = ?2 AND consumed = 0
                   AND message_id IN (
                       SELECT id FROM swarm_messages WHERE swarm_id = ?1 AND wire_id = ?3
                   )",
            )?;
            for wire_id in wire_ids {
                total += stmt.execute(rusqlite::params![swarm, recipient, wire_id])?;
            }
        }
        tx.commit()?;
        Ok(total)
    }

    pub fn swarm_deliveries_unconsumed_wire_ids(
        &self,
        swarm: u64,
        recipient: &str,
    ) -> Result<Vec<String>> {
        let conn = self.conn.lock().expect("db lock");
        let mut stmt = conn.prepare(
            "SELECT m.wire_id FROM swarm_deliveries d
             JOIN swarm_messages m ON m.id = d.message_id
             WHERE d.swarm_id = ?1 AND d.recipient = ?2 AND d.consumed = 0
               AND m.wire_id IS NOT NULL
             ORDER BY d.message_id",
        )?;
        let ids = stmt
            .query_map(rusqlite::params![swarm, recipient], |r| {
                r.get::<_, String>(0)
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(ids)
    }

    pub fn swarm_messages(&self, swarm: u64, limit: u32) -> Result<Vec<proto::SwarmMessage>> {
        let conn = self.conn.lock().expect("db lock");
        let mut stmt = conn.prepare(&format!(
            "SELECT * FROM ({SWARM_MSG_SELECT} WHERE swarm_id = ?1
              ORDER BY id DESC LIMIT ?2) ORDER BY id"
        ))?;
        let rows = stmt
            .query_map(rusqlite::params![swarm, limit], map_swarm_msg_row)?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        rows.into_iter().map(|r| r.into_info()).collect()
    }

    pub fn swarm_mail_ingested_wire_ids(
        &self,
        swarm: u64,
        candidate_ids: &[String],
    ) -> Result<HashSet<String>> {
        let conn = self.conn.lock().expect("db lock");
        ids_present_in_table(&conn, "swarm_messages", "wire_id", swarm, candidate_ids)
    }

    pub fn swarm_plan_applied_event_ids(
        &self,
        swarm: u64,
        candidate_ids: &[String],
    ) -> Result<HashSet<String>> {
        let conn = self.conn.lock().expect("db lock");
        ids_present_in_table(
            &conn,
            "swarm_plan_events_applied",
            "event_id",
            swarm,
            candidate_ids,
        )
    }

    pub fn swarm_plan_events_applied_prune(
        &self,
        swarm: u64,
        older_than_epoch_secs: i64,
    ) -> Result<u64> {
        let conn = self.conn.lock().expect("db lock");
        let n = conn.execute(
            "DELETE FROM swarm_plan_events_applied WHERE swarm_id = ?1 AND applied_at < ?2",
            rusqlite::params![swarm, older_than_epoch_secs],
        )?;
        Ok(n as u64)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn command_history_cap_keeps_the_newest_per_workspace() {
        let tmp = tempfile::tempdir().unwrap();
        let db = Db::open(&tmp.path().join("t.db")).unwrap();
        let over = Db::COMMAND_HISTORY_CAP + 5;
        for i in 0..over {
            db.insert_command(
                "/ws/a",
                1,
                "/ws/a",
                &format!("cmd-{i}"),
                Some(0),
                "zsh",
                None,
                i as u64,
                i as u64 + 1,
            )
            .unwrap();
        }
        db.insert_command("/ws/b", 2, "/ws/b", "other-ws", Some(0), "zsh", None, 1, 2)
            .unwrap();

        assert_eq!(
            db.command_history_count(Some("/ws/a")).unwrap(),
            Db::COMMAND_HISTORY_CAP,
            "workspace a must be pruned to exactly the cap"
        );
        assert_eq!(
            db.command_history_count(Some("/ws/b")).unwrap(),
            1,
            "another workspace's rows must never be pruned by a's overflow"
        );
        let cmds: Vec<String> = {
            let conn = db.conn.lock().unwrap();
            let mut stmt = conn
                .prepare("SELECT cmd FROM command_history WHERE workspace = '/ws/a' ORDER BY id")
                .unwrap();
            stmt.query_map([], |r| r.get(0))
                .unwrap()
                .map(|r| r.unwrap())
                .collect()
        };
        assert_eq!(
            cmds.first().map(String::as_str),
            Some("cmd-5"),
            "the 5 oldest rows are the ones pruned"
        );
        assert_eq!(
            cmds.last().map(String::as_str),
            Some(format!("cmd-{}", over - 1).as_str()),
            "the newest row must survive"
        );
    }

    fn info(id: u32, state: proto::SessionState) -> proto::SessionInfo {
        proto::SessionInfo {
            id,
            agent: proto::AgentKind::Shell,
            project_dir: "/tmp/p".into(),
            cwd: "/tmp/p".into(),
            state,
            title: format!("Sess-{id}"),
            codename: format!("Sess-{id}"),
            detected_agent: None,
            hidden: false,
            ssh_host: None,
            restore_deferred: None,
            status: None,
            context: None,
            swarm_agent: None,
            spawned_by: None,
            acp: None,
            live_children: 0,
            profile_label: None,
            children_waiting: 0,
            delegation: None,
            inbox_unread: 0,
            tags: vec![],
        }
    }

    #[test]
    fn interrupted_marking_and_id_seed() {
        let tmp = tempfile::tempdir().unwrap();
        let db = Db::open(&tmp.path().join("t.db")).unwrap();

        db.insert_session(&info(1, proto::SessionState::Running))
            .unwrap();
        db.insert_session(&info(2, proto::SessionState::Exited))
            .unwrap();
        db.insert_session(&info(3, proto::SessionState::Running))
            .unwrap();

        assert_eq!(db.mark_live_as_interrupted().unwrap(), 2);
        assert_eq!(db.next_session_id().unwrap(), 4);
    }

    #[test]
    fn list_interrupted_excludes_swarm_tied_sessions() {
        let tmp = tempfile::tempdir().unwrap();
        let db = Db::open(&tmp.path().join("t.db")).unwrap();

        db.insert_session(&info(1, proto::SessionState::Running))
            .unwrap();
        db.insert_session(&info(2, proto::SessionState::Running))
            .unwrap();
        db.mark_live_as_interrupted().unwrap();

        let (_swarm, agents) = db.swarm_create("S1", "/tmp/r", "g", &roster(), 0).unwrap();
        db.swarm_agent_bind_session(agents[0].id, None, Some(1))
            .unwrap();

        let restored = db.list_interrupted().unwrap();
        let ids: Vec<u32> = restored.iter().map(|s| s.id).collect();
        assert_eq!(
            ids,
            vec![2],
            "swarm-tied session 1 must not be a restore candidate: {restored:?}"
        );
    }

    #[test]
    fn title_persists_and_restores() {
        let tmp = tempfile::tempdir().unwrap();
        let db_path = tmp.path().join("t.db");
        {
            let db = Db::open(&db_path).unwrap();
            db.insert_session(&info(1, proto::SessionState::Running))
                .unwrap();
            db.update_session_title(1, "Kai").unwrap();
            db.mark_live_as_interrupted().unwrap();
        }
        let db = Db::open(&db_path).unwrap();
        let restored = db.list_interrupted().unwrap();
        assert_eq!(restored.len(), 1);
        assert_eq!(restored[0].title, "Kai");
    }

    #[test]
    fn title_source_persists_with_the_title() {
        let tmp = tempfile::tempdir().unwrap();
        let db_path = tmp.path().join("t.db");
        let db = Db::open(&db_path).unwrap();
        db.insert_session_with_title_source(
            &info(1, proto::SessionState::Running),
            Some("codename"),
        )
        .unwrap();
        db.update_session_title_with_source(1, "Review the parser", Some("prompt"))
            .unwrap();
        assert_eq!(
            db.session_title_source(1).unwrap().as_deref(),
            Some("prompt")
        );
    }

    #[test]
    fn codename_backfills_from_title_or_a_fresh_pick() {
        let tmp = tempfile::tempdir().unwrap();
        let db_path = tmp.path().join("t.db");
        let db = Db::open(&db_path).unwrap();
        db.insert_session_with_title_source(
            &info(1, proto::SessionState::Running),
            Some("codename"),
        )
        .unwrap();
        db.insert_session(&info(2, proto::SessionState::Running))
            .unwrap();
        db.update_session_title_with_source(2, "Review the parser", Some("prompt"))
            .unwrap();
        db.update_session_codename(1, "").unwrap();
        db.update_session_codename(2, "").unwrap();
        db.mark_live_as_interrupted().unwrap();

        let restored = db.list_interrupted().unwrap();
        assert_eq!(restored.len(), 2);
        let first = restored.iter().find(|i| i.id == 1).expect("row 1 restores");
        assert_eq!(first.codename, "Sess-1");
        let second = restored.iter().find(|i| i.id == 2).expect("row 2 restores");
        assert!(!second.codename.is_empty(), "a renamed row is minted one");
        assert_ne!(second.codename, "Review the parser");

        let again = db.list_interrupted().unwrap();
        let second_again = again.iter().find(|i| i.id == 2).expect("row 2 restores");
        assert_eq!(second_again.codename, second.codename);
    }

    #[test]
    fn detected_agent_persists_and_restores() {
        let tmp = tempfile::tempdir().unwrap();
        let db_path = tmp.path().join("t.db");
        {
            let db = Db::open(&db_path).unwrap();
            db.insert_session(&info(1, proto::SessionState::Running))
                .unwrap();
            db.update_session_detected(1, proto::AgentKind::Claude)
                .unwrap();
            db.mark_live_as_interrupted().unwrap();
        }
        let db = Db::open(&db_path).unwrap();
        let restored = db.list_interrupted().unwrap();
        assert_eq!(restored.len(), 1);
        assert_eq!(restored[0].detected_agent, Some(proto::AgentKind::Claude));

        let err = db
            .update_session_detected(42, proto::AgentKind::Codex)
            .unwrap_err()
            .to_string();
        assert!(err.contains("42"), "error should name the id: {err}");
    }

    #[test]
    fn profile_label_persists_and_restores() {
        let tmp = tempfile::tempdir().unwrap();
        let db_path = tmp.path().join("t.db");
        {
            let db = Db::open(&db_path).unwrap();
            let mut i = info(1, proto::SessionState::Running);
            i.profile_label = Some("personal".to_string());
            db.insert_session(&i).unwrap();
            db.mark_live_as_interrupted().unwrap();
        }
        let db = Db::open(&db_path).unwrap();
        let restored = db.list_interrupted().unwrap();
        assert_eq!(restored.len(), 1);
        assert_eq!(restored[0].profile_label.as_deref(), Some("personal"));
    }

    #[test]
    fn update_title_of_missing_row_fails_loud() {
        let tmp = tempfile::tempdir().unwrap();
        let db = Db::open(&tmp.path().join("t.db")).unwrap();
        let err = db.update_session_title(42, "Nope").unwrap_err().to_string();
        assert!(err.contains("42"), "error should name the id: {err}");
    }

    #[test]
    fn workspace_add_is_idempotent() {
        let tmp = tempfile::tempdir().unwrap();
        let db = Db::open(&tmp.path().join("t.db")).unwrap();
        db.add_workspace("/home/x/proj", "proj").unwrap();
        db.add_workspace("/home/x/proj", "proj").unwrap();
        let ws = db.list_workspaces().unwrap();
        assert_eq!(ws.len(), 1);
        assert_eq!(ws[0].name, "proj");
    }

    #[test]
    fn workspace_rename_updates_the_row() {
        let dir = tempfile::tempdir().unwrap();
        let db = Db::open(&dir.path().join("t.db")).unwrap();
        db.add_workspace("/home/x/proj", "proj").unwrap();
        db.rename_workspace("/home/x/proj", "renamed").unwrap();
        let ws = db.list_workspaces().unwrap();
        assert_eq!(ws[0].name, "renamed");

        let err = db.rename_workspace("/nope", "x").unwrap_err().to_string();
        assert!(err.contains("/nope"), "error must name the path: {err}");
    }

    #[test]
    fn workspace_remove_deletes_the_row() {
        let tmp = tempfile::tempdir().unwrap();
        let db = Db::open(&tmp.path().join("t.db")).unwrap();
        db.add_workspace("/home/x/proj", "proj").unwrap();
        db.remove_workspace("/home/x/proj").unwrap();
        assert!(db.list_workspaces().unwrap().is_empty());
    }

    #[test]
    fn remove_missing_workspace_fails_loud() {
        let tmp = tempfile::tempdir().unwrap();
        let db = Db::open(&tmp.path().join("t.db")).unwrap();
        let err = db.remove_workspace("/nope").unwrap_err().to_string();
        assert!(err.contains("/nope"), "error should name the path: {err}");
    }

    fn roster() -> Vec<proto::SwarmRosterEntry> {
        [
            ("Coordinator", proto::SwarmRole::Coordinator),
            ("Builder-1", proto::SwarmRole::Builder),
            ("Builder-2", proto::SwarmRole::Builder),
        ]
        .into_iter()
        .map(|(label, role)| proto::SwarmRosterEntry {
            label: label.into(),
            role,
            agent: proto::AgentKind::Claude,
            auto_approve: true,
            plan_mode: false,
            model: None,
            custom_prompt: None,
            cmd: None,
        })
        .collect()
    }

    #[test]
    fn swarm_create_seeds_roster() {
        let tmp = tempfile::tempdir().unwrap();
        let db = Db::open(&tmp.path().join("t.db")).unwrap();
        let (info, agents) = db
            .swarm_create("S1", "/tmp/r", "ship it", &roster(), 120)
            .unwrap();
        assert_eq!(info.status, proto::SwarmStatus::Idle);
        assert_eq!(agents.len(), 3);
        assert!(agents
            .iter()
            .all(|a| a.status == proto::SwarmAgentStatus::Idle));
    }

    #[test]
    fn swarm_duplicate_label_fails_loud() {
        let tmp = tempfile::tempdir().unwrap();
        let db = Db::open(&tmp.path().join("t.db")).unwrap();
        let mut r = roster();
        r[2].label = "Builder-1".into();
        let err = db
            .swarm_create("S1", "/tmp/r", "g", &r, 120)
            .unwrap_err()
            .to_string();
        assert!(
            err.contains("Builder-1"),
            "error should name the label: {err}"
        );
    }

    #[test]
    fn swarm_inbox_is_consume_once_and_fanout_skips_sender() {
        let tmp = tempfile::tempdir().unwrap();
        let db = Db::open(&tmp.path().join("t.db")).unwrap();
        let (info, _) = db
            .swarm_create("S1", "/tmp/r", "g", &roster(), 120)
            .unwrap();
        db.swarm_message_insert(
            info.id,
            "Coordinator",
            "@all",
            "kick off",
            proto::SwarmMsgKind::Message,
            &["Builder-1".to_string(), "Builder-2".to_string()],
        )
        .unwrap();
        assert!(db
            .swarm_inbox_take(info.id, "Coordinator", true)
            .unwrap()
            .is_empty());
        assert_eq!(
            db.swarm_inbox_take(info.id, "Builder-1", true)
                .unwrap()
                .len(),
            1
        );
        assert_eq!(
            db.swarm_inbox_take(info.id, "Builder-1", false)
                .unwrap()
                .len(),
            1
        );
        assert!(db
            .swarm_inbox_take(info.id, "Builder-1", false)
            .unwrap()
            .is_empty());
        assert_eq!(
            db.swarm_inbox_take(info.id, "Builder-2", false)
                .unwrap()
                .len(),
            1
        );
        assert_eq!(db.swarm_messages(info.id, 500).unwrap().len(), 1);
    }

    #[test]
    fn swarm_capacity_and_plan_mode_validation() {
        let tmp = tempfile::tempdir().unwrap();
        let db = Db::open(&tmp.path().join("t.db")).unwrap();
        let entry = |label: &str| proto::SwarmRosterEntry {
            label: label.into(),
            role: proto::SwarmRole::Builder,
            agent: proto::AgentKind::Claude,
            auto_approve: false,
            plan_mode: false,
            model: None,
            custom_prompt: None,
            cmd: None,
        };
        let big: Vec<_> = (0..MAX_SWARM_AGENTS + 1)
            .map(|i| entry(&format!("a-{i}")))
            .collect();
        let err = db
            .swarm_create("S", "/tmp/r", "g", &big, 0)
            .unwrap_err()
            .to_string();
        assert!(err.contains("13") && err.contains("12"), "{err}");
        let full: Vec<_> = (0..MAX_SWARM_AGENTS)
            .map(|i| entry(&format!("a-{i}")))
            .collect();
        let (info, _) = db.swarm_create("S", "/tmp/r", "g", &full, 0).unwrap();
        let err = db
            .swarm_agent_add(info.id, &entry("one-more"))
            .unwrap_err()
            .to_string();
        assert!(err.contains("13") && err.contains("12"), "{err}");
        let both = proto::SwarmRosterEntry {
            auto_approve: true,
            plan_mode: true,
            ..entry("Contradictory")
        };
        let err = db
            .swarm_create("S2", "/tmp/r", "g", &[both], 0)
            .unwrap_err()
            .to_string();
        assert!(err.contains("Contradictory"), "{err}");
        let (info3, agents3) = db
            .swarm_create(
                "S3",
                "/tmp/r",
                "g",
                &[proto::SwarmRosterEntry {
                    plan_mode: true,
                    ..entry("Planner")
                }],
                0,
            )
            .unwrap();
        assert!(agents3[0].plan_mode);
        let updated = db
            .swarm_agent_update(agents3[0].id, &entry("Planner"))
            .unwrap();
        assert!(!updated.plan_mode);
        let _ = info3;
    }

    #[test]
    fn swarm_agent_rename_repoints_queued_mail() {
        let tmp = tempfile::tempdir().unwrap();
        let db = Db::open(&tmp.path().join("t.db")).unwrap();
        let (info, agents) = db
            .swarm_create("S1", "/tmp/r", "g", &roster(), 120)
            .unwrap();
        db.swarm_message_insert(
            info.id,
            "Coordinator",
            "Builder-1",
            "hi",
            proto::SwarmMsgKind::Message,
            &["Builder-1".to_string()],
        )
        .unwrap();
        let b1 = agents.iter().find(|a| a.label == "Builder-1").unwrap();
        db.swarm_agent_update(
            b1.id,
            &proto::SwarmRosterEntry {
                label: "Mason".into(),
                role: proto::SwarmRole::Builder,
                agent: proto::AgentKind::Claude,
                auto_approve: false,
                plan_mode: false,
                model: None,
                custom_prompt: None,
                cmd: None,
            },
        )
        .unwrap();
        assert!(db
            .swarm_inbox_take(info.id, "Builder-1", false)
            .unwrap()
            .is_empty());
        assert_eq!(
            db.swarm_inbox_take(info.id, "Mason", false).unwrap().len(),
            1
        );
    }

    #[test]
    fn swarm_remove_drops_all_dependents() {
        let tmp = tempfile::tempdir().unwrap();
        let db = Db::open(&tmp.path().join("t.db")).unwrap();
        let (info, _) = db
            .swarm_create("S1", "/tmp/r", "g", &roster(), 120)
            .unwrap();
        db.swarm_message_insert(
            info.id,
            "Coordinator",
            "@all",
            "x",
            proto::SwarmMsgKind::Message,
            &["Builder-1".to_string()],
        )
        .unwrap();
        db.swarm_remove(info.id).unwrap();
        assert!(db.list_swarms().unwrap().is_empty());
        assert!(db.list_swarm_agents(info.id).unwrap().is_empty());
        assert!(db.swarm_messages(info.id, 500).unwrap().is_empty());
        let err = db.swarm_remove(info.id).unwrap_err().to_string();
        assert!(
            err.contains(&info.id.to_string()),
            "error should name the id: {err}"
        );
    }

    #[test]
    fn swarm_create_snapshots_budget_and_activated_at_is_set_once() {
        let tmp = tempfile::tempdir().unwrap();
        let db = Db::open(&tmp.path().join("t.db")).unwrap();
        let (info, _) = db.swarm_create("S1", "/tmp/r", "g", &roster(), 90).unwrap();
        assert_eq!(
            info.budget_minutes, 90,
            "budget should be snapshotted at create time"
        );
        assert_eq!(info.activated_at, None, "not launched yet");

        let activated = db.swarm_set_activated_at(info.id).unwrap();
        let first = activated.activated_at.expect("activated_at should be set");
        assert!(first > 0);

        std::thread::sleep(std::time::Duration::from_millis(1100));
        let again = db.swarm_set_activated_at(info.id).unwrap();
        assert_eq!(
            again.activated_at,
            Some(first),
            "activated_at must be set only once"
        );

        let err = db.swarm_set_activated_at(999).unwrap_err().to_string();
        assert!(err.contains("999"), "error should name the id: {err}");
    }

    #[test]
    fn swarm_completed_at_stamps_on_terminal_status_and_clears_on_reactivate() {
        let tmp = tempfile::tempdir().unwrap();
        let db = Db::open(&tmp.path().join("t.db")).unwrap();
        let (info, _) = db.swarm_create("S1", "/tmp/r", "g", &roster(), 0).unwrap();
        assert_eq!(
            info.completed_at, None,
            "fresh swarm has no completion stamp"
        );

        let active = db
            .swarm_set_status(info.id, proto::SwarmStatus::Active)
            .unwrap();
        assert_eq!(active.completed_at, None);

        let done = db
            .swarm_set_status(info.id, proto::SwarmStatus::Completed)
            .unwrap();
        let first = done
            .completed_at
            .expect("completed_at should be stamped on Completed");
        assert!(first > 0);

        std::thread::sleep(std::time::Duration::from_millis(1100));
        let errored = db
            .swarm_set_status(info.id, proto::SwarmStatus::Error)
            .unwrap();
        assert_eq!(
            errored.completed_at,
            Some(first),
            "terminal→terminal keeps the first stamp"
        );

        let reactivated = db
            .swarm_set_status(info.id, proto::SwarmStatus::Active)
            .unwrap();
        assert_eq!(
            reactivated.completed_at, None,
            "re-activation must clear completed_at"
        );
    }

    #[test]
    fn swarm_messages_wire_id_migration_is_idempotent() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("t.db");

        fn wire_id_column_present(db: &Db) -> bool {
            db.conn
                .lock()
                .unwrap()
                .query_row(
                    "SELECT COUNT(*) FROM pragma_table_info('swarm_messages') WHERE name = 'wire_id'",
                    [],
                    |r| r.get::<_, i64>(0).map(|c| c > 0),
                )
                .unwrap()
        }

        fn composite_index_present(db: &Db) -> (bool, bool) {
            let conn = db.conn.lock().unwrap();
            let composite: bool = conn
                .query_row(
                    "SELECT COUNT(*) FROM pragma_index_list('swarm_messages')
                        WHERE name = 'idx_swarm_messages_swarm_wire_id' AND \"unique\" = 1",
                    [],
                    |r| r.get::<_, i64>(0).map(|c| c > 0),
                )
                .unwrap();
            let old_gone: bool = conn
                .query_row(
                    "SELECT COUNT(*) FROM pragma_index_list('swarm_messages')
                        WHERE name = 'idx_swarm_messages_wire_id'",
                    [],
                    |r| r.get::<_, i64>(0).map(|c| c == 0),
                )
                .unwrap();
            (composite, old_gone)
        }

        {
            let db = Db::open(&path).unwrap();
            assert!(
                wire_id_column_present(&db),
                "wire_id column should exist after first open"
            );
            let (composite, old_gone) = composite_index_present(&db);
            assert!(
                composite,
                "composite (swarm_id, wire_id) index should exist after first open"
            );
            assert!(
                old_gone,
                "single-column wire_id index should not exist after first open"
            );
        }
        let db = Db::open(&path).unwrap();
        assert!(
            wire_id_column_present(&db),
            "wire_id column should survive a second open"
        );
        let (composite, old_gone) = composite_index_present(&db);
        assert!(
            composite,
            "composite (swarm_id, wire_id) index should survive a second open"
        );
        assert!(
            old_gone,
            "single-column wire_id index should stay gone after a second open"
        );
    }

    #[test]
    fn swarm_completed_at_backfills_from_last_message_on_open() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("t.db");
        let msg_ts;
        let id;
        {
            let db = Db::open(&path).unwrap();
            let (info, _) = db.swarm_create("S1", "/tmp/r", "g", &roster(), 0).unwrap();
            id = info.id;
            db.swarm_set_status(id, proto::SwarmStatus::Active).unwrap();
            let msg = db
                .swarm_message_insert(
                    id,
                    "Policy",
                    "@all",
                    "auto-completed",
                    proto::SwarmMsgKind::Status,
                    &[],
                )
                .unwrap();
            msg_ts = msg.created_at;
            db.swarm_set_status(id, proto::SwarmStatus::Completed)
                .unwrap();
            db.conn
                .lock()
                .unwrap()
                .execute(
                    "UPDATE swarms SET completed_at = NULL WHERE id = ?1",
                    rusqlite::params![id],
                )
                .unwrap();
        }
        let db = Db::open(&path).unwrap();
        assert_eq!(
            db.get_swarm(id).unwrap().completed_at,
            Some(msg_ts),
            "backfill should stamp completed_at from the swarm's last message"
        );
    }

    #[test]
    fn swarm_severity_prioritizes_error_over_escalation_and_ignores_inactive() {
        let tmp = tempfile::tempdir().unwrap();
        let db = Db::open(&tmp.path().join("t.db")).unwrap();
        let (info, agents) = db
            .swarm_create("S1", "/tmp/r", "g", &roster(), 120)
            .unwrap();
        assert_eq!(
            db.get_swarm(info.id).unwrap().severity,
            proto::SwarmSeverity::None
        );

        db.swarm_set_status(info.id, proto::SwarmStatus::Active)
            .unwrap();
        db.swarm_message_insert(
            info.id,
            "Policy",
            "@operator",
            "may be stuck",
            proto::SwarmMsgKind::Escalation,
            &[],
        )
        .unwrap();
        assert_eq!(
            db.get_swarm(info.id).unwrap().severity,
            proto::SwarmSeverity::Escalation
        );
        let listed = db.list_swarms().unwrap();
        assert_eq!(
            listed.iter().find(|s| s.id == info.id).unwrap().severity,
            proto::SwarmSeverity::Escalation
        );

        let b1 = agents.iter().find(|a| a.label == "Builder-1").unwrap();
        db.swarm_agent_set_status(b1.id, proto::SwarmAgentStatus::Error)
            .unwrap();
        assert_eq!(
            db.get_swarm(info.id).unwrap().severity,
            proto::SwarmSeverity::Error
        );

        db.swarm_agent_set_status(b1.id, proto::SwarmAgentStatus::Idle)
            .unwrap();
        db.swarm_set_status(info.id, proto::SwarmStatus::Completed)
            .unwrap();
        assert_eq!(
            db.get_swarm(info.id).unwrap().severity,
            proto::SwarmSeverity::None,
            "an escalation on a no-longer-active swarm must not keep the ring lit"
        );
    }

    #[test]
    fn resolvable_stuck_escalation_clears_severity_after_recovery_while_still_active() {
        let tmp = tempfile::tempdir().unwrap();
        let db = Db::open(&tmp.path().join("t.db")).unwrap();
        let (info, agents) = db
            .swarm_create("S1", "/tmp/r", "g", &roster(), 120)
            .unwrap();
        db.swarm_set_status(info.id, proto::SwarmStatus::Active)
            .unwrap();
        let b1 = agents.iter().find(|a| a.label == "Builder-1").unwrap();

        db.swarm_message_insert_resolvable(
            info.id,
            "Policy",
            "@operator",
            "Builder-1 may be stuck — no activity for 5m.",
            proto::SwarmMsgKind::Escalation,
            &[],
            Some(b1.id),
        )
        .unwrap();
        assert_eq!(
            db.get_swarm(info.id).unwrap().severity,
            proto::SwarmSeverity::Escalation,
            "an unresolved stuck-warning still counts toward the tier"
        );

        let resolved = db.swarm_resolve_stuck_escalations(b1.id).unwrap();
        assert_eq!(resolved, 1);
        assert_eq!(
            db.get_swarm(info.id).unwrap().severity,
            proto::SwarmSeverity::None,
            "severity must return to normal once the stuck-warning is resolved, swarm still Active"
        );
        assert_eq!(
            db.list_swarms()
                .unwrap()
                .iter()
                .find(|s| s.id == info.id)
                .unwrap()
                .severity,
            proto::SwarmSeverity::None
        );
        assert_eq!(
            db.get_swarm(info.id).unwrap().status,
            proto::SwarmStatus::Active,
            "resolution must not itself change swarm status"
        );

        assert_eq!(db.swarm_resolve_stuck_escalations(b1.id).unwrap(), 0);

        db.swarm_message_insert(
            info.id,
            "Builder-1",
            "@operator",
            "manual escalation from the agent itself",
            proto::SwarmMsgKind::Escalation,
            &[],
        )
        .unwrap();
        assert_eq!(
            db.get_swarm(info.id).unwrap().severity,
            proto::SwarmSeverity::Escalation
        );
        assert_eq!(
            db.swarm_resolve_stuck_escalations(b1.id).unwrap(),
            0,
            "resolving stuck-warnings must never touch an operator-facing escalation"
        );
        assert_eq!(
            db.get_swarm(info.id).unwrap().severity,
            proto::SwarmSeverity::Escalation
        );
    }

    fn mail_msg(id: &str, body: &str, timestamp_ms: u64) -> MailMessage {
        MailMessage {
            id: id.to_string(),
            from: "Coordinator".to_string(),
            to: "Builder-1".to_string(),
            body: body.to_string(),
            kind: proto::SwarmMsgKind::Message,
            timestamp_ms,
        }
    }

    #[test]
    fn triple_ingest_of_one_file_id_yields_one_row_first_new_rest_replay() {
        let tmp = tempfile::tempdir().unwrap();
        let db = Db::open(&tmp.path().join("t.db")).unwrap();
        let (info, _agents) = db.swarm_create("S1", "/tmp/r", "g", &roster(), 0).unwrap();
        let msg = mail_msg("file-1", "hello", 1_700_000_000_000);

        let first = db.swarm_mail_ingest(info.id, &msg, &[]).unwrap();
        let SwarmMailIngest::New(first_info) = &first else {
            panic!("first ingest of a fresh wire_id must report New");
        };

        let second = db.swarm_mail_ingest(info.id, &msg, &[]).unwrap();
        let SwarmMailIngest::Replay(second_info) = &second else {
            panic!("second ingest of the same wire_id must report Replay");
        };

        let third = db.swarm_mail_ingest(info.id, &msg, &[]).unwrap();
        let SwarmMailIngest::Replay(third_info) = &third else {
            panic!("third ingest of the same wire_id must report Replay");
        };

        assert_eq!(first_info, second_info);
        assert_eq!(first_info, third_info);

        let count: u64 = db
            .conn
            .lock()
            .unwrap()
            .query_row("SELECT COUNT(*) FROM swarm_messages", [], |r| r.get(0))
            .unwrap();
        assert_eq!(
            count, 1,
            "three ingests of the same wire_id must yield one row"
        );
    }

    #[test]
    fn different_wire_ids_with_identical_content_yield_two_rows() {
        let tmp = tempfile::tempdir().unwrap();
        let db = Db::open(&tmp.path().join("t.db")).unwrap();
        let (info, _agents) = db.swarm_create("S1", "/tmp/r", "g", &roster(), 0).unwrap();

        let a = mail_msg("file-a", "same body", 1_700_000_000_000);
        let b = mail_msg("file-b", "same body", 1_700_000_000_000);

        db.swarm_mail_ingest(info.id, &a, &[]).unwrap();
        db.swarm_mail_ingest(info.id, &b, &[]).unwrap();

        let count: u64 = db
            .conn
            .lock()
            .unwrap()
            .query_row("SELECT COUNT(*) FROM swarm_messages", [], |r| r.get(0))
            .unwrap();
        assert_eq!(
            count, 2,
            "distinct wire_ids must yield distinct rows even with byte-identical content"
        );
    }

    #[test]
    fn same_wire_id_in_two_swarms_yields_two_independent_rows() {
        let tmp = tempfile::tempdir().unwrap();
        let db = Db::open(&tmp.path().join("t.db")).unwrap();
        let (info_a, _) = db.swarm_create("S1", "/tmp/r", "g", &roster(), 0).unwrap();
        let (info_b, _) = db.swarm_create("S2", "/tmp/r2", "g", &roster(), 0).unwrap();

        let msg_a = mail_msg("shared-id", "body from A", 1_700_000_000_000);
        let msg_b = mail_msg("shared-id", "body from B", 1_700_000_001_000);

        let ingested_a = db
            .swarm_mail_ingest(info_a.id, &msg_a, &["Builder-1".to_string()])
            .unwrap();
        let ingested_b = db
            .swarm_mail_ingest(info_b.id, &msg_b, &["Builder-1".to_string()])
            .unwrap();

        let SwarmMailIngest::New(a_info) = &ingested_a else {
            panic!("swarm A's first ingest of shared-id must report New");
        };
        let SwarmMailIngest::New(b_info) = &ingested_b else {
            panic!("swarm B's first ingest of the same wire_id must report New, not Replay");
        };

        assert_ne!(
            a_info.id, b_info.id,
            "each swarm must get its own message row"
        );
        assert_eq!(a_info.body, "body from A");
        assert_eq!(b_info.body, "body from B");

        let conn = db.conn.lock().unwrap();
        let count: u64 = conn
            .query_row("SELECT COUNT(*) FROM swarm_messages", [], |r| r.get(0))
            .unwrap();
        assert_eq!(
            count, 2,
            "identical wire_id across swarms must yield two rows"
        );

        let delivery_message_id: u64 = conn
            .query_row(
                "SELECT message_id FROM swarm_deliveries WHERE swarm_id = ?1",
                rusqlite::params![info_a.id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(
            delivery_message_id, a_info.id,
            "swarm A's delivery must point at swarm A's own message row"
        );
        let delivery_message_id: u64 = conn
            .query_row(
                "SELECT message_id FROM swarm_deliveries WHERE swarm_id = ?1",
                rusqlite::params![info_b.id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(
            delivery_message_id, b_info.id,
            "swarm B's delivery must point at swarm B's own message row, not swarm A's"
        );
    }

    #[test]
    fn duplicate_swarm_and_wire_id_rejected_at_the_index() {
        let tmp = tempfile::tempdir().unwrap();
        let db = Db::open(&tmp.path().join("t.db")).unwrap();
        let (info, _) = db.swarm_create("S1", "/tmp/r", "g", &roster(), 0).unwrap();

        let conn = db.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO swarm_messages (swarm_id, sender, recipient, body, kind, created_at, wire_id)
             VALUES (?1, 'Coordinator', 'Builder-1', 'first', 'message', 1700000000, 'dup-id')",
            rusqlite::params![info.id],
        )
        .unwrap();

        let err = conn
            .execute(
                "INSERT INTO swarm_messages (swarm_id, sender, recipient, body, kind, created_at, wire_id)
                 VALUES (?1, 'Coordinator', 'Builder-1', 'second', 'message', 1700000001, 'dup-id')",
                rusqlite::params![info.id],
            )
            .unwrap_err();
        assert!(
            err.to_string().to_lowercase().contains("unique"),
            "duplicate (swarm_id, wire_id) must be rejected by the unique index: {err}"
        );
    }

    #[test]
    fn replay_with_expanded_recipients_adds_new_deliveries_without_duplicates() {
        let tmp = tempfile::tempdir().unwrap();
        let db = Db::open(&tmp.path().join("t.db")).unwrap();
        let (info, _agents) = db.swarm_create("S1", "/tmp/r", "g", &roster(), 0).unwrap();
        let msg = mail_msg("file-1", "hello", 1_700_000_000_000);

        db.swarm_mail_ingest(info.id, &msg, &["A".to_string(), "B".to_string()])
            .unwrap();
        db.swarm_mail_ingest(
            info.id,
            &msg,
            &["A".to_string(), "B".to_string(), "C".to_string()],
        )
        .unwrap();

        let count: u64 = db
            .conn
            .lock()
            .unwrap()
            .query_row("SELECT COUNT(*) FROM swarm_deliveries", [], |r| r.get(0))
            .unwrap();
        assert_eq!(
            count, 3,
            "expected exactly one delivery row per distinct recipient"
        );
    }

    #[test]
    fn created_at_is_the_file_timestamp_converted_to_seconds() {
        let tmp = tempfile::tempdir().unwrap();
        let db = Db::open(&tmp.path().join("t.db")).unwrap();
        let (info, _agents) = db.swarm_create("S1", "/tmp/r", "g", &roster(), 0).unwrap();
        let msg = mail_msg("file-1", "hello", 1_700_000_000_000);

        let ingested = db.swarm_mail_ingest(info.id, &msg, &[]).unwrap();
        assert_eq!(ingested.message().created_at, 1_700_000_000);
    }

    #[test]
    fn zero_timestamp_falls_back_to_current_time_not_1970() {
        let tmp = tempfile::tempdir().unwrap();
        let db = Db::open(&tmp.path().join("t.db")).unwrap();
        let (info, _agents) = db.swarm_create("S1", "/tmp/r", "g", &roster(), 0).unwrap();
        let msg = mail_msg("file-1", "hello", 0);

        let before = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs();
        let ingested = db.swarm_mail_ingest(info.id, &msg, &[]).unwrap();
        let after = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs();

        let created_at = ingested.message().created_at;
        assert!(
            created_at >= before && created_at <= after,
            "timestamp_ms == 0 must fall back to current time, got {created_at}, expected between {before} and {after}"
        );
    }

    #[derive(Clone, Default)]
    struct LogBuf(std::sync::Arc<std::sync::Mutex<Vec<u8>>>);

    impl std::io::Write for LogBuf {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            self.0.lock().unwrap().write(buf)
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    impl<'a> tracing_subscriber::fmt::MakeWriter<'a> for LogBuf {
        type Writer = Self;
        fn make_writer(&'a self) -> Self::Writer {
            self.clone()
        }
    }

    #[test]
    fn replay_with_mutated_body_keeps_stored_row_and_warns_naming_wire_id() {
        let tmp = tempfile::tempdir().unwrap();
        let db = Db::open(&tmp.path().join("t.db")).unwrap();
        let (info, _agents) = db.swarm_create("S1", "/tmp/r", "g", &roster(), 0).unwrap();
        let original = mail_msg("file-1", "original body", 1_700_000_000_000);
        db.swarm_mail_ingest(info.id, &original, &[]).unwrap();

        let mutated = mail_msg("file-1", "MUTATED body", 1_700_000_000_000);
        crate::test_tracing_capture::ensure_permissive_global_default();
        let buf = LogBuf::default();
        let subscriber = tracing_subscriber::fmt().with_writer(buf.clone()).finish();
        let replayed = tracing::subscriber::with_default(subscriber, || {
            db.swarm_mail_ingest(info.id, &mutated, &[]).unwrap()
        });

        assert_eq!(
            replayed.message().body,
            "original body",
            "the stored row must win over a mutated replay"
        );
        let logged = String::from_utf8(buf.0.lock().unwrap().clone()).unwrap();
        assert!(
            logged.contains("file-1"),
            "warning should name the wire_id: {logged}"
        );
        assert!(
            logged.contains("body"),
            "warning should name the differing field: {logged}"
        );
    }

    #[test]
    fn identical_replay_stays_silent() {
        let tmp = tempfile::tempdir().unwrap();
        let db = Db::open(&tmp.path().join("t.db")).unwrap();
        let (info, _agents) = db.swarm_create("S1", "/tmp/r", "g", &roster(), 0).unwrap();
        let msg = mail_msg("file-1", "hello", 1_700_000_000_000);
        db.swarm_mail_ingest(info.id, &msg, &[]).unwrap();

        crate::test_tracing_capture::ensure_permissive_global_default();
        let buf = LogBuf::default();
        let subscriber = tracing_subscriber::fmt().with_writer(buf.clone()).finish();
        tracing::subscriber::with_default(subscriber, || {
            db.swarm_mail_ingest(info.id, &msg, &[]).unwrap();
        });

        let logged = String::from_utf8(buf.0.lock().unwrap().clone()).unwrap();
        assert!(
            logged.is_empty(),
            "an identical replay must not warn: {logged}"
        );
    }

    #[test]
    fn null_wire_id_rows_coexist_with_ingested_rows() {
        let tmp = tempfile::tempdir().unwrap();
        let db = Db::open(&tmp.path().join("t.db")).unwrap();
        let (info, _agents) = db.swarm_create("S1", "/tmp/r", "g", &roster(), 0).unwrap();

        db.swarm_message_insert(
            info.id,
            "Coordinator",
            "Builder-1",
            "old-path message 1",
            proto::SwarmMsgKind::Message,
            &[],
        )
        .unwrap();
        db.swarm_message_insert(
            info.id,
            "Coordinator",
            "Builder-1",
            "old-path message 2",
            proto::SwarmMsgKind::Message,
            &[],
        )
        .unwrap();

        let msg = mail_msg("file-1", "ingested message", 1_700_000_000_000);
        db.swarm_mail_ingest(info.id, &msg, &[]).unwrap();

        let count: u64 = db
            .conn
            .lock()
            .unwrap()
            .query_row("SELECT COUNT(*) FROM swarm_messages", [], |r| r.get(0))
            .unwrap();
        assert_eq!(
            count, 3,
            "two NULL-wire_id rows and one ingested row must all coexist"
        );
    }

    #[test]
    fn swarm_mail_ingested_wire_ids_is_bounded_by_the_candidate_list_not_all_history() {
        let tmp = tempfile::tempdir().unwrap();
        let db = Db::open(&tmp.path().join("t.db")).unwrap();
        let (info, _agents) = db.swarm_create("S1", "/tmp/r", "g", &roster(), 0).unwrap();

        let on_disk = mail_msg("on-disk-id", "still on disk", 1_700_000_000_000);
        let long_gone = mail_msg("long-gone-id", "file deleted ages ago", 1_600_000_000_000);
        db.swarm_mail_ingest(info.id, &on_disk, &[]).unwrap();
        db.swarm_mail_ingest(info.id, &long_gone, &[]).unwrap();

        let candidates = vec!["on-disk-id".to_string(), "never-ingested-id".to_string()];
        let ids = db
            .swarm_mail_ingested_wire_ids(info.id, &candidates)
            .unwrap();

        assert_eq!(
            ids,
            HashSet::from(["on-disk-id".to_string()]),
            "must return exactly the candidate ids that are durable — never an id absent from \
             the candidate list, even if durable, and never a candidate that isn't durable"
        );
    }

    #[test]
    fn swarm_plan_applied_event_ids_is_bounded_by_the_candidate_list_not_all_history() {
        let tmp = tempfile::tempdir().unwrap();
        let db = Db::open(&tmp.path().join("t.db")).unwrap();
        let (info, _agents) = db.swarm_create("S1", "/tmp/r", "g", &roster(), 0).unwrap();

        for (event_id, applied_at) in [
            ("event-on-disk", 1_700_000_000i64),
            ("event-long-gone", 1_600_000_000i64),
        ] {
            db.conn
                .lock()
                .unwrap()
                .execute(
                    "INSERT INTO swarm_plan_events_applied (swarm_id, event_id, applied_at) \
                     VALUES (?1, ?2, ?3)",
                    rusqlite::params![info.id, event_id, applied_at],
                )
                .unwrap();
        }

        let candidates = vec!["event-on-disk".to_string(), "never-applied-id".to_string()];
        let ids = db
            .swarm_plan_applied_event_ids(info.id, &candidates)
            .unwrap();

        assert_eq!(
            ids,
            HashSet::from(["event-on-disk".to_string()]),
            "must return exactly the candidate ids that are durable — never an id absent from \
             the candidate list, even if durable, and never a candidate that isn't durable"
        );
    }

    #[test]
    fn swarm_agent_respawn_count_and_activity_touch_persist() {
        let tmp = tempfile::tempdir().unwrap();
        let db = Db::open(&tmp.path().join("t.db")).unwrap();
        let (_info, agents) = db
            .swarm_create("S1", "/tmp/r", "g", &roster(), 120)
            .unwrap();
        let b1 = agents.iter().find(|a| a.label == "Builder-1").unwrap();

        db.swarm_agent_set_respawn_count(b1.id, 3).unwrap();
        db.swarm_agent_touch_activity(b1.id, 123_456).unwrap();

        let rows = db.list_swarm_agent_policy_rows().unwrap();
        let row = rows.iter().find(|r| r.id == b1.id).unwrap();
        assert_eq!(row.respawn_count, 3);
        assert_eq!(row.last_activity_at, Some(123_456));

        let err = db
            .swarm_agent_set_respawn_count(999_999, 1)
            .unwrap_err()
            .to_string();
        assert!(err.contains("999999"), "error should name the id: {err}");
    }

    #[test]
    fn insert_command_redacts_secrets_before_the_ledger_insert() {
        let tmp = tempfile::tempdir().unwrap();
        let db = Db::open(&tmp.path().join("t.db")).unwrap();
        let jwt = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N";
        let cmd = format!(
            "curl -H \"Authorization: Bearer {jwt}\" -u AKIAIOSFODNN7EXAMPLE:secret https://api.example.com"
        );
        db.insert_command("ws", 1, "/tmp", &cmd, Some(0), "bash", None, 0, 1)
            .unwrap();
        let stored: String = db
            .conn
            .lock()
            .unwrap()
            .query_row("SELECT cmd FROM command_history LIMIT 1", [], |r| r.get(0))
            .unwrap();
        assert!(stored.contains("[redacted:jwt]"), "stored: {stored}");
        assert!(stored.contains("[redacted:aws_key]"), "stored: {stored}");
        assert!(!stored.contains(jwt));
        assert!(!stored.contains("AKIAIOSFODNN7EXAMPLE"));

        let uuid = "3fa85f64-5717-4562-b3fc-2c963f66afa6";
        db.insert_command(
            "ws",
            1,
            "/tmp",
            &format!("kubectl get pod {uuid} -n default"),
            Some(0),
            "bash",
            None,
            2,
            3,
        )
        .unwrap();
        let stored2: String = db
            .conn
            .lock()
            .unwrap()
            .query_row("SELECT cmd FROM command_history WHERE id = 2", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert!(stored2.contains(uuid), "stored2: {stored2}");
    }

    #[test]
    fn boot_sweep_strands_legacy_worktree_swarms_and_is_idempotent() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("t.db");

        let (legacy_id, clean_id) = {
            let db = Db::open(&path).unwrap();
            let (legacy, _) = db
                .swarm_create("Legacy", "/tmp/r", "g", &roster(), 0)
                .unwrap();
            let (clean, _) = db
                .swarm_create("Clean", "/tmp/r2", "g", &roster(), 0)
                .unwrap();
            db.conn
                .lock()
                .unwrap()
                .execute(
                    "UPDATE swarms SET status = 'active', worktree_dir = ?2, branch = ?3
                     WHERE id = ?1",
                    rusqlite::params![legacy.id, "/tmp/r/.tr-worktrees/legacy", "swarm/legacy"],
                )
                .unwrap();
            (legacy.id, clean.id)
        };

        let db = Db::open(&path).unwrap();
        let (status, worktree_dir, branch, completed_at): (String, String, String, Option<i64>) =
            db.conn
                .lock()
                .unwrap()
                .query_row(
                    "SELECT status, worktree_dir, branch, completed_at FROM swarms WHERE id = ?1",
                    rusqlite::params![legacy_id],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
                )
                .unwrap();
        assert_eq!(status, "error");
        assert_eq!(worktree_dir, "");
        assert_eq!(branch, "");
        assert!(completed_at.is_some());

        let (clean_status, clean_worktree_dir): (String, String) = db
            .conn
            .lock()
            .unwrap()
            .query_row(
                "SELECT status, worktree_dir FROM swarms WHERE id = ?1",
                rusqlite::params![clean_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(clean_status, "idle");
        assert_eq!(clean_worktree_dir, "");
        drop(db);

        let db2 = Db::open(&path).unwrap();
        let (status2, completed_at2): (String, Option<i64>) = db2
            .conn
            .lock()
            .unwrap()
            .query_row(
                "SELECT status, completed_at FROM swarms WHERE id = ?1",
                rusqlite::params![legacy_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(status2, "error");
        assert_eq!(completed_at2, completed_at);
    }

    #[test]
    fn stranded_swarm_mail_files_become_operator_inbox_rows_once() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("t.db");
        let root_dir = tmp.path().join("repo");
        std::fs::create_dir_all(&root_dir).unwrap();

        let swarm_id = {
            let db = Db::open(&path).unwrap();
            let (swarm, _) = db
                .swarm_create("Stranded", root_dir.to_str().unwrap(), "g", &roster(), 0)
                .unwrap();
            swarm.id
        };

        let layout = crate::scope::ScopeLayout::new(&root_dir, swarm_id);
        let inbox = layout.inbox_for("Builder-1").unwrap();
        std::fs::create_dir_all(&inbox).unwrap();
        let mail = MailMessage {
            id: crate::scope::gen_mailbox_id(),
            from: "Coordinator".to_string(),
            to: "Builder-1".to_string(),
            body: "ship the thing".to_string(),
            kind: proto::SwarmMsgKind::Message,
            timestamp_ms: 1_700_000_000_000,
        };
        let name = crate::scope::mail_filename(&mail.id);
        crate::hook_drop::write_atomic(&inbox, &name, &mail.to_bytes().unwrap()).unwrap();

        let db = Db::open(&path).unwrap();
        assert!(
            !inbox.join(&name).exists(),
            "the migrated file must be deleted, not left to migrate again"
        );
        let rows = db.inbox_list_operator(root_dir.to_str().unwrap()).unwrap();
        assert_eq!(rows.len(), 1, "{rows:?}");
        assert_eq!(rows[0].to_session, 0);
        assert_eq!(rows[0].reason.as_deref(), Some("migrated"));
        assert!(rows[0].body.contains("ship the thing"), "{rows:?}");
        assert!(rows[0].summary.contains("Coordinator"), "{rows:?}");
        drop(db);

        let db2 = Db::open(&path).unwrap();
        let rows2 = db2.inbox_list_operator(root_dir.to_str().unwrap()).unwrap();
        assert_eq!(
            rows2.len(),
            1,
            "a second boot must not re-migrate the same (already deleted) file: {rows2:?}"
        );
    }

    #[test]
    fn a_second_open_survives_a_writer_committing_under_it() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("t.db");
        let live = Db::open(&path).unwrap();

        let stop = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let stop_writer = std::sync::Arc::clone(&stop);
        let writer_path = path.clone();
        let writer = std::thread::spawn(move || {
            let conn = Connection::open(&writer_path).unwrap();
            let mut n = 0i64;
            while !stop_writer.load(std::sync::atomic::Ordering::Relaxed) {
                n += 1;
                let _ = conn.execute(
                    "INSERT OR REPLACE INTO workspaces(path, name, added_at) VALUES (?1, ?2, ?3)",
                    rusqlite::params![format!("/w/{n}"), "w", n],
                );
                std::thread::sleep(std::time::Duration::from_millis(5));
            }
        });

        let mut opens = 0;
        for _ in 0..80 {
            match Db::open(&path) {
                Ok(_) => opens += 1,
                Err(e) => {
                    stop.store(true, std::sync::atomic::Ordering::Relaxed);
                    writer.join().unwrap();
                    panic!(
                        "open {} of 80 failed under a concurrent writer: {e:?}",
                        opens + 1
                    );
                }
            }
        }
        stop.store(true, std::sync::atomic::Ordering::Relaxed);
        writer.join().unwrap();
        drop(live);
        assert_eq!(opens, 80);
    }

    #[test]
    fn only_sqlite_damage_codes_count_as_corruption() {
        let dir = tempfile::tempdir().unwrap();
        let conn = Connection::open(dir.path().join("t.db")).unwrap();

        let no_such_table = conn
            .query_row("SELECT 1 FROM nope", [], |r| r.get::<_, i64>(0))
            .unwrap_err();
        assert!(
            !is_corruption(&no_such_table),
            "a missing table is not corruption: {no_such_table:?}"
        );

        let syntax = conn.execute_batch("SELECT FROM WHERE").unwrap_err();
        assert!(!is_corruption(&syntax), "bad SQL is not corruption");

        for code in [
            rusqlite::ErrorCode::DatabaseCorrupt,
            rusqlite::ErrorCode::NotADatabase,
        ] {
            let err = rusqlite::Error::SqliteFailure(
                rusqlite::ffi::Error {
                    code,
                    extended_code: 0,
                },
                None,
            );
            assert!(is_corruption(&err), "{code:?} means damaged");
        }
    }

    #[test]
    fn a_healthy_ledger_is_left_completely_alone() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("t.db");
        let db = Db::open(&path).unwrap();
        db.insert_command("ws", 1, "/tmp", "echo hi", Some(0), "bash", None, 0, 1)
            .unwrap();
        drop(db);

        let reopened = Db::open(&path).unwrap();
        assert_eq!(
            reopened.command_history_count(Some("ws")).unwrap(),
            1,
            "an intact ledger survives a reopen"
        );
    }

    #[test]
    fn a_wholly_unreadable_file_is_refused_at_open_with_a_named_reason() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("corrupt.db");
        std::fs::write(&path, b"this is definitely not a sqlite database").unwrap();

        let err = match Db::open(&path) {
            Ok(_) => panic!("a junk file must be refused, not silently accepted"),
            Err(e) => e,
        };
        let msg = format!("{err:#}");
        assert!(
            msg.contains("not a database"),
            "the refusal names why: {msg}"
        );
    }

    #[test]
    fn quarantine_empties_the_ledger_and_leaves_every_other_table_intact() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("t.db");
        let db = Db::open(&path).unwrap();

        db.add_workspace("/tmp/p", "proj").unwrap();
        db.insert_session(&info(1, proto::SessionState::Running))
            .unwrap();
        db.insert_command("ws", 1, "/tmp", "echo hi", Some(0), "bash", None, 0, 1)
            .unwrap();
        assert_eq!(db.command_history_count(Some("ws")).unwrap(), 1);

        {
            let conn = db.conn.lock().unwrap();
            quarantine_command_history(&conn);
        }

        assert_eq!(
            db.command_history_count(Some("ws")).unwrap(),
            0,
            "the ledger is emptied"
        );
        assert_eq!(db.list_workspaces().unwrap().len(), 1, "workspaces survive");
        let sessions: i64 = {
            let conn = db.conn.lock().unwrap();
            conn.query_row("SELECT count(*) FROM sessions", [], |r| r.get(0))
                .unwrap()
        };
        assert_eq!(sessions, 1, "the session row survives");

        db.insert_command("ws", 1, "/tmp", "echo again", Some(0), "bash", None, 0, 1)
            .expect("the ledger accepts writes after quarantine");
        assert_eq!(db.command_history_count(Some("ws")).unwrap(), 1);
    }

    #[test]
    fn a_missing_table_is_left_alone_rather_than_repaired() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("t.db");
        let db = Db::open(&path).unwrap();
        {
            let conn = db.conn.lock().unwrap();
            conn.execute_batch(DISCARD_COMMAND_HISTORY).unwrap();
            heal_command_history(&conn);
            let still_missing = conn
                .query_row("SELECT count(*) FROM command_history", [], |r| {
                    r.get::<_, i64>(0)
                })
                .is_err();
            assert!(
                still_missing,
                "a non-corruption probe failure must not trigger the repair"
            );
        }
    }

    #[test]
    fn delegation_create_then_read_round_trips() {
        let tmp = tempfile::tempdir().unwrap();
        let db = Db::open(&tmp.path().join("t.db")).unwrap();

        let id = db
            .delegation_create(1, 2, None, "do the thing", 100)
            .unwrap();
        let row = db.delegation_for_child(2).unwrap().expect("row exists");

        assert_eq!(row.id, id);
        assert_eq!(row.parent_session, 1);
        assert_eq!(row.child_session, 2);
        assert_eq!(row.role, None);
        assert_eq!(row.state, "spawning");
        assert!(!row.stalled);
        assert_eq!(row.brief, "do the thing");
        assert_eq!(row.round, 1, "the spawn's own prompt is request 1");
        assert_eq!(row.created_at, 100);
        assert_eq!(row.updated_at, 100);
        assert_eq!(row.ended_at, None);
        assert_eq!(row.stop_reason, None);
        assert!(row.reusable, "legacy creation keeps the child reusable");
        assert_eq!(row.cleanup_after, None);

        assert_eq!(db.delegations_for_parent(1).unwrap().len(), 1);
    }

    #[test]
    fn temporary_lifecycle_and_cleanup_marker_round_trip() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("t.db");
        let db = Db::open(&path).unwrap();

        db.delegation_create_with_lifecycle(7, 8, Some("reviewer"), "brief", false, 100)
            .unwrap();
        assert_eq!(db.delegation_parent_of(8).unwrap(), Some(7));
        db.delegation_finish(8, "done", None, 200).unwrap();
        db.delegation_set_cleanup_after(8, Some(300), 201).unwrap();
        drop(db);
        let db = Db::open(&path).unwrap();

        let row = db.delegation_for_child(8).unwrap().unwrap();
        assert!(!row.reusable);
        assert_eq!(row.cleanup_after, Some(300));
        assert!(db.delegations_cleanup_pending().unwrap());
        assert!(db
            .delegations_cleanup_due(300)
            .unwrap()
            .iter()
            .any(|row| { row.child_session == 8 && row.cleanup_after == Some(300) }));

        db.delegation_bump_round(8, 301).unwrap();
        let row = db.delegation_for_child(8).unwrap().unwrap();
        assert_eq!(row.cleanup_after, None, "new input cancels pending cleanup");
        assert!(!db.delegations_cleanup_pending().unwrap());
    }

    #[test]
    fn delegation_create_replaces_a_reused_child_id() {
        let tmp = tempfile::tempdir().unwrap();
        let db = Db::open(&tmp.path().join("t.db")).unwrap();

        let first = db
            .delegation_create(1, 2, None, "first brief", 100)
            .unwrap();
        db.delegation_finish(2, "done", Some("finished"), 120)
            .unwrap();

        let second = db
            .delegation_create(9, 2, None, "second brief", 200)
            .unwrap();
        assert_eq!(
            first, second,
            "the row is replaced in place, not duplicated"
        );

        let row = db.delegation_for_child(2).unwrap().expect("row exists");
        assert_eq!(row.parent_session, 9);
        assert_eq!(row.brief, "second brief");
        assert_eq!(
            row.state, "spawning",
            "a fresh delegation starts un-finished"
        );
        assert_eq!(row.round, 1, "a fresh delegation counts from request 1");
        assert_eq!(row.ended_at, None);
        assert_eq!(row.stop_reason, None);
        assert_eq!(db.delegations_for_parent(1).unwrap().len(), 0);
        assert_eq!(db.delegations_for_parent(9).unwrap().len(), 1);
    }

    #[test]
    fn a_second_answer_to_one_request_replaces_the_first_and_counts_it() {
        let tmp = tempfile::tempdir().unwrap();
        let db = Db::open(&tmp.path().join("t.db")).unwrap();
        db.delegation_create(1, 2, None, "brief", 100).unwrap();

        let first = db
            .inbox_insert(&new_inbox_row(1, "/ws", Some(2), Some(1), false), 101)
            .unwrap();
        let second = db
            .inbox_insert(&new_inbox_row(1, "/ws", Some(2), Some(1), false), 102)
            .unwrap();
        let third = db
            .inbox_insert(&new_inbox_row(1, "/ws", Some(2), Some(1), false), 103)
            .unwrap();
        assert_eq!(first, second, "one request, one row");
        assert_eq!(first, third);
        let row = db.inbox_get(first).unwrap().unwrap();
        assert_eq!(row.superseded, 2, "two earlier bodies were displaced");
        assert_eq!(db.inbox_list_for_session(1).unwrap().len(), 1);
    }

    #[test]
    fn closing_a_round_makes_its_answer_eligible_and_starts_a_fresh_one() {
        let tmp = tempfile::tempdir().unwrap();
        let db = Db::open(&tmp.path().join("t.db")).unwrap();
        db.delegation_create(1, 2, None, "brief", 100).unwrap();
        assert_eq!(
            db.inbox_pending_result(1, 2, 1).unwrap(),
            None,
            "nothing stored yet"
        );

        let stored = db
            .inbox_insert(&new_inbox_row(1, "/ws", Some(2), Some(1), false), 101)
            .unwrap();
        assert_eq!(db.inbox_pending_result(1, 2, 1).unwrap(), Some(stored));
        assert!(
            db.inbox_reserve(1, 102, 10, 1_000_000).unwrap().is_none(),
            "a stored row is not eligible until its round closes"
        );

        db.delegation_close_round(
            2,
            "done",
            None,
            true,
            RoundHandback::Ready {
                id: stored,
                provisional: false,
                reason: None,
            },
            103,
        )
        .unwrap();
        let (_, eligible) = db.inbox_reserve(1, 104, 10, 1_000_000).unwrap().unwrap();
        assert_eq!(eligible.len(), 1);
        assert_eq!(eligible[0].id, stored);
        assert_eq!(
            db.delegation_for_child(2).unwrap().unwrap().state,
            "done",
            "the state moved in the same transaction"
        );

        db.delegation_reopen(2, "working", 105).unwrap();
        let next = db
            .inbox_insert(&new_inbox_row(1, "/ws", Some(2), Some(2), false), 106)
            .unwrap();
        assert_ne!(next, stored, "two requests, two surviving results");
    }

    fn stage_a_result_the_old_way(path: &std::path::Path, child: u32, body: &str) {
        let conn = Connection::open(path).unwrap();
        conn.execute_batch(
            "ALTER TABLE delegations ADD COLUMN staged_result TEXT;
             ALTER TABLE delegations ADD COLUMN staged_superseded INTEGER NOT NULL DEFAULT 0;
             DROP INDEX IF EXISTS pane_inbox_eligible;
             DROP INDEX IF EXISTS pane_inbox_workspace;
             DROP TABLE pane_inbox;",
        )
        .unwrap();
        conn.execute(
            "UPDATE delegations SET staged_result = ?2, staged_superseded = 3
             WHERE child_session = ?1",
            rusqlite::params![child, body],
        )
        .unwrap();
    }

    #[test]
    fn a_staged_result_migrates_into_the_inbox_and_running_it_twice_is_a_no_op() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("t.db");
        {
            let db = Db::open(&path).unwrap();
            db.delegation_create(1, 2, None, "brief", 100).unwrap();
        }
        stage_a_result_the_old_way(&path, 2, "the result the last daemon held");

        let db = Db::open(&path).unwrap();
        let rows = db.inbox_list_for_session(1).unwrap();
        assert_eq!(rows.len(), 1, "{rows:?}");
        assert_eq!(rows[0].body, "the result the last daemon held");
        assert_eq!(rows[0].from_session, Some(2));
        assert_eq!(rows[0].request_id, Some(1), "stamped with its own round");
        assert_eq!(rows[0].superseded, 3, "what it displaced comes with it");
        assert_eq!(rows[0].reason.as_deref(), Some("migrated"));
        assert!(
            rows[0].ready_at.is_some(),
            "the round that would have released it belongs to a daemon that is gone"
        );
        drop(db);

        let db = Db::open(&path).unwrap();
        assert_eq!(
            db.inbox_list_for_session(1).unwrap().len(),
            1,
            "a second open must not duplicate the result"
        );
        let present: bool = Connection::open(&path)
            .unwrap()
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('delegations') WHERE name = 'staged_result'",
                [],
                |r| r.get::<_, i64>(0).map(|c| c > 0),
            )
            .unwrap();
        assert!(!present, "the staging slot is gone: one message, one store");
    }

    #[test]
    fn a_migrated_result_never_replaces_an_answer_written_since() {
        let tmp = tempfile::tempdir().unwrap();
        let db = Db::open(&tmp.path().join("t.db")).unwrap();

        let first = db
            .inbox_insert(&new_inbox_row(1, "/ws", Some(2), Some(1), true), 101)
            .unwrap();
        let migrated = db
            .inbox_insert(
                &NewInboxRow {
                    reason: Some("migrated".to_string()),
                    body: "the stale one".to_string(),
                    ..new_inbox_row(1, "/ws", Some(2), Some(1), true)
                },
                102,
            )
            .unwrap();
        assert_ne!(migrated, first, "a reason row never replaces another body");

        let rows = db.inbox_list_for_session(1).unwrap();
        assert_eq!(rows.len(), 2, "both survive: {rows:?}");
        assert!(rows.iter().any(|r| r.body == "the stale one"));
        assert!(rows.iter().any(|r| r.reason.is_none()));
    }

    #[test]
    fn a_real_legacy_db_without_the_table_migrates_on_open() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("t.db");
        {
            let db = Db::open(&path).unwrap();
            db.delegation_create(1, 2, None, "brief", 100).unwrap();
        }
        stage_a_result_the_old_way(&path, 2, "the result the last daemon held");

        let db = Db::open(&path).unwrap();
        let rows = db.inbox_list_for_session(1).unwrap();
        assert_eq!(rows.len(), 1, "{rows:?}");
        assert_eq!(rows[0].body, "the result the last daemon held");
        assert_eq!(rows[0].from_session, Some(2));
        assert_eq!(rows[0].request_id, Some(1), "stamped with its own round");
        assert_eq!(rows[0].reason.as_deref(), Some("migrated"));
    }

    #[test]
    fn delegations_open_excludes_terminal_states() {
        let tmp = tempfile::tempdir().unwrap();
        let db = Db::open(&tmp.path().join("t.db")).unwrap();

        db.delegation_create(1, 2, None, "working one", 100)
            .unwrap();
        db.delegation_set_state(2, "working", 101).unwrap();

        db.delegation_create(1, 3, None, "needs input", 100)
            .unwrap();
        db.delegation_set_state(3, "needs_input", 101).unwrap();

        for (child, state) in [(4, "done"), (5, "failed"), (6, "cancelled"), (7, "unknown")] {
            db.delegation_create(1, child, None, "finished one", 100)
                .unwrap();
            db.delegation_finish(child, state, None, 101).unwrap();
        }

        let open = db.delegations_open().unwrap();
        let open_children: Vec<u32> = open.iter().map(|r| r.child_session).collect();
        assert_eq!(open_children, vec![2, 3]);
    }

    #[test]
    fn session_approval_mode_round_trips() {
        let tmp = tempfile::tempdir().unwrap();
        let db = Db::open(&tmp.path().join("t.db")).unwrap();
        db.insert_session(&info(1, proto::SessionState::Running))
            .unwrap();

        assert_eq!(db.session_approval_mode(1).unwrap(), None);

        db.session_set_approval_mode(1, "auto").unwrap();
        assert_eq!(
            db.session_approval_mode(1).unwrap(),
            Some("auto".to_string())
        );
    }

    fn new_inbox_row(
        to_session: u32,
        workspace: &str,
        from_session: Option<u32>,
        request_id: Option<u32>,
        ready: bool,
    ) -> NewInboxRow {
        NewInboxRow {
            to_session,
            workspace: workspace.to_string(),
            from_session,
            request_id,
            kind: "result".to_string(),
            urgent: false,
            summary: "did the thing".to_string(),
            body: "the full body of the result".to_string(),
            artifacts: Vec::new(),
            provisional: false,
            corrects: None,
            reason: None,
            ready,
        }
    }

    #[test]
    fn inbox_child_summary_counts_owed_and_names_the_correction() {
        let tmp = tempfile::tempdir().unwrap();
        let db = Db::open(&tmp.path().join("t.db")).unwrap();

        assert_eq!(
            db.inbox_child_summary(1, 2).unwrap(),
            (0, 0, None),
            "a child that owes nothing reads as nothing owed"
        );

        db.inbox_insert(&new_inbox_row(1, "/ws", Some(2), Some(9), true), 100)
            .unwrap();
        let (delivery_id, _) = db.inbox_reserve(1, 150, 1, 1_000_000).unwrap().unwrap();
        db.inbox_mark_delivered(&delivery_id, "wait", 150).unwrap();
        db.inbox_insert(&new_inbox_row(1, "/ws", Some(2), Some(1), true), 200)
            .unwrap();
        let mut provisional = new_inbox_row(1, "/ws", Some(2), Some(2), true);
        provisional.provisional = true;
        let second = db.inbox_insert(&provisional, 300).unwrap();
        let mut correction = new_inbox_row(1, "/ws", Some(2), Some(2), true);
        correction.corrects = Some(second);
        let correction_id = db.inbox_insert(&correction, 400).unwrap();

        assert_eq!(
            db.inbox_child_summary(1, 2).unwrap(),
            (3, 1, Some(correction_id)),
            "two results plus their correction are owed, one provisional, \
             the last result names its correction"
        );
        assert_eq!(
            db.inbox_child_summary(1, 9).unwrap(),
            (0, 0, None),
            "another child is unaffected"
        );
    }

    #[test]
    fn a_second_submit_for_the_same_request_replaces_the_first_but_a_reserved_row_is_immutable() {
        let tmp = tempfile::tempdir().unwrap();
        let db = Db::open(&tmp.path().join("t.db")).unwrap();

        let first = db
            .inbox_insert(&new_inbox_row(1, "/ws", Some(2), Some(1), true), 100)
            .unwrap();
        let replaced = db
            .inbox_insert(&new_inbox_row(1, "/ws", Some(2), Some(1), true), 200)
            .unwrap();
        assert_eq!(
            first, replaced,
            "same request_id replaces the earlier row in place"
        );

        let (_, reserved) = db.inbox_reserve(1, 300, 10, 1_000_000).unwrap().unwrap();
        assert_eq!(reserved.len(), 1);
        assert_eq!(reserved[0].id, first);
        assert_eq!(reserved[0].superseded, 1);
        assert_eq!(
            reserved[0].created_at, 100,
            "created_at survives the replace"
        );

        let after_reserve = db
            .inbox_insert(&new_inbox_row(1, "/ws", Some(2), Some(1), true), 400)
            .unwrap();
        assert_ne!(
            after_reserve, first,
            "a reserved row is immutable; the new body becomes a new row"
        );

        let different_request = db
            .inbox_insert(&new_inbox_row(1, "/ws", Some(2), Some(9), true), 500)
            .unwrap();
        assert_ne!(different_request, first);
        assert_ne!(
            different_request, after_reserve,
            "a different request_id is a new row"
        );
    }

    #[test]
    fn a_submit_replaces_a_row_whose_reservation_expired() {
        let tmp = tempfile::tempdir().unwrap();
        let db = Db::open(&tmp.path().join("t.db")).unwrap();

        let first = db
            .inbox_insert(&new_inbox_row(1, "/ws", Some(2), Some(1), true), 100)
            .unwrap();
        let (_, reserved) = db.inbox_reserve(1, 200, 10, 1_000_000).unwrap().unwrap();
        assert_eq!(reserved[0].id, first);

        let after_expiry = 200 + crate::orchestrate::INBOX_RESERVATION_MS + 1;
        let replaced = db
            .inbox_insert(
                &new_inbox_row(1, "/ws", Some(2), Some(1), true),
                after_expiry,
            )
            .unwrap();
        assert_eq!(
            replaced, first,
            "an expired reservation must not read as still held"
        );
    }

    #[test]
    fn two_consecutive_reserves_for_one_session_pick_disjoint_rows() {
        let tmp = tempfile::tempdir().unwrap();
        let db = Db::open(&tmp.path().join("t.db")).unwrap();
        for i in 0..3u32 {
            db.inbox_insert(
                &new_inbox_row(1, "/ws", Some(2), Some(i), true),
                100 + i as u64,
            )
            .unwrap();
        }

        let (_, first) = db.inbox_reserve(1, 1_000, 2, 1_000_000).unwrap().unwrap();
        assert_eq!(first.len(), 2);
        let (_, second) = db.inbox_reserve(1, 1_000, 2, 1_000_000).unwrap().unwrap();
        assert_eq!(second.len(), 1);

        let first_ids: Vec<i64> = first.iter().map(|r| r.id).collect();
        for row in &second {
            assert!(
                !first_ids.contains(&row.id),
                "the second reserve must not repeat a row the first already claimed"
            );
        }
    }

    #[test]
    fn a_full_batch_says_has_more() {
        let tmp = tempfile::tempdir().unwrap();
        let db = Db::open(&tmp.path().join("t.db")).unwrap();
        let total = crate::orchestrate::INBOX_BATCH_MAX_ROWS + 5;
        for i in 0..total {
            db.inbox_insert(
                &new_inbox_row(1, "/ws", Some(2), Some(i), true),
                100 + i as u64,
            )
            .unwrap();
        }

        let (_, reserved) = db
            .inbox_reserve_matching(
                1,
                1_000,
                crate::orchestrate::INBOX_BATCH_MAX_ROWS,
                crate::orchestrate::INBOX_BATCH_MAX_BYTES,
                None,
                None,
            )
            .unwrap()
            .unwrap();
        assert_eq!(
            reserved.len() as u32,
            crate::orchestrate::INBOX_BATCH_MAX_ROWS
        );
        let remaining = db.inbox_count_matching(1, 1_000, None, None).unwrap();
        assert_eq!(
            remaining, 5,
            "the 5 rows past the cap must still read as eligible"
        );
    }

    #[test]
    fn an_expired_reservation_is_eligible_again_and_its_old_delivery_id_is_dead() {
        let tmp = tempfile::tempdir().unwrap();
        let db = Db::open(&tmp.path().join("t.db")).unwrap();
        db.inbox_insert(&new_inbox_row(1, "/ws", Some(2), Some(1), true), 100)
            .unwrap();

        let (old_delivery_id, first) = db.inbox_reserve(1, 200, 10, 1_000_000).unwrap().unwrap();
        assert_eq!(first.len(), 1);

        assert!(
            db.inbox_reserve(1, 300, 10, 1_000_000).unwrap().is_none(),
            "still inside the reservation window"
        );

        let after_expiry = 200 + crate::orchestrate::INBOX_RESERVATION_MS + 1;
        let (new_delivery_id, second) = db
            .inbox_reserve(1, after_expiry, 10, 1_000_000)
            .unwrap()
            .unwrap();
        assert_eq!(second.len(), 1);
        assert_eq!(second[0].id, first[0].id);
        assert_ne!(new_delivery_id, old_delivery_id);

        let changed = db
            .inbox_mark_delivered(&old_delivery_id, "stop_hook", after_expiry + 10)
            .unwrap();
        assert_eq!(
            changed, 0,
            "a stale delivery_id must not confirm a body it no longer names"
        );
    }

    #[test]
    fn a_delivery_id_nobody_reserved_marks_nothing() {
        let tmp = tempfile::tempdir().unwrap();
        let db = Db::open(&tmp.path().join("t.db")).unwrap();
        let changed = db
            .inbox_mark_delivered("not-a-real-delivery-id", "wait", 100)
            .unwrap();
        assert_eq!(changed, 0);
    }

    #[test]
    fn the_inbox_migration_runs_twice_without_duplicating_anything() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("t.db");
        drop(Db::open(&path).unwrap());
        let db = Db::open(&path).unwrap();

        let conn = db.conn.lock().unwrap();
        let table_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'pane_inbox'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(table_count, 1);
        let round_columns: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('delegations') WHERE name = 'round'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(round_columns, 1);
    }

    #[test]
    fn recovery_requeues_unconfirmed_paste_readdresses_a_dead_parent_and_leaves_wait_alone() {
        let tmp = tempfile::tempdir().unwrap();
        let db = Db::open(&tmp.path().join("t.db")).unwrap();

        db.inbox_insert(&new_inbox_row(1, "/ws", None, Some(1), true), 100)
            .unwrap();
        let (paste_delivery, _) = db.inbox_reserve(1, 100, 10, 1_000_000).unwrap().unwrap();
        db.inbox_mark_delivered(&paste_delivery, "paste", 110)
            .unwrap();

        db.inbox_insert(&new_inbox_row(2, "/ws", None, Some(1), true), 100)
            .unwrap();
        let (wait_delivery, _) = db.inbox_reserve(2, 100, 10, 1_000_000).unwrap().unwrap();
        db.inbox_mark_delivered(&wait_delivery, "wait", 110)
            .unwrap();

        db.inbox_insert(&new_inbox_row(3, "/ws", None, Some(1), true), 100)
            .unwrap();

        let recovery = db.inbox_recover_after_restart(&[1, 2]).unwrap();
        assert_eq!(recovery.pastes_requeued, 1);
        assert_eq!(recovery.operator_requeued, 0);
        assert_eq!(recovery.readdressed, 1);

        assert_eq!(
            db.inbox_pending_count(1).unwrap(),
            1,
            "the unconfirmed paste is pending again for its still-live parent"
        );
        assert_eq!(
            db.inbox_pending_count(2).unwrap(),
            0,
            "a wait delivery is final and is never requeued"
        );

        let operator_rows = db.inbox_list_operator("/ws").unwrap();
        assert_eq!(operator_rows.len(), 1);
        assert_eq!(operator_rows[0].original_to, Some(3));
        assert_eq!(operator_rows[0].reason.as_deref(), Some("parent_dead"));
    }

    #[test]
    fn recovery_leaves_a_pending_row_alone_for_a_live_session_and_readdresses_a_dead_ones() {
        let tmp = tempfile::tempdir().unwrap();
        let db = Db::open(&tmp.path().join("t.db")).unwrap();

        db.inbox_insert(&new_inbox_row(1, "/ws", None, Some(1), true), 100)
            .unwrap();
        db.inbox_insert(&new_inbox_row(2, "/ws", None, Some(1), true), 100)
            .unwrap();

        let recovery = db.inbox_recover_after_restart(&[1]).unwrap();
        assert_eq!(recovery.readdressed, 1);

        assert_eq!(
            db.inbox_pending_count(1).unwrap(),
            1,
            "a pending row for a session restore actually brought back stays addressed to it"
        );
        let operator_rows = db.inbox_list_operator("/ws").unwrap();
        assert_eq!(operator_rows.len(), 1);
        assert_eq!(operator_rows[0].original_to, Some(2));
        assert_eq!(operator_rows[0].reason.as_deref(), Some("parent_dead"));
    }

    #[test]
    fn a_delegations_round_starts_at_one_and_bumps_on_reopen() {
        let tmp = tempfile::tempdir().unwrap();
        let db = Db::open(&tmp.path().join("t.db")).unwrap();
        db.delegation_create(1, 2, None, "go", 100).unwrap();
        assert_eq!(db.delegation_round(2).unwrap(), Some(1));

        db.delegation_reopen(2, "working", 200).unwrap();
        assert_eq!(db.delegation_round(2).unwrap(), Some(2));

        db.delegation_reopen(2, "working", 300).unwrap();
        assert_eq!(db.delegation_round(2).unwrap(), Some(3));
    }

    #[test]
    fn the_retention_sweep_deletes_only_rows_the_doors_call_finished() {
        const RETENTION_MS: u64 = 30 * 24 * 60 * 60 * 1000;
        let tmp = tempfile::tempdir().unwrap();
        let db = Db::open(&tmp.path().join("t.db")).unwrap();

        db.inbox_insert(&new_inbox_row(1, "/ws", None, Some(1), true), 100)
            .unwrap();
        let (wait_id, _) = db.inbox_reserve(1, 100, 10, 1_000_000).unwrap().unwrap();
        db.inbox_mark_delivered(&wait_id, "wait", 100).unwrap();

        db.inbox_insert(&new_inbox_row(1, "/ws", None, Some(2), true), 100)
            .unwrap();
        let (paste_id, _) = db.inbox_reserve(1, 100, 10, 1_000_000).unwrap().unwrap();
        db.inbox_mark_delivered(&paste_id, "paste", 100).unwrap();
        db.inbox_confirm(&paste_id, 100).unwrap();

        db.inbox_insert(&new_inbox_row(1, "/ws", None, Some(3), true), 100)
            .unwrap();
        let (unconfirmed_id, _) = db.inbox_reserve(1, 100, 10, 1_000_000).unwrap().unwrap();
        db.inbox_mark_delivered(&unconfirmed_id, "paste", 100)
            .unwrap();

        const FRESH_AT: u64 = 300;
        db.inbox_insert(&new_inbox_row(1, "/ws", None, Some(4), true), FRESH_AT)
            .unwrap();
        let (fresh_id, _) = db
            .inbox_reserve(1, FRESH_AT, 10, 1_000_000)
            .unwrap()
            .unwrap();
        db.inbox_mark_delivered(&fresh_id, "paste", FRESH_AT)
            .unwrap();
        db.inbox_confirm(&fresh_id, FRESH_AT).unwrap();

        db.inbox_insert(&new_inbox_row(1, "/ws", None, Some(5), true), 100)
            .unwrap();

        let pruned = db
            .inbox_prune_expired(FRESH_AT + RETENTION_MS, RETENTION_MS)
            .unwrap();
        assert_eq!(pruned, 2, "the old wait and the old confirmed paste go");

        let rows = db.inbox_list_for_session(1).unwrap();
        assert_eq!(rows.len(), 3, "{rows:?}");
        assert!(
            rows.iter()
                .any(|r| r.delivered_via.as_deref() == Some("paste") && r.confirmed_at.is_none()),
            "the unconfirmed paste stays: {rows:?}"
        );
        assert!(
            rows.iter()
                .any(|r| r.delivered_via.as_deref() == Some("paste") && r.confirmed_at.is_some()),
            "the fresh confirmed row stays: {rows:?}"
        );
        assert!(
            rows.iter()
                .any(|r| r.delivered_at.is_none() && r.confirmed_at.is_none()),
            "the never-delivered row stays: {rows:?}"
        );
    }
}
