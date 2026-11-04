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

import * as PullRequestService from "../pullRequest/PullRequestService.ts";
import * as VcsStatusBroadcaster from "../vcs/VcsStatusBroadcaster.ts";
import * as WorkspaceEntries from "../workspace/WorkspaceEntries.ts";
import * as CheckpointCapture from "./CheckpointCaptureService.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as RunFinalization from "./RunFinalizationService.ts";

it.effect("completes finalization when the post-checkpoint workspace refresh fails", () => {
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
  return Effect.gen(function* () {
    const service = yield* RunFinalization.RunFinalizationService;
    yield* service.finalize({ threadId, runId, scopeId });
    while (captured.length < 2) yield* Effect.yieldNow;
    assert.deepEqual(captured, ["checkpoint", "refresh"]);
  }).pipe(Effect.provide(layer));
});

const makeBackgroundRefreshLayer = (input: {
  readonly calls: string[];
  readonly pullRequestRefresh: Effect.Effect<void>;
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
      Effect.succeed({ id: threadId, branch: "feature", activeRunId: null } as never),
  });
  const observer = RunFinalization.layerObserver.pipe(
    Layer.provide(
      Layer.mergeAll(
        projections,
        Layer.mock(WorkspaceEntries.WorkspaceEntries)({ refresh: () => Effect.void }),
        Layer.mock(PullRequestService.PullRequestService)({ refreshAfterTurn: () => Effect.void }),
        Layer.mock(VcsStatusBroadcaster.VcsStatusBroadcaster)({
          refreshLocalStatus: () =>
            Effect.sync(() => {
              input.calls.push("local status");
              return {
                isRepo: true,
                hasPrimaryRemote: true,
                isDefaultRef: false,
                refName: "feature",
                hasWorkingTreeChanges: false,
                workingTree: { files: [], insertions: 0, deletions: 0 },
              };
            }),
          refreshPullRequestStatus: () =>
            Effect.sync(() => input.calls.push("pull request status")).pipe(
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
          execute: () => Effect.sync(() => input.calls.push("checkpoint")),
        }),
      ),
    ),
  );
  return { layer, finalizeInput: (run: string) => ({ threadId, runId: RunId.make(run), scopeId }) };
};

it.live("finalizes without waiting for a pull request refresh that never returns", () => {
  const calls: string[] = [];
  const interrupted = { value: false };
  const { layer, finalizeInput } = makeBackgroundRefreshLayer({
    calls,
    pullRequestRefresh: Effect.never.pipe(
      Effect.onInterrupt(() => Effect.sync(() => (interrupted.value = true))),
    ),
  });
  return Effect.gen(function* () {
    yield* Effect.gen(function* () {
      const service = yield* RunFinalization.RunFinalizationService;
      const finished = yield* service
        .finalize(finalizeInput("run-1"))
        .pipe(Effect.timeout("2 seconds"), Effect.as(true));
      assert.isTrue(finished);
      assert.deepEqual(calls.slice(0, 1), ["checkpoint"]);
      // The refresh still runs, and still publishes local status, after finalization returns.
      while (calls.length < 3) yield* Effect.sleep("5 millis");
      assert.deepEqual(calls, ["checkpoint", "local status", "pull request status"]);
      assert.isFalse(interrupted.value);
    }).pipe(Effect.provide(layer));
    // Shutting the service down interrupts the refresh it left running.
    assert.isTrue(interrupted.value);
  });
});

it.live("coalesces refreshes requested while one is still running", () => {
  const calls: string[] = [];
  return Effect.gen(function* () {
    const gate = yield* Deferred.make<void>();
    const { layer, finalizeInput } = makeBackgroundRefreshLayer({
      calls,
      pullRequestRefresh: Deferred.await(gate),
    });
    yield* Effect.gen(function* () {
      const service = yield* RunFinalization.RunFinalizationService;
      yield* service.finalize(finalizeInput("run-1"));
      while (!calls.includes("pull request status")) yield* Effect.sleep("5 millis");
      yield* service.finalize(finalizeInput("run-2"));
      yield* service.finalize(finalizeInput("run-3"));
      yield* Deferred.succeed(gate, undefined);
      while (calls.filter((call) => call === "pull request status").length < 2) {
        yield* Effect.sleep("5 millis");
      }
      yield* Effect.sleep("50 millis");
      assert.deepEqual(calls, [
        "checkpoint",
        "local status",
        "pull request status",
        "checkpoint",
        "checkpoint",
        "local status",
        "pull request status",
      ]);
    }).pipe(Effect.provide(layer));
  });
});

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
        label: "does not refresh during a newer active run",
        branch: "feature",
        checkedOut: "feature",
        activeRun: "newer-run",
        expected: [],
      },
    ] as const
  ).map((scenario) => [scenario.label, scenario] as const),
)("%s", ([, scenario]) => {
  const refreshed: string[] = [];
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
          refreshPullRequestStatus: (cwd) =>
            Effect.sync(() => {
              refreshed.push(cwd);
              return null;
            }),
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
    assert.deepEqual(refreshed, [...scenario.expected]);
  }).pipe(Effect.provide(layer));
});
