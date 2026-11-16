// The timeline page over a replayed two-turn conversation: the same rows as the full projection's
// visible items, read from the covering timeline index without run, attempt or item payloads.
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as Tracer from "effect/Tracer";

import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { replayedTurnEvents } from "./shellReads.testkit.ts";

const traceStatements = () => {
  const statements: Array<string> = [];
  const tracer = Tracer.make({
    span(options) {
      const span = new Tracer.NativeSpan(options);
      const end = span.end.bind(span);
      span.end = (endTime, exit) => {
        end(endTime, exit);
        const query = span.attributes.get("db.query.text");
        if (typeof query === "string") statements.push(query);
      };
      return span;
    },
  });
  return { statements, tracer };
};

const storeLayer = Layer.fresh(
  ProjectionStore.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory)),
);

describe("the timeline page", () => {
  it.effect("pages the visible items as the full projection lists them", () =>
    Effect.gen(function* () {
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const events = yield* replayedTurnEvents;
      for (const event of events) yield* store.apply(event);
      const threadId = events.find((event) => event.type === "thread.created")?.threadId;
      assert.isDefined(threadId);
      const visible = (yield* store.getThreadProjection(threadId)).visibleTurnItems;
      assert.isAbove(visible.length, 4);
      for (const afterPosition of [undefined, 0, 2, visible.length - 2, visible.length]) {
        const page = yield* store.getTimelinePage(threadId, {
          view: "activity",
          limit: 3,
          ...(afterPosition === undefined ? {} : { afterPosition }),
        });
        const start = afterPosition === undefined ? 0 : afterPosition + 1;
        assert.deepEqual(page.items, visible.slice(start, start + 3), `after ${afterPosition}`);
        assert.strictEqual(page.totalItems, visible.length);
        assert.strictEqual(page.hasMore, start + 3 < visible.length);
      }
      const messages = yield* store.getTimelinePage(threadId, { view: "messages", limit: 50 });
      assert.deepEqual(
        messages.items,
        visible.filter((row) =>
          ["user_message", "assistant_message", "proposed_plan"].includes(row.item.type),
        ),
      );
    }).pipe(Effect.provide(storeLayer)),
  );

  it.effect("reads the item index from the covering index and no run or attempt payload", () =>
    Effect.gen(function* () {
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const sql = yield* SqlClient.SqlClient;
      const events = yield* replayedTurnEvents;
      for (const event of events) yield* store.apply(event);
      const threadId = events.find((event) => event.type === "thread.created")?.threadId;
      assert.isDefined(threadId);
      const { statements, tracer } = traceStatements();
      const page = yield* store
        .getTimelinePage(threadId, { view: "messages", limit: 50 })
        .pipe(Effect.withTracer(tracer));
      // The planner picks the index by itself; the query does not name it.
      const itemIndex = statements.filter((statement) =>
        statement.includes("SELECT item.turn_item_id, item.run_id"),
      );
      assert.lengthOf(itemIndex, 1);
      const plan = (yield* sql.unsafe<{ readonly detail: string }>(
        `EXPLAIN QUERY PLAN ${itemIndex[0]!}`,
        [threadId],
      )).map((row) => row.detail);
      assert.deepEqual(plan, [
        "SEARCH item USING COVERING INDEX houston_turn_items_timeline_idx (thread_id=?)",
      ]);
      for (const statement of statements) {
        assert.notMatch(
          statement,
          /payload_json\s+FROM\s+orchestration_v2_projection_(runs|run_attempts)\b/,
        );
      }
      // Without the index (a table rebuild before the repair runs) the page is slower, not failed.
      yield* sql`DROP INDEX houston_turn_items_timeline_idx`;
      assert.deepEqual(
        yield* store.getTimelinePage(threadId, { view: "messages", limit: 50 }),
        page,
      );
    }).pipe(Effect.provide(storeLayer)),
  );
});
