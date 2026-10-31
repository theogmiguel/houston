// The Houston migration track beside upstream's, through persistence/Sqlite.ts.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";
import * as Migrator from "effect/sql/Migrator";

import { migrationManifest, runMigrations } from "../persistence/Migrations.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { runHoustonMigrations } from "./migrations.ts";

const UPSTREAM_HEAD = Math.max(...migrationManifest.map(([id]) => id));
const HOUSTON_TRACK: Array<readonly [number, string]> = [
  [1, "ReviewFilesViewed"],
  [2, "TasksBacklog"],
  [3, "TaskSources"],
  [4, "TaskRunsCursor"],
  [5, "MergeQueue"],
  [6, "TaskSourceMarkerKey"],
  [7, "HarnessReview"],
];
const TASK_TABLES = [
  "houston_task_acceptance",
  "houston_task_blocks",
  "houston_task_comments",
  "houston_task_counter",
  "houston_task_domain",
  "houston_task_history",
  "houston_task_import",
  "houston_task_initiatives",
  "houston_task_planning",
  "houston_task_runs",
  "houston_task_runs_cursor",
  "houston_task_settings",
  "houston_tasks",
];

const upstreamHistory = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql<{ readonly migration_id: number; readonly name: string }>`
    SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id
  `;
});

const houstonHistory = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return (yield* sql<{ readonly migration_id: number; readonly name: string }>`
    SELECT migration_id, name FROM houston_sql_migrations ORDER BY migration_id
  `).map((row) => [row.migration_id, row.name] as const);
});

const primaryKey = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string; readonly pk: number }>`
    SELECT name, pk FROM pragma_table_info('houston_review_files_viewed')
  `;
  return columns
    .filter((column) => column.pk > 0)
    .toSorted((left, right) => left.pk - right.pk)
    .map((column) => column.name);
});

const withDatabaseFile = <A, E, R>(body: (file: string) => Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "houston-migrations-" });
    return yield* body(path.join(dir, "state.sqlite"));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

const openThroughSqlite = (file: string) =>
  Layer.fresh(SqlitePersistence.layerFromPath(file)).pipe(Layer.provide(NodeServices.layer));

describe("the Houston track runs beside upstream's", () => {
  it.effect("a fresh database records the Houston migrations and upstream stays at its head", () =>
    withDatabaseFile((file) =>
      Effect.gen(function* () {
        const first = yield* Effect.gen(function* () {
          assert.deepEqual(yield* houstonHistory, HOUSTON_TRACK);
          assert.deepEqual(yield* primaryKey, ["worktree_root", "ref_name", "path"]);
          const upstream = yield* upstreamHistory;
          assert.equal(Math.max(...upstream.map((row) => row.migration_id)), UPSTREAM_HEAD);
          return upstream;
        }).pipe(Effect.provide(openThroughSqlite(file)));

        // A reopen applies nothing on either track.
        yield* Effect.gen(function* () {
          assert.deepEqual(yield* runHoustonMigrations(), []);
          assert.deepEqual(yield* houstonHistory, HOUSTON_TRACK);
          assert.deepEqual(yield* upstreamHistory, first);
        }).pipe(Effect.provide(openThroughSqlite(file)));
      }),
    ),
  );

  it.effect("the in-memory layer runs the Houston track too", () =>
    Effect.gen(function* () {
      assert.deepEqual(yield* houstonHistory, HOUSTON_TRACK);
      assert.deepEqual(yield* primaryKey, ["worktree_root", "ref_name", "path"]);
    }).pipe(Effect.provide(Layer.fresh(SqlitePersistence.layerMemory))),
  );

  it.effect("upstream's migrator still applies its next id after the Houston track", () =>
    withDatabaseFile((file) =>
      Effect.gen(function* () {
        yield* Effect.gen(function* () {
          assert.deepEqual(yield* houstonHistory, HOUSTON_TRACK);
        }).pipe(Effect.provide(openThroughSqlite(file)));

        yield* Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          // Upstream's own migrator again, then as a later build with one more migration.
          assert.deepEqual(yield* runMigrations(), []);
          const nextId = UPSTREAM_HEAD + 1;
          const applied = yield* Migrator.make({})({
            loader: Migrator.fromRecord({
              [`${nextId}_FutureUpstreamMigration`]: sql`CREATE TABLE future_upstream (id INTEGER)`,
            }),
          });
          assert.deepEqual(applied, [[nextId, "FutureUpstreamMigration"]]);
          assert.deepEqual(yield* houstonHistory, HOUSTON_TRACK);
        }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: file })));
      }),
    ),
  );
});

