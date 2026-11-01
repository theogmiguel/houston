// @effect-diagnostics nodeBuiltinImport:off globalDate:off - builds v1 files and hashes them byte for byte.
// The one-time import of Houston 1's harness reviews and suspected defects, from v1 databases
// built in temporary channel directories; v1's real state is never read.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as HoustonTaskV1Import from "../tasks/V1Import.ts";
import { createProject, layerTasks } from "../tasks/tasks.testkit.ts";
import { type V1Fixture, writeV1Database } from "../tasks/v1Fixture.ts";
import { reviewWindow } from "./rules.ts";
import { HoustonHarnessStore, layer as HoustonHarnessStoreLayer } from "./Store.ts";
import * as HoustonHarnessV1Import from "./V1Import.ts";
import { type V1HarnessFixture, writeV1Harness } from "./v1Fixture.ts";

const TIMEOUT = 120_000;
const T0 = Date.UTC(2026, 8, 1);
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const iso = (ms: number) => new Date(ms).toISOString();
const WINDOWS = HostProcess.Platform.defaultValue() === "win32";
const ROOT = WINDOWS ? "C:\\work\\shop" : "/work/shop";
// The path v1 recorded: on Windows another case and a trailing separator, as a user typed it.
const V1_ROOT = WINDOWS ? "c:\\Work\\Shop\\" : "/work/shop";
const OTHER = WINDOWS ? "C:\\work\\gone" : "/work/gone";
// v1's run directories are absolute: `<pane folder>/.houston/harness/r<run>`, joined by the OS.
const R5 = NodePath.join(V1_ROOT, ".houston", "harness", "r5");
// A review pane that ran in a folder beside the project, not inside it.
const R9 = NodePath.join(`${ROOT}-review`, ".houston", "harness", "r9");

const importer = HoustonHarnessV1Import.HoustonHarnessV1Import;

interface Dirs {
  readonly baseDir: string;
  readonly source: string;
}

const layerFor = (baseDir: string) =>
  HoustonHarnessV1Import.layer.pipe(
    Layer.provideMerge(HoustonHarnessStoreLayer),
    Layer.provideMerge(layerTasks({ baseDir })),
  );

