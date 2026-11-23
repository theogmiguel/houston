import { assert, it } from "@effect/vitest";
import {
  ChatAttachmentId,
  CommandId,
  ComposerContextId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  ThreadId,
  type ChatAttachment,
  type OrchestrationMessageContext,
  type OrchestrationV2Notification,
  type OrchestrationV2Run,
} from "@houston-app/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as EffectWorker from "./EffectWorker.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import { checkpointWorkspace } from "@houston-app/provider-testing/replayWorkspace";
import type * as ProviderAdapter from "@houston-app/provider-core/server/ProviderAdapter";

const driver = ProviderDriverKind.make("codex");
const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "test-model" };
const CONTINUE = "Continue where you left off.";
const ORIGINAL = "Fix the checkout page after [log](houston-context://v1/terminal/ctx_terminal)";

const screenshot: ChatAttachment = {
  type: "image",
  id: ChatAttachmentId.make("manual-resume-screenshot"),
  name: "checkout.png",
  mimeType: "image/png",
  sizeBytes: 10,
};
const terminalContext: OrchestrationMessageContext = {
  version: 1,
  records: [
    {
      version: 1,
      contextId: ComposerContextId.make("ctx_terminal"),
      kind: "terminal",
      label: "Terminal 1 lines 1-2",
      terminalId: "term-1",
      terminalLabel: "Terminal 1",
      lineStart: 1,
      lineEnd: 2,
      text: "error: checkout failed",
    },
  ],
};

const harness = (name: string) =>
  Effect.gen(function* () {
    const cwd = yield* checkpointWorkspace(name);
    const events = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
    const started: ProviderAdapter.ProviderAdapterV2TurnInput[] = [];
    const adapter: ProviderAdapter.ProviderAdapterV2["Service"] = {
      instanceId,
      driver,
      getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
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
            // The provider accepts every turn it is given.
            startTurn: (turn) =>
              Effect.gen(function* () {
                started.push(turn);
                yield* Queue.offer(events, {
                  type: "provider_turn.updated",
                  driver,
                  providerTurn: {
                    id: ProviderTurnId.make(`provider-turn:${turn.attemptId}`),
                    providerThreadId: turn.providerThread.id,
                    nodeId: turn.rootNodeId,
                    runAttemptId: turn.attemptId,
                    nativeTurnRef: {
                      driver,
                      nativeId: `native:${turn.attemptId}`,
                      strength: "strong",
                    },
                    ordinal: turn.providerTurnOrdinal,
                    status: "running",
                    startedAt: now,
                    completedAt: null,
                  },
                });
              }),
            steerTurn: () => Effect.die("unused"),
            interruptTurn: () => Effect.void,
            respondToRuntimeRequest: () => Effect.die("unused"),
            readThreadSnapshot: () => Effect.die("unused"),
            rollbackThread: () => Effect.die("unused"),
            forkThread: () => Effect.die("unused"),
          };
        }),
    };
    const layer = ProviderReplayHarness.layerWithRegistry(
      { name },
      ProviderAdapterRegistry.layerSingle(adapter),
      { runEffectWorker: false },
    );
    return { cwd, layer, started };
  });

const scenario = (threadId: ThreadId, cwd: string) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
    let commands = 0;
    const providerTurnRunning = () =>
      orchestrator.streamDomainEvents.pipe(
        Stream.filter(
          (event) => event.type === "provider-turn.updated" && event.payload.status === "running",
        ),
        Stream.take(1),
        Stream.runDrain,
        Effect.forkScoped({ startImmediately: true }),
      );
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`create:${threadId}`),
      threadId,
      projectId: ProjectId.make(`project:${threadId}`),
      title: "Manual resume",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: cwd,
      createdBy: "user",
      creationSource: "web",
    });
    const send = (input: {
      readonly text: string;
      readonly attachments?: ReadonlyArray<ChatAttachment>;
      readonly context?: OrchestrationMessageContext;
      readonly notification?: OrchestrationV2Notification;
      readonly resumeOf?: OrchestrationV2Run["id"];
    }) => {
      commands += 1;
      return orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make(`send:${threadId}:${commands}`),
        threadId,
        messageId: MessageId.make(`message:${threadId}:${commands}`),
        text: input.text,
        attachments: input.attachments ?? [],
        ...(input.context ? { context: input.context } : {}),
        ...(input.notification ? { notification: input.notification } : {}),
        ...(input.resumeOf ? { manualContinuationOfRunId: input.resumeOf } : {}),
        dispatchMode: { type: input.notification ? "queue_after_active" : "start_immediately" },
        createdBy: input.notification ? "agent" : "user",
        creationSource: input.notification ? "server" : "web",
      });
    };
    const stop = Effect.gen(function* () {
      commands += 1;
      yield* orchestrator.dispatch({
        type: "thread.stop",
        commandId: CommandId.make(`stop:${threadId}:${commands}`),
        threadId,
      });
      yield* worker.drain();
      const run = (yield* orchestrator.getThreadProjection(threadId)).runs.at(-1)!;
      assert.equal(run.status, "interrupted");
      return run;
    });
    // Sends, then stops before the effect worker hands the turn to the provider.
    const stopBeforeAcceptance = (input: Parameters<typeof send>[0]) =>
      Effect.gen(function* () {
        yield* send(input);
        return yield* stop;
      });
    const sendAccepted = (input: Parameters<typeof send>[0]) =>
      Effect.gen(function* () {
        const running = yield* providerTurnRunning();
        yield* send(input);
        yield* worker.drain();
        yield* Fiber.join(running);
      });
    const resume = (source: OrchestrationV2Run) => send({ text: CONTINUE, resumeOf: source.id });
    const resumeAndStart = (source: OrchestrationV2Run) =>
      sendAccepted({ text: CONTINUE, resumeOf: source.id });
    return { orchestrator, stop, stopBeforeAcceptance, sendAccepted, resume, resumeAndStart };
  });

