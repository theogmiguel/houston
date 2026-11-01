// The one-time import of Houston 1's harness reviews and suspected defects. v1's database beside a
// hosted server's base dir is copied to a temporary directory and read there, never written; it
// runs after the Tasks import, into a store with no reviews and no defects, in one transaction.
import * as NodeSqlite from "node:sqlite";

import type { ProjectId } from "@t3tools/contracts";
import {
  HoustonHarnessError,
  HoustonHarnessImportCounts,
  type HoustonHarnessImportResult,
  type HoustonHarnessImportStatus,
} from "@t3tools/contracts/houston/harnessReview";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerConfig from "../../config.ts";
import * as ProjectStore from "../../orchestration-v2/ProjectStore.ts";
import { HostedLaunch } from "../baseDir.ts";
import { v1PathMatches, v1PathUnder } from "../tasks/rules.ts";
import { HoustonHarnessStore } from "./Store.ts";

const OPERATION = "houston.harness.importV1.run";
const V1_DATABASE = "houston.db";
const V1_COMPANIONS = ["-wal", "-shm"] as const;
const SEEN_PREFIX = "harness_seen:";

type SqlValue = string | number | null;
type Row = Readonly<Record<string, SqlValue>>;

interface V1Snapshot {
  readonly reviews: ReadonlyArray<Row>;
  readonly findings: ReadonlyArray<Row>;
  readonly decisions: ReadonlyArray<Row>;
  readonly links: ReadonlyArray<Row>;
  readonly verifications: ReadonlyArray<Row>;
  readonly defects: ReadonlyArray<Row>;
  readonly seen: ReadonlyArray<Row>;
  /** v1 task id to task number, which the Tasks import kept. */
  readonly taskNumbers: ReadonlyArray<Row>;
}

/** Every v1 row the import copies, read in one read transaction. */
const readV1 = (file: string): V1Snapshot => {
  const db = new NodeSqlite.DatabaseSync(file, { readOnly: true });
  try {
    db.exec("BEGIN");
    try {
      const tables = new Set(
        (
          db
            .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
            .all() as ReadonlyArray<Row>
        ).map((row) => String(row.name)),
      );
      const all = (table: string, query: string) =>
        tables.has(table) ? (db.prepare(query).all() as ReadonlyArray<Row>) : [];
      return {
        reviews: all("harness_reviews", "SELECT * FROM harness_reviews ORDER BY id"),
        findings: all(
          "harness_findings",
          "SELECT * FROM harness_findings ORDER BY review_id, rowid",
        ),
        decisions: all("harness_decisions", "SELECT * FROM harness_decisions ORDER BY rowid"),
        links: all("harness_finding_tasks", "SELECT * FROM harness_finding_tasks ORDER BY rowid"),
        verifications: all(
          "harness_verifications",
          "SELECT * FROM harness_verifications ORDER BY review_id, rowid",
        ),
        defects: all("suspected_defects", "SELECT * FROM suspected_defects ORDER BY rowid"),
        seen: all(
          "settings",
          `SELECT key, value FROM settings WHERE key LIKE '${SEEN_PREFIX}%' ORDER BY key`,
        ),
        taskNumbers: all("backlog_tasks", "SELECT id, number FROM backlog_tasks"),
      };
    } finally {
      db.exec("COMMIT");
    }
  } finally {
    db.close();
  }
};

const iso = (ms: SqlValue | undefined) =>
  ms === null || ms === undefined ? null : DateTime.formatIso(DateTime.makeUnsafe(Number(ms)));

const encodeCounts = Schema.encodeSync(Schema.fromJsonString(HoustonHarnessImportCounts));
const decodeCounts = Schema.decodeUnknownSync(Schema.fromJsonString(HoustonHarnessImportCounts));

const refuse = (kind: HoustonHarnessError["kind"], message: string) =>
  new HoustonHarnessError({ kind, operation: OPERATION, message });

export class HoustonHarnessV1Import extends Context.Service<
  HoustonHarnessV1Import,
  {
    readonly status: Effect.Effect<HoustonHarnessImportStatus>;
    readonly run: Effect.Effect<HoustonHarnessImportResult, HoustonHarnessError>;
  }
