import { describe, expect, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  EventId,
  MessageId,
  type OrchestrationV2Command,
  type OrchestrationV2ThreadProjection,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  RunId,
  RuntimeRequestId,
  ThreadId,
} from "@houston-app/contracts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as Tracer from "effect/Tracer";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as IdleCompactionService from "./IdleCompactionService.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";

import {
  IDLE_COMPACTION_MAX_CACHE_TTL_MS,
  idleCompactionWindow,
  type IdleCompactionRecords,
} from "./IdleCompaction.ts";

const NOW_MS = Date.parse("2026-10-19T12:00:00.000Z");
const MINUTE_MS = 60_000;
const at = (offset = 0) => DateTime.makeUnsafe(NOW_MS + offset);
const threadId = ThreadId.make("idle-thread");
const runId = RunId.make("run-1");
const instanceId = ProviderInstanceId.make("claudeAgent");
const providerThreadId = ProviderThreadId.make("provider-thread");
const modelSelection = { instanceId, model: "claude-opus-5-5" };

function records(
  usage: {
    readonly usedTokens?: number;
    readonly cacheExpiresInMs?: number;
    readonly cacheTtlMs?: number;
  } = {},
): { -readonly [Key in keyof IdleCompactionRecords]: IdleCompactionRecords[Key] } {
  const messageId = MessageId.make("message-1");
  const nodeId = NodeId.make("root-node");
  return {
    thread: {
      id: threadId,
      projectId: ProjectId.make("project"),
      title: "Idle thread",
      createdBy: "user",
      creationSource: "web",
      providerInstanceId: instanceId,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      activeProviderThreadId: providerThreadId,
      lineage: { rootThreadId: threadId, parentThreadId: null, relationshipToParent: null },
      forkedFrom: null,
      createdAt: at(-MINUTE_MS),
      updatedAt: at(),
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      lastVisitedAt: at(),
      deletedAt: null,
    },
    runs: [
      {
        id: runId,
        threadId,
        ordinal: 1,
        providerInstanceId: instanceId,
        modelSelection,
        providerThreadId,
        userMessageId: messageId,
        rootNodeId: nodeId,
        activeAttemptId: null,
        status: "completed",
        requestedAt: at(-MINUTE_MS),
        startedAt: at(-MINUTE_MS),
        completedAt: at(),
        checkpointId: null,
        contextHandoffId: null,
      },
    ],
    messages: [
      {
        id: messageId,
        threadId,
        runId,
        nodeId,
        role: "user",
        text: "Explain this code",
        attachments: [],
        streaming: false,
        createdBy: "user",
        creationSource: "web",
        createdAt: at(-MINUTE_MS),
        updatedAt: at(-MINUTE_MS),
      },
    ],
    providerThreads: [
      {
        id: providerThreadId,
        driver: ProviderDriverKind.make("claudeAgent"),
        providerInstanceId: instanceId,
        providerSessionId: null,
        appThreadId: threadId,
        ownerNodeId: nodeId,
        nativeThreadRef: null,
        nativeConversationHeadRef: null,
        status: "idle",
        firstRunOrdinal: 1,
        lastRunOrdinal: 1,
        handoffIds: [],
        forkedFrom: null,
        pendingBackgroundTasks: [],
        createdAt: at(-MINUTE_MS),
        updatedAt: at(),
      },
    ],
    providerTurns: [
      {
        id: ProviderTurnId.make("provider-turn-1"),
        providerThreadId,
        nodeId,
        runAttemptId: null,
        nativeTurnRef: null,
        ordinal: 1,
        status: "completed",
        startedAt: at(-MINUTE_MS),
        completedAt: at(),
        tokenUsage: {
          usedTokens: usage.usedTokens ?? 250_000,
          ...(usage.cacheTtlMs === undefined ? {} : { promptCacheTtlMs: usage.cacheTtlMs }),
          ...(usage.cacheExpiresInMs === undefined
            ? {}
            : { promptCacheExpiresAt: DateTime.formatIso(at(usage.cacheExpiresInMs)) }),
          updatedAt: DateTime.formatIso(at()),
        },
      },
    ],
    runtimeRequests: [],
    turnItems: [],
    contextTransfers: [],
  };
}

