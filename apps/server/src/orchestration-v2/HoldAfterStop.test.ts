import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ScheduledTaskId,
  ThreadId,
  type OrchestrationV2Run,
  type OrchestrationV2ThreadProjection,
} from "@houston-app/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import { STOPPED_THREAD_HOLD_MESSAGE } from "../houston/runStart/StoppedThreadAdmission.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as CommandReceiptStore from "./CommandReceiptStore.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as EventStore from "./EventStore.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import type * as ProviderAdapter from "@houston-app/provider-core/server/ProviderAdapter";

const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "gpt-5.1-codex" };
const projectId = ProjectId.make("project:hold-after-stop");
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("Runs here never reach a provider"),
} as ProviderAdapter.ProviderAdapterV2["Service"];

const layerDatabase = SqlitePersistence.layerMemory;
const layerTest = (holdAgentMessagesAfterStop: boolean) =>
  ThreadManagementService.layer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        layerDatabase,
        ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
        EventStore.layer.pipe(Layer.provide(layerDatabase)),
        EffectOutbox.layer.pipe(Layer.provide(layerDatabase)),
        ProviderReplayHarness.layerWithRegistry(
          { name: `hold-after-stop-${holdAgentMessagesAfterStop}` },
          ProviderAdapterRegistry.layerFromAdapters([adapter]),
          {
            databaseLayer: layerDatabase,
            runEffectWorker: false,
            settings: { holdAgentMessagesAfterStop },
          },
        ),
      ),
    ),
    Layer.provideMerge(ServerSettings.layerTest({ holdAgentMessagesAfterStop })),
    Layer.provideMerge(CommandReceiptStore.layer.pipe(Layer.provide(layerDatabase))),
  );

const layerOn = layerTest(true);
const layerOff = layerTest(false);

/** A separate server process over the same database file, for restart coverage. */
const layerAt = (dbPath: string, name: string) => {
  const database = SqlitePersistence.layerFromPath(dbPath).pipe(Layer.provide(NodeServices.layer));
  return ThreadManagementService.layer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        database,
        ProjectionStore.layer.pipe(Layer.provide(database)),
        EventStore.layer.pipe(Layer.provide(database)),
        EffectOutbox.layer.pipe(Layer.provide(database)),
        ProviderReplayHarness.layerWithRegistry(
          { name },
          ProviderAdapterRegistry.layerFromAdapters([adapter]),
          {
            databaseLayer: database,
            runEffectWorker: false,
            settings: { holdAgentMessagesAfterStop: true },
          },
        ),
      ),
    ),
    Layer.provideMerge(ServerSettings.layerTest({ holdAgentMessagesAfterStop: true })),
    Layer.provideMerge(CommandReceiptStore.layer.pipe(Layer.provide(database))),
  );
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
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
  });

const send = (
  threadId: ThreadId,
  text: string,
  overrides: {
    readonly createdBy?: "user" | "agent";
    readonly creationSource?: "web" | "server" | "mcp" | "provider";
    readonly startOrigin?: "user" | "automatic" | "provider";
    readonly scheduledTaskId?: ScheduledTaskId;
    readonly dispatchMode?: "start_immediately" | "queue_after_active";
  } = {},
) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make(`send:${threadId}:${text}`),
      threadId,
      messageId: MessageId.make(`message:${threadId}:${text}`),
      text,
      attachments: [],
      dispatchMode: { type: overrides.dispatchMode ?? "start_immediately" },
      createdBy: overrides.createdBy ?? "user",
      creationSource: overrides.creationSource ?? "web",
      ...(overrides.startOrigin === undefined ? {} : { startOrigin: overrides.startOrigin }),
      ...(overrides.scheduledTaskId === undefined
        ? {}
        : { scheduledTaskId: overrides.scheduledTaskId }),
    });
  });

const stop = (threadId: ThreadId, requestedBy: "user" | "agent") =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* orchestrator.dispatch({
      type: "thread.stop",
      commandId: CommandId.make(`stop:${threadId}:${requestedBy}`),
      threadId,
      requestedBy,
    });
  });

const mergeQueueNote = (threadId: ThreadId, messageId: string) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* orchestrator.dispatch({
      type: "houston.merge-queue.notify",
      commandId: CommandId.make(`merge-queue:${messageId}`),
      threadId,
      messageId: MessageId.make(messageId),
      text: "PR #7 failed its merge checks",
    });
  });

const heldQueuedRun = (runs: ReadonlyArray<OrchestrationV2Run>) =>
  runs.find((run) => run.status === "queued" && run.queueHeld === true);

const runByText = (projection: OrchestrationV2ThreadProjection, text: string) => {
  const message = projection.messages.find((candidate) => candidate.text === text);
  return message === undefined
    ? undefined
    : projection.runs.find((run) => run.id === message.runId);
};

