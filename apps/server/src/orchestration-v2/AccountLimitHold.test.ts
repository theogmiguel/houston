import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TurnItemId,
} from "@houston-app/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { assert, it } from "@effect/vitest";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as CommandReceiptStore from "./CommandReceiptStore.ts";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import * as LimitWindowRegistryModule from "../houston/runStart/LimitWindowRegistry.ts";
import type * as ProviderAdapter from "@houston-app/provider-core/server/ProviderAdapter";

const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "gpt-5.1-codex" };
const projectId = ProjectId.make("project:account-limit");
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("Runs here never reach a provider"),
} as ProviderAdapter.ProviderAdapterV2["Service"];

const layerDatabase = SqlitePersistence.layerMemory;
const layerTest = ThreadManagementService.layer.pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      layerDatabase,
      ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
      ProviderReplayHarness.layerWithRegistry(
        { name: "account-limit-hold" },
        ProviderAdapterRegistry.layerFromAdapters([adapter]),
        {
          databaseLayer: layerDatabase,
          runEffectWorker: false,
          settings: {
            snoozeLimitedThreads: true,
            holdUnlimitedThreads: true,
            holdAgentMessagesAfterStop: true,
          },
        },
      ),
    ),
  ),
  Layer.provideMerge(
    ServerSettings.layerTest({
      snoozeLimitedThreads: true,
      holdUnlimitedThreads: true,
      holdAgentMessagesAfterStop: true,
    }),
  ),
  Layer.provideMerge(CommandReceiptStore.layer.pipe(Layer.provide(layerDatabase))),
);

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
      worktreePath: "/srv/account-limit",
      createdBy: "user",
      creationSource: "web",
    });
  });

