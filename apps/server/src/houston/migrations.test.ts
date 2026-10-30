// The Houston migration track beside upstream's, through persistence/Sqlite.ts.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
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
  [7, "SlackIntake"],
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

describe("the slack intake migration runs on the Houston track", () => {
  const SLACK_TABLES = [
    "houston_slack_adjustments",
    "houston_slack_channels",
    "houston_slack_import",
    "houston_slack_outbox",
    "houston_slack_questions",
    "houston_slack_requests",
    "houston_slack_results",
    "houston_slack_settings",
  ];

  it.effect("the slack intake migration runs on the Houston track", () =>
    withDatabaseFile((file) =>
      Effect.gen(function* () {
        const upstream = yield* Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const history = yield* houstonHistory;
          assert.deepEqual(history.at(-1), [7, "SlackIntake"]);
          const names = history.map(([, name]) => name);
          assert.isBelow(names.indexOf("TaskSources"), names.indexOf("SlackIntake"));
          assert.isTrue(history.slice(0, -1).every(([id]) => id < 7));
          const tables = (yield* sql<{ readonly name: string }>`
            SELECT name FROM sqlite_master
            WHERE type = 'table' AND name LIKE 'houston_slack_%' ORDER BY name
          `).map((row) => row.name);
          assert.deepEqual(tables, SLACK_TABLES);
          const request = (ts: string) => sql`
            INSERT INTO houston_slack_requests (channel_id, ts, author, project_id, state, created_at)
            VALUES ('C1', ${ts}, 'U2', 'p', 'pending', 'now')
          `;
          yield* request("1.000100");
          yield* request("1.000200");
          assert.isTrue((yield* Effect.exit(request("1.000100")))._tag === "Failure");
          const outbox = (key: string) => sql`
            INSERT INTO houston_slack_outbox (request_id, dedupe_key, target, text, created_at)
            VALUES (1, ${key}, 'thread', 'x', 'now')
          `;
          yield* outbox("a");
          assert.isTrue((yield* Effect.exit(outbox("a")))._tag === "Failure");
          const settings = (id: number) => sql`
            INSERT INTO houston_slack_settings (id, enabled, language, updated_at)
            VALUES (${id}, 0, 'en', 'now')
          `;
          yield* settings(1);
          assert.isTrue((yield* Effect.exit(settings(2)))._tag === "Failure");
          for (const table of SLACK_TABLES) {
            const columns = yield* sql<{ readonly name: string }>`
              SELECT name FROM pragma_table_info(${table})
            `;
            assert.isNotEmpty(columns, table);
            for (const column of columns) {
              assert.notMatch(column.name, /token|secret/i, `${table}.${column.name}`);
            }
          }
          // Task sources' provider check is unchanged: Slack has no row there.
          const refused = yield* Effect.exit(sql`
            INSERT INTO houston_task_source_settings (
              project_id, provider, enabled, settings_json, updated_at
            ) VALUES ('p', 'slack', 0, '{}', 'now')
          `);
          assert.isTrue(refused._tag === "Failure");
          assert.isFalse(
            (yield* upstreamHistory).some((row) => row.name.toLowerCase().includes("slack")),
          );
          return yield* upstreamHistory;
        }).pipe(Effect.provide(openThroughSqlite(file)));

        yield* Effect.gen(function* () {
          assert.deepEqual(yield* runHoustonMigrations(), []);
          assert.deepEqual(yield* houstonHistory, HOUSTON_TRACK);
          assert.deepEqual(yield* upstreamHistory, upstream);
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
