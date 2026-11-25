import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  ThreadId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ProviderTurn,
  type OrchestrationV2Run,
  type OrchestrationV2ThreadProjection,
} from "@houston-app/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import { checkpointWorkspace } from "@houston-app/provider-testing/replayWorkspace";
import * as ProviderAdapter from "@houston-app/provider-core/server/ProviderAdapter";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as EffectWorker from "./EffectWorker.ts";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";

const driver = ProviderDriverKind.make("codex");
const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "test-model" };
type Turn = ProviderAdapter.ProviderAdapterV2TurnInput;
const turnIdOf = (turn: Turn) => ProviderTurnId.make(`provider-turn:${turn.attemptId}`);

/** One session shared by every thread; it refuses a thread's turn while that thread runs one. */
const makeProvider = (cwd: string) =>
  Effect.gen(function* () {
    const events = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
    const now = yield* DateTime.now;
    const active = new Map<string, Turn>();
    const provider = {
      confirmsInterrupts: true,
      /** Provider turns a confirmed interrupt reached. */
      interrupted: [] as Array<ProviderTurnId>,
      accepted: [] as Array<string>,
      active,
      end: (turn: Turn, status: "completed" | "interrupted") =>
        Effect.gen(function* () {
          active.delete(turn.threadId);
          yield* Queue.offer(events, turnUpdate(turn, status));
          yield* Queue.offer(events, {
            type: "turn.terminal",
            driver,
            providerThreadId: turn.providerThread.id,
            providerTurnId: turnIdOf(turn),
            runOrdinal: turn.runOrdinal,
            status,
            failure: null,
            threadDisposition: "reusable",
          });
        }),
    };
    const turnUpdate = (
      turn: Turn,
      status: OrchestrationV2ProviderTurn["status"],
    ): ProviderAdapter.ProviderAdapterV2Event => ({
      type: "provider_turn.updated",
      driver,
      providerTurn: {
        id: turnIdOf(turn),
        providerThreadId: turn.providerThread.id,
        nodeId: turn.rootNodeId,
        runAttemptId: turn.attemptId,
        nativeTurnRef: { driver, nativeId: `native:${turn.attemptId}`, strength: "strong" },
        ordinal: turn.providerTurnOrdinal,
        status,
        startedAt: now,
        completedAt: status === "running" ? null : now,
      },
    });
    const adapter: ProviderAdapter.ProviderAdapterV2["Service"] = {
      instanceId,
      driver,
      getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
      planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
      openSession: (session) =>
        Effect.succeed({
          instanceId,
          driver,
          providerSessionId: session.providerSessionId,
          providerSession: {
            id: session.providerSessionId,
            driver,
            providerInstanceId: instanceId,
            status: "ready",
            cwd,
            model: modelSelection.model,
            capabilities: CodexProviderCapabilitiesV2,
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
              providerSessionId: session.providerSessionId,
              appThreadId: threadId,
              ownerNodeId: null,
              nativeThreadRef: { driver, nativeId: `native:${threadId}`, strength: "strong" },
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
              if (active.has(turn.threadId)) {
                return yield* new ProviderAdapter.ProviderAdapterProtocolError({
                  driver,
                  detail: "The previous provider turn is still active.",
                  reason: "previous_turn_active",
                });
              }
              active.set(turn.threadId, turn);
              provider.accepted.push(turn.message.text);
              yield* Queue.offer(events, turnUpdate(turn, "running"));
            }),
          steerTurn: () => Effect.die("unused"),
          interruptTurn: (interrupt) =>
            Effect.gen(function* () {
              if (!provider.confirmsInterrupts) {
                return yield* new ProviderAdapter.ProviderAdapterInterruptTimeoutError({
                  driver,
                  providerThreadId: interrupt.providerThread.id,
                  providerTurnId: interrupt.providerTurnId,
                  timeoutMs: 1,
                });
              }
              provider.interrupted.push(interrupt.providerTurnId);
              const turn = [...active.values()].find(
                (candidate) => turnIdOf(candidate) === interrupt.providerTurnId,
              );
              if (turn !== undefined) yield* provider.end(turn, "interrupted");
            }),
          respondToRuntimeRequest: () => Effect.die("unused"),
          readThreadSnapshot: () => Effect.die("unused"),
          rollbackThread: () => Effect.die("unused"),
          forkThread: () => Effect.die("unused"),
        }),
    };
    return { provider, registry: ProviderAdapterRegistry.layerSingle(adapter) };
  });