/** The same records under ids of their own, so several threads share one store. */
function renamed(base: ReturnType<typeof records>, name: string): ReturnType<typeof records> {
  const id = ThreadId.make(`thread-${name}`);
  const providerThread = ProviderThreadId.make(`provider-thread-${name}`);
  const run = (value: RunId) => RunId.make(`${value}-${name}`);
  const message = (value: MessageId) => MessageId.make(`${value}-${name}`);
  return {
    ...base,
    thread: {
      ...base.thread,
      id,
      activeProviderThreadId: providerThread,
      lineage: { ...base.thread.lineage, rootThreadId: id },
    },
    runs: base.runs.map((entry) => ({
      ...entry,
      id: run(entry.id),
      threadId: id,
      userMessageId: message(entry.userMessageId),
      providerThreadId: providerThread,
    })),
    messages: base.messages.map((entry) => ({
      ...entry,
      id: message(entry.id),
      threadId: id,
      runId: entry.runId === null ? null : run(entry.runId),
    })),
    providerThreads: base.providerThreads.map((entry) => ({
      ...entry,
      id: providerThread,
      appThreadId: id,
    })),
    providerTurns: base.providerTurns.map((entry) => ({
      ...entry,
      id: ProviderTurnId.make(`${entry.id}-${name}`),
      providerThreadId: providerThread,
    })),
  };
}

/** A fully cached request: it reports usage but no cache lifetime. */
function withEarlierOneHourTurn(base: ReturnType<typeof records>): ReturnType<typeof records> {
  const latest = base.providerTurns[0]!;
  return {
    ...base,
    providerTurns: [
      {
        ...latest,
        id: ProviderTurnId.make(`${latest.id}-earlier`),
        ordinal: 1,
        tokenUsage: {
          ...latest.tokenUsage!,
          promptCacheTtlMs: 60 * MINUTE_MS,
          promptCacheExpiresAt: DateTime.formatIso(at(50 * MINUTE_MS)),
          updatedAt: DateTime.formatIso(at(-10 * MINUTE_MS)),
        },
      },
      { ...latest, ordinal: 2 },
    ],
  };
}

function projection(base: ReturnType<typeof records>): OrchestrationV2ThreadProjection {
  return {
    ...base,
    attempts: [],
    nodes: [],
    subagents: [],
    providerSessions: [],
    plans: [],
    checkpointScopes: [],
    checkpoints: [],
    contextHandoffs: [],
    visibleTurnItems: [],
    updatedAt: at(),
  };
}

/** Writes a thread's records through the projection store, as the orchestrator's events do. */
const writeRecords = Effect.fnUntraced(function* (data: ReturnType<typeof records>) {
  const store = yield* ProjectionStore.ProjectionStoreV2;
  const event = { threadId: data.thread.id, occurredAt: at() };
  yield* store.apply({
    ...event,
    id: EventId.make(`${data.thread.id}:created`),
    type: "thread.created",
    payload: data.thread,
  });
  for (const providerThread of data.providerThreads)
    yield* store.apply({
      ...event,
      id: EventId.make(`${providerThread.id}:updated`),
      type: "provider-thread.updated",
      payload: providerThread,
    });
  for (const turn of data.providerTurns)
    yield* store.apply({
      ...event,
      id: EventId.make(`${turn.id}:updated`),
      type: "provider-turn.updated",
      payload: turn,
    });
  for (const run of data.runs)
    yield* store.apply({
      ...event,
      id: EventId.make(`${run.id}:updated`),
      type: "run.updated",
      runId: run.id,
      payload: run,
    });
  for (const message of data.messages)
    yield* store.apply({
      ...event,
      id: EventId.make(`${message.id}:updated`),
      type: "message.updated",
      payload: message,
    });
});

