// In-test provider doubles behind the real orchestrator and effect worker, one per driver, so a
// source thread and its side threads can run on different providers. No CLI, network or
// recording: each double reports the turns it was asked to run and answers them itself.
import {
  CommandId,
  EnvironmentId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  ThreadId,
  TurnItemId,
  type ModelSelection,
  type OrchestrationV2Command,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ProviderCapabilities,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ProviderTurn,
  type OrchestrationV2Run,
  type ProviderInteractionMode,
  type RuntimeMode,
} from "@t3tools/contracts";
import type * as McpProviderSession from "@t3tools/provider-core/server/mcpSession";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { checkpointWorkspace } from "@t3tools/provider-testing/replayWorkspace";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";

import { ClaudeProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as EffectWorker from "../orchestration-v2/EffectWorker.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import * as McpSessionRegistry from "../mcp/McpSessionRegistry.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { AcpProviderCapabilitiesV2 } from "@t3tools/provider-acp/server/adapter";

const ACTIVE_RUN_STATUSES: ReadonlySet<OrchestrationV2Run["status"]> = new Set([
  "preparing",
  "starting",
  "running",
  "waiting",
]);

type ReadOnlyRun = NonNullable<OrchestrationV2ProviderCapabilities["runtimePolicy"]["readOnlyRun"]>;

/** Capabilities that declare a proven read-only run, as the real adapter would. */
export const withReadOnlyRun = (
  capabilities: OrchestrationV2ProviderCapabilities,
  readOnlyRun: ReadOnlyRun,
): OrchestrationV2ProviderCapabilities => ({
  ...capabilities,
  runtimePolicy: { ...capabilities.runtimePolicy, readOnlyRun },
});

/** Capabilities with no read-only run, whatever the base declares. */
export const withoutReadOnlyRun = (
  capabilities: OrchestrationV2ProviderCapabilities,
): OrchestrationV2ProviderCapabilities => {
  const { readOnlyRun: _readOnlyRun, ...runtimePolicy } = capabilities.runtimePolicy;
  return { ...capabilities, runtimePolicy };
};

export interface DoubleSpec {
  readonly driver: string;
  /** The provider instance; the driver's name when absent. */
  readonly instanceId?: string;
  readonly capabilities: OrchestrationV2ProviderCapabilities;
}

export const CODEX: DoubleSpec = {
  driver: "codex",
  capabilities: withReadOnlyRun(CodexProviderCapabilitiesV2, "sandbox"),
};
export const CLAUDE: DoubleSpec = {
  driver: "claudeAgent",
  capabilities: withReadOnlyRun(ClaudeProviderCapabilitiesV2, "permissionMode"),
};
export const ANTIGRAVITY: DoubleSpec = {
  driver: "antigravity",
  capabilities: withoutReadOnlyRun(AcpProviderCapabilitiesV2),
};
export const ACP_REGISTRY: DoubleSpec = {
  driver: "acpRegistry",
  capabilities: withoutReadOnlyRun(AcpProviderCapabilitiesV2),
};

export interface StartedTurn {
  readonly driver: string;
  readonly input: ProviderAdapter.ProviderAdapterV2TurnInput;
  /** The T3 MCP credential the session held for this thread when the turn started. */
  readonly mcp: McpProviderSession.McpProviderSessionConfig | undefined;
}

export interface Script {
  /** Message ids whose turn stays running until `release`. */
  readonly hold: Set<string>;
  /** The assistant text a message's turn ends with; `answer: <text>` by default. */
  readonly replies: Map<string, string>;
  /** An assistant message a message's turn writes before its reply. */
  readonly commentary: Map<string, string>;
  /** Message ids whose turn ends with no assistant text. */
  readonly silent: Set<string>;
  /** Work a message's turn does in the workspace before it ends. */
  readonly edits: Map<string, (cwd: string) => Effect.Effect<void>>;
}

export interface Log {
  readonly started: StartedTurn[];
  readonly steered: ProviderAdapter.ProviderAdapterV2SteerInput[];
  readonly interrupted: ProviderTurnId[];
  readonly forks: ProviderAdapter.ProviderAdapterV2ForkThreadInput[];
  readonly mcpIssued: ThreadId[];
}

interface LiveTurn {
  readonly turn: OrchestrationV2ProviderTurn;
  readonly input: ProviderAdapter.ProviderAdapterV2TurnInput;
  readonly events: Queue.Queue<ProviderAdapter.ProviderAdapterV2Event>;
  readonly driver: ProviderDriverKind;
}

const makeAdapter = (
  spec: DoubleSpec,
  cwd: string,
  script: Script,
  log: Log,
  live: Map<string, LiveTurn>,
  mcpSessions: McpProviderSessions.McpProviderSessions["Service"],
): ProviderAdapter.ProviderAdapterV2["Service"] => {
  const driver = ProviderDriverKind.make(spec.driver);
  const instanceId = ProviderInstanceId.make(spec.instanceId ?? spec.driver);
  const providerThreadFor = (
    threadId: ThreadId,
    providerSessionId: OrchestrationV2ProviderThread["providerSessionId"],
    now: DateTime.Utc,
    forkedFrom: OrchestrationV2ProviderThread["forkedFrom"] = null,
  ): OrchestrationV2ProviderThread => ({
    id: ProviderThreadId.make(`provider-thread:${spec.instanceId ?? spec.driver}:${threadId}`),
    driver,
    providerInstanceId: instanceId,
    providerSessionId,
    appThreadId: threadId,
    ownerNodeId: null,
    nativeThreadRef: { driver, nativeId: `native:${threadId}`, strength: "strong" },
    nativeConversationHeadRef: null,
    status: "idle",
    firstRunOrdinal: null,
    lastRunOrdinal: null,
    handoffIds: [],
    forkedFrom,
    createdAt: now,
    updatedAt: now,
  });
  return {
    instanceId,
    driver,
    getCapabilities: () => Effect.succeed(spec.capabilities),
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
            model: input.modelSelection.model,
            capabilities: spec.capabilities,
            createdAt: now,
            updatedAt: now,
            lastError: null,
          },
          events: Stream.fromQueue(events),
          ensureThread: ({ threadId }) =>
            DateTime.now.pipe(
              Effect.map((at) => providerThreadFor(threadId, input.providerSessionId, at)),
            ),
          resumeThread: ({ providerThread }) => Effect.succeed(providerThread),
          startTurn: (turn) =>
            Effect.gen(function* () {
              log.started.push({
                driver: spec.driver,
                input: turn,
                mcp: yield* mcpSessions.read(turn.threadId),
              });
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
              yield* Queue.offer(events, { type: "provider_turn.updated", driver, providerTurn });
              const messageId = turn.message.messageId;
              live.set(messageId, { turn: providerTurn, input: turn, events, driver });
              if (!script.hold.has(messageId)) yield* finish(live, script, cwd, messageId);
            }),
          steerTurn: (turn) =>
            Effect.sync(() => {
              log.steered.push(turn);
              return { adoption: "notReported" } as const;
            }),
          interruptTurn: ({ providerTurnId }) =>
            Effect.gen(function* () {
              log.interrupted.push(providerTurnId);
              for (const [messageId, entry] of live) {
                if (entry.turn.id === providerTurnId) {
                  yield* end(entry, "interrupted");
                  live.delete(messageId);
                }
              }
            }),
          respondToRuntimeRequest: () => Effect.void,
          readThreadSnapshot: () => Effect.die("unused"),
          rollbackThread: () => Effect.die("unused"),
          forkThread: (fork) =>
            Effect.gen(function* () {
              log.forks.push(fork);
              return providerThreadFor(
                fork.targetThreadId,
                input.providerSessionId,
                yield* DateTime.now,
                {
                  providerThreadId: fork.sourceProviderThread.id,
                  ...(fork.providerTurnId === undefined
                    ? {}
                    : { providerTurnId: fork.providerTurnId }),
                },
              );
            }),
        };
      }),
  };
};