type Provider = Effect.Success<ReturnType<typeof makeProvider>>["provider"];

const driveThread = (name: string, cwd: string, provider: Provider) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
    const eventSink = yield* EventSink.EventSinkV2;
    const threadId = ThreadId.make(`thread:${name}`);
    const now = yield* DateTime.now;
    let composed = 0;
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`create:${name}`),
      threadId,
      projectId: ProjectId.make(`project:${name}`),
      title: name,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: cwd,
      createdBy: "user",
      creationSource: "web",
    });
    const projection = orchestrator.getThreadProjection(threadId);
    const send = (
      text: string,
      dispatchMode: Extract<
        Parameters<typeof orchestrator.dispatch>[0],
        { readonly type: "message.dispatch" }
      >["dispatchMode"] = { type: "start_immediately" },
    ) =>
      orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make(`send:${name}:${text}`),
        threadId,
        messageId: MessageId.make(`message:${name}:${text}`),
        text,
        attachments: [],
        dispatchMode,
        createdBy: "user",
        creationSource: "web",
      });
    // Subscribes before the first read, so no event between the two is missed.
    const until = (predicate: (current: OrchestrationV2ThreadProjection) => boolean) =>
      Effect.gen(function* () {
        const reached = yield* orchestrator.streamDomainEvents.pipe(
          Stream.mapEffect(() => projection),
          Stream.filter(predicate),
          Stream.runHead,
          Effect.forkScoped({ startImmediately: true }),
        );
        const current = yield* projection;
        if (predicate(current)) return current;
        return Option.getOrThrow(yield* Fiber.join(reached));
      }).pipe(Effect.scoped);
    const untilRun = (index: number, statuses: ReadonlyArray<OrchestrationV2Run["status"]>) =>
      until((current) => {
        const status = current.runs[index]?.status;
        return status !== undefined && statuses.includes(status);
      });
    // Runs every effect to its end; each adjustment passes the longest retry delay.
    const settle = Effect.gen(function* () {
      yield* worker.drain();
      while (Option.isSome(yield* worker.nextClaimableAt)) {
        yield* TestClock.adjust("1 second");
        yield* worker.drain();
      }
    });
    const write = (event: Pick<OrchestrationV2DomainEvent, "type" | "payload">) => {
      composed += 1;
      return eventSink.write({
        events: [
          {
            ...event,
            id: EventId.make(`composed:${name}:${composed}`),
            threadId,
            occurredAt: now,
          } as OrchestrationV2DomainEvent,
        ],
      });
    };
    /** Composed: the run's stored status alone, as another path to it would leave it. */
    const composeRunStatus = (status: OrchestrationV2Run["status"]) =>
      Effect.gen(function* () {
        yield* write({
          type: "run.updated",
          payload: { ...(yield* projection).runs[0]!, status },
        });
      });
    const accept = (text: string) =>
      Effect.gen(function* () {
        yield* send(text);
        yield* worker.drain();
        const turnId = turnIdOf(provider.active.get(threadId)!);
        yield* until((current) =>
          current.providerTurns.some((turn) => turn.id === turnId && turn.status === "running"),
        );
        return turnId;
      });
    const completeTurn = Effect.gen(function* () {
      const turn = provider.active.get(threadId)!;
      yield* provider.end(turn, "completed");
      // The finalized run waits on the checkpoint its commit queued.
      yield* untilRun(turn.runOrdinal - 1, ["waiting"]);
      yield* settle;
      yield* untilRun(turn.runOrdinal - 1, ["completed"]);
    });
    /** A steer restarts the turn, the provider never confirms its interrupt, and Stop cannot either. */
    const abandonTurn = Effect.gen(function* () {
      const turnId = yield* accept("first");
      const runId = (yield* projection).runs[0]!.id;
      provider.confirmsInterrupts = false;
      yield* send("steer", { type: "restart_active", targetRunId: runId });
      yield* orchestrator.dispatch({
        type: "run.interrupt",
        commandId: CommandId.make(`stop:${name}`),
        threadId,
        runId,
      });
      yield* settle;
      provider.confirmsInterrupts = true;
      const left = yield* projection;
      assert.equal(left.runs[0]?.status, "interrupted");
      assert.deepEqual(
        left.attempts.map((attempt) => attempt.status),
        ["superseded", "interrupted"],
      );
      assert.deepEqual(
        left.providerTurns.map((turn) => [turn.id, turn.status]),
        [[turnId, "running"]],
      );
      return turnId;
    });
    return {
      threadId,
      projection,
      send,
      settle,
      worker,
      untilRun,
      write,
      composeRunStatus,
      accept,
      completeTurn,
      abandonTurn,
    };
  });

