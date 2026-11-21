import { HoustonLayoutWorkspaceRecord } from "@houston-app/contracts/houston/layoutWorkspaces";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Migrator from "effect/sql/Migrator";
import * as SqlClient from "effect/sql/SqlClient";

import { convertGridTree, readLegacyGrid } from "./layoutWorkspaceConversion.ts";
import { membershipsFromTabs, type StoredWorkspaceTabs } from "./membershipBackfill.ts";
import {
  createProjectionReadIndexes,
  createShellReadModels,
  createTimelineReadIndexes,
  createTurnStartReadModels,
} from "./projectionReadModels.ts";

// Upstream's migrator skips every id up to the highest it recorded, so Houston's schema keeps its
// own history table and ids; upstream's table and ids stay untouched.
const HOUSTON_MIGRATIONS_TABLE = "houston_sql_migrations";

// One row per grid, as an earlier build stored it. The record JSON is a grid's tree of threads;
// project_id, revision and the times are columns. Migration 19 copies each row into a layout
// workspace and migration 20 drops the table.
const Grids = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS houston_grids (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      record_json TEXT NOT NULL,
      revision INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) WITHOUT ROWID
  `;
  yield* sql`CREATE INDEX IF NOT EXISTS idx_houston_grids_project ON houston_grids(project_id, created_at)`;
});

const encodeWorkspace = Schema.encodeSync(Schema.fromJsonString(HoustonLayoutWorkspaceRecord));

const JsonText = Schema.fromJsonString(Schema.Unknown);
const decodeJson = Schema.decodeUnknownOption(JsonText);
const encodeJson = Schema.encodeSync(JsonText);

// One row per layout workspace (record_json is the contract's record). Every grid is copied in as
// columns of panes, houston_grids untouched; a lossy conversion is logged per workspace. An empty
// table gets one empty workspace, so the layout always has one.
const LayoutWorkspaces = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS houston_layout_workspaces (
      id TEXT PRIMARY KEY,
      position INTEGER NOT NULL,
      record_json TEXT NOT NULL,
      revision INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) WITHOUT ROWID
  `;
  yield* sql`CREATE INDEX IF NOT EXISTS idx_houston_layout_workspaces_position ON houston_layout_workspaces(position, created_at)`;

  const grids = yield* sql<{ readonly id: string; readonly record_json: string }>`
    SELECT id, record_json FROM houston_grids ORDER BY created_at, id
  `;
  const next = (yield* sql<{ readonly next: number }>`
    SELECT COALESCE(MAX(position) + 1, 0) AS next FROM houston_layout_workspaces
  `)[0]!.next;
  const claimedThreadIds = new Set<string>();
  let position = next;
  for (const row of grids) {
    const grid = readLegacyGrid(row.record_json);
    if (grid === null) {
      yield* Effect.logWarning(
        `Houston migration LayoutWorkspaces: grid ${row.id} was skipped because its stored record is not a readable grid.`,
      );
      continue;
    }
    const { columns, notes } = convertGridTree({
      gridId: grid.id,
      environmentId: grid.environmentId,
      tree: grid.tree,
      claimedThreadIds,
    });
    if (notes.length > 0) {
      yield* Effect.logWarning(
        `Houston migration LayoutWorkspaces: grid ${grid.id} ("${grid.name}") converted with loss: ${notes.join("; ")}.`,
      );
    }
    const record = {
      id: grid.id,
      name: grid.name,
      position,
      columns,
      pinnedAt: grid.pinnedAt,
      hidden: grid.hidden,
      createdAt: grid.createdAt,
      revision: 1,
      updatedAt: grid.updatedAt,
    };
    const inserted = yield* sql`
      INSERT INTO houston_layout_workspaces (id, position, record_json, revision, created_at, updated_at)
      VALUES (${record.id}, ${position}, ${encodeWorkspace(record)}, 1, ${record.createdAt}, ${record.updatedAt})
      ON CONFLICT (id) DO NOTHING RETURNING id
    `;
    if (inserted.length > 0) position += 1;
  }

  const remaining = yield* sql<{ readonly count: number }>`
    SELECT COUNT(*) AS count FROM houston_layout_workspaces
  `;
  if (remaining[0]!.count === 0) {
    const now = DateTime.formatIso(yield* DateTime.now);
    const record = {
      id: "workspace:default",
      name: "Workspace 1",
      position: 0,
      columns: [],
      pinnedAt: null,
      hidden: false,
      createdAt: now,
      revision: 1,
      updatedAt: now,
    };
    yield* sql`
      INSERT INTO houston_layout_workspaces (id, position, record_json, revision, created_at, updated_at)
      VALUES (${record.id}, 0, ${encodeWorkspace(record)}, 1, ${now}, ${now})
    `;
  }
});

