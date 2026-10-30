// An in-test provider double behind the real orchestrator and effect worker, the shape
// upstream's SteeringCompletion integration test uses. No CLI, network or recording.
import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  RunId,
  ThreadId,
  type OrchestrationV2Command,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ProviderCapabilities,
  type OrchestrationV2ProviderTurn,
} from "@t3tools/contracts";
import type { MessageDelivery } from "@t3tools/contracts/houston/messageDelivery";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { checkpointWorkspace } from "@t3tools/provider-testing/replayWorkspace";
import * as DateTime from "effect/DateTime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";

import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as EffectWorker from "../orchestration-v2/EffectWorker.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "../orchestration-v2/testkit/ProviderReplayHarness.ts";

export interface DoubleOptions {
  /** The double's driver and capabilities; Codex's by default. */
  readonly driver?: string;
  /** The double's provider instance; its driver's name by default. */
  readonly instanceId?: string;
  readonly capabilities?: OrchestrationV2ProviderCapabilities;
  /** What a successful steer returns: a receipt, or nothing as non-Houston adapters do. */
  readonly steerReturns?: "reported" | "void";
  /** After a successful steer, report it read as Codex does (message.delivery). */
  readonly steerAdopts?: boolean;
  /** Fail every steer with this provider message. */
  readonly steerFails?: string;
  /** Fail every turn start for this message id with this provider message. */
  readonly startFails?: { readonly messageId: MessageId; readonly detail: string };
  /** How many steers `steerFails` fails before one succeeds; every one by default. */
  readonly steerFailures?: number;
  /** The steered turn ends while `steerTurn` is still delivering, then the steer returns. */
  readonly steerEndsTurn?: boolean;
}

