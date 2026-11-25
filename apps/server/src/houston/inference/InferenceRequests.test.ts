import { expect, it } from "@effect/vitest";
import { RunId, ThreadId } from "@houston-app/contracts";
import { InferenceServerId } from "@houston-app/contracts/houston/inference";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import * as InferenceRequests from "./InferenceRequests.ts";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";

const rtx = InferenceServerId.make("rtx");
const thread = ThreadId.make("thread-1");
const HOUR = 60 * 60 * 1_000;
const DAY = 24 * HOUR;

const layer = InferenceRequests.layer.pipe(
  Layer.provideMerge(Layer.fresh(SqlitePersistence.layerMemory)),
);

const row = (
  index: number,
  overrides: Partial<InferenceRequests.InferenceRequestRecord> = {},
): InferenceRequests.InferenceRequestRecord => ({
  requestId: `request-${index}`,
  serverId: rtx,
  model: "GLM-5.3-Flash",
  threadId: thread,
  runId: RunId.make("run-1"),
  parentRunId: null,
  purpose: "interactive",
  status: "completed",
  fallbackFrom: null,
  staticPrefixHash: null,
  receivedAt: 0,
  queueWaitMs: null,
  ttftMs: null,
  decodeMs: null,
  durationMs: null,
  promptTokens: null,
  cachedPromptTokens: null,
  completionTokens: null,
  failureCause: null,
  upstreamHttpStatus: null,
  reasoningTokens: null,
  ...overrides,
});

it.effect("aggregates by server, model, and purpose, excluding missing measurements", () =>
  Effect.gen(function* () {
    const log = yield* InferenceRequests.InferenceRequestLog;
    yield* TestClock.adjust(10 * DAY);
    const now = 10 * DAY;
    yield* log.record(
      row(1, {
        receivedAt: now - HOUR,
        queueWaitMs: 10,
        ttftMs: 100,
        decodeMs: 1_000,
        durationMs: 1_200,
        promptTokens: 50,
        cachedPromptTokens: 40,
        completionTokens: 20,
      }),
    );
    yield* log.record(
      row(2, {
        receivedAt: now - 2 * HOUR,
        queueWaitMs: 30,
        ttftMs: 300,
        decodeMs: 2_000,
        promptTokens: 10,
        completionTokens: 10,
      }),
    );
    yield* log.record(
      row(3, {
        receivedAt: now - 3 * HOUR,
        status: "failed",
        queueWaitMs: 20,
        failureCause: "watchdog-loop",
      }),
    );
    yield* log.record(row(6, { receivedAt: now - 5 * HOUR, status: "rejected" }));
    yield* log.record(row(4, { receivedAt: now - 2 * DAY, purpose: "background", ttftMs: 5 }));
    yield* log.record(row(5, { receivedAt: now - 8 * DAY }));

    const day = yield* log.summarize("24h");
    expect(day.window).toBe("24h");
    expect(day.rows).toEqual([
      {
        serverId: rtx,
        model: "GLM-5.3-Flash",
        purpose: "interactive",
        requests: 4,
        failed: 2,
        promptTokens: 60,
        cachedPromptTokens: 40,
        promptTokensWithCacheData: 50,
        completionTokens: 30,
        lastFailure: {
          status: "failed",
          at: "1970-01-10T21:00:00.000Z",
          cause: "watchdog-loop",
          advice: "The model repeated itself; try a different model or reasoning profile.",
        },
        queueWaitMs: { n: 3, p50: 20, p95: 30 },
        ttftMs: { n: 2, p50: 100, p95: 300 },
        decodeTokensPerSecond: { n: 2, p50: 5, p95: 20 },
      },
    ]);
    const week = yield* log.summarize("7d");
    expect(week.rows.map((entry) => [entry.purpose, entry.requests])).toEqual([
      ["background", 1],
      ["interactive", 4],
    ]);
    expect(week.rows[0]?.ttftMs).toEqual({ n: 1, p50: 5, p95: 5 });
    expect(week.rows[0]?.queueWaitMs).toEqual({ n: 0, p50: null, p95: null });
  }).pipe(Effect.provide(layer)),
);