const readStoredColumns = (json: string): StoredWorkspaceTabs["columns"] | null => {
  const parsed = Option.getOrNull(decodeJson(json)) as {
    columns?: StoredWorkspaceTabs["columns"];
  } | null;
  return parsed === null ? null : Array.isArray(parsed.columns) ? parsed.columns : [];
};

// Which workspace each chat thread belongs to, and the last workspace a client reported as
// focused. A thread with an open chat tab starts in that tab's workspace; threads with no tab are
// assigned when the server starts, because only the server knows its environment id.
const LayoutThreadMembership = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS houston_layout_thread_membership (
      environment_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      parent_thread_id TEXT,
      PRIMARY KEY (environment_id, thread_id)
    ) WITHOUT ROWID
  `;
  yield* sql`CREATE INDEX IF NOT EXISTS idx_houston_layout_membership_workspace ON houston_layout_thread_membership(workspace_id)`;
  yield* sql`
    CREATE TABLE IF NOT EXISTS houston_layout_focus (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      workspace_id TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;
  const rows = yield* sql<{ readonly id: string; readonly record_json: string }>`
    SELECT id, record_json FROM houston_layout_workspaces ORDER BY position, created_at, id
  `;
  const workspaces = rows.flatMap((row) => {
    const columns = readStoredColumns(row.record_json);
    return columns === null ? [] : [{ id: row.id, columns }];
  });
  for (const membership of membershipsFromTabs(workspaces)) {
    yield* sql`
      INSERT OR IGNORE INTO houston_layout_thread_membership
        (environment_id, thread_id, workspace_id, parent_thread_id)
      VALUES (${membership.environmentId}, ${membership.threadId}, ${membership.workspaceId}, NULL)
    `;
  }
});

// Migration 19 copied every readable grid into a layout workspace and nothing reads houston_grids
// any more, so the table and its index are removed. A database without the table has nothing to do.
const RemoveGrids = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`DROP INDEX IF EXISTS idx_houston_grids_project`;
  yield* sql`DROP TABLE IF EXISTS houston_grids`;
});

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
// three-way snapshot, the write-back outbox and the marker namespace. Tokens live in the secret store.
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
  // Which projects have a stored token, so a deleted project's token can be found.
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

