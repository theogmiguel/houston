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

  it.effect("keeps the refs the picker kept from the full list, on a composed fixture", () =>
    Effect.gen(function* () {
      const events = yield* replayedTurnEvents;
      yield* Effect.gen(function* () {
        const projections = yield* ProjectionStore.ProjectionStoreV2;
        const sql = yield* SqlClient.SqlClient;
        for (const event of events) yield* projections.apply(event);
        const source = events.find((event) => event.type === "thread.created")!.threadId;
        const sourceProvider = (yield* projections.getThread(source)).activeProviderThreadId!;

        // Composed fixture: rows copied from the replayed thread with ids rewritten, as the
        // projections write them. "many" has an older and a newer active provider thread and
        // points at the newer; "none" has a provider thread but no active pointer; "foreign"
        // points at many's older provider thread.
        const copyThread = (id: string, active: string | null) =>
          Effect.gen(function* () {
            yield* sql`DROP TABLE IF EXISTS temp.copied_thread`;
            yield* sql`CREATE TEMP TABLE copied_thread AS
              SELECT * FROM orchestration_v2_projection_threads WHERE thread_id = ${source}`;
            yield* sql`UPDATE temp.copied_thread SET thread_id = ${id},
              active_provider_thread_id = ${active},
              payload_json = json_set(payload_json, '$.id', ${id}, '$.activeProviderThreadId', ${active})`;
            yield* sql`INSERT INTO orchestration_v2_projection_threads SELECT * FROM temp.copied_thread`;
          });
        const copyProvider = (id: string, threadId: string, updatedAt: string) =>
          Effect.gen(function* () {
            yield* sql`DROP TABLE IF EXISTS temp.copied_provider`;
            yield* sql`CREATE TEMP TABLE copied_provider AS
              SELECT * FROM orchestration_v2_projection_provider_threads
              WHERE provider_thread_id = ${sourceProvider}`;
            yield* sql`UPDATE temp.copied_provider SET provider_thread_id = ${id},
              thread_id = ${threadId}, status = 'active', updated_at = ${updatedAt},
              payload_json = json_set(payload_json, '$.id', ${id}, '$.appThreadId', ${threadId},
                '$.status', 'active', '$.updatedAt', ${updatedAt})`;
            yield* sql`INSERT INTO orchestration_v2_projection_provider_threads
              SELECT * FROM temp.copied_provider`;
          });
        yield* copyThread("thread:many", "provider:many:newer");
        yield* copyProvider("provider:many:older", "thread:many", "2026-01-01T00:00:00.000Z");
        yield* copyProvider("provider:many:newer", "thread:many", "2026-01-02T00:00:00.000Z");
        yield* copyThread("thread:none", null);
        yield* copyProvider("provider:none", "thread:none", "2026-01-01T00:00:00.000Z");
        yield* copyThread("thread:foreign", "provider:many:older");

        const listed = [source, "thread:many", "thread:none", "thread:foreign"].map((id) =>
          ThreadId.make(id),
        );
        // The picker's rule over the previous full list: a ref counts only when its own thread
        // is listed and that thread's active pointer names it.
        const threads = yield* Effect.forEach(listed, (id) => projections.getThread(id));
        const before = yield* sql<{ readonly payload_json: string }>`
          SELECT payload_json FROM orchestration_v2_projection_provider_threads
          WHERE thread_id IS NOT NULL
        `;
        const kept = (
          refs: ReadonlyArray<{ readonly id: string; readonly appThreadId: string | null }>,
        ) =>
          refs
            .filter((ref) =>
              threads.some((t) => t.id === ref.appThreadId && t.activeProviderThreadId === ref.id),
            )
            .map((ref) => [ref.id, ref.appThreadId])
            .toSorted();
        const previous = kept(
          before.map((row) => JSON.parse(row.payload_json) as { id: string; appThreadId: string }),
        );
        assert.deepEqual(
          previous,
          [
            ["provider:many:newer", "thread:many"],
            [sourceProvider, source],
          ].toSorted(),
        );
        const refs = yield* projections.listProviderThreadRefs(listed);
        assert.deepEqual(refs.map((ref) => [ref.id, ref.appThreadId]).toSorted(), previous);
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
