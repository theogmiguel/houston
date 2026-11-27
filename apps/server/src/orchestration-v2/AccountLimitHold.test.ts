import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
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
          settings: { snoozeLimitedThreads: true, holdUnlimitedThreads: true },
        },
      ),
    ),
  ),
  Layer.provideMerge(
    ServerSettings.layerTest({ snoozeLimitedThreads: true, holdUnlimitedThreads: true }),
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
});
