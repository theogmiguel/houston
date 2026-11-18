// Houston 1's tracker tables for import tests, with the final DDL of v1's
// `task_trackers` tables, added to a database from the Tasks v1Fixture.
import * as NodeSqlite from "node:sqlite";

const V1_TRACKER_SCHEMA = `
  CREATE TABLE IF NOT EXISTS task_external_links (
    task_id INTEGER NOT NULL, provider TEXT NOT NULL, external_id TEXT NOT NULL,
    url TEXT NOT NULL, fetched_at_ms INTEGER, body_hash TEXT, remote_rev TEXT,
    synced_at_ms INTEGER, source TEXT NOT NULL DEFAULT 'source', snapshot TEXT NOT NULL,
    sync_state TEXT NOT NULL DEFAULT 'current', PRIMARY KEY(task_id, provider, external_id, source)
  );
  CREATE INDEX IF NOT EXISTS idx_task_external_links_task ON task_external_links(task_id);
  CREATE TABLE IF NOT EXISTS task_tracker_settings (
    workspace TEXT NOT NULL, provider TEXT NOT NULL, settings TEXT NOT NULL,
    PRIMARY KEY(workspace, provider)
  );
  CREATE TABLE IF NOT EXISTS task_tracker_database_identity (
    singleton INTEGER PRIMARY KEY CHECK(singleton=1), namespace TEXT NOT NULL UNIQUE
  );
  CREATE TABLE IF NOT EXISTS task_tracker_poll_state (
    workspace TEXT NOT NULL, provider TEXT NOT NULL, cursor TEXT NOT NULL,
    last_sync_at_ms INTEGER, last_error TEXT, PRIMARY KEY(workspace, provider)
  );
  CREATE TABLE IF NOT EXISTS task_tracker_refresh_cursor (
    workspace TEXT NOT NULL, provider TEXT NOT NULL, after_external_id TEXT,
    PRIMARY KEY(workspace, provider)
  );
  CREATE TABLE IF NOT EXISTS backlog_project_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL, actor TEXT NOT NULL,
    action TEXT NOT NULL, changes TEXT NOT NULL, created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS task_tracker_outbox (
    id INTEGER PRIMARY KEY AUTOINCREMENT, workspace TEXT NOT NULL, task_id INTEGER NOT NULL,
    provider TEXT NOT NULL, action TEXT NOT NULL, revision INTEGER NOT NULL, payload TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at_ms INTEGER NOT NULL DEFAULT 0,
    last_error TEXT, receipt TEXT, UNIQUE(task_id, provider, action, revision)
  );
`;

/** v1's `TaskTrackerWorkspaceSettings` as serde wrote it. */
export const v1Settings = (
  workspace: string,
  provider: "github_issues" | "notion" | "slack",
  patch: Record<string, unknown> = {},
) => ({
  workspace,
  provider,
  enabled: true,
  github_repository: null,
  github_label: null,
  github_assigned_user: null,
  notion_data_source_id: null,
  notion_title_property_id: null,
  notion_description_property_id: null,
  notion_status_property_id: null,
  notion_assignee_property_id: null,
  notion_project_relation_property_id: null,
  notion_assignee_user_id: null,
  notion_active_status_values: [],
  notion_projects_data_source_id: null,
  notion_project_title_property_id: null,
  notion_project_description_property_id: null,
  notion_pr_url_property_id: null,
  notion_status_mapping: {
    todo: null,
    in_progress: null,
    in_review: null,
    done: null,
    canceled: null,
  },
  has_credential: true,
  last_sync_at_ms: 1_700_000_000_000,
  last_error: null,
  ...patch,
});

/** v1's `TaskTrackerSnapshot` for an item imported with `fields`, as serde wrote it. */
export const v1Snapshot = (
  fields: Record<string, string>,
  patch: Record<string, unknown> = {},
) => ({
  base: fields,
  local: fields,
  remote: fields,
  conflicts: [],
  revision: 1,
  project_external_id: null,
  project: null,
  ...patch,
});

export interface V1TrackerFixture {
  readonly namespace?: string;
  readonly settings?: ReadonlyArray<ReturnType<typeof v1Settings>>;
  readonly links?: ReadonlyArray<{
    readonly taskId: number;
    readonly provider: string;
    readonly externalId: string;
    readonly url: string;
    readonly source?: "source" | "pull_request";
    /** Raw JSON; a malformed one tests a row that fails to copy. */
    readonly snapshot: string;
    readonly syncState?: string;
    readonly fetchedAtMs?: number | null;
  }>;
  readonly outbox?: ReadonlyArray<{ readonly workspace: string; readonly taskId: number }>;
  readonly pollState?: ReadonlyArray<{ readonly workspace: string; readonly provider: string }>;
  readonly refreshCursors?: ReadonlyArray<{
    readonly workspace: string;
    readonly provider: string;
  }>;
}

/** Adds v1's tracker tables and rows to the database at `file`. */
export const writeV1TrackerTables = (file: string, fixture: V1TrackerFixture): void => {
  const db = new NodeSqlite.DatabaseSync(file);
  try {
    db.exec(V1_TRACKER_SCHEMA);
    db.exec("BEGIN");
    db.prepare(
      "INSERT INTO task_tracker_database_identity (singleton, namespace) VALUES (1, ?)",
    ).run(fixture.namespace ?? "0123456789abcdef0123456789abcdef");
    const setting = db.prepare(
      "INSERT INTO task_tracker_settings (workspace, provider, settings) VALUES (?, ?, ?)",
    );
    for (const row of fixture.settings ?? []) {
      setting.run(row.workspace, row.provider, JSON.stringify(row));
    }
    const link = db.prepare(
      `INSERT INTO task_external_links (task_id, provider, external_id, url, fetched_at_ms,
        body_hash, remote_rev, synced_at_ms, source, snapshot, sync_state)
       VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?)`,
    );
    for (const row of fixture.links ?? []) {
      link.run(
        row.taskId,
        row.provider,
        row.externalId,
        row.url,
        row.fetchedAtMs ?? 1_700_000_000_000,
        row.fetchedAtMs ?? 1_700_000_000_000,
        row.source ?? "source",
        row.snapshot,
        row.syncState ?? '{"state":"current"}',
      );
    }
    const outbox = db.prepare(
      `INSERT INTO task_tracker_outbox (workspace, task_id, provider, action, revision, payload)
       VALUES (?, ?, 'github_issues', 'status', 1, '{}')`,
    );
    for (const row of fixture.outbox ?? []) outbox.run(row.workspace, row.taskId);
    const poll = db.prepare(
      `INSERT INTO task_tracker_poll_state (workspace, provider, cursor, last_sync_at_ms)
       VALUES (?, ?, '{}', 1)`,
    );
    for (const row of fixture.pollState ?? []) poll.run(row.workspace, row.provider);
    const refresh = db.prepare(
      `INSERT INTO task_tracker_refresh_cursor (workspace, provider, after_external_id)
       VALUES (?, ?, 'x')`,
    );
    for (const row of fixture.refreshCursors ?? []) refresh.run(row.workspace, row.provider);
    db.exec("COMMIT");
  } finally {
    db.close();
  }
};