const end = (entry: LiveTurn, status: "completed" | "interrupted") =>
  Effect.gen(function* () {
    const ended = { ...entry.turn, status, completedAt: yield* DateTime.now };
    yield* Queue.offer(entry.events, {
      type: "provider_turn.updated",
      driver: entry.driver,
      providerTurn: ended,
    });
    yield* Queue.offer(entry.events, {
      type: "turn.terminal",
      driver: entry.driver,
      providerThreadId: entry.turn.providerThreadId,
      providerTurnId: entry.turn.id,
      runOrdinal: entry.input.runOrdinal,
      status,
      failure: null,
      threadDisposition: "reusable",
    });
  });

const finish = (live: Map<string, LiveTurn>, script: Script, cwd: string, messageId: string) =>
  Effect.gen(function* () {
    const entry = live.get(messageId);
    if (entry === undefined) return yield* Effect.die(`no running turn for ${messageId}`);
    const edit = script.edits.get(messageId);
    if (edit !== undefined) yield* edit(cwd);
    if (!script.silent.has(messageId)) {
      const now = yield* DateTime.now;
      const text = script.replies.get(messageId) ?? `answer: ${entry.input.message.text}`;
      const commentary = script.commentary.get(messageId);
      const assistantMessage = (suffix: string, ordinal: number, body: string) =>
        Queue.offer(entry.events, {
          type: "turn_item.updated",
          driver: entry.driver,
          turnItem: {
            id: TurnItemId.make(`assistant:${messageId}${suffix}`),
            threadId: entry.input.threadId,
            runId: entry.input.runId,
            nodeId: entry.input.rootNodeId,
            providerThreadId: entry.turn.providerThreadId,
            providerTurnId: entry.turn.id,
            nativeItemRef: null,
            parentItemId: null,
            ordinal,
            status: "completed",
            title: null,
            startedAt: now,
            completedAt: now,
            updatedAt: now,
            type: "assistant_message",
            messageId: MessageId.make(`assistant:${messageId}${suffix}`),
            text: body,
            streaming: false,
          },
        });
      if (commentary !== undefined) yield* assistantMessage(":commentary", 0, commentary);
      yield* assistantMessage("", commentary === undefined ? 0 : 1, text);
    }
    yield* end(entry, "completed");
    live.delete(messageId);
  });

