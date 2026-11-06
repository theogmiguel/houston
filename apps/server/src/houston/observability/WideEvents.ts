// One wide span per unit of work that has no request of its own: a finished run and a
// background job tick. Both are root spans enriched with context, so traces and events agree.
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as References from "effect/References";
import * as Tracer from "effect/Tracer";
import type { OrchestrationV2RunStatus } from "@houston-app/contracts";

import { outcomeFromExit } from "../../observability/Attributes.ts";
import { toAttributes, withinTraceContext, type TraceContext } from "./TraceContext.ts";

// A run usually finishes within minutes of its command; older commands lose their link.
const REMEMBERED_TRACES = 4096;

const remember = <K, V>(map: Map<K, V>, key: K, value: V) => {
  map.delete(key);
  map.set(key, value);
  if (map.size > REMEMBERED_TRACES) map.delete(map.keys().next().value!);
};

// Link targets only: the ids, not the ended span with its attributes and events.
const commandSpans = new Map<string, Tracer.ExternalSpan>();
const runSpans = new Map<string, Tracer.ExternalSpan>();

/** Remembers the span that dispatched a command, so outbox work can link back to it. */
// oxlint-disable-next-line houston/require-traced-definition -- it records the current span; a span of its own would be recorded instead
export const rememberCommandSpan = (commandId: string): Effect.Effect<void> =>
  Effect.currentSpan.pipe(
    Effect.tap((span) =>
      Effect.sync(() =>
        remember(
          commandSpans,
          commandId,
          Tracer.externalSpan({
            traceId: span.traceId,
            spanId: span.spanId,
            sampled: span.sampled,
          }),
        ),
      ),
    ),
    Effect.ignore,
  );

/** Links spans inside `self` to the command that queued them, and the run's wide event too. */
export const linkToCommand =
  (commandId: string, runId: string | undefined) =>
  <A, E, R>(self: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    Effect.suspend(() => {
      const span = commandSpans.get(commandId);
      if (span === undefined) return self;
      if (runId !== undefined) remember(runSpans, runId, span);
      return self.pipe(Effect.linkSpans(span));
    });

const toNanos = (time: DateTime.Utc) => BigInt(DateTime.toEpochMillis(time)) * 1_000_000n;

export interface RunEvent {
  readonly runId: string;
  readonly context: TraceContext;
  readonly status: OrchestrationV2RunStatus;
  readonly startedAt: DateTime.Utc;
  readonly completedAt: DateTime.Utc;
  readonly queueWaitMs: number | undefined;
  readonly durationMs: number | undefined;
}

// The run's status as a span exit, so exporters see the same outcome and error tag.
const runExit = (status: OrchestrationV2RunStatus): Exit.Exit<unknown, unknown> => {
  switch (status) {
    case "completed":
      return Exit.void;
    // Run metrics never emit a rolled-back run (it rewrites finished runs); mapped as a cancel.
    case "cancelled":
    case "interrupted":
    case "rolled_back":
      return Exit.interrupt();
    case "failed":
      return Exit.fail({ _tag: "RunFailed" });
    case "preparing":
    case "queued":
    case "starting":
    case "running":
    case "waiting":
      return Exit.fail({ _tag: "RunUnfinished" });
  }
};

// Emits `houston.run` from the run's stored start to its completion. No I/O, so it is safe
// where run metrics are recorded under the publish lane.
export const emitRun = Effect.fnUntraced(function* (event: RunEvent) {
  if (!(yield* References.TracerEnabled)) return;
  const tracer = yield* Effect.tracer;
  const link = runSpans.get(event.runId);
  runSpans.delete(event.runId);
  const span = tracer.span({
    name: "houston.run",
    parent: Option.none(),
    annotations: Context.empty(),
    links: link === undefined ? [] : [{ span: link, attributes: {} }],
    startTime: toNanos(event.startedAt),
    kind: "internal",
    root: true,
    sampled: true,
  });
  const attributes = {
    ...toAttributes({ ...event.context, runId: event.runId }),
    "houston.run.status": event.status,
    ...(event.queueWaitMs === undefined ? {} : { "houston.run.queue_wait_ms": event.queueWaitMs }),
    ...(event.durationMs === undefined ? {} : { "houston.run.duration_ms": event.durationMs }),
  };
  const exit = runExit(event.status);
  for (const [key, value] of Object.entries(attributes)) span.attribute(key, value);
  span.attribute("houston.outcome", outcomeFromExit(exit));
  span.end(toNanos(event.completedAt), exit);
});

/** A loop's check for due work, untraced: an idle tick then exports nothing. */
// oxlint-disable-next-line houston/require-traced-definition -- it switches tracing off for the wrapped check
export const findWork = <A, E, R>(self: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
  Effect.withTracerEnabled(self, false);

/** Runs one background job tick that found work as the root span `houston.job.<name>`. */
export const jobTick =
  (name: string, context: TraceContext = {}) =>
  <A, E, R>(self: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    self.pipe(
      withinTraceContext({ ...context, jobName: name }),
      Effect.withSpan(`houston.job.${name}`, {
        root: true,
        attributes: toAttributes({ ...context, jobName: name }),
      }),
    );
