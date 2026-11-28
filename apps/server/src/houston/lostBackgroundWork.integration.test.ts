import type { SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  ClaudeSettings,
  CommandId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2PendingBackgroundTask,
} from "@houston-app/contracts";
import * as IdAllocator from "@houston-app/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@houston-app/provider-core/server/McpProviderSessions";
import type * as Cause from "effect/Cause";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { checkpointWorkspace } from "@houston-app/provider-testing/replayWorkspace";
import * as ClaudeAdapterV2 from "../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import * as EffectWorker from "../orchestration-v2/EffectWorker.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ProviderSessionManager from "../orchestration-v2/ProviderSessionManager.ts";
import * as ProviderReplayHarness from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import { writeLostBackgroundWork } from "./lostBackgroundWork.ts";

const sessionId = "lost-background-work-session";
const settings = Schema.decodeSync(ClaudeSettings)({});
const modelSelection = {
  instanceId: ProviderInstanceId.make("claudeAgent"),
  model: "claude-sonnet-4-6",
};
const taskId = "b8sleep180";
const exitNote = "your agent process exited";

function frame(value: unknown): SDKMessage {
  return value as SDKMessage;
}

const roster = (tasks: ReadonlyArray<string>, uuid: string) =>
  frame({
    type: "system",
    subtype: "background_tasks_changed",
    tasks: tasks.map((id) => ({ task_id: id, task_type: "local_bash", description: "sleep 180" })),
    uuid,
    session_id: sessionId,
  });

const result = (uuid: string) =>
  frame({
    type: "result",
    subtype: "success",
    uuid,
    session_id: sessionId,
    is_error: false,
    num_turns: 1,
    result: "",
    stop_reason: "end_turn",
    terminal_reason: "completed",
    permission_denials: [],
    duration_ms: 1,
    duration_api_ms: 1,
    total_cost_usd: 0,
    usage: { input_tokens: 1, output_tokens: 1 },
    modelUsage: {},
  });

type Scenario = {
  /** Whether the agent registered a wait on the task before ending its turn. */
  readonly awaited: boolean;
  /** The CLI reports the task finished, emptying its list, before the process exits. */
  readonly workEndsFirst?: boolean;
  /** What the user does after the turn instead of the process being killed. */
  readonly before?: "stop" | "delete";
};

type ExitError = ClaudeAdapterV2.ClaudeAgentSdkQueryRunnerError | Cause.Done;

type Probe = {
  readonly calls: ReadonlyArray<string>;
  readonly offers: ReadonlyArray<SDKUserMessage>;
  readonly processes: ReadonlyArray<Queue.Queue<SDKMessage, ExitError>>;
  readonly orchestrator: Orchestrator.OrchestratorV2Shape;
  readonly threadId: ThreadId;
  readonly firstRunId: string;
  /** Writes the same loss again, as a repeated exit event would. */
  readonly repeatLoss: Effect.Effect<void>;
  /** Sends a user message and answers its turn. */
  readonly send: (id: string) => Effect.Effect<void>;
};

