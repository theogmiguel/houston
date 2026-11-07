import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";
import * as HostProcess from "@houston-app/shared/HostProcess";
import * as NodeSqliteClient from "@houston-app/shared/nodeSqliteClient";

import { runMigrations } from "./Migrations.ts";
import { runHoustonMigrations } from "../houston/migrations.ts";
import { ensureHoustonReadModels } from "../houston/projectionReadModels.ts";
import { initializeV2Database } from "./initializeV2Database.ts";
import * as ServerConfig from "../config.ts";

const WAL_SIZE_LIMIT_BYTES = 32 * 1024 * 1024;

// Mapped reads skip SQLite's copy into its page cache: 12-43% off boot, shell and thread-open reads.
// The mapping is address space over the OS file cache that all connections share, not heap; it
// counts towards resident memory as pages are touched, up to the file size.
const MMAP_SIZE_BYTES = 1024 * 1024 * 1024;
// 4 readers x 32 MiB: at most 128 MiB of heap over SQLite's default 2 MB per reader.
const WINDOWS_READER_CACHE_KIB = 32 * 1024;

/**
 * Windows cannot truncate a file any connection maps, so reclaim would stop shrinking it there;
 * its readers get a larger page cache instead. The checkpoint connection only copies WAL frames.
 */
export const connectionPragmas = (platform: NodeJS.Platform) =>
  platform === "win32"
    ? { writer: [], readers: [`cache_size = -${WINDOWS_READER_CACHE_KIB}`] }
    : { writer: [`mmap_size = ${MMAP_SIZE_BYTES}`], readers: [`mmap_size = ${MMAP_SIZE_BYTES}`] };

const layerSetup = Layer.effectDiscard(
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    // CLI and server write from separate processes; wait rather than fail with SQLITE_BUSY.
    yield* sql`PRAGMA busy_timeout = 5000;`;
    yield* sql`PRAGMA foreign_keys = ON;`;
    // Houston: a REPLACE then fires delete triggers, which keep houston/projectionReadModels.ts exact.
    yield* sql`PRAGMA recursive_triggers = ON;`;
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
    for (const pragma of connectionPragmas(yield* HostProcess.Platform).writer) {
      yield* sql.unsafe(`PRAGMA ${pragma};`);
    }
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

export const layerFromPath = Effect.fn("makeSqlitePersistenceLive")(function* (dbPath: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fs.makeDirectory(path.dirname(dbPath), { recursive: true });

  return Layer.provideMerge(
    layerSetup,
    NodeSqliteClient.layer({
      filename: dbPath,
      readerWorker: true,
      readerPragmas: connectionPragmas(yield* HostProcess.Platform).readers,
      // Run checkpoint fsyncs off the event loop so slow disk flushes cannot stall clients.
      checkpointWorker: true,
      spanAttributes: {
        "db.name": path.basename(dbPath),
        "service.name": "houston-server",
      },
    }),
  );
}, Layer.unwrap);

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
