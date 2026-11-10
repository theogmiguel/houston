// The Houston migration track beside upstream's, through persistence/Sqlite.ts.
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as NodeSqliteClient from "@houston-app/shared/nodeSqliteClient";
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
  [5, "MergeQueue"],
  [6, "TaskSourceMarkerKey"],
  [7, "HarnessReview"],
  [8, "SlackIntake"],
  [9, "NightShift"],
  [10, "DropNightShiftAndHarnessReview"],
  [11, "SecretStoreImport"],
  [12, "ProjectionReadIndexes"],
  [13, "ShellReadModels"],
  [16, "TimelineReadIndex"],
  [17, "TurnStartReadModels"],
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
  }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)));

const openThroughSqlite = (file: string) =>
  Layer.fresh(SqlitePersistence.layerFromPath(file)).pipe(
    Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
  );

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

describe("the Houston track applies every id it has not recorded", () => {
  const slackTables = Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return (yield* sql<{ readonly name: string }>`
      SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'houston_slack_%'
    `).map((row) => row.name);
  });

  it.effect("a database at upstream's head applies every Houston id in id order", () =>
    withDatabaseFile((file) =>
      Effect.gen(function* () {
        yield* runMigrations();
        assert.deepEqual(yield* runHoustonMigrations(), HOUSTON_TRACK);
        assert.deepEqual(yield* houstonHistory, HOUSTON_TRACK);
      }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: file }))),
    ),
  );

  it.effect("a database that recorded 1..7 and 9..11 gets 8 applied, then nothing", () =>
    withDatabaseFile((file) =>
      Effect.gen(function* () {
        // Composed fixture: a migrated database without id 8's tables and row is the state of one
        // that ran a build with 9 but not 8.
        yield* Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          for (const table of yield* slackTables) yield* sql`DROP TABLE ${sql(table)}`;
          yield* sql`DELETE FROM houston_sql_migrations WHERE migration_id = 8`;
        }).pipe(Effect.provide(openThroughSqlite(file)));

        yield* Effect.gen(function* () {
          assert.deepEqual(yield* slackTables, []);
          assert.deepEqual(yield* runHoustonMigrations(), [[8, "SlackIntake"]]);
          assert.deepEqual(yield* houstonHistory, HOUSTON_TRACK);
          assert.isAbove((yield* slackTables).length, 0);
          assert.deepEqual(yield* runHoustonMigrations(), []);
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
          const slack = history.findIndex(([, name]) => name === "SlackIntake");
          assert.deepEqual(history[slack], [8, "SlackIntake"]);
          const names = history.map(([, name]) => name);
          assert.isBelow(names.indexOf("TaskSources"), names.indexOf("SlackIntake"));
          assert.isTrue(history.slice(0, slack).every(([id]) => id < 8));
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
          assert.deepEqual(
            history.find(([id]) => id === 5),
            [5, "MergeQueue"],
          );
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

describe("the projection read indexes cover rows written before them", () => {
  it.effect("threads and provider threads already stored are indexed by their payload keys", () =>
    withDatabaseFile((file) =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations();
        const thread = (id: string, payload: object, archivedAt: string | null = null) => sql`
          INSERT INTO orchestration_v2_projection_threads (thread_id, project_id, title,
            default_provider, provider_instance_id, runtime_mode, interaction_mode, created_at,
            updated_at, archived_at, deleted_at, payload_json)
          VALUES (${id}, 'project', ${id}, 'codex', 'codex', 'full-access', 'default', '2026-01-01',
            ${`2026-01-0${id.length}`}, ${archivedAt}, NULL,
            ${JSON.stringify({ ...payload, archivedAt })})
        `;
        yield* thread("worktree", {
          worktreePath: "/work/tree",
          lineage: { relationshipToParent: "subagent" },
          pullRequests: [{ number: 1 }],
          limitRecovery: { autoResume: true },
        });
        yield* thread("plain", { worktreePath: null, pullRequests: [] });
        yield* thread("archived", { worktreePath: "/work/old" }, "2026-01-02");
        yield* sql`
          INSERT INTO orchestration_v2_projection_provider_threads (provider_thread_id, thread_id,
            provider, status, updated_at, payload_json)
          VALUES ('provider:pending', 'plain', 'codex', 'idle', '2026-01-01',
            ${JSON.stringify({ pendingBackgroundTasks: [{ id: "task" }] })}),
            ('provider:idle', 'plain', 'codex', 'idle', '2026-01-01', '{}')
        `;
        yield* runHoustonMigrations();
        const indexed = (index: string, where: string) =>
          sql
            .unsafe<{ readonly id: string }>(
              index === "houston_provider_threads_pending_idx"
                ? `SELECT provider_thread_id AS id FROM orchestration_v2_projection_provider_threads
                    INDEXED BY ${index} WHERE ${where} ORDER BY id`
                : `SELECT thread_id AS id FROM orchestration_v2_projection_threads
                    INDEXED BY ${index} WHERE ${where} ORDER BY id`,
            )
            .pipe(Effect.map((rows) => rows.map((row) => row.id)));
        const valid = (condition: string) =>
          `CASE WHEN json_valid(payload_json) THEN ${condition} ELSE 0 END`;
        assert.deepEqual(
          yield* indexed(
            "houston_threads_worktree_idx",
            `deleted_at IS NULL AND ${valid("json_extract(payload_json, '$.worktreePath') IS NOT NULL")}`,
          ),
          ["archived", "worktree"],
        );
        assert.deepEqual(
          yield* indexed(
            "houston_threads_subagent_idx",
            `deleted_at IS NULL AND ${valid("json_extract(payload_json, '$.archivedAt') IS NULL AND json_extract(payload_json, '$.lineage.relationshipToParent') = 'subagent'")}`,
          ),
          ["worktree"],
        );
        assert.deepEqual(
          yield* indexed(
            "houston_threads_pull_requests_idx",
            `deleted_at IS NULL AND ${valid("json_extract(payload_json, '$.archivedAt') IS NULL AND json_array_length(payload_json, '$.pullRequests') > 0")}`,
          ),
          ["worktree"],
        );
        assert.deepEqual(
          yield* indexed(
            "houston_threads_limit_auto_resume_idx",
            `deleted_at IS NULL AND ${valid("json_extract(payload_json, '$.limitRecovery.autoResume') = 1")}`,
          ),
          ["worktree"],
        );
        assert.deepEqual(
          yield* indexed(
            "houston_provider_threads_pending_idx",
            `status = 'active' OR ${valid("json_array_length(payload_json, '$.pendingBackgroundTasks') > 0")}`,
          ),
          ["provider:pending"],
        );
        // A malformed payload stays writable and leaves every index.
        yield* sql`UPDATE orchestration_v2_projection_threads SET payload_json = 'not json'
          WHERE thread_id = 'worktree'`;
        assert.deepEqual(
          yield* indexed(
            "houston_threads_worktree_idx",
            `deleted_at IS NULL AND ${valid("json_extract(payload_json, '$.worktreePath') IS NOT NULL")}`,
          ),
          ["archived"],
        );
      }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: file }))),
    ),
  );
});