it.effect("Resume after a Stop the provider never saw resends the original message", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { cwd, layer, started } = yield* harness("manual-resume-unaccepted");
      yield* Effect.gen(function* () {
        const threadId = ThreadId.make("thread:manual-resume-unaccepted");
        const { orchestrator, stopBeforeAcceptance, resume, resumeAndStart } = yield* scenario(
          threadId,
          cwd,
        );
        const source = yield* stopBeforeAcceptance({
          text: ORIGINAL,
          attachments: [screenshot],
          context: terminalContext,
        });
        assert.lengthOf(started, 0);

        yield* resumeAndStart(source);
        // A second Resume of the same run, from another client, starts nothing.
        assert.isTrue(Exit.isFailure(yield* resume(source).pipe(Effect.exit)));

        assert.lengthOf(started, 1);
        const delivered = started[0]!.message;
        assert.include(delivered.text, "User message:\nFix the checkout page after [Terminal: log");
        assert.include(delivered.text, "error: checkout failed");
        // The history copy is existing behaviour; a later change is expected to remove it.
        const [history, request, ...rest] = delivered.text.split("\nUser message:\n");
        assert.lengthOf(rest, 0);
        assert.include(history, "[Historical user; user_message;");
        assert.lengthOf(history!.split("Fix the checkout page").slice(1), 1);
        assert.lengthOf(request!.split("Fix the checkout page").slice(1), 1);
        assert.notInclude(delivered.text, CONTINUE);
        assert.deepEqual(delivered.attachments, [screenshot]);

        const projection = yield* orchestrator.getThreadProjection(threadId);
        assert.lengthOf(projection.runs, 2);
        const resent = projection.messages.find(
          (message) => message.id === projection.runs[1]!.userMessageId,
        )!;
        assert.equal(resent.text, ORIGINAL);
        assert.deepEqual(resent.context, terminalContext);
        assert.deepEqual(resent.attachments, [screenshot]);
        assert.isFalse(projection.messages.some((message) => message.text === CONTINUE));
        // Attachment files are removed only with the thread, which collects them from every message.
        assert.deepEqual(
          projection.messages.map((message) => message.attachments.map((file) => file.id)),
          [[screenshot.id], [screenshot.id]],
        );
      }).pipe(Effect.provide(layer));
    }),
  ),
);

it.effect(
  "Resume of an accepted run continues, and an unsent continuation is resent as itself",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { cwd, layer, started } = yield* harness("manual-resume-accepted");
        yield* Effect.gen(function* () {
          const threadId = ThreadId.make("thread:manual-resume-accepted");
          const { orchestrator, stop, sendAccepted, resume, resumeAndStart } = yield* scenario(
            threadId,
            cwd,
          );
          yield* sendAccepted({ text: "Fix the checkout page", attachments: [screenshot] });
          const acceptedSource = yield* stop;

          yield* resume(acceptedSource);
          const unsentContinuation = yield* stop;
          yield* resumeAndStart(unsentContinuation);

          assert.deepEqual(
            started.map((turn) => turn.message.attachments.length),
            [1, 0],
          );
          assert.equal(started[0]!.message.text, "Fix the checkout page");
          assert.isTrue(started[1]!.message.text.endsWith(`User message:\n${CONTINUE}`));
          const projection = yield* orchestrator.getThreadProjection(threadId);
          assert.deepEqual(
            projection.messages.map((message) => message.text),
            ["Fix the checkout page", CONTINUE, CONTINUE],
          );
        }).pipe(Effect.provide(layer));
      }),
    ),
);

it.effect("Resume of a wake the provider never saw keeps the continuation", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { cwd, layer, started } = yield* harness("manual-resume-wake");
      yield* Effect.gen(function* () {
        const threadId = ThreadId.make("thread:manual-resume-wake");
        const { stopBeforeAcceptance, resumeAndStart } = yield* scenario(threadId, cwd);
        const source = yield* stopBeforeAcceptance({
          text: "A background task finished.",
          notification: {
            source: { kind: "system" },
            outcome: "updated",
            summary: "Background task finished",
          },
        });
        yield* resumeAndStart(source);

        assert.lengthOf(started, 1);
        assert.isTrue(started[0]!.message.text.endsWith(`User message:\n${CONTINUE}`));
      }).pipe(Effect.provide(layer));
    }),
  ),
);
