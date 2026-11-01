// Houston 1's harness review and suspected-defect tables, with their final schema, added to a v1
// database the Tasks fixture wrote. Times are Unix milliseconds, as v1 stored them.
import * as NodeSqlite from "node:sqlite";

const V1_HARNESS_SCHEMA = `
  CREATE TABLE harness_routines (workspace TEXT PRIMARY KEY, routine_id INTEGER NOT NULL UNIQUE);
  CREATE TABLE harness_reviews (
    id INTEGER PRIMARY KEY AUTOINCREMENT, workspace TEXT NOT NULL, routine_id INTEGER NOT NULL,
    run_id INTEGER NOT NULL UNIQUE, session_id INTEGER, status TEXT NOT NULL, run_dir TEXT NOT NULL,
    started_at_ms INTEGER NOT NULL, ended_at_ms INTEGER, window_since TEXT, window_until TEXT,
    sessions INTEGER, prompts INTEGER, cost_usd REAL, summary TEXT, error TEXT
  );
  CREATE TABLE harness_findings (
    review_id INTEGER NOT NULL, key TEXT NOT NULL, title TEXT NOT NULL, category TEXT NOT NULL,
    confidence TEXT NOT NULL, sessions TEXT NOT NULL, count INTEGER NOT NULL, quotes TEXT NOT NULL,
    recommendation_kind TEXT NOT NULL, target TEXT NOT NULL, recommendation TEXT NOT NULL,
    apply_prompt TEXT NOT NULL, PRIMARY KEY (review_id, key)
  );
  CREATE TABLE harness_decisions (
    workspace TEXT NOT NULL, key TEXT NOT NULL, state TEXT NOT NULL,
    decided_at_ms INTEGER NOT NULL, decided_by TEXT NOT NULL DEFAULT 'user',
    PRIMARY KEY (workspace, key)
  );
  CREATE TABLE harness_finding_tasks (
    workspace TEXT NOT NULL, key TEXT NOT NULL, task_id INTEGER NOT NULL,
    review_id INTEGER NOT NULL, created_at_ms INTEGER NOT NULL,
    PRIMARY KEY (workspace, key, task_id)
  );
  CREATE TABLE harness_verifications (
    review_id INTEGER NOT NULL, key TEXT NOT NULL, task_id INTEGER NOT NULL,
    verdict TEXT NOT NULL, sessions_after INTEGER NOT NULL, evidence TEXT NOT NULL,
    PRIMARY KEY (review_id, key, task_id)
  );
  CREATE TABLE suspected_defects (
    workspace TEXT NOT NULL, key TEXT NOT NULL, source TEXT NOT NULL, detector TEXT,
    title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', evidence TEXT NOT NULL,
    destination TEXT NOT NULL, reporter_session INTEGER, first_seen_ms INTEGER NOT NULL,
    last_seen_ms INTEGER NOT NULL, count INTEGER NOT NULL, issue_url TEXT,
    PRIMARY KEY (workspace, key)
  );
`;

export interface V1ReviewRow {
  readonly id: number;
  readonly workspace: string;
  readonly status: "running" | "published" | "failed";
  readonly runDir: string;
  readonly startedAtMs: number;
  readonly endedAtMs?: number | null;
  readonly windowSince?: string | null;
  readonly windowUntil?: string | null;
  readonly sessions?: number | null;
  readonly prompts?: number | null;
  readonly costUsd?: number | null;
  readonly summary?: string | null;
  readonly error?: string | null;
}

export interface V1FindingRow {
  readonly reviewId: number;
  readonly key: string;
  readonly title: string;
  readonly quotes?: ReadonlyArray<string>;
}