// Composed fixture: the fake SDK replays the frames Claude Code sends for a background
// Bash task; a killed CLI then fails its message stream without a result.
const exitWhileIdle = (scenario: Scenario, check: (probe: Probe) => Effect.Effect<void>) =>
  Effect.scoped(
    Effect.gen(function* () {
      const cwd = yield* checkpointWorkspace("houston-lost-background-work");
      const processes: Array<Queue.Queue<SDKMessage, ExitError>> = [];
      const offers: SDKUserMessage[] = [];
      const calls: string[] = [];
      // The adapter logs this as its last step with a process whose stream failed.
      const exitHandled = yield* Deferred.make<void>();
      const logger = Logger.make(({ message }) => {
        if (String(message).includes("orchestration-v2.claude-query-stream-failed")) {
          Deferred.doneUnsafe(exitHandled, Effect.void);
        }
      });
      const registry = Layer.unwrap(
        Effect.gen(function* () {
          const adapter = yield* ClaudeAdapterV2.makeClaudeAdapterV2({
            instanceId: modelSelection.instanceId,
            settings,
            environment: {},
            attachmentsDir: cwd,
            fileSystem: yield* FileSystem.FileSystem,
            path: yield* Path.Path,
            random: yield* SecureRandom.SecureRandom,
            idAllocator: yield* IdAllocator.IdAllocatorV2,
            queryRunner: {
              allocateSessionId: Effect.succeed(sessionId),
              open: () =>
                Effect.gen(function* () {
                  const sdkMessages = yield* Queue.unbounded<SDKMessage, ExitError>();
                  processes.push(sdkMessages);
                  return {
                    messages: Stream.fromQueue(sdkMessages),
                    offer: (message: SDKUserMessage) =>
                      Effect.sync(() => void offers.push(message)),
                    setModel: () => Effect.void,
                    applyFlagSettings: () => Effect.void,
                    setPermissionMode: () => Effect.void,
                    backgroundTasks: () => Effect.succeed(false),
                    mcpServerStatus: Effect.succeed([]),
                    readMcpResource: () => Effect.die("unexpected MCP resource read"),
                    callMcpTool: () => Effect.die("unexpected MCP tool call"),
                    mcpAuthenticate: () => Effect.die("unexpected MCP sign-in"),
                    mcpSubmitOAuthCallbackUrl: () => Effect.die("unexpected MCP sign-in"),
                    reconnectMcpServer: () => Effect.die("unexpected MCP reconnect"),
                    listPermissionRules: Effect.die("unexpected permission rules read"),
                    stopTask: (id: string) => Effect.sync(() => void calls.push(`stopTask:${id}`)),
                    interrupt: Effect.sync(() => void calls.push("interrupt")),
                    close: Effect.sync(() => void calls.push("close")).pipe(
                      Effect.andThen(Queue.shutdown(sdkMessages)),
                    ),
                  };
                }),
              forkSession: () => Effect.die("unused"),
              subagentLaunchToolUseId: () => Effect.succeed(null),
              assertComplete: Effect.void,
            },
          });
          return ProviderAdapterRegistry.layerSingle(adapter);
        }),
      ).pipe(
        Layer.provide(Layer.mergeAll(IdAllocator.layer, NodeServices.layer, NodeCrypto.layer)),
      );
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const sessions = yield* ProviderSessionManager.ProviderSessionManagerV2;
        const eventSink = yield* EventSink.EventSinkV2;
        const idAllocator = yield* IdAllocator.IdAllocatorV2;
        const threadId = ThreadId.make("thread:lost-background-work");
        const watch = (predicate: (event: OrchestrationV2DomainEvent) => boolean) =>
          orchestrator.streamDomainEvents.pipe(
            Stream.filter(predicate),
            Stream.take(1),
            Stream.runDrain,
            Effect.forkScoped,
          );
        const startTurn = (id: string, text: string) =>
          Effect.gen(function* () {
            const running = yield* watch(
              (event) =>
                event.type === "provider-turn.updated" && event.payload.status === "running",
            );
            yield* orchestrator.dispatch({
              type: "message.dispatch",
              commandId: CommandId.make(id),
              threadId,
              messageId: MessageId.make(id),
              text,
              attachments: [],
              dispatchMode: { type: "start_immediately" },
              createdBy: "user",
              creationSource: "web",
            });
            yield* worker.drain();
            yield* Fiber.join(running);
          });
        const endTurn = (uuid: string) =>
          Effect.gen(function* () {
            const settled = yield* watch(
              (event) =>
                event.type === "run.updated" &&
                (event.payload.status === "waiting" || event.payload.status === "completed"),
            );
            yield* Queue.offer(processes.at(-1)!, result(uuid));
            yield* Fiber.join(settled);
            yield* worker.drain();
          });
        yield* orchestrator.dispatch({
          type: "thread.create",
          commandId: CommandId.make("create"),
          threadId,
          projectId: ProjectId.make("project:lost-background-work"),
          title: "Lost background work",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: cwd,
          createdBy: "user",
          creationSource: "web",
        });
        yield* startTurn("first", "Sleep 180 seconds in the background and wait for it.");
        const firstProcess = processes[0]!;
        const rostered = yield* watch(
          (event) =>
            event.type === "provider-thread.updated" &&
            event.payload.pendingBackgroundTasks?.some((task) => task.taskId === taskId) === true,
        );
        yield* Queue.offer(firstProcess, roster([taskId], "roster"));
        yield* Fiber.join(rostered);
        if (scenario.awaited) {
          const records = yield* orchestrator.getThreadRecords(threadId, ["providerThreads"]);
          const providerThread = records.providerThreads[0]!;
          const runtime = yield* sessions.get(providerThread.providerSessionId!);
          if (Option.isNone(runtime) || runtime.value.awaitBackgroundTasks === undefined) {
            return yield* Effect.die("the Claude runtime must accept background waits");
          }
          const awaitedRoster = yield* watch(
            (event) =>
              event.type === "provider-thread.updated" &&
              event.payload.pendingBackgroundTasks?.some((task) => task.awaited === true) === true,
          );
          yield* runtime.value.awaitBackgroundTasks({
            providerThread,
            taskIds: [taskId],
            awaited: true,
          });
          yield* Fiber.join(awaitedRoster);
        }
        if (scenario.workEndsFirst === true) {
          const emptied = yield* watch(
            (event) =>
              event.type === "provider-thread.updated" &&
              (event.payload.pendingBackgroundTasks?.length ?? 0) === 0,
          );
          yield* Queue.offer(firstProcess, roster([], "roster-empty"));
          yield* Fiber.join(emptied);
        }
        yield* endTurn("waiting-on-sleep");
        const firstRun = (yield* orchestrator.getThreadProjection(threadId)).runs[0]!;

        if (scenario.before === undefined) {
          // A loss is written before the exit's roster clear is.
          const cleared =
            scenario.workEndsFirst === true
              ? null
              : yield* watch(
                  (event) =>
                    event.type === "provider-thread.updated" &&
                    (event.payload.pendingBackgroundTasks?.length ?? 0) === 0,
                );
          // The CLI is killed while the thread is idle; the Houston server keeps running.
          yield* Queue.fail(
            firstProcess,
            new ClaudeAdapterV2.ClaudeAgentSdkQueryRunnerError({
              method: "messages",
              cause: "Claude Code process exited with code 137",
            }),
          );
          yield* Deferred.await(exitHandled);
          if (cleared !== null) yield* Fiber.join(cleared);
        } else {
          // Stop and delete end the process themselves and wait until the adapter is done with it.
          yield* orchestrator.dispatch(
            scenario.before === "stop"
              ? { type: "thread.stop", commandId: CommandId.make("stop"), threadId }
              : { type: "thread.delete", commandId: CommandId.make("delete"), threadId },
          );
        }
        yield* worker.drain();

        const lostTasks: ReadonlyArray<OrchestrationV2PendingBackgroundTask> = [
          { taskId, description: "sleep 180", kind: "command", awaited: true },
        ];
        yield* check({
          calls,
          offers,
          processes,
          orchestrator,
          threadId,
          firstRunId: firstRun.id,
          send: (id) =>
            startTurn(id, `User message ${id}.`).pipe(
              Effect.andThen(endTurn(`result-${id}`)),
              Effect.orDie,
              Effect.scoped,
            ),
          repeatLoss: writeLostBackgroundWork(
            {
              readRuns: (id) =>
                orchestrator.getThreadRecords(id, ["runs"]).pipe(
                  Effect.map((records) => records.runs),
                  Effect.orDie,
                ),
              eventSink,
              allocateEventId: idAllocator.allocate.event({ threadId }),
            },
            { threadId, providerThreadId: firstRun.providerThreadId!, tasks: lostTasks },
          ).pipe(Effect.andThen(worker.drain()), Effect.orDie),
        });
      }).pipe(
        Effect.provide(
          ProviderReplayHarness.layerWithRegistry(
            { name: "houston-lost-background-work" },
            registry,
            {
              runEffectWorker: false,
            },
          ).pipe(Layer.provideMerge(Logger.layer([logger], { mergeWithExisting: true }))),
        ),
      );
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          IdAllocator.layer,
          McpProviderSessions.layer,
          NodeServices.layer,
          NodeCrypto.layer,
        ),
      ),
    ),
  );