/** Records which threads were issued a T3 MCP credential; issues a test credential as upstream's testkit does. */
const recordingMcpRegistry = (log: Log) =>
  Layer.succeed(
    McpSessionRegistry.McpSessionRegistry,
    McpSessionRegistry.McpSessionRegistry.of({
      issue: ({ threadId, providerInstanceId }) =>
        Effect.sync(() => {
          log.mcpIssued.push(threadId);
          return {
            config: {
              environmentId: EnvironmentId.make("environment:side-threads"),
              threadId,
              providerSessionId: `mcp-test:${threadId}`,
              providerInstanceId,
              endpoint: "http://127.0.0.1/mcp",
              authorizationHeader: `Bearer mcp-test:${threadId}`,
              browserToolsAvailable: true,
            },
          };
        }),
      // @effect-diagnostics-next-line effectSucceedWithVoid:off - This optional result requires undefined, not the wider void type.
      resolve: () => Effect.succeed(undefined),
      touch: () => Effect.void,
      revokeProviderSession: () => Effect.void,
      revokeThread: () => Effect.void,
      revokeAll: Effect.void,
    }),
  );

export const makeHarness = Effect.fn("sideThreadsHarness")(function* (
  name: string,
  specs: ReadonlyArray<DoubleSpec> = [CODEX, CLAUDE, ANTIGRAVITY],
  options: { readonly git?: boolean } = {},
) {
  // Without git, the workspace keeps no checkpoints.
  const cwd =
    options.git === false
      ? yield* Effect.flatMap(FileSystem.FileSystem, (fs) =>
          fs.makeTempDirectoryScoped({ prefix: `side-threads-${name}-` }),
        ).pipe(Effect.provide(NodeServices.layer))
      : yield* checkpointWorkspace(`side-threads-${name}`);
  const script: Script = {
    hold: new Set(),
    replies: new Map(),
    commentary: new Map(),
    silent: new Set(),
    edits: new Map(),
  };
  const log: Log = { started: [], steered: [], interrupted: [], forks: [], mcpIssued: [] };
  const live = new Map<string, LiveTurn>();
  const registry = Layer.effect(
    ProviderAdapterRegistry.ProviderAdapterRegistryV2,
    Effect.gen(function* () {
      const mcpSessions = yield* McpProviderSessions.McpProviderSessions;
      return ProviderAdapterRegistry.ProviderAdapterRegistryV2.of({
        get: (instanceId) => {
          const spec = specs.find(
            (candidate) => (candidate.instanceId ?? candidate.driver) === instanceId,
          );
          return spec === undefined
            ? Effect.fail(
                new ProviderAdapterRegistry.ProviderAdapterRegistryLookupError({ instanceId }),
              )
            : Effect.succeed(adapters.get(instanceId) ?? remember(spec, mcpSessions));
        },
        list: () =>
          Effect.succeed(
            specs.map((spec) => ProviderInstanceId.make(spec.instanceId ?? spec.driver)),
          ),
      });
    }),
  );
  const adapters = new Map<string, ProviderAdapter.ProviderAdapterV2["Service"]>();
  const remember = (
    spec: DoubleSpec,
    mcpSessions: McpProviderSessions.McpProviderSessions["Service"],
  ) => {
    const adapter = makeAdapter(spec, cwd, script, log, live, mcpSessions);
    adapters.set(spec.instanceId ?? spec.driver, adapter);
    return adapter;
  };
  const release = (messageId: string) => finish(live, script, cwd, messageId);
  return { name, cwd, script, log, registry, release };
});

export type Harness = Effect.Success<ReturnType<typeof makeHarness>>;

export type HarnessError =
  | Orchestrator.OrchestratorV2Error
  | EffectWorker.OrchestrationEffectWorkerError;

export const selection = (driver: string, model = "test-model"): ModelSelection => ({
  instanceId: ProviderInstanceId.make(driver),
  model,
});

