import { RunId, ThreadId } from "@houston-app/contracts";
import {
  InferenceFailureCause,
  InferenceRequestPurpose,
  InferenceServerId,
  type InferenceThreadLastRequest,
  type InferenceUsageRow,
  type InferenceUsageSummary,
  type InferenceUsageWindow,
} from "@houston-app/contracts/houston/inference";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { inferenceFailureAdvice } from "./InferenceDiagnostics.ts";

export const InferenceRequestStatus = Schema.Literals([
  "completed",
  "failed",
  "cancelled",
  "rejected",
]);
export type InferenceRequestStatus = typeof InferenceRequestStatus.Type;

/** Milliseconds are measured from when the gateway received the request. */
export const InferenceRequestRecord = Schema.Struct({
  requestId: Schema.String,
  serverId: InferenceServerId,
  model: Schema.String,
  threadId: Schema.NullOr(ThreadId),
  runId: Schema.NullOr(RunId),
  /** The run that delegated this request's thread, when the thread is a delegated child. */
  parentRunId: Schema.NullOr(RunId),
  purpose: InferenceRequestPurpose,
  status: InferenceRequestStatus,
  /** Set when another server served the request its credential's server could not take. */
  fallbackFrom: Schema.NullOr(InferenceServerId),
  /** Short hash of the request's static prefix (system text and tools); never the text itself. */
  staticPrefixHash: Schema.NullOr(Schema.String),
  receivedAt: Schema.Number,
  queueWaitMs: Schema.NullOr(Schema.Number),
  ttftMs: Schema.NullOr(Schema.Number),
  /** From first content to completion: the denominator of decode speed. */
  decodeMs: Schema.NullOr(Schema.Number),
  durationMs: Schema.NullOr(Schema.Number),
  promptTokens: Schema.NullOr(Schema.Number),
  cachedPromptTokens: Schema.NullOr(Schema.Number),
  completionTokens: Schema.NullOr(Schema.Number),
  failureCause: Schema.NullOr(InferenceFailureCause),
  upstreamHttpStatus: Schema.NullOr(Schema.Number),
  reasoningTokens: Schema.NullOr(Schema.Number),
});
export type InferenceRequestRecord = typeof InferenceRequestRecord.Type;

/** Request/response text is never stored; rows past a week are swept as it records. */
export const RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;
const PRUNE_EVERY_MS = 60 * 60 * 1_000;
const WINDOW_MS: Record<InferenceUsageWindow, number> = {
  "24h": 24 * 60 * 60 * 1_000,
  "7d": 7 * 24 * 60 * 60 * 1_000,
};

export class InferenceRequestLog extends Context.Service<
  InferenceRequestLog,
  {
    /** Never fails: losing a log row must not fail the request it describes. */
    readonly record: (record: InferenceRequestRecord) => Effect.Effect<void>;
    readonly summarize: (window: InferenceUsageWindow) => Effect.Effect<InferenceUsageSummary>;
    readonly latestForThread: (
      threadId: ThreadId,
    ) => Effect.Effect<InferenceThreadLastRequest | null>;
  }
>()("@houston-app/cli/houston/inference/InferenceRequests/InferenceRequestLog") {}

const Row = Schema.Struct({
  request_id: Schema.String,
  server_id: InferenceServerId,
  model: Schema.String,
  thread_id: Schema.NullOr(ThreadId),
  run_id: Schema.NullOr(RunId),
  parent_run_id: Schema.NullOr(RunId),
  purpose: InferenceRequestPurpose,
  status: InferenceRequestStatus,
  fallback_from: Schema.NullOr(InferenceServerId),
  static_prefix_hash: Schema.NullOr(Schema.String),
  received_at: Schema.Number,
  queue_wait_ms: Schema.NullOr(Schema.Number),
  ttft_ms: Schema.NullOr(Schema.Number),
  decode_ms: Schema.NullOr(Schema.Number),
  duration_ms: Schema.NullOr(Schema.Number),
  prompt_tokens: Schema.NullOr(Schema.Number),
  cached_prompt_tokens: Schema.NullOr(Schema.Number),
  completion_tokens: Schema.NullOr(Schema.Number),
  failure_cause: Schema.NullOr(InferenceFailureCause),
  upstream_http_status: Schema.NullOr(Schema.Number),
  reasoning_tokens: Schema.NullOr(Schema.Number),
});
const decodeRows = Schema.decodeUnknownEffect(Schema.Array(Row));

