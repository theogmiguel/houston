import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@houston-app/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../persistence/Migrations.ts";
import { mergeMessageSearch } from "./messageSearchIndex.ts";

const layer = it.layer(NodeSqliteClient.layer({ filename: ":memory:" }));

// Messages finish one per transaction, so each adds its own index segment.
const finishMessages = (sql: SqlClient.SqlClient, from: number, count: number) =>
  Effect.forEach(
    Array.from({ length: count }, (_, index) => from + index),
    (n) => sql`
      INSERT INTO orchestration_v2_projection_messages (
        message_id, thread_id, run_id, node_id, role, streaming, created_at, updated_at, payload_json
      )
      VALUES (
        ${`message-${n}`}, 'thread-1', NULL, NULL, 'assistant', 0,
        '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z',
        ${JSON.stringify({ text: `needle ${n} ${n % 3 === 0 ? "haystack" : "straw"}` })}
      )
    `,
    { discard: true },
  );

// FTS5 keys each segment page by (segment id << 37) + page; ids from 2^16 hold tombstones.
const segments = (sql: SqlClient.SqlClient) =>
  sql<{ readonly n: number }>`
    SELECT COUNT(DISTINCT id >> 37) AS n FROM orchestration_v2_message_search_data
    WHERE id >= (1 << 37) AND (id >> 37) < 65536
  `.pipe(Effect.map((rows) => rows[0]?.n ?? 0));

const matches = (sql: SqlClient.SqlClient, query: string) =>
  sql<{ readonly rowid: number }>`
    SELECT rowid FROM orchestration_v2_message_search
    WHERE orchestration_v2_message_search MATCH ${query} ORDER BY rowid
  `.pipe(Effect.map((rows) => rows.map((row) => row.rowid)));

layer("mergeMessageSearch", (it) => {
  it.effect("merges segments in bounded steps and keeps every result", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations();
      yield* finishMessages(sql, 0, 120);
      yield* sql`DELETE FROM orchestration_v2_projection_messages WHERE message_id = 'message-9'`;
      const before = yield* segments(sql);
      const haystack = yield* matches(sql, '"haystack"');
      const needles = yield* matches(sql, '"needle"');
      assert.isAbove(before, 4);

      assert.equal(yield* mergeMessageSearch(sql, { maxSteps: 1, betweenSteps: Effect.void }), 1);
      let paced = 0;
      const steps = yield* mergeMessageSearch(sql, {
        maxSteps: 1_000,
        betweenSteps: Effect.sync(() => paced++),
      });
      assert.equal(paced, steps);
      assert.isBelow(yield* segments(sql), before);
      assert.deepEqual(yield* matches(sql, '"haystack"'), haystack);
      assert.deepEqual(yield* matches(sql, '"needle"'), needles);
      assert.equal(needles.length, 119);

      // Nothing is left until messages arrive again.
      assert.equal(
        yield* mergeMessageSearch(sql, { maxSteps: 1_000, betweenSteps: Effect.void }),
        0,
      );
      yield* finishMessages(sql, 120, 4);
      assert.isAbove(
        yield* mergeMessageSearch(sql, { maxSteps: 1_000, betweenSteps: Effect.void }),
        0,
      );
      assert.equal((yield* matches(sql, '"needle"')).length, 123);
    }),
  );

  it.effect("does nothing without a search index", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`DROP TABLE IF EXISTS orchestration_v2_message_search`;
      assert.equal(yield* mergeMessageSearch(sql, { maxSteps: 10, betweenSteps: Effect.void }), 0);
    }),
  );
});
