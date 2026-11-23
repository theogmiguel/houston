import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  ThreadId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ProviderTurn,
} from "@houston-app/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import { ClaudeProviderCapabilitiesV2 } from "./Adapters/ClaudeAdapterV2.ts";
import * as EffectWorker from "./EffectWorker.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProviderAdapter from "@houston-app/provider-core/server/ProviderAdapter";
import {
  makeProviderFailure,
  makeProviderRetryTurnItem,
} from "@houston-app/provider-core/server/failure";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import { checkpointWorkspace } from "@houston-app/provider-testing/replayWorkspace";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";

const driver = ProviderDriverKind.make("claudeAgent");
const instanceId = ProviderInstanceId.make("claudeAgent");
const modelSelection = { instanceId, model: "claude-test" };

// Composed fixture: a fake adapter whose delegated child announces one API retry and then sends
// nothing more, as a provider does while its requests hang.
it.effect("a parent hears that its delegated child failed in provider retries", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const cwd = yield* checkpointWorkspace("provider-retry-budget");
      const turns: Array<{
        readonly turn: ProviderAdapter.ProviderAdapterV2TurnInput;
        readonly providerTurn: OrchestrationV2ProviderTurn;
        readonly events: Queue.Queue<ProviderAdapter.ProviderAdapterV2Event>;
      }> = [];
      const adapter: ProviderAdapter.ProviderAdapterV2["Service"] = {
        instanceId,
        driver,
        getCapabilities: () => Effect.succeed(ClaudeProviderCapabilitiesV2),
        planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
        openSession: (input) =>
          Effect.gen(function* () {
            const now = yield* DateTime.now;
            const events = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
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
                capabilities: ClaudeProviderCapabilitiesV2,
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
                  const providerTurn: OrchestrationV2ProviderTurn = {
                    id: ProviderTurnId.make(`provider-turn:${turn.attemptId}`),
                    providerThreadId: turn.providerThread.id,
                    nodeId: turn.rootNodeId,
                    runAttemptId: turn.attemptId,
                    nativeTurnRef: null,
                    ordinal: turn.providerTurnOrdinal,
                    status: "running",
                    startedAt: now,
                    completedAt: null,
                  };
                  turns.push({ turn, providerTurn, events });
                  yield* Queue.offer(events, {
                    type: "provider_turn.updated",
                    driver,
                    providerTurn,
                  });
                }),
              steerTurn: () => Effect.void,
              // The provider ends a stopped turn as interrupted.
              interruptTurn: ({ providerTurnId }) =>
                Effect.gen(function* () {
                  const entry = turns.find(
                    (candidate) => candidate.providerTurn.id === providerTurnId,
                  );
                  if (entry === undefined) return;
                  const completedAt = yield* DateTime.now;
                  yield* Queue.offerAll(entry.events, [
                    {
                      type: "provider_turn.updated",
                      driver,
                      providerTurn: { ...entry.providerTurn, status: "interrupted", completedAt },
                    },
                    {
                      type: "turn.terminal",
                      driver,
                      providerThreadId: entry.providerTurn.providerThreadId,
                      providerTurnId,
                      runOrdinal: entry.turn.runOrdinal,
                      status: "interrupted",
                      failure: null,
                      threadDisposition: "reusable",
                    },
                  ]);
                }),
              respondToRuntimeRequest: () => Effect.die("unused"),
              readThreadSnapshot: () => Effect.die("unused"),
              rollbackThread: () => Effect.die("unused"),
              forkThread: () => Effect.die("unused"),
            };
          }),
      };
      const layerAdapters = ProviderAdapterRegistry.layerSingle(adapter);
      const layerTest = ProviderReplayHarness.layerWithRegistry(
        { name: "provider-retry-budget" },
        layerAdapters,
        { runEffectWorker: false },
      ).pipe(
        Layer.provide(
          Layer.mergeAll(
            layerAdapters,
            Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
            Layer.mock(ProjectService.ProjectService)({}),
            ServerSettings.layerTest(),
            NodeServices.layer,
            NodeCrypto.layer,
          ),
        ),
      );

      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const parentThreadId = ThreadId.make("thread:provider-retry-budget-parent");
        const watch = (predicate: (event: OrchestrationV2DomainEvent) => boolean) =>
          orchestrator.streamDomainEvents.pipe(
            Stream.filter(predicate),
            Stream.take(1),
            Stream.runDrain,
            Effect.forkScoped,
          );
        const turnRunning = () =>
          watch(
            (event) => event.type === "provider-turn.updated" && event.payload.status === "running",
          );
        yield* orchestrator.dispatch({
          type: "thread.create",
          commandId: CommandId.make("create-parent"),
          threadId: parentThreadId,
          projectId: ProjectId.make("project:provider-retry-budget"),
          title: "Parent",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: cwd,
          createdBy: "user",
          creationSource: "web",
        });
        const parentRunning = yield* turnRunning();
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("start-parent"),
          threadId: parentThreadId,
          messageId: MessageId.make("message:start-parent"),
          text: "Delegate a review",
          attachments: [],
          dispatchMode: { type: "start_immediately" },
          createdBy: "user",
          creationSource: "web",
        });
        yield* worker.drain();
        yield* Fiber.join(parentRunning);

        const parentRun = (yield* orchestrator.getThreadProjection(parentThreadId)).runs[0]!;
        const childRunning = yield* turnRunning();
        yield* orchestrator.dispatch({
          type: "delegated_task.request",
          commandId: CommandId.make("delegate"),
          parentThreadId,
          parentRunId: parentRun.id,
          parentNodeId: parentRun.rootNodeId!,
          task: "Review the change",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          completionWake: "always",
          createdBy: "agent",
          creationSource: "mcp",
        });
        yield* worker.drain();
        yield* Fiber.join(childRunning);
        const task = (yield* orchestrator.getThreadProjection(parentThreadId)).subagents[0]!;
        const child = turns.find((entry) => entry.turn.threadId === task.childThreadId)!;

        const retryShown = yield* watch(
          (event) => event.type === "turn-item.updated" && event.payload.type === "error",
        );
        yield* Queue.offer(child.events, {
          type: "turn_item.updated",
          driver,
          turnItem: makeProviderRetryTurnItem({
            driver,
            threadId: child.turn.threadId,
            runId: child.turn.runId,
            nodeId: child.turn.rootNodeId,
            providerThreadId: child.providerTurn.providerThreadId,
            providerTurnId: child.providerTurn.id,
            itemOrdinal: 1,
            failure: makeProviderFailure({
              message: "Claude API server error.",
              code: "api_error_503",
              class: "provider_error",
              retryable: true,
            }),
            retry: { attempt: 1, maxAttempts: 10, retryDelayMs: 600 },
            status: "running",
            startedAt: yield* DateTime.now,
            updatedAt: yield* DateTime.now,
          }),
        });
        yield* Fiber.join(retryShown);
        const childFailed = yield* watch(
          (event) =>
            event.type === "run.updated" &&
            event.payload.id === child.turn.runId &&
            event.payload.status === "failed",
        );
        yield* TestClock.adjust("10 minutes");
        yield* Fiber.join(childFailed);
        yield* worker.drain();

        const parent = yield* orchestrator.getThreadProjection(parentThreadId);
        const settledTask = parent.subagents.find((row) => row.id === task.id)!;
        assert.equal(settledTask.status, "failed");
        assert.equal(
          settledTask.result,
          "Claude API server error. The provider retried for 10 minutes without recovering; the retry limit is 10 minutes, so the turn was stopped.",
        );
        // The parent's run holds the completion for delivery.
        assert.deepEqual(parent.runs[0]?.delegatedCompletion?.delivery?.taskIds, [task.id]);
      }).pipe(Effect.provide(layerTest));
    }),
  ),
);
