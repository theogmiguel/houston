import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@houston-app/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";

import { ensureHoustonReadModels } from "../../src/houston/projectionReadModels.ts";
import { buildDatabase } from "./build.ts";

const READ_MODELS = ["houston_thread_shell", "houston_user_messages", "houston_turn_item_counts"];

const snapshot = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows: Record<string, ReadonlyArray<unknown>> = {};
  for (const table of READ_MODELS) {
    rows[table] = yield* sql.unsafe(`SELECT * FROM "${table}" ORDER BY 1, 2`);
  }
  return rows;
});

it.effect("a cloned fixture's trigger-kept read models equal a rebuild", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "houston-db-load-build-" });
    const manifest = yield* buildDatabase({
      dir: path.join(dir, "2x"),
      scale: 2,
      seed: 7,
      shape: { projects: 1, threads: 4, tasks: 2, runBuckets: [[1, 1, 2]] },
      log: () => {},
    });
    assert.equal(manifest.units, 2);
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const built = yield* snapshot;
      for (const table of READ_MODELS) assert.isNotEmpty(built[table], table);
      // A missing read-model table makes the next open rebuild every read model from the source rows.
      for (const table of READ_MODELS) yield* sql.unsafe(`DROP TABLE "${table}"`);
      yield* ensureHoustonReadModels();
      assert.deepEqual(yield* snapshot, built);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: manifest.dbPath })));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