export const makeHarness = Effect.fn("messageDeliveryHarness")(function* (
  name: string,
  options: DoubleOptions = {},
) {
  const cwd = yield* checkpointWorkspace(`message-delivery-${name}`);
  const events = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
  const started: ProviderAdapter.ProviderAdapterV2TurnInput[] = [];
  const steered: ProviderAdapter.ProviderAdapterV2SteerInput[] = [];
  const turns = new Map<ProviderTurnId, OrchestrationV2ProviderTurn>();
  const driver = ProviderDriverKind.make(options.driver ?? "codex");
  const instanceId = ProviderInstanceId.make(options.instanceId ?? options.driver ?? "codex");
  const modelSelection = { instanceId, model: "test-model" };
  const capabilities = options.capabilities ?? CodexProviderCapabilitiesV2;
  const interrupted: ProviderTurnId[] = [];
  let steerFailures = 0;
  const endTurn = (turn: OrchestrationV2ProviderTurn, status: "completed" | "interrupted") =>
    Effect.gen(function* () {
      const ended = { ...turn, status, completedAt: yield* DateTime.now };
      turns.set(turn.id, ended);
      yield* Queue.offer(events, { type: "provider_turn.updated", driver, providerTurn: ended });
      yield* Queue.offer(events, {
        type: "turn.terminal",
        driver,
        providerThreadId: turn.providerThreadId,
        providerTurnId: turn.id,
        runOrdinal: 1,
        status,
        failure: null,
        threadDisposition: "reusable",
      });
    });
  const adapter: ProviderAdapter.ProviderAdapterV2["Service"] = {
    instanceId,
    driver,
    getCapabilities: () => Effect.succeed(capabilities),
    planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
    openSession: (input) =>
      Effect.gen(function* () {
        const now = yield* DateTime.now;
        return {
          instanceId,
          driver,
          providerSessionId: input.providerSessionId,
          providerSession: {
            id: input.providerSessionId,
            driver,
            providerInstanceId: instanceId,
            status: "ready",
            cwd,
            model: modelSelection.model,
            capabilities,
            createdAt: now,
            updatedAt: now,
            lastError: null,
          },
          events: Stream.fromQueue(events),
          ensureThread: ({ threadId }) =>
            Effect.succeed({
              id: ProviderThreadId.make(`provider-thread:${threadId}`),
              driver,
              providerInstanceId: instanceId,
              providerSessionId: input.providerSessionId,
              appThreadId: threadId,
              ownerNodeId: null,
              nativeThreadRef: { driver, nativeId: "native-thread", strength: "strong" },
              nativeConversationHeadRef: null,
              status: "idle",
              firstRunOrdinal: null,
              lastRunOrdinal: null,
              handoffIds: [],
              forkedFrom: null,
              createdAt: now,
              updatedAt: now,
            }),
          resumeThread: ({ providerThread }) => Effect.succeed(providerThread),
          startTurn: (turn) =>
            Effect.gen(function* () {
              if (options.startFails?.messageId === turn.message.messageId) {
                return yield* new ProviderAdapter.ProviderAdapterProtocolError({
                  driver,
                  detail: options.startFails.detail,
                });
              }
              started.push(turn);
              const providerTurn: OrchestrationV2ProviderTurn = {
                id: ProviderTurnId.make(`provider-turn:${turn.attemptId}`),
                providerThreadId: turn.providerThread.id,
                nodeId: turn.rootNodeId,
                runAttemptId: turn.attemptId,
                nativeTurnRef: { driver, nativeId: `native:${turn.attemptId}`, strength: "strong" },
                ordinal: turn.providerTurnOrdinal,
                status: "running",
                startedAt: yield* DateTime.now,
                completedAt: null,
              };
              turns.set(providerTurn.id, providerTurn);
              yield* Queue.offer(events, { type: "provider_turn.updated", driver, providerTurn });
            }),
          steerTurn: (turn) =>
            Effect.gen(function* () {
              steered.push(turn);
              steerFailures += 1;
              if (
                options.steerFails !== undefined &&
                steerFailures <= (options.steerFailures ?? Number.POSITIVE_INFINITY)
              ) {
                return yield* new ProviderAdapter.ProviderAdapterSteerRunError({
                  driver,
                  providerThreadId: turn.providerThread.id,
                  providerTurnId: turn.providerTurnId,
                  cause: options.steerFails,
                });
              }
              if (options.steerAdopts === true) {
                yield* Queue.offer(events, {
                  type: "message.delivery",
                  driver,
                  threadId: turn.threadId,
                  providerThreadId: turn.providerThread.id,
                  providerTurnId: turn.providerTurnId,
                  messageId: turn.message.messageId,
                  state: "adopted",
                  evidence: "codex.userMessage",
                });
              }
              const steeredTurn = turns.get(turn.providerTurnId);
              if (options.steerEndsTurn === true && steeredTurn !== undefined) {
                yield* endTurn(steeredTurn, "completed");
                for (let round = 0; round < 20; round += 1) {
                  yield* Effect.yieldNow;
                  yield* TestClock.adjust("1 millis");
                }
              }
              return options.steerReturns === "void"
                ? undefined
                : ({ adoption: "reported" } as const);
            }),
          interruptTurn: ({ providerTurnId }) =>
            Effect.gen(function* () {
              interrupted.push(providerTurnId);
              const turn = turns.get(providerTurnId);
              if (turn !== undefined && turn.status === "running") {
                yield* endTurn(turn, "interrupted");
              }
            }),
          respondToRuntimeRequest: () => Effect.void,
          readThreadSnapshot: () => Effect.die("unused"),
          rollbackThread: () => Effect.die("unused"),
          forkThread: () => Effect.die("unused"),
        };
      }),
  };
  return {
    name,
    adapter,
    cwd,
    events,
    started,
    steered,
    interrupted,
    turns,
    endTurn,
    modelSelection,
  };
});

export type HarnessError =
  | Orchestrator.OrchestratorV2Error
  | EffectWorker.OrchestrationEffectWorkerError;

export type Harness = Effect.Success<ReturnType<typeof makeHarness>>;

/** The orchestration runtime around the double; a database path keeps state across a restart. */
export const harnessLayer = (
  harness: Harness,
  options: { readonly databasePath?: string; readonly others?: ReadonlyArray<Harness> } = {},
) =>
  ProviderReplayHarness.layerWithRegistry(
    { name: `message-delivery-${harness.name}` },
    ProviderAdapterRegistry.layerFromAdapters([
      harness.adapter,
      ...(options.others ?? []).map((other) => other.adapter),
    ]),
    {
      runEffectWorker: false,
      ...(options.databasePath === undefined
        ? {}
        : {
            databaseLayer: SqlitePersistence.layerFromPath(options.databasePath).pipe(
              Layer.provide(NodeServices.layer),
            ),
          }),
    },
  );