describe("idleCompactionWindow", () => {
  it("skips small contexts, other providers, switched threads, compactions, and side chats", () => {
    const cache = { cacheExpiresInMs: 60 * MINUTE_MS };
    expect(idleCompactionWindow(records({ ...cache, usedTokens: 199_999 }), NOW_MS)).toBeNull();
    const codex = records(cache);
    codex.providerThreads = [
      { ...codex.providerThreads[0]!, driver: ProviderDriverKind.make("codex") },
    ];
    expect(idleCompactionWindow(codex, NOW_MS)).toBeNull();
    const switched = records(cache);
    switched.thread = { ...switched.thread, providerInstanceId: ProviderInstanceId.make("codex") };
    expect(idleCompactionWindow(switched, NOW_MS)).toBeNull();
    const compacted = records(cache);
    compacted.messages = [{ ...compacted.messages[0]!, text: "/compact" }];
    expect(idleCompactionWindow(compacted, NOW_MS)).toBeNull();
    const archived = records(cache);
    archived.thread = { ...archived.thread, archivedAt: at() };
    expect(idleCompactionWindow(archived, NOW_MS)).toBeNull();
    const sideChat = records(cache);
    expect(idleCompactionWindow(sideChat, NOW_MS)).not.toBeNull();
    sideChat.thread = {
      ...sideChat.thread,
      lineage: { ...sideChat.thread.lineage, relationshipToParent: "fork", sideChat: true },
    };
    expect(idleCompactionWindow(sideChat, NOW_MS)).toBeNull();
  });

  it("skips threads with pending work, a pending merge-back, a snooze, a settlement, or an expired cache", () => {
    const cache = { cacheExpiresInMs: 60 * MINUTE_MS, cacheTtlMs: 60 * MINUTE_MS };
    const request = records(cache);
    request.runtimeRequests = [
      {
        id: RuntimeRequestId.make("request-1"),
        nodeId: NodeId.make("root-node"),
        providerTurnId: null,
        nativeRequestRef: null,
        kind: "user_input",
        status: "pending",
        responseCapability: { type: "message" },
        createdAt: at(),
        resolvedAt: null,
      },
    ];
    expect(idleCompactionWindow(request, NOW_MS)).toBeNull();
    const mergeBack = records(cache);
    // Composed: only the fields the window reads.
    mergeBack.contextTransfers = [
      { type: "merge_back", targetThreadId: threadId, status: "pending" } as never,
    ];
    expect(idleCompactionWindow(mergeBack, NOW_MS)).toBeNull();
    const background = records(cache);
    background.providerThreads = [
      {
        ...background.providerThreads[0]!,
        pendingBackgroundTasks: [{ taskId: "bash-1", kind: "command" }],
      },
    ];
    expect(idleCompactionWindow(background, NOW_MS)).toBeNull();
    const snoozed = records(cache);
    snoozed.thread = { ...snoozed.thread, snoozedUntil: at(10 * MINUTE_MS) };
    expect(idleCompactionWindow(snoozed, NOW_MS)).toBeNull();
    const settled = records(cache);
    settled.thread = { ...settled.thread, settledAt: at() };
    expect(idleCompactionWindow(settled, NOW_MS)).toBeNull();
    expect(idleCompactionWindow(records(cache), NOW_MS + 60 * MINUTE_MS)).toBeNull();
  });

  it("derives a fully cached request's expiry from the session's latest lifetime, or skips without one", () => {
    const fullyCached = records();
    expect(idleCompactionWindow(fullyCached, NOW_MS, 60 * MINUTE_MS)).toEqual({
      runId,
      startMs: NOW_MS + 55 * MINUTE_MS,
      endMs: NOW_MS + 60 * MINUTE_MS,
    });
    // No lifetime was ever reported on this session: any guess could compact a cold cache.
    expect(idleCompactionWindow(fullyCached, NOW_MS)).toBeNull();
  });

  it("leads a five-minute cache by half its lifetime and a one-hour cache by five minutes", () => {
    expect(
      idleCompactionWindow(
        records({ cacheExpiresInMs: 5 * MINUTE_MS, cacheTtlMs: 5 * MINUTE_MS }),
        NOW_MS,
      ),
    ).toEqual({ runId, startMs: NOW_MS + 2.5 * MINUTE_MS, endMs: NOW_MS + 5 * MINUTE_MS });
    expect(
      idleCompactionWindow(
        records({ cacheExpiresInMs: 60 * MINUTE_MS, cacheTtlMs: 60 * MINUTE_MS }),
        NOW_MS,
      ),
    ).toEqual({ runId, startMs: NOW_MS + 55 * MINUTE_MS, endMs: NOW_MS + 60 * MINUTE_MS });
  });
});

