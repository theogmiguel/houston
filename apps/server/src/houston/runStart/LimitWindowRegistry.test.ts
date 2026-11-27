import { ProviderInstanceId } from "@houston-app/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import * as LimitWindowRegistryModule from "./LimitWindowRegistry.ts";

const { LimitWindowRegistry } = LimitWindowRegistryModule;

const providerInstanceId = ProviderInstanceId.make("codex");
const now = DateTime.makeUnsafe("2026-01-01T00:00:00.000Z");

const layerRegistry = LimitWindowRegistryModule.layer.pipe(
  Layer.provideMerge(Layer.fresh(SqlitePersistence.layerMemory)),
);

describe("LimitWindowRegistry", () => {
  it.effect("persists a limit failure and reads it back", () =>
    Effect.gen(function* () {
      const registry = yield* LimitWindowRegistry;
      yield* registry.recordFailure({
        providerInstanceId,
        model: null,
        resetAt: "2026-01-01T01:00:00.000Z",
        now,
      });
      const records = yield* registry.read(providerInstanceId);
      assert.equal(records.length, 1);
      assert.equal(records[0]?.scope, "*");
      assert.equal(records[0]?.resetAt, "2026-01-01T01:00:00.000Z");

      const sql = yield* SqlClient.SqlClient;
      const rows = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM houston_limit_windows
        WHERE provider_instance_id = ${providerInstanceId}
      `;
      assert.equal(rows[0]?.count, 1);
    }).pipe(Effect.provide(layerRegistry)),
  );

  it.effect("clears a window when a reported reading drops below 100%", () =>
    Effect.gen(function* () {
      const registry = yield* LimitWindowRegistry;
      yield* registry.recordReported({
        providerInstanceId,
        scope: "session",
        resetAt: "2026-01-01T01:00:00.000Z",
        usedPercent: 100,
        now,
      });
      assert.equal((yield* registry.read(providerInstanceId)).length, 1);
      yield* registry.recordReported({
        providerInstanceId,
        scope: "session",
        resetAt: "2026-01-01T01:00:00.000Z",
        usedPercent: 40,
        now,
      });
      assert.equal((yield* registry.read(providerInstanceId)).length, 0);
    }).pipe(Effect.provide(layerRegistry)),
  );

  it.effect("counts test releases", () =>
    Effect.gen(function* () {
      const registry = yield* LimitWindowRegistry;
      yield* registry.recordFailure({ providerInstanceId, model: null, resetAt: null, now });
      const first = yield* registry.read(providerInstanceId);
      assert.equal(first[0]?.testAttempt, 0);
      assert.isNotNull(first[0]?.nextTestAt);
      yield* registry.recordTestAttempt({ providerInstanceId, scope: "*", now });
      const second = yield* registry.read(providerInstanceId);
      assert.equal(second[0]?.testAttempt, 1);
      yield* registry.clear(providerInstanceId);
      assert.equal((yield* registry.read(providerInstanceId)).length, 0);
    }).pipe(Effect.provide(layerRegistry)),
  );
});
