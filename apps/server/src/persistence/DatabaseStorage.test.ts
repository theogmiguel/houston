import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@houston-app/shared/HostProcess";
import * as NodeSqliteClient from "@houston-app/shared/nodeSqliteClient";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerConfig from "../config.ts";
import * as ProjectionMaintenance from "../orchestration-v2/ProjectionMaintenance.ts";
import { ServerActivation } from "../serverActivation.ts";
import * as DatabaseStorage from "./DatabaseStorage.ts";
import { runMigrations } from "./Migrations.ts";
import * as Sqlite from "./Sqlite.ts";

const freePages = Effect.map(
  Effect.flatMap(
    SqlClient.SqlClient,
    (sql) => sql<{ readonly freelist_count: number }>`PRAGMA freelist_count`,
  ),
  (rows) => rows[0]?.freelist_count ?? 0,
);

const storageLayer = <E>(
  config: Layer.Layer<ServerConfig.ServerConfig, E, FileSystem.FileSystem | Path.Path>,
) =>
  DatabaseStorage.layer.pipe(
    Layer.provide(ProjectionMaintenance.layer),
    Layer.provideMerge(Sqlite.layerMemory),
    Layer.provideMerge(config),
    Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
  );

const testConfig = ServerConfig.layerTest(process.cwd(), { prefix: "database-storage-" });

it.effect("a new database returns freed pages online without losing data", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const storage = yield* DatabaseStorage.DatabaseStorage;
    assert.deepEqual(yield* sql`PRAGMA auto_vacuum`, [{ auto_vacuum: 2 }]);
    yield* sql`CREATE TABLE retained (value TEXT)`;
    yield* sql`INSERT INTO retained VALUES ('keep')`;
    yield* sql`CREATE TABLE discarded (value BLOB)`;
    yield* sql`INSERT INTO discarded VALUES (zeroblob(1048576))`;
    yield* sql`DROP TABLE discarded`;
    assert.isAbove(yield* freePages, 0);
    yield* storage.reclaim;
    assert.equal(yield* freePages, 0);
    assert.deepEqual(yield* sql`SELECT value FROM retained`, [{ value: "keep" }]);
  }).pipe(Effect.provide(storageLayer(testConfig))),
);

// Resolving the doctor command walks PATH (seconds on a long Windows PATH); only the storage notice needs it.
// The test's PATH is one missing directory, so the walk stays short on any machine.
it.effect("resolves the compact command after activation, not while the server starts", () =>
  Effect.gen(function* () {
    let pathReads = 0;
    const environment = new Proxy<NodeJS.ProcessEnv>(
      { ...process.env, PATH: `${process.cwd()}/.database-storage-missing-path` },
      {
        get: (target, key) => {
          if (typeof key === "string" && /path/iu.test(key)) pathReads += 1;
          return target[key as string];
        },
      },
    );
    const activated = yield* Deferred.make<void>();
    yield* Effect.gen(function* () {
      const storage = yield* DatabaseStorage.DatabaseStorage;
      assert.equal(pathReads, 0, `PATH was read ${pathReads} times before activation`);
      yield* Deferred.succeed(activated, undefined);
      const status = yield* storage.status.pipe(
        Stream.filter((value) => value !== null),
        Stream.runHead,
      );
      assert.include(status._tag === "Some" ? status.value?.compactCommand : "", "doctor");
      assert.isAbove(pathReads, 0);
    }).pipe(
      Effect.provide(storageLayer(testConfig)),
      Effect.provideService(HostProcess.Environment, environment),
      Effect.provideService(ServerActivation, Deferred.await(activated)),
    );
  }),
);