// Night shift: settings, runs, crew, ledger, pushes and the v1 import, keyed by upstream ProjectId
// without a foreign key; a deleted project's rows go with its deletion hook.
const NightShift = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS houston_night_shift_settings (
      project_id TEXT PRIMARY KEY,
      scheduled_task_id TEXT,
      settings_json TEXT NOT NULL,
      revision INTEGER NOT NULL DEFAULT 1,
      updated_at TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS houston_night_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id TEXT NOT NULL,
      trigger TEXT NOT NULL CHECK (trigger IN ('scheduled', 'catchUp', 'manual', 'imported')),
      scheduled_task_id TEXT,
      phase TEXT NOT NULL
        CHECK (phase IN ('preflight', 'refused', 'running', 'wrappingUp', 'settled')),
      stop_reason TEXT CHECK (stop_reason IS NULL OR stop_reason IN ('report', 'hardStop',
        'stopped', 'idle', 'orchestratorEnded', 'orchestratorLimited', 'serverRestart',
        'launchFailed', 'imported')),
      stop_detail TEXT,
      orchestrator_thread_id TEXT,
      worktree_path TEXT,
      branch TEXT,
      settings_json TEXT NOT NULL,
      started_at TEXT NOT NULL,
      wrap_up_at TEXT,
      hard_stop_at TEXT,
      wrap_up_sent INTEGER NOT NULL DEFAULT 0,
      nudged_at TEXT,
      ended_at TEXT,
      preflight_json TEXT NOT NULL DEFAULT '[]',
      limited_json TEXT NOT NULL DEFAULT '[]',
      remote_heads_json TEXT,
      remote_changes_json TEXT,
      interruptions_json TEXT NOT NULL DEFAULT '[]',
      cost_json TEXT,
      summary TEXT,
      report_path TEXT,
      keep_awake TEXT,
      notice_sent INTEGER NOT NULL DEFAULT 0
    )
  `;
  // A restart or a second server process must not start a second crew in the same project.
  yield* sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_houston_night_runs_live
    ON houston_night_runs(project_id) WHERE phase IN ('preflight', 'running', 'wrappingUp')
  `;
  yield* sql`CREATE INDEX IF NOT EXISTS idx_houston_night_runs_project ON houston_night_runs(project_id, id DESC)`;
  yield* sql`
    CREATE TABLE IF NOT EXISTS houston_night_crew (
      run_id INTEGER NOT NULL,
      thread_id TEXT NOT NULL,
      task_id TEXT,
      parent_thread_id TEXT,
      role TEXT NOT NULL CHECK (role IN ('orchestrator', 'implementation', 'research', 'review',
        'design', 'test', 'general')),
      provider_instance_id TEXT NOT NULL,
      requested_instance_id TEXT,
      worktree_path TEXT,
      branch TEXT,
      started_at TEXT NOT NULL,
      ended_at TEXT,
      PRIMARY KEY (run_id, thread_id)
    )
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS houston_night_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id INTEGER NOT NULL,
      project_id TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('plan', 'pr', 'lesson', 'flaky', 'decision', 'deferred',
        'studied', 'pick', 'verdict')),
      title TEXT NOT NULL,
      theme TEXT,
      status TEXT,
      pr_number INTEGER,
      task_number INTEGER,
      head_sha TEXT,
      branch TEXT,
      visible INTEGER NOT NULL DEFAULT 0,
      qa_passed INTEGER NOT NULL DEFAULT 0,
      body TEXT NOT NULL DEFAULT '',
      detail_json TEXT NOT NULL DEFAULT '{}',
      author_thread_id TEXT,
      created_at TEXT NOT NULL,
      decided_at TEXT,
      choice TEXT
    )
  `;
  yield* sql`CREATE INDEX IF NOT EXISTS idx_houston_night_entries_project ON houston_night_entries(project_id, kind, id DESC)`;
  yield* sql`
    CREATE TABLE IF NOT EXISTS houston_night_pushes (
      run_id INTEGER NOT NULL,
      branch TEXT NOT NULL,
      old_sha TEXT,
      new_sha TEXT NOT NULL,
      pr_number INTEGER,
      at TEXT NOT NULL,
      PRIMARY KEY (run_id, branch, new_sha)
    )
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS houston_night_import (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      imported_at TEXT NOT NULL,
      counts_json TEXT NOT NULL
    )
  `;
});

// v2 keeps routines on the generic scheduled-tasks feature, so the night shift and harness review
// tables are dropped; their ids above stay recorded and unchanged.
const DropNightShiftAndHarnessReview = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  for (const index of [
    "idx_houston_harness_reviews_active",
    "idx_houston_harness_reviews_project",
    "idx_houston_harness_reviews_thread",
    "idx_houston_night_runs_live",
    "idx_houston_night_runs_project",
    "idx_houston_night_entries_project",
  ]) {
    yield* sql`DROP INDEX IF EXISTS ${sql(index)}`;
  }
  for (const table of [
    "houston_harness_settings",
    "houston_harness_reviews",
    "houston_harness_findings",
    "houston_harness_decisions",
    "houston_harness_finding_tasks",
    "houston_harness_verifications",
    "houston_defects",
    "houston_harness_import",
    "houston_night_shift_settings",
    "houston_night_runs",
    "houston_night_crew",
    "houston_night_entries",
    "houston_night_pushes",
    "houston_night_import",
  ]) {
    yield* sql`DROP TABLE IF EXISTS ${sql(table)}`;
  }
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