/** A channel directory with a hosted `v2` base dir and the import's layer over it. */
const withChannel = <A, E, R>(body: (dirs: Dirs) => Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const channel = yield* fs.makeTempDirectoryScoped({ prefix: "houston-harness-v1-" });
    const baseDir = NodePath.join(channel, "v2");
    NodeFS.mkdirSync(baseDir);
    const dirs = { baseDir, source: NodePath.join(channel, "houston.db") };
    return yield* body(dirs).pipe(Effect.provide(layerFor(baseDir)));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

const failureOf = <A, E>(exit: Exit.Exit<A, E>) => {
  assert.isTrue(Exit.isFailure(exit), "expected a refusal");
  return Cause.squash((exit as Exit.Failure<A, E>).cause) as {
    readonly kind?: string;
    readonly message?: string;
  };
};

const TASKS: V1Fixture = {
  nextNumber: 4,
  tasks: [
    {
      id: 7,
      workspace: V1_ROOT,
      number: 3,
      title: "Allow git push",
      status: "done",
      createdAtMs: T0,
    },
  ],
};

const HARNESS: V1HarnessFixture = {
  reviews: [
    {
      id: 5,
      workspace: V1_ROOT,
      status: "published",
      runDir: R5,
      startedAtMs: T0,
      endedAtMs: T0 + HOUR,
      windowSince: "2026-08-18T00:00:00Z",
      windowUntil: "2026-09-01T00:00:00Z",
      sessions: 4,
      prompts: 9,
      costUsd: 0.25,
      summary: "1 finding",
    },
    {
      id: 6,
      workspace: OTHER,
      status: "published",
      runDir: NodePath.join(OTHER, ".houston", "harness", "r6"),
      startedAtMs: T0,
      endedAtMs: T0 + HOUR,
    },
    {
      id: 8,
      workspace: V1_ROOT,
      status: "failed",
      // v1 stored "" when it could not prepare the run directory.
      runDir: "",
      startedAtMs: T0 + 3 * DAY,
      endedAtMs: T0 + 3 * DAY + HOUR,
      error: "the run ended without publishing",
    },
    {
      id: 9,
      workspace: V1_ROOT,
      status: "published",
      runDir: R9,
      startedAtMs: T0 + 7 * DAY,
      endedAtMs: T0 + 7 * DAY + HOUR,
      windowSince: "2026-09-01T00:00:00Z",
      windowUntil: "2026-09-08T00:00:00Z",
      summary: "2 findings",
    },
  ],
  findings: [
    { reviewId: 5, key: "denied-push", title: "Denied git push" },
    { reviewId: 6, key: "other-key", title: "Elsewhere" },
    { reviewId: 9, key: "denied-push", title: "Denied git push" },
    { reviewId: 9, key: "slow-skill", title: "A slow skill" },
  ],
  decisions: [
    { workspace: V1_ROOT, key: "slow-skill", state: "dismissed", decidedAtMs: T0 + 8 * DAY },
    { workspace: OTHER, key: "other-key", state: "resolved", decidedAtMs: T0 + 2 * DAY },
    {
      workspace: V1_ROOT,
      key: "defect-reply_reasked-22222222",
      state: "dismissed",
      decidedAtMs: T0 + 9 * DAY,
      decidedBy: "not_a_bug",
    },
  ],
  links: [
    { workspace: V1_ROOT, key: "denied-push", taskId: 7, reviewId: 5, createdAtMs: T0 + 2 * HOUR },
    { workspace: V1_ROOT, key: "slow-skill", taskId: 99, reviewId: 9, createdAtMs: T0 + 8 * DAY },
  ],
  verifications: [
    {
      reviewId: 9,
      key: "denied-push",
      taskId: 7,
      verdict: "gone",
      sessionsAfter: 3,
      evidence: ["no denial since"],
    },
  ],
  defects: [
    {
      workspace: V1_ROOT,
      key: "defect-agent-11111111",
      source: "agent",
      title: "worker re-asked the same question",
      evidence: ["message 7"],
      destination: "houston",
      firstSeenMs: T0,
      lastSeenMs: T0 + DAY,
      count: 2,
    },
    {
      workspace: V1_ROOT,
      key: "defect-reply_reasked-22222222",
      source: "detector",
      detector: "reply_reasked",
      title: "a reply was asked again",
      evidence: [],
      destination: "workspace",
      firstSeenMs: T0 + DAY,
      lastSeenMs: T0 + DAY,
      count: 1,
      issueUrl: null,
    },
    {
      workspace: OTHER,
      key: "defect-agent-33333333",
      source: "agent",
      title: "elsewhere",
      evidence: [],
      destination: "houston",
      firstSeenMs: T0,
      lastSeenMs: T0,
      count: 1,
    },
  ],
  seen: { [V1_ROOT]: 9 },
};

const writeV1 = (source: string, options: { readonly wal?: boolean } = {}) => {
  writeV1Database(source, TASKS, options);
  writeV1Harness(source, HARNESS);
};

const importTasks = Effect.flatMap(HoustonTaskV1Import.HoustonTaskV1Import, (tasks) => tasks.run);

/** Rows of every harness table and the defects table. */
const harnessRows = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const out: Record<string, unknown> = {};
  for (const table of [
    "houston_harness_settings",
    "houston_harness_reviews",
    "houston_harness_findings",
    "houston_harness_decisions",
    "houston_harness_finding_tasks",
    "houston_harness_verifications",
    "houston_defects",
    "houston_harness_import",
  ]) {
    out[table] = yield* sql`SELECT * FROM ${sql(table)} ORDER BY rowid`;
  }
  return out;
});

const hashes = (source: string) =>
  Object.fromEntries(
    ["", "-wal", "-shm"].map((suffix) => {
      const file = `${source}${suffix}`;
      return [
        suffix || "db",
        NodeFS.existsSync(file)
          ? NodeCrypto.createHash("sha256").update(NodeFS.readFileSync(file)).digest("hex")
          : "absent",
      ];
    }),
  );

describe("the import status", () => {
  it.effect(
    "the import status names why it can or cannot run",
    () =>
      Effect.gen(function* () {
        // No v1 database.
        yield* withChannel(() =>
          Effect.gen(function* () {
            assert.deepEqual(yield* (yield* importer).status, { state: "unavailable" });
          }),
        );

        // Before the Tasks import, then available, then imported.
        yield* withChannel((dirs) =>
          Effect.gen(function* () {
            writeV1(dirs.source);
            yield* createProject("shop", ROOT);
            const imports = yield* importer;
            const before = yield* imports.status;
            assert.strictEqual(before.state, "blocked");
            if (before.state === "blocked") assert.include(before.reason, "Tasks import");

            yield* importTasks;
            assert.deepEqual(yield* imports.status, {
              state: "available",
              source: dirs.source,
              reviews: 3,
              defects: 2,
            });

            const result = yield* imports.run;
            const after = yield* imports.status;
            assert.strictEqual(after.state, "imported");
            if (after.state === "imported") {
              assert.deepEqual(after.counts, result.imported);
              assert.isTrue(after.at.length > 0);
            }
          }),
        );

        // A v2 review blocks it.
        yield* withChannel((dirs) =>
          Effect.gen(function* () {
            writeV1(dirs.source);
            const projectId = yield* createProject("shop", ROOT);
            yield* importTasks;
            const store = yield* HoustonHarnessStore;
            yield* store.openReview({
              projectId,
              trigger: "manual",
              scheduledTaskId: null,
              providerInstanceId: "claudeAgent",
              startedAt: iso(T0),
            });
            const status = yield* (yield* importer).status;
            assert.strictEqual(status.state, "blocked");
            if (status.state === "blocked") assert.include(status.reason, "review");
          }),
        );
      }),
    TIMEOUT,
  );
});

