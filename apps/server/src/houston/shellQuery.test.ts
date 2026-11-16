// The shell query reads archived state from the `archived_at` column, which every thread write path
// keeps equal to the payload's `archivedAt`; checked over a replayed Claude turn.
import { assert, describe, it } from "@effect/vitest";
import { EventId, type OrchestrationV2DomainEvent } from "@houston-app/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as Statement from "effect/sql/Statement";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import { replayedTurnEvents } from "./shellReads.testkit.ts";

type Compiled = readonly [string, ReadonlyArray<unknown>];

describe("shell query", () => {
  it.effect("filters archived threads on the archived_at column, which stays in sync", () =>
    Effect.gen(function* () {
      const events = yield* replayedTurnEvents;
      yield* Effect.gen(function* () {
        const projections = yield* ProjectionStore.ProjectionStoreV2;
        const sql = yield* SqlClient.SqlClient;
        const outOfSync = () =>
          sql<{ readonly count: number }>`
            SELECT COUNT(*) AS count FROM orchestration_v2_projection_threads
            WHERE (archived_at IS NULL) <> (json_extract(payload_json, '$.archivedAt') IS NULL)
          `.pipe(Effect.map((rows) => rows[0]!.count));
        const shellStatements: Array<Compiled> = [];
        const record: Statement.Transformer = (statement) => {
          const compiled = statement.compile();
          if (compiled[0].includes("AS activity_run_status")) shellStatements.push(compiled);
          return Effect.succeed(statement);
        };
        const shellIds = (location: "active" | "archive") =>
          projections.readShellSnapshot({ location }).pipe(
            Effect.flatten,
            Effect.map((snapshot) =>
              [...snapshot.threads, ...snapshot.archivedThreads].map((thread) => thread.id),
            ),
            Effect.provideService(Statement.CurrentTransformer, record),
          );

        for (const event of events) yield* projections.apply(event);
        assert.equal(yield* outOfSync(), 0);
        const created = events.find((event) => event.type === "thread.created")!;
        const threadId = created.threadId;
        assert.deepEqual(yield* shellIds("active"), [threadId]);

        // Archive, then run the two partial thread writes: a provider thread update and the
        // updatedAt stamp every other event applies.
        const at = DateTime.makeUnsafe(Date.parse("2030-01-01T00:00:00.000Z"));
        const thread = yield* projections.getThread(threadId);
        yield* projections.apply({
          ...created,
          id: EventId.make("event:shell-query:archived"),
          type: "thread.archived",
          occurredAt: at,
          payload: { ...thread, archivedAt: at, updatedAt: at },
        } as OrchestrationV2DomainEvent);
        const providerThread = events.findLast(
          (event) =>
            event.type === "provider-thread.updated" && event.payload.appThreadId === threadId,
        );
        const node = events.findLast((event) => event.type === "node.updated");
        assert.isDefined(providerThread);
        assert.isDefined(node);
        yield* projections.apply(providerThread);
        yield* projections.apply(node);
        assert.equal(yield* outOfSync(), 0);
        assert.deepEqual(yield* shellIds("active"), []);
        assert.deepEqual(yield* shellIds("archive"), [threadId]);
        assert.isNotNull((yield* projections.getThreadShell(threadId))?.archivedAt);

        const archived = yield* projections.getThread(threadId);
        yield* projections.apply({
          ...created,
          id: EventId.make("event:shell-query:unarchived"),
          type: "thread.unarchived",
          occurredAt: at,
          payload: { ...archived, archivedAt: null },
        } as OrchestrationV2DomainEvent);
        assert.equal(yield* outOfSync(), 0);
        assert.deepEqual(yield* shellIds("active"), [threadId]);

        assert.isNotEmpty(shellStatements);
        for (const [query] of shellStatements) {
          assert.match(query, /t\.archived_at IS (NOT )?NULL/);
          assert.notInclude(query, "'$.archivedAt'");
        }
        // The thread rows are scanned (no index on archived_at); every run join stays a key lookup.
        const [query, params] = shellStatements[0]!;
        const plan = yield* sql.unsafe<{ readonly detail: string }>(
          `EXPLAIN QUERY PLAN ${query}`,
          params,
        );
        const details = plan.map((row) => row.detail);
        assert.include(details, "SCAN t");
        // The silent-run check walks the live runs once for both activity columns: 3 walks, not 4.
        assert.lengthOf(
          details.filter((detail) => detail.startsWith("SEARCH prompt USING")),
          3,
        );
        for (const alias of ["active", "activity", "presented", "blocked"]) {
          assert.isTrue(
            details.some((detail) => detail.startsWith(`SEARCH ${alias} USING`)),
            `${alias} is looked up by key: ${details.join(" | ")}`,
          );
        }
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