// Slack intake: one settings row, the channel map with catch-up cursors, the filed requests and
// what each owes Slack. Both tokens live in the secret store; no column holds one.
const SlackIntake = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS houston_slack_settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      enabled INTEGER NOT NULL,
      owner_user_id TEXT,
      language TEXT NOT NULL CHECK (language IN ('en', 'pt-BR')),
      credential_set_at TEXT,
      team_id TEXT,
      team TEXT,
      bot_user_id TEXT,
      revision INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS houston_slack_channels (
      channel_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      cursor_ts TEXT NOT NULL,
      mapped_at TEXT NOT NULL
    )
  `;
  // awaiting_reply marks a mention refused for its text, whose requester's next reply is filed.
  yield* sql`
    CREATE TABLE IF NOT EXISTS houston_slack_requests (
      id INTEGER PRIMARY KEY,
      channel_id TEXT NOT NULL,
      ts TEXT NOT NULL,
      author TEXT NOT NULL,
      project_id TEXT NOT NULL,
      task_id INTEGER,
      state TEXT NOT NULL CHECK (state IN ('pending', 'queued', 'started', 'refused', 'closed')),
      status_reaction TEXT,
      permalink TEXT,
      queued_at TEXT,
      created_at TEXT NOT NULL,
      awaiting_reply INTEGER NOT NULL DEFAULT 0,
      attachments_json TEXT,
      UNIQUE (channel_id, ts)
    )
  `;
  yield* sql`CREATE INDEX IF NOT EXISTS idx_houston_slack_requests_task ON houston_slack_requests(task_id)`;
  yield* sql`
    CREATE TABLE IF NOT EXISTS houston_slack_questions (
      id INTEGER PRIMARY KEY,
      request_id INTEGER NOT NULL,
      task_run_id INTEGER NOT NULL,
      thread_id TEXT NOT NULL,
      form_json TEXT NOT NULL,
      answer TEXT,
      answered_by TEXT,
      answer_ts TEXT,
      created_at TEXT NOT NULL,
      answered_at TEXT,
      delivered_at TEXT
    )
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS houston_slack_results (
      task_run_id INTEGER PRIMARY KEY,
      request_id INTEGER NOT NULL,
      form_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS houston_slack_adjustments (
      id INTEGER PRIMARY KEY,
      request_id INTEGER NOT NULL,
      task_run_id INTEGER NOT NULL,
      ts TEXT NOT NULL,
      text TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('pending', 'accepted', 'refused')),
      created_at TEXT NOT NULL,
      UNIQUE (request_id, ts)
    )
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS houston_slack_outbox (
      id INTEGER PRIMARY KEY,
      request_id INTEGER NOT NULL,
      dedupe_key TEXT NOT NULL UNIQUE,
      target TEXT NOT NULL CHECK (target IN ('thread', 'dm', 'update', 'react', 'ephemeral')),
      text TEXT NOT NULL,
      blocks_json TEXT,
      reaction TEXT,
      remove_reaction TEXT,
      message_ts TEXT,
      update_of TEXT,
      user_id TEXT,
      posted_channel TEXT,
      posted_ts TEXT,
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      created_at TEXT NOT NULL,
      sent_at TEXT
    )
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS houston_slack_import (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      imported_at TEXT NOT NULL,
      counts_json TEXT NOT NULL
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

// One row per project bound to a standalone issue tracker (Linear): which tracker and which of
// its scopes (a team key). Unbinding deletes the row; a project with no row reads only its git
// host's issues. The credential itself lives in the secret store.
const IssueTrackerBindings = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS issue_tracker_bindings (
      project_id TEXT PRIMARY KEY,
      tracker TEXT NOT NULL,
      scope TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) WITHOUT ROWID
  `;
});

// The one-time copy of tokens from the OS keychain, where earlier builds kept them, into the
// secret store. The row exists once every token on record has been read or accounted for.
const SecretStoreImport = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS houston_secret_store_import (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      imported_at TEXT NOT NULL,
      counts_json TEXT NOT NULL
    )
  `;
});

// The issue a task is backed by: at most one per task, named the way the issue service resolves
// it. The identity index is not unique, so an archived task keeps its link while another task
// may be created from the same issue; the service enforces one non-archived task per issue.
const TaskIssues = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS houston_task_issues (
      task_id INTEGER PRIMARY KEY,
      project_id TEXT NOT NULL,
      tracker TEXT NOT NULL,
      host TEXT NOT NULL,
      scope TEXT NOT NULL,
      key TEXT NOT NULL,
      display_key TEXT NOT NULL,
      url TEXT NOT NULL,
      title TEXT NOT NULL,
      linked_at TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_houston_task_issues_identity
    ON houston_task_issues(tracker, host, scope, key)
  `;
});

// The per-project switch that lets a task's status move the issue it is backed by. Off by
// default, so an existing project's issues stay where their tracker has them.
const TaskIssueStateSetting = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    ALTER TABLE houston_task_settings
    ADD COLUMN update_issue_state INTEGER NOT NULL DEFAULT 0
  `;
});

// GitHub issues are no longer a task source: each imported GitHub link becomes the task's issue
// link, and the source's settings, cursors and pending write-back rows go. A link that cannot be
// converted leaves its task unlinked with a history note, never deleted; a task already backed by
// the issue keeps that link.
const GITHUB_EXTERNAL_ID = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)#([1-9][0-9]*)$/;

interface GitHubIssueReference {
  readonly owner: string;
  readonly repository: string;
  readonly number: string;
  readonly host: string;
}

