import {
  CommandId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  RunId,
  ThreadId,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ProviderTurn,
  type OrchestrationV2Run,
} from "@houston-app/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { assert, it } from "@effect/vitest";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import { ClaudeProviderCapabilitiesV2 } from "./Adapters/ClaudeAdapterV2.ts";
import * as CommandReceiptStore from "./CommandReceiptStore.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import * as LimitWindowRegistryModule from "../houston/runStart/LimitWindowRegistry.ts";
import type * as ProviderAdapter from "@houston-app/provider-core/server/ProviderAdapter";

const instanceId = ProviderInstanceId.make("claudeAgent");
const modelSelection = { instanceId, model: "claude-opus-5-5" };
const projectId = ProjectId.make("project:stale-wake");
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("claudeAgent"),
  getCapabilities: () => Effect.succeed(ClaudeProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("Runs here never reach a provider"),
} as ProviderAdapter.ProviderAdapterV2["Service"];

const layerDatabase = SqlitePersistence.layerMemory;
const layerTest = (settings: NonNullable<Parameters<typeof ServerSettings.layerTest>[0]>) =>
  ThreadManagementService.layer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        layerDatabase,
        ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
        ProviderReplayHarness.layerWithRegistry(
          { name: "stale-wake" },
          ProviderAdapterRegistry.layerFromAdapters([adapter]),
          { databaseLayer: layerDatabase, runEffectWorker: false, settings },
        ),
      ),
    ),
    Layer.provideMerge(ServerSettings.layerTest(settings)),
    Layer.provideMerge(CommandReceiptStore.layer.pipe(Layer.provide(layerDatabase))),
  );

const staleSettings = {
  snoozeLimitedThreads: true,
  holdUnlimitedThreads: true,
  providerInstances: {
    [instanceId]: {
      driver: "claudeAgent" as const,
      enabled: true,
      config: { compactStaleThreadsOnWake: true },
    },
  },
};

const createThread = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`create:${threadId}`),
      threadId,
      projectId,
      title: threadId,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: "/srv/stale-wake",
      createdBy: "user",
      creationSource: "web",
    });
  });

/** Writes the completed run and cache state a stale thread has before it wakes. */
const seedStaleThread = (threadId: ThreadId, usage?: { usedTokens?: number; ageMs?: number }) =>
  Effect.gen(function* () {
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    yield* createThread(threadId);
    const thread = yield* projections.getThread(threadId);
    const now = yield* DateTime.now;
    const nowMs = DateTime.toEpochMillis(now);
    const at = (offset: number) => DateTime.makeUnsafe(nowMs + offset);
    const providerThreadId = ProviderThreadId.make(`provider:${threadId}`);
    const runId = RunId.make(`run:${threadId}`);
    const messageId = MessageId.make(`message:${threadId}`);
    const nodeId = NodeId.make(`node:${threadId}`);
    const startedAt = at(-3 * 60 * 60_000);
    const completedAt = at(-2 * 60 * 60_000);
    const providerThread: OrchestrationV2ProviderThread = {
      id: providerThreadId,
      driver: ProviderDriverKind.make("claudeAgent"),
      providerInstanceId: instanceId,
      providerSessionId: null,
      appThreadId: threadId,
      ownerNodeId: null,
      nativeThreadRef: null,
      nativeConversationHeadRef: null,
      status: "idle",
      firstRunOrdinal: 1,
      lastRunOrdinal: 1,
      handoffIds: [],
      forkedFrom: null,
      createdAt: startedAt,
      updatedAt: now,
    };
    const message: OrchestrationV2ConversationMessage = {
      id: messageId,
      threadId,
      runId,
      nodeId,
      role: "user",
      text: "An earlier turn",
      attachments: [],
      streaming: false,
      createdBy: "user",
      creationSource: "web",
      createdAt: startedAt,
      updatedAt: startedAt,
    };
    const run: OrchestrationV2Run = {
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
      requestedAt: startedAt,
      startedAt,
      completedAt,
      checkpointId: null,
      contextHandoffId: null,
    };
    const providerTurn: OrchestrationV2ProviderTurn = {
      id: ProviderTurnId.make(`turn:${threadId}`),
      providerThreadId,
      nodeId,
      runAttemptId: null,
      nativeTurnRef: null,
      ordinal: 1,
      status: "completed",
      startedAt,
      completedAt,
      tokenUsage: {
        usedTokens: usage?.usedTokens ?? 318_000,
        autoCompactThreshold: 300_000,
        promptCacheTtlMs: 60 * 60_000,
        updatedAt: DateTime.formatIso(at(-(usage?.ageMs ?? 2 * 60 * 60_000))),
      },
    };
    const event = { threadId, occurredAt: now };
    yield* projections.apply({
      ...event,
      id: "event:thread" as never,
      type: "thread.metadata-updated",
      payload: { ...thread, activeProviderThreadId: providerThreadId, updatedAt: now },
    });
    yield* projections.apply({
      ...event,
      id: "event:provider-thread" as never,
      type: "provider-thread.updated",
      payload: providerThread,
    });
    yield* projections.apply({
      ...event,
      id: "event:run" as never,
      type: "run.updated",
      runId,
      payload: run,
    });
    yield* projections.apply({
      ...event,
      id: "event:message" as never,
      type: "message.updated",
      payload: message,
    });
    yield* projections.apply({
      ...event,
      id: "event:turn" as never,
      type: "provider-turn.updated",
      payload: providerTurn,
    });
    return { now, providerThreadId, runId, messageId, nodeId };
  });