const completeRun = (threadId: ThreadId, runId: OrchestrationV2Run["id"]) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const projection = yield* orchestrator.getThreadProjection(threadId);
    const run = projection.runs.find((candidate) => candidate.id === runId);
    assert.isDefined(run);
    const now = yield* DateTime.now;
    yield* projections.apply({
      id: EventId.make(`complete:${runId}`),
      type: "run.updated",
      threadId,
      runId,
      occurredAt: now,
      payload: { ...run, status: "completed", completedAt: now },
    });
  });

it.effect(
  "holds an agent message, a scheduled task and a merge-queue note after a user Stop, then releases them in order behind the user's run",
  () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const threadId = ThreadId.make("thread:hold-after-stop-release");
      yield* createThread(threadId);
      yield* send(threadId, "active");
      yield* stop(threadId, "user");

      assert.strictEqual(
        (yield* orchestrator.getThreadProjection(threadId)).thread.heldAfterStop,
        true,
      );

      yield* send(threadId, "agent nudge", {
        createdBy: "agent",
        creationSource: "mcp",
        startOrigin: "automatic",
      });
      yield* send(threadId, "Nightly check", {
        createdBy: "user",
        creationSource: "server",
        scheduledTaskId: ScheduledTaskId.make("scheduled:nightly"),
      });
      yield* mergeQueueNote(threadId, "message:merge-queue:project:7:abc:conflict");

      const held = yield* orchestrator.getThreadProjection(threadId);
      for (const text of ["agent nudge", "Nightly check", "PR #7 failed its merge checks"]) {
        const run = runByText(held, text);
        assert.isDefined(run, `${text} has a run`);
        assert.strictEqual(run?.status, "queued", `${text} waits`);
        assert.strictEqual(run?.queueHeld, true, `${text} is held`);
        assert.strictEqual(run?.queueHeldReason?.kind, "stopped_thread");
        assert.strictEqual(run?.queueHeldReason?.message, STOPPED_THREAD_HOLD_MESSAGE);
      }

      // The user returns: the hold lifts, and their run starts ahead of the held queue.
      yield* send(threadId, "back");
      const released = yield* orchestrator.getThreadProjection(threadId);
      assert.strictEqual(released.thread.heldAfterStop, false);
      assert.isUndefined(heldQueuedRun(released.runs), "every held run is released");
      assert.isFalse(
        released.runs.some((run) => run.queueHeldReason?.kind === "stopped_thread"),
        "the stop reason is cleared",
      );
      const userRun = runByText(released, "back");
      assert.strictEqual(userRun?.status, "starting");

      // Each queued run starts in the order it was created, one at a time.
      const order = ["agent nudge", "Nightly check", "PR #7 failed its merge checks"];
      yield* completeRun(threadId, userRun!.id);
      for (const text of order) {
        assert.strictEqual(yield* orchestrator.resumeQueuedRuns, 1);
        const projection = yield* orchestrator.getThreadProjection(threadId);
        assert.strictEqual(runByText(projection, text)?.status, "starting", `${text} starts`);
        yield* completeRun(threadId, runByText(projection, text)!.id);
      }
      assert.strictEqual(yield* orchestrator.resumeQueuedRuns, 0);
    }).pipe(Effect.provide(layerOn)),
);

it.effect("Send now starts one held run while the thread still holds new automatic work", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const threadId = ThreadId.make("thread:hold-after-stop-send-now");
    yield* createThread(threadId);
    yield* send(threadId, "active");
    yield* stop(threadId, "user");
    yield* send(threadId, "agent nudge", {
      createdBy: "agent",
      creationSource: "mcp",
      startOrigin: "automatic",
    });
    const held = yield* orchestrator.getThreadProjection(threadId);
    const heldRun = runByText(held, "agent nudge");
    assert.strictEqual(heldRun?.status, "queued");
    assert.strictEqual(heldRun?.queueHeldReason?.kind, "stopped_thread");

    yield* orchestrator.dispatch({
      type: "queued-run.start",
      commandId: CommandId.make("send-now-after-stop"),
      threadId,
      runId: heldRun!.id,
    });
    const started = yield* orchestrator.getThreadProjection(threadId);
    assert.strictEqual(started.thread.heldAfterStop, true);
    assert.strictEqual(runByText(started, "agent nudge")?.status, "starting");
  }).pipe(Effect.provide(layerOn)),
);