describe("ProjectionStore.getIdleCompactionCandidates", () => {
  it.effect(
    "lists threads whose latest run completed recently, with the session's latest lifetime",
    () =>
      Effect.gen(function* () {
        const store = yield* ProjectionStore.ProjectionStoreV2;
        const apply = writeRecords;
        const idle = renamed(withEarlierOneHourTurn(records()), "idle");
        yield* apply(idle);
        const busy = renamed(records(), "busy");
        busy.runs = [
          ...busy.runs,
          {
            ...busy.runs[0]!,
            id: RunId.make("run-2-busy"),
            ordinal: 2,
            status: "running",
            completedAt: null,
          },
        ];
        yield* apply(busy);
        const old = renamed(records(), "old");
        old.runs = [{ ...old.runs[0]!, completedAt: at(-2 * 60 * MINUTE_MS) }];
        yield* apply(old);
        const archived = renamed(records(), "archived");
        archived.thread = { ...archived.thread, archivedAt: at() };
        yield* apply(archived);
        const subagent = renamed(records(), "subagent");
        subagent.thread = {
          ...subagent.thread,
          lineage: {
            ...subagent.thread.lineage,
            parentThreadId: idle.thread.id,
            relationshipToParent: "subagent",
          },
        };
        yield* apply(subagent);
        const codex = renamed(records(), "codex");
        codex.providerThreads = [
          { ...codex.providerThreads[0]!, driver: ProviderDriverKind.make("codex") },
        ];
        yield* apply(codex);

        const candidates = yield* store.getIdleCompactionCandidates({
          completedAfter: at(-IDLE_COMPACTION_MAX_CACHE_TTL_MS),
        });
        expect(candidates).toEqual([
          {
            threadId: idle.thread.id,
            runId: idle.runs[0]!.id,
            promptCacheTtlMs: 60 * MINUTE_MS,
          },
        ]);
      }).pipe(
        Effect.provide(
          ProjectionStore.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory)),
        ),
      ),
  );
});

