import type { DatabaseStorageStatus } from "@houston-app/contracts";
import {
  HoustonDatabaseReclaimError,
  type HoustonDatabaseReclaimResult,
} from "@houston-app/contracts/houston/databaseReclaim";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as SqlClient from "effect/sql/SqlClient";

import { resolveHostCliCommand } from "../cli/invocation.ts";
import * as ServerConfig from "../config.ts";
import { mergeMessageSearch } from "../orchestration-v2/messageSearchIndex.ts";
import * as ProjectionMaintenance from "../orchestration-v2/ProjectionMaintenance.ts";
import { diskShortfall, formatBytes } from "../houston/databaseReclaim.ts";
import { forkParked } from "../serverActivation.ts";
import { WAL_SIZE_LIMIT_BYTES } from "./Sqlite.ts";

// Bound each reclaim pass to one minute of churn.
const RECLAIM_PAGES_PER_PASS = 1024;
// Each statement commits on its own: 32 pages write a third of the WAL of 32 single-page commits
// and hold the writer for about 2 ms.
export const RECLAIM_PAGES_PER_STATEMENT = 32;
const COMPACTION_INTERVAL = Duration.hours(6);
// About 256 MB of merged search index per pass at most; a pass usually needs a few hundred steps.
const SEARCH_MERGE_STEPS_PER_PASS = 1024;

const isReclaimError = Schema.is(HoustonDatabaseReclaimError);

// One click returns pages for at most this long. A 1 GiB free list takes about half a minute at
// the pace below, so two minutes covers several GiB; a larger backlog reports what is left.
export const RECLAIM_NOW_TIME_LIMIT = Duration.minutes(2);
export const ReclaimTimeLimit = Context.Reference<Duration.Duration>(
  "@houston-app/cli/persistence/DatabaseStorage/ReclaimTimeLimit",
  { defaultValue: () => RECLAIM_NOW_TIME_LIMIT },
);

// Moving live pages into freed holes writes them to the write-ahead log, which SQLite lets grow
// to journal_size_limit between checkpoints. Refuse when the disk cannot hold that.
export const ReclaimHeadroomBytes = Context.Reference<number>(
  "@houston-app/cli/persistence/DatabaseStorage/ReclaimHeadroomBytes",
  { defaultValue: () => WAL_SIZE_LIMIT_BYTES },
);

// Work in slices of this length, then rest as long as the slice took, so writes from agent runs
// share the connection at about half duty. Each statement itself holds the writer for ~2 ms.
const RECLAIM_NOW_SLICE_NANOS = 25_000_000n;

export class DatabaseStorage extends Context.Service<
  DatabaseStorage,
  {
    /** Return free pages to the filesystem on databases with incremental auto_vacuum. */
    readonly reclaim: Effect.Effect<void>;
    /** Current file accounting, re-published after each maintenance pass. Null until first read. */
    readonly status: Stream.Stream<DatabaseStorageStatus | null>;
    /**
     * Returns every free page now, in paced slices that share the connection with running
     * agents. Refuses databases that only an offline repair can shrink.
     */
    readonly reclaimNow: Effect.Effect<HoustonDatabaseReclaimResult, HoustonDatabaseReclaimError>;
  }
