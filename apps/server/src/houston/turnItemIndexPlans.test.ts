// Item reads filtered by status or type name their partial index. SQLite plans without statistics,
// so it otherwise prefers the covering timeline index, which reads every item of the thread.
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as Statement from "effect/sql/Statement";

import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { replayedTurnEvents } from "./shellReads.testkit.ts";

const TIMELINE_INDEX = "houston_turn_items_timeline_idx";

const layer = Layer.fresh(
  ProjectionStore.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory)),
);

/** Runs `read`, then returns the plan lines of each statement it ran that mentions `marker`. */
const plansOf = <A, E, R>(marker: string, read: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const statements: Array<readonly [string, ReadonlyArray<unknown>]> = [];
    const record: Statement.Transformer = (statement) => {
      const compiled = statement.compile();
      if (compiled[0].includes(marker)) statements.push(compiled);
      return Effect.succeed(statement);
    };
    yield* read.pipe(Effect.provideService(Statement.CurrentTransformer, record));
    assert.isNotEmpty(statements, `a statement mentions ${marker}`);
    const plans: Array<ReadonlyArray<string>> = [];
    for (const [query, params] of statements) {
      const plan = yield* sql.unsafe<{ readonly detail: string }>(
        `EXPLAIN QUERY PLAN ${query}`,
        params,
      );
      plans.push(plan.map((row) => row.detail.trim()));
    }
    return plans;
  });

/** Each plan searches `alias` `count` times, each through an index that `index` matches. */
const assertSearches = (
  plans: ReadonlyArray<ReadonlyArray<string>>,
  alias: string,
  index: RegExp,
  count: number,
) => {
  for (const plan of plans) {
    const searches = plan.filter((detail) => detail.startsWith(`SEARCH ${alias} `));
    assert.lengthOf(searches, count, plan.join(" | "));
    for (const detail of searches) assert.match(detail, index, plan.join(" | "));
    for (const detail of plan) assert.notInclude(detail, TIMELINE_INDEX);
  }
};

const replayedThread = Effect.gen(function* () {
  const store = yield* ProjectionStore.ProjectionStoreV2;
  const events = yield* replayedTurnEvents;
  for (const event of events) yield* store.apply(event);
  const threadId = events.find((event) => event.type === "thread.created")?.threadId;
  assert.isDefined(threadId);
  return threadId;
});

describe("item reads filtered by status or type use their partial index", () => {
  it.effect("the active shell index looks for pending items in the shell pending index", () =>
    Effect.gen(function* () {
      yield* replayedThread;
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const plans = yield* plansOf("AS may_be_live", store.listActiveShellIndex());
      assertSearches(
        plans,
        "item",
        / INDEX orchestration_v2_projection_turn_items_shell_pending_idx /,
        1,
      );
    }).pipe(Effect.provide(layer)),
  );

  it.effect("runtime recovery reads only active items", () =>
    Effect.gen(function* () {
      const threadId = yield* replayedThread;
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const plans = yield* plansOf("AS section", store.getRuntimeRecoveryProjection(threadId));
      // runs, nodes (2), subagents, provider threads (2) and turn items, which reads in ordinal order.
      assertSearches(
        plans,
        "item",
        / INDEX orchestration_v2_projection_turn_items_active_(run|ordinal)_idx /,
        7,
      );
    }).pipe(Effect.provide(layer)),
  );

  it.effect("shell rows and settlement candidates look up failed compactions by run", () =>
    Effect.gen(function* () {
      const threadId = yield* replayedThread;
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const index =
        / INDEX orchestration_v2_projection_turn_items_thread_run_idx \(thread_id=\? AND run_id=\?\)/;
      assertSearches(
        yield* plansOf("AS activity_run_status", store.getThreadShell(threadId)),
        "compaction",
        index,
        3,
      );
      assertSearches(
        yield* plansOf("AS latest_user_message_at", store.getSettlementCandidates()),
        "compaction",
        index,
        1,
      );
    }).pipe(Effect.provide(layer)),
  );
});
