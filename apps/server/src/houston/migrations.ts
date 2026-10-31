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

// Task sources: tracker settings per project and provider, poll cursors, links with their
// three-way snapshot, the write-back outbox and the marker namespace. Tokens live in the OS keychain.
const TaskSources = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS houston_task_source_settings (
      project_id TEXT NOT NULL,
      provider TEXT NOT NULL CHECK (provider IN ('github_issues', 'notion')),
      enabled INTEGER NOT NULL,
      settings_json TEXT NOT NULL,
      revision INTEGER NOT NULL DEFAULT 1,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (project_id, provider)
    )
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS houston_task_source_poll (
      project_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      cursor_json TEXT NOT NULL,
      last_sync_at TEXT,
      last_error TEXT,
      refresh_after TEXT,
      PRIMARY KEY (project_id, provider)
    )
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS houston_task_source_links (
      task_id INTEGER NOT NULL,
      project_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      external_id TEXT NOT NULL,
      source TEXT NOT NULL CHECK (source IN ('source', 'pull_request')),
      url TEXT NOT NULL,
      remote_rev TEXT,
      body_hash TEXT,
      fetched_at TEXT,
      synced_at TEXT,
      snapshot_json TEXT NOT NULL,
      sync_state_json TEXT NOT NULL,
      PRIMARY KEY (task_id, provider, external_id, source)
    )
  `;
  yield* sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_houston_task_source_links_item
    ON houston_task_source_links(project_id, provider, external_id) WHERE source = 'source'
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS houston_task_source_outbox (
      id INTEGER PRIMARY KEY,
      project_id TEXT NOT NULL,
      task_id INTEGER NOT NULL,
      provider TEXT NOT NULL,
      action TEXT NOT NULL,
      revision INTEGER NOT NULL,
      payload_json TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      next_attempt_at TEXT NOT NULL,
      last_error TEXT,
      receipt_json TEXT,
      UNIQUE (task_id, provider, action, revision)
    )
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS houston_task_source_identity (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      namespace TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS houston_task_source_import (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      imported_at TEXT NOT NULL,
      counts_json TEXT NOT NULL
    )
  `;
  // Which projects have an OS keychain entry, so a deleted project's entry can be found.
  yield* sql`
    CREATE TABLE IF NOT EXISTS houston_task_source_credentials (
      project_id TEXT NOT NULL,
      provider TEXT NOT NULL CHECK (provider IN ('github_issues', 'notion')),
      PRIMARY KEY (project_id, provider)
    )
  `;
});

// Harness reviews, their findings and decisions, and suspected defects, keyed by upstream
// ProjectId without a foreign key; a deleted project's rows go with its deletion hook.
const HarnessReview = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS houston_harness_settings (
      project_id TEXT PRIMARY KEY,
      scheduled_task_id TEXT,
      seen_review_id INTEGER NOT NULL DEFAULT 0,
      defect_notice_day TEXT,
      updated_at TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS houston_harness_reviews (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id TEXT NOT NULL,
      trigger TEXT NOT NULL CHECK (trigger IN ('scheduled', 'manual', 'imported')),
      scheduled_task_id TEXT,
      thread_id TEXT,
      run_id TEXT,
      provider_instance_id TEXT,
      status TEXT NOT NULL CHECK (status IN ('preparing', 'running', 'published', 'failed')),
      run_dir TEXT NOT NULL,
      started_at TEXT NOT NULL,
      ended_at TEXT,
      window_since TEXT,
      window_until TEXT,
      threads INTEGER,
      prompts INTEGER,
      cost_usd REAL,
      finding_count INTEGER,
      corrections INTEGER NOT NULL DEFAULT 0,
      summary TEXT,
      error TEXT
    )
  `;
  // A restart or a second server process must not start a second run over the same directory.
  yield* sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_houston_harness_reviews_active
    ON houston_harness_reviews(project_id) WHERE status IN ('preparing', 'running')
  `;
  yield* sql`CREATE INDEX IF NOT EXISTS idx_houston_harness_reviews_project ON houston_harness_reviews(project_id, id DESC)`;
  yield* sql`CREATE INDEX IF NOT EXISTS idx_houston_harness_reviews_thread ON houston_harness_reviews(thread_id)`;
  yield* sql`
    CREATE TABLE IF NOT EXISTS houston_harness_findings (
      review_id INTEGER NOT NULL,
      key TEXT NOT NULL,
      title TEXT NOT NULL,
      category TEXT NOT NULL,
      confidence TEXT NOT NULL,
      sessions_json TEXT NOT NULL,
      count INTEGER NOT NULL,
      quotes_json TEXT NOT NULL,
      recommendation_kind TEXT NOT NULL,
      target TEXT NOT NULL,
      recommendation TEXT NOT NULL,
      apply_prompt TEXT NOT NULL,
      PRIMARY KEY (review_id, key)
    )
  `;
  // decided_by is user, not_a_bug, filed or houston:verification; findings and defects share it.
  yield* sql`
    CREATE TABLE IF NOT EXISTS houston_harness_decisions (
      project_id TEXT NOT NULL,
      key TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('open', 'dismissed', 'resolved')),
      decided_at TEXT NOT NULL,
      decided_by TEXT NOT NULL,
      PRIMARY KEY (project_id, key)
    )
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS houston_harness_finding_tasks (
      project_id TEXT NOT NULL,
      key TEXT NOT NULL,
      task_id INTEGER NOT NULL,
      review_id INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (project_id, key, task_id)
    )
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS houston_harness_verifications (
      review_id INTEGER NOT NULL,
      key TEXT NOT NULL,
      task_id INTEGER NOT NULL,
      verdict TEXT NOT NULL CHECK (verdict IN ('gone', 'still_present', 'inconclusive')),
      sessions_after INTEGER NOT NULL,
      evidence_json TEXT NOT NULL,
      PRIMARY KEY (review_id, key, task_id)
    )
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS houston_defects (
      project_id TEXT NOT NULL,
      key TEXT NOT NULL,
      source TEXT NOT NULL CHECK (source IN ('agent', 'detector')),
      detector TEXT,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      evidence_json TEXT NOT NULL,
      destination TEXT NOT NULL CHECK (destination IN ('houston', 'project')),
      reporter_thread_id TEXT,
      first_seen_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      count INTEGER NOT NULL,
      issue_url TEXT,
      PRIMARY KEY (project_id, key)
    )
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS houston_harness_import (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      imported_at TEXT NOT NULL,
      counts_json TEXT NOT NULL
    )
  `;
});