describe("IdleCompactionService", () => {
  /**
   * One server's lifetime: the sweep registered with a real scheduler over a store that holds
   * `state`. A dispatch adds the compaction run, as the orchestrator does.
   */
  const serve = (input: {
    readonly state: { current: OrchestrationV2ThreadProjection };
    readonly promptCacheTtlMs?: number;
    readonly settings?: Partial<typeof DEFAULT_SERVER_SETTINGS>;
    readonly counts: { historyReads: number; candidateReads: number };
    readonly dispatched: Array<string>;
  }) =>
    IdleCompactionService.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Scheduler.layer,
          Layer.mock(Orchestrator.OrchestratorV2)({
            streamDomainEvents: Stream.never,
            dispatch: (command) =>
              Effect.sync(() => {
                input.dispatched.push(command.commandId);
                const data = input.state.current;
                const compactionRunId = RunId.make(`compaction-${input.dispatched.length}`);
                const compactionMessageId = MessageId.make(
                  `compaction-message-${input.dispatched.length}`,
                );
                input.state.current = {
                  ...data,
                  runs: [
                    ...data.runs,
                    {
                      ...data.runs.at(-1)!,
                      id: compactionRunId,
                      ordinal: data.runs.length + 1,
                      userMessageId: compactionMessageId,
                      status: "running",
                      completedAt: null,
                    },
                  ],
                  messages: [
                    ...data.messages,
                    {
                      ...data.messages[0]!,
                      id: compactionMessageId,
                      runId: compactionRunId,
                      text: "/compact",
                    },
                  ],
                };
                return { sequence: 1, storedEvents: [] };
              }),
          }),
          Layer.mock(ProjectionStore.ProjectionStoreV2)({
            getIdleCompactionCandidates: ({ completedAfter }) =>
              Effect.sync(() => {
                input.counts.candidateReads++;
                const latest = input.state.current.runs.at(-1)!;
                return latest.status === "completed" &&
                  latest.completedAt !== null &&
                  DateTime.toEpochMillis(latest.completedAt) >
                    DateTime.toEpochMillis(completedAfter)
                  ? [
                      {
                        threadId: input.state.current.thread.id,
                        runId: latest.id,
                        promptCacheTtlMs: input.promptCacheTtlMs ?? null,
                      },
                    ]
                  : [];
              }),
            getThread: () => Effect.sync(() => input.state.current.thread),
            getThreadRecords: (_threadId, _keys, options) =>
              Effect.sync(() => {
                input.counts.historyReads++;
                const data = input.state.current;
                return {
                  ...data,
                  messages: data.messages.filter(
                    (message) =>
                      options?.messageRunIds === undefined ||
                      (message.runId !== null && options.messageRunIds.includes(message.runId)),
                  ),
                };
              }),
          }),
          Layer.mock(ServerSettings.ServerSettingsService)({
            getSettings: Effect.succeed({
              ...DEFAULT_SERVER_SETTINGS,
              idleCompaction: "beforeCacheExpires",
              ...input.settings,
            }),
            streamChanges: Stream.never,
          }),
        ),
      ),
    );

  const harness = (data: ReturnType<typeof records>, promptCacheTtlMs?: number) => {
    const state = { current: projection(data) };
    const counts = { historyReads: 0, candidateReads: 0 };
    const dispatched: Array<string> = [];
    return {
      dispatched,
      counts,
      // Runs `during` while one server is up; the server stops when it returns.
      server: <A, E>(during: Effect.Effect<A, E>) =>
        during.pipe(
          Effect.provide(
            serve({
              state,
              counts,
              dispatched,
              ...(promptCacheTtlMs === undefined ? {} : { promptCacheTtlMs }),
            }),
          ),
        ),
    };
  };

  it.effect("fires a compaction that was scheduled before a restart, once", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW_MS);
      const test = harness(
        records({ cacheExpiresInMs: 60 * MINUTE_MS, cacheTtlMs: 60 * MINUTE_MS }),
      );
      yield* test.server(TestClock.adjust(10 * MINUTE_MS));
      expect(test.dispatched).toEqual([]);
      // The restarted server holds nothing in memory from the first one.
      yield* test.server(
        Effect.gen(function* () {
          yield* TestClock.adjust(44 * MINUTE_MS);
          expect(test.dispatched).toEqual([]);
          yield* TestClock.adjust(MINUTE_MS + 5_000);
          expect(test.dispatched).toEqual(["server:idle-compact:idle-thread:run-1"]);
          yield* TestClock.adjust(10 * MINUTE_MS);
        }),
      );
      // A second restart after the compaction started does not send it again.
      yield* test.server(TestClock.adjust(MINUTE_MS));
      expect(test.dispatched).toEqual(["server:idle-compact:idle-thread:run-1"]);
    }),
  );

  it.effect.each([
    { found: "with three minutes left", leftMinutes: 3, dispatched: 1 },
    { found: "with two minutes left", leftMinutes: 2, dispatched: 0 },
  ])("after a restart, compacts a thread found $found only with half its lead left", (scenario) =>
    Effect.gen(function* () {
      // A one-hour cache leads by five minutes, so at least 2.5 minutes must be left.
      yield* TestClock.setTime(NOW_MS + (60 - scenario.leftMinutes) * MINUTE_MS);
      const test = harness(
        records({ cacheExpiresInMs: 60 * MINUTE_MS, cacheTtlMs: 60 * MINUTE_MS }),
      );
      yield* test.server(TestClock.adjust(30_000));
      expect(test.dispatched.length).toBe(scenario.dispatched);
    }),
  );

  it.effect("compacts a thread whose last request was fully cached before its cache expires", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW_MS);
      const test = harness(records(), 60 * MINUTE_MS);
      yield* test.server(
        Effect.gen(function* () {
          yield* TestClock.adjust(54 * MINUTE_MS);
          expect(test.dispatched).toEqual([]);
          yield* TestClock.adjust(MINUTE_MS + 5_000);
          expect(test.dispatched).toEqual(["server:idle-compact:idle-thread:run-1"]);
        }),
      );
    }),
  );

  it.effect.each([
    { mode: "onReturn", candidateReads: 0, reads: 0 },
    { mode: "off", candidateReads: 0, reads: 0 },
    { mode: "beforeCacheExpires", candidateReads: 1, reads: 1 },
    { mode: "beforeCacheExpires", override: "off", candidateReads: 0, reads: 0 },
    { mode: "onReturn", override: "beforeCacheExpires", candidateReads: 1, reads: 1 },
    { mode: "beforeCacheExpires", projectDisabled: true, candidateReads: 1, reads: 0 },
    { mode: "beforeCacheExpires", enabled: false, candidateReads: 1, reads: 0 },
    { mode: "beforeCacheExpires", driver: "codex", instance: "codex", candidateReads: 1, reads: 0 },
    {
      mode: "beforeCacheExpires",
      driver: "codex",
      instance: "custom-codex",
      candidateReads: 1,
      reads: 0,
    },
    {
      mode: "beforeCacheExpires",
      driver: "claudeAgent",
      instance: "custom-claude",
      candidateReads: 1,
      reads: 1,
    },
    { mode: "beforeCacheExpires", unconfigured: true, candidateReads: 1, reads: 1 },
  ] as const)(
    "reads and compacts only for eligible idle compaction: $mode/$override/$enabled/$projectDisabled/$instance/$unconfigured",
    (scenario) => {
      const test = {
        override: "default",
        enabled: true,
        projectDisabled: false,
        ...scenario,
      } as const;
      return Effect.gen(function* () {
        yield* TestClock.setTime(NOW_MS);
        const selectedInstance = ProviderInstanceId.make(
          "instance" in test ? test.instance : "claudeAgent",
        );
        const driver = ProviderDriverKind.make("driver" in test ? test.driver : "claudeAgent");
        // Inside a one-hour cache's five-minute lead, with more than half of it left.
        const base = records({ cacheExpiresInMs: 4 * MINUTE_MS, cacheTtlMs: 60 * MINUTE_MS });
        const data: ReturnType<typeof records> = {
          ...base,
          thread: {
            ...base.thread,
            providerInstanceId: selectedInstance,
            modelSelection: { ...base.thread.modelSelection, instanceId: selectedInstance },
          },
          runs: base.runs.map((run) => ({
            ...run,
            providerInstanceId: selectedInstance,
            modelSelection: { ...run.modelSelection, instanceId: selectedInstance },
          })),
          providerThreads: base.providerThreads.map((thread) => ({
            ...thread,
            driver,
            providerInstanceId: selectedInstance,
          })),
        };
        const state = { current: projection(data) };
        const counts = { historyReads: 0, candidateReads: 0 };
        const dispatched: Array<string> = [];
        yield* TestClock.adjust(1_000).pipe(
          Effect.provide(
            serve({
              state,
              counts,
              dispatched,
              settings: {
                idleCompaction: test.mode,
                providerInstances:
                  "unconfigured" in test
                    ? {}
                    : {
                        [selectedInstance]: {
                          driver,
                          enabled: test.enabled,
                          config: { idleCompaction: test.override },
                        },
                      },
                projectSettingsOverrides: test.projectDisabled
                  ? {
                      [data.thread.projectId]: {
                        providerInstances: { [selectedInstance]: { enabled: false } },
                      },
                    }
                  : {},
              },
            }),
          ),
        );
        expect(counts.candidateReads).toBe(test.candidateReads);
        expect(counts.historyReads).toBe(test.reads);
        expect(dispatched.length).toBe(test.reads);
      });
    },
  );
});