/** The issue a stored external id and URL name, or why they do not name one. */
const githubIssueReference = (
  externalId: string,
  rawUrl: string,
): GitHubIssueReference | string => {
  const match = GITHUB_EXTERNAL_ID.exec(externalId);
  if (match === null) return `${externalId} is not owner/repo#number`;
  const owner = match[1] as string;
  const repository = match[2] as string;
  const number = match[3] as string;
  if (owner === "." || owner === ".." || repository === "." || repository === "..") {
    return `${externalId} is not owner/repo#number`;
  }
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return `${externalId} has no readable URL`;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return `${externalId} has no readable URL`;
  }
  const segments = url.pathname.split("/").filter((part) => part.length > 0);
  const expected = [owner, repository, "issues", number] as Array<string | undefined>;
  if (segments.length !== 4 || segments.some((part, index) => part !== expected[index])) {
    return `${externalId} does not match its URL ${rawUrl}`;
  }
  return { owner, repository, number, host: url.host };
};

/** The title the snapshot recorded for the issue, preferring the tracker's own words. */
const snapshotIssueTitle = (json: string): string | null => {
  const parsed = Option.getOrNull(decodeJson(json)) as Record<string, unknown> | null;
  if (parsed !== null) {
    for (const key of ["remote", "base", "local"]) {
      const fields = parsed[key];
      if (typeof fields !== "object" || fields === null) continue;
      const title = (fields as Record<string, unknown>).title;
      if (typeof title === "string" && title.trim().length > 0) return title.trim();
    }
  }
  return null;
};

const GitHubIssuesAsTaskIssues = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const now = DateTime.formatIso(yield* DateTime.now);
  const rows = yield* sql<{
    readonly task_id: number;
    readonly project_id: string;
    readonly external_id: string;
    readonly url: string;
    readonly snapshot_json: string;
    readonly task_title: string;
  }>`
    SELECT l.task_id, l.project_id, l.external_id, l.url, l.snapshot_json, t.title AS task_title
    FROM houston_task_source_links l
    JOIN houston_tasks t ON t.id = l.task_id
    WHERE l.provider = 'github_issues' AND l.source = 'source'
    ORDER BY l.task_id
  `;
  const skip = (taskId: number, reason: string, externalId: string, url: string) =>
    sql`
      INSERT INTO houston_task_history (task_id, actor, action, changes, created_at)
      VALUES (
        ${taskId}, 'houston:issue-import', 'houston:issue-import-skipped',
        ${encodeJson({ reason, externalId, url })}, ${now}
      )
    `;
  for (const row of rows) {
    const reference = githubIssueReference(row.external_id, row.url);
    if (typeof reference === "string") {
      yield* skip(row.task_id, reference, row.external_id, row.url);
      continue;
    }
    const scope = `${reference.owner}/${reference.repository}`;
    const [own] = yield* sql<{ readonly task_id: number }>`
      SELECT task_id FROM houston_task_issues WHERE task_id = ${row.task_id}
    `;
    if (own !== undefined) {
      yield* skip(
        row.task_id,
        `task ${row.task_id} already has an issue link`,
        row.external_id,
        row.url,
      );
      continue;
    }
    const [holder] = yield* sql<{
      readonly task_id: number;
      readonly archived_at: string | null;
    }>`
      SELECT i.task_id, t.archived_at FROM houston_task_issues i
      JOIN houston_tasks t ON t.id = i.task_id
      WHERE lower(i.tracker) = 'github' AND lower(i.host) = lower(${reference.host})
        AND lower(i.scope) = lower(${scope}) AND i.key = ${reference.number}
      ORDER BY t.archived_at IS NOT NULL, i.task_id LIMIT 1
    `;
    if (holder !== undefined && holder.archived_at === null) {
      yield* skip(
        row.task_id,
        `${scope}#${reference.number} is already the issue of task ${holder.task_id}`,
        row.external_id,
        row.url,
      );
      continue;
    }
    const title = (snapshotIssueTitle(row.snapshot_json) ?? row.task_title).trim();
    if (title.length === 0) {
      yield* skip(row.task_id, `${row.external_id} has no title`, row.external_id, row.url);
      continue;
    }
    yield* sql`
      INSERT INTO houston_task_issues (
        task_id, project_id, tracker, host, scope, key, display_key, url, title, linked_at
      ) VALUES (
        ${row.task_id}, ${row.project_id}, 'github', ${reference.host}, ${scope},
        ${reference.number}, ${`#${reference.number}`},
        ${`https://${reference.host}/${scope}/issues/${reference.number}`}, ${title}, ${now}
      )
    `;
  }
  yield* sql`DELETE FROM houston_task_source_links WHERE provider = 'github_issues'`;
  yield* sql`DELETE FROM houston_task_source_settings WHERE provider = 'github_issues'`;
  yield* sql`DELETE FROM houston_task_source_poll WHERE provider = 'github_issues'`;
  yield* sql`DELETE FROM houston_task_source_outbox WHERE provider = 'github_issues'`;
  yield* sql`DELETE FROM houston_task_source_credentials WHERE provider = 'github_issues'`;
});

// A standalone tracker's binding carries the property mapping its container needs (Notion's
// title, status and optional properties); Linear's empty mapping is the default.
const IssueTrackerBindingProperties = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    ALTER TABLE issue_tracker_bindings
    ADD COLUMN properties_json TEXT NOT NULL DEFAULT '{}'
  `;
});

