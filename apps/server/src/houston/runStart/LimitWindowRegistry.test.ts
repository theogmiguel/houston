import { ProviderInstanceId } from "@houston-app/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import { accountLimitHold } from "./LimitsAdmission.ts";
import * as LimitWindowRegistryModule from "./LimitWindowRegistry.ts";
import { recordReportedWindows, testReleaseWindowToClear } from "./AccountLimitHoldWorker.ts";

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

  it.effect("serves reads from the cache, not a fresh SELECT", () =>
    Effect.gen(function* () {
      const registry = yield* LimitWindowRegistry;
      yield* registry.recordFailure({
        providerInstanceId,
        model: null,
        resetAt: "2026-01-01T01:00:00.000Z",
        now,
      });
      const sql = yield* SqlClient.SqlClient;
      yield* sql`DELETE FROM houston_limit_windows WHERE provider_instance_id = ${providerInstanceId}`;
      const records = yield* registry.read(providerInstanceId);
      assert.lengthOf(records, 1);
    }).pipe(Effect.provide(layerRegistry)),
  );

  it.effect("maps a provider-reported window id to the account scope", () =>
    Effect.gen(function* () {
      const registry = yield* LimitWindowRegistry;
      yield* recordReportedWindows({
        registry,
        providers: [
          {
            instanceId: providerInstanceId,
            models: [],
            usageLimits: {
              checkedAt: DateTime.formatIso(now),
              windows: [
                {
                  id: "five_hour",
                  kind: "session",
                  label: "Session",
                  usedPercent: 100,
                  resetsAt: "2026-01-01T01:00:00.000Z",
                },
              ],
            },
          },
        ] as never,
        now,
      });
      const records = yield* registry.read(providerInstanceId);
      assert.deepEqual(
        records.map((record) => record.scope),
        ["*"],
      );
      assert.isNotNull(
        accountLimitHold({
          origin: "automatic",
          providerInstanceId,
          model: "claude-sonnet",
          windows: records,
          holdUnlimitedThreads: true,
          nowMs: DateTime.toEpochMillis(now),
        }),
      );
    }).pipe(Effect.provide(layerRegistry)),
  );

  it.effect("holds only the model a model-only weekly window names", () =>
    Effect.gen(function* () {
      const registry = yield* LimitWindowRegistry;
      yield* recordReportedWindows({
        registry,
        providers: [
          {
            instanceId: providerInstanceId,
            models: [
              { slug: "claude-opus", name: "Opus" },
              { slug: "claude-sonnet", name: "Sonnet" },
            ],
            usageLimits: {
              checkedAt: DateTime.formatIso(now),
              windows: [
                {
                  id: "seven_day_opus",
                  kind: "weekly",
                  label: "Weekly · Opus",
                  usedPercent: 100,
                  resetsAt: "2026-01-01T01:00:00.000Z",
                },
              ],
            },
          },
        ] as never,
        now,
      });
      const records = yield* registry.read(providerInstanceId);
      assert.deepEqual(
        records.map((record) => record.scope),
        ["claude-opus"],
      );
      const hold = (model: string) =>
        accountLimitHold({
          origin: "automatic",
          providerInstanceId,
          model,
          windows: records,
          holdUnlimitedThreads: true,
          nowMs: DateTime.toEpochMillis(now),
        });
      assert.isNull(hold("claude-sonnet"));
      assert.isNotNull(hold("claude-opus"));
    }).pipe(Effect.provide(layerRegistry)),
  );

  it("clears only the untimed window a test release produced", () => {
    const windows = [
      {
        providerInstanceId,
        scope: "*",
        resetAt: "2026-01-01T01:00:00.000Z",
        observedAt: "2025-12-31T23:00:00.000Z",
        testAttempt: 0,
        nextTestAt: null,
      },
      {
        providerInstanceId,
        scope: "*",
        resetAt: null,
        observedAt: "2026-01-01T00:00:00.000Z",
        testAttempt: 1,
        nextTestAt: "2026-01-01T01:00:00.000Z",
      },
    ];
    const testReleases = new Map([
      [
        "run:test",
        {
          instanceId: providerInstanceId,
          scope: "*",
          observedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    ]);
    assert.equal(
      testReleaseWindowToClear({ runId: "run:test", testReleases, windows })?.resetAt,
      null,
    );
    assert.isNull(testReleaseWindowToClear({ runId: "run:other", testReleases, windows }));
    assert.isNull(
      testReleaseWindowToClear({
        runId: "run:test",
        testReleases: new Map([
          [
            "run:test",
            {
              instanceId: providerInstanceId,
              scope: "claude-opus",
              observedAt: "2026-01-01T00:00:00.000Z",
            },
          ],
        ]),
        windows,
      }),
    );
  });

  it("builds a distinct command id for each release occurrence", () => {
    const first = LimitWindowRegistryModule.limitReleaseCommandId({
      prefix: "limit-test-release",
      threadId: "thread:a",
      runId: "run:a",
      occurrence: "2026-01-01T00:00:00.000Z:1",
    });
    const second = LimitWindowRegistryModule.limitReleaseCommandId({
      prefix: "limit-test-release",
      threadId: "thread:a",
      runId: "run:a",
      occurrence: "2026-01-01T00:15:00.000Z:2",
    });
    assert.notEqual(first, second);
  });
});

describe("accountLimitSweepEnabled", () => {
  it("keeps the sweep when either hold setting is on", async () => {
    const { accountLimitSweepEnabled } = await import("./AccountLimitHoldWorker.ts");
    assert.isTrue(
      accountLimitSweepEnabled({ snoozeLimitedThreads: false, holdUnlimitedThreads: true }),
    );
    assert.isTrue(
      accountLimitSweepEnabled({ snoozeLimitedThreads: true, holdUnlimitedThreads: false }),
    );
    assert.isFalse(
      accountLimitSweepEnabled({ snoozeLimitedThreads: false, holdUnlimitedThreads: false }),
    );
  });
});
