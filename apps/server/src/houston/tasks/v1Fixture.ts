// A Houston 1 database for import tests, with the final `backlog_*` schema of
// core/houston-core/src/db/tasks.rs (after its column additions) and the `settings` table.
import * as NodeSqlite from "node:sqlite";

const V1_SCHEMA = `
  CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE backlog_tasks (
    id INTEGER PRIMARY KEY, workspace TEXT, number INTEGER NOT NULL UNIQUE,
    title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', status TEXT NOT NULL,
    priority INTEGER NOT NULL DEFAULT 0, parent_id INTEGER REFERENCES backlog_tasks(id),
    ref_url TEXT, revision INTEGER NOT NULL DEFAULT 1, created_by TEXT NOT NULL,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, archived_at INTEGER
  );
  CREATE INDEX idx_backlog_tasks_workspace_status ON backlog_tasks(workspace, status);
  CREATE TABLE backlog_task_counters (workspace TEXT PRIMARY KEY, next_number INTEGER NOT NULL);
  CREATE TABLE backlog_task_blocks (
    task_id INTEGER NOT NULL, blocked_by_id INTEGER NOT NULL, PRIMARY KEY (task_id, blocked_by_id)
  );
  CREATE TABLE backlog_task_acceptance (
    id INTEGER PRIMARY KEY, task_id INTEGER NOT NULL, position INTEGER NOT NULL,
    text TEXT NOT NULL, checked_at INTEGER, checked_by TEXT
  );
  CREATE TABLE backlog_task_comments (
    id INTEGER PRIMARY KEY, task_id INTEGER NOT NULL, body TEXT NOT NULL,
    author TEXT NOT NULL, created_at INTEGER NOT NULL
  );
  CREATE TABLE backlog_task_history (
    id INTEGER PRIMARY KEY, task_id INTEGER NOT NULL, actor TEXT NOT NULL,
    action TEXT NOT NULL, changes TEXT NOT NULL, created_at INTEGER NOT NULL
  );
  CREATE TABLE backlog_task_runs (
    id INTEGER PRIMARY KEY, task_id INTEGER NOT NULL, attempt INTEGER NOT NULL,
    kind TEXT NOT NULL, state TEXT NOT NULL, provider TEXT NOT NULL, reviewer TEXT,
    session_id INTEGER, delegation_id INTEGER, worktree_path TEXT, branch TEXT,
    base_commit TEXT, initial_revision INTEGER NOT NULL, summary TEXT,
    started_at INTEGER NOT NULL, ended_at INTEGER, reason TEXT, pr_url TEXT,
    review_head_sha TEXT, review_focus TEXT, review_verdict TEXT, review_findings TEXT,
    review_skipped_reason TEXT
  );
  CREATE TABLE backlog_projects (
    id INTEGER PRIMARY KEY AUTOINCREMENT, workspace TEXT NOT NULL, name TEXT NOT NULL,
    external_url TEXT, project_external_id TEXT, tracker_description TEXT,
    local_decisions TEXT NOT NULL DEFAULT '[]', revision INTEGER NOT NULL DEFAULT 1,
    updated_at INTEGER NOT NULL, archived_at INTEGER, UNIQUE(workspace, project_external_id)
  );
  CREATE TABLE backlog_task_domain (
    task_id INTEGER PRIMARY KEY REFERENCES backlog_tasks(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK(kind IN ('delivery', 'slice')),
    project_id INTEGER REFERENCES backlog_projects(id),
    user_status_override INTEGER NOT NULL DEFAULT 0, plan_json TEXT, plan_revision INTEGER,
    approved_task_revision INTEGER, planning_session_id INTEGER, planning_task_revision INTEGER,
    plan_context_bound INTEGER NOT NULL DEFAULT 0, plan_project_id INTEGER,
    plan_project_revision INTEGER, planning_project_id INTEGER, planning_project_revision INTEGER
  );
  CREATE TABLE backlog_task_planning_capabilities (
    session_id INTEGER PRIMARY KEY,
    task_id INTEGER NOT NULL REFERENCES backlog_tasks(id) ON DELETE CASCADE,
    task_revision INTEGER NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('active', 'submitted', 'cancelled', 'exited', 'restarted')),
    project_id INTEGER, project_revision INTEGER
  );
`;

