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
  it.effect("a fresh database records Houston migration 1 and upstream stays at its head", () =>
    withDatabaseFile((file) =>
      Effect.gen(function* () {
        const first = yield* Effect.gen(function* () {
          assert.deepEqual(yield* houstonHistory, [[1, "ReviewFilesViewed"]]);
          assert.deepEqual(yield* primaryKey, ["worktree_root", "ref_name", "path"]);
          const upstream = yield* upstreamHistory;
          assert.equal(UPSTREAM_HEAD, 72);
          assert.equal(Math.max(...upstream.map((row) => row.migration_id)), UPSTREAM_HEAD);
          return upstream;
        }).pipe(Effect.provide(openThroughSqlite(file)));

        // A reopen applies nothing on either track.
        yield* Effect.gen(function* () {
          assert.deepEqual(yield* runHoustonMigrations(), []);
          assert.deepEqual(yield* houstonHistory, [[1, "ReviewFilesViewed"]]);
          assert.deepEqual(yield* upstreamHistory, first);
        }).pipe(Effect.provide(openThroughSqlite(file)));
      }),
    ),
  );

  it.effect("the in-memory layer runs the Houston track too", () =>
    Effect.gen(function* () {
      assert.deepEqual(yield* houstonHistory, [[1, "ReviewFilesViewed"]]);
      assert.deepEqual(yield* primaryKey, ["worktree_root", "ref_name", "path"]);
    }).pipe(Effect.provide(Layer.fresh(SqlitePersistence.layerMemory))),
  );

  it.effect("upstream's migrator still applies its next id after the Houston track", () =>
    withDatabaseFile((file) =>
      Effect.gen(function* () {
        yield* Effect.gen(function* () {
          assert.deepEqual(yield* houstonHistory, [[1, "ReviewFilesViewed"]]);
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
          assert.deepEqual(yield* houstonHistory, [[1, "ReviewFilesViewed"]]);
        }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: file })));
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
          assert.deepEqual(yield* houstonHistory, [[1, "ReviewFilesViewed"]]);
          assert.deepEqual(yield* primaryKey, ["worktree_root", "ref_name", "path"]);
          assert.deepEqual(yield* upstreamHistory, before);
        }).pipe(Effect.provide(openThroughSqlite(file)));
      }),
    ),
  );
});