it.layer(layerTest)("account limit hold", (it) => {
  it.effect("holds an automatic turn on a thread that has not hit the limit", () =>
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
      const threadId = ThreadId.make("thread:account-limit-automatic");
      yield* createThread(threadId);
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make(`send:${threadId}`),
        threadId,
        messageId: MessageId.make(`message:${threadId}`),
        text: "Background note",
        attachments: [],
        dispatchMode: { type: "start_immediately" },
        createdBy: "agent",
        creationSource: "server",
        startOrigin: "automatic",
      });
      const projection = yield* orchestrator.getThreadProjection(threadId);
      const run = projection.runs.at(-1);
      assert.equal(run?.status, "queued");
      assert.isTrue(run?.queueHeld);
      assert.equal(run?.queueHeldReason?.kind, "usage_limit");
      assert.isNotNull(run?.queueHeldReason?.releaseAt);
    }),
  );

  it.effect("starts a user message on the same limited account", () =>
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
      const threadId = ThreadId.make("thread:account-limit-user");
      yield* createThread(threadId);
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make(`send:${threadId}`),
        threadId,
        messageId: MessageId.make(`message:${threadId}`),
        text: "A typed send",
        attachments: [],
        dispatchMode: { type: "start_immediately" },
        createdBy: "user",
        creationSource: "web",
        startOrigin: "user",
      });
      const projection = yield* orchestrator.getThreadProjection(threadId);
      assert.equal(projection.runs.at(-1)?.status, "starting");
    }),
  );

  it.effect("one banner start releases every held usage-limit item in queue order", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const eventSink = yield* EventSink.EventSinkV2;
      const registry = yield* LimitWindowRegistryModule.LimitWindowRegistry;
      const now = yield* DateTime.now;
      yield* registry.recordFailure({
        providerInstanceId: instanceId,
        model: null,
        resetAt: DateTime.formatIso(DateTime.add(now, { hours: 1 })),
        now,
      });
      const threadId = ThreadId.make("thread:account-limit-release-all");
      yield* createThread(threadId);
      for (const key of ["first", "second", "third"]) {
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make(`send:${threadId}:${key}`),
          threadId,
          messageId: MessageId.make(`message:${threadId}:${key}`),
          text: key,
          attachments: [],
          dispatchMode: { type: "start_immediately" },
          createdBy: "agent",
          creationSource: "server",
          startOrigin: "automatic",
        });
      }
      const held = yield* orchestrator.getThreadProjection(threadId);
      const ordered = held.runs
        .filter((run) => run.status === "queued" && run.queueHeld === true)
        .toSorted(
          (left, right) =>
            (left.queuePosition ?? left.ordinal) - (right.queuePosition ?? right.ordinal),
        );
      assert.lengthOf(ordered, 3);

      yield* orchestrator.dispatch({
        type: "queued-run.start",
        commandId: CommandId.make(`start:${threadId}:first`),
        threadId,
        runId: ordered[0]!.id,
        releaseThreadHolds: true,
      });

      const started = yield* orchestrator.getThreadProjection(threadId);
      assert.equal(started.runs.find((run) => run.id === ordered[0]!.id)?.status, "starting");
      for (const run of ordered.slice(1)) {
        const row = started.runs.find((candidate) => candidate.id === run.id);
        assert.isFalse(row?.queueHeld === true);
        assert.isTrue(row?.releasedUsageLimitHold === true);
      }

      let activeId = ordered[0]!.id;
      for (const next of ordered.slice(1)) {
        const active = (yield* orchestrator.getThreadProjection(threadId)).runs.find(
          (run) => run.id === activeId,
        )!;
        const completedAt = yield* DateTime.now;
        yield* eventSink.write({
          events: [
            {
              id: EventId.make(`done:${activeId}`),
              type: "run.updated",
              threadId,
              occurredAt: completedAt,
              payload: { ...active, status: "completed", completedAt },
            },
          ],
        });
        yield* orchestrator.resumeQueuedRuns;
        const after = yield* orchestrator.getThreadProjection(threadId);
        const startedNext = after.runs.find((run) => run.id === next.id);
        assert.equal(startedNext?.status, "starting");
        assert.isFalse(startedNext?.queueHeld === true);
        activeId = next.id;
      }
    }),
  );

  it.effect("a typed send still starts while automatic items stay held", () =>
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
      const threadId = ThreadId.make("thread:account-limit-user-with-holds");
      yield* createThread(threadId);
      for (const key of ["auto-one", "auto-two"]) {
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make(`auto:${threadId}:${key}`),
          threadId,
          messageId: MessageId.make(`auto-message:${threadId}:${key}`),
          text: key,
          attachments: [],
          dispatchMode: { type: "start_immediately" },
          createdBy: "agent",
          creationSource: "server",
          startOrigin: "automatic",
        });
      }
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make(`typed:${threadId}`),
        threadId,
        messageId: MessageId.make(`typed-message:${threadId}`),
        text: "A typed send",
        attachments: [],
        dispatchMode: { type: "start_immediately" },
        createdBy: "user",
        creationSource: "web",
        startOrigin: "user",
      });
      const projection = yield* orchestrator.getThreadProjection(threadId);
      assert.equal(
        projection.runs.find((run) => run.userMessageId === `typed-message:${threadId}`)?.status,
        "starting",
      );
      for (const message of projection.messages.filter((row) =>
        row.id.startsWith(`auto-message:${threadId}`),
      )) {
        const run = projection.runs.find((candidate) => candidate.id === message.runId);
        assert.equal(run?.status, "queued");
        assert.isTrue(run?.queueHeld === true);
      }
    }),
  );

  it.effect("a queued row's Send now releases only that held usage-limit item", () =>
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
      const threadId = ThreadId.make("thread:account-limit-send-one");
      yield* createThread(threadId);
      for (const key of ["first", "second"]) {
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make(`send:${threadId}:${key}`),
          threadId,
          messageId: MessageId.make(`message:${threadId}:${key}`),
          text: key,
          attachments: [],
          dispatchMode: { type: "start_immediately" },
          createdBy: "agent",
          creationSource: "server",
          startOrigin: "automatic",
        });
      }
      const held = yield* orchestrator.getThreadProjection(threadId);
      const ordered = held.runs
        .filter((run) => run.status === "queued" && run.queueHeld === true)
        .toSorted(
          (left, right) =>
            (left.queuePosition ?? left.ordinal) - (right.queuePosition ?? right.ordinal),
        );
      assert.lengthOf(ordered, 2);

      yield* orchestrator.dispatch({
        type: "queued-run.start",
        commandId: CommandId.make(`send-now:${threadId}:first`),
        threadId,
        runId: ordered[0]!.id,
      });

      const after = yield* orchestrator.getThreadProjection(threadId);
      assert.equal(after.runs.find((run) => run.id === ordered[0]!.id)?.status, "starting");
      const remaining = after.runs.find((run) => run.id === ordered[1]!.id);
      assert.equal(remaining?.status, "queued");
      assert.isTrue(remaining?.queueHeld === true);
      assert.isFalse(remaining?.releasedUsageLimitHold === true);
    }),
  );

  it.effect("a server release leaves a Stop hold and a compaction hold in place", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const eventSink = yield* EventSink.EventSinkV2;
      const registry = yield* LimitWindowRegistryModule.LimitWindowRegistry;
      const now = yield* DateTime.now;
      yield* registry.recordFailure({
        providerInstanceId: instanceId,
        model: null,
        resetAt: DateTime.formatIso(DateTime.add(now, { hours: 1 })),
        now,
      });
      const threadId = ThreadId.make("thread:account-limit-stop-and-compaction");
      yield* createThread(threadId);
      for (const key of ["first", "second", "third"]) {
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make(`send:${threadId}:${key}`),
          threadId,
          messageId: MessageId.make(`message:${threadId}:${key}`),
          text: key,
          attachments: [],
          dispatchMode: { type: "start_immediately" },
          createdBy: "agent",
          creationSource: "server",
          startOrigin: "automatic",
        });
      }
      const held = yield* orchestrator.getThreadProjection(threadId);
      const ordered = held.runs
        .filter((run) => run.status === "queued" && run.queueHeld === true)
        .toSorted(
          (left, right) =>
            (left.queuePosition ?? left.ordinal) - (right.queuePosition ?? right.ordinal),
        );
      assert.lengthOf(ordered, 3);
      const compactionRun = ordered[2]!;
      yield* eventSink.write({
        events: [
          {
            id: EventId.make(`stop:${threadId}`),
            type: "thread.metadata-updated",
            threadId,
            occurredAt: now,
            payload: { ...held.thread, heldAfterStop: true, updatedAt: now },
          },
          {
            id: EventId.make(`compaction:${threadId}`),
            type: "run.updated",
            threadId,
            runId: compactionRun.id,
            occurredAt: now,
            payload: {
              ...compactionRun,
              queueHeld: true,
              queueHeldReason: {
                kind: "context_compaction",
                message: "Compacting first.",
                providerInstanceId: instanceId,
              },
            },
          },
        ],
      });

      yield* orchestrator.dispatch({
        type: "queued-run.release",
        commandId: CommandId.make(`release:${threadId}`),
        threadId,
        runId: ordered[0]!.id,
        releaseThreadHolds: true,
      });

      const after = yield* orchestrator.getThreadProjection(threadId);
      assert.isTrue(after.thread.heldAfterStop === true);
      const first = after.runs.find((run) => run.id === ordered[0]!.id);
      assert.equal(first?.status, "queued");
      assert.equal(first?.queueHeldReason?.kind, "stopped_thread");
      const compaction = after.runs.find((run) => run.id === compactionRun.id);
      assert.equal(compaction?.status, "queued");
      assert.equal(compaction?.queueHeldReason?.kind, "context_compaction");
    }),
  );

  it.effect("a queued message keeps the start origin its producer set", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const eventSink = yield* EventSink.EventSinkV2;
      const registry = yield* LimitWindowRegistryModule.LimitWindowRegistry;
      const now = yield* DateTime.now;
      yield* registry.recordFailure({
        providerInstanceId: instanceId,
        model: null,
        resetAt: DateTime.formatIso(DateTime.add(now, { hours: 1 })),
        now,
      });
      const threadId = ThreadId.make("thread:account-limit-queued-origin");
      yield* createThread(threadId);
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make(`active:${threadId}`),
        threadId,
        messageId: MessageId.make(`active-message:${threadId}`),
        text: "Active",
        attachments: [],
        dispatchMode: { type: "start_immediately" },
        createdBy: "user",
        creationSource: "web",
        startOrigin: "user",
      });
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make(`queued:${threadId}`),
        threadId,
        messageId: MessageId.make(`queued-message:${threadId}`),
        text: "Review findings",
        attachments: [],
        dispatchMode: { type: "queue_after_active" },
        createdBy: "user",
        creationSource: "server",
        startOrigin: "automatic",
      });
      const active = (yield* orchestrator.getThreadProjection(threadId)).runs.find(
        (run) => run.userMessageId === `active-message:${threadId}`,
      )!;
      const completedAt = yield* DateTime.now;
      yield* eventSink.write({
        events: [
          {
            id: EventId.make(`done:${threadId}`),
            type: "run.updated",
            threadId,
            occurredAt: completedAt,
            payload: { ...active, status: "completed", completedAt },
          },
        ],
      });
      yield* orchestrator.resumeQueuedRuns;
      const after = yield* orchestrator.getThreadProjection(threadId);
      const queued = after.runs.find((run) => run.userMessageId === `queued-message:${threadId}`);
      assert.equal(queued?.startOrigin, "automatic");
      assert.equal(queued?.status, "queued");
      assert.isTrue(queued?.queueHeld === true);
    }),
  );

  it.effect("a no-reset failure keeps the whole queue held with the setting on", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const eventSink = yield* EventSink.EventSinkV2;
      const threadId = ThreadId.make("thread:account-limit-no-reset-queue");
      yield* createThread(threadId);
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make(`active:${threadId}`),
        threadId,
        messageId: MessageId.make(`active-message:${threadId}`),
        text: "Active",
        attachments: [],
        dispatchMode: { type: "start_immediately" },
        createdBy: "user",
        creationSource: "web",
      });
      for (const key of ["first", "second"]) {
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make(`queued:${threadId}:${key}`),
          threadId,
          messageId: MessageId.make(`queued-message:${threadId}:${key}`),
          text: key,
          attachments: [],
          dispatchMode: { type: "queue_after_active" },
          createdBy: "user",
          creationSource: "web",
        });
      }
      const active = (yield* orchestrator.getThreadProjection(threadId)).runs.find(
        (run) => run.userMessageId === `active-message:${threadId}`,
      )!;
      const failedAt = yield* DateTime.now;
      yield* eventSink.write({
        events: [
          {
            id: EventId.make(`error:${threadId}`),
            type: "turn-item.updated",
            threadId,
            runId: active.id,
            nodeId: active.rootNodeId!,
            occurredAt: failedAt,
            payload: {
              id: TurnItemId.make("error-item"),
              type: "error",
              threadId,
              runId: active.id,
              nodeId: active.rootNodeId,
              providerThreadId: active.providerThreadId,
              providerTurnId: null,
              nativeItemRef: null,
              parentItemId: null,
              ordinal: 2,
              status: "failed",
              title: "Usage limit",
              startedAt: failedAt,
              completedAt: failedAt,
              updatedAt: failedAt,
              failure: {
                class: "usage_limit",
                message: "Usage limit reached",
                code: "usage_limit",
                retryable: null,
              },
            },
          },
          {
            id: EventId.make(`failed:${threadId}`),
            type: "run.updated",
            threadId,
            runId: active.id,
            occurredAt: failedAt,
            payload: { ...active, status: "failed", completedAt: failedAt },
          },
        ],
      });
      yield* orchestrator.resumeQueuedRuns;
      const after = yield* orchestrator.getThreadProjection(threadId);
      const queued = after.runs.filter((run) => run.status === "queued");
      assert.lengthOf(queued, 2);
      assert.isTrue(queued.every((run) => run.queueHeld === true));
      assert.isTrue(queued.every((run) => run.queueHeldReason?.kind === "usage_limit"));
      assert.isFalse(after.runs.some((run) => run.status === "starting"));
    }),
  );
});