describe("the tasks migration runs on the Houston track", () => {
  const taskTables = Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return (yield* sql<{ readonly name: string }>`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND (name = 'houston_tasks' OR name LIKE 'houston_task_%')
        AND name NOT LIKE 'houston_task_source_%'
      ORDER BY name
    `).map((row) => row.name);
  });

  it.effect("every houston_task table exists, numbers are unique and the counter is one row", () =>
    withDatabaseFile((file) =>
      Effect.gen(function* () {
        const upstream = yield* Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          assert.deepEqual(yield* houstonHistory, HOUSTON_TRACK);
          assert.deepEqual(yield* taskTables, TASK_TABLES);
          assert.deepEqual(yield* sql`SELECT id, next_number FROM houston_task_counter`, [
            { id: 1, next_number: 1 },
          ]);
          // The counter holds exactly one row.
          const second = yield* Effect.exit(
            sql`INSERT INTO houston_task_counter (id, next_number) VALUES (2, 1)`,
          );
          assert.isTrue(second._tag === "Failure");
          yield* sql`
            INSERT INTO houston_tasks (number, title, status, created_by, created_at, updated_at)
            VALUES (1, 'a', 'backlog', 'user', 'now', 'now')
          `;
          const duplicate = yield* Effect.exit(sql`
            INSERT INTO houston_tasks (number, title, status, created_by, created_at, updated_at)
            VALUES (1, 'b', 'backlog', 'user', 'now', 'now')
          `);
          assert.isTrue(duplicate._tag === "Failure");
          assert.isFalse(
            (yield* upstreamHistory).some(
              (row) =>
                row.name.toLowerCase().includes("task") &&
                row.name.toLowerCase().includes("backlog"),
            ),
          );
          return yield* upstreamHistory;
        }).pipe(Effect.provide(openThroughSqlite(file)));

        // A reopen applies nothing and keeps upstream's history as it was.
        yield* Effect.gen(function* () {
          assert.deepEqual(yield* runHoustonMigrations(), []);
          assert.deepEqual(yield* houstonHistory, HOUSTON_TRACK);
          assert.deepEqual(yield* upstreamHistory, upstream);
          assert.strictEqual(Math.max(...upstream.map((row) => row.migration_id)), UPSTREAM_HEAD);
        }).pipe(Effect.provide(openThroughSqlite(file)));
      }),
    ),
  );
});

describe("the task sources migration runs on the Houston track", () => {
  const SOURCE_TABLES = [
    "houston_task_source_credentials",
    "houston_task_source_identity",
    "houston_task_source_import",
    "houston_task_source_links",
    "houston_task_source_outbox",
    "houston_task_source_poll",
    "houston_task_source_settings",
  ];

  it.effect("the task sources migration runs on the Houston track", () =>
    withDatabaseFile((file) =>
      Effect.gen(function* () {
        const upstream = yield* Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const history = yield* houstonHistory;
          assert.deepEqual(history.slice(1, 3), [
            [2, "TasksBacklog"],
            [3, "TaskSources"],
          ]);
          const tables = (yield* sql<{ readonly name: string }>`
            SELECT name FROM sqlite_master
            WHERE type = 'table' AND name LIKE 'houston_task_source_%' ORDER BY name
          `).map((row) => row.name);
          assert.deepEqual(tables, SOURCE_TABLES);
          // One source link per project, provider and item; pull request links may repeat it.
          const link = (taskId: number, source: string) => sql`
            INSERT INTO houston_task_source_links (
              task_id, project_id, provider, external_id, source, url, snapshot_json,
              sync_state_json
            ) VALUES (${taskId}, 'p', 'github_issues', 'o/r#1', ${source}, 'u', '{}', '{}')
          `;
          yield* link(1, "source");
          yield* link(1, "pull_request");
          assert.isTrue((yield* Effect.exit(link(2, "source")))._tag === "Failure");
          const refused = yield* Effect.exit(sql`
            INSERT INTO houston_task_source_settings (
              project_id, provider, enabled, settings_json, updated_at
            ) VALUES ('p', 'slack', 0, '{}', 'now')
          `);
          assert.isTrue(refused._tag === "Failure");
          for (const table of SOURCE_TABLES) {
            const columns = yield* sql<{ readonly name: string }>`
              SELECT name FROM pragma_table_info(${table})
            `;
            assert.isNotEmpty(columns, table);
            for (const column of columns) {
              assert.notMatch(column.name, /token|secret/i, `${table}.${column.name}`);
            }
          }
          assert.isFalse(
            (yield* upstreamHistory).some((row) => row.name.toLowerCase().includes("tasksource")),
          );
          return yield* upstreamHistory;
        }).pipe(Effect.provide(openThroughSqlite(file)));

        yield* Effect.gen(function* () {
          assert.deepEqual(yield* runHoustonMigrations(), []);
          assert.deepEqual(yield* upstreamHistory, upstream);
        }).pipe(Effect.provide(openThroughSqlite(file)));
      }),
    ),
  );
});

