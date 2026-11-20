import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeSqliteClient from "@houston-app/shared/nodeSqliteClient";

import { runMigrations } from "./Migrations.ts";
import { runHoustonMigrations } from "../houston/migrations.ts";
import { ensureHoustonReadModels } from "../houston/projectionReadModels.ts";
import { initializeV2Database } from "./initializeV2Database.ts";
import { BUILD_MIGRATION_HEAD, recordedMigrations } from "./databaseMigrationHead.ts";
import { isProcessAlive, readPersistedServerRuntimeState } from "../serverRuntimeState.ts";
import * as ServerConfig from "../config.ts";

export class DatabaseMigrationsAheadError extends Schema.TaggedError<DatabaseMigrationsAheadError>()(
  "DatabaseMigrationsAheadError",
  {
    databasePath: Schema.String,
    databaseMigration: Schema.Int,
    buildMigration: Schema.Int,
  },
) {
  override get message(): string {
    return `The database at ${this.databasePath} records migration ${this.databaseMigration}, newer than this build's migration ${this.buildMigration}. Run a build that includes migration ${this.databaseMigration}, or use a database this build supports.`;
  }
}

export const WAL_SIZE_LIMIT_BYTES = 128 * 1024 * 1024;

// 4 readers x 32 MiB: about 120 MiB of heap over SQLite's default 2 MB per reader. On Windows it
// took 19-23% off deep thread-open and boot reads at 10x. No connection maps the file (mmap_size):
// Windows cannot truncate a mapped file, and elsewhere a mapped-page I/O error ends the server.
const READER_CACHE_KIB = 32 * 1024;
const READER_PRAGMAS = [`cache_size = -${READER_CACHE_KIB}`];

const makeLayerSetup = (applyMigrations: boolean) =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      // CLI and server write from separate processes; wait rather than fail with SQLITE_BUSY.
      yield* sql`PRAGMA busy_timeout = 5000;`;
      yield* sql`PRAGMA foreign_keys = ON;`;
      // Houston: a REPLACE then fires delete triggers, which keep houston/projectionReadModels.ts exact.
      yield* sql`PRAGMA recursive_triggers = ON;`;
      if (!applyMigrations) {
        // A CLI beside a running server reads and writes its database without changing its schema.
        yield* sql`PRAGMA temp_store = MEMORY;`;
        return;
      }
      // Existing databases need doctor's offline VACUUM to add pointer maps for this mode.
      const tables = yield* sql<{
        readonly count: number;
      }>`SELECT COUNT(*) AS count FROM sqlite_schema WHERE type = 'table'`;
      if (tables[0]?.count === 0) yield* sql`PRAGMA auto_vacuum = INCREMENTAL;`;
      yield* sql`PRAGMA journal_mode = WAL;`;
      // FULL fsyncs every event commit on the main thread; NORMAL syncs only at WAL checkpoints.
      // App crashes lose nothing; OS crashes or power loss can roll back post-checkpoint commits without corruption.
      yield* sql`PRAGMA synchronous = NORMAL;`;
      // macOS fsync misses drive caches; F_FULLFSYNC flushes them at checkpoints and is ignored elsewhere.
      yield* sql`PRAGMA checkpoint_fullfsync = ON;`;
      // Keep statement journals and sort spills off the main thread's disk path.
      // Large statements and open savepoints can increase peak memory use.
      yield* sql`PRAGMA temp_store = MEMORY;`;
      // PASSIVE checkpoints retain peak WAL size until the last connection closes.
      yield* sql.unsafe(`PRAGMA journal_size_limit = ${WAL_SIZE_LIMIT_BYTES};`);
      yield* runMigrations();
      yield* runHoustonMigrations();
      yield* ensureHoustonReadModels();
      // Collecting stats scans every page, and stale small-table stats cause scans after growth; use indexes by default.
      // Connections cache stats; reload after deleting them.
      const statTables = yield* sql`SELECT 1 FROM sqlite_schema WHERE name = 'sqlite_stat1'`;
      if (statTables.length > 0) {
        yield* sql`DELETE FROM sqlite_stat1;`;
        yield* sql`ANALYZE sqlite_schema;`;
      }
    }).pipe(Effect.withSpan("Sqlite.setup")),
  );

const layerSetup = makeLayerSetup(true);
const layerSetupWithoutMigrations = makeLayerSetup(false);

const layerWithSetup = (
  dbPath: string,
  setup: typeof layerSetup,
): Effect.Effect<Layer.Layer<never>, never, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* fs.makeDirectory(path.dirname(dbPath), { recursive: true });

    return Layer.provideMerge(
      setup,
      NodeSqliteClient.layer({
        filename: dbPath,
        readerWorker: true,
        readerPragmas: READER_PRAGMAS,
        // Run checkpoint fsyncs off the event loop so slow disk flushes cannot stall clients.
        checkpointWorker: true,
        spanAttributes: {
          "db.name": path.basename(dbPath),
          "service.name": "houston-server",
        },
      }),
    );
  });

export const layerFromPath = Effect.fn("makeSqlitePersistenceLive")(
  function* (dbPath: string) {
    return yield* layerWithSetup(dbPath, layerSetup);
  },
  Layer.unwrap,
);

/** A database a running server owns: never applies migrations, and refuses one this build is too old for. */
export const layerFromPathWithoutMigrations = Effect.fn(
  "makeSqlitePersistenceWithoutMigrations",
)(
  function* (dbPath: string) {
    const recorded = recordedMigrations(dbPath);
    const databaseMigration =
      recorded === null ? 0 : Math.max(0, ...recorded.map(({ id }) => id));
    if (databaseMigration > BUILD_MIGRATION_HEAD) {
      return yield* new DatabaseMigrationsAheadError({
        databasePath: dbPath,
        databaseMigration,
        buildMigration: BUILD_MIGRATION_HEAD,
      });
    }
    return yield* layerWithSetup(dbPath, layerSetupWithoutMigrations);
  },
  Layer.unwrap,
);

export const layerMemory = Layer.provideMerge(
  layerSetup,
  NodeSqliteClient.layer({ filename: ":memory:" }),
);

export const layerConfig = Layer.unwrap(
  Effect.gen(function* () {
    const { dbPath } = yield* ServerConfig.ServerConfig;
    yield* initializeV2Database(dbPath);
    return layerFromPath(dbPath);
  }),
);

const liveServerOwns = Effect.fn("Sqlite.liveServerOwns")(function* (statePath: string) {
  const runtime = yield* readPersistedServerRuntimeState(statePath);
  return (
    Option.isSome(runtime) &&
    runtime.value.pid > 0 &&
    runtime.value.pid !== process.pid &&
    isProcessAlive(runtime.value.pid)
  );
});

/** For CLI commands beside a server: use the non-migrating layer while that server may be open. */
export const layerCliConfig = Layer.unwrap(
  Effect.gen(function* () {
    const { dbPath, serverRuntimeStatePath } = yield* ServerConfig.ServerConfig;
    if (yield* liveServerOwns(serverRuntimeStatePath)) {
      return layerFromPathWithoutMigrations(dbPath);
    }
    yield* initializeV2Database(dbPath);
    return layerFromPath(dbPath);
  }),
);
