// @effect-diagnostics nodeBuiltinImport:off - writes a Houston 1 database for the import tests.
// A Houston 1 database with the tables its Night shift kept, as v1's last schema made them.
import * as NodeSqlite from "node:sqlite";

export interface V1Agent {
  readonly provider: string;
  readonly model?: string | null;
}

/** A v1 settings document (`{"v":2}`), snake_case as v1 serialized it. */
export const v1Settings = (patch: Record<string, unknown> = {}): Record<string, unknown> => ({
  v: 2,
  enabled: true,
  window: {
    start: { hour: 23, minute: 30 },
    wrap_up: { hour: 6, minute: 45 },
    hard_stop: { hour: 7, minute: 30 },
    nights: [2, 4],
  },
  focus: {
    reliability: "high",
    performance: "normal",
    ui_polish: "off",
    competitor_gaps: "low",
    docs_accuracy: "off",
    test_gaps: "off",
  },
  direction: "Make uploads reliable.",
  competitors: [
    { kind: "repo", repo: "acme/rival" },
    { kind: "app", name: "Rival", version: "1.0", path: "/Applications/Rival.app" },
  ],
  orchestrator: { provider: "claude", model: "opus" },
  workers: [
    { provider: "zcode", model: "GLM-5.3-Flash" },
    { provider: "claude", model: "opus" },
  ],
  live_workers: 3,
  reviewer: null,
  output: "prs",
  pr_size: { kind: "related", max_changes: 4 },
  screenshots: true,
  app_qa: { enabled: false, start_command: "", source: "", address: "", smoke_flows: [] },
  hold_for_qa: true,
  checks: [{ command: "git --version", source: "ci.yml · checks" }],
  verification: "light",
  questions: "park",
  ...patch,
});

export interface V1Routine {
  readonly id: number;
  readonly workspace: string;
  readonly settings: Record<string, unknown>;
}

export interface V1Run {
  readonly runId: number;
  readonly routineId: number;
  readonly workspace: string;
  readonly phase: string;
  readonly stopReason: string | null;
  readonly startedAtMs: number;
  readonly endedAtMs: number | null;
  readonly summary?: string | null;
  readonly interruptions?: ReadonlyArray<{ readonly at_ms: number; readonly detail: string }>;
}

export interface V1Entry {
  readonly runId: number;
  readonly kind: string;
  readonly title: string;
  readonly theme?: string | null;
  readonly status?: string | null;
  readonly prNumber?: number | null;
  readonly body?: string;
  readonly createdAtMs: number;
  readonly choice?: string | null;
  readonly decidedAtMs?: number | null;
  readonly detail?: Record<string, unknown>;
}

export interface V1NightFixture {
  readonly workspaces: ReadonlyArray<string>;
  readonly routines: ReadonlyArray<V1Routine>;
  readonly runs: ReadonlyArray<V1Run>;
  readonly entries: ReadonlyArray<V1Entry>;
}

