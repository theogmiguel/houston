// @effect-diagnostics globalDate:off globalDateInEffect:off effectFnOpportunity:off anyUnknownInErrorContext:off - a benchmark harness: wall-clock ids and backdated marks, and query thunks kept inline for the catalogue.
// The hot-path reads and writes, called through the server's own stores. Each entry names the
// function it calls; findings map it to the SQL that function runs.
import {
  EventId,
  RunId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2TurnItem,
} from "@houston-app/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";

import * as TaskStore from "../../src/houston/tasks/TaskStore.ts";
import * as EffectOutbox from "../../src/orchestration-v2/EffectOutbox.ts";
import * as EventSink from "../../src/orchestration-v2/EventSink.ts";
import * as EventStore from "../../src/orchestration-v2/EventStore.ts";
import * as ProjectionMaintenance from "../../src/orchestration-v2/ProjectionMaintenance.ts";
import * as ProjectionStore from "../../src/orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../../src/orchestration-v2/ProjectStore.ts";
import {
  THREAD_HISTORY_PAGE_POLICY,
  THREAD_HISTORY_SNAPSHOT_ROW_LIMIT,
} from "../../src/orchestration-v2/threadHistoryPaging.ts";
import * as ThreadSearch from "../../src/orchestration-v2/ThreadSearch.ts";
import { EVENT_LOG_PRUNE_MARK } from "../../src/persistence/OrchestrationEventStore.ts";
import type { DatabaseManifest } from "./build.ts";
import { NOW_ISO, type ThreadProbe } from "./fixture.ts";

/** Where a query sits, which sets its latency budget. */
export type QueryPath = "boot" | "interactive" | "search" | "turn" | "stream" | "maintenance";

// p95 budgets: an interactive read fits one 60 Hz frame, a per-event stream write half of one;
// boot and search are one-off waits; maintenance holds the writer (docs/operations/development.md).
export const BUDGET_MS: Readonly<Record<QueryPath, number>> = {
  boot: 100,
  interactive: 16,
  search: 100,
  turn: 50,
  stream: 8,
  maintenance: 250,
};

export type Services =
  | ProjectionStore.ProjectionStoreV2
  | EventStore.EventStoreV2
  | EventSink.EventSinkV2
  | EffectOutbox.EffectOutboxV2
  | ThreadSearch.ThreadSearch
  | ProjectStore.ProjectStoreV2
  | TaskStore.HoustonTaskStore
  | ProjectionMaintenance.ProjectionMaintenanceV2
  | SqlClient.SqlClient;

export interface QueryContext {
  readonly manifest: DatabaseManifest;
  /** A typical thread of the copied unit: median turn count. */
  readonly typical: ThreadProbe;
  /** One thread whose turn count grows with the scale. */
  readonly deep: ThreadProbe;
  /** A thread whose last turn is running. */
  readonly running: ThreadProbe;
  /** Items re-written by the stream queries, read once before timing. */
  readonly streamItems: {
    readonly typical: OrchestrationV2TurnItem;
    readonly deep: OrchestrationV2TurnItem;
  };
}

export interface QuerySpec {
  readonly name: string;
  readonly path: QueryPath;
  /** The server function called (or the caller it stands for). */
  readonly calls: string;
  /** Which dimension the cost should follow: every table (breadth) or one thread's length (depth). */
  readonly grows: "breadth" | "depth";
  readonly run: (context: QueryContext) => Effect.Effect<unknown, unknown, Services>;
}

const projectionStore = Effect.service(ProjectionStore.ProjectionStoreV2);
const eventStore = Effect.service(EventStore.EventStoreV2);
const eventSink = Effect.service(EventSink.EventSinkV2);
const effectOutbox = Effect.service(EffectOutbox.EffectOutboxV2);
const threadSearch = Effect.service(ThreadSearch.ThreadSearch);
const projectStore = Effect.service(ProjectStore.ProjectStoreV2);
const taskStore = Effect.service(TaskStore.HoustonTaskStore);

const tid = (probe: ThreadProbe) => ThreadId.make(probe.threadId);

class Rollback {
  readonly _tag = "Rollback";
}

/** Runs a write inside a transaction that is always rolled back, so repetitions see the same state. */
const rolledBack = Effect.fn("DbLoad.rolledBack")(function* <A, E, R>(
  effect: Effect.Effect<A, E, R>,
) {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql.withTransaction(Effect.flatMap(effect, () => Effect.fail(new Rollback()))).pipe(
    Effect.catchIf(
      (error): error is Rollback => error instanceof Rollback,
      () => Effect.void,
    ),
  );
});