describe("IdleCompactionService over a database file", () => {
  // Real: the SQLite file and its migrations, the projection store, the scheduler and the sweep.
  // Fake: the orchestrator, which records each dispatch and writes its compaction run through the
  // real store, and the settings.
  const server = (
    file: string,
    dispatched: Array<string>,
    commands: Array<OrchestrationV2Command> = [],
  ) =>
    Layer.fresh(IdleCompactionService.layer).pipe(
      Layer.provide(
        Layer.effect(
          Orchestrator.OrchestratorV2,
          Effect.gen(function* () {
            const store = yield* ProjectionStore.ProjectionStoreV2;
            return Orchestrator.OrchestratorV2.of({
              streamDomainEvents: Stream.never,
              dispatch: (command: OrchestrationV2Command) =>
                Effect.gen(function* () {
                  dispatched.push(command.commandId);
                  commands.push(command);
                  const data = records();
                  const compactionRunId = RunId.make(`compaction-${dispatched.length}`);
                  const compactionMessageId = MessageId.make(
                    `compaction-message-${dispatched.length}`,
                  );
                  yield* store.apply({
                    id: EventId.make(`${compactionRunId}:updated`),
                    type: "run.updated",
                    threadId,
                    runId: compactionRunId,
                    occurredAt: yield* DateTime.now,
                    payload: {
                      ...data.runs[0]!,
                      id: compactionRunId,
                      ordinal: 2,
                      userMessageId: compactionMessageId,
                      status: "running",
                      completedAt: null,
                    },
                  });
                  return { sequence: 1, storedEvents: [] };
                }).pipe(Effect.orDie),
            } as never);
          }),
        ),
      ),
      Layer.provideMerge(Layer.fresh(ProjectionStore.layer)),
      Layer.provide(Layer.fresh(Scheduler.layer)),
      Layer.provide(
        Layer.mock(ServerSettings.ServerSettingsService)({
          getSettings: Effect.succeed({
            ...DEFAULT_SERVER_SETTINGS,
            idleCompaction: "beforeCacheExpires",
          }),
          streamChanges: Stream.never,
        }),
      ),
      Layer.provideMerge(Layer.fresh(SqlitePersistence.layerFromPath(file))),
      Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
    );

  // Each finished sweep, so a test waits for real database reads instead of guessing.
  const sweepsTraced = Effect.gen(function* () {
    const sweeps = yield* Queue.unbounded<void>();
    const tracer = Tracer.make({
      span(options) {
        const span = new Tracer.NativeSpan(options);
        const end = span.end.bind(span);
        span.end = (...args) => {
          end(...args);
          if (span.name === "IdleCompactionService.sweep") Queue.offerUnsafe(sweeps, undefined);
        };
        return span;
      },
    });
    return { sweeps, tracer };
  });

  it.effect.each([
    { restartedAt: "with three minutes left", leftMinutes: 3, dispatched: 1 },
    { restartedAt: "with two minutes left", leftMinutes: 2, dispatched: 0 },
  ])("a fresh server over the same database compacts a due thread $restartedAt", (scenario) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "houston-idle-compaction-" });
      const file = path.join(dir, "state.sqlite");
      const dispatched: Array<string> = [];
      const commands: Array<OrchestrationV2Command> = [];
      const { sweeps, tracer } = yield* sweepsTraced;
      yield* TestClock.setTime(NOW_MS);
      // The first server: the thread completes with a one-hour cache and is not yet due.
      yield* Effect.gen(function* () {
        yield* writeRecords(
          records({ cacheExpiresInMs: 60 * MINUTE_MS, cacheTtlMs: 60 * MINUTE_MS }),
        );
        yield* TestClock.adjust(10 * MINUTE_MS);
        yield* Queue.take(sweeps);
      }).pipe(Effect.provide(server(file, dispatched, commands)), Effect.withTracer(tracer));
      expect(dispatched).toEqual([]);
      yield* Queue.clear(sweeps);
      // The restarted server, inside the one-hour cache's five-minute lead.
      yield* TestClock.setTime(NOW_MS + (60 - scenario.leftMinutes) * MINUTE_MS);
      yield* Effect.gen(function* () {
        yield* Queue.take(sweeps);
        yield* TestClock.adjust(5_000);
        yield* Queue.take(sweeps);
      }).pipe(Effect.provide(server(file, dispatched, commands)), Effect.withTracer(tracer));
      expect(dispatched).toEqual(
        scenario.dispatched === 1 ? ["server:idle-compact:idle-thread:run-1"] : [],
      );
      const idleCompaction = commands.find((command) => command.type === "message.dispatch");
      expect(
        idleCompaction?.type === "message.dispatch" ? idleCompaction.compactionReason : undefined,
      ).toBe(scenario.dispatched === 1 ? "beforeCacheExpires" : undefined);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