const NOTION_ID =
  /^(?:[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

const notionId = (value: string) => value.replaceAll("-", "").toLowerCase();
const isNotionPageId = (value: string) => NOTION_ID.test(value.trim());

/** A stored Notion settings JSON's data source and the property mapping it names. */
const notionBindingOf = (
  json: string,
): {
  readonly dataSourceId: string;
  readonly properties: Readonly<Record<string, string>>;
} | null => {
  const parsed = Option.getOrNull(decodeJson(json));
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const fields = parsed as Record<string, unknown>;
  const read = (key: string) => {
    const value = fields[key];
    return typeof value === "string" && value.trim().length > 0 ? value : null;
  };
  const dataSourceId = read("notionDataSourceId");
  if (dataSourceId === null || !isNotionPageId(dataSourceId)) return null;
  const properties: Record<string, string> = {};
  for (const [bindingKey, settingKey] of [
    ["title", "notionTitlePropertyId"],
    ["status", "notionStatusPropertyId"],
    ["body", "notionDescriptionPropertyId"],
    ["assignee", "notionAssigneePropertyId"],
    ["prUrl", "notionPrUrlPropertyId"],
  ] as const) {
    const value = read(settingKey);
    if (value !== null) properties[bindingKey] = value;
  }
  return Object.keys(properties).length === 0
    ? null
    : { dataSourceId: notionId(dataSourceId), properties };
};

/** The title a stored Notion link's snapshot recorded, preferring the tracker's own words. */
const notionSnapshotTitle = (json: string): string | null => {
  const parsed = Option.getOrNull(decodeJson(json)) as Record<string, unknown> | null;
  if (parsed !== null) {
    for (const key of ["remote", "base", "local"]) {
      const fields = parsed[key];
      if (typeof fields !== "object" || fields === null) continue;
      const title = (fields as Record<string, unknown>).title;
      if (typeof title === "string" && title.trim().length > 0) return title.trim();
    }
  }
  return null;
};

const notionPageUrl = (id: string, rawUrl: string): string => {
  try {
    const url = new URL(rawUrl);
    const host = url.hostname.toLowerCase();
    if (
      url.protocol === "https:" &&
      (host === "notion.so" || host.endsWith(".notion.so") || host.endsWith(".notion.site"))
    ) {
      return url.toString();
    }
  } catch {
    // A missing URL still has a canonical page address.
  }
  return `https://www.notion.so/${notionId(id)}`;
};

// Notion pages are no longer a task source: each linked page becomes the task's issue link and
// the per-project Notion settings become the project's tracker binding. The token already in the
// secret store is adopted by the tracker at its first read. The source's tables go afterwards; a
// link that cannot be converted leaves its task unlinked with a history note, never deleted.
const NotionPagesAsTaskIssues = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const now = DateTime.formatIso(yield* DateTime.now);
  const rows = yield* sql<{
    readonly task_id: number;
    readonly project_id: string;
    readonly external_id: string;
    readonly url: string;
    readonly snapshot_json: string;
    readonly synced_at: string | null;
    readonly task_title: string;
    readonly settings_json: string;
  }>`
    SELECT l.task_id, l.project_id, l.external_id, l.url, l.snapshot_json, l.synced_at,
      t.title AS task_title, s.settings_json
    FROM houston_task_source_links l
    JOIN houston_tasks t ON t.id = l.task_id
    LEFT JOIN houston_task_source_settings s
      ON s.project_id = l.project_id AND s.provider = 'notion'
    WHERE l.provider = 'notion' AND l.source = 'source'
    ORDER BY l.task_id
  `;
  const skip = (taskId: number, reason: string, externalId: string, url: string) =>
    sql`
      INSERT INTO houston_task_history (task_id, actor, action, changes, created_at)
      VALUES (
        ${taskId}, 'houston:issue-import', 'houston:issue-import-skipped',
        ${encodeJson({ reason, externalId, url })}, ${now}
      )
    `;
  for (const row of rows) {
    const externalId = row.external_id.trim();
    if (!isNotionPageId(externalId)) {
      yield* skip(row.task_id, `${externalId} is not a Notion page id`, row.external_id, row.url);
      continue;
    }
    const binding = row.settings_json === null ? null : notionBindingOf(row.settings_json);
    if (binding === null) {
      yield* skip(
        row.task_id,
        `project ${row.project_id} has no Notion data source binding`,
        row.external_id,
        row.url,
      );
      continue;
    }
    const key = notionId(externalId);
    const [own] = yield* sql<{ readonly task_id: number }>`
      SELECT task_id FROM houston_task_issues WHERE task_id = ${row.task_id}
    `;
    if (own !== undefined) {
      yield* skip(
        row.task_id,
        `task ${row.task_id} already has an issue link`,
        row.external_id,
        row.url,
      );
      continue;
    }
    const [holder] = yield* sql<{
      readonly task_id: number;
      readonly archived_at: string | null;
    }>`
      SELECT i.task_id, t.archived_at FROM houston_task_issues i
      JOIN houston_tasks t ON t.id = i.task_id
      WHERE lower(i.tracker) = 'notion'
        AND lower(replace(i.scope, '-', '')) = ${notionId(binding.dataSourceId)}
        AND lower(replace(i.key, '-', '')) = ${key}
      ORDER BY t.archived_at IS NOT NULL, i.task_id LIMIT 1
    `;
    if (holder !== undefined && holder.archived_at === null) {
      yield* skip(
        row.task_id,
        `${externalId} is already the issue of task ${holder.task_id}`,
        row.external_id,
        row.url,
      );
      continue;
    }
    const title = (notionSnapshotTitle(row.snapshot_json) ?? row.task_title).trim();
    if (title.length === 0) {
      yield* skip(row.task_id, `${externalId} has no title`, row.external_id, row.url);
      continue;
    }
    yield* sql`
      INSERT INTO houston_task_issues (
        task_id, project_id, tracker, host, scope, key, display_key, url, title, linked_at
      ) VALUES (
        ${row.task_id}, ${row.project_id}, 'notion', 'notion.so', ${binding.dataSourceId},
        ${key}, ${key.slice(0, 8)}, ${notionPageUrl(externalId, row.url)}, ${title},
        ${row.synced_at ?? now}
      )
    `;
  }

  // Each project that configured Notion becomes bound to its data source, unless it already picked
  // a tracker binding itself.
  const settings = yield* sql<{
    readonly project_id: string;
    readonly settings_json: string;
    readonly updated_at: string;
  }>`
    SELECT project_id, settings_json, updated_at FROM houston_task_source_settings
    WHERE provider = 'notion'
  `;
  for (const row of settings) {
    const binding = notionBindingOf(row.settings_json);
    if (binding === null) continue;
    yield* sql`
      INSERT INTO issue_tracker_bindings (project_id, tracker, scope, properties_json, updated_at)
      VALUES (
        ${row.project_id}, 'notion', ${binding.dataSourceId},
        ${encodeJson(binding.properties)}, ${row.updated_at}
      )
      ON CONFLICT (project_id) DO NOTHING
    `;
  }

  // The token's new home: the first project whose Notion token earlier builds stored. The
  // tracker adopts it at its first read, so no token is copied into the database.
  yield* sql`
    CREATE TABLE IF NOT EXISTS houston_issue_tracker_token_adoption (
      tracker TEXT PRIMARY KEY,
      project_id TEXT NOT NULL
    ) WITHOUT ROWID
  `;
  yield* sql`
    INSERT OR IGNORE INTO houston_issue_tracker_token_adoption (tracker, project_id)
    SELECT 'notion', project_id FROM houston_task_source_credentials
    WHERE provider = 'notion' ORDER BY project_id LIMIT 1
  `;

  // The Notion task source is retired; its tables, cursors and write-back rows go with it.
  for (const table of [
    "houston_task_source_links",
    "houston_task_source_settings",
    "houston_task_source_poll",
    "houston_task_source_outbox",
    "houston_task_source_identity",
    "houston_task_source_import",
    "houston_task_source_credentials",
  ]) {
    yield* sql`DROP TABLE IF EXISTS ${sql(table)}`;
  }
  yield* sql`
    CREATE TABLE IF NOT EXISTS houston_issue_import (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      imported_at TEXT NOT NULL,
      counts_json TEXT NOT NULL
    )
  `;
});

