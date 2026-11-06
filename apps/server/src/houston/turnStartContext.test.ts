// The turn-start context over a replayed two-turn conversation: its statements find /compact and
// /goal turns through the user-message read model and read attempts and provider turns in index order.
import { assert, describe, it } from "@effect/vitest";
import { RunId } from "@houston-app/contracts";
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

describe("the turn-start context", () => {
  it.effect("reads command messages and ordered history by index", () =>
    Effect.gen(function* () {
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const sql = yield* SqlClient.SqlClient;
      const events = yield* replayedTurnEvents;
      for (const event of events) yield* store.apply(event);
      const run = events.findLast((event) => event.type === "run.created");
      assert.isDefined(run);
      const runId = RunId.make((run.payload as { readonly id: string }).id);
      const { statements, tracer } = traceStatements();
      const context = yield* store
        .getTurnStartContext(run.threadId, runId)
        .pipe(Effect.withTracer(tracer));
      assert.isTrue(context.runs.some((candidate) => candidate.id === runId));
      const plan = (fragment: string) =>
        Effect.gen(function* () {
          const statement = statements.find((candidate) => candidate.includes(fragment));
          assert.isDefined(statement, fragment);
          return (yield* sql.unsafe<{ readonly detail: string }>(
            `EXPLAIN QUERY PLAN ${statement}`,
          )).map((row) => row.detail);
        });
      const messages = yield* plan("FROM houston_user_messages");
      assert.include(messages.join("\n"), "houston_user_messages_command_idx");
      assert.notInclude(messages.join("\n"), "SCAN orchestration_v2_projection_messages");
      for (const fragment of [
        "FROM orchestration_v2_projection_run_attempts",
        "FROM orchestration_v2_projection_provider_turns",
      ]) {
        assert.notInclude((yield* plan(fragment)).join("\n"), "TEMP B-TREE", fragment);
      }
    }).pipe(
      Effect.provide(
        Layer.fresh(ProjectionStore.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory))),
      ),
    ),
  );
});
