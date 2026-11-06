import { assert, describe, it } from "@effect/vitest";
import {
  EventId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type OrchestrationV2Run,
  type OrchestrationV2StoredEvent,
} from "@houston-app/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as RecordingTracer from "../../observability/testing/RecordingTracer.ts";
import { makeRunOutcomeRecorder } from "../../orchestration-v2/RunMetrics.ts";
import * as WideEvents from "./WideEvents.ts";

const at = (iso: string) => DateTime.makeUnsafe(iso);
const nanos = (iso: string) => BigInt(Date.parse(iso)) * 1_000_000n;
const threadId = ThreadId.make("thread:wide");

const runUpdated = (
  sequence: number,
  run: Pick<OrchestrationV2Run, "id" | "status" | "startedAt" | "completedAt">,
): OrchestrationV2StoredEvent => ({
  sequence,
  commandId: null,
  event: {
    type: "run.updated",
    id: EventId.make(`event:wide:${sequence}`),
    threadId,
    occurredAt: at("2026-11-06T12:00:00.000Z"),
    payload: {
      threadId,
      ordinal: 1,
      providerInstanceId: ProviderInstanceId.make("my-codex"),
      modelSelection: { instanceId: ProviderInstanceId.make("my-codex"), model: "gpt-5.4" },
      requestedAt: at("2026-11-06T12:00:00.000Z"),
      ...run,
    } as OrchestrationV2Run,
  },
});

const record = (events: ReadonlyArray<OrchestrationV2StoredEvent>) => {
  const recorder = makeRunOutcomeRecorder(() => Effect.succeed(false));
  return recorder.prepare(events).pipe(Effect.flatMap(recorder.record));
};

describe("houston.run", () => {
  it.effect("is emitted once per finished run with the row's start and completion", () =>
    Effect.gen(function* () {
      const recording = RecordingTracer.make();
      const recorder = makeRunOutcomeRecorder(() => Effect.succeed(false));
      const finished = runUpdated(1, {
        id: RunId.make("run:wide:once"),
        status: "failed",
        startedAt: at("2026-11-06T12:00:02.000Z"),
        completedAt: at("2026-11-06T12:00:32.000Z"),
      });
      const commit = (events: ReadonlyArray<OrchestrationV2StoredEvent>) =>
        recorder.prepare(events).pipe(Effect.flatMap(recorder.record));
      // A replayed or re-updated finished run is counted once.
      yield* commit([finished]).pipe(Effect.withTracer(recording.tracer));
      yield* commit([finished]).pipe(Effect.withTracer(recording.tracer));

      const runs = recording.named("houston.run");
      assert.strictEqual(runs.length, 1);
      const span = runs[0]!;
      assert.isTrue(Option.isNone(span.parent));
      const status = span.status;
      assert.strictEqual(status._tag, "Ended");
      if (status._tag !== "Ended") return;
      assert.strictEqual(status.startTime, nanos("2026-11-06T12:00:02.000Z"));
      assert.strictEqual(status.endTime, nanos("2026-11-06T12:00:32.000Z"));
      assert.deepStrictEqual(Object.fromEntries(span.attributes), {
        "houston.thread.id": "thread:wide",
        "houston.run.id": "run:wide:once",
        "houston.delegated": false,
        "houston.model": "gpt",
        "houston.run.status": "failed",
        "houston.run.queue_wait_ms": 2000,
        "houston.run.duration_ms": 30000,
        "houston.outcome": "failure",
      });
    }),
  );

  it.effect("is not emitted for a run without a completion time", () =>
    Effect.gen(function* () {
      const recording = RecordingTracer.make();
      yield* record([
        runUpdated(1, {
          id: RunId.make("run:wide:open"),
          status: "interrupted",
          startedAt: null,
          completedAt: null,
        }),
      ]).pipe(Effect.withTracer(recording.tracer));
      assert.strictEqual(recording.named("houston.run").length, 0);
    }),
  );

  it.effect("links to the command that started it while that command is remembered", () =>
    Effect.gen(function* () {
      const recording = RecordingTracer.make();
      yield* WideEvents.rememberCommandSpan("command:wide").pipe(
        Effect.withSpan("ws.rpc.orchestrationV2.dispatchCommand"),
        Effect.withTracer(recording.tracer),
      );
      yield* Effect.void.pipe(
        Effect.withSpan("OrchestrationEffectExecutorV2.execute"),
        WideEvents.linkToCommand("command:wide", "run:wide:linked"),
        Effect.withTracer(recording.tracer),
      );
      yield* record([
        runUpdated(1, {
          id: RunId.make("run:wide:linked"),
          status: "completed",
          startedAt: at("2026-11-06T12:00:01.000Z"),
          completedAt: at("2026-11-06T12:00:03.000Z"),
        }),
      ]).pipe(Effect.withTracer(recording.tracer));

      const command = recording.named("ws.rpc.orchestrationV2.dispatchCommand")[0]!;
      const execute = recording.named("OrchestrationEffectExecutorV2.execute")[0]!;
      const run = recording.named("houston.run")[0]!;
      assert.deepStrictEqual(
        execute.links.map((link) => link.span.spanId),
        [command.spanId],
      );
      assert.deepStrictEqual(
        run.links.map((link) => link.span.spanId),
        [command.spanId],
      );
      assert.strictEqual(run.attributes.get("houston.outcome"), "success");
    }),
  );
});

describe("jobTick", () => {
  it.effect("runs each tick as a root span whose children carry the job name", () =>
    Effect.gen(function* () {
      const recording = RecordingTracer.make();
      yield* Effect.void.pipe(
        Effect.withSpan("HoustonMergeQueueStore.projectsWithEntries"),
        WideEvents.jobTick("mergeQueue.pass"),
        Effect.withSpan("server.boot"),
        Effect.withTracer(recording.tracer),
      );
      const tick = recording.named("houston.job.mergeQueue.pass")[0]!;
      assert.isTrue(Option.isNone(tick.parent));
      assert.strictEqual(tick.attributes.get("houston.job.name"), "mergeQueue.pass");
      const child = recording.named("HoustonMergeQueueStore.projectsWithEntries")[0]!;
      assert.strictEqual(child.attributes.get("houston.job.name"), "mergeQueue.pass");
      assert.strictEqual(Option.getOrUndefined(child.parent)?.spanId, tick.spanId);
    }),
  );
});