it.effect("a reclaim pass shrinks the database file", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const config = yield* ServerConfig.ServerConfig;
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const storage = yield* DatabaseStorage.DatabaseStorage;
      const fileBytes = Effect.gen(function* () {
        // SQLite reports busy at once, without waiting, while the checkpoint worker is mid-checkpoint.
        yield* sql<{ readonly busy: number }>`PRAGMA wal_checkpoint(TRUNCATE)`.pipe(
          Effect.repeat({ while: (rows) => rows[0]?.busy !== 0, times: 1_000 }),
        );
        return Number((yield* fs.stat(config.dbPath)).size);
      });
      yield* sql`CREATE TABLE discarded (value BLOB)`;
      yield* sql`INSERT INTO discarded VALUES (zeroblob(2097152))`;
      yield* sql`DROP TABLE discarded`;
      const free = yield* freePages;
      assert.isAbove(free, 2 * DatabaseStorage.RECLAIM_PAGES_PER_STATEMENT);
      const pageCount = sql<{ readonly page_count: number }>`PRAGMA page_count`.pipe(
        Effect.map((rows) => rows[0]?.page_count ?? 0),
      );
      const pagesBefore = yield* pageCount;
      const before = yield* fileBytes;

      yield* storage.reclaim;

      assert.equal(yield* freePages, 0);
      // Moving pages can also release a pointer-map page.
      assert.isAtLeast(pagesBefore - (yield* pageCount), free);
      const pageSize = (yield* sql<{ readonly page_size: number }>`PRAGMA page_size`)[0]!.page_size;
      assert.isAtLeast(before - (yield* fileBytes), free * pageSize);
    }).pipe(
      Effect.provide(
        DatabaseStorage.layer.pipe(
          Layer.provide(ProjectionMaintenance.layer),
          Layer.provideMerge(Sqlite.layerFromPath(config.dbPath)),
        ),
      ),
    );
  }).pipe(
    Effect.provide(
      ServerConfig.layerTest(process.cwd(), { prefix: "database-storage-file-" }).pipe(
        Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
      ),
    ),
  ),
);

const compactionLayer = (
  pruneEventStore: ProjectionMaintenance.ProjectionMaintenanceV2["Service"]["pruneEventStore"],
) =>
  DatabaseStorage.layer.pipe(
    Layer.provide(
      Layer.succeed(ProjectionMaintenance.ProjectionMaintenanceV2, {
        pruneEventStore,
      }),
    ),
    Layer.provide(Sqlite.layerMemory),
  );

const minute = 60_000;
const startupTime = Date.UTC(2026, 9, 19);
const emptyCompaction = { deletedEventCount: 0, deletedReceiptCount: 0, reclaimableBytes: 0 };

it.effect("remembers completion only after the paced pass finishes", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(startupTime);
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const config = yield* ServerConfig.ServerConfig;
    const timestampPath = path.join(path.dirname(config.dbPath), "compacted-at");
    const betweenPagesReached = yield* Deferred.make<void>();
    const completed = yield* Deferred.make<void>();
    const timestampWritten = yield* Deferred.make<void>();
    const compact = (betweenPages: Effect.Effect<void> = Effect.void) =>
      Effect.gen(function* () {
        yield* Effect.sleep(30);
        yield* Deferred.succeed(betweenPagesReached, undefined);
        yield* betweenPages;
        yield* Deferred.succeed(completed, undefined);
        return emptyCompaction;
      });
    yield* Effect.gen(function* () {
      yield* TestClock.adjust(minute);
      yield* TestClock.adjust(30);
      yield* Deferred.await(betweenPagesReached);
      assert.isFalse(yield* Deferred.isDone(completed));
      assert.isFalse(yield* fs.exists(timestampPath));
      yield* TestClock.adjust(269);
      assert.isFalse(yield* Deferred.isDone(completed));
      assert.isFalse(yield* fs.exists(timestampPath));
      yield* TestClock.adjust(1);
      yield* Deferred.await(timestampWritten);
      assert.isTrue(yield* Deferred.isDone(completed));
      assert.equal(Number(yield* fs.readFileString(timestampPath)), startupTime + minute + 300);
    }).pipe(
      Effect.provide(compactionLayer(compact)),
      Effect.provideService(FileSystem.FileSystem, {
        ...fs,
        writeFileString: (file, content, options) =>
          fs
            .writeFileString(file, content, options)
            .pipe(Effect.ensuring(Deferred.succeed(timestampWritten, undefined))),
      }),
    );
  }).pipe(
    Effect.provide(
      testConfig.pipe(Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
    ),
  ),
);