describe("the merge queue migration runs on the Houston track", () => {
  const QUEUE_TABLES = [
    "houston_merge_queue_entries",
    "houston_merge_queue_global",
    "houston_merge_queue_log",
    "houston_merge_queue_settings",
  ];

  it.effect("the merge queue migration runs on the Houston track", () =>
    withDatabaseFile((file) =>
      Effect.gen(function* () {
        const upstream = yield* Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const history = yield* houstonHistory;
          assert.deepEqual(history[4], [5, "MergeQueue"]);
          assert.deepEqual(
            history.map(([id]) => id),
            HOUSTON_TRACK.map(([id]) => id),
          );
          const tables = (yield* sql<{ readonly name: string }>`
            SELECT name FROM sqlite_master
            WHERE type = 'table' AND name LIKE 'houston_merge_queue_%' ORDER BY name
          `).map((row) => row.name);
          assert.deepEqual(tables, QUEUE_TABLES);
          const entry = (number: number) => sql`
            INSERT INTO houston_merge_queue_entries (
              project_id, number, repository, url, head_ref, head_sha, position, enqueued_at
            ) VALUES ('p', ${number}, 'o/r', 'u', 'houston/x', 'abc', 1, 'now')
          `;
          yield* entry(7);
          assert.isTrue((yield* Effect.exit(entry(7)))._tag === "Failure");
          yield* sql`
            INSERT INTO houston_merge_queue_entries (
              project_id, number, repository, url, head_ref, head_sha, position, enqueued_at
            ) VALUES ('q', 7, 'o/r', 'u', 'houston/x', 'abc', 1, 'now')
          `;
          const log = (kind: string) => sql`
            INSERT INTO houston_merge_queue_log (project_id, kind, number, repository, url, at)
            VALUES ('p', ${kind}, 7, 'o/r', 'u', 'now')
          `;
          for (const kind of ["push", "merge", "park", "restack", "retarget", "hand_off"]) {
            yield* log(kind);
          }
          for (const kind of ["delete", "Push", "verify"]) {
            assert.isTrue((yield* Effect.exit(log(kind)))._tag === "Failure", kind);
          }
          yield* sql`INSERT INTO houston_merge_queue_global (id, paused) VALUES (1, 0)`;
          assert.isTrue(
            (yield* Effect.exit(
              sql`INSERT INTO houston_merge_queue_global (id, paused) VALUES (2, 0)`,
            ))._tag === "Failure",
          );
          const settings = yield* sql<Record<string, unknown>>`
            INSERT INTO houston_merge_queue_settings (project_id) VALUES ('p') RETURNING *
          `;
          assert.deepEqual(settings[0], {
            project_id: "p",
            merge_when_verified: 0,
            verification_command: "",
            time_limit_minutes: 30,
            paused: 0,
            acknowledged_at: null,
            hand_off_json: null,
            revision: 0,
          });
          const index = yield* sql<{ readonly name: string }>`
            SELECT name FROM pragma_index_list('houston_merge_queue_log')
          `;
          assert.isNotEmpty(index);
          assert.isFalse(
            (yield* upstreamHistory).some((row) => row.name.toLowerCase().includes("mergequeue")),
          );
          return yield* upstreamHistory;
        }).pipe(Effect.provide(openThroughSqlite(file)));

        // A reopen applies nothing on either track.
        yield* Effect.gen(function* () {
          assert.deepEqual(yield* runHoustonMigrations(), []);
          assert.deepEqual(yield* upstreamHistory, upstream);
          assert.deepEqual(yield* houstonHistory, HOUSTON_TRACK);
        }).pipe(Effect.provide(openThroughSqlite(file)));
      }),
    ),
  );
});

describe("an upstream database gains the Houston track", () => {
  it.effect("migrated by upstream through its head, then opened through Sqlite.ts", () =>
    withDatabaseFile((file) =>
      Effect.gen(function* () {
        const before = yield* Effect.gen(function* () {
          yield* runMigrations();
          const sql = yield* SqlClient.SqlClient;
          const tables = yield* sql`
            SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'houston_%'
          `;
          assert.deepEqual(tables, []);
          return yield* upstreamHistory;
        }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: file })));
        assert.equal(Math.max(...before.map((row) => row.migration_id)), UPSTREAM_HEAD);

        yield* Effect.gen(function* () {
          assert.deepEqual(yield* houstonHistory, HOUSTON_TRACK);
          assert.deepEqual(yield* primaryKey, ["worktree_root", "ref_name", "path"]);
          assert.deepEqual(yield* upstreamHistory, before);
        }).pipe(Effect.provide(openThroughSqlite(file)));
      }),
    ),
  );
});