const projectionOf = (probe: Probe) =>
  probe.orchestrator.getThreadProjection(probe.threadId).pipe(Effect.orDie);
const recordedOf = (probe: Probe) =>
  projectionOf(probe).pipe(
    Effect.map(
      ({ runs }) => runs.find((run) => run.id === probe.firstRunId)?.restartCancelledBackgroundWork,
    ),
  );
const laterRunsOf = (probe: Probe) =>
  projectionOf(probe).pipe(
    Effect.map(({ runs }) => runs.filter((run) => run.id !== probe.firstRunId)),
  );
const offerText = (offer: SDKUserMessage | undefined) => JSON.stringify(offer?.message ?? null);

it.effect("wakes the agent once when Claude's process exits while it awaits background work", () =>
  exitWhileIdle({ awaited: true }, (probe) =>
    Effect.gen(function* () {
      assert.deepEqual(
        (yield* recordedOf(probe))?.map((work) => [work.id, work.awaited, work.cause]),
        [[taskId, true, "provider_exit"]],
        "the run records the task the exited process took with it",
      );
      const projection = yield* projectionOf(probe);
      assert.equal(
        projection.providerThreads[0]?.pendingBackgroundTasks?.length ?? 0,
        0,
        "the wait on lost work is cleared",
      );
      assert.lengthOf(yield* laterRunsOf(probe), 1, "the agent is woken exactly once");
      const wake = projection.messages.find(
        (message) => message.id === `message:restart-continuation:${probe.firstRunId}`,
      );
      assert.include(wake?.text ?? "", taskId, "the wake names the lost task");
      assert.include(wake?.text ?? "", exitNote);
      assert.notInclude(wake?.text ?? "", "server restarted");
      yield* probe.repeatLoss;
      assert.lengthOf(yield* laterRunsOf(probe), 1, "a repeated loss wakes no one again");
    }),
  ),
);

