import {
  type OrchestrationV2DomainEvent,
  type ProviderInstanceId,
  type ServerProvider,
  type ServerProviderModel,
  type ServerProviderUsageWindow,
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
import {
  LimitWindowRegistry,
  limitReleaseCommandId,
  type LimitWindowRecord,
} from "./LimitWindowRegistry.ts";

/** Usage readings refresh at most this often while a hold exists. */
export const BACKGROUND_REFRESH_MS = 15 * 60 * 1000;

/** Either hold setting can leave work waiting, so either keeps the account sweep alive. */
export function accountLimitSweepEnabled(preferences: {
  readonly snoozeLimitedThreads: boolean;
  readonly holdUnlimitedThreads: boolean;
}): boolean {
  return preferences.snoozeLimitedThreads || preferences.holdUnlimitedThreads;
}

const activeWindows = (windows: ReadonlyArray<LimitWindowRecord>, nowMs: number) =>
  windows.filter((record) => limitWindowState(record, nowMs).active);

const NON_ALPHANUMERIC_RUN = /[^a-z0-9]+/g;

function modelScopeSlug(name: string): string {
  return name.toLowerCase().replace(NON_ALPHANUMERIC_RUN, "_");
}

/** A model-only weekly window holds only that model; every other window is the account. */
export function reportedWindowScope(
  window: Pick<ServerProviderUsageWindow, "id" | "label">,
  models: ReadonlyArray<Pick<ServerProviderModel, "slug" | "name">>,
): string {
  if (!window.id.startsWith("seven_day_") || window.id === "seven_day") return "*";
  const suffix = window.id.slice("seven_day_".length);
  const display = window.label.includes("·")
    ? window.label.split("·").at(-1)?.trim().toLowerCase()
    : undefined;
  const match = models.find((model) => {
    const name = model.name.toLowerCase();
    const slug = modelScopeSlug(model.name);
    return (
      slug === suffix ||
      slug.startsWith(`${suffix}_`) ||
      model.slug === suffix ||
      (display !== undefined && (name === display || name.includes(display)))
    );
  });
  return match?.slug ?? "*";
}

/** Import the provider's own reported windows; one record per account or model scope. */
export const recordReportedWindows = Effect.fn("AccountLimitHoldWorker.recordReportedWindows")(
  function* (input: {
    readonly registry: LimitWindowRegistry["Service"];
    readonly providers: ReadonlyArray<
      Pick<ServerProvider, "instanceId" | "usageLimits" | "models">
    >;
    readonly now: DateTime.Utc;
  }) {
    const nowMs = DateTime.toEpochMillis(input.now);
    for (const provider of input.providers) {
      const groups = new Map<string, Array<ServerProviderUsageWindow>>();
      for (const window of provider.usageLimits?.windows ?? []) {
        const scope = reportedWindowScope(window, provider.models ?? []);
        const list = groups.get(scope) ?? [];
        list.push(window);
        groups.set(scope, list);
      }
      for (const [scope, windows] of groups) {
        const limited = windows.filter((window) => window.usedPercent >= 100);
        const timed = limited
          .filter(
            (window) =>
              window.resetsAt !== undefined &&
              window.resetsAt !== null &&
              Date.parse(window.resetsAt) > nowMs,
          )
          .toSorted((left, right) => Date.parse(right.resetsAt!) - Date.parse(left.resetsAt!));
        const chosen = timed[0] ?? limited.find((window) => window.resetsAt === undefined);
        yield* input.registry.recordReported({
          providerInstanceId: provider.instanceId,
          scope,
          resetAt: chosen?.resetsAt ?? null,
          usedPercent: chosen === undefined ? 0 : 100,
          now: input.now,
        });
      }
    }
  },
);

/** The untimed window a completed run's test release belongs to; unrelated runs clear nothing. */
export function testReleaseWindowToClear(input: {
  readonly runId: string;
  readonly testReleases: ReadonlyMap<
    string,
    { readonly instanceId: ProviderInstanceId; readonly scope: string; readonly observedAt: string }
  >;
  readonly windows: ReadonlyArray<LimitWindowRecord>;
}): LimitWindowRecord | null {
  const test = input.testReleases.get(input.runId);
  if (test === undefined) return null;
  return (
    input.windows.find(
      (window) =>
        window.providerInstanceId === test.instanceId &&
        window.scope === test.scope &&
        window.resetAt === null,
    ) ?? null
  );
}

const makeWorker = Effect.gen(function* () {
  const registry = yield* LimitWindowRegistry;
  const providers = yield* ProviderRegistry.ProviderRegistry;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const settings = yield* ServerSettings.ServerSettingsService;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const lastRefresh = yield* Ref.make<ReadonlyMap<string, number>>(new Map());
  // The run a test release started, so only that run's completion clears its window.
  const testReleases = yield* Ref.make<
    ReadonlyMap<
      string,
      {
        readonly instanceId: ProviderInstanceId;
        readonly scope: string;
        readonly observedAt: string;
      }
    >
  >(new Map());

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
            candidate.queueHeldReason.providerInstanceId === window.providerInstanceId &&
            (window.scope === "*" || candidate.modelSelection.model === window.scope),
        );
        if (run === undefined) continue;
        released = true;
        yield* threads
          .dispatch({
            type: "queued-run.release",
            commandId: limitReleaseCommandId({
              prefix: "limit-test-release",
              threadId,
              runId: run.id,
              occurrence: `${window.observedAt}:${window.testAttempt + 1}`,
            }),
            threadId,
            runId: run.id,
          })
          .pipe(Effect.ignoreCause({ log: true }));
        yield* Ref.update(testReleases, (current) =>
          new Map(current).set(run.id, {
            instanceId: window.providerInstanceId,
            scope: window.scope,
            observedAt: window.observedAt,
          }),
        );
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
    if (!accountLimitSweepEnabled(preferences)) return;
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
            const test = (yield* Ref.get(testReleases)).get(event.payload.id);
            if (test === undefined) return;
            yield* Ref.update(testReleases, (current) => {
              const next = new Map(current);
              next.delete(event.payload.id);
              return next;
            });
            const windows = yield* registry.read(test.instanceId);
            const window = testReleaseWindowToClear({
              runId: event.payload.id,
              testReleases: new Map([[event.payload.id, test]]),
              windows,
            });
            if (window === null) return;
            // Only the window this test released clears; a timed or other model window stays.
            yield* registry.clear(test.instanceId, test.scope);
            // A successful test releases the rest of that scope's held work in queue order.
            const threadIds = yield* projections.getRecoveryThreadIds("queued-runs");
            for (const threadId of threadIds) {
              const held = yield* projections.getHeldQueuedRuns(threadId);
              for (const run of held) {
                if (
                  run.queueHeldReason?.kind !== "usage_limit" ||
                  run.queueHeldReason.providerInstanceId !== test.instanceId ||
                  (test.scope !== "*" && run.modelSelection.model !== test.scope)
                )
                  continue;
                yield* threads
                  .dispatch({
                    type: "queued-run.release",
                    commandId: limitReleaseCommandId({
                      prefix: "limit-clear",
                      threadId,
                      runId: run.id,
                      occurrence: test.observedAt,
                    }),
                    threadId,
                    runId: run.id,
                  })
                  .pipe(Effect.ignoreCause({ log: true }));
              }
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