const fromRow = (row: typeof Row.Type): InferenceRequestRecord => ({
  requestId: row.request_id,
  serverId: row.server_id,
  model: row.model,
  threadId: row.thread_id,
  runId: row.run_id,
  parentRunId: row.parent_run_id,
  purpose: row.purpose,
  status: row.status,
  fallbackFrom: row.fallback_from,
  staticPrefixHash: row.static_prefix_hash,
  receivedAt: row.received_at,
  queueWaitMs: row.queue_wait_ms,
  ttftMs: row.ttft_ms,
  decodeMs: row.decode_ms,
  durationMs: row.duration_ms,
  promptTokens: row.prompt_tokens,
  cachedPromptTokens: row.cached_prompt_tokens,
  completionTokens: row.completion_tokens,
  failureCause: row.failure_cause,
  upstreamHttpStatus: row.upstream_http_status,
  reasoningTokens: row.reasoning_tokens,
});

// Below this the output arrived in a burst (often buffered tool calls), not at a decode rate.
const MIN_DECODE_WINDOW_MS = 100;

const decodeSpeed = (record: InferenceRequestRecord) =>
  record.completionTokens !== null &&
  record.decodeMs !== null &&
  record.decodeMs >= MIN_DECODE_WINDOW_MS
    ? record.completionTokens / (record.decodeMs / 1_000)
    : null;

/** Nearest-rank percentiles over the values that were measured. */
function distribution(values: ReadonlyArray<number | null>) {
  const known = values.filter((value): value is number => value !== null).toSorted((a, b) => a - b);
  const at = (quantile: number) =>
    known.length === 0 ? null : known[Math.max(0, Math.ceil(quantile * known.length) - 1)]!;
  return { n: known.length, p50: at(0.5), p95: at(0.95) };
}

const sum = (values: ReadonlyArray<number | null>) =>
  values.reduce<number>((total, value) => total + (value ?? 0), 0);

const isoAt = (millis: number) => DateTime.formatIso(DateTime.makeUnsafe(millis));

