import { CheckpointScopeId, ProjectId, RunId, ThreadId } from "@houston-app/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FiberSet from "effect/FiberSet";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as PullRequestService from "../pullRequest/PullRequestService.ts";
import * as VcsStatusBroadcaster from "../vcs/VcsStatusBroadcaster.ts";
import * as WorkspaceEntries from "../workspace/WorkspaceEntries.ts";
import * as CheckpointCapture from "./CheckpointCaptureService.ts";
import * as ProjectionStore from "./ProjectionStore.ts";

export class RunFinalizationError extends Schema.TaggedError<RunFinalizationError>()(
  "RunFinalizationError",
  {
    threadId: ThreadId,
    runId: RunId,
    scopeId: CheckpointScopeId,
    operation: Schema.Literals(["capture-checkpoint", "refresh-workspace"]),
    cause: Schema.Defect(),
  },
) {}

export class RunFinalizationRefreshError extends Schema.TaggedError<RunFinalizationRefreshError>()(
  "RunFinalizationRefreshError",
  { cwd: Schema.String, cause: Schema.Defect() },
) {}

export class RunFinalizationObserver extends Context.Reference<{
  readonly refreshAfterTurn: (projectId: ProjectId) => Effect.Effect<void>;
  readonly refresh: (input: {
    readonly cwd: string;
    readonly threadId: ThreadId;
    readonly runId: RunId;
  }) => Effect.Effect<void, RunFinalizationRefreshError>;
}>("houston/orchestration-v2/RunFinalizationObserver", {
  defaultValue: () => ({ refresh: () => Effect.void, refreshAfterTurn: () => Effect.void }),
}) {}

export class RunFinalizationService extends Context.Service<
  RunFinalizationService,
  {
    readonly finalize: (input: {
      readonly threadId: ThreadId;
      readonly runId: RunId;
      readonly scopeId: CheckpointScopeId;
    }) => Effect.Effect<void, RunFinalizationError>;
  }
>()("@houston-app/cli/orchestration-v2/RunFinalizationService") {}

type RefreshRequest = Parameters<(typeof RunFinalizationObserver)["Service"]["refresh"]>[0];

const make = Effect.gen(function* () {
  const checkpointCapture = yield* CheckpointCapture.CheckpointCaptureServiceV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const observer = yield* RunFinalizationObserver;

  // Houston: display refreshes run beside the next turn, not before it. The service's scope
  // interrupts them on shutdown. Per thread and workspace, one runs and the latest request waits.
  const refreshes = yield* FiberSet.make();
  const queued = new Map<string, RefreshRequest>();
  const running = new Set<string>();
  const refreshOnce = (request: RefreshRequest) =>
    observer.refresh(request).pipe(
      Effect.catchCauseIf(
        (cause) => !Cause.hasInterruptsOnly(cause),
        (cause) =>
          Effect.logWarning("Failed to refresh workspace after checkpoint capture", {
            threadId: request.threadId,
            runId: request.runId,
            cause,
          }),
      ),
    );
  const drain = (key: string) =>
    Effect.gen(function* () {
      // Taking the next request and releasing the key happen together, so none is stranded.
      const takeNext = Effect.sync(() => {
        const next = queued.get(key);
        if (next === undefined) running.delete(key);
        else queued.delete(key);
        return next;
      });
      let next = yield* takeNext;
      while (next !== undefined) {
        yield* refreshOnce(next);
        next = yield* takeNext;
      }
    }).pipe(
      Effect.onInterrupt(() =>
        Effect.sync(() => {
          running.delete(key);
          queued.delete(key);
        }),
      ),
    );
  const refreshInBackground = (request: RefreshRequest) =>
    Effect.suspend(() => {
      const key = `${request.threadId}\u0000${request.cwd}`;
      queued.set(key, request);
      if (running.has(key)) return Effect.void;
      running.add(key);
      return FiberSet.run(refreshes, drain(key)).pipe(Effect.asVoid);
    });

  const finalize: RunFinalizationService["Service"]["finalize"] = Effect.fn(
    "RunFinalizationService.finalize",
  )(function* (input) {
    yield* checkpointCapture
      .execute(input)
      .pipe(
        Effect.mapError(
          (cause) => new RunFinalizationError({ ...input, operation: "capture-checkpoint", cause }),
        ),
      );
    const projection = yield* projections
      .getCheckpointContext(input.threadId)
      .pipe(
        Effect.mapError(
          (cause) => new RunFinalizationError({ ...input, operation: "refresh-workspace", cause }),
        ),
      );
    const cwd = projection.checkpointScopes.find((scope) => scope.id === input.scopeId)?.cwd;
    if (cwd !== undefined) {
      // Waiting on a display refresh after the checkpoint is durable would block the next turn.
      yield* refreshInBackground({ cwd, threadId: input.threadId, runId: input.runId });
    }
  });
  return RunFinalizationService.of({ finalize });
});

export const layer = Layer.effect(RunFinalizationService, make);

export const layerObserver = Layer.effect(
  RunFinalizationObserver,
  Effect.gen(function* () {
    const workspaceEntries = yield* WorkspaceEntries.WorkspaceEntries;
    const vcsStatus = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const pullRequests = yield* PullRequestService.PullRequestService;
    return {
      refreshAfterTurn: pullRequests.refreshAfterTurn,
      refresh: Effect.fn("RunFinalizationService.refresh")(
        function* ({ cwd, threadId, runId }) {
          const [, local] = yield* Effect.all(
            [workspaceEntries.refresh(cwd), vcsStatus.refreshLocalStatus(cwd)],
            { concurrency: "unbounded" },
          );
          if (local.refName === null || local.isDefaultRef) return;
          const thread = yield* projections.getThreadShell(threadId);
          if (!thread || thread.branch !== local.refName) return;
          if (thread.activeRunId !== null && thread.activeRunId !== runId) return;
          yield* vcsStatus.refreshPullRequestStatus(cwd).pipe(
            Effect.catch((error) =>
              Effect.logWarning("failed to refresh pull request status after run completion", {
                threadId,
                cwd,
                detail: error.message,
              }),
            ),
          );
        },
        (effect, { cwd }) =>
          effect.pipe(Effect.mapError((cause) => new RunFinalizationRefreshError({ cwd, cause }))),
      ),
    };
  }),
);