export interface V1TaskRow {
  readonly id: number;
  readonly workspace: string | null;
  readonly number: number;
  readonly title: string;
  readonly description?: string;
  readonly status: string;
  readonly priority?: number;
  readonly parentId?: number | null;
  readonly refUrl?: string | null;
  readonly revision?: number;
  readonly createdBy?: string;
  readonly createdAtMs: number;
  readonly updatedAtMs?: number;
  readonly archivedAtMs?: number | null;
}

export interface V1RunRow {
  readonly id: number;
  readonly taskId: number;
  readonly attempt: number;
  readonly kind: "implementation" | "review";
  readonly state: string;
  readonly provider: string;
  readonly reviewer?: string | null;
  readonly sessionId?: number | null;
  readonly worktreePath?: string | null;
  readonly branch?: string | null;
  readonly baseCommit?: string | null;
  readonly initialRevision: number;
  readonly summary?: string | null;
  readonly reason?: string | null;
  readonly startedAtMs: number;
  readonly endedAtMs?: number | null;
  readonly prUrl?: string | null;
  readonly reviewHeadSha?: string | null;
  readonly reviewFocus?: string | null;
  readonly reviewVerdict?: string | null;
  readonly reviewFindings?: string | null;
  readonly reviewSkippedReason?: string | null;
}

export interface V1Fixture {
  readonly nextNumber: number;
  readonly tasks: ReadonlyArray<V1TaskRow>;
  readonly acceptance?: ReadonlyArray<{
    readonly taskId: number;
    readonly position: number;
    readonly text: string;
    readonly checkedAtMs?: number | null;
    readonly checkedBy?: string | null;
  }>;
  readonly comments?: ReadonlyArray<{
    readonly taskId: number;
    readonly body: string;
    readonly author: string;
    readonly createdAtMs: number;
  }>;
  readonly history?: ReadonlyArray<{
    readonly taskId: number;
    readonly actor: string;
    readonly action: string;
    readonly changes: string;
    readonly createdAtMs: number;
  }>;
  readonly blocks?: ReadonlyArray<{ readonly taskId: number; readonly blockedById: number }>;
  readonly runs?: ReadonlyArray<V1RunRow>;
  readonly projects?: ReadonlyArray<{
    readonly id: number;
    readonly workspace: string;
    readonly name: string;
    readonly externalUrl?: string | null;
    readonly trackerDescription?: string | null;
    readonly localDecisions?: ReadonlyArray<string>;
    readonly revision?: number;
    readonly updatedAtMs?: number;
    readonly archivedAtMs?: number | null;
  }>;
  readonly domains?: ReadonlyArray<{
    readonly taskId: number;
    readonly kind: "delivery" | "slice";
    readonly projectId?: number | null;
    readonly userStatusOverride?: boolean;
    readonly planJson?: string | null;
    readonly planRevision?: number | null;
    readonly approvedTaskRevision?: number | null;
  }>;
  readonly settings?: Readonly<Record<string, string>>;
}