describe("the import", () => {
  it.effect(
    "the import carries reviews decisions links and defects",
    () =>
      withChannel((dirs) =>
        Effect.gen(function* () {
          writeV1(dirs.source, { wal: true });
          const projectId = yield* createProject("shop", ROOT);
          yield* importTasks;
          // A v1 daemon still running: an open connection with an uncheckpointed write.
          const daemon = new NodeSqlite.DatabaseSync(dirs.source);
          try {
            daemon.exec("PRAGMA wal_autocheckpoint = 0");
            daemon
              .prepare("INSERT INTO settings (key, value) VALUES ('unrelated', 'in the wal')")
              .run();
            const before = hashes(dirs.source);
            assert.notStrictEqual(before["-wal"], "absent");

            const result = yield* (yield* importer).run;
            assert.deepEqual(result.imported, {
              reviews: 3,
              findings: 3,
              decisions: 2,
              links: 1,
              verifications: 1,
              defects: 2,
            });
            assert.lengthOf(result.notes, 4);
            assert.isTrue(
              result.notes.some((note) => note.includes("review 8") && note.includes("no run")),
              "a review v1 recorded without a run directory is one note",
            );
            assert.isTrue(
              result.notes.some((note) => note.includes(R9) && note.includes("not inside")),
              "a run directory outside the project is kept and noted",
            );
            assert.isTrue(
              result.notes.some((note) => note.includes(OTHER)),
              "a workspace with no project is one note",
            );
            assert.isTrue(
              result.notes.some((note) => note.includes("99") && note.includes("slow-skill")),
              "a link to a task not imported is one note",
            );
            assert.deepEqual(hashes(dirs.source), before, "v1's files are unchanged");
          } finally {
            daemon.close();
          }

          const sql = yield* SqlClient.SqlClient;
          const reviews = yield* sql<{
            id: number;
            project_id: string;
            trigger: string;
            status: string;
            run_dir: string;
            window_since: string | null;
            window_until: string | null;
            started_at: string;
            ended_at: string | null;
            error: string | null;
          }>`SELECT * FROM houston_harness_reviews ORDER BY id`;
          assert.deepEqual(
            reviews.map((row) => [row.id, row.project_id, row.trigger, row.status, row.run_dir]),
            [
              [1, projectId, "imported", "published", ".houston/harness/r5"],
              [2, projectId, "imported", "failed", ""],
              [3, projectId, "imported", "published", R9],
            ],
          );
          // The report reader joins the run directory under the project root: v1's folder.
          assert.strictEqual(
            NodePath.join(ROOT, ...reviews[0]!.run_dir.split("/")).toLowerCase(),
            R5.toLowerCase(),
          );
          assert.strictEqual(reviews[0]?.window_since, "2026-08-18T00:00:00Z");
          assert.strictEqual(reviews[0]?.window_until, "2026-09-01T00:00:00Z");
          assert.strictEqual(reviews[0]?.started_at, iso(T0));
          assert.strictEqual(reviews[0]?.ended_at, iso(T0 + HOUR));
          assert.strictEqual(reviews[1]?.error, "the run ended without publishing");

          assert.deepEqual(
            yield* sql`SELECT review_id, key FROM houston_harness_findings ORDER BY review_id, key`,
            [
              { review_id: 1, key: "denied-push" },
              { review_id: 3, key: "denied-push" },
              { review_id: 3, key: "slow-skill" },
            ],
          );
          assert.deepEqual(
            yield* sql`SELECT key, state, decided_at, decided_by FROM houston_harness_decisions
              WHERE project_id = ${projectId} ORDER BY key`,
            [
              {
                key: "defect-reply_reasked-22222222",
                state: "dismissed",
                decided_at: iso(T0 + 9 * DAY),
                decided_by: "not_a_bug",
              },
              {
                key: "slow-skill",
                state: "dismissed",
                decided_at: iso(T0 + 8 * DAY),
                decided_by: "user",
              },
            ],
          );
          const [task] = yield* sql<{ id: number }>`SELECT id FROM houston_tasks WHERE number = 3`;
          assert.deepEqual(
            yield* sql`SELECT project_id, key, task_id, review_id, created_at
              FROM houston_harness_finding_tasks`,
            [
              {
                project_id: projectId,
                key: "denied-push",
                task_id: task!.id,
                review_id: 1,
                created_at: iso(T0 + 2 * HOUR),
              },
            ],
          );
          assert.deepEqual(
            yield* sql`SELECT review_id, key, task_id, verdict, sessions_after, evidence_json
              FROM houston_harness_verifications`,
            [
              {
                review_id: 3,
                key: "denied-push",
                task_id: task!.id,
                verdict: "gone",
                sessions_after: 3,
                evidence_json: '["no denial since"]',
              },
            ],
          );
          assert.deepEqual(
            yield* sql`SELECT seen_review_id FROM houston_harness_settings
              WHERE project_id = ${projectId}`,
            [{ seen_review_id: 3 }],
          );
          const defects = yield* sql<{
            key: string;
            source: string;
            detector: string | null;
            destination: string;
            first_seen_at: string;
            count: number;
          }>`SELECT * FROM houston_defects ORDER BY key`;
          assert.deepEqual(
            defects.map((row) => [row.key, row.source, row.detector, row.destination, row.count]),
            [
              ["defect-agent-11111111", "agent", null, "houston", 2],
              ["defect-reply_reasked-22222222", "detector", "reply_reasked", "project", 1],
            ],
          );
          assert.strictEqual(defects[0]?.first_seen_at, iso(T0));

          // The next review's window starts at the newest imported published review's end.
          const store = yield* HoustonHarnessStore;
          const window = reviewWindow(
            Date.parse("2026-09-20T00:00:00Z"),
            yield* store.windows(projectId),
          );
          assert.strictEqual(window.previousEnd, "2026-09-08T00:00:00Z");
          assert.strictEqual(iso(window.sinceMs), "2026-09-08T00:00:00.000Z");
        }),
      ),
    TIMEOUT,
  );

  it.effect(
    "the import refuses by name and changes nothing",
    () =>
      Effect.gen(function* () {
        // Without a v1 database: not_found.
        yield* withChannel(() =>
          Effect.gen(function* () {
            const before = yield* harnessRows;
            const refused = failureOf(yield* Effect.exit((yield* importer).run));
            assert.strictEqual(refused.kind, "not_found");
            assert.include(refused.message ?? "", "houston.db");
            assert.deepEqual(yield* harnessRows, before);
          }),
        );

        // Before the Tasks import: invalid.
        yield* withChannel((dirs) =>
          Effect.gen(function* () {
            writeV1(dirs.source);
            yield* createProject("shop", ROOT);
            const before = yield* harnessRows;
            const refused = failureOf(yield* Effect.exit((yield* importer).run));
            assert.strictEqual(refused.kind, "invalid");
            assert.include(refused.message ?? "", "Tasks import");
            assert.deepEqual(yield* harnessRows, before);
          }),
        );

        // A second import, then one over a v2 defect: conflict.
        yield* withChannel((dirs) =>
          Effect.gen(function* () {
            writeV1(dirs.source);
            yield* createProject("shop", ROOT);
            yield* importTasks;
            const imports = yield* importer;
            yield* imports.run;
            const imported = yield* harnessRows;
            const again = failureOf(yield* Effect.exit(imports.run));
            assert.strictEqual(again.kind, "conflict");
            assert.include(again.message ?? "", "already imported");
            assert.deepEqual(yield* harnessRows, imported);
          }),
        );
        yield* withChannel((dirs) =>
          Effect.gen(function* () {
            writeV1(dirs.source);
            const projectId = yield* createProject("shop", ROOT);
            yield* importTasks;
            const sql = yield* SqlClient.SqlClient;
            yield* sql`INSERT INTO houston_defects (project_id, key, source, title, evidence_json,
              destination, first_seen_at, last_seen_at, count)
              VALUES (${projectId}, 'defect-agent-abcdef12', 'agent', 'made in v2', '[]',
                'houston', ${iso(T0)}, ${iso(T0)}, 1)`;
            const before = yield* harnessRows;
            const refused = failureOf(yield* Effect.exit((yield* importer).run));
            assert.strictEqual(refused.kind, "conflict");
            assert.include(refused.message ?? "", "defect");
            assert.deepEqual(yield* harnessRows, before);
          }),
        );
      }),
    TIMEOUT,
  );
});
