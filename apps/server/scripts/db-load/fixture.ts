// @effect-diagnostics globalDate:off - generated timestamps derive from a fixed base, not the clock.
// One unit of a heavy user's history, written through the server's own write paths (EventSink,
// ProjectStore, HoustonTaskStore). Sizes follow a real v2 database (docs/operations/development.md).
import {
  CommandId,
  OrchestrationV2DomainEvent,
  ProjectId,
  ThreadId,
  type OrchestrationV2DomainEvent as DomainEvent,
} from "@houston-app/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as EventSink from "../../src/orchestration-v2/EventSink.ts";
import type * as EffectOutbox from "../../src/orchestration-v2/EffectOutbox.ts";
import * as EventStore from "../../src/orchestration-v2/EventStore.ts";
import * as ProjectStore from "../../src/orchestration-v2/ProjectStore.ts";
import * as TaskStore from "../../src/houston/tasks/TaskStore.ts";
import { makeRandom, type Random } from "./random.ts";

/** Every generated id and path carries the unit token; a clone rewrites it (see clone.ts). */
export const unitToken = (unit: number) => `U${String(unit).padStart(4, "0")}`;
export const BASE_TOKEN = unitToken(0);
/** Timestamps of unit 0 fall in this year; clone k moves them k years back. */
export const BASE_YEAR = 2026;
export const NOW_ISO = "2026-11-06T12:00:00.000Z";
const NOW_MS = Date.parse(NOW_ISO);
const DAY_MS = 86_400_000;

const decodeEventSync = Schema.decodeUnknownSync(Schema.toCodecJson(OrchestrationV2DomainEvent));
export function decodeEvent(encoded: Record<string, unknown>): DomainEvent {
  try {
    return decodeEventSync(encoded);
  } catch (error) {
    throw new Error(`Generated ${String(encoded.type)} event does not decode: ${String(error)}`, {
      cause: error,
    });
  }
}

export interface UnitShape {
  readonly projects: number;
  readonly threads: number;
  readonly tasks: number;
  /** Runs per thread: [share of threads, min runs, max runs]. */
  readonly runBuckets: ReadonlyArray<readonly [number, number, number]>;
}

// A heavy user after a few months: about 150 threads and 1,300 turns across six projects.
// The bucket mix gives a median of 4 turns and a tail of 30-80 turn threads, the shape seen on
// real databases (most threads short, a few long-running ones).
export const HEAVY_USER_UNIT: UnitShape = {
  projects: 6,
  threads: 150,
  tasks: 40,
  runBuckets: [
    [0.5, 1, 3],
    [0.3, 4, 10],
    [0.15, 11, 30],
    [0.05, 31, 80],
  ],
};

/** Runs of the deep thread at 1x; scale F gives it F times as many. */
export const DEEP_THREAD_BASE_RUNS = 60;

const WORDS = (
  "the a function module request response server client thread project index query table row " +
  "column cache value result error retry build test check lint type schema event stream " +
  "update apply commit branch merge review diff file path line token batch window budget " +
  "latency render state store reader writer worker queue lease outbox handler layer service " +
  "effect span trace metric counter config setting option default flag guard limit bound size " +
  "parse encode decode json text output input command shell process signal timeout deadline"
).split(" ");

function text(random: Random, length: number): string {
  const parts: Array<string> = [];
  let size = 0;
  while (size < length) {
    const word = random.chance(0.04)
      ? `${random.pick(WORDS)}${random.int(1, 999)}`
      : random.pick(WORDS);
    parts.push(word);
    size += word.length + 1;
    if (random.chance(0.08)) {
      parts.push(random.chance(0.5) ? ".\n" : ",");
      size += 2;
    }
  }
  return parts.join(" ").slice(0, length);
}

const enc = encodeURIComponent;