function aggregate(
  records: ReadonlyArray<InferenceRequestRecord>,
): ReadonlyArray<InferenceUsageRow> {
  const groups = new Map<string, Array<InferenceRequestRecord>>();
  for (const record of records) {
    const key = JSON.stringify([record.serverId, record.model, record.purpose]);
    groups.set(key, [...(groups.get(key) ?? []), record]);
  }
  return Array.from(groups.values(), (group) => {
    const first = group[0]!;
    const lastFailure = group
      .filter((record) => record.status === "failed" || record.status === "rejected")
      .reduce<InferenceRequestRecord | undefined>(
        (latest, record) =>
          latest === undefined || record.receivedAt > latest.receivedAt ? record : latest,
        undefined,
      );
    return {
      serverId: first.serverId,
      model: first.model,
      purpose: first.purpose,
      requests: group.length,
      failed: group.filter((record) => record.status === "failed" || record.status === "rejected")
        .length,
      promptTokens: sum(group.map((record) => record.promptTokens)),
      cachedPromptTokens: sum(group.map((record) => record.cachedPromptTokens)),
      promptTokensWithCacheData: sum(
        group
          .filter((record) => record.cachedPromptTokens !== null)
          .map((record) => record.promptTokens),
      ),
      completionTokens: sum(group.map((record) => record.completionTokens)),
      ...(lastFailure === undefined
        ? {}
        : {
            lastFailure: {
              status: lastFailure.status === "rejected" ? "rejected" : "failed",
              at: isoAt(lastFailure.receivedAt),
              ...(lastFailure.failureCause === null
                ? {}
                : {
                    cause: lastFailure.failureCause,
                    advice: inferenceFailureAdvice(lastFailure.failureCause),
                  }),
              ...(lastFailure.upstreamHttpStatus === null
                ? {}
                : { httpStatus: lastFailure.upstreamHttpStatus }),
            },
          }),
      queueWaitMs: distribution(group.map((record) => record.queueWaitMs)),
      ttftMs: distribution(group.map((record) => record.ttftMs)),
      decodeTokensPerSecond: distribution(group.map(decodeSpeed)),
    } satisfies InferenceUsageRow;
  }).toSorted(
    (a, b) =>
      a.serverId.localeCompare(b.serverId) ||
      a.model.localeCompare(b.model) ||
      a.purpose.localeCompare(b.purpose),
  );
}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const lastPrunedAt = yield* Ref.make(Number.NEGATIVE_INFINITY);

  const prune = Effect.fn("InferenceRequestLog.prune")(function* (now: number) {
    const due = yield* Ref.modify(lastPrunedAt, (last) =>
      now - last >= PRUNE_EVERY_MS ? [true, now] : [false, last],
    );
    if (due) {
      yield* sql`DELETE FROM houston_inference_requests WHERE received_at < ${now - RETENTION_MS}`;
    }
  });

  const record = Effect.fn("InferenceRequestLog.record")(
    function* (entry: InferenceRequestRecord) {
      yield* sql`INSERT INTO houston_inference_requests ${sql.insert({
        request_id: entry.requestId,
        server_id: entry.serverId,
        model: entry.model,
        thread_id: entry.threadId,
        run_id: entry.runId,
        parent_run_id: entry.parentRunId,
        purpose: entry.purpose,
        status: entry.status,
        fallback_from: entry.fallbackFrom,
        static_prefix_hash: entry.staticPrefixHash,
        received_at: entry.receivedAt,
        queue_wait_ms: entry.queueWaitMs,
        ttft_ms: entry.ttftMs,
        decode_ms: entry.decodeMs,
        duration_ms: entry.durationMs,
        prompt_tokens: entry.promptTokens,
        cached_prompt_tokens: entry.cachedPromptTokens,
        completion_tokens: entry.completionTokens,
        failure_cause: entry.failureCause,
        upstream_http_status: entry.upstreamHttpStatus,
        reasoning_tokens: entry.reasoningTokens,
      })}`;
      yield* prune(yield* Clock.currentTimeMillis);
    },
    Effect.catchCause((cause) =>
      Effect.logWarning("could not log an inference request", { cause }),
    ),
  );

  const summarize = Effect.fn("InferenceRequestLog.summarize")(function* (
    window: InferenceUsageWindow,
  ) {
    const now = yield* Clock.currentTimeMillis;
    const rows = yield* sql`
      SELECT * FROM houston_inference_requests WHERE received_at >= ${now - WINDOW_MS[window]}
    `.pipe(
      Effect.flatMap(decodeRows),
      Effect.catchCause((cause) =>
        Effect.logError("could not read inference usage", { cause }).pipe(Effect.as([])),
      ),
    );
    return { window, generatedAt: isoAt(now), rows: aggregate(rows.map(fromRow)) };
  });

  const latestForThread = Effect.fn("InferenceRequestLog.latestForThread")(function* (
    threadId: ThreadId,
  ) {
    const rows = yield* sql`
      SELECT * FROM houston_inference_requests
      WHERE thread_id = ${threadId} AND status = 'completed'
      ORDER BY received_at DESC
      LIMIT 2
    `.pipe(
      Effect.flatMap(decodeRows),
      Effect.catchCause((cause) =>
        Effect.logError("could not read a thread's inference request", { cause }).pipe(
          Effect.as([]),
        ),
      ),
    );
    const [row, previousRow] = rows;
    if (row === undefined) return null;
    const latest = fromRow(row);
    const previous = previousRow === undefined ? undefined : fromRow(previousRow);
    return {
      serverId: latest.serverId,
      model: latest.model,
      completedAt: isoAt(latest.receivedAt + (latest.durationMs ?? 0)),
      promptTokens: latest.promptTokens,
      cachedPromptTokens: latest.cachedPromptTokens,
      completionTokens: latest.completionTokens,
      queueWaitMs: latest.queueWaitMs,
      ttftMs: latest.ttftMs,
      decodeTokensPerSecond: decodeSpeed(latest),
      ...(latest.fallbackFrom === null ? {} : { fallbackFrom: latest.fallbackFrom }),
      ...(previous === undefined ? {} : { serverChanged: previous.serverId !== latest.serverId }),
      ...(previous?.staticPrefixHash == null || latest.staticPrefixHash === null
        ? {}
        : { staticPrefixChanged: previous.staticPrefixHash !== latest.staticPrefixHash }),
    } satisfies InferenceThreadLastRequest;
  });

  return InferenceRequestLog.of({ record, summarize, latestForThread });
});

export const layer = Layer.effect(InferenceRequestLog, make);
