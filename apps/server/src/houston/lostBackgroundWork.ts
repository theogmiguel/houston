import {
  CommandId,
  type EventId,
  type OrchestrationV2PendingBackgroundTask,
  type OrchestrationV2Run,
  type ProviderThreadId,
  type ThreadId,
} from "@houston-app/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import type * as IdAllocator from "@houston-app/provider-core/server/IdAllocator";
import type * as EventSink from "../orchestration-v2/EventSink.ts";
import type * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import {
  cancelledRosterTaskWork,
  isAwaitedWork,
  latestStartedRun,
  mergeRestartCancelledBackgroundWork,
} from "../orchestration-v2/RestartBackgroundNote.ts";

/** Records work an exited provider process took with it on the latest started run, and queues one
 * wake for that run if the agent awaited the work. Restart recovery moves the record to the run
 * before it when that run is a prompt recovery holds. */
export const writeLostBackgroundWork = Effect.fn("houston.writeLostBackgroundWork")(function* (
  deps: {
    readonly readRuns: (
      threadId: ThreadId,
    ) => Effect.Effect<ReadonlyArray<OrchestrationV2Run>, ProjectionStore.ProjectionStoreV2Error>;
    readonly eventSink: EventSink.EventSinkV2Shape;
    readonly allocateEventId: Effect.Effect<EventId, IdAllocator.IdAllocatorV2AllocationError>;
  },
  input: {
    readonly threadId: ThreadId;
    readonly providerThreadId: ProviderThreadId;
    readonly tasks: ReadonlyArray<OrchestrationV2PendingBackgroundTask>;
  },
) {
  if (input.tasks.length === 0) return;
  const run = latestStartedRun(yield* deps.readRuns(input.threadId), input.providerThreadId);
  if (run === undefined) return;
  const recorded = run.restartCancelledBackgroundWork ?? [];
  const recordedIds = new Set(recorded.map((work) => work.id));
  const lost = input.tasks
    .map((task) => ({ ...cancelledRosterTaskWork(task), cause: "provider_exit" as const }))
    .filter((work) => !recordedIds.has(work.id));
  if (lost.length === 0) return;
  const now = yield* DateTime.now;
  yield* deps.eventSink.writeWithEffects({
    events: [
      {
        id: yield* deps.allocateEventId,
        type: "run.background-work-cancelled",
        threadId: input.threadId,
        runId: run.id,
        providerInstanceId: run.providerInstanceId,
        occurredAt: now,
        payload: {
          runId: run.id,
          restartCancelledBackgroundWork: mergeRestartCancelledBackgroundWork(recorded, lost),
        },
      },
    ],
    // Unawaited work waits for the next user message; queueing nothing keeps the shared id free.
    effects: lost.some(isAwaitedWork)
      ? [
          {
            id: `effect:restart-continuation:${run.id}`,
            commandId: CommandId.make(`command:provider-exit-continuation:${run.id}`),
            threadId: input.threadId,
            request: { type: "provider-runtime.continue", sourceRunId: run.id },
          },
        ]
      : [],
  });
});