>()("@houston-app/cli/persistence/DatabaseStorage") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const maintenance = yield* ProjectionMaintenance.ProjectionMaintenanceV2;
  const config = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const statusRef = yield* SubscriptionRef.make<DatabaseStorageStatus | null>(null);

  // The notice shows host-shell quoting verbatim; desktop needs its launcher because houston is absent from PATH.
  // Resolved on first publish: the PATH walk takes seconds on Windows and must not delay listening.
  const resolveCompactCommand = yield* Effect.cached(
    resolveHostCliCommand("doctor", ["--base-dir", config.baseDir]).pipe(
      Effect.map(({ command }) => command),
    ),
  );
  // doctor --base-dir targets userdata, not implicit dev homes; suppress status to avoid touching the live install.
  const doctorTargetsThisDatabase =
    path.resolve(config.dbPath) ===
    path.resolve(config.baseDir, "userdata", path.basename(config.dbPath));
  // Only VACUUM changes these, and doctor refuses to VACUUM while a server has the database open.
  let layout: { readonly pageSize: number; readonly incrementalVacuum: boolean } | undefined;
  const readLayout = Effect.suspend(() =>
    layout !== undefined
      ? Effect.succeed(layout)
      : Effect.gen(function* () {
          const size = yield* sql<{ readonly page_size: number }>`PRAGMA page_size`;
          const mode = yield* sql<{ readonly auto_vacuum: number }>`PRAGMA auto_vacuum`;
          layout = {
            pageSize: size[0]?.page_size ?? 0,
            incrementalVacuum: mode[0]?.auto_vacuum === 2,
          };
          return layout;
        }),
  );
  const readPages = Effect.gen(function* () {
    const { pageSize, incrementalVacuum } = yield* readLayout;
    const pages = yield* sql<{ readonly page_count: number }>`PRAGMA page_count`;
    const free = yield* sql<{ readonly freelist_count: number }>`PRAGMA freelist_count`;
    return {
      databaseBytes: (pages[0]?.page_count ?? 0) * pageSize,
      reclaimableBytes: (free[0]?.freelist_count ?? 0) * pageSize,
      incrementalVacuum,
    };
  });
  const publishStatus = Effect.gen(function* () {
    if (!doctorTargetsThisDatabase) return;
    const { databaseBytes, reclaimableBytes, incrementalVacuum } = yield* readPages;
    const next: DatabaseStorageStatus = {
      databaseBytes,
      reclaimableBytes,
      incrementalVacuumEnabled: incrementalVacuum,
      compactCommand: yield* resolveCompactCommand,
    };
    // Every set reaches each open Storage page; most passes change nothing.
    if (!Equal.equals(yield* SubscriptionRef.get(statusRef), next)) {
      yield* SubscriptionRef.set(statusRef, next);
    }
  }).pipe(
    Effect.catch((cause) => Effect.logWarning("Database storage inspection failed", { cause })),
  );

  // The background pass and a one-click reclaim must not interleave their statements.
  const reclaimLock = yield* Semaphore.make(1);
  const reclaim = Effect.gen(function* () {
    if (!(yield* readLayout).incrementalVacuum) return;
    // Yield between statements so other writers interleave.
    for (let page = 0; page < RECLAIM_PAGES_PER_PASS; page += RECLAIM_PAGES_PER_STATEMENT) {
      const free = yield* sql<{ readonly freelist_count: number }>`PRAGMA freelist_count`;
      if ((free[0]?.freelist_count ?? 0) === 0) break;
      yield* sql.unsafe(`PRAGMA incremental_vacuum(${RECLAIM_PAGES_PER_STATEMENT})`);
      yield* Effect.yieldNow;
    }
  }).pipe(
    reclaimLock.withPermits(1),
    Effect.catch((cause) => Effect.logWarning("Database space reclamation failed", { cause })),
  );

  const reclaimNow = Effect.gen(function* () {
    const expectedPath = path.resolve(config.baseDir, "userdata", path.basename(config.dbPath));
    if (!doctorTargetsThisDatabase) {
      return yield* new HoustonDatabaseReclaimError({
        kind: "not-channel-database",
        message: `Reclaim runs only on this channel's own database, ${expectedPath}; this server uses ${config.dbPath}.`,
      });
    }
    if (!(yield* readLayout).incrementalVacuum) {
      return yield* new HoustonDatabaseReclaimError({
        kind: "needs-offline-repair",
        message: `This database was created before automatic shrinking, so its free space can only be returned while Houston is stopped. Stop Houston on this machine, then run: ${yield* resolveCompactCommand}`,
      });
    }
    const headroomBytes = yield* ReclaimHeadroomBytes;
    const shortfall = yield* diskShortfall(config.dbPath, headroomBytes).pipe(
      Effect.provideService(Path.Path, path),
    );
    if (shortfall !== null) {
      return yield* new HoustonDatabaseReclaimError({
        kind: "insufficient-disk",
        message: `Reclaiming needs ${formatBytes(shortfall.neededBytes)} of free disk space next to ${config.dbPath} for the write-ahead log; ${formatBytes(shortfall.freeBytes)} is free. Free some disk space and try again.`,
        neededBytes: shortfall.neededBytes,
        freeBytes: shortfall.freeBytes,
      });
    }
    const timeLimit = yield* ReclaimTimeLimit;
    const before = yield* readPages;
    yield* Effect.gen(function* () {
      const started = yield* Clock.monotonicTimeNanos;
      const limitNanos = BigInt(Math.round(Duration.toMillis(timeLimit))) * 1_000_000n;
      let sliceStarted = started;
      while ((yield* Clock.monotonicTimeNanos) - started < limitNanos) {
        const free = yield* sql<{ readonly freelist_count: number }>`PRAGMA freelist_count`;
        if ((free[0]?.freelist_count ?? 0) === 0) break;
        yield* sql.unsafe(`PRAGMA incremental_vacuum(${RECLAIM_PAGES_PER_STATEMENT})`);
        const elapsed = (yield* Clock.monotonicTimeNanos) - sliceStarted;
        if (elapsed >= RECLAIM_NOW_SLICE_NANOS) {
          yield* Effect.sleep(Number(elapsed) / 1_000_000);
          sliceStarted = yield* Clock.monotonicTimeNanos;
        } else {
          yield* Effect.yieldNow;
        }
      }
    }).pipe(reclaimLock.withPermits(1));
    const after = yield* readPages;
    yield* publishStatus;
    return {
      reclaimedBytes: Math.max(0, before.reclaimableBytes - after.reclaimableBytes),
      remainingBytes: after.reclaimableBytes,
      databaseBytes: after.databaseBytes,
      timeLimitSeconds: Duration.toSeconds(timeLimit),
    } satisfies HoustonDatabaseReclaimResult;
  }).pipe(
    Effect.mapError((cause) =>
      isReclaimError(cause)
        ? cause
        : new HoustonDatabaseReclaimError({
            kind: "failed",
            message: `Reclaiming database space failed: ${cause instanceof Error ? cause.message : String(cause)}`,
          }),
    ),
    Effect.provideService(FileSystem.FileSystem, fs),
    Effect.provideService(Path.Path, path),
    Effect.withSpan("DatabaseStorage.reclaimNow"),
  );

  // Even a pass that deletes nothing scans the event store. Persist completion
  // so restarting does not trigger another scan before the six-hour interval.
  const compactedAtPath = path.join(path.dirname(config.dbPath), "compacted-at");
  const compact = Effect.gen(function* () {
    let sliceStarted = yield* Clock.monotonicTimeNanos;
    const betweenPages = Effect.gen(function* () {
      const elapsed = (yield* Clock.monotonicTimeNanos) - sliceStarted;
      if (elapsed < 25_000_000n) return;
      // Keep background maintenance at 10% duty, including pages that exceed the budget.
      yield* Effect.sleep((Number(elapsed) / 1_000_000) * 9);
      sliceStarted = yield* Clock.monotonicTimeNanos;
    });
    const result = yield* maintenance.pruneEventStore(betweenPages);
    yield* mergeMessageSearch(sql, {
      maxSteps: SEARCH_MERGE_STEPS_PER_PASS,
      betweenSteps: betweenPages,
    }).pipe(
      Effect.catch((cause) => Effect.logWarning("Message search index merge failed", { cause })),
    );
    const completedAt = yield* Clock.currentTimeMillis;
    yield* fs.writeFileString(compactedAtPath, String(completedAt)).pipe(Effect.ignore);
    if (result.deletedEventCount > 0 || result.deletedReceiptCount > 0) {
      yield* Effect.logInfo("Compacted orchestration history", result);
    }
  }).pipe(
    Effect.catch((cause) =>
      Effect.logWarning("Orchestration history compaction failed", { cause }),
    ),
  );
  const lastCompactedAt = yield* fs.readFileString(compactedAtPath).pipe(
    Effect.map(Number),
    Effect.orElseSucceed(() => Number.NaN),
  );
  const intervalMs = Duration.toMillis(COMPACTION_INTERVAL);
  const untilDueMs = Number.isFinite(lastCompactedAt)
    ? lastCompactedAt + intervalMs - (yield* Clock.currentTimeMillis)
    : 0;
  const firstCompactionDelay = Duration.millis(
    Math.min(intervalMs, Math.max(Duration.toMillis(Duration.minutes(1)), untilDueMs)),
  );

  yield* forkParked(
    Effect.sleep(firstCompactionDelay).pipe(
      Effect.andThen(
        compact.pipe(
          Effect.andThen(publishStatus),
          Effect.repeat(Schedule.spaced(COMPACTION_INTERVAL)),
        ),
      ),
    ),
  );
  yield* forkParked(
    publishStatus.pipe(
      Effect.andThen(Effect.sleep("1 minute")),
      Effect.andThen(
        reclaim.pipe(Effect.andThen(publishStatus), Effect.repeat(Schedule.spaced("1 minute"))),
      ),
    ),
  );

  return DatabaseStorage.of({ reclaim, status: SubscriptionRef.changes(statusRef), reclaimNow });
});

export const layer = Layer.effect(DatabaseStorage, make);
