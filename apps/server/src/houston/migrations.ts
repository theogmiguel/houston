import * as Effect from "effect/Effect";
import * as Migrator from "effect/sql/Migrator";
import * as SqlClient from "effect/sql/SqlClient";

// Upstream's migrator skips every id up to the highest it recorded, so Houston's schema keeps its
// own history table and ids; upstream's table and ids stay untouched.
const HOUSTON_MIGRATIONS_TABLE = "houston_sql_migrations";

const ReviewFilesViewed = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // Unticks delete their row; ref_name is "" on a detached HEAD, blob "" for an absent path.
  yield* sql`
    CREATE TABLE IF NOT EXISTS houston_review_files_viewed (
      worktree_root TEXT NOT NULL,
      ref_name TEXT NOT NULL,
      path TEXT NOT NULL,
      head_sha TEXT,
      blob TEXT NOT NULL,
      viewed_at TEXT NOT NULL,
      PRIMARY KEY (worktree_root, ref_name, path)
    ) WITHOUT ROWID
  `;
});

// The Tasks backlog. Times are ISO text; project_id is an upstream ProjectId without a foreign
// key, so a deleted project leaves its tasks unassigned. Numbers come from the one counter row.
const TasksBacklog = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS houston_tasks (
      id INTEGER PRIMARY KEY,
      number INTEGER NOT NULL UNIQUE,
      project_id TEXT,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL,
      priority INTEGER NOT NULL DEFAULT 0,
      parent_id INTEGER,
      ref_url TEXT,
      revision INTEGER NOT NULL DEFAULT 1,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      archived_at TEXT
    )
  `;
  yield* sql`CREATE INDEX IF NOT EXISTS idx_houston_tasks_project ON houston_tasks(project_id, status)`;
  yield* sql`CREATE INDEX IF NOT EXISTS idx_houston_tasks_parent ON houston_tasks(parent_id)`;
  yield* sql`
    CREATE TABLE IF NOT EXISTS houston_task_counter (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      next_number INTEGER NOT NULL
    )
  `;
  yield* sql`INSERT OR IGNORE INTO houston_task_counter (id, next_number) VALUES (1, 1)`;
  yield* sql`
    CREATE TABLE IF NOT EXISTS houston_task_blocks (
      task_id INTEGER NOT NULL,
      blocked_by_id INTEGER NOT NULL,
      PRIMARY KEY (task_id, blocked_by_id)
    ) WITHOUT ROWID
  `;
  yield* sql`CREATE INDEX IF NOT EXISTS idx_houston_task_blocks_by ON houston_task_blocks(blocked_by_id)`;
  yield* sql`
    CREATE TABLE IF NOT EXISTS houston_task_acceptance (
      id INTEGER PRIMARY KEY,
      task_id INTEGER NOT NULL,
      position INTEGER NOT NULL,
      text TEXT NOT NULL,
      checked_at TEXT,
      checked_by TEXT
    )
  `;
  yield* sql`CREATE INDEX IF NOT EXISTS idx_houston_task_acceptance_task ON houston_task_acceptance(task_id, position)`;
  // author_label and actor_label keep an agent thread's title as it was at write time.
  yield* sql`
    CREATE TABLE IF NOT EXISTS houston_task_comments (
      id INTEGER PRIMARY KEY,
      task_id INTEGER NOT NULL,
      body TEXT NOT NULL,
      author TEXT NOT NULL,
      author_label TEXT,
      created_at TEXT NOT NULL
    )
  `;
  yield* sql`CREATE INDEX IF NOT EXISTS idx_houston_task_comments_task ON houston_task_comments(task_id, id)`;
  yield* sql`
    CREATE TABLE IF NOT EXISTS houston_task_history (
      id INTEGER PRIMARY KEY,
      task_id INTEGER NOT NULL,
      actor TEXT NOT NULL,
      actor_label TEXT,
      action TEXT NOT NULL,
      changes TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `;
  yield* sql`CREATE INDEX IF NOT EXISTS idx_houston_task_history_task ON houston_task_history(task_id, id)`;
  yield* sql`
    CREATE TABLE IF NOT EXISTS houston_task_runs (
      id INTEGER PRIMARY KEY,
      task_id INTEGER NOT NULL,
      attempt INTEGER NOT NULL,
      kind TEXT NOT NULL,
      state TEXT NOT NULL,
      provider TEXT NOT NULL,
      reviewer TEXT,
      thread_id TEXT,
      run_id TEXT,
      worktree_path TEXT,
      branch TEXT,
      base_commit TEXT,
      initial_revision INTEGER NOT NULL,
      summary TEXT,
      reason TEXT,
      started_at TEXT NOT NULL,
      ended_at TEXT,
      pr_url TEXT,
      review_head_sha TEXT,
      review_focus TEXT,
      review_verdict TEXT,
      review_findings TEXT,
      review_skipped_reason TEXT
    )
  `;
  yield* sql`CREATE INDEX IF NOT EXISTS idx_houston_task_runs_task ON houston_task_runs(task_id, id)`;
  yield* sql`CREATE INDEX IF NOT EXISTS idx_houston_task_runs_thread ON houston_task_runs(thread_id)`;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_houston_task_runs_open ON houston_task_runs(task_id)
    WHERE state IN ('preparing', 'running', 'waiting_for_input', 'validating')
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS houston_task_initiatives (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id TEXT,
      name TEXT NOT NULL,
      external_url TEXT,
      project_external_id TEXT,
      tracker_description TEXT,
      local_decisions TEXT NOT NULL DEFAULT '[]',
      revision INTEGER NOT NULL DEFAULT 1,
      updated_at TEXT NOT NULL,
      archived_at TEXT
    )
  `;
  yield* sql`CREATE INDEX IF NOT EXISTS idx_houston_task_initiatives_project ON houston_task_initiatives(project_id, archived_at, id)`;
  yield* sql`
    CREATE TABLE IF NOT EXISTS houston_task_domain (
      task_id INTEGER PRIMARY KEY,
      kind TEXT NOT NULL CHECK (kind IN ('delivery', 'slice')),
      initiative_id INTEGER,
      user_status_override INTEGER NOT NULL DEFAULT 0,
      plan_json TEXT,
      plan_revision INTEGER,
      approved_task_revision INTEGER,
      planning_thread_id TEXT,
      planning_task_revision INTEGER,
      plan_context_bound INTEGER NOT NULL DEFAULT 0,
      plan_initiative_id INTEGER,
      plan_initiative_revision INTEGER,
      planning_initiative_id INTEGER,
      planning_initiative_revision INTEGER
    )
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS houston_task_planning (
      thread_id TEXT PRIMARY KEY,
      task_id INTEGER NOT NULL,
      task_revision INTEGER NOT NULL,
      initiative_id INTEGER,
      initiative_revision INTEGER,
      state TEXT NOT NULL CHECK (state IN ('active', 'submitted', 'cancelled', 'exited')),
      created_at TEXT NOT NULL
    )
  `;
  yield* sql`CREATE INDEX IF NOT EXISTS idx_houston_task_planning_task ON houston_task_planning(task_id, state)`;
  // start_model and reviewer hold ModelSelection JSON; a null review_mode follows the reviewer.
  yield* sql`
    CREATE TABLE IF NOT EXISTS houston_task_settings (
      project_id TEXT PRIMARY KEY,
      access TEXT NOT NULL,
      start_model TEXT NOT NULL,
      delivery TEXT NOT NULL,
      reviewer TEXT,
      review_mode TEXT,
      focus TEXT NOT NULL,
      rework_rounds INTEGER NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS houston_task_import (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      source TEXT NOT NULL,
      imported_at TEXT NOT NULL,
      counts_json TEXT NOT NULL
    )
  `;
});

const houstonMigrationEntries = [
  [1, "ReviewFilesViewed", ReviewFilesViewed],
  [2, "TasksBacklog", TasksBacklog],
] as const;

const run = Migrator.make({});

export const runHoustonMigrations = Effect.fn("runHoustonMigrations")(function* () {
  const executed = yield* run({
    table: HOUSTON_MIGRATIONS_TABLE,
    loader: Migrator.fromRecord(
      Object.fromEntries(
        houstonMigrationEntries.map(([id, name, migration]) => [`${id}_${name}`, migration]),
      ),
    ),
  });
  if (executed.length > 0) {
    yield* Effect.log("Houston migrations ran successfully").pipe(
      Effect.annotateLogs({ migrations: executed.map(([id, name]) => `${id}_${name}`) }),
    );
  }
  return executed;
});
