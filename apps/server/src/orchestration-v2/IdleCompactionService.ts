import {
  CommandId,
  IDLE_COMPACTION_TEXT,
  MessageId,
  ProviderInstanceId,
  resolveIdleCompaction,
  resolveProjectProviderInstanceEnabled,
  type OrchestrationV2AppThread,
  type ServerSettings as ServerSettingsValue,
} from "@houston-app/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as DueHint from "../scheduling/DueHint.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import { forkParked } from "../serverActivation.ts";
import * as ServerSettings from "../serverSettings.ts";
import { IDLE_COMPACTION_MAX_CACHE_TTL_MS, idleCompactionWindow } from "./IdleCompaction.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";

const DEFAULT_CLAUDE_INSTANCE_ID = ProviderInstanceId.make("claudeAgent");

const compactsBeforeCacheExpires = (
  settings: ServerSettingsValue,
  instanceId: ProviderInstanceId,
): boolean => {
  const claudeInstance = Object.hasOwn(settings.providerInstances, instanceId)
    ? settings.providerInstances[instanceId]?.driver === "claudeAgent"
    : instanceId === DEFAULT_CLAUDE_INSTANCE_ID;
  return claudeInstance && resolveIdleCompaction(settings, instanceId) === "beforeCacheExpires";
};

const anyInstanceCompactsBeforeCacheExpires = (settings: ServerSettingsValue): boolean =>
  [DEFAULT_CLAUDE_INSTANCE_ID, ...Object.keys(settings.providerInstances)].some((instanceId) =>
    compactsBeforeCacheExpires(settings, ProviderInstanceId.make(instanceId)),
  );

/**
 * Beta: sends `/compact` as a visible Houston turn shortly before an idle Claude thread's prompt
 * cache expires. Due times come from stored runs and turns, so a server restart loses none.
 */
const makeSweep = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const settings = yield* ServerSettings.ServerSettingsService;
  const due = DueHint.make();
  yield* forkParked(
    Stream.runForEach(orchestrator.streamDomainEvents, (event) =>
      event.type === "run.updated" && event.payload.status === "completed"
        ? due.invalidate
        : Effect.void,
    ),
  );
  yield* forkParked(Stream.runForEach(settings.streamChanges, () => due.invalidate));

  const eligible = (
    current: ServerSettingsValue,
    thread: Pick<OrchestrationV2AppThread, "projectId" | "providerInstanceId">,
  ) =>
    compactsBeforeCacheExpires(current, thread.providerInstanceId) &&
    resolveProjectProviderInstanceEnabled(current, thread.projectId, thread.providerInstanceId);

  // Epoch ms when the candidate becomes due, or null when it is not waiting to compact.
  const compactIfDue = Effect.fn("IdleCompactionService.compactIfDue")(
    function* (
      candidate: ProjectionStore.ProjectionIdleCompactionCandidate,
      current: ServerSettingsValue,
      nowMs: number,
    ) {
      const { threadId, runId } = candidate;
      const thread = yield* projections.getThread(threadId);
      if (!eligible(current, thread)) return null;
      const activeProviderThreadIds =
        thread.activeProviderThreadId === null ? [] : [thread.activeProviderThreadId];
      const records = yield* projections.getThreadRecords(
        threadId,
        [
          "runs",
          "messages",
          "providerThreads",
          "providerTurns",
          "runtimeRequests",
          "turnItems",
          "contextTransfers",
        ],
        {
          messageRunIds: [runId],
          turnItemStatuses: ["pending", "running", "waiting"],
          // The latest run, active runs that hold background work, and rolled-back runs whose
          // items it ignores.
          runStatuses: ["preparing", "starting", "running", "rolled_back"],
          includeLatestRun: true,
          // Without an active provider thread there is no session to compact.
          providerThreadIds: activeProviderThreadIds,
          providerTurnThreadIds: activeProviderThreadIds,
          latestProviderTurnUsageOnly: true,
          runtimeRequestStatuses: ["pending"],
          contextTransferStatuses: ["pending"],
        },
      );
      if (!eligible(current, records.thread)) return null;
      const window = idleCompactionWindow(records, nowMs, candidate.promptCacheTtlMs ?? undefined);
      // A newer run replaced the candidate's; its completion wakes the next sweep.
      if (window?.runId !== runId) return null;
      if (nowMs < window.startMs) return window.startMs;
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        // One compaction per completed run, across sweeps and restarts.
        commandId: CommandId.make(`server:idle-compact:${threadId}:${runId}`),
        messageId: MessageId.make(`idle-compact:${threadId}:${runId}`),
        threadId,
        text: IDLE_COMPACTION_TEXT,
        attachments: [],
        createdBy: "agent",
        creationSource: "server",
        idleCompaction: "beforeCacheExpires",
        compactionReason: "beforeCacheExpires",
        dispatchMode: { type: "start_immediately" },
        startOrigin: "maintenance",
      });
      return null;
    },
    (effect, candidate) =>
      effect.pipe(
        Effect.catch((cause) =>
          Effect.logWarning("idle compaction skipped", {
            threadId: candidate.threadId,
            cause,
          }).pipe(Effect.as(null)),
        ),
      ),
  );

  return Effect.fn("IdleCompactionService.sweep")(function* () {
    const now = yield* DateTime.now;
    const nowMs = DateTime.toEpochMillis(now);
    if (yield* due.isIdle(nowMs)) return;
    const readVersion = yield* due.version;
    const current = yield* settings.getSettings;
    let nextDueMs = Infinity;
    // With the setting off for every Claude instance, nothing is read.
    if (anyInstanceCompactsBeforeCacheExpires(current)) {
      const candidates = yield* projections.getIdleCompactionCandidates({
        completedAfter: DateTime.subtract(now, {
          milliseconds: IDLE_COMPACTION_MAX_CACHE_TTL_MS,
        }),
      });
      for (const candidate of candidates) {
        const dueMs = yield* compactIfDue(candidate, current, nowMs);
        if (dueMs !== null) nextDueMs = Math.min(nextDueMs, dueMs);
      }
    }
    yield* due.record(readVersion, nextDueMs, nowMs);
  });
});

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const sweep = yield* makeSweep;
    const scheduler = yield* Scheduler.Scheduler;
    yield* scheduler.register("idle-compaction", sweep());
  }),
);