it.effect("Resume starts the first held run and later automatic starts no longer wait", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const threadId = ThreadId.make("thread:hold-after-stop-resume");
    yield* createThread(threadId);
    yield* send(threadId, "active");
    yield* stop(threadId, "user");
    yield* send(threadId, "agent nudge", {
      createdBy: "agent",
      creationSource: "mcp",
      startOrigin: "automatic",
    });

    yield* orchestrator.dispatch({
      type: "queue.resume",
      commandId: CommandId.make("resume-after-stop"),
      threadId,
    });
    const resumed = yield* orchestrator.getThreadProjection(threadId);
    assert.strictEqual(resumed.thread.heldAfterStop, false);
    assert.strictEqual(runByText(resumed, "agent nudge")?.status, "starting");

    yield* completeRun(threadId, runByText(resumed, "agent nudge")!.id);
    yield* send(threadId, "another nudge", {
      createdBy: "agent",
      creationSource: "mcp",
      startOrigin: "automatic",
    });
    const next = yield* orchestrator.getThreadProjection(threadId);
    assert.strictEqual(runByText(next, "another nudge")?.status, "starting");
    assert.isUndefined(runByText(next, "another nudge")?.queueHeldReason);
  }).pipe(Effect.provide(layerOn)),
);

it.effect("an agent's MCP stop holds nothing", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const threadId = ThreadId.make("thread:hold-after-stop-agent");
    yield* createThread(threadId);
    yield* send(threadId, "active");
    yield* stop(threadId, "agent");

    assert.notStrictEqual(
      (yield* orchestrator.getThreadProjection(threadId)).thread.heldAfterStop,
      true,
    );
    yield* send(threadId, "agent nudge", {
      createdBy: "agent",
      creationSource: "mcp",
      startOrigin: "automatic",
    });
    const projection = yield* orchestrator.getThreadProjection(threadId);
    assert.strictEqual(runByText(projection, "agent nudge")?.status, "starting");
    assert.isUndefined(runByText(projection, "agent nudge")?.queueHeldReason);
  }).pipe(Effect.provide(layerOn)),
);

it.effect("provider output is never held after a user Stop", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const threadId = ThreadId.make("thread:hold-after-stop-provider");
    yield* createThread(threadId);
    yield* send(threadId, "active");
    yield* stop(threadId, "user");
    yield* send(threadId, "provider output", {
      createdBy: "agent",
      creationSource: "provider",
      startOrigin: "provider",
    });
    const projection = yield* orchestrator.getThreadProjection(threadId);
    assert.strictEqual(runByText(projection, "provider output")?.status, "starting");
    assert.isUndefined(runByText(projection, "provider output")?.queueHeldReason);
  }).pipe(Effect.provide(layerOn)),
);

it.effect("the user Stop holds automatic starts across a server restart", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "houston-hold-after-stop-",
      });
      const dbPath = path.join(directory, "state.sqlite");
      const threadId = ThreadId.make("thread:hold-after-stop-restart");

      yield* Effect.gen(function* () {
        yield* createThread(threadId);
        yield* send(threadId, "active");
        yield* stop(threadId, "user");
        yield* send(threadId, "before restart", {
          createdBy: "agent",
          creationSource: "mcp",
          startOrigin: "automatic",
        });
      }).pipe(Effect.provide(layerAt(dbPath, "hold-after-stop-restart-1")));

      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const restored = yield* orchestrator.getThreadProjection(threadId);
        assert.strictEqual(restored.thread.heldAfterStop, true);
        assert.strictEqual(runByText(restored, "before restart")?.status, "queued");
        assert.strictEqual(
          runByText(restored, "before restart")?.queueHeldReason?.kind,
          "stopped_thread",
        );

        yield* send(threadId, "after restart", {
          createdBy: "agent",
          creationSource: "mcp",
          startOrigin: "automatic",
        });
        const after = yield* orchestrator.getThreadProjection(threadId);
        assert.strictEqual(runByText(after, "after restart")?.status, "queued");
        assert.strictEqual(
          runByText(after, "after restart")?.queueHeldReason?.kind,
          "stopped_thread",
        );
      }).pipe(Effect.provide(layerAt(dbPath, "hold-after-stop-restart-2")));
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("with the setting off, a user Stop changes no later start", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const threadId = ThreadId.make("thread:hold-after-stop-off");
    yield* createThread(threadId);
    yield* send(threadId, "active");
    yield* stop(threadId, "user");
    yield* send(threadId, "agent nudge", {
      createdBy: "agent",
      creationSource: "mcp",
      startOrigin: "automatic",
    });
    const projection = yield* orchestrator.getThreadProjection(threadId);
    assert.strictEqual(runByText(projection, "agent nudge")?.status, "starting");
    assert.isUndefined(runByText(projection, "agent nudge")?.queueHeldReason);
  }).pipe(Effect.provide(layerOff)),
);
