import {
  CheckpointScopeId,
  CommandId,
  type OrchestrationV2Checkpoint,
  type OrchestrationV2ExecutionNode,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2Run,
  type OrchestrationV2TurnItem,
  RunId,
  ThreadId,
} from "@houston-app/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as CheckpointService from "./CheckpointService.ts";
import * as EventSink from "./EventSink.ts";
import * as IdAllocator from "@houston-app/provider-core/server/IdAllocator";
import * as ProjectionStore from "./ProjectionStore.ts";

export class CheckpointCaptureExecutionError extends Schema.TaggedError<CheckpointCaptureExecutionError>()(
  "CheckpointCaptureExecutionError",
  {
    threadId: ThreadId,
    runId: RunId,
    scopeId: CheckpointScopeId,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

const isCheckpointCaptureExecutionError = Schema.is(CheckpointCaptureExecutionError);

export interface CheckpointCaptureServiceV2Shape {
  readonly execute: (input: {
    readonly threadId: ThreadId;
    readonly runId: RunId;
    readonly scopeId: CheckpointScopeId;
  }) => Effect.Effect<void, CheckpointCaptureExecutionError>;
}

export class CheckpointCaptureServiceV2 extends Context.Service<
  CheckpointCaptureServiceV2,
  CheckpointCaptureServiceV2Shape
>()("@houston-app/cli/orchestration-v2/CheckpointCaptureService/CheckpointCaptureServiceV2") {}

export const layer: Layer.Layer<
  CheckpointCaptureServiceV2,
  never,
  | CheckpointService.CheckpointServiceV2
  | EventSink.EventSinkV2
  | IdAllocator.IdAllocatorV2
  | ProjectionStore.ProjectionStoreV2
> = Layer.effect(
  CheckpointCaptureServiceV2,
  Effect.gen(function* () {
    const checkpoints = yield* CheckpointService.CheckpointServiceV2;
    const eventSink = yield* EventSink.EventSinkV2;
    const ids = yield* IdAllocator.IdAllocatorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;

    const execute = Effect.fn("orchestrationV2.checkpointCapture.execute")(function* (input: {
      readonly threadId: ThreadId;
      readonly runId: RunId;
      readonly scopeId: CheckpointScopeId;
    }) {
      const {
        run,
        rootNode,
        scope,
        providerThread,
        readyCheckpointOrdinals,
        childScopes: storedChildScopes,
        sideChat,
      } = yield* projections.getCheckpointCaptureContext(input.threadId, input);
      const existingChildScopes = storedChildScopes ?? [];
      // Stopped runs remain terminal; their checkpoint is the next message's rollback point.
      const stopped = run?.status === "interrupted" || run?.status === "cancelled";

      // A checkpoint on a settled run proves this at-least-once effect already committed.
      if (
        run !== undefined &&
        run.checkpointId !== null &&
        (run.status === "completed" || stopped)
      ) {
        return;
      }
      // Rollback uses the same lane and can precede a capture retry; preserve the restored workspace and discarded run.
      if (run?.status === "rolled_back") {
        return;
      }

      if (
        run === undefined ||
        (run.status !== "waiting" && !stopped) ||
        rootNode === undefined ||
        scope === undefined ||
        rootNode.checkpointScopeId !== scope.id ||
        providerThread === undefined
      ) {
        return yield* new CheckpointCaptureExecutionError({
          threadId: input.threadId,
          runId: input.runId,
          scopeId: input.scopeId,
          cause: "The persisted checkpoint capture target is incomplete or no longer waiting.",
        });
      }

      const capturedAt = yield* DateTime.now;
      const baselineOrdinalWithinScope = Math.max(0, run.ordinal - 1);
      const hasReadyCheckpoint = (ordinalWithinScope: number) =>
        readyCheckpointOrdinals.includes(ordinalWithinScope);
      // The baselines this capture materializes are attributed to the run materializing them. The
      // thread's scope may already be a later run's: one queued meanwhile, or sent after Stop.
      const materializeBaseline = (ordinalWithinScope: number) =>
        checkpoints.materializeBaselineCheckpoint({
          scope,
          ordinalWithinScope,
          nodeId: rootNode.id,
          capturedAt: run.requestedAt,
          forceMissing: sideChat,
        });
      const threadStartCheckpoint =
        baselineOrdinalWithinScope === 0 || hasReadyCheckpoint(0)
          ? null
          : yield* materializeBaseline(0);
      const baselineCheckpoint = hasReadyCheckpoint(baselineOrdinalWithinScope)
        ? null
        : yield* materializeBaseline(baselineOrdinalWithinScope);
      const checkpoint = yield* checkpoints.capture({
        scope,
        runId: run.id,
        nodeId: rootNode.id,
        ordinalWithinScope: run.ordinal,
        appRunOrdinal: run.ordinal,
        capturedAt,
        forceMissing: sideChat,
        previousCheckpointReady: baselineCheckpoint?.status === "ready",
      });
      // A task folder's root scope holds its first repository; every other repository gets a
      // child scope, captured and rewound with it.
      const newChildScopes =
        existingChildScopes.length === 0
          ? yield* checkpoints.repositoryScopes({ parent: scope })
          : [];
      const childScopes =
        existingChildScopes.length === 0
          ? newChildScopes.map((childScope) => ({
              scope: childScope,
              readyCheckpointOrdinals: [] as ReadonlyArray<number>,
            }))
          : existingChildScopes;
      const childCaptures = yield* Effect.forEach(childScopes, (child) =>
        Effect.gen(function* () {
          const childHasReady = (ordinalWithinScope: number) =>
            child.readyCheckpointOrdinals.includes(ordinalWithinScope);
          const materializeChildBaseline = (ordinalWithinScope: number) =>
            checkpoints.materializeBaselineCheckpoint({
              scope: child.scope,
              ordinalWithinScope,
              nodeId: rootNode.id,
              capturedAt: run.requestedAt,
              forceMissing: sideChat,
            });
          const childThreadStart =
            baselineOrdinalWithinScope === 0 || childHasReady(0)
              ? null
              : yield* materializeChildBaseline(0);
          const childBaseline = childHasReady(baselineOrdinalWithinScope)
            ? null
            : yield* materializeChildBaseline(baselineOrdinalWithinScope);
          const childCheckpoint = yield* checkpoints.capture({
            scope: child.scope,
            runId: run.id,
            nodeId: rootNode.id,
            ordinalWithinScope: run.ordinal,
            appRunOrdinal: run.ordinal,
            capturedAt,
            forceMissing: sideChat,
            previousCheckpointReady: childBaseline?.status === "ready",
          });
          return {
            threadStart: childThreadStart,
            baseline: childBaseline,
            checkpoint: childCheckpoint,
          };
        }),
      );
      // Omit delegatedCompletion to preserve cohort writes made after capture loaded the run.
      const { delegatedCompletion: _delegatedCompletion, ...runWithoutDelegatedCompletion } = run;
      const commandId = CommandId.make(`command:effect:checkpoint.capture:${run.id}`);
      const childEvents = yield* Effect.forEach(
        [
          ...newChildScopes.map((childScope) => ({ kind: "scope" as const, childScope })),
          ...childCaptures.flatMap((capture) => [
            ...(capture.threadStart === null
              ? []
              : [{ kind: "checkpoint" as const, checkpoint: capture.threadStart }]),
            ...(capture.baseline === null
              ? []
              : [{ kind: "checkpoint" as const, checkpoint: capture.baseline }]),
            { kind: "checkpoint" as const, checkpoint: capture.checkpoint },
          ]),
        ],
        (entry) =>
          Effect.map(ids.allocate.event({ threadId: input.threadId, commandId }), (id) =>
            entry.kind === "scope"
              ? {
                  id,
                  type: "checkpoint-scope.created" as const,
                  threadId: input.threadId,
                  runId: run.id,
                  nodeId: entry.childScope.nodeId,
                  driver: providerThread.driver,
                  providerInstanceId: run.providerInstanceId,
                  occurredAt: capturedAt,
                  payload: entry.childScope,
                }
              : {
                  id,
                  type: "checkpoint.captured" as const,
                  threadId: input.threadId,
                  ...(entry.checkpoint.runId === null ? {} : { runId: entry.checkpoint.runId }),
                  nodeId: entry.checkpoint.nodeId,
                  driver: providerThread.driver,
                  providerInstanceId: run.providerInstanceId,
                  occurredAt: capturedAt,
                  payload: entry.checkpoint,
                },
          ),
      );
      yield* eventSink.commitCommand({
        commandId,
        threadId: input.threadId,
        commandType: "checkpoint.capture",
        acceptedAt: capturedAt,
        effects: [],
        events: [
          ...(threadStartCheckpoint === null
            ? []
            : [
                {
                  id: yield* ids.allocate.event({ threadId: input.threadId, commandId }),
                  type: "checkpoint.captured" as const,
                  threadId: input.threadId,
                  nodeId: threadStartCheckpoint.nodeId,
                  driver: providerThread.driver,
                  providerInstanceId: run.providerInstanceId,
                  occurredAt: capturedAt,
                  payload: threadStartCheckpoint,
                },
              ]),
          ...(baselineCheckpoint === null
            ? []
            : [
                {
                  id: yield* ids.allocate.event({ threadId: input.threadId, commandId }),
                  type: "checkpoint.captured" as const,
                  threadId: input.threadId,
                  nodeId: baselineCheckpoint.nodeId,
                  driver: providerThread.driver,
                  providerInstanceId: run.providerInstanceId,
                  occurredAt: capturedAt,
                  payload: baselineCheckpoint,
                },
              ]),
          ...childEvents,
          {
            id: yield* ids.allocate.event({ threadId: input.threadId, commandId }),
            type: "checkpoint.captured",
            threadId: input.threadId,
            runId: run.id,
            nodeId: rootNode.id,
            driver: providerThread.driver,
            providerInstanceId: run.providerInstanceId,
            occurredAt: capturedAt,
            payload: checkpoint,
          },
          {
            id: yield* ids.allocate.event({ threadId: input.threadId, commandId }),
            type: "turn-item.updated",
            threadId: input.threadId,
            runId: run.id,
            nodeId: rootNode.id,
            driver: providerThread.driver,
            providerInstanceId: run.providerInstanceId,
            occurredAt: capturedAt,
            payload: makeCheckpointTurnItem({
              idAllocator: ids,
              run,
              rootNode,
              providerThread,
              checkpoint,
              completedAt: capturedAt,
            }),
          },
          {
            id: yield* ids.allocate.event({ threadId: input.threadId, commandId }),
            type: "run.updated",
            threadId: input.threadId,
            runId: run.id,
            nodeId: rootNode.id,
            providerInstanceId: run.providerInstanceId,
            occurredAt: capturedAt,
            payload: stopped
              ? { ...runWithoutDelegatedCompletion, checkpointId: checkpoint.id }
              : {
                  ...runWithoutDelegatedCompletion,
                  status: "completed",
                  completedAt: capturedAt,
                  checkpointId: checkpoint.id,
                },
          },
          ...(stopped
            ? []
            : [
                {
                  id: yield* ids.allocate.event({ threadId: input.threadId, commandId }),
                  type: "node.updated" as const,
                  threadId: input.threadId,
                  runId: run.id,
                  nodeId: rootNode.id,
                  providerInstanceId: run.providerInstanceId,
                  occurredAt: capturedAt,
                  payload: {
                    ...rootNode,
                    status: "completed" as const,
                    completedAt: capturedAt,
                    checkpointScopeId: scope.id,
                  },
                },
              ]),
        ],
      });
    });

    return CheckpointCaptureServiceV2.of({
      execute: Effect.fn("CheckpointCaptureServiceV2.execute")(function (input) {
        return execute(input).pipe(
          Effect.mapError((cause) =>
            isCheckpointCaptureExecutionError(cause)
              ? cause
              : new CheckpointCaptureExecutionError({ ...input, cause }),
          ),
        );
      }),
    });
  }),
);

function makeCheckpointTurnItem(input: {
  readonly idAllocator: IdAllocator.IdAllocatorV2["Service"];
  readonly run: OrchestrationV2Run;
  readonly rootNode: OrchestrationV2ExecutionNode;
  readonly providerThread: OrchestrationV2ProviderThread;
  readonly checkpoint: OrchestrationV2Checkpoint;
  readonly completedAt: DateTime.Utc;
}): OrchestrationV2TurnItem {
  return {
    id: input.idAllocator.derive.turnItemFromProviderItem({
      driver: input.providerThread.driver,
      nativeItemId: `checkpoint:${input.checkpoint.id}`,
    }),
    threadId: input.run.threadId,
    runId: input.run.id,
    nodeId: input.rootNode.id,
    providerThreadId: input.providerThread.id,
    providerTurnId: input.rootNode.providerTurnId,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: input.run.ordinal * 100 + 99,
    status: "completed",
    title: null,
    startedAt: input.completedAt,
    completedAt: input.completedAt,
    updatedAt: input.completedAt,
    type: "checkpoint",
    checkpointId: input.checkpoint.id,
    scopeId: input.checkpoint.scopeId,
    files: input.checkpoint.files,
  };
}