const now = DateTime.makeUnsafe(NOW_ISO);
const olderSettledBefore = new Date(Date.parse(NOW_ISO) - 7 * 86_400_000).toISOString();
let streamWrite = 0;

/** Re-writes an existing item as a streaming update does: same row, one more event. */
const rewriteItem = (item: OrchestrationV2TurnItem) =>
  Effect.flatMap(eventSink, (sink) =>
    sink.write({
      events: [
        {
          id: EventId.make(`event:db-load:stream:${item.id}:${streamWrite++}:${Date.now()}`),
          type: "turn-item.updated",
          threadId: item.threadId,
          ...(item.runId === null ? {} : { runId: item.runId }),
          occurredAt: now,
          payload: item,
        },
      ],
    }),
  );

export const QUERIES: ReadonlyArray<QuerySpec> = [
  // Boot and the shell (sidebar) subscription.
  {
    name: "shell.subscribe",
    path: "boot",
    calls:
      "ProjectionStore.listActiveShellIndex + readShellSnapshot({location: active}) (ws subscribeShell)",
    grows: "breadth",
    run: Effect.fn("DbLoad.shellSubscribe")(function* () {
      const store = yield* ProjectionStore.ProjectionStoreV2;
      yield* store.listActiveShellIndex();
      const decode = yield* store.readShellSnapshot({ location: "active" });
      return yield* decode;
    }),
  },
  {
    name: "shell.archive",
    path: "boot",
    calls: "ProjectionStore.readShellSnapshot({location: archive})",
    grows: "breadth",
    run: () =>
      Effect.flatMap(projectionStore, (store) =>
        Effect.flatten(store.readShellSnapshot({ location: "archive" })),
      ),
  },
  {
    name: "shell.olderSettled",
    path: "interactive",
    calls: "ProjectionStore.listOlderSettledThreads({before, limit: 50})",
    grows: "breadth",
    run: () =>
      Effect.flatMap(projectionStore, (store) =>
        store.listOlderSettledThreads({
          before: { settledAt: olderSettledBefore as never },
          limit: 50,
        }),
      ),
  },
  {
    name: "shell.thread",
    path: "stream",
    calls:
      "ProjectionStore.getShellSnapshot({threadIds}) (per-batch shell refresh of a running thread)",
    grows: "breadth",
    run: (c) =>
      Effect.flatMap(projectionStore, (store) =>
        store.getShellSnapshot({ threadIds: [tid(c.running)] }),
      ),
  },
  {
    name: "boot.countThreads",
    path: "boot",
    calls: "ProjectionStore.countThreads",
    grows: "breadth",
    run: () => Effect.flatMap(projectionStore, (store) => store.countThreads()),
  },
  {
    name: "boot.recoveryThreadIds",
    path: "boot",
    calls: "ProjectionStore.getRecoveryThreadIds (all four kinds)",
    grows: "breadth",
    run: () =>
      Effect.flatMap(projectionStore, (store) =>
        Effect.forEach(
          ["queued-runs", "runtime", "subagent-results", "delegated-completions"] as const,
          (kind) => store.getRecoveryThreadIds(kind),
        ),
      ),
  },
  {
    name: "boot.unreadableThreadIds",
    path: "boot",
    calls: "ProjectionStore.getUnreadableThreadIds",
    grows: "breadth",
    run: () => Effect.flatMap(projectionStore, (store) => store.getUnreadableThreadIds()),
  },
  {
    name: "boot.limitRecovery",
    path: "boot",
    calls: "ProjectionStore.getLimitRecoveryCandidates + getLimitRecoveryWakeAt",
    grows: "breadth",
    run: () =>
      Effect.flatMap(projectionStore, (store) =>
        Effect.all([
          store.getLimitRecoveryCandidates({ now, autoResume: true, snooze: true }),
          store.getLimitRecoveryWakeAt(now),
        ]),
      ),
  },
  {
    name: "boot.settlementCandidates",
    path: "boot",
    calls: "ProjectionStore.getSettlementCandidates()",
    grows: "breadth",
    run: () => Effect.flatMap(projectionStore, (store) => store.getSettlementCandidates()),
  },
  {
    name: "boot.pullRequests",
    path: "boot",
    calls: "ProjectionStore.getThreadsWithPullRequests() + getPullRequestSnapshot({unsettledOnly})",
    grows: "breadth",
    run: () =>
      Effect.flatMap(projectionStore, (store) =>
        Effect.all([
          store.getThreadsWithPullRequests(),
          store.getPullRequestSnapshot({ unsettledOnly: true }),
        ]),
      ),
  },
  {
    name: "boot.worktreePaths",
    path: "boot",
    calls: "ProjectionStore.getThreadWorktreePaths()",
    grows: "breadth",
    run: () => Effect.flatMap(projectionStore, (store) => store.getThreadWorktreePaths()),
  },
  {
    name: "boot.providerThreadRefs",
    path: "boot",
    calls: "ProjectionStore.listProviderThreadRefs()",
    grows: "breadth",
    run: () => Effect.flatMap(projectionStore, (store) => store.listProviderThreadRefs()),
  },
  {
    name: "boot.delegatedAndSubagents",
    path: "boot",
    calls: "ProjectionStore.getOpenRemoteDelegatedTasks + listActiveSubagentThreadIds",
    grows: "breadth",
    run: () =>
      Effect.flatMap(projectionStore, (store) =>
        Effect.all([store.getOpenRemoteDelegatedTasks, store.listActiveSubagentThreadIds()]),
      ),
  },
  {
    name: "boot.latestSequence",
    path: "boot",
    calls: "EventStoreV2.latestApplicationSequence",
    grows: "breadth",
    run: () => Effect.flatMap(eventStore, (events) => events.latestApplicationSequence),
  },
  {
    name: "boot.projects",
    path: "boot",
    calls: "ProjectStoreV2.listShells()",
    grows: "breadth",
    run: () => Effect.flatMap(projectStore, (projects) => projects.listShells()),
  },
  {
    name: "boot.tasks",
    path: "boot",
    calls: "HoustonTaskStore.summaries({scope: all})",
    grows: "breadth",
    run: () => Effect.flatMap(taskStore, (tasks) => tasks.summaries({ scope: "all" })),
  },
  {
    name: "boot.outboxReconcile",
    path: "boot",
    calls: "EffectOutboxV2.reconcileAfterProcessLoss",
    grows: "breadth",
    run: () => Effect.flatMap(effectOutbox, (outbox) => outbox.reconcileAfterProcessLoss),
  },
  // Opening and reading a thread.
  {
    name: "open.window.typical",
    path: "interactive",
    calls: "ProjectionStore.getThreadSnapshotWindow (ws subscribeThread, bounded)",
    grows: "breadth",
    run: (c) =>
      Effect.flatMap(projectionStore, (store) =>
        store.getThreadSnapshotWindow(tid(c.typical), {
          rowLimit: THREAD_HISTORY_SNAPSHOT_ROW_LIMIT,
          deferWork: true,
          userTurnLimit: THREAD_HISTORY_PAGE_POLICY.maxUserTurns,
        }),
      ),
  },
  {
    name: "open.window.deep",
    path: "interactive",
    calls: "ProjectionStore.getThreadSnapshotWindow (ws subscribeThread, bounded)",
    grows: "depth",
    run: (c) =>
      Effect.flatMap(projectionStore, (store) =>
        store.getThreadSnapshotWindow(tid(c.deep), {
          rowLimit: THREAD_HISTORY_SNAPSHOT_ROW_LIMIT,
          deferWork: true,
          userTurnLimit: THREAD_HISTORY_PAGE_POLICY.maxUserTurns,
        }),
      ),
  },
  {
    name: "open.projection.deep",
    path: "interactive",
    calls: "ProjectionStore.getThreadSnapshotWindow({rowLimit}) (ws getThreadProjection)",
    grows: "depth",
    run: (c) =>
      Effect.flatMap(projectionStore, (store) =>
        store.getThreadSnapshotWindow(tid(c.deep), { rowLimit: THREAD_HISTORY_SNAPSHOT_ROW_LIMIT }),
      ),
  },
  {
    name: "open.timeline.deep",
    path: "interactive",
    calls: "ProjectionStore.getTimelinePage({view: messages, limit: 50})",
    grows: "depth",
    run: (c) =>
      Effect.flatMap(projectionStore, (store) =>
        store.getTimelinePage(tid(c.deep), { view: "messages", limit: 50 }),
      ),
  },
  {
    name: "open.threadShell.deep",
    path: "interactive",
    calls: "ProjectionStore.getThreadShell",
    grows: "depth",
    run: (c) => Effect.flatMap(projectionStore, (store) => store.getThreadShell(tid(c.deep))),
  },
  {
    name: "open.counts.deep",
    path: "interactive",
    calls: "ProjectionStore.getMessageCount + getSubagentCount",
    grows: "depth",
    run: (c) =>
      Effect.flatMap(projectionStore, (store) =>
        Effect.all([store.getMessageCount(tid(c.deep)), store.getSubagentCount(tid(c.deep))]),
      ),
  },
  {
    name: "open.turnItem.deep",
    path: "interactive",
    calls: "ProjectionStore.getTurnItem (expand a tool output)",
    grows: "depth",
    run: (c) =>
      Effect.flatMap(projectionStore, (store) =>
        store.getTurnItem({ threadId: tid(c.deep), itemId: TurnItemId.make(c.deep.lastItemId) }),
      ),
  },
  {
    name: "open.replay",
    path: "interactive",
    calls: "EventStoreV2.read({afterSequence}) (resume replay of the last 200 events)",
    grows: "breadth",
    run: Effect.fn("DbLoad.resumeReplay")(function* () {
      const events = yield* EventStore.EventStoreV2;
      const head = yield* events.latestApplicationSequence;
      return yield* Stream.runCollect(events.read({ afterSequence: Math.max(0, head - 200) }));
    }),
  },
  {
    name: "open.fullProjection.typical",
    path: "interactive",
    calls: "ProjectionStore.getThreadProjection (unbounded snapshot)",
    grows: "breadth",
    run: (c) =>
      Effect.flatMap(projectionStore, (store) => store.getThreadProjection(tid(c.typical))),
  },
  {
    name: "open.fullProjection.deep",
    path: "interactive",
    calls: "ProjectionStore.getThreadProjection (unbounded snapshot)",
    grows: "depth",
    run: (c) => Effect.flatMap(projectionStore, (store) => store.getThreadProjection(tid(c.deep))),
  },
  // Search.
  {
    name: "search.messages.common",
    path: "search",
    calls: "ThreadSearch.search({query: common word})",
    grows: "breadth",
    run: () => Effect.flatMap(threadSearch, (search) => search.search({ query: "retry budget" })),
  },
  {
    name: "search.messages.rare",
    path: "search",
    calls: "ThreadSearch.search({query: rare word})",
    grows: "breadth",
    run: () => Effect.flatMap(threadSearch, (search) => search.search({ query: "lease417" })),
  },
  {
    name: "search.palette",
    path: "search",
    calls: "ThreadSearch.searchThreads({query}) (command palette)",
    grows: "breadth",
    run: () =>
      Effect.flatMap(threadSearch, (search) => search.searchThreads({ query: "render cache" })),
  },
  {
    name: "search.inThread.deep",
    path: "search",
    calls: "ProjectionStore.searchThread (find in thread)",
    grows: "depth",
    run: (c) =>
      Effect.flatMap(projectionStore, (store) =>
        store.searchThread({ threadId: tid(c.deep), query: "deadline" as never }),
      ),
  },
  // Starting and finishing a turn.
  {
    name: "turn.startContext.typical",
    path: "turn",
    calls: "ProjectionStore.getTurnStartContext",
    grows: "breadth",
    run: (c) =>
      Effect.flatMap(projectionStore, (store) =>
        store.getTurnStartContext(tid(c.typical), RunId.make(c.typical.lastRunId)),
      ),
  },
  {
    name: "turn.startContext.deep",
    path: "turn",
    calls: "ProjectionStore.getTurnStartContext",
    grows: "depth",
    run: (c) =>
      Effect.flatMap(projectionStore, (store) =>
        store.getTurnStartContext(tid(c.deep), RunId.make(c.deep.lastRunId)),
      ),
  },
  {
    name: "turn.startHistory.deep",
    path: "turn",
    calls: "ProjectionStore.getTurnStartHistory",
    grows: "depth",
    run: (c) => Effect.flatMap(projectionStore, (store) => store.getTurnStartHistory(tid(c.deep))),
  },
  {
    name: "turn.recoveryProjection.deep",
    path: "turn",
    calls: "ProjectionStore.getRuntimeRecoveryProjection",
    grows: "depth",
    run: (c) =>
      Effect.flatMap(projectionStore, (store) => store.getRuntimeRecoveryProjection(tid(c.deep))),
  },
  {
    name: "turn.providerContext.deep",
    path: "turn",
    calls: "ProjectionStore.getThreadProviderContext + getCheckpointContext",
    grows: "depth",
    run: (c) =>
      Effect.flatMap(projectionStore, (store) =>
        Effect.all([
          store.getThreadProviderContext(tid(c.deep)),
          store.getCheckpointContext(tid(c.deep)),
        ]),
      ),
  },
  {
    name: "turn.queue.deep",
    path: "turn",
    calls: "ProjectionStore.canStartQueuedRun + getHeldQueuedRuns + getRunMessage",
    grows: "depth",
    run: (c) =>
      Effect.flatMap(projectionStore, (store) =>
        Effect.all([
          store.canStartQueuedRun(tid(c.deep)),
          store.getHeldQueuedRuns(tid(c.deep)),
          store.getRunMessage(tid(c.deep), RunId.make(c.deep.lastRunId)),
        ]),
      ),
  },
  // Streaming provider events into a running turn.
  {
    name: "stream.writeItem.typical",
    path: "stream",
    calls: "EventSinkV2.write(turn-item.updated) (event append + projection apply)",
    grows: "breadth",
    run: (c) => rewriteItem(c.streamItems.typical),
  },
  {
    name: "stream.writeItem.deep",
    path: "stream",
    calls: "EventSinkV2.write(turn-item.updated) (event append + projection apply)",
    grows: "depth",
    run: (c) => rewriteItem(c.streamItems.deep),
  },
  {
    name: "stream.nextOrdinal.deep",
    path: "stream",
    calls: "ProjectionStore.getNextTurnItemOrdinal + getRunningTurnContext",
    grows: "depth",
    run: (c) =>
      Effect.flatMap(projectionStore, (store) =>
        Effect.all([
          store.getNextTurnItemOrdinal(tid(c.deep)),
          store.getRunningTurnContext(tid(c.running)),
        ]),
      ),
  },
  {
    name: "stream.outboxPoll",
    path: "stream",
    calls: "EffectOutboxV2.claimNext + nextClaimableAt (worker poll, nothing pending)",
    grows: "breadth",
    run: () =>
      Effect.flatMap(effectOutbox, (outbox) =>
        Effect.all([outbox.claimNext({ workerId: "db-load" }), outbox.nextClaimableAt]),
      ),
  },
  // Background maintenance, rolled back so each repetition does the same work.
  {
    name: "maint.pruneEventLog",
    path: "maintenance",
    calls: "ProjectionMaintenanceV2.pruneEventStore (daily pass, mark due)",
    grows: "breadth",
    run: () =>
      rolledBack(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const maintenance = yield* ProjectionMaintenance.ProjectionMaintenanceV2;
          const backdated = new Date(Date.now() - 2 * 86_400_000).toISOString();
          yield* sql`
            UPDATE orchestration_v2_projection_metadata SET updated_at = ${backdated}
            WHERE projection_name = ${EVENT_LOG_PRUNE_MARK}
          `;
          return yield* maintenance.pruneEventStore();
        }),
      ),
  },
  {
    name: "maint.pruneOutbox",
    path: "maintenance",
    calls: "EffectOutboxV2.pruneSettled",
    grows: "breadth",
    run: () => rolledBack(Effect.flatMap(effectOutbox, (outbox) => outbox.pruneSettled)),
  },
];

/** Picks the probe threads and reads the items the stream queries re-write. */
export const makeContext = Effect.fn("DbLoad.makeContext")(function* (manifest: DatabaseManifest) {
  const store = yield* ProjectionStore.ProjectionStoreV2;
  const open = manifest.unit.threads.filter((thread) => !thread.archived && thread.runCount > 1);
  const byRuns = [...open].sort((a, b) => a.runCount - b.runCount);
  const typical = byRuns[Math.floor(byRuns.length / 2)]!;
  const running = manifest.unit.threads.find(
    (thread) => thread.threadId === manifest.unit.runningThreadId,
  )!;
  const item = (probe: ThreadProbe) =>
    store.getTurnItem({ threadId: tid(probe), itemId: TurnItemId.make(probe.lastItemId) }).pipe(
      Effect.filterOrElse(
        (found): found is OrchestrationV2TurnItem => found !== null,
        () =>
          Effect.die(
            new Error(`Probe item ${probe.lastItemId} of thread ${probe.threadId} is missing.`),
          ),
      ),
    );
  return {
    manifest,
    typical,
    deep: manifest.deep,
    running,
    streamItems: { typical: yield* item(typical), deep: yield* item(manifest.deep) },
  } satisfies QueryContext;
});