// Task runs: the last thread event they applied, so a restart replays what a crash left unapplied.
const TaskRunsCursor = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS houston_task_runs_cursor (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      sequence INTEGER NOT NULL
    )
  `;
});

// The merge queue, keyed by upstream ProjectId without a foreign key; a deleted project's rows go
// with its deletion hook. JSON columns hold camelCase facts, verification, failure and holds.
const MergeQueue = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS houston_merge_queue_entries (
      project_id TEXT NOT NULL,
      number INTEGER NOT NULL,
      repository TEXT NOT NULL,
      url TEXT NOT NULL,
      title TEXT,
      head_ref TEXT NOT NULL,
      head_sha TEXT NOT NULL,
      base_ref TEXT,
      depends_on INTEGER,
      owner_thread_id TEXT,
      position INTEGER NOT NULL,
      enqueued_at TEXT NOT NULL,
      facts_json TEXT,
      verification_json TEXT,
      failure_json TEXT,
      stacked_json TEXT,
      github_json TEXT,
      PRIMARY KEY (project_id, number)
    )
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS houston_merge_queue_settings (
      project_id TEXT PRIMARY KEY,
      merge_when_verified INTEGER NOT NULL DEFAULT 0,
      verification_command TEXT NOT NULL DEFAULT '',
      time_limit_minutes INTEGER NOT NULL DEFAULT 30,
      paused INTEGER NOT NULL DEFAULT 0,
      acknowledged_at TEXT,
      hand_off_json TEXT,
      revision INTEGER NOT NULL DEFAULT 0
    )
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS houston_merge_queue_log (
      id INTEGER PRIMARY KEY,
      project_id TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('push', 'merge', 'park', 'restack', 'retarget', 'hand_off')),
      number INTEGER NOT NULL,
      repository TEXT NOT NULL,
      url TEXT NOT NULL,
      title TEXT,
      ref_name TEXT,
      old_sha TEXT,
      new_sha TEXT,
      head_sha TEXT,
      fork_sha TEXT,
      method TEXT,
      detail TEXT,
      unattended INTEGER NOT NULL DEFAULT 0,
      at TEXT NOT NULL
    )
  `;
  yield* sql`CREATE INDEX IF NOT EXISTS idx_houston_merge_queue_log_project ON houston_merge_queue_log(project_id, at)`;
  yield* sql`
    CREATE TABLE IF NOT EXISTS houston_merge_queue_global (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      paused INTEGER NOT NULL
    )
  `;
});

// Task source write-back: the installation's random key that write-back markers are keyed with.
// Not a credential: it only makes Houston's own markers unforgeable, so it stays in the database.
const TaskSourceMarkerKey = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE houston_task_source_identity ADD COLUMN marker_key TEXT`;
});

const houstonMigrationEntries = [
  [1, "ReviewFilesViewed", ReviewFilesViewed],
  [2, "TasksBacklog", TasksBacklog],
  [3, "TaskSources", TaskSources],
  [4, "TaskRunsCursor", TaskRunsCursor],
  [5, "MergeQueue", MergeQueue],
  [6, "TaskSourceMarkerKey", TaskSourceMarkerKey],
  [7, "HarnessReview", HarnessReview],
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
