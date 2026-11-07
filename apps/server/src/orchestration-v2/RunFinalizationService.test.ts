import { assert, it } from "@effect/vitest";
import {
  CheckpointScopeId,
  RunId,
  ThreadId,
  type OrchestrationV2ThreadShell,
} from "@houston-app/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import type * as Tracer from "effect/Tracer";

import * as TraceContext from "../houston/observability/TraceContext.ts";
import * as RecordingTracer from "../observability/testing/RecordingTracer.ts";
import * as PullRequestService from "../pullRequest/PullRequestService.ts";
import * as VcsStatusBroadcaster from "../vcs/VcsStatusBroadcaster.ts";
import * as WorkspaceEntries from "../workspace/WorkspaceEntries.ts";
import * as CheckpointCapture from "./CheckpointCaptureService.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as RunFinalization from "./RunFinalizationService.ts";

it.effect("completes finalization when the post-checkpoint workspace refresh fails", () =>
  Effect.gen(function* () {
    const refreshed = yield* Deferred.make<void>();
    const threadId = ThreadId.make("thread_refresh_failure");
    const runId = RunId.make("run_refresh_failure");
    const scopeId = CheckpointScopeId.make("scope_refresh_failure");
    const captured: string[] = [];
    const layer = RunFinalization.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(CheckpointCapture.CheckpointCaptureServiceV2)({
            execute: () =>
              Effect.sync(() => {
                captured.push("checkpoint");
              }),
          }),
          Layer.mock(ProjectionStore.ProjectionStoreV2)({
            getCheckpointContext: () =>
              Effect.succeed({
                runs: [],
                checkpointScopes: [{ id: scopeId, runId, kind: "root_run" as const, cwd: "/repo" }],
                checkpoints: [],
              }),
          }),
          Layer.succeed(RunFinalization.RunFinalizationObserver, {
            refresh: () =>
              Effect.gen(function* () {
                captured.push("refresh");
                yield* Deferred.succeed(refreshed, undefined);
                return yield* new RunFinalization.RunFinalizationRefreshError({
                  cwd: "/repo",
                  cause: new Error("Git command timed out"),
                });
              }),
            refreshAfterTurn: () => Effect.void,
          }),
        ),
      ),
    );
    yield* Effect.gen(function* () {
      const service = yield* RunFinalization.RunFinalizationService;
      yield* service.finalize({ threadId, runId, scopeId });
      yield* Deferred.await(refreshed);
      assert.deepEqual(captured, ["checkpoint", "refresh"]);
    }).pipe(Effect.provide(layer));
  }),
);

const makeBackgroundRefreshLayer = (input: {
  readonly events: Queue.Queue<string>;
  readonly pullRequestRefresh: Effect.Effect<void>;
  readonly activeRunId?: string;
}) => {
  const threadId = ThreadId.make("thread-background-refresh");
  const scopeId = CheckpointScopeId.make("scope-background-refresh");
  const projections = Layer.mock(ProjectionStore.ProjectionStoreV2)({
    getCheckpointContext: () =>
      Effect.succeed({
        runs: [],
        checkpointScopes: [
          { id: scopeId, runId: RunId.make("run-1"), kind: "root_run" as const, cwd: "/repo" },
        ],
        checkpoints: [],
      }),
    getThreadShell: () =>
      Effect.succeed({
        id: threadId,
        branch: "feature",
        activeRunId: input.activeRunId === undefined ? null : RunId.make(input.activeRunId),
      } as never),
  });
  const observer = RunFinalization.layerObserver.pipe(
    Layer.provide(
      Layer.mergeAll(
        projections,
        Layer.mock(WorkspaceEntries.WorkspaceEntries)({ refresh: () => Effect.void }),
        Layer.mock(PullRequestService.PullRequestService)({ refreshAfterTurn: () => Effect.void }),
        Layer.mock(VcsStatusBroadcaster.VcsStatusBroadcaster)({
          refreshLocalStatus: () =>
            Queue.offer(input.events, "local status").pipe(
              Effect.as({
                isRepo: true,
                hasPrimaryRemote: true,
                isDefaultRef: false,
                refName: "feature",
                hasWorkingTreeChanges: false,
                workingTree: { files: [], insertions: 0, deletions: 0 },
              }),
            ),
          refreshPullRequestStatus: () =>
            Queue.offer(input.events, "pull request status").pipe(
              Effect.andThen(input.pullRequestRefresh),
              Effect.as(null),
            ),
        }),
      ),
    ),
  );
  const layer = RunFinalization.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        projections,
        observer,
        Layer.mock(CheckpointCapture.CheckpointCaptureServiceV2)({
          execute: () => Queue.offer(input.events, "checkpoint").pipe(Effect.asVoid),
        }),
      ),
    ),
  );
  return { layer, finalizeInput: (run: string) => ({ threadId, runId: RunId.make(run), scopeId }) };
};