const scenario = <A, E, R>(
  name: string,
  run: (input: { readonly cwd: string; readonly provider: Provider }) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const cwd = yield* checkpointWorkspace(name);
    const { provider, registry } = yield* makeProvider(cwd);
    return yield* run({ cwd, provider }).pipe(
      Effect.provide(
        ProviderReplayHarness.layerWithRegistry({ name }, registry, { runEffectWorker: false }),
      ),
    );
  }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)));

const turnStatus = (current: OrchestrationV2ThreadProjection, id: ProviderTurnId) =>
  current.providerTurns.find((turn) => turn.id === id)?.status;

it.effect.each(["interrupted", "failed", "cancelled", "rolled_back"] as const)(
  "a message after a run that ended %s starts once its abandoned turn is interrupted",
  (status) =>
    scenario(`abandoned-${status}`, ({ cwd, provider }) =>
      Effect.gen(function* () {
        const thread = yield* driveThread(`abandoned-${status}`, cwd, provider);
        const abandoned = yield* thread.abandonTurn;
        if (status !== "interrupted") yield* thread.composeRunStatus(status);
        yield* thread.send("next");
        yield* thread.settle;
        const after = yield* thread.untilRun(1, ["running", "failed"]);
        assert.equal(after.runs[1]?.status, "running");
        assert.lengthOf(provider.accepted, 2);
        assert.deepEqual(provider.interrupted, [abandoned]);
        assert.equal(turnStatus(after, abandoned), "interrupted");
        assert.isFalse(after.turnItems.some((item) => item.type === "error"));
      }),
    ),
);

it.effect("a message after an interrupted run recovers the turn of its active attempt", () =>
  scenario("abandoned-active-attempt", ({ cwd, provider }) =>
    Effect.gen(function* () {
      const thread = yield* driveThread("abandoned-active-attempt", cwd, provider);
      const abandoned = yield* thread.accept("first");
      yield* thread.composeRunStatus("interrupted");
      yield* thread.send("next");
      yield* thread.settle;
      const after = yield* thread.untilRun(1, ["running", "failed"]);
      assert.equal(after.runs[1]?.status, "running");
      assert.deepEqual(provider.interrupted, [abandoned]);
    }),
  ),
);

it.effect.each(["running", "waiting", "starting", "completed"] as const)(
  "a turn whose run is %s is never interrupted for a later message",
  (status) =>
    scenario(`live-${status}`, ({ cwd, provider }) =>
      Effect.gen(function* () {
        const thread = yield* driveThread(`live-${status}`, cwd, provider);
        const turn = yield* thread.abandonTurn;
        yield* thread.send("next");
        yield* thread.composeRunStatus(status);
        yield* thread.settle;
        const after = yield* thread.untilRun(1, ["running", "failed"]);
        assert.deepEqual(provider.interrupted, []);
        assert.isTrue(provider.active.has(thread.threadId));
        assert.equal(turnStatus(after, turn), "running");
      }),
    ),
);

it.effect("another thread's abandoned turn on the shared session is never interrupted", () =>
  scenario("shared-session", ({ cwd, provider }) =>
    Effect.gen(function* () {
      const other = yield* driveThread("shared-session-other", cwd, provider);
      const otherTurn = yield* other.abandonTurn;
      const thread = yield* driveThread("shared-session-own", cwd, provider);
      const ownTurn = yield* thread.abandonTurn;
      const sessionOf = (current: OrchestrationV2ThreadProjection) =>
        current.providerThreads[0]?.providerSessionId;
      assert.equal(sessionOf(yield* thread.projection), sessionOf(yield* other.projection));

      yield* thread.send("next");
      yield* thread.settle;

      const after = yield* thread.untilRun(1, ["running", "failed"]);
      assert.equal(after.runs[1]?.status, "running");
      assert.deepEqual(provider.interrupted, [ownTurn]);
      assert.isTrue(provider.active.has(other.threadId));
      assert.equal(turnStatus(yield* other.projection, otherTurn), "running");
    }),
  ),
);

