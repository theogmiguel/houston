import {
  CommandId,
  type OrchestrationV2DomainEvent,
  type ServerProvider,
} from "@houston-app/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import * as ProviderRegistry from "../../provider/ProviderRegistry.ts";
import * as Scheduler from "../../scheduling/Scheduler.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as Orchestrator from "../../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import * as ThreadManagementService from "../../orchestration-v2/ThreadManagementService.ts";
import { forkParked } from "../../serverActivation.ts";
import { limitWindowState, MAX_HOLD_WITHOUT_RESET_MS } from "./LimitsAdmission.ts";
import { LimitWindowRegistry, type LimitWindowRecord } from "./LimitWindowRegistry.ts";

/** Usage readings refresh at most this often while a hold exists. */
export const BACKGROUND_REFRESH_MS = 15 * 60 * 1000;

const activeWindows = (windows: ReadonlyArray<LimitWindowRecord>, nowMs: number) =>
  windows.filter((record) => limitWindowState(record, nowMs).active);

/** Import the provider's own reported windows; a window at 100% is a known limit. */
export const recordReportedWindows = Effect.fn("AccountLimitHoldWorker.recordReportedWindows")(
  function* (input: {
    readonly registry: LimitWindowRegistry["Service"];
    readonly providers: ReadonlyArray<Pick<ServerProvider, "instanceId" | "usageLimits">>;
    readonly now: DateTime.Utc;
  }) {
    for (const provider of input.providers) {
      for (const window of provider.usageLimits?.windows ?? []) {
        yield* input.registry.recordReported({
          providerInstanceId: provider.instanceId,
          scope: window.id,
          resetAt: window.resetsAt ?? null,
          usedPercent: window.usedPercent,
          now: input.now,
        });
      }
    }
  },
);

const makeWorker = Effect.gen(function* () {
  const registry = yield* LimitWindowRegistry;
  const providers = yield* ProviderRegistry.ProviderRegistry;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const settings = yield* ServerSettings.ServerSettingsService;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const lastRefresh = yield* Ref.make<ReadonlyMap<string, number>>(new Map());

  const refreshReported = Effect.fn("AccountLimitHoldWorker.refreshReported")(function* (
    now: DateTime.Utc,
  ) {
    const nowMs = DateTime.toEpochMillis(now);
    const windows = activeWindows(yield* registry.list, nowMs);
    const instanceIds = [...new Set(windows.map((window) => window.providerInstanceId))];
    for (const instanceId of instanceIds) {
      const refreshed = yield* Ref.get(lastRefresh);
      if (nowMs - (refreshed.get(instanceId) ?? 0) < BACKGROUND_REFRESH_MS) continue;
      yield* Ref.update(lastRefresh, (current) => new Map(current).set(instanceId, nowMs));
      yield* providers.refreshInstance(instanceId).pipe(Effect.ignoreCause({ log: true }));
    }
    yield* recordReportedWindows({
      registry,
      providers: yield* providers.getProviders,
      now,
    });
  });

  const releaseOneTest = Effect.fn("AccountLimitHoldWorker.releaseOneTest")(function* (
    now: DateTime.Utc,
  ) {
    const nowMs = DateTime.toEpochMillis(now);
    const windows = (yield* registry.list).filter((window) => {
      if (window.resetAt !== null) return false;
      if (nowMs - Date.parse(window.observedAt) >= MAX_HOLD_WITHOUT_RESET_MS) return false;
      const nextTestMs = window.nextTestAt === null ? null : Date.parse(window.nextTestAt);
      return nextTestMs === null || Number.isFinite(nextTestMs)
        ? (nextTestMs ?? 0) <= nowMs
        : false;
    });
    for (const window of windows) {
      const threadIds = yield* projections.getRecoveryThreadIds("queued-runs");
      let released = false;
      for (const threadId of threadIds) {
        if (released) break;
        const held = yield* projections.getHeldQueuedRuns(threadId);
        const run = held.find(
          (candidate) =>
            candidate.queueHeldReason?.kind === "usage_limit" &&
            candidate.queueHeldReason.providerInstanceId === window.providerInstanceId,
        );
        if (run === undefined) continue;
        released = true;
        yield* threads
          .dispatch({
            type: "queued-run.start",
            commandId: CommandId.make(
              `limit-test-release:${window.providerInstanceId}:${run.id}:${window.testAttempt + 1}`,
            ),
            threadId,
            runId: run.id,
          })
          .pipe(Effect.ignoreCause({ log: true }));
        yield* registry.recordTestAttempt({
          providerInstanceId: window.providerInstanceId,
          scope: window.scope,
          now,
        });
      }
    }
  });

  const sweep = Effect.fn("AccountLimitHoldWorker.sweep")(function* () {
    const preferences = yield* settings.getSettings;
    if (!preferences.snoozeLimitedThreads || !preferences.holdUnlimitedThreads) return;
    const now = yield* DateTime.now;
    yield* refreshReported(now);
    yield* releaseOneTest(now);
  });

  // A no-reset window clears once a test release's run completes; a reported reading that
  // drops below 100% clears it through `recordReported`.
  yield* forkParked(
    Stream.runForEach(orchestrator.streamDomainEvents, (event: OrchestrationV2DomainEvent) =>
      event.type === "run.updated" && event.payload.status === "completed"
        ? Effect.gen(function* () {
            const instanceId = event.payload.providerInstanceId;
            const windows = yield* registry.read(instanceId);
            const untimed = windows.filter((window) => window.resetAt === null);
            if (!untimed.some((window) => window.testAttempt > 0)) return;
            yield* registry.clear(instanceId);
            // A successful test releases the rest of the instance's held work in queue order.
            const threadIds = yield* projections.getRecoveryThreadIds("queued-runs");
            for (const threadId of threadIds) {
              const held = yield* projections.getHeldQueuedRuns(threadId);
              if (
                !held.some(
                  (run) =>
                    run.queueHeldReason?.kind === "usage_limit" &&
                    run.queueHeldReason.providerInstanceId === instanceId,
                )
              )
                continue;
              yield* threads
                .dispatch({
                  type: "queue.resume",
                  commandId: CommandId.make(`limit-clear:${instanceId}:${threadId}`),
                  threadId,
                })
                .pipe(Effect.ignoreCause({ log: true }));
            }
          })
        : Effect.void,
    ),
  );
  yield* forkParked(
    Stream.runForEach(providers.streamChanges, (providerList) =>
      Effect.gen(function* () {
        const now = yield* DateTime.now;
        yield* recordReportedWindows({ registry, providers: providerList, now });
      }),
    ),
  );

  return sweep;
});

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const sweep = yield* makeWorker;
    const scheduler = yield* Scheduler.Scheduler;
    yield* scheduler.register("account-limit-hold", sweep());
  }),
);