const takeEvents = (events: Queue.Queue<string>, count: number) =>
  Effect.replicateEffect(Queue.take(events), count);

const houstonContextOf = (span: Tracer.NativeSpan) =>
  Object.fromEntries([...span.attributes].filter(([key]) => key.startsWith("houston.")));

it.effect("finalizes without waiting for a pull request refresh that never returns", () =>
  Effect.gen(function* () {
    const events = yield* Queue.unbounded<string>();
    const interrupted = yield* Deferred.make<void>();
    const { layer, finalizeInput } = makeBackgroundRefreshLayer({
      events,
      pullRequestRefresh: Effect.never.pipe(
        Effect.onInterrupt(() => Deferred.succeed(interrupted, undefined)),
      ),
    });
    yield* Effect.gen(function* () {
      const service = yield* RunFinalization.RunFinalizationService;
      yield* service.finalize(finalizeInput("run-1"));
      yield* Queue.offer(events, "finalized");
      // The checkpoint comes first; the refresh still runs and publishes local status.
      const seen = yield* takeEvents(events, 4);
      assert.strictEqual(seen[0], "checkpoint");
      assert.sameMembers(seen, ["checkpoint", "local status", "pull request status", "finalized"]);
      assert.isFalse(yield* Deferred.isDone(interrupted));
    }).pipe(Effect.provide(layer));
    // Shutting the service down interrupts the refresh it left running.
    yield* Deferred.await(interrupted);
  }),
);

it.effect("coalesces refreshes requested while one is still running", () =>
  Effect.gen(function* () {
    const events = yield* Queue.unbounded<string>();
    const gate = yield* Deferred.make<void>();
    const { layer, finalizeInput } = makeBackgroundRefreshLayer({
      events,
      pullRequestRefresh: Deferred.await(gate),
    });
    yield* Effect.gen(function* () {
      const service = yield* RunFinalization.RunFinalizationService;
      yield* service.finalize(finalizeInput("run-1"));
      assert.deepEqual(yield* takeEvents(events, 3), [
        "checkpoint",
        "local status",
        "pull request status",
      ]);
      yield* service.finalize(finalizeInput("run-2"));
      yield* service.finalize(finalizeInput("run-3"));
      yield* Deferred.succeed(gate, undefined);
      assert.deepEqual(yield* takeEvents(events, 4), [
        "checkpoint",
        "checkpoint",
        "local status",
        "pull request status",
      ]);
    }).pipe(Effect.provide(layer));
    assert.deepEqual(yield* Queue.clear(events), []);
  }),
);

it.effect("a refresh drained after a later run is queued carries that run, not the first", () => {
  const recording = RecordingTracer.make();
  return Effect.gen(function* () {
    const events = yield* Queue.unbounded<string>();
    const gate = yield* Deferred.make<void>();
    const { layer, finalizeInput } = makeBackgroundRefreshLayer({
      events,
      pullRequestRefresh: Deferred.await(gate),
    });
    yield* Effect.gen(function* () {
      const service = yield* RunFinalization.RunFinalizationService;
      const finalize = (run: string) => {
        const input = finalizeInput(run);
        return service.finalize(input).pipe(
          TraceContext.withTraceContext({
            threadId: input.threadId,
            runId: run,
            commandId: `command-${run}`,
          }),
        );
      };
      // Run 1's finalize starts the drain; run 2's refresh waits in its queue.
      yield* finalize("run-1").pipe(Effect.withSpan("Turn1.root"));
      yield* takeEvents(events, 3);
      yield* finalize("run-2");
      yield* Deferred.succeed(gate, undefined);
      yield* takeEvents(events, 3);
    }).pipe(Effect.provide(layer));

    const threadId = finalizeInput("run-1").threadId;
    assert.deepStrictEqual(
      recording.named("RunFinalizationService.refresh").map(houstonContextOf),
      [
        { "houston.thread.id": threadId, "houston.run.id": "run-1" },
        { "houston.thread.id": threadId, "houston.run.id": "run-2" },
      ],
    );
    assert.deepStrictEqual(
      recording.named("RunFinalizationService.drainRefreshes").map(houstonContextOf),
      [{}],
    );
    // The drain serves later runs too, so it starts a trace of its own.
    const drainSpan = recording.named("RunFinalizationService.drainRefreshes")[0]!;
    assert.isTrue(Option.isNone(drainSpan.parent));
    assert.notStrictEqual(drainSpan.traceId, recording.named("Turn1.root")[0]!.traceId);
  }).pipe(Effect.withTracer(recording.tracer));
});