/** Writes `fixture` to a new v1 database at `path`, in WAL mode as v1 ran it. */
export const writeV1NightDatabase = (path: string, fixture: V1NightFixture) => {
  const db = new NodeSqlite.DatabaseSync(path);
  try {
    db.exec(`PRAGMA journal_mode = WAL;
      CREATE TABLE workspaces (path TEXT PRIMARY KEY, name TEXT NOT NULL, added_at INTEGER NOT NULL);
      CREATE TABLE routines (
        id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, name_folded TEXT NOT NULL,
        prompt TEXT NOT NULL, cadence TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
        workspace_id TEXT, engine TEXT NOT NULL DEFAULT 'claude', model TEXT, effort TEXT,
        next_run_at_ms INTEGER NOT NULL, last_run_at_ms INTEGER, last_run_session_id INTEGER,
        last_error TEXT, revision TEXT NOT NULL, created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL);
      CREATE TABLE night_shift_settings (routine_id INTEGER PRIMARY KEY, json TEXT NOT NULL);
      CREATE TABLE night_runs (
        run_id INTEGER PRIMARY KEY, routine_id INTEGER NOT NULL, workspace TEXT NOT NULL,
        report_path TEXT NOT NULL, summary TEXT, started_at_ms INTEGER NOT NULL,
        ended_at_ms INTEGER, interruptions_json TEXT NOT NULL DEFAULT '[]',
        cost_json TEXT NOT NULL DEFAULT '{}', trigger TEXT NOT NULL, phase TEXT NOT NULL,
        session_id INTEGER, wrap_up_at_ms INTEGER NOT NULL, hard_stop_at_ms INTEGER NOT NULL,
        wrap_up_sent INTEGER NOT NULL DEFAULT 0, report_published INTEGER NOT NULL DEFAULT 0,
        stop_reason TEXT, stop_detail TEXT, limited_json TEXT NOT NULL DEFAULT '[]',
        preflight_json TEXT NOT NULL DEFAULT '[]', keep_awake TEXT NOT NULL DEFAULT 'off',
        merge_order_json TEXT NOT NULL DEFAULT '[]', heartbeat_ms INTEGER,
        crew_json TEXT NOT NULL DEFAULT '[]', goal_sent INTEGER NOT NULL DEFAULT 0,
        tokens_scanned INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE night_entries (
        id INTEGER PRIMARY KEY AUTOINCREMENT, run_id INTEGER NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('plan','pr','lesson','decision','deferred','flaky','studied')),
        title TEXT NOT NULL, theme TEXT, status TEXT, pr_number INTEGER,
        visible INT NOT NULL DEFAULT 0, qa_passed INT NOT NULL DEFAULT 0,
        body TEXT NOT NULL DEFAULT '', created_at_ms INTEGER NOT NULL, decided_at_ms INTEGER,
        choice TEXT, gates_json TEXT NOT NULL DEFAULT '{}', detail_json TEXT NOT NULL DEFAULT '{}');`);
    for (const workspace of fixture.workspaces) {
      db.prepare("INSERT INTO workspaces (path, name, added_at) VALUES (?, ?, 0)").run(
        workspace,
        workspace,
      );
    }
    for (const routine of fixture.routines) {
      db.prepare(
        `INSERT INTO routines (id, name, name_folded, prompt, cadence, workspace_id,
          next_run_at_ms, revision, created_at, updated_at)
         VALUES (?, 'Night shift', 'night shift', '', 'night_shift', ?, 0, 'r1', 0, 0)`,
      ).run(routine.id, routine.workspace);
      db.prepare("INSERT INTO night_shift_settings (routine_id, json) VALUES (?, ?)").run(
        routine.id,
        JSON.stringify(routine.settings),
      );
    }
    for (const run of fixture.runs) {
      db.prepare(
        `INSERT INTO night_runs (run_id, routine_id, workspace, report_path, summary,
          started_at_ms, ended_at_ms, interruptions_json, trigger, phase, wrap_up_at_ms,
          hard_stop_at_ms, stop_reason)
         VALUES (?, ?, ?, '/home/v1/.houston/night-shift/report.md', ?, ?, ?, ?, 'scheduled', ?, ?, ?, ?)`,
      ).run(
        run.runId,
        run.routineId,
        run.workspace,
        run.summary ?? null,
        run.startedAtMs,
        run.endedAtMs,
        JSON.stringify(
          (run.interruptions ?? []).map((item) => ({
            at_ms: item.at_ms,
            resumed_at_ms: item.at_ms,
            detail: item.detail,
            resumed: true,
          })),
        ),
        run.phase,
        run.startedAtMs + 7 * 3_600_000,
        run.startedAtMs + 8 * 3_600_000,
        run.stopReason,
      );
    }
    for (const entry of fixture.entries) {
      db.prepare(
        `INSERT INTO night_entries (run_id, kind, title, theme, status, pr_number, body,
          created_at_ms, decided_at_ms, choice, detail_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        entry.runId,
        entry.kind,
        entry.title,
        entry.theme ?? null,
        entry.status ?? null,
        entry.prNumber ?? null,
        entry.body ?? "",
        entry.createdAtMs,
        entry.decidedAtMs ?? null,
        entry.choice ?? null,
        JSON.stringify(entry.detail ?? {}),
      );
    }
  } finally {
    db.close();
  }
};