describe("the harness review migration runs on the Houston track", () => {
  const HARNESS_TABLES = [
    "houston_defects",
    "houston_harness_decisions",
    "houston_harness_finding_tasks",
    "houston_harness_findings",
    "houston_harness_import",
    "houston_harness_reviews",
    "houston_harness_settings",
    "houston_harness_verifications",
  ];

  const harnessTables = Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return (yield* sql<{ readonly name: string }>`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND (name LIKE 'houston_harness_%' OR name = 'houston_defects')
      ORDER BY name
    `).map((row) => row.name);
  });

  const review = (projectId: string, status: string, trigger = "manual") =>
    Effect.flatMap(
      SqlClient.SqlClient,
      (sql) =>
        sql`INSERT INTO houston_harness_reviews (project_id, trigger, status, run_dir, started_at)
        VALUES (${projectId}, ${trigger}, ${status}, '.houston/harness/review-x', '2026-10-30T09:00:00.000Z')`,
    );

  it.effect("the harness review migration runs on the Houston track", () =>
    withDatabaseFile((file) =>
      Effect.gen(function* () {
        const upstream = yield* Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const history = yield* houstonHistory;
          assert.deepEqual(history.at(-1), [7, "HarnessReview"]);
          assert.isTrue(history.slice(0, -1).every(([id]) => id < 7));
          assert.deepEqual(yield* harnessTables, HARNESS_TABLES);

          // One preparing or running review per project; one per project in two projects is fine.
          yield* review("project-p", "running");
          assert.isTrue(Exit.isFailure(yield* Effect.exit(review("project-p", "preparing"))));
          assert.isTrue(Exit.isFailure(yield* Effect.exit(review("project-p", "running"))));
          yield* review("project-q", "preparing");
          yield* review("project-p", "published");
          yield* review("project-p", "failed");

          // Every enumerated column refuses a value outside its CHECK.
          const refused = [
            review("project-r", "paused"),
            review("project-r", "published", "routine"),
            sql`INSERT INTO houston_harness_decisions (project_id, key, state, decided_at, decided_by)
              VALUES ('project-p', 'k', 'ignored', 'now', 'user')`,
            sql`INSERT INTO houston_harness_verifications (review_id, key, task_id, verdict, sessions_after, evidence_json)
              VALUES (1, 'k', 1, 'stillPresent', 3, '[]')`,
            sql`INSERT INTO houston_defects (project_id, key, source, title, evidence_json, destination, first_seen_at, last_seen_at, count)
              VALUES ('project-p', 'd', 'user', 't', '[]', 'houston', 'now', 'now', 1)`,
            sql`INSERT INTO houston_defects (project_id, key, source, title, evidence_json, destination, first_seen_at, last_seen_at, count)
              VALUES ('project-p', 'd', 'agent', 't', '[]', 'workspace', 'now', 'now', 1)`,
          ];
          for (const insert of refused) {
            assert.isTrue(Exit.isFailure(yield* Effect.exit(insert)));
          }
          yield* sql`INSERT INTO houston_harness_decisions (project_id, key, state, decided_at, decided_by)
            VALUES ('project-p', 'k', 'dismissed', '2026-10-30T09:00:00.000Z', 'user')`;
          yield* sql`INSERT INTO houston_harness_findings (review_id, key, title, category, confidence, sessions_json, count, quotes_json, recommendation_kind, target, recommendation, apply_prompt)
            VALUES (1, 'k', 'Title', 'tools', 'high', '[]', 1, '[]', 'claude-md', 'CLAUDE.md', 'r', 'p')`;
          yield* sql`INSERT INTO houston_defects (project_id, key, source, title, evidence_json, destination, first_seen_at, last_seen_at, count)
            VALUES ('project-p', 'd', 'agent', 't', '[]', 'project', 'now', 'now', 1)`;
          assert.isFalse(
            (yield* upstreamHistory).some((row) => row.name.toLowerCase().includes("harness")),
          );
          return yield* upstreamHistory;
        }).pipe(Effect.provide(openThroughSqlite(file)));

        yield* Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          assert.deepEqual(yield* runHoustonMigrations(), []);
          assert.deepEqual(yield* upstreamHistory, upstream);
          const counts = yield* sql<{
            readonly reviews: number;
            readonly findings: number;
            readonly decisions: number;
            readonly defects: number;
          }>`
            SELECT
              (SELECT COUNT(*) FROM houston_harness_reviews) AS reviews,
              (SELECT COUNT(*) FROM houston_harness_findings) AS findings,
              (SELECT COUNT(*) FROM houston_harness_decisions) AS decisions,
              (SELECT COUNT(*) FROM houston_defects) AS defects
          `;
          assert.deepEqual(counts, [{ reviews: 4, findings: 1, decisions: 1, defects: 1 }]);
        }).pipe(Effect.provide(openThroughSqlite(file)));
      }),
    ),
  );
});