it.effect("a turn on the thread's other provider thread is never interrupted", () =>
  scenario("other-provider-thread", ({ cwd, provider }) =>
    Effect.gen(function* () {
      const thread = yield* driveThread("other-provider-thread", cwd, provider);
      const abandoned = yield* thread.abandonTurn;
      // Composed: the abandoned turn belongs to a provider thread used before a switch, and both
      // provider threads have had one turn.
      const [turn] = (yield* thread.projection).providerTurns;
      yield* thread.write({
        type: "provider-turn.updated",
        payload: { ...turn!, providerThreadId: ProviderThreadId.make("provider-thread:before") },
      });
      yield* thread.write({
        type: "provider-turn.updated",
        payload: {
          ...turn!,
          id: ProviderTurnId.make("provider-turn:own"),
          runAttemptId: null,
          status: "completed",
        },
      });
      provider.active.delete(thread.threadId);
      yield* thread.send("next");
      yield* thread.settle;
      const after = yield* thread.untilRun(1, ["running", "failed"]);
      assert.equal(after.runs[1]?.status, "running");
      assert.deepEqual(provider.interrupted, []);
      assert.equal(turnStatus(after, abandoned), "running");
    }),
  ),
);

it.effect.each(["completed", "running"] as const)(
  "a turn that a newer attempt's %s turn replaced is never interrupted",
  (status) =>
    scenario(`replaced-${status}`, ({ cwd, provider }) =>
      Effect.gen(function* () {
        const thread = yield* driveThread(`replaced-${status}`, cwd, provider);
        const replaced = yield* thread.abandonTurn;
        // Composed: the newer attempt reached the provider, and only the replaced row kept running.
        const left = yield* thread.projection;
        const newer = left.attempts[1]!;
        const newerTurn = ProviderTurnId.make(`provider-turn:${newer.id}`);
        yield* thread.write({
          type: "provider-turn.updated",
          payload: {
            ...left.providerTurns[0]!,
            id: newerTurn,
            runAttemptId: newer.id,
            nodeId: newer.rootNodeId,
            ordinal: left.providerTurns[0]!.ordinal + 1,
            status,
          },
        });
        const turn = provider.active.get(thread.threadId)!;
        provider.active.delete(thread.threadId);
        if (status === "running") {
          provider.active.set(thread.threadId, {
            ...turn,
            attemptId: newer.id,
            rootNodeId: newer.rootNodeId,
            providerTurnOrdinal: turn.providerTurnOrdinal + 1,
          });
        }
        yield* thread.send("next");
        yield* thread.settle;
        const after = yield* thread.untilRun(1, ["running", "failed"]);
        assert.equal(after.runs[1]?.status, "running");
        assert.deepEqual(provider.interrupted, status === "running" ? [newerTurn] : []);
        assert.equal(turnStatus(after, replaced), "running");
      }),
    ),
);

it.effect.each(["interrupted", "failed"] as const)(
  "the stale turn of a run that ended %s is closed without an interrupt once a later turn has run",
  (status) =>
    scenario(`followed-${status}`, ({ cwd, provider }) =>
      Effect.gen(function* () {
        const thread = yield* driveThread(`followed-${status}`, cwd, provider);
        const first = yield* thread.accept("first");
        yield* thread.completeTurn;
        yield* thread.accept("second");
        yield* thread.completeTurn;
        // Composed: the first turn's end was never stored, and the provider has since moved on.
        const left = yield* thread.projection;
        yield* thread.write({
          type: "provider-turn.updated",
          payload: {
            ...left.providerTurns.find((turn) => turn.id === first)!,
            status: "running",
            completedAt: null,
          },
        });
        yield* thread.composeRunStatus(status);
        yield* thread.send("third");
        yield* thread.settle;
        const after = yield* thread.untilRun(2, ["running", "failed"]);
        assert.equal(after.runs[2]?.status, "running");
        assert.deepEqual(provider.interrupted, []);
        assert.equal(turnStatus(after, first), "interrupted");
      }),
    ),
);