it.effect("delivers the note for an unawaited lost shell once, with the next user message", () =>
  exitWhileIdle({ awaited: false }, (probe) =>
    Effect.gen(function* () {
      assert.deepEqual(
        (yield* recordedOf(probe))?.map((work) => [work.id, work.awaited, work.cause]),
        [[taskId, undefined, "provider_exit"]],
        "the run records the shell the exited process took with it",
      );
      assert.lengthOf(yield* laterRunsOf(probe), 0, "unawaited work wakes no one");
      assert.lengthOf(probe.offers, 1);
      yield* probe.send("second");
      assert.lengthOf(probe.processes, 2, "the next message runs on a new process");
      assert.lengthOf(probe.offers, 2);
      const delivered = offerText(probe.offers[1]);
      assert.include(delivered, exitNote, "the next user message carries the note");
      assert.include(delivered, taskId);
      assert.equal(delivered.split(exitNote).length - 1, 1, "the note is delivered once");
      yield* probe.send("third");
      assert.lengthOf(probe.offers, 3);
      assert.notInclude(offerText(probe.offers[2]), exitNote, "the note is not repeated");
    }),
  ),
);

it.effect("records nothing and wakes no one when Claude exits after its work list emptied", () =>
  exitWhileIdle({ awaited: true, workEndsFirst: true }, (probe) =>
    Effect.gen(function* () {
      // The next turn's events pass through the same event pump after anything the exit reported.
      yield* probe.send("second");
      assert.equal(yield* recordedOf(probe), undefined, "nothing was lost, so nothing is recorded");
      const later = yield* laterRunsOf(probe);
      assert.deepEqual(
        later.map((run) => run.restartContinuationOfRunId ?? null),
        [null],
        "no wake without a loss: the only later run is the user's",
      );
      assert.notInclude(offerText(probe.offers[1]), exitNote);
    }),
  ),
);

it.effect.each(["stop", "delete"] as const)(
  "does not report a loss or wake the agent when the user's %s ends Claude's process",
  (before) =>
    exitWhileIdle({ awaited: true, before }, (probe) =>
      Effect.gen(function* () {
        assert.deepEqual(probe.calls, ["close"], `the ${before} ends the process`);
        const projection = yield* projectionOf(probe);
        assert.equal(
          yield* recordedOf(probe),
          undefined,
          `work the ${before} ended is not recorded as lost`,
        );
        assert.equal(
          projection.providerThreads[0]?.pendingBackgroundTasks?.length ?? 0,
          0,
          "the ended work leaves the list",
        );
        assert.lengthOf(yield* laterRunsOf(probe), 0, `no wake after the ${before}`);
        assert.isFalse(
          projection.messages.some((message) => message.text.includes(exitNote)),
          "no loss note is dispatched",
        );
      }),
    ),
);
