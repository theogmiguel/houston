// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalDateInEffect:off effectFnOpportunity:off preferSchemaOverJson:off - host-side benchmark builder writing temp files and a JSON manifest.
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeSqliteClient from "@houston-app/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as TaskStore from "../../src/houston/tasks/TaskStore.ts";
import * as EffectOutbox from "../../src/orchestration-v2/EffectOutbox.ts";
import * as EventSink from "../../src/orchestration-v2/EventSink.ts";
import * as EventStore from "../../src/orchestration-v2/EventStore.ts";
import { rebuildMessageSearch } from "../../src/orchestration-v2/messageSearchIndex.ts";
import * as ProjectionMaintenance from "../../src/orchestration-v2/ProjectionMaintenance.ts";
import * as ProjectionStore from "../../src/orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../../src/orchestration-v2/ProjectStore.ts";
import * as ThreadSearch from "../../src/orchestration-v2/ThreadSearch.ts";
import { EVENT_LOG_PRUNE_MARK } from "../../src/persistence/OrchestrationEventStore.ts";
import * as SqlitePersistence from "../../src/persistence/Sqlite.ts";
import { cloneUnits } from "./clone.ts";
import {
  DEEP_THREAD_BASE_RUNS,
  HEAVY_USER_UNIT,
  writeDeepThread,
  writeUnit,
  type ThreadProbe,
  type UnitManifest,
  type UnitShape,
} from "./fixture.ts";

/** Bump when the generator's output changes, so cached databases are rebuilt. */
export const GENERATOR_VERSION = 2;

export interface DatabaseManifest {
  readonly generatorVersion: number;
  readonly seed: number;
  readonly scale: number;
  readonly dbPath: string;
  readonly unit: UnitManifest;
  readonly deep: ThreadProbe;
  readonly units: number;
  readonly rowCounts: Readonly<Record<string, number>>;
  readonly totalRows: number;
  readonly fileBytes: number;
  readonly buildSeconds: number;
}

/** The production SQLite layer plus the stores; `capture` uses one main-thread connection. */
export function storesLayer(dbPath: string, options: { readonly capture?: boolean } = {}) {
  const sql = options.capture
    ? NodeSqliteClient.layer({ filename: dbPath })
    : SqlitePersistence.layerFromPath(dbPath).pipe(Layer.provide(NodeServices.layer));
  const stores = Layer.mergeAll(
    ProjectionStore.layer,
    EventStore.layer,
    ProjectStore.layer,
    TaskStore.layer,
    EffectOutbox.layer,
    ProjectionMaintenance.layer,
    ThreadSearch.layer,
  ).pipe(Layer.provideMerge(sql));
  return EventSink.layer.pipe(Layer.provideMerge(stores));
}

const countRows = Effect.fn("DbLoad.countRows")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const tables = yield* sql<{ readonly name: string }>`
    SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
      AND name NOT LIKE 'orchestration_v2_message_search_%'
  `;
  const counts: Record<string, number> = {};
  for (const { name } of tables) {
    const rows = yield* sql<{ readonly n: number }>`SELECT COUNT(*) AS n FROM ${sql(name)}`;
    const n = rows[0]?.n ?? 0;
    if (n > 0) counts[name] = n;
  }
  return counts;
});

// Effects the generator enqueued ran long ago in a real history; mark them as the worker does.
const settleOutbox = Effect.fn("DbLoad.settleOutbox")(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    UPDATE orchestration_v2_effect_outbox
    SET status = 'succeeded', attempt_count = 1, completed_at = updated_at
    WHERE status = 'pending'
  `;
});

// A long-lived install keeps only the event log's retained rows (stream heads, thread.created,
// running run.updated). Run the real daily prune once, with its mark backdated past the
// retention window, so the generated log has that shape.
const pruneEventLog = Effect.fn("DbLoad.pruneEventLog")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const maintenance = yield* ProjectionMaintenance.ProjectionMaintenanceV2;
  const head = (yield* sql<{ readonly head: number }>`
    SELECT COALESCE(MAX(sequence), 0) AS head FROM orchestration_events
  `)[0]!.head;
  const backdated = new Date(Date.now() - 2 * 86_400_000).toISOString();
  yield* sql`
    INSERT INTO orchestration_v2_projection_metadata (projection_name, schema_version, last_sequence, updated_at)
    VALUES ('thread-projections', ${ProjectionStore.ORCHESTRATION_V2_PROJECTION_SCHEMA_VERSION}, ${head}, ${backdated}),
      (${EVENT_LOG_PRUNE_MARK}, ${ProjectionStore.ORCHESTRATION_V2_PROJECTION_SCHEMA_VERSION}, ${head}, ${backdated})
    ON CONFLICT(projection_name) DO UPDATE SET last_sequence = excluded.last_sequence, updated_at = excluded.updated_at
  `;
  yield* sql`UPDATE houston_task_runs_cursor SET sequence = ${head} WHERE id = 1`;
  return yield* maintenance.pruneEventStore();
});

export const buildDatabase = (input: {
  readonly dir: string;
  readonly scale: number;
  readonly seed: number;
  readonly shape?: UnitShape;
  readonly log: (line: string) => void;
}) => {
  const dbPath = NodePath.join(input.dir, "state.sqlite");
  NodeFS.rmSync(input.dir, { recursive: true, force: true });
  NodeFS.mkdirSync(input.dir, { recursive: true });
  const started = performance.now();
  const program = Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const unit = yield* writeUnit({
      seed: input.seed,
      shape: input.shape ?? HEAVY_USER_UNIT,
      onProgress: (done, total) => {
        if (done % 25 === 0 || done === total) input.log(`unit: ${done}/${total} threads`);
      },
    });
    yield* settleOutbox();
    const pruned = yield* pruneEventLog();
    input.log(`event log pruned: ${pruned.deletedEventCount} events`);
    yield* cloneUnits(input.scale, (done, total) => {
      if (done % Math.max(1, Math.round(total / 10)) === 0 || done === total) {
        input.log(`clone: ${done}/${total} units`);
      }
    });
    const deepRuns = DEEP_THREAD_BASE_RUNS * input.scale;
    input.log(`deep thread: ${deepRuns} turns`);
    const deep = yield* writeDeepThread({
      seed: input.seed,
      runs: deepRuns,
      projectId: unit.projectIds[0]!,
    });
    yield* settleOutbox();
    yield* sql`
      UPDATE orchestration_v2_projection_metadata
      SET last_sequence = (SELECT MAX(sequence) FROM orchestration_events)
      WHERE projection_name = 'thread-projections'
    `;
    input.log("rebuilding message search");
    yield* rebuildMessageSearch(sql);
    yield* sql`PRAGMA wal_checkpoint(TRUNCATE)`;
    const rowCounts = yield* countRows();
    return { unit, deep, rowCounts };
  });
  return program.pipe(
    Effect.provide(storesLayer(dbPath)),
    Effect.map(({ unit, deep, rowCounts }): DatabaseManifest => ({
      generatorVersion: GENERATOR_VERSION,
      seed: input.seed,
      scale: input.scale,
      dbPath,
      unit,
      deep,
      units: input.scale,
      rowCounts,
      totalRows: Object.values(rowCounts).reduce((total, n) => total + n, 0),
      fileBytes: NodeFS.statSync(dbPath).size,
      buildSeconds: (performance.now() - started) / 1000,
    })),
    Effect.tap((manifest) =>
      Effect.sync(() =>
        NodeFS.writeFileSync(
          NodePath.join(input.dir, "manifest.json"),
          JSON.stringify(manifest, null, 1),
        ),
      ),
    ),
  );
};