/** The orchestration runtime around the doubles, with T3 MCP credentials issued as in production. */
export const harnessLayer = (harness: Harness, options: { readonly databasePath?: string } = {}) =>
  ProviderReplayHarness.layerWithRegistry(
    { name: `side-threads-${harness.name}` },
    harness.registry,
    {
      runEffectWorker: false,
      configureMcp: true,
      mcpSessionRegistry: recordingMcpRegistry(harness.log),
      ...(options.databasePath === undefined
        ? {}
        : {
            databaseLayer: SqlitePersistence.layerFromPath(options.databasePath).pipe(
              Layer.provide(NodeServices.layer),
            ),
          }),
    },
  );

export interface Context {
  readonly orchestrator: Orchestrator.OrchestratorV2["Service"];
  readonly events: ReadonlyArray<OrchestrationV2DomainEvent>;
  readonly settle: Effect.Effect<void, HarnessError>;
  readonly createThread: (input: {
    readonly threadId: string;
    readonly driver: string;
    readonly model?: string;
    readonly title?: string;
    readonly runtimeMode?: RuntimeMode;
    readonly interactionMode?: ProviderInteractionMode;
  }) => Effect.Effect<ThreadId, Orchestrator.OrchestratorV2Error>;
  readonly send: (
    threadId: ThreadId,
    messageId: string,
    text: string,
    mode?: Extract<OrchestrationV2Command, { type: "message.dispatch" }>["dispatchMode"],
  ) => Effect.Effect<void, Orchestrator.OrchestratorV2Error>;
  /** Sends a message and settles; its run ends unless the script holds it. */
  readonly turn: (
    threadId: ThreadId,
    messageId: string,
    text: string,
  ) => Effect.Effect<void, HarnessError>;
  readonly dispatch: (
    command: OrchestrationV2Command,
  ) => Effect.Effect<void, Orchestrator.OrchestratorV2Error>;
}

export const runWith = <A, E, R>(
  harness: Harness,
  body: (context: Context) => Effect.Effect<A, E, R>,
  options: { readonly databasePath?: string } = {},
) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
    const events: OrchestrationV2DomainEvent[] = [];
    const recorder = yield* orchestrator.streamDomainEvents.pipe(
      Stream.runForEach((event) => Effect.sync(() => events.push(event))),
      Effect.forkScoped,
    );
    yield* Effect.yieldNow;
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
    const dispatch: Context["dispatch"] = (command) =>
      orchestrator.dispatch(command).pipe(Effect.asVoid);
    const createThread: Context["createThread"] = (input) =>
      Effect.gen(function* () {
        const threadId = ThreadId.make(input.threadId);
        yield* orchestrator.dispatch({
          type: "thread.create",
          commandId: CommandId.make(`create:${input.threadId}`),
          threadId,
          projectId: ProjectId.make("project:side-threads"),
          title: input.title ?? `Thread ${input.threadId}`,
          modelSelection: selection(input.driver, input.model),
          runtimeMode: input.runtimeMode ?? "full-access",
          interactionMode: input.interactionMode ?? "default",
          branch: null,
          worktreePath: harness.cwd,
          createdBy: "user",
          creationSource: "web",
        });
        return threadId;
      });
    const send: Context["send"] = (threadId, messageId, text, mode) =>
      orchestrator
        .dispatch({
          type: "message.dispatch",
          commandId: CommandId.make(`send:${messageId}`),
          threadId,
          messageId: MessageId.make(messageId),
          text,
          attachments: [],
          dispatchMode: mode ?? { type: "start_immediately" },
          createdBy: "user",
          creationSource: "web",
        })
        .pipe(Effect.asVoid);
    // On a file database the runtime reads on worker threads, whose answers can land after one
    // settle; an unheld turn settles until its run ends, as `turn` promises.
    const turn: Context["turn"] = (threadId, messageId, text) =>
      Effect.gen(function* () {
        yield* send(threadId, messageId, text);
        yield* settle;
        if (harness.script.hold.has(messageId)) return;
        for (let round = 0; round < 20; round += 1) {
          const { runs } = yield* orchestrator.getThreadProjection(threadId);
          const run = runs.find((candidate) => candidate.userMessageId === messageId);
          if (run === undefined || !ACTIVE_RUN_STATUSES.has(run.status)) return;
          yield* settle;
        }
      });
    const result = yield* body({
      orchestrator,
      events,
      settle,
      createThread,
      send,
      turn,
      dispatch,
    });
    yield* Fiber.interrupt(recorder);
    return result;
  }).pipe(
    Effect.provide(
      harnessLayer(
        harness,
        options.databasePath === undefined ? {} : { databasePath: options.databasePath },
      ),
    ),
  );