it.effect("the compaction pass merges the message search index", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(startupTime);
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const config = yield* ServerConfig.ServerConfig;
    const timestampPath = path.join(path.dirname(config.dbPath), "compacted-at");
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations();
    // One transaction per finished message, so each adds an index segment.
    for (let n = 0; n < 40; n++) {
      yield* sql`
        INSERT INTO orchestration_v2_projection_messages (
          message_id, thread_id, run_id, node_id, role, streaming, created_at, updated_at, payload_json
        )
        VALUES (
          ${`message-${n}`}, 'thread-1', NULL, NULL, 'assistant', 0,
          '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z', ${JSON.stringify({ text: `needle ${n}` })}
        )
      `;
    }
    // FTS5 keys each segment page by (segment id << 37) + page; ids from 2^16 hold tombstones.
    const segments = Effect.map(
      sql<{ readonly n: number }>`
        SELECT COUNT(DISTINCT id >> 37) AS n FROM orchestration_v2_message_search_data
        WHERE id >= (1 << 37) AND (id >> 37) < 65536
      `,
      (rows) => rows[0]?.n ?? 0,
    );
    const before = yield* segments;
    assert.isAbove(before, 4);

    const timestampWritten = yield* Deferred.make<void>();
    yield* Effect.gen(function* () {
      yield* DatabaseStorage.DatabaseStorage;
      yield* TestClock.adjust(minute);
      yield* Deferred.await(timestampWritten);
    }).pipe(
      Effect.provide(
        DatabaseStorage.layer.pipe(
          Layer.provide(
            Layer.succeed(ProjectionMaintenance.ProjectionMaintenanceV2, {
              pruneEventStore: () => Effect.succeed(emptyCompaction),
            }),
          ),
        ),
      ),
      Effect.provideService(FileSystem.FileSystem, {
        ...fs,
        writeFileString: (file, content, options) =>
          fs
            .writeFileString(file, content, options)
            .pipe(
              Effect.ensuring(
                file === timestampPath
                  ? Deferred.succeed(timestampWritten, undefined)
                  : Effect.void,
              ),
            ),
      }),
    );

    assert.isBelow(yield* segments, before);
    const found = yield* sql`
      SELECT rowid FROM orchestration_v2_message_search
      WHERE orchestration_v2_message_search MATCH '"needle"'
    `;
    assert.equal(found.length, 40);
  }).pipe(
    Effect.provide(
      Sqlite.layerMemory.pipe(
        Layer.provideMerge(
          ServerConfig.layerTest(process.cwd(), { prefix: "database-storage-merge-" }),
        ),
        Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
      ),
    ),
  ),
);

// Windows cannot truncate a file that any connection maps, readers included.
it.effect("reclaim shrinks the file while every reader is open", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const config = yield* ServerConfig.ServerConfig;
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const storage = yield* DatabaseStorage.DatabaseStorage;
      const fileBytes = Effect.gen(function* () {
        yield* sql<{ readonly busy: number }>`PRAGMA wal_checkpoint(TRUNCATE)`.pipe(
          Effect.repeat({ while: (rows) => rows[0]?.busy !== 0, times: 1_000 }),
        );
        return Number((yield* fs.stat(config.dbPath)).size);
      });
      yield* sql`CREATE TABLE discarded (value BLOB)`;
      yield* sql`INSERT INTO discarded VALUES (zeroblob(2097152))`;
      // Readers then read the blob from the database file, not the WAL; a mapping reader would pin it.
      yield* fileBytes;
      yield* Effect.forEach(
        Array.from({ length: 8 }),
        () =>
          sql`SELECT hex(substr(value, 2097000, 8)) AS tail FROM discarded`.pipe(
            NodeSqliteClient.readOnly,
          ),
        { concurrency: "unbounded" },
      );
      yield* sql`DROP TABLE discarded`;
      const free = yield* freePages;
      assert.isAbove(free, 0);
      const before = yield* fileBytes;

      yield* storage.reclaim;

      assert.equal(yield* freePages, 0);
      const pageSize = (yield* sql<{ readonly page_size: number }>`PRAGMA page_size`)[0]!.page_size;
      // Moving pages can also release a pointer-map page.
      assert.isAtLeast(before - (yield* fileBytes), free * pageSize);
    }).pipe(
      Effect.provide(
        DatabaseStorage.layer.pipe(
          Layer.provide(ProjectionMaintenance.layer),
          Layer.provideMerge(Sqlite.layerFromPath(config.dbPath)),
        ),
      ),
    );
  }).pipe(
    Effect.provide(
      ServerConfig.layerTest(process.cwd(), { prefix: "database-storage-readers-" }).pipe(
        Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
      ),
    ),
  ),
);

const dropMegabytes = (megabytes: number) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`CREATE TABLE IF NOT EXISTS retained (value TEXT)`;
    yield* sql`INSERT INTO retained VALUES ('keep')`;
    yield* sql`CREATE TABLE discarded (value BLOB)`;
    yield* sql`INSERT INTO discarded VALUES (zeroblob(${megabytes * 1024 * 1024}))`;
    yield* sql`DROP TABLE discarded`;
  });

const reclaimNow = Effect.flatMap(DatabaseStorage.DatabaseStorage, (storage) => storage.reclaimNow);