/** Writes a v1 database at `file`; `wal` leaves it in WAL mode as a running daemon does. */
export const writeV1Database = (
  file: string,
  fixture: V1Fixture,
  options: { readonly wal?: boolean } = {},
): void => {
  const db = new NodeSqlite.DatabaseSync(file);
  try {
    db.exec(V1_SCHEMA);
    if (options.wal === true) db.exec("PRAGMA journal_mode = WAL");
    db.exec("BEGIN");
    db.prepare("INSERT INTO backlog_task_counters (workspace, next_number) VALUES ('all', ?)").run(
      fixture.nextNumber,
    );
    const task = db.prepare(
      `INSERT INTO backlog_tasks (id, workspace, number, title, description, status, priority,
        parent_id, ref_url, revision, created_by, created_at, updated_at, archived_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const row of fixture.tasks) {
      task.run(
        row.id,
        row.workspace,
        row.number,
        row.title,
        row.description ?? "",
        row.status,
        row.priority ?? 0,
        row.parentId ?? null,
        row.refUrl ?? null,
        row.revision ?? 1,
        row.createdBy ?? "user",
        row.createdAtMs,
        row.updatedAtMs ?? row.createdAtMs,
        row.archivedAtMs ?? null,
      );
    }
    const acceptance = db.prepare(
      `INSERT INTO backlog_task_acceptance (task_id, position, text, checked_at, checked_by)
       VALUES (?, ?, ?, ?, ?)`,
    );
    for (const row of fixture.acceptance ?? []) {
      acceptance.run(
        row.taskId,
        row.position,
        row.text,
        row.checkedAtMs ?? null,
        row.checkedBy ?? null,
      );
    }
    const comment = db.prepare(
      "INSERT INTO backlog_task_comments (task_id, body, author, created_at) VALUES (?, ?, ?, ?)",
    );
    for (const row of fixture.comments ?? []) {
      comment.run(row.taskId, row.body, row.author, row.createdAtMs);
    }
    const history = db.prepare(
      `INSERT INTO backlog_task_history (task_id, actor, action, changes, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    );
    for (const row of fixture.history ?? []) {
      history.run(row.taskId, row.actor, row.action, row.changes, row.createdAtMs);
    }
    const block = db.prepare(
      "INSERT INTO backlog_task_blocks (task_id, blocked_by_id) VALUES (?, ?)",
    );
    for (const row of fixture.blocks ?? []) block.run(row.taskId, row.blockedById);
    const run = db.prepare(
      `INSERT INTO backlog_task_runs (id, task_id, attempt, kind, state, provider, reviewer,
        session_id, delegation_id, worktree_path, branch, base_commit, initial_revision, summary,
        started_at, ended_at, reason, pr_url, review_head_sha, review_focus, review_verdict,
        review_findings, review_skipped_reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const row of fixture.runs ?? []) {
      run.run(
        row.id,
        row.taskId,
        row.attempt,
        row.kind,
        row.state,
        row.provider,
        row.reviewer ?? null,
        row.sessionId ?? null,
        row.worktreePath ?? null,
        row.branch ?? null,
        row.baseCommit ?? null,
        row.initialRevision,
        row.summary ?? null,
        row.startedAtMs,
        row.endedAtMs ?? null,
        row.reason ?? null,
        row.prUrl ?? null,
        row.reviewHeadSha ?? null,
        row.reviewFocus ?? null,
        row.reviewVerdict ?? null,
        row.reviewFindings ?? null,
        row.reviewSkippedReason ?? null,
      );
    }
    const project = db.prepare(
      `INSERT INTO backlog_projects (id, workspace, name, external_url, tracker_description,
        local_decisions, revision, updated_at, archived_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const row of fixture.projects ?? []) {
      project.run(
        row.id,
        row.workspace,
        row.name,
        row.externalUrl ?? null,
        row.trackerDescription ?? null,
        JSON.stringify(row.localDecisions ?? []),
        row.revision ?? 1,
        row.updatedAtMs ?? 0,
        row.archivedAtMs ?? null,
      );
    }
    const domain = db.prepare(
      `INSERT INTO backlog_task_domain (task_id, kind, project_id, user_status_override, plan_json,
        plan_revision, approved_task_revision, plan_context_bound)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1)`,
    );
    for (const row of fixture.domains ?? []) {
      domain.run(
        row.taskId,
        row.kind,
        row.projectId ?? null,
        row.userStatusOverride === true ? 1 : 0,
        row.planJson ?? null,
        row.planRevision ?? null,
        row.approvedTaskRevision ?? null,
      );
    }
    const setting = db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)");
    for (const [key, value] of Object.entries(fixture.settings ?? {})) setting.run(key, value);
    db.exec("COMMIT");
  } finally {
    db.close();
  }
};