export const runWith = <A, E, R>(
  harness: Harness,
  body: (context: {
    readonly orchestrator: Orchestrator.OrchestratorV2["Service"];
    readonly worker: EffectWorker.OrchestrationEffectWorkerV2["Service"];
    readonly threadId: ThreadId;
    readonly deliveries: (messageId: MessageId) => ReadonlyArray<MessageDelivery>;
    readonly settle: Effect.Effect<void, HarnessError>;
    readonly send: (
      messageId: string,
      text: string,
      mode: Extract<OrchestrationV2Command, { type: "message.dispatch" }>["dispatchMode"],
      deliveryIntent?: "auto" | "steer" | "restart",
    ) => Effect.Effect<void, Orchestrator.OrchestratorV2Error>;
    readonly startFirst: Effect.Effect<RunId, HarnessError>;
    readonly runningTurn: Effect.Effect<OrchestrationV2ProviderTurn, HarnessError>;
  }) => Effect.Effect<A, E, R>,
  options: {
    /** False when a previous run on the same database already created the thread. */
    readonly createThread?: boolean;
    readonly databasePath?: string;
    /** More provider instances in the registry, for a provider switch. */
    readonly others?: ReadonlyArray<Harness>;
  } = {},
) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
    const threadId = ThreadId.make(`thread:${harness.name}`);
    const domainEvents: OrchestrationV2DomainEvent[] = [];
    const recorder = yield* orchestrator.streamDomainEvents.pipe(
      Stream.runForEach((event) => Effect.sync(() => domainEvents.push(event))),
      Effect.forkScoped,
    );
    yield* Effect.yieldNow;
    // A queued message's record is on the message until its run starts, then on its item.
    const deliveries = (messageId: MessageId) =>
      domainEvents.flatMap((event) => {
        if (event.type === "message.updated") {
          const delivery = event.payload.delivery;
          return event.payload.id === messageId && delivery !== undefined ? [delivery] : [];
        }
        return event.type === "turn-item.updated" &&
          event.payload.type === "user_message" &&
          event.payload.messageId === messageId &&
          event.payload.delivery !== undefined
          ? [event.payload.delivery]
          : [];
      });
    // Effects retry with backoff; move the clock so every retry runs.
    const settle = Effect.gen(function* () {
      for (let round = 0; round < 8; round += 1) {
        yield* Effect.yieldNow;
        yield* worker.drain();
        yield* orchestrator.resumeQueuedRuns;
        yield* worker.drain();
        yield* TestClock.adjust("1 minute");
      }
    });
    const send = (
      messageId: string,
      text: string,
      mode: Extract<OrchestrationV2Command, { type: "message.dispatch" }>["dispatchMode"],
      deliveryIntent?: "auto" | "steer" | "restart",
    ) =>
      orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make(`send:${messageId}`),
        threadId,
        messageId: MessageId.make(messageId),
        text,
        attachments: [],
        dispatchMode: mode,
        ...(deliveryIntent === undefined ? {} : { deliveryIntent }),
        createdBy: "user",
        creationSource: "web",
      });
    if (options.createThread !== false)
      yield* orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make("create"),
        threadId,
        projectId: ProjectId.make("project:message-delivery"),
        title: "Send intents",
        modelSelection: harness.modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: harness.cwd,
        createdBy: "user",
        creationSource: "web",
      });
    const runningTurn = Effect.gen(function* () {
      for (let round = 0; round < 50; round += 1) {
        const projection = yield* orchestrator.getThreadProjection(threadId);
        const turn = projection.providerTurns.find((candidate) => candidate.status === "running");
        if (turn !== undefined) return turn;
        yield* Effect.yieldNow;
        yield* TestClock.adjust("1 millis");
      }
      return yield* Effect.die("no provider turn reached running");
    });
    const startFirst = Effect.gen(function* () {
      yield* send("message:first", "first", { type: "start_immediately" });
      yield* settle;
      yield* runningTurn;
      const projection = yield* orchestrator.getThreadProjection(threadId);
      return projection.runs[0]!.id;
    });
    const result = yield* body({
      orchestrator,
      worker,
      threadId,
      deliveries,
      settle,
      send,
      startFirst,
      runningTurn,
    });
    yield* Fiber.interrupt(recorder);
    return result;
  }).pipe(
    Effect.provide(
      harnessLayer(harness, {
        ...(options.databasePath === undefined ? {} : { databasePath: options.databasePath }),
        ...(options.others === undefined ? {} : { others: options.others }),
      }),
    ),
  );

export const latest = (list: ReadonlyArray<MessageDelivery>) => list.at(-1);