const send = (input: {
  threadId: ThreadId;
  messageId: string;
  text: string;
  createdBy: "user" | "agent";
  creationSource: "web" | "server";
  startOrigin: "automatic" | "user";
}) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make(`wake:${input.messageId}`),
      threadId: input.threadId,
      messageId: MessageId.make(input.messageId),
      text: input.text,
      attachments: [],
      dispatchMode: { type: "start_immediately" },
      createdBy: input.createdBy,
      creationSource: input.creationSource,
      startOrigin: input.startOrigin,
    });
  });

it.layer(layerTest(staleSettings))("a stale thread compacts before its waking turn", (it) => {
  it.effect("compacts first and keeps the waking message unchanged", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const threadId = ThreadId.make("thread:stale-agent");
      yield* seedStaleThread(threadId);
      const text = "A delegated result is ready; keep this text exactly.";
      yield* send({
        threadId,
        messageId: "message:wake-agent",
        text,
        createdBy: "agent",
        creationSource: "server",
        startOrigin: "automatic",
      });
      const projection = yield* orchestrator.getThreadProjection(threadId);
      const compaction = projection.messages.find(
        (message) => message.id === "stale-compaction:message:wake-agent",
      );
      assert.equal(compaction?.text, "/compact");
      assert.equal(compaction?.compactionReason, "wake:agentMessage");
      const woke = projection.messages.find((message) => message.id === "message:wake-agent");
      assert.equal(woke?.text, text);
      const wakingRun = projection.runs.find((run) => run.userMessageId === woke?.id);
      assert.equal(wakingRun?.status, "queued");
      assert.equal(wakingRun?.queueHeldReason?.kind, "context_compaction");
      const wakingItem = projection.turnItems.find(
        (item) => item.type === "user_message" && item.messageId === woke?.id,
      );
      assert.equal(
        wakingItem?.type === "user_message"
          ? wakingItem.delivery?.queueHeldReason?.kind
          : undefined,
        "context_compaction",
      );
      const compactionRun = projection.runs.find((run) => run.userMessageId === compaction?.id);
      assert.equal(compactionRun?.status, "starting");
      assert.isBelow(compactionRun?.ordinal ?? 0, wakingRun?.ordinal ?? 0);
    }),
  );

  it.effect("starts a warm thread directly", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const threadId = ThreadId.make("thread:warm");
      yield* seedStaleThread(threadId, { ageMs: 10 * 60_000 });
      yield* send({
        threadId,
        messageId: "message:warm",
        text: "A warm wake",
        createdBy: "agent",
        creationSource: "server",
        startOrigin: "automatic",
      });
      const projection = yield* orchestrator.getThreadProjection(threadId);
      assert.isUndefined(
        projection.messages.find((message) => message.id.startsWith("stale-compaction:")),
      );
      const run = projection.runs.find((candidate) => candidate.status === "starting");
      assert.equal(run?.queueHeldReason, undefined);
    }),
  );

  it.effect("starts a small thread directly", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const threadId = ThreadId.make("thread:small");
      yield* seedStaleThread(threadId, { usedTokens: 199_000 });
      yield* send({
        threadId,
        messageId: "message:small",
        text: "A small wake",
        createdBy: "agent",
        creationSource: "server",
        startOrigin: "automatic",
      });
      const projection = yield* orchestrator.getThreadProjection(threadId);
      assert.isUndefined(
        projection.messages.find((message) => message.id.startsWith("stale-compaction:")),
      );
    }),
  );

  it.effect("makes no second compaction for the same waking message", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const threadId = ThreadId.make("thread:duplicate");
      yield* seedStaleThread(threadId);
      yield* send({
        threadId,
        messageId: "message:wake-twice",
        text: "Delivered twice",
        createdBy: "agent",
        creationSource: "server",
        startOrigin: "automatic",
      });
      yield* Effect.exit(
        orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("wake:message:wake-twice:again"),
          threadId,
          messageId: MessageId.make("message:wake-twice"),
          text: "Delivered twice",
          attachments: [],
          dispatchMode: { type: "start_immediately" },
          createdBy: "agent",
          creationSource: "server",
          startOrigin: "automatic",
        }),
      );
      const projection = yield* orchestrator.getThreadProjection(threadId);
      assert.lengthOf(
        projection.messages.filter((message) => message.id.startsWith("stale-compaction:")),
        1,
      );
    }),
  );

  it.effect("compacts first when a queued release starts the turn", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const threadId = ThreadId.make("thread:queued-release");
      const seeded = yield* seedStaleThread(threadId);
      const now = yield* DateTime.now;
      const runId = RunId.make("run:queued-release");
      const messageId = MessageId.make("message:queued-release");
      const queuedRun: OrchestrationV2Run = {
        id: runId,
        threadId,
        ordinal: 2,
        providerInstanceId: instanceId,
        modelSelection,
        providerThreadId: seeded.providerThreadId,
        userMessageId: messageId,
        rootNodeId: seeded.nodeId,
        activeAttemptId: null,
        status: "queued",
        queuePosition: 1,
        requestedAt: now,
        startedAt: null,
        completedAt: null,
        checkpointId: null,
        contextHandoffId: null,
      };
      const queuedMessage: OrchestrationV2ConversationMessage = {
        id: messageId,
        threadId,
        runId,
        nodeId: seeded.nodeId,
        role: "user",
        text: "A queued release keeps its text",
        attachments: [],
        streaming: false,
        createdBy: "agent",
        creationSource: "server",
        createdAt: now,
        updatedAt: now,
      };
      yield* projections.apply({
        id: "event:queued-run" as never,
        type: "run.updated",
        threadId,
        occurredAt: now,
        runId,
        payload: queuedRun,
      });
      yield* projections.apply({
        id: "event:queued-message" as never,
        type: "message.updated",
        threadId,
        occurredAt: now,
        payload: queuedMessage,
      });
      yield* orchestrator.dispatch({
        type: "queued-run.start",
        commandId: CommandId.make("queued-release:start"),
        threadId,
        runId,
      });
      const projection = yield* orchestrator.getThreadProjection(threadId);
      assert.isDefined(
        projection.messages.find(
          (message) => message.id === "stale-compaction:message:queued-release",
        ),
      );
      const held = projection.runs.find((run) => run.id === runId);
      assert.equal(held?.queueHeldReason?.kind, "context_compaction");
      const releasedMessage = projection.messages.find((message) => message.id === messageId);
      assert.equal(releasedMessage?.text, "A queued release keeps its text");
    }),
  );

  it.effect("never starts an automatic compaction on a limited account", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const registry = yield* LimitWindowRegistryModule.LimitWindowRegistry;
      const now = yield* DateTime.now;
      yield* registry.recordFailure({
        providerInstanceId: instanceId,
        model: null,
        resetAt: DateTime.formatIso(DateTime.add(now, { hours: 1 })),
        now,
      });
      const threadId = ThreadId.make("thread:limited");
      yield* seedStaleThread(threadId);
      yield* send({
        threadId,
        messageId: "message:limited",
        text: "A limited wake",
        createdBy: "agent",
        creationSource: "server",
        startOrigin: "automatic",
      });
      const projection = yield* orchestrator.getThreadProjection(threadId);
      assert.isUndefined(
        projection.messages.find((message) => message.id.startsWith("stale-compaction:")),
      );
      const run = projection.runs.find(
        (candidate) => candidate.userMessageId === "message:limited",
      );
      assert.equal(run?.status, "queued");
      assert.equal(run?.queueHeldReason?.kind, "usage_limit");
    }),
  );
});

const offSettings = {
  providerInstances: {
    [instanceId]: {
      driver: "claudeAgent" as const,
      enabled: true,
      config: { compactStaleThreadsOnWake: false },
    },
  },
};

it.layer(layerTest(offSettings))("the switch off keeps today's behaviour", (it) => {
  it.effect("starts directly without a compaction", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const threadId = ThreadId.make("thread:switch-off");
      yield* seedStaleThread(threadId);
      yield* send({
        threadId,
        messageId: "message:switch-off",
        text: "Switch off",
        createdBy: "agent",
        creationSource: "server",
        startOrigin: "automatic",
      });
      const projection = yield* orchestrator.getThreadProjection(threadId);
      assert.isUndefined(
        projection.messages.find((message) => message.id.startsWith("stale-compaction:")),
      );
      const run = projection.runs.find(
        (candidate) => candidate.userMessageId === "message:switch-off",
      );
      assert.equal(run?.status, "starting");
    }),
  );
});