export interface ThreadProbe {
  readonly threadId: string;
  readonly projectId: string;
  readonly runIds: ReadonlyArray<string>;
  readonly lastRunId: string;
  readonly lastUserMessageId: string;
  readonly lastItemId: string;
  readonly lastRootNodeId: string;
  readonly providerThreadId: string;
  readonly scopeId: string;
  readonly runCount: number;
}

export interface UnitManifest {
  readonly token: string;
  readonly projectIds: ReadonlyArray<string>;
  readonly threads: ReadonlyArray<
    ThreadProbe & { readonly settled: boolean; readonly archived: boolean }
  >;
  readonly runningThreadId: string | null;
  readonly queuedThreadId: string | null;
}

interface ThreadPlan {
  readonly index: number;
  readonly projectIndex: number;
  readonly runs: number;
  readonly createdMs: number;
  readonly settled: boolean;
  readonly archived: boolean;
  readonly pullRequest: boolean;
  readonly lastRunStatus: "completed" | "running" | "queued";
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

const MODEL_SELECTION = { instanceId: "claudeAgent", model: "claude-opus-5-5" } as const;

const CAPABILITIES = {
  sessions: {
    supportsMultipleProviderThreadsPerSession: false,
    supportsModelSwitchInSession: true,
    supportsProviderSwitchingViaHandoff: true,
    supportsRuntimeModeSwitchInSession: false,
    pendingRequestsSurviveRestart: false,
  },
  threads: {
    canCreateEmptyThread: true,
    canReadThreadSnapshot: false,
    canRollbackThread: true,
    canForkThread: true,
    canForkFromTurn: true,
    canForkFromSubagentThread: false,
    exposesNativeThreadId: true,
  },
  turns: {
    exposesNativeTurnId: false,
    emitsTurnStarted: true,
    emitsTurnCompleted: true,
    supportsInterrupt: true,
    supportsActiveSteering: true,
    activeSteeringInterruptsTools: true,
    supportsSteeringByInterruptRestart: false,
    supportsQueuedMessages: true,
    terminalStatusQuality: "strong",
  },
  streaming: {
    streamsAssistantText: true,
    streamsReasoning: true,
    streamsToolOutput: false,
    streamsPlanText: false,
    emitsMessageCompleted: true,
  },
  tools: {
    exposesToolItemIds: true,
    emitsToolStarted: true,
    emitsToolCompleted: true,
    emitsToolOutput: true,
    supportsMcpTools: true,
    supportsDynamicToolCallbacks: true,
  },
  approvals: {
    supportsCommandApproval: true,
    supportsFileReadApproval: true,
    supportsFileChangeApproval: true,
    supportsApplyPatchApproval: false,
    approvalsHaveNativeRequestIds: true,
    approvalCallbacksAreLiveOnly: true,
    approvalsCanOriginateFromSubagents: false,
  },
  planning: {
    emitsPlanUpdated: true,
    emitsTodoList: true,
    emitsProposedPlan: true,
    supportsStructuredQuestions: true,
    planDeltasHaveItemIds: false,
  },
  subagents: {
    supportsSubagents: true,
    exposesSubagentThreadIds: false,
    emitsSubagentLifecycle: true,
    canWaitForSubagents: false,
    canCloseSubagents: false,
    canForkSubagentThread: false,
  },
  context: {
    acceptsSystemContext: true,
    acceptsDeveloperContext: true,
    acceptsSyntheticUserContext: true,
    canGenerateSummaries: true,
    canConsumeHandoffSummaries: true,
    supportsDeltaHandoff: true,
    supportsFullThreadHandoff: true,
    maxRecommendedHandoffChars: null,
  },
  checkpointing: {
    appCanCheckpointFilesystem: true,
    supportsNestedCheckpointScopes: true,
    providerCanRollbackConversation: true,
    providerRollbackReturnsSnapshot: true,
    providerCanReadConversationSnapshot: false,
  },
  identity: {
    nativeThreadIds: "strong",
    nativeTurnIds: "weak",
    nativeItemIds: "strong",
    nativeRequestIds: "strong",
  },
  runtimePolicy: { enforcement: "native", readOnlyRun: "permissionMode" },
};

type Json = Record<string, unknown>;

/** Writes one thread's history; returns its probe ids. */
const writeThread = Effect.fnUntraced(function* (input: {
  readonly random: Random;
  readonly token: string;
  readonly projectId: string;
  readonly workspaceRoot: string;
  readonly plan: ThreadPlan;
  readonly label: string;
}) {
  const sink = yield* EventSink.EventSinkV2;
  const { random, token, plan } = input;
  const threadId = `${token}-${input.label}-${random.hex(8)}-${random.hex(4)}-${random.hex(12)}`;
  const providerThreadId = `provider-thread:provider:claudeAgent:native-thread:${enc(`pending:run:thread:${threadId}:ordinal:1`)}`;
  const providerSessionId = `provider-session:provider-instance:claudeAgent:thread:${threadId}:${random.hex(8)}-${random.hex(4)}-${random.hex(12)}`;
  const scopeId = `checkpoint-scope:thread:${threadId}:name:root`;
  const cwd =
    plan.index % 5 === 0
      ? `${input.workspaceRoot}/.worktrees/${token}-t${plan.index}`
      : input.workspaceRoot;
  let clock = plan.createdMs;
  const tick = (min: number, max: number) => {
    clock += random.int(min, max);
    return iso(clock);
  };
  let eventCounter = 0;
  const event = (type: string, payload: Json, extra: Json = {}): DomainEvent =>
    decodeEvent({
      id: `event:${token}:${threadId}:${eventCounter++}`,
      type,
      threadId,
      occurredAt: iso(clock),
      ...extra,
      payload,
    });
  const write = (
    commandId: string | undefined,
    events: Array<DomainEvent>,
    effects: Array<EffectOutbox.PendingOrchestrationEffectV2> = [],
  ) =>
    sink.writeWithEffects({
      ...(commandId === undefined ? {} : { commandId: CommandId.make(commandId) }),
      events,
      effects,
    });

  const createdAt = iso(clock);
  const title = text(random, random.int(18, 60)).trim() || "Untitled";
  const firstMessageId = `${token}-msg-${random.hex(8)}-${random.hex(4)}-${random.hex(12)}`;
  const thread: Json = {
    createdBy: "user",
    creationSource: "web",
    id: threadId,
    projectId: input.projectId,
    title,
    providerInstanceId: "claudeAgent",
    modelSelection: MODEL_SELECTION,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: plan.index % 5 === 0 ? `feature/${token.toLowerCase()}-t${plan.index}` : "main",
    worktreePath: plan.index % 5 === 0 ? cwd : null,
    pullRequests: plan.pullRequest
      ? [
          {
            host: "github.com",
            repository: `example/project-${plan.projectIndex}`,
            number: 1000 + plan.index,
            url: `https://github.com/example/project-${plan.projectIndex}/pull/${1000 + plan.index}`,
            source: "agent",
            linkedAt: createdAt,
            snapshot: null,
            stack: null,
          },
        ]
      : [],
    activeProviderThreadId: null,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
    forkedFrom: null,
    createdAt,
    updatedAt: createdAt,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    snoozedUntil: null,
    snoozedAt: null,
    lastVisitedAt: null,
    deletedAt: null,
  };
  const createCommand = `${token}:command:${threadId}:create`;
  yield* write(
    createCommand,
    [
      event("thread.created", thread),
      event("provider-thread.updated", {
        id: providerThreadId,
        driver: "claudeAgent",
        providerInstanceId: "claudeAgent",
        providerSessionId,
        appThreadId: threadId,
        ownerNodeId: null,
        nativeThreadRef: null,
        nativeConversationHeadRef: null,
        status: "not_loaded",
        firstRunOrdinal: 1,
        lastRunOrdinal: 1,
        handoffIds: [],
        forkedFrom: null,
        createdAt,
        updatedAt: createdAt,
      }),
    ],
    [
      {
        id: `${createCommand}:title`,
        commandId: CommandId.make(createCommand),
        threadId: ThreadId.make(threadId),
        request: {
          type: "thread-title.generate",
          kind: { type: "initial", messageId: firstMessageId as never },
        },
      },
    ],
  );

  const runIds: Array<string> = [];
  let lastUserMessageId = firstMessageId;
  let lastItemId = "";
  let lastRootNodeId = "";
  let checkpointOrdinal = 0;
  const nativeThreadId = `${random.hex(8)}-${random.hex(4)}-${random.hex(12)}`;

  for (let ordinal = 1; ordinal <= plan.runs; ordinal++) {
    const isLast = ordinal === plan.runs;
    const status = isLast ? plan.lastRunStatus : "completed";
    const runId = `run:thread:${threadId}:ordinal:${ordinal}`;
    const rootNodeId = `node:run:${enc(runId)}:root`;
    const attemptId = `run-attempt:run:${enc(runId)}:attempt:1`;
    const providerTurnId = `provider-turn:provider:claudeAgent:native-turn:${enc(`turn:${attemptId}`)}`;
    const userMessageId =
      ordinal === 1
        ? firstMessageId
        : `${token}-msg-${random.hex(8)}-${random.hex(4)}-${random.hex(12)}`;
    const meta = { runId, nodeId: rootNodeId, providerInstanceId: "claudeAgent" };
    runIds.push(runId);
    lastUserMessageId = userMessageId;
    lastRootNodeId = rootNodeId;
    const requestedAt = tick(30_000, 6 * 3_600_000);
    const run: Json = {
      id: runId,
      threadId,
      ordinal,
      providerInstanceId: "claudeAgent",
      modelSelection: MODEL_SELECTION,
      providerThreadId,
      userMessageId,
      rootNodeId,
      activeAttemptId: attemptId,
      status: "queued",
      queuePosition: null,
      requestedAt,
      startedAt: null,
      completedAt: null,
      checkpointId: null,
      contextHandoffId: null,
    };
    const attempt: Json = {
      id: attemptId,
      runId,
      attemptOrdinal: 1,
      rootNodeId,
      providerInstanceId: "claudeAgent",
      providerThreadId,
      providerTurnId: null,
      reason: "initial",
      status: "pending",
      startedAt: null,
      completedAt: null,
    };
    const rootNode: Json = {
      id: rootNodeId,
      threadId,
      runId,
      parentNodeId: null,
      rootNodeId,
      kind: "root_turn",
      status: "pending",
      countsForRun: true,
      providerThreadId,
      providerTurnId: null,
      nativeItemRef: null,
      runtimeRequestId: null,
      checkpointScopeId: scopeId,
      startedAt: null,
      completedAt: null,
    };
    const userText = text(random, random.logNormalLength(600, 6_000, 4));
    const message: Json = {
      createdBy: "user",
      creationSource: "web",
      id: userMessageId,
      threadId,
      runId,
      nodeId: rootNodeId,
      role: "user",
      text: userText,
      attachments: [],
      streaming: false,
      createdAt: requestedAt,
      updatedAt: requestedAt,
    };
    let itemOrdinal = ordinal * 1_000_000;
    const itemBase = (
      id: string,
      nodeId: string,
      startedAt: string,
      completedAt: string | null,
      turnId: string | null,
      nativeId: string | null,
    ): Json => ({
      id,
      threadId,
      runId,
      nodeId,
      providerThreadId,
      providerTurnId: turnId,
      nativeItemRef:
        nativeId === null ? null : { driver: "claudeAgent", nativeId, strength: "strong" },
      parentItemId: null,
      ordinal: ++itemOrdinal,
      status: completedAt === null ? "running" : "completed",
      title: null,
      startedAt,
      completedAt,
      updatedAt: completedAt ?? startedAt,
    });
    const userItemId = `turn-item:message:${userMessageId}`;
    const turnCommand = `${token}:command:${runId}:start`;
    const startEvents = [
      event("run.created", run, meta),
      event("run-attempt.created", attempt, meta),
      event("node.updated", rootNode, meta),
      event("message.updated", message, meta),
      event(
        "turn-item.updated",
        {
          ...itemBase(userItemId, rootNodeId, requestedAt, requestedAt, null, null),
          createdBy: "user",
          creationSource: "web",
          type: "user_message",
          messageId: userMessageId,
          inputIntent: "turn_start",
          text: userText,
          attachments: [],
        },
        meta,
      ),
    ];
    if (ordinal === 1) {
      startEvents.push(
        event(
          "provider-session.attached",
          {
            id: providerSessionId,
            driver: "claudeAgent",
            providerInstanceId: "claudeAgent",
            status: "ready",
            cwd,
            model: MODEL_SELECTION.model,
            capabilities: CAPABILITIES,
            createdAt: requestedAt,
            updatedAt: requestedAt,
            lastError: null,
          },
          { driver: "claudeAgent", providerInstanceId: "claudeAgent" },
        ),
        event(
          "checkpoint-scope.created",
          {
            id: scopeId,
            threadId,
            runId,
            nodeId: rootNodeId,
            parentScopeId: null,
            providerThreadId,
            kind: "root_run",
            ordinalWithinParent: 0,
            advancesAppRunCount: true,
            cwd,
            createdAt: requestedAt,
          },
          meta,
        ),
      );
    }
    yield* write(turnCommand, startEvents, [
      {
        id: `${turnCommand}:provider-turn`,
        commandId: CommandId.make(turnCommand),
        threadId: ThreadId.make(threadId),
        request: { type: "provider-turn.start", runId: runId as never },
      },
    ]);
    lastItemId = userItemId;
    if (status === "queued") continue;

    const startedAt = tick(200, 3_000);
    const runningRun = { ...run, status: "running", startedAt };
    const runningAttempt = {
      ...attempt,
      status: "running",
      startedAt,
      providerTurnId,
      nativeThreadId,
    };
    const providerTurn: Json = {
      id: providerTurnId,
      providerThreadId,
      nodeId: rootNodeId,
      runAttemptId: attemptId,
      nativeTurnRef: { driver: "claudeAgent", nativeId: `turn:${attemptId}`, strength: "weak" },
      ordinal,
      status: "running",
      startedAt,
      completedAt: null,
    };
    const runningNode = { ...rootNode, status: "running", providerTurnId, startedAt };
    yield* write(undefined, [
      event("run.updated", runningRun, meta),
      event("run-attempt.updated", runningAttempt, meta),
      event("provider-turn.updated", providerTurn, { ...meta, driver: "claudeAgent" }),
      event("node.updated", runningNode, meta),
    ]);

    // Work items, in the proportions of a real tool-heavy turn (about 14 items and 10 nodes).
    const workCount = random.int(4, 16);
    for (let k = 0; k < workCount; k++) {
      // Native ids are global keys, so they carry the unit token as well.
      const nativeId = `toolu_${token}${random.hex(19)}`;
      const itemId = `turn-item:provider:claudeAgent:native-item:${nativeId}`;
      const nodeId = `node:provider:claudeAgent:native-item:${nativeId}`;
      const itemStart = tick(300, 20_000);
      const itemEnd = tick(50, 8_000);
      const roll = random.next();
      const events: Array<DomainEvent> = [];
      if (roll < 0.2) {
        const thinkingId = `msg_${token}${random.hex(15)}:thinking:0`;
        const id = `turn-item:provider:claudeAgent:native-item:${enc(thinkingId)}`;
        events.push(
          event(
            "turn-item.updated",
            {
              ...itemBase(id, rootNodeId, itemStart, itemEnd, providerTurnId, thinkingId),
              title: "Thinking",
              type: "reasoning",
              text: text(random, random.logNormalLength(1_400, 9_000, 10)),
              streaming: false,
            },
            meta,
          ),
        );
        lastItemId = id;
      } else {
        const toolNode: Json = {
          id: nodeId,
          threadId,
          runId,
          parentNodeId: rootNodeId,
          rootNodeId,
          kind: "tool_call",
          status: "completed",
          countsForRun: true,
          providerThreadId,
          providerTurnId,
          nativeItemRef: { driver: "claudeAgent", nativeId, strength: "strong" },
          runtimeRequestId: null,
          checkpointScopeId: null,
          startedAt: itemStart,
          completedAt: itemEnd,
        };
        events.push(event("node.updated", toolNode, meta));
        const base = itemBase(itemId, nodeId, itemStart, itemEnd, providerTurnId, nativeId);
        if (roll < 0.65) {
          events.push(
            event(
              "turn-item.updated",
              {
                ...base,
                title: "Run command",
                type: "command_execution",
                input: text(random, random.int(10, 120)),
                output: text(random, random.logNormalLength(3_000, 32_000, 0)),
                exitCode: random.chance(0.9) ? 0 : 1,
              },
              meta,
            ),
          );
        } else if (roll < 0.88) {
          const filePath = `${cwd}/src/module${random.int(0, 40)}.ts`;
          events.push(
            event(
              "turn-item.updated",
              {
                ...base,
                title: `Read ${filePath}`,
                type: "dynamic_tool",
                toolName: random.pick(["Read", "Grep", "Glob", "WebFetch"]),
                input: { file_path: filePath },
                output: {
                  type: "text",
                  text: text(random, random.logNormalLength(6_000, 80_000, 0)),
                },
              },
              meta,
            ),
          );
        } else {
          const filePath = `${cwd}/src/module${random.int(0, 40)}.ts`;
          events.push(
            event(
              "turn-item.updated",
              {
                ...base,
                type: "file_change",
                fileName: filePath,
                additions: random.int(1, 80),
                deletions: random.int(0, 40),
                diffStr: `--- ${filePath}\n+++ ${filePath}\n${text(random, random.logNormalLength(3_000, 34_000, 10))}`,
              },
              meta,
            ),
          );
        }
        lastItemId = itemId;
      }
      yield* write(undefined, events);
    }
    // Assistant replies: one to three per turn.
    const replies = random.int(1, 3);
    for (let k = 0; k < replies; k++) {
      const nativeId = `${token}-${random.hex(8)}-${random.hex(4)}-${random.hex(12)}`;
      const messageId = `message:provider:claudeAgent:native-item:${nativeId}`;
      const at = tick(500, 30_000);
      const replyText = text(random, random.logNormalLength(2_200, 28_000, 4));
      const itemId = `turn-item:provider:claudeAgent:native-item:${nativeId}`;
      yield* write(undefined, [
        event(
          "message.updated",
          {
            id: messageId,
            threadId,
            runId,
            nodeId: rootNodeId,
            role: "assistant",
            createdBy: "agent",
            creationSource: "provider",
            text: replyText,
            attachments: [],
            streaming: false,
            createdAt: at,
            updatedAt: at,
          },
          meta,
        ),
        event(
          "turn-item.updated",
          {
            ...itemBase(itemId, rootNodeId, at, at, providerTurnId, nativeId),
            type: "assistant_message",
            messageId,
            text: replyText,
            streaming: false,
          },
          meta,
        ),
      ]);
      lastItemId = itemId;
    }
    if (status === "running") continue;

    const completedAt = tick(100, 2_000);
    const checkpointId = `checkpoint:scope:${enc(scopeId)}:name:${++checkpointOrdinal}`;
    const finishCommand = `${token}:command:effect:checkpoint.capture:${runId}`;
    const checkpointItemId = `turn-item:provider:claudeAgent:native-item:${enc(`checkpoint:${checkpointId}`)}`;
    yield* write(
      finishCommand,
      [
        event(
          "checkpoint.captured",
          {
            id: checkpointId,
            threadId,
            scopeId,
            runId,
            nodeId: rootNodeId,
            parentCheckpointId: null,
            ordinalWithinScope: checkpointOrdinal,
            appRunOrdinal: ordinal,
            ref: `refs/houston/orchestration-v2/checkpoints/${random.hex(40)}/ordinal/${checkpointOrdinal}`,
            status: "ready",
            files: [],
            capturedAt: completedAt,
          },
          meta,
        ),
        event(
          "turn-item.updated",
          {
            ...itemBase(checkpointItemId, rootNodeId, completedAt, completedAt, null, null),
            type: "checkpoint",
            checkpointId,
            scopeId,
            files: [],
          },
          meta,
        ),
        event(
          "provider-turn.updated",
          { ...providerTurn, status: "completed", completedAt },
          { ...meta, driver: "claudeAgent" },
        ),
        event("node.updated", { ...runningNode, status: "completed", completedAt }, meta),
        event("run-attempt.updated", { ...runningAttempt, status: "completed", completedAt }, meta),
        event(
          "run.updated",
          { ...runningRun, status: "completed", completedAt, checkpointId },
          meta,
        ),
      ],
      [
        {
          id: `${finishCommand}:capture`,
          commandId: CommandId.make(finishCommand),
          threadId: ThreadId.make(threadId),
          request: { type: "checkpoint.capture", runId: runId as never, scopeId: scopeId as never },
        },
      ],
    );
    lastItemId = checkpointItemId;
  }

  // Settle, archive and visit as the user does after a thread's work ends.
  const updated = {
    ...thread,
    activeProviderThreadId: providerThreadId,
    updatedAt: iso(clock),
    lastVisitedAt: iso(clock),
  };
  const closing: Array<DomainEvent> = [event("thread.visited", updated)];
  if (plan.settled)
    closing.push(event("thread.settled", { ...updated, settledAt: tick(60_000, 3_600_000) }));
  if (plan.archived)
    closing.push(event("thread.archived", { ...updated, archivedAt: tick(60_000, 3_600_000) }));
  yield* write(`${token}:command:${threadId}:close`, closing);

  return {
    threadId,
    projectId: input.projectId,
    runIds,
    lastRunId: runIds.at(-1)!,
    lastUserMessageId,
    lastItemId,
    lastRootNodeId,
    providerThreadId,
    scopeId,
    runCount: runIds.length,
  } satisfies ThreadProbe;
});

function planThreads(random: Random, shape: UnitShape): Array<ThreadPlan> {
  const plans: Array<ThreadPlan> = [];
  for (let index = 0; index < shape.threads; index++) {
    let roll = random.next();
    let bucket = shape.runBuckets.at(-1)!;
    for (const candidate of shape.runBuckets) {
      if (roll < candidate[0]) {
        bucket = candidate;
        break;
      }
      roll -= candidate[0];
    }
    // Zipf-like project skew: the first project holds about a third of the threads.
    const projectIndex = Math.min(
      shape.projects - 1,
      Math.floor(shape.projects * random.next() ** 2),
    );
    const ageDays = random.next() ** 1.5 * 120;
    const recent = ageDays < 2;
    plans.push({
      index,
      projectIndex,
      runs: random.int(bucket[1], bucket[2]),
      createdMs: NOW_MS - ageDays * DAY_MS - 2 * DAY_MS,
      settled: !recent && random.chance(0.75),
      archived: !recent && random.chance(0.12),
      pullRequest: random.chance(0.12),
      lastRunStatus: index === 0 ? "running" : index === 1 ? "queued" : "completed",
    });
  }
  return plans;
}

export const projectRoot = (token: string, index: number) => `/work/${token}/project-${index}`;

/** Writes unit `unit` (normally 0; clones copy it) and returns the probe ids. */
export const writeUnit = Effect.fn("DbLoad.writeUnit")(function* (input: {
  readonly seed: number;
  readonly shape: UnitShape;
  readonly onProgress?: (done: number, total: number) => void;
}) {
  const random = makeRandom(input.seed);
  const token = BASE_TOKEN;
  const events = yield* EventStore.EventStoreV2;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const tasks = yield* TaskStore.HoustonTaskStore;
  const projectIds: Array<string> = [];
  for (let index = 0; index < input.shape.projects; index++) {
    const projectId = `${token}-project-${index}-${random.hex(8)}`;
    const at = iso(NOW_MS - 150 * DAY_MS + index * DAY_MS);
    const stored = yield* events.appendProjectEvent({
      eventId: `event:${token}:project:${index}` as never,
      aggregateKind: "project",
      aggregateId: ProjectId.make(projectId),
      type: "project.created",
      occurredAt: at,
      commandId: CommandId.make(`${token}:command:project:${index}`),
      causationEventId: null,
      correlationId: CommandId.make(`${token}:command:project:${index}`),
      metadata: {},
      payload: {
        projectId: ProjectId.make(projectId),
        title: `project-${index}`,
        workspaceRoot: projectRoot(token, index),
        defaultModelSelection: null,
        faviconPath: null,
        projectIcon: null,
        scripts: [],
        createdAt: at,
        updatedAt: at,
      },
    } as never);
    yield* projects.apply(stored);
    projectIds.push(projectId);
  }
  const plans = planThreads(random, input.shape);
  const threads: Array<UnitManifest["threads"][number]> = [];
  for (const plan of plans) {
    const probe = yield* writeThread({
      random,
      token,
      projectId: projectIds[plan.projectIndex]!,
      workspaceRoot: projectRoot(token, plan.projectIndex),
      plan,
      label: "t",
    });
    threads.push({ ...probe, settled: plan.settled, archived: plan.archived });
    input.onProgress?.(threads.length, plans.length);
  }
  for (let index = 0; index < input.shape.tasks; index++) {
    yield* tasks.write(
      Effect.map(
        tasks.createTask({
          projectId: projectIds[index % projectIds.length]!,
          title: text(random, random.int(20, 70)).trim() || "Task",
          description: text(random, random.logNormalLength(400, 4_000, 0)),
          status: random.pick(["backlog", "todo", "in_progress", "done", "done", "done"] as const),
          priority: random.pick(["none", "urgent", "high", "medium", "low"] as const),
          parentId: null,
          refUrl: null,
          acceptance: [text(random, 40), text(random, 40)],
          createdBy: "user",
        }),
        (task) => ({ result: task, touched: [task.id] }),
      ),
    );
  }
  return {
    token,
    projectIds,
    threads,
    runningThreadId: threads[0]?.threadId ?? null,
    queuedThreadId: threads[1]?.threadId ?? null,
  } satisfies UnitManifest;
});

/** The deep thread: one thread whose turn count scales with the factor, for per-thread reads. */
export const writeDeepThread = Effect.fn("DbLoad.writeDeepThread")(function* (input: {
  readonly seed: number;
  readonly runs: number;
  readonly projectId: string;
}) {
  const random = makeRandom(input.seed ^ 0x5eed);
  return yield* writeThread({
    random,
    token: BASE_TOKEN,
    projectId: input.projectId,
    workspaceRoot: projectRoot(BASE_TOKEN, 0),
    plan: {
      index: 1,
      projectIndex: 0,
      runs: input.runs,
      // About 3.2 hours per generated turn, so the newest turn lands near NOW.
      createdMs: NOW_MS - input.runs * 3.2 * 3_600_000,
      settled: false,
      archived: false,
      pullRequest: true,
      lastRunStatus: "completed",
    },
    label: "deep",
  });
});