it.live("refreshes a run's pull request after the next queued run has started", () =>
  Effect.gen(function* () {
    const events = yield* Queue.unbounded<string>();
    // The next turn starts while the refresh is still queued, so run-2 is already active.
    const { layer, finalizeInput } = makeBackgroundRefreshLayer({
      events,
      pullRequestRefresh: Effect.void,
      activeRunId: "run-2",
    });
    yield* Effect.gen(function* () {
      const service = yield* RunFinalization.RunFinalizationService;
      yield* service.finalize(finalizeInput("run-1"));
      const seen = yield* takeEvents(events, 3).pipe(Effect.timeoutOption("2 seconds"));
      assert.deepEqual(Option.getOrUndefined(seen), [
        "checkpoint",
        "local status",
        "pull request status",
      ]);
    }).pipe(Effect.provide(layer));
  }),
);

it.effect.each(
  (
    [
      {
        label: "discovers a new PR for the completed run's branch",
        branch: "feature",
        checkedOut: "feature",
        activeRun: null,
        expected: ["/repo"],
      },
      {
        label: "leaves the default branch's PR cache alone",
        branch: "main",
        checkedOut: "main",
        activeRun: null,
        expected: [],
      },
      {
        label: "does not refresh another thread's checkout",
        branch: "feature",
        checkedOut: "other",
        activeRun: null,
        expected: [],
      },
      {
        label: "refreshes the completed run's PR after a newer run starts",
        branch: "feature",
        checkedOut: "feature",
        activeRun: "newer-run",
        expected: ["/repo"],
      },
    ] as const
  ).map((scenario) => [scenario.label, scenario] as const),
)("%s", ([, scenario]) => {
  const refreshed: string[] = [];
  const lookedUp = Deferred.makeUnsafe<void>();
  const threadId = ThreadId.make("thread-pr-refresh");
  const runId = RunId.make("completed-run");
  const layer = RunFinalization.layerObserver.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(WorkspaceEntries.WorkspaceEntries)({ refresh: () => Effect.void }),
        Layer.mock(PullRequestService.PullRequestService)({
          refreshAfterTurn: () => Effect.void,
        }),
        Layer.mock(VcsStatusBroadcaster.VcsStatusBroadcaster)({
          refreshLocalStatus: () =>
            Effect.succeed({
              isRepo: true,
              hasPrimaryRemote: true,
              isDefaultRef: scenario.checkedOut === "main",
              refName: scenario.checkedOut,
              hasWorkingTreeChanges: false,
              workingTree: { files: [], insertions: 0, deletions: 0 },
            }),
          refreshStatus: () =>
            Effect.die("turn completion must preserve known PRs and lookup backoff"),
          // Requested synchronously by refresh; the lookup itself runs in the background.
          refreshPullRequestStatus: (cwd) => {
            refreshed.push(cwd);
            return Deferred.succeed(lookedUp, undefined).pipe(Effect.as(null));
          },
        }),
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getThreadShell: () =>
            Effect.succeed({
              id: threadId,
              branch: scenario.branch,
              activeRunId: scenario.activeRun === null ? null : RunId.make(scenario.activeRun),
            } as OrchestrationV2ThreadShell),
        }),
      ),
    ),
  );
  return Effect.gen(function* () {
    const observer = yield* RunFinalization.RunFinalizationObserver;
    yield* observer.refresh({ cwd: "/repo", threadId, runId });
    if (scenario.expected.length > 0) yield* Deferred.await(lookedUp);
    assert.deepEqual(refreshed, [...scenario.expected]);
  }).pipe(Effect.provide(layer));
});
