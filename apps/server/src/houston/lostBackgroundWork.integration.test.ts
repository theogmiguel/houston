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
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
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

function frame(value: unknown): SDKMessage {
  return value as SDKMessage;
}

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
  /** What the user did after the turn and before the process exited. */
  readonly before?: "stop" | "delete";
  /** Write the same loss a second time after the wake, as a repeated exit event would. */
  readonly repeat?: boolean;
};

// Composed fixture: the fake SDK replays the frames Claude Code sends for a background
// Bash task, then its message stream ends without a result, as when the CLI is killed.
const exitWhileIdle = (scenario: Scenario) =>
  Effect.scoped(
    Effect.gen(function* () {
      const cwd = yield* checkpointWorkspace("houston-lost-background-work");
      const processes: Array<Queue.Queue<SDKMessage, Cause.Done>> = [];
      const offers: SDKUserMessage[] = [];
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
                  const sdkMessages = yield* Queue.unbounded<SDKMessage, Cause.Done>();
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
                    listPermissionRules: Effect.die("unexpected permission rules read"),
                    stopTask: () => Effect.void,
                    interrupt: Effect.void,
                    close: Queue.shutdown(sdkMessages),
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
        const running = yield* watch(
          (event) => event.type === "provider-turn.updated" && event.payload.status === "running",
        );
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("first"),
          threadId,
          messageId: MessageId.make("first"),
          text: "Sleep 180 seconds in the background and wait for it.",
          attachments: [],
          dispatchMode: { type: "start_immediately" },
          createdBy: "user",
          creationSource: "web",
        });
        yield* worker.drain();
        yield* Fiber.join(running);
        const firstProcess = processes[0]!;
        {
          const rostered = yield* watch(
            (event) =>
              event.type === "provider-thread.updated" &&
              event.payload.pendingBackgroundTasks?.some((task) => task.taskId === taskId) === true,
          );
          yield* Queue.offer(
            firstProcess,
            frame({
              type: "system",
              subtype: "background_tasks_changed",
              tasks: [{ task_id: taskId, task_type: "local_bash", description: "sleep 180" }],
              uuid: "roster",
              session_id: sessionId,
            }),
          );
          yield* Fiber.join(rostered);
        }
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
        const settled = yield* watch(
          (event) =>
            event.type === "run.updated" &&
            (event.payload.status === "waiting" || event.payload.status === "completed"),
        );
        yield* Queue.offer(firstProcess, result("waiting-on-sleep"));
        yield* Fiber.join(settled);
        yield* worker.drain();
        const firstRun = (yield* orchestrator.getThreadProjection(threadId)).runs[0]!;

        if (scenario.before === "stop") {
          yield* orchestrator.dispatch({
            type: "thread.stop",
            commandId: CommandId.make("stop"),
            threadId,
          });
          yield* worker.drain();
        } else if (scenario.before === "delete") {
          yield* orchestrator.dispatch({
            type: "thread.delete",
            commandId: CommandId.make("delete"),
            threadId,
          });
          yield* worker.drain();
        }

        if (scenario.before === undefined) {
          // The exit clears the roster only after any loss it reports has been written.
          const cleared = yield* watch(
            (event) =>
              event.type === "provider-thread.updated" &&
              (event.payload.pendingBackgroundTasks?.length ?? 0) === 0,
          );
          // The CLI exits while the thread is idle; the Houston server keeps running.
          yield* Queue.end(firstProcess);
          yield* Fiber.join(cleared);
          yield* worker.drain();
        }

        const afterExit = yield* orchestrator.getThreadProjection(threadId);
        const recorded = afterExit.runs.find(
          (run) => run.id === firstRun.id,
        )?.restartCancelledBackgroundWork;
        const lostTasks: ReadonlyArray<OrchestrationV2PendingBackgroundTask> = [
          {
            taskId,
            description: "sleep 180",
            kind: "command",
            ...(scenario.awaited ? { awaited: true as const } : {}),
          },
        ];
        const laterRuns = () =>
          orchestrator
            .getThreadProjection(threadId)
            .pipe(Effect.map(({ runs }) => runs.filter((run) => run.id !== firstRun.id)));
        return {
          recorded,
          afterExit,
          firstRun,
          offers,
          laterRuns,
          repeat: (tasks = lostTasks) =>
            writeLostBackgroundWork(
              {
                readRuns: (id) =>
                  orchestrator.getThreadRecords(id, ["runs"]).pipe(
                    Effect.map((records) => records.runs),
                    Effect.orDie,
                  ),
                eventSink,
                allocateEventId: idAllocator.allocate.event({ threadId }),
              },
              {
                threadId,
                providerThreadId: firstRun.providerThreadId!,
                tasks,
              },
            ).pipe(Effect.andThen(worker.drain())),
        };
      }).pipe(
        Effect.flatMap((state) =>
          Effect.gen(function* () {
            const { recorded, afterExit, firstRun } = state;
            if (scenario.before !== undefined) {
              // A deliberate stop or delete is not a loss; a loss reported anyway still wakes no one.
              assert.equal(
                recorded,
                undefined,
                `a ${scenario.before} is not reported as lost work`,
              );
              yield* state.repeat();
              assert.lengthOf(
                yield* state.laterRuns(),
                0,
                `a thread after ${scenario.before} is not woken`,
              );
              return;
            }
            assert.deepEqual(
              recorded?.map((work) => [work.id, work.awaited, work.cause]),
              [[taskId, scenario.awaited ? true : undefined, "provider_exit"]],
              "the run records the task the exited process took with it",
            );
            assert.equal(
              afterExit.providerThreads[0]?.pendingBackgroundTasks?.length ?? 0,
              0,
              "the wait on lost work is cleared",
            );
            const woken = yield* state.laterRuns();
            assert.lengthOf(
              woken,
              scenario.awaited ? 1 : 0,
              "only awaited work wakes the agent, exactly once",
            );
            if (!scenario.awaited) {
              yield* state.repeat([]);
              assert.lengthOf(yield* state.laterRuns(), 0, "no wake without a loss");
              return;
            }
            const wake = afterExit.messages.find(
              (message) => message.id === `message:restart-continuation:${firstRun.id}`,
            );
            assert.include(wake?.text ?? "", taskId, "the wake names the lost task");
            assert.include(wake?.text ?? "", "agent process exited");
            assert.notInclude(wake?.text ?? "", "server restarted");
            if (scenario.repeat === true) {
              yield* state.repeat();
              assert.lengthOf(yield* state.laterRuns(), 1, "a repeated loss wakes no one again");
            }
          }),
        ),
        Effect.provide(
          ProviderReplayHarness.layerWithRegistry(
            { name: "houston-lost-background-work" },
            registry,
            {
              runEffectWorker: false,
            },
          ),
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

it.effect("wakes the agent once when Claude's process exits while it awaits background work", () =>
  exitWhileIdle({ awaited: true, repeat: true }),
);

it.effect("records but does not wake for an unawaited shell lost when Claude's process exits", () =>
  exitWhileIdle({ awaited: false }),
);

it.effect("does not wake a thread the user stopped before Claude's process exited", () =>
  exitWhileIdle({ awaited: true, before: "stop" }),
);

it.effect("does not wake a thread deleted before Claude's process exited", () =>
  exitWhileIdle({ awaited: true, before: "delete" }),
);