it.effect("returns a thread's latest completed request", () =>
  Effect.gen(function* () {
    const log = yield* InferenceRequests.InferenceRequestLog;
    expect(yield* log.latestForThread(thread)).toBeNull();
    yield* log.record(
      row(1, {
        receivedAt: 1_000,
        durationMs: 500,
        promptTokens: 7,
        ttftMs: 40,
        decodeMs: 200,
        completionTokens: 4,
      }),
    );
    yield* log.record(row(2, { receivedAt: 2_000, status: "failed" }));
    expect(yield* log.latestForThread(thread)).toEqual({
      serverId: rtx,
      model: "GLM-5.3-Flash",
      completedAt: "1970-01-01T00:00:01.500Z",
      promptTokens: 7,
      cachedPromptTokens: null,
      completionTokens: 4,
      queueWaitMs: null,
      ttftMs: 40,
      decodeTokensPerSecond: 20,
    });
  }).pipe(Effect.provide(layer)),
);

it.effect("compares a thread's latest request with its previous one", () =>
  Effect.gen(function* () {
    const log = yield* InferenceRequests.InferenceRequestLog;
    const spark = InferenceServerId.make("spark1");
    yield* log.record(row(1, { receivedAt: 1_000, staticPrefixHash: "aaaa" }));
    const first = yield* log.latestForThread(thread);
    expect(first).not.toHaveProperty("serverChanged");
    expect(first).not.toHaveProperty("staticPrefixChanged");

    yield* log.record(
      row(2, {
        receivedAt: 2_000,
        serverId: spark,
        fallbackFrom: rtx,
        staticPrefixHash: "bbbb",
        parentRunId: RunId.make("run-parent"),
      }),
    );
    expect(yield* log.latestForThread(thread)).toMatchObject({
      serverId: spark,
      fallbackFrom: rtx,
      serverChanged: true,
      staticPrefixChanged: true,
    });

    yield* log.record(row(3, { receivedAt: 3_000, serverId: spark, staticPrefixHash: "bbbb" }));
    const third = yield* log.latestForThread(thread);
    expect(third).toMatchObject({ serverChanged: false, staticPrefixChanged: false });
    expect(third).not.toHaveProperty("fallbackFrom");

    yield* log.record(row(4, { receivedAt: 4_000, serverId: spark }));
    const unmeasured = yield* log.latestForThread(thread);
    expect(unmeasured).toMatchObject({ serverChanged: false });
    expect(unmeasured).not.toHaveProperty("staticPrefixChanged");
  }).pipe(Effect.provide(layer)),
);

// Servers can flush buffered output (tool calls) in one burst; that is not a decode rate.
it.effect("reports no decode speed for output that arrived in a burst", () =>
  Effect.gen(function* () {
    const log = yield* InferenceRequests.InferenceRequestLog;
    yield* log.record(
      row(1, { receivedAt: 1_000, durationMs: 900, decodeMs: 2, completionTokens: 90 }),
    );
    expect((yield* log.latestForThread(thread))?.decodeTokensPerSecond).toBeNull();
  }).pipe(Effect.provide(layer)),
);

it.effect("prunes records past the retention window when it records", () =>
  Effect.gen(function* () {
    const log = yield* InferenceRequests.InferenceRequestLog;
    const sql = yield* SqlClient.SqlClient;
    yield* log.record(row(1, { receivedAt: 0 }));
    yield* TestClock.adjust(InferenceRequests.RETENTION_MS + DAY);
    yield* log.record(row(2, { receivedAt: InferenceRequests.RETENTION_MS + DAY }));
    const ids = yield* sql<{ readonly request_id: string }>`
      SELECT request_id FROM houston_inference_requests ORDER BY request_id
    `;
    expect(ids.map((entry) => entry.request_id)).toEqual(["request-2"]);
  }).pipe(Effect.provide(layer)),
);