describe("the removal migration drops the night shift and harness review tables", () => {
  const removedTables = Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return (yield* sql<{ readonly name: string }>`
      SELECT name FROM sqlite_master
      WHERE type = 'table'
        AND (name LIKE 'houston_night_%' OR name LIKE 'houston_harness_%' OR name = 'houston_defects')
      ORDER BY name
    `).map((row) => row.name);
  });
  const featureTables = [
    "houston_defects",
    "houston_harness_decisions",
    "houston_harness_finding_tasks",
    "houston_harness_findings",
    "houston_harness_import",
    "houston_harness_reviews",
    "houston_harness_settings",
    "houston_harness_verifications",
    "houston_night_crew",
    "houston_night_entries",
    "houston_night_import",
    "houston_night_pushes",
    "houston_night_runs",
    "houston_night_shift_settings",
  ];

  it.effect("a database that recorded 1..9 loses the tables and their rows", () =>
    withDatabaseFile((file) =>
      Effect.gen(function* () {
        // Composed fixture: the schema and rows a build with ids 1..9 leaves behind.
        yield* Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          for (const table of featureTables) {
            yield* sql`CREATE TABLE ${sql(table)} (id INTEGER PRIMARY KEY)`;
            yield* sql`INSERT INTO ${sql(table)} (id) VALUES (1)`;
          }
          yield* sql`DELETE FROM houston_sql_migrations WHERE migration_id = 10`;
        }).pipe(Effect.provide(openThroughSqlite(file)));

        yield* Effect.gen(function* () {
          assert.deepEqual(yield* runHoustonMigrations(), [[10, "DropNightShiftAndHarnessReview"]]);
          assert.deepEqual(yield* removedTables, []);
          assert.deepEqual(yield* houstonHistory, HOUSTON_TRACK);
          assert.deepEqual(yield* runHoustonMigrations(), []);
        }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: file })));
      }),
    ),
  );
});