// A paired device whose owner must approve it holds no scope until approved. Its grant, how it
// paired and its deadline live here, keyed by session id, so upstream's auth_sessions stays as
// upstream's migrations define it. A session is pending exactly while it has a row.
const PendingDeviceApprovals = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS houston_pending_device_approvals (
      auth_session_id TEXT PRIMARY KEY NOT NULL,
      granted_scopes TEXT NOT NULL,
      paired_via TEXT NOT NULL,
      approval_expires_at TEXT NOT NULL
    )
  `;
});

const houstonMigrationEntries = [
  [1, "ReviewFilesViewed", ReviewFilesViewed],
  [2, "TasksBacklog", TasksBacklog],
  [3, "TaskSources", TaskSources],
  [4, "TaskRunsCursor", TaskRunsCursor],
  [5, "MergeQueue", MergeQueue],
  [6, "TaskSourceMarkerKey", TaskSourceMarkerKey],
  [7, "HarnessReview", HarnessReview],
  [8, "SlackIntake", SlackIntake],
  [9, "NightShift", NightShift],
  [10, "DropNightShiftAndHarnessReview", DropNightShiftAndHarnessReview],
  [11, "SecretStoreImport", SecretStoreImport],
  [12, "ProjectionReadIndexes", createProjectionReadIndexes],
  [13, "ShellReadModels", createShellReadModels],
  [16, "TimelineReadIndex", createTimelineReadIndexes],
  [17, "TurnStartReadModels", createTurnStartReadModels],
  [18, "Grids", Grids],
  [19, "LayoutWorkspaces", LayoutWorkspaces],
  [20, "RemoveGrids", RemoveGrids],
  [21, "LayoutThreadMembership", LayoutThreadMembership],
  [22, "IssueTrackerBindings", IssueTrackerBindings],
  [23, "TaskIssues", TaskIssues],
  [24, "TaskIssueStateSetting", TaskIssueStateSetting],
  [25, "GitHubIssuesAsTaskIssues", GitHubIssuesAsTaskIssues],
  [26, "IssueTrackerBindingProperties", IssueTrackerBindingProperties],
  [27, "NotionPagesAsTaskIssues", NotionPagesAsTaskIssues],
  [28, "PendingDeviceApprovals", PendingDeviceApprovals],
] as const;

/** Every Houston migration id this build knows, for callers that must not run beside an older schema. */
export const HOUSTON_BUILD_MIGRATION_IDS: ReadonlyArray<number> = houstonMigrationEntries.map(
  ([id]) => id,
);

// Ids land in merge order, so a database can record a higher id before a lower one; every
// unrecorded id runs, ascending, each in its own transaction with its history row.
export const runHoustonMigrations = Effect.fn("runHoustonMigrations")(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS ${sql(HOUSTON_MIGRATIONS_TABLE)} (
      migration_id integer PRIMARY KEY NOT NULL,
      created_at datetime NOT NULL DEFAULT current_timestamp,
      name VARCHAR(255) NOT NULL
    )
  `;
  const recorded = new Set(
    (yield* sql<{ readonly migration_id: number }>`
      SELECT migration_id FROM ${sql(HOUSTON_MIGRATIONS_TABLE)}
    `).map((row) => row.migration_id),
  );
  const executed: Array<readonly [number, string]> = [];
  const pending = houstonMigrationEntries
    .filter(([id]) => !recorded.has(id))
    .toSorted(([left], [right]) => left - right);
  for (const [id, name, migration] of pending) {
    const applied = yield* sql.withTransaction(
      Effect.gen(function* () {
        // A second server that recorded this id first wins; this one skips it.
        const claimed = yield* sql`
          INSERT INTO ${sql(HOUSTON_MIGRATIONS_TABLE)} (migration_id, name) VALUES (${id}, ${name})
          ON CONFLICT (migration_id) DO NOTHING RETURNING migration_id
        `;
        if (claimed.length === 0) return false;
        yield* migration.pipe(
          Effect.catch((cause) =>
            Effect.die(
              new Migrator.MigrationError({
                cause,
                kind: "Failed",
                message: `Migration "${id}_${name}" failed`,
              }),
            ),
          ),
        );
        return true;
      }),
    );
    if (applied) executed.push([id, name] as const);
  }
  if (executed.length > 0) {
    yield* Effect.log("Houston migrations ran successfully").pipe(
      Effect.annotateLogs({ migrations: executed.map(([id, name]) => `${id}_${name}`) }),
    );
  }
  return executed;
});