export interface V1HarnessFixture {
  readonly reviews: ReadonlyArray<V1ReviewRow>;
  readonly findings?: ReadonlyArray<V1FindingRow>;
  readonly decisions?: ReadonlyArray<{
    readonly workspace: string;
    readonly key: string;
    readonly state: "dismissed" | "resolved";
    readonly decidedAtMs: number;
    readonly decidedBy?: string;
  }>;
  readonly links?: ReadonlyArray<{
    readonly workspace: string;
    readonly key: string;
    readonly taskId: number;
    readonly reviewId: number;
    readonly createdAtMs: number;
  }>;
  readonly verifications?: ReadonlyArray<{
    readonly reviewId: number;
    readonly key: string;
    readonly taskId: number;
    readonly verdict: "gone" | "still_present" | "inconclusive";
    readonly sessionsAfter: number;
    readonly evidence: ReadonlyArray<string>;
  }>;
  readonly defects?: ReadonlyArray<{
    readonly workspace: string;
    readonly key: string;
    readonly source: "agent" | "detector";
    readonly detector?: string | null;
    readonly title: string;
    readonly description?: string;
    readonly evidence: ReadonlyArray<string>;
    readonly destination: "houston" | "workspace";
    readonly firstSeenMs: number;
    readonly lastSeenMs: number;
    readonly count: number;
    readonly issueUrl?: string | null;
  }>;
  /** `harness_seen:<workspace>` settings: the seen review id per workspace. */
  readonly seen?: Readonly<Record<string, number>>;
}

/** Adds v1's harness and defect tables and `fixture`'s rows to the database at `file`. */
export const writeV1Harness = (file: string, fixture: V1HarnessFixture): void => {
  const db = new NodeSqlite.DatabaseSync(file);
  try {
    db.exec(V1_HARNESS_SCHEMA);
    db.exec("BEGIN");
    const review = db.prepare(
      `INSERT INTO harness_reviews (id, workspace, routine_id, run_id, status, run_dir,
        started_at_ms, ended_at_ms, window_since, window_until, sessions, prompts, cost_usd,
        summary, error) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const row of fixture.reviews) {
      review.run(
        row.id,
        row.workspace,
        1000 + row.id,
        row.status,
        row.runDir,
        row.startedAtMs,
        row.endedAtMs ?? null,
        row.windowSince ?? null,
        row.windowUntil ?? null,
        row.sessions ?? null,
        row.prompts ?? null,
        row.costUsd ?? null,
        row.summary ?? null,
        row.error ?? null,
      );
    }
    const finding = db.prepare(
      `INSERT INTO harness_findings (review_id, key, title, category, confidence, sessions, count,
        quotes, recommendation_kind, target, recommendation, apply_prompt)
       VALUES (?, ?, ?, 'permissions', 'high', '["s-1"]', 2, ?, 'settings-allow',
        '.claude/settings.json', 'Allow it', 'Add the rule')`,
    );
    for (const row of fixture.findings ?? []) {
      finding.run(row.reviewId, row.key, row.title, JSON.stringify(row.quotes ?? ["a quote"]));
    }
    const decision = db.prepare(
      `INSERT INTO harness_decisions (workspace, key, state, decided_at_ms, decided_by)
       VALUES (?, ?, ?, ?, ?)`,
    );
    for (const row of fixture.decisions ?? []) {
      decision.run(row.workspace, row.key, row.state, row.decidedAtMs, row.decidedBy ?? "user");
    }
    const link = db.prepare(
      `INSERT INTO harness_finding_tasks (workspace, key, task_id, review_id, created_at_ms)
       VALUES (?, ?, ?, ?, ?)`,
    );
    for (const row of fixture.links ?? []) {
      link.run(row.workspace, row.key, row.taskId, row.reviewId, row.createdAtMs);
    }
    const verification = db.prepare(
      `INSERT INTO harness_verifications (review_id, key, task_id, verdict, sessions_after, evidence)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    for (const row of fixture.verifications ?? []) {
      verification.run(
        row.reviewId,
        row.key,
        row.taskId,
        row.verdict,
        row.sessionsAfter,
        JSON.stringify(row.evidence),
      );
    }
    const defect = db.prepare(
      `INSERT INTO suspected_defects (workspace, key, source, detector, title, description,
        evidence, destination, first_seen_ms, last_seen_ms, count, issue_url)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const row of fixture.defects ?? []) {
      defect.run(
        row.workspace,
        row.key,
        row.source,
        row.detector ?? null,
        row.title,
        row.description ?? "",
        JSON.stringify(row.evidence),
        row.destination,
        row.firstSeenMs,
        row.lastSeenMs,
        row.count,
        row.issueUrl ?? null,
      );
    }
    const setting = db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)");
    for (const [workspace, id] of Object.entries(fixture.seen ?? {})) {
      setting.run(`harness_seen:${workspace}`, String(id));
    }
    db.exec("COMMIT");
  } finally {
    db.close();
  }
};
