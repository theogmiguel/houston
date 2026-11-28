import {
  CommandId,
  MessageId,
  type OrchestrationV2Run,
  type ThreadId,
} from "@houston-app/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";

import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import * as ThreadManagementService from "../../orchestration-v2/ThreadManagementService.ts";
import * as Scheduler from "../../scheduling/Scheduler.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as ThreadMemory from "../memory/ThreadMemory.ts";
import {
  canReleaseHeld,
  concurrentRunsCeiling,
  memoryPressure,
  overdueHoldIds,
  type HeldAt,
} from "./LoadAdmission.ts";

interface HeldRun {
  readonly threadId: ThreadId;
  readonly run: OrchestrationV2Run;
}

const heldAt = (run: OrchestrationV2Run): number => DateTime.toEpochMillis(run.requestedAt);

const oldestFirst = (left: HeldRun, right: HeldRun): number =>
  heldAt(left.run) - heldAt(right.run) || left.run.ordinal - right.run.ordinal;

const makeWorker = Effect.gen(function* () {
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const settings = yield* ServerSettings.ServerSettingsService;
  const lastRelease = yield* Ref.make<number | null>(null);
  const notified = yield* Ref.make<ReadonlySet<string>>(new Set());

  const readHeldLoadRuns = Effect.fn("LoadHoldWorker.readHeldLoadRuns")(function* () {
    const threadIds = yield* projections.getRecoveryThreadIds("queued-runs");
    const held: HeldRun[] = [];
    for (const threadId of threadIds) {
      const runs = yield* projections.getHeldQueuedRuns(threadId);
      for (const run of runs) {
        if (run.queueHeldReason?.kind === "load") held.push({ threadId, run });
      }
    }
    return held.toSorted(oldestFirst);
  });

  const notifyOverdue = Effect.fn("LoadHoldWorker.notifyOverdue")(function* (
    held: ReadonlyArray<HeldRun>,
    nowMs: number,
  ) {
    const already = yield* Ref.get(notified);
    const due = new Set(
      overdueHoldIds(
        held.map(({ run }): HeldAt => ({ runId: run.id, requestedAtMs: heldAt(run) })),
        nowMs,
        already,
      ),
    );
    if (due.size === 0) return;
    for (const entry of held) {
      if (!due.has(entry.run.id)) continue;
      const child = yield* projections
        .getThread(entry.threadId)
        .pipe(Effect.catchCause(() => Effect.succeed(null)));
      const parentThreadId = child?.lineage.parentThreadId ?? null;
      if (parentThreadId === null) continue;
      const taskIds = entry.run.delegatedTaskId === undefined ? [] : [entry.run.delegatedTaskId];
      yield* threads
        .dispatch({
          type: "message.dispatch",
          commandId: CommandId.make(`load-overdue:${entry.run.id}`),
          threadId: parentThreadId,
          messageId: MessageId.make(`message:load-overdue:${entry.run.id}`),
          text: `The sub-agent in thread ${entry.threadId} still waits for memory (${entry.run.queueHeldReason?.message ?? "held"}). It can be cancelled if it is no longer needed; it starts when a run finishes or memory frees.`,
          notification: {
            source:
              taskIds.length > 0
                ? { kind: "delegated_task", taskIds, childThreadId: entry.threadId }
                : { kind: "subagent", childThreadId: entry.threadId },
            outcome: "updated",
            summary: "A sub-agent still waits for memory",
          },
          attachments: [],
          dispatchMode: { type: "queue_after_active" },
          createdBy: "agent",
          creationSource: "server",
          // A notice about held work must not itself be held.
          startOrigin: "provider",
        })
        .pipe(Effect.ignoreCause({ log: true }));
      yield* Ref.update(notified, (current) => new Set(current).add(entry.run.id));
    }
  });

  const releaseOldest = Effect.fn("LoadHoldWorker.releaseOldest")(function* (
    held: ReadonlyArray<HeldRun>,
  ) {
    const target = held[0];
    if (target === undefined) return;
    const preferences = yield* settings.getSettings;
    const now = yield* DateTime.now;
    const nowMs = DateTime.toEpochMillis(now);
    const memory = yield* Effect.serviceOption(ThreadMemory.ThreadMemory);
    const machine = Option.isSome(memory)
      ? yield* memory.value.read([]).pipe(
          Effect.map((sample) => sample.machine),
          Effect.catchCause(() => Effect.succeed(null)),
        )
      : null;
    const activeRuns = yield* projections
      .countActiveRuns()
      .pipe(Effect.catchCause(() => Effect.succeed(0)));
    const ceiling = concurrentRunsCeiling(preferences.concurrentRuns, machine);
    const allowed = canReleaseHeld({
      settingOn: preferences.holdNewSubagentsUnderLoad,
      nowMs,
      lastReleaseMs: yield* Ref.get(lastRelease),
      activeRuns,
      ceiling,
      pressure: memoryPressure(machine),
    });
    if (!allowed) return;
    yield* threads
      .dispatch({
        type: "queued-run.start",
        commandId: CommandId.make(`load-release:${target.run.id}:${nowMs}`),
        threadId: target.threadId,
        runId: target.run.id,
      })
      .pipe(Effect.ignoreCause({ log: true }));
    yield* Ref.set(lastRelease, nowMs);
  });

  return Effect.fn("LoadHoldWorker.sweep")(function* () {
    const held = yield* readHeldLoadRuns();
    if (held.length === 0) return;
    const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
    yield* notifyOverdue(held, nowMs);
    yield* releaseOldest(held);
  });
});

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const sweep = yield* makeWorker;
    const scheduler = yield* Scheduler.Scheduler;
    yield* scheduler.register("load-hold", sweep());
  }),
);