>()("houston/houston/harnessReview/V1Import/HoustonHarnessV1Import") {}

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const sql = yield* SqlClient.SqlClient;
  const store = yield* HoustonHarnessStore;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const platform = yield* HostProcess.Platform;
  const hosted = yield* HostedLaunch;

  const sourcePath = path.join(path.dirname(config.baseDir), V1_DATABASE);
  const source = Effect.gen(function* () {
    if (!hosted) return null;
    const exists = yield* fs.exists(sourcePath).pipe(Effect.orElseSucceed(() => false));
    return exists ? sourcePath : null;
  });

  /** Reads a temporary copy of v1's file and its companions, so nothing is created beside it. */
  const fromCopy = (file: string) =>
    Effect.scoped(
      Effect.gen(function* () {
        const dir = yield* fs.makeTempDirectoryScoped({ prefix: "houston-harness-v1-copy-" });
        const copy = path.join(dir, V1_DATABASE);
        yield* fs.copyFile(file, copy);
        for (const suffix of V1_COMPANIONS) {
          if (yield* fs.exists(`${file}${suffix}`)) {
            yield* fs.copyFile(`${file}${suffix}`, `${copy}${suffix}`);
          }
        }
        return yield* Effect.try(() => readV1(copy));
      }),
    );

  const importRow = sql<{ readonly imported_at: string; readonly counts_json: string }>`
    SELECT imported_at, counts_json FROM houston_harness_import WHERE id = 1
  `.pipe(
    Effect.map((rows) => rows[0]),
    Effect.orDie,
  );

  const tasksImported = sql<{ readonly n: number }>`
    SELECT COUNT(*) AS n FROM houston_task_import
  `.pipe(
    Effect.map((rows) => (rows[0]?.n ?? 0) > 0),
    Effect.orDie,
  );

  /** What v2 holds that the import would collide with, or null. */
  const v2Holds = Effect.gen(function* () {
    const [row] = yield* sql<{ readonly reviews: number; readonly defects: number }>`
      SELECT (SELECT COUNT(*) FROM houston_harness_reviews) AS reviews,
        (SELECT COUNT(*) FROM houston_defects) AS defects
    `.pipe(Effect.orDie);
    if ((row?.reviews ?? 0) > 0) return `v2 already holds ${row!.reviews} harness review(s)`;
    if ((row?.defects ?? 0) > 0) return `v2 already holds ${row!.defects} suspected defect(s)`;
    return null;
  });

  const TASKS_FIRST =
    "the Tasks import has not run; import Houston 1's tasks first so fix-task links keep their tasks";

  /** The project each v1 workspace path names, among the projects that exist. */
  const projectMatcher = Effect.gen(function* () {
    const roots = (yield* projects.list().pipe(Effect.orDie)).filter(
      (project) => project.deletedAt === null,
    );
    const match = (workspace: SqlValue | undefined) =>
      typeof workspace !== "string"
        ? undefined
        : roots.find((project) => v1PathMatches(workspace, project.workspaceRoot, platform));
    return Object.assign(
      (workspace: SqlValue | undefined): ProjectId | null => match(workspace)?.projectId ?? null,
      { rootOf: (workspace: SqlValue | undefined) => match(workspace)?.workspaceRoot ?? null },
    );
  });

  const status: HoustonHarnessV1Import["Service"]["status"] = Effect.gen(function* () {
    const previous = yield* importRow;
    if (previous !== undefined) {
      return {
        state: "imported" as const,
        at: previous.imported_at,
        counts: decodeCounts(previous.counts_json),
      };
    }
    const found = yield* source;
    if (found === null) return { state: "unavailable" as const };
    const v1 = yield* fromCopy(found).pipe(Effect.orElseSucceed(() => null));
    if (v1 === null) return { state: "unavailable" as const };
    if (!(yield* tasksImported)) return { state: "blocked" as const, reason: TASKS_FIRST };
    const holds = yield* v2Holds;
    if (holds !== null) {
      return {
        state: "blocked" as const,
        reason: `${holds}; the import needs a store with no reviews and no defects`,
      };
    }
    const projectOf = yield* projectMatcher;
    return {
      state: "available" as const,
      source: found,
      reviews: v1.reviews.filter((row) => projectOf(row.workspace) !== null).length,
      defects: v1.defects.filter((row) => projectOf(row.workspace) !== null).length,
    };
  });

  const copy = Effect.fn("HoustonHarnessV1Import.copy")(function* (file: string, v1: V1Snapshot) {
    const projectOf = yield* projectMatcher;
    const notes: Array<string> = [];
    const unmatched = new Set<string>();
    const noteWorkspace = (workspace: SqlValue | undefined, what: string) => {
      const name = String(workspace);
      if (unmatched.has(name)) return;
      unmatched.add(name);
      notes.push(
        `${what} of the Houston 1 workspace ${name} were not imported: no project has that folder`,
      );
    };

    // Reviews, renumbered in their v1 order.
    const reviewIds = new Map<number, { readonly id: number; readonly projectId: ProjectId }>();
    for (const review of v1.reviews) {
      const projectId = projectOf(review.workspace);
      if (projectId === null) {
        noteWorkspace(review.workspace, "reviews, findings and defects");
        continue;
      }
      // A v1 review still running when the copy was taken never publishes here.
      const running = review.status !== "published" && review.status !== "failed";
      // v1 stored an absolute directory, or "" when it could not prepare one; the report reader
      // resolves a run directory under the project root.
      const v1Dir = typeof review.run_dir === "string" ? review.run_dir : "";
      const root = projectOf.rootOf(review.workspace);
      const runDir = root === null ? null : v1PathUnder(v1Dir, root, platform);
      if (runDir === null) {
        notes.push(
          v1Dir === ""
            ? `Houston 1 review ${String(review.id)} recorded no run directory, so its report cannot be opened`
            : `Houston 1 review ${String(review.id)}'s run directory ${v1Dir} is not inside its project, so it is kept as it was and its report cannot be opened`,
        );
      }
      const [inserted] = yield* sql<{ readonly id: number }>`
        INSERT INTO houston_harness_reviews (project_id, trigger, status, run_dir, started_at,
          ended_at, window_since, window_until, threads, prompts, cost_usd, finding_count,
          summary, error)
        VALUES (${projectId}, 'imported', ${running ? "failed" : review.status}, ${runDir ?? v1Dir},
          ${iso(review.started_at_ms)}, ${iso(review.ended_at_ms) ?? iso(review.started_at_ms)},
          ${review.window_since}, ${review.window_until}, ${review.sessions}, ${review.prompts},
          ${review.cost_usd},
          ${v1.findings.filter((finding) => finding.review_id === review.id).length},
          ${review.summary},
          ${running ? "imported from Houston 1 while it was still running" : review.error})
        RETURNING id
      `;
      reviewIds.set(Number(review.id), { id: inserted!.id, projectId });
    }

    let findings = 0;
    for (const finding of v1.findings) {
      const review = reviewIds.get(Number(finding.review_id));
      if (review === undefined) continue;
      findings += 1;
      yield* sql`
        INSERT INTO houston_harness_findings (review_id, key, title, category, confidence,
          sessions_json, count, quotes_json, recommendation_kind, target, recommendation,
          apply_prompt)
        VALUES (${review.id}, ${finding.key}, ${finding.title}, ${finding.category},
          ${finding.confidence}, ${finding.sessions}, ${finding.count}, ${finding.quotes},
          ${finding.recommendation_kind}, ${finding.target}, ${finding.recommendation},
          ${finding.apply_prompt})
      `;
    }

    let decisions = 0;
    for (const decision of v1.decisions) {
      const projectId = projectOf(decision.workspace);
      if (projectId === null) continue;
      if (decision.state !== "dismissed" && decision.state !== "resolved") continue;
      decisions += 1;
      yield* sql`
        INSERT INTO houston_harness_decisions (project_id, key, state, decided_at, decided_by)
        VALUES (${projectId}, ${decision.key}, ${decision.state}, ${iso(decision.decided_at_ms)},
          ${decision.decided_by ?? "user"})
      `;
    }

    // Task ids through the task number the Tasks import kept.
    const v1Numbers = new Map(v1.taskNumbers.map((row) => [Number(row.id), Number(row.number)]));
    const v2Ids = new Map(
      (yield* sql<{ readonly id: number; readonly number: number }>`
        SELECT id, number FROM houston_tasks`).map((row) => [row.number, row.id]),
    );
    const taskOf = (v1Id: SqlValue | undefined) => {
      const number = v1Numbers.get(Number(v1Id));
      return number === undefined ? undefined : v2Ids.get(number);
    };

    let links = 0;
    for (const link of v1.links) {
      const projectId = projectOf(link.workspace);
      const review = reviewIds.get(Number(link.review_id));
      if (projectId === null || review === undefined) continue;
      const taskId = taskOf(link.task_id);
      if (taskId === undefined) {
        notes.push(
          `the fix-task link of finding ${link.key} to Houston 1 task ${link.task_id} was not imported: that task is not in the backlog`,
        );
        continue;
      }
      links += 1;
      yield* sql`
        INSERT INTO houston_harness_finding_tasks (project_id, key, task_id, review_id, created_at)
        VALUES (${projectId}, ${link.key}, ${taskId}, ${review.id}, ${iso(link.created_at_ms)})
      `;
    }

    let verifications = 0;
    for (const verification of v1.verifications) {
      const review = reviewIds.get(Number(verification.review_id));
      if (review === undefined) continue;
      const taskId = taskOf(verification.task_id);
      if (taskId === undefined) {
        notes.push(
          `the ${verification.verdict} verdict of review ${verification.review_id} on finding ${verification.key} was not imported: Houston 1 task ${verification.task_id} is not in the backlog`,
        );
        continue;
      }
      verifications += 1;
      yield* sql`
        INSERT INTO houston_harness_verifications
          (review_id, key, task_id, verdict, sessions_after, evidence_json)
        VALUES (${review.id}, ${verification.key}, ${taskId}, ${verification.verdict},
          ${verification.sessions_after}, ${verification.evidence})
      `;
    }

    const now = DateTime.formatIso(yield* DateTime.now);
    for (const seen of v1.seen) {
      const workspace = String(seen.key).slice(SEEN_PREFIX.length);
      const projectId = projectOf(workspace);
      if (projectId === null) continue;
      // The newest renumbered review at or before the v1 cursor.
      let cursor = 0;
      for (const [v1Id, review] of reviewIds) {
        if (review.projectId === projectId && v1Id <= Number(seen.value)) {
          cursor = Math.max(cursor, review.id);
        }
      }
      if (cursor === 0) continue;
      yield* sql`
        INSERT INTO houston_harness_settings (project_id, seen_review_id, updated_at)
        VALUES (${projectId}, ${cursor}, ${now})
        ON CONFLICT (project_id) DO UPDATE SET seen_review_id = excluded.seen_review_id
      `;
    }

    let defects = 0;
    for (const defect of v1.defects) {
      const projectId = projectOf(defect.workspace);
      if (projectId === null) {
        noteWorkspace(defect.workspace, "reviews, findings and defects");
        continue;
      }
      defects += 1;
      yield* sql`
        INSERT INTO houston_defects (project_id, key, source, detector, title, description,
          evidence_json, destination, reporter_thread_id, first_seen_at, last_seen_at, count,
          issue_url)
        VALUES (${projectId}, ${defect.key}, ${defect.source === "detector" ? "detector" : "agent"},
          ${defect.detector}, ${defect.title}, ${defect.description ?? ""}, ${defect.evidence},
          ${defect.destination === "houston" ? "houston" : "project"}, NULL,
          ${iso(defect.first_seen_ms)}, ${iso(defect.last_seen_ms)}, ${defect.count},
          ${defect.issue_url})
      `;
    }

    const counts: HoustonHarnessImportCounts = {
      reviews: reviewIds.size,
      findings,
      decisions,
      links,
      verifications,
      defects,
    };
    yield* sql`
      INSERT INTO houston_harness_import (id, imported_at, counts_json)
      VALUES (1, ${now}, ${encodeCounts(counts)})
    `;
    return {
      result: { imported: counts, notes } satisfies HoustonHarnessImportResult,
      touched: [
        ...new Set([
          ...[...reviewIds.values()].map((review) => review.projectId),
          ...v1.defects.flatMap((defect) => projectOf(defect.workspace) ?? []),
        ]),
      ],
      file,
    };
  });

  const run: HoustonHarnessV1Import["Service"]["run"] = Effect.gen(function* () {
    const previous = yield* importRow;
    if (previous !== undefined) {
      return yield* refuse(
        "conflict",
        `Houston 1 harness reviews were already imported at ${previous.imported_at}`,
      );
    }
    const found = yield* source;
    if (found === null) {
      return yield* refuse(
        "not_found",
        hosted
          ? `no Houston 1 database at ${sourcePath}`
          : `the server is not hosted, so no Houston 1 database (${V1_DATABASE}) sits beside its base dir ${config.baseDir}`,
      );
    }
    if (!(yield* tasksImported)) return yield* refuse("invalid", TASKS_FIRST);
    const holds = yield* v2Holds;
    if (holds !== null) {
      return yield* refuse(
        "conflict",
        `${holds}; the import needs a store with no reviews and no defects`,
      );
    }
    const v1 = yield* fromCopy(found).pipe(
      Effect.mapError((error) =>
        refuse("not_found", `could not read the Houston 1 database at ${found}: ${error.message}`),
      ),
    );
    const copied = yield* sql.withTransaction(copy(found, v1)).pipe(
      Effect.catchTags({
        SqlError: (error) =>
          Effect.fail(
            refuse(
              "invalid",
              `the Houston 1 harness rows at ${found} could not be copied: ${error.message}`,
            ),
          ),
      }),
    );
    // Subscribers see the imported reviews and defects once they are committed.
    for (const projectId of copied.touched) yield* PubSub.publish(store.changes, projectId);
    return copied.result;
  });

  return HoustonHarnessV1Import.of({ status, run });
});

export const layer = Layer.effect(HoustonHarnessV1Import, make);