it.effect("a one-click reclaim returns every freed page and reports what it returned", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* dropMegabytes(4);
    const free = yield* freePages;
    assert.isAbove(free, 2 * DatabaseStorage.RECLAIM_PAGES_PER_STATEMENT);
    const pageSize = (yield* sql<{ readonly page_size: number }>`PRAGMA page_size`)[0]!.page_size;

    const result = yield* reclaimNow;

    assert.equal(yield* freePages, 0);
    assert.isAtLeast(result.reclaimedBytes, free * pageSize);
    assert.equal(result.remainingBytes, 0);
    assert.deepEqual(yield* sql`SELECT value FROM retained`, [{ value: "keep" }]);
  }).pipe(Effect.provide(storageLayer(testConfig))),
);

it.effect("a one-click reclaim lets writes from running agents through", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* dropMegabytes(4);
    yield* sql`CREATE TABLE agent_events (n INTEGER)`;
    const writes = Effect.forEach(
      Array.from({ length: 50 }, (_, n) => n),
      (n) => sql`INSERT INTO agent_events VALUES (${n})`.pipe(Effect.andThen(Effect.yieldNow)),
      { discard: true },
    );

    yield* Effect.all([reclaimNow, writes], { concurrency: "unbounded" });

    assert.equal(
      (yield* sql<{ readonly count: number }>`SELECT COUNT(*) AS count FROM agent_events`)[0]!
        .count,
      50,
    );
    assert.equal(yield* freePages, 0);
  }).pipe(Effect.provide(storageLayer(testConfig))),
);

it.effect("a one-click reclaim stops at its time limit and says what is left", () =>
  Effect.gen(function* () {
    yield* dropMegabytes(4);
    const free = yield* freePages;

    const result = yield* reclaimNow;

    assert.equal(result.timeLimitSeconds, 0);
    assert.equal(result.reclaimedBytes, 0);
    assert.isAbove(result.remainingBytes, 0);
    assert.equal(yield* freePages, free);
  }).pipe(
    Effect.provide(storageLayer(testConfig)),
    Effect.provideService(DatabaseStorage.ReclaimTimeLimit, Duration.zero),
  ),
);

it.effect("a one-click reclaim refuses a database that cannot shrink online", () =>
  Effect.gen(function* () {
    const refused = yield* reclaimNow.pipe(Effect.flip);
    assert.equal(refused._tag, "HoustonDatabaseReclaimError");
    assert.equal(refused.kind, "needs-offline-repair");
    assert.include(refused.message, "doctor");
    assert.include(refused.message, "stopped");
  }).pipe(
    Effect.provide(
      DatabaseStorage.layer.pipe(
        Layer.provide(ProjectionMaintenance.layer),
        Layer.provide(
          Layer.effectDiscard(
            Effect.gen(function* () {
              const sql = yield* SqlClient.SqlClient;
              yield* sql.unsafe(`PRAGMA auto_vacuum = NONE`);
              yield* sql`VACUUM`;
            }),
          ).pipe(Layer.provideMerge(Sqlite.layerMemory)),
        ),
        Layer.provideMerge(testConfig),
        Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
      ),
    ),
    // Resolving the doctor command reads PATH and the file system, as the server's own context does.
    Effect.provide(NodeServices.layer),
  ),
);

it.effect("a one-click reclaim refuses a database outside this channel's directory", () =>
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const elsewhere = "/home/someone/.houston/houston.db";
    const refused = yield* reclaimNow.pipe(
      Effect.provide(
        storageLayer(Layer.succeed(ServerConfig.ServerConfig, { ...config, dbPath: elsewhere })),
      ),
      Effect.flip,
    );
    if (refused._tag !== "HoustonDatabaseReclaimError") return assert.fail(refused._tag);
    assert.equal(refused.kind, "not-channel-database");
    assert.include(refused.message, elsewhere);
    assert.include(refused.message, config.baseDir);
  }).pipe(Effect.provide(testConfig.pipe(Layer.provideMerge(NodeServices.layer)))),
);

it.effect("a one-click reclaim refuses when the disk cannot hold the write-ahead log", () =>
  Effect.gen(function* () {
    yield* dropMegabytes(4);
    const free = yield* freePages;
    const huge = 2 ** 60;

    const refused = yield* reclaimNow.pipe(Effect.flip);

    assert.equal(refused.kind, "insufficient-disk");
    assert.equal(refused.neededBytes, huge);
    assert.isBelow(refused.freeBytes ?? Infinity, huge);
    assert.include(refused.message, "free disk space");
    assert.equal(yield* freePages, free, "a refused reclaim must not change the database");
  }).pipe(
    Effect.provide(storageLayer(testConfig)),
    Effect.provideService(DatabaseStorage.ReclaimHeadroomBytes, 2 ** 60),
  ),
);
