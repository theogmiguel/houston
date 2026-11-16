// Projection apply for the per-event hot cases never parses the payload it has just encoded.
import { assert, describe, it, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import { replayedTurnEvents } from "./shellReads.testkit.ts";

const HOT = new Set(["turn-item.updated", "message.updated", "checkpoint.captured"]);

describe("projection apply", () => {
  it.effect("stores turn items, messages and checkpoints without parsing their payloads", () =>
    Effect.gen(function* () {
      const events = yield* replayedTurnEvents;
      yield* Effect.gen(function* () {
        const projections = yield* ProjectionStore.ProjectionStoreV2;
        const sql = yield* SqlClient.SqlClient;
        const parse = vi.spyOn(JSON, "parse");
        const parsesByType = new Map<string, number>();
        try {
          for (const event of events) {
            parse.mockClear();
            yield* projections.apply(event);
            if (HOT.has(event.type)) {
              parsesByType.set(
                event.type,
                (parsesByType.get(event.type) ?? 0) + parse.mock.calls.length,
              );
            }
          }
        } finally {
          parse.mockRestore();
        }
        assert.deepEqual(Object.fromEntries(parsesByType), {
          "turn-item.updated": 0,
          "message.updated": 0,
          "checkpoint.captured": 0,
        });
        // The timestamp columns still hold the payload's own encoded values.
        for (const [table, column, field] of [
          ["orchestration_v2_projection_turn_items", "updated_at", "updatedAt"],
          ["orchestration_v2_projection_messages", "created_at", "createdAt"],
          ["orchestration_v2_projection_messages", "updated_at", "updatedAt"],
          ["orchestration_v2_projection_checkpoints", "captured_at", "capturedAt"],
        ] as const) {
          const rows = yield* sql.unsafe<{ readonly total: number; readonly differing: number }>(
            `SELECT COUNT(*) AS total,
              SUM(${column} IS NOT json_extract(payload_json, '$.${field}')) AS differing
            FROM ${table}`,
          );
          assert.isAbove(rows[0]!.total, 0, table);
          assert.equal(rows[0]!.differing, 0, `${table}.${column}`);
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
