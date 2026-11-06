// The resume picker resolves native sessions through each listed thread's active provider thread,
// read by key, never every provider thread of every thread.
import { assert, describe, it } from "@effect/vitest";
import { ThreadId } from "@houston-app/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as Statement from "effect/sql/Statement";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import { replayedTurnEvents } from "./shellReads.testkit.ts";

type Compiled = readonly [string, ReadonlyArray<unknown>];

describe("provider thread refs", () => {
  it.effect("returns the listed threads' active provider threads, looked up by key", () =>
    Effect.gen(function* () {
      const events = yield* replayedTurnEvents;
      yield* Effect.gen(function* () {
        const projections = yield* ProjectionStore.ProjectionStoreV2;
        const sql = yield* SqlClient.SqlClient;
        for (const event of events) yield* projections.apply(event);
        const threadId = events.find((event) => event.type === "thread.created")!.threadId;
        const thread = yield* projections.getThread(threadId);
        assert.isNotNull(thread.activeProviderThreadId);

        const statements: Array<Compiled> = [];
        const record: Statement.Transformer = (statement) => {
          const compiled = statement.compile();
          if (compiled[0].includes("orchestration_v2_projection_provider_threads"))
            statements.push(compiled);
          return Effect.succeed(statement);
        };
        const refs = yield* projections
          .listProviderThreadRefs([threadId, ThreadId.make("thread:missing")])
          .pipe(Effect.provideService(Statement.CurrentTransformer, record));
        assert.deepEqual(
          refs.map((ref) => [ref.id, ref.appThreadId]),
          [[thread.activeProviderThreadId, threadId]],
        );
        assert.deepEqual(yield* projections.listProviderThreadRefs([]), []);

        assert.lengthOf(statements, 1);
        const [query, params] = statements[0]!;
        const plan = yield* sql.unsafe<{ readonly detail: string }>(
          `EXPLAIN QUERY PLAN ${query}`,
          params,
        );
        const details = plan.map((row) => row.detail);
        for (const detail of details) {
          assert.notMatch(detail, /^SCAN (provider|thread)\b/);
        }
        assert.isTrue(
          details.some((detail) => /^SEARCH provider USING INDEX sqlite_autoindex/.test(detail)),
          details.join(" | "),
        );
      }).pipe(
        Effect.provide(
          Layer.fresh(
            ProjectionStore.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory)),
          ),
        ),
      );
    }),
  );
});
