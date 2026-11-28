import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import {
  MessageId,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  RunId,
  ThreadId,
  type WakeCompactionSource,
} from "@houston-app/contracts";

import {
  staleWakeCompactionMessageId,
  staleWakeOneShot,
  wakeCompactionSourceFor,
  type StaleWakeRecords,
  type StaleWakeTrigger,
} from "./StaleWakeCompaction.ts";

const NOW_MS = Date.parse("2026-10-19T12:00:00.000Z");
const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const at = (offset = 0) => DateTime.makeUnsafe(NOW_MS + offset);
const iso = (offset = 0) => DateTime.formatIso(at(offset));
const threadId = ThreadId.make("stale-thread");
const runId = RunId.make("run-1");
const instanceId = ProviderInstanceId.make("claudeAgent");
const providerThreadId = ProviderThreadId.make("provider-thread");
const modelSelection = { instanceId, model: "claude-opus-5-5" };

function records(
  usage: {
    readonly usedTokens?: number;
    readonly cacheTtlMs?: number | undefined;
    readonly cacheExpiresInMs?: number | undefined;
    readonly updatedInMs?: number;
    readonly autoCompactThreshold?: number;
    readonly noAutoCompactThreshold?: boolean;
    readonly driver?: string;
    readonly sideChat?: boolean;
    readonly relationshipToParent?: "fork" | "subagent" | null;
    readonly latestText?: string;
  } = {},
): StaleWakeRecords {
  const messageId = MessageId.make("message-1");
  const nodeId = NodeId.make("root-node");
  return {
    thread: {
      id: threadId,
      projectId: ProjectId.make("project"),
      title: "Stale thread",
      createdBy: "user",
      creationSource: "web",
      providerInstanceId: instanceId,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      activeProviderThreadId: providerThreadId,
      lineage: {
        rootThreadId: threadId,
        parentThreadId: null,
        relationshipToParent: usage.relationshipToParent ?? null,
        ...(usage.sideChat === true ? { sideChat: true } : {}),
      },
      forkedFrom: null,
      createdAt: at(-3 * HOUR_MS),
      updatedAt: at(),
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      lastVisitedAt: at(),
      deletedAt: null,
    },
    runs: [
      {
        id: runId,
        threadId,
        ordinal: 1,
        providerInstanceId: instanceId,
        modelSelection,
        providerThreadId,
        userMessageId: messageId,
        rootNodeId: nodeId,
        activeAttemptId: null,
        status: "completed",
        requestedAt: at(-3 * HOUR_MS),
        startedAt: at(-3 * HOUR_MS),
        completedAt: at(-2 * HOUR_MS),
        checkpointId: null,
        contextHandoffId: null,
      },
    ],
    messages: [
      {
        id: messageId,
        threadId,
        runId,
        nodeId,
        role: "user",
        text: usage.latestText ?? "Explain this code",
        attachments: [],
        streaming: false,
        createdBy: "user",
        creationSource: "web",
        createdAt: at(-3 * HOUR_MS),
        updatedAt: at(-3 * HOUR_MS),
      },
    ],
    providerThreads: [
      {
        id: providerThreadId,
        driver: ProviderDriverKind.make(usage.driver ?? "claudeAgent"),
        providerInstanceId: instanceId,
        providerSessionId: null,
        appThreadId: threadId,
        ownerNodeId: nodeId,
        nativeThreadRef: null,
        nativeConversationHeadRef: null,
        status: "idle",
        firstRunOrdinal: 1,
        lastRunOrdinal: 1,
        handoffIds: [],
        forkedFrom: null,
        createdAt: at(-3 * HOUR_MS),
        updatedAt: at(),
      },
    ],
    providerTurns: [
      {
        id: ProviderTurnId.make("provider-turn-1"),
        providerThreadId,
        nodeId,
        runAttemptId: null,
        nativeTurnRef: null,
        ordinal: 1,
        status: "completed",
        startedAt: at(-3 * HOUR_MS),
        completedAt: at(-2 * HOUR_MS),
        tokenUsage: {
          usedTokens: usage.usedTokens ?? 318_000,
          ...(usage.noAutoCompactThreshold === true
            ? {}
            : {
                autoCompactThreshold:
                  usage.autoCompactThreshold === undefined ? 300_000 : usage.autoCompactThreshold,
              }),
          ...(usage.cacheTtlMs === undefined
            ? { promptCacheTtlMs: HOUR_MS }
            : { promptCacheTtlMs: usage.cacheTtlMs }),
          ...(usage.cacheExpiresInMs === undefined
            ? {}
            : { promptCacheExpiresAt: iso(usage.cacheExpiresInMs) }),
          updatedAt: iso(usage.updatedInMs ?? -2 * HOUR_MS),
        },
      },
    ],
  };
}

function trigger(overrides: Partial<StaleWakeTrigger> = {}): StaleWakeTrigger {
  return {
    origin: "automatic",
    messageId: "message-2",
    text: "A waking message",
    attachments: [],
    createdBy: "agent",
    creationSource: "server",
    ...overrides,
  };
}

function oneShot(input: {
  readonly data?: StaleWakeRecords;
  readonly trigger?: StaleWakeTrigger;
  readonly compactStaleThreadsOnWake?: boolean;
  readonly idleCompaction?: "beforeCacheExpires" | "onReturn" | "off";
}) {
  return staleWakeOneShot({
    projection: input.data ?? records(),
    providerInstanceId: instanceId,
    trigger: input.trigger ?? trigger(),
    nowMs: NOW_MS,
    compactStaleThreadsOnWake: input.compactStaleThreadsOnWake ?? true,
    idleCompaction: input.idleCompaction ?? "beforeCacheExpires",
  });
}

const cases: ReadonlyArray<readonly [WakeCompactionSource, Partial<StaleWakeTrigger>]> = [
  ["agentMessage", { createdBy: "agent", creationSource: "server" }],
  ["delegatedResult", { delegatedCompletion: { parentRunId: "run", generation: 1, taskIds: [] } }],
  ["limitResume", { usageLimitContinuationOfRunId: "run" }],
  ["backgroundCompletion", { notification: { source: { kind: "background_task" } } }],
  ["restartNote", { restartContinuationOfRunId: "run" }],
  ["manualContinuation", { manualContinuationOfRunId: "run" }],
  ["userMessage", { createdBy: "user", creationSource: "web" }],
  ["pullRequestWatch", { notification: { source: { kind: "monitor" } } }],
  ["cardAnswer", { createdBy: "user", creationSource: "server" }],
  [
    "childQuestionAnswer",
    {
      notification: {
        source: { kind: "delegated_task", taskIds: [NodeId.make("task")] },
      },
    },
  ],
  ["scheduledTask", { scheduledTaskId: "task" }],
  ["taskRun", { commandId: "houston-task-review:review:findings" }],
  ["slackAnswer", { messageId: "slack-answer-7" }],
  ["mergeQueueNote", { commandId: "houston-merge-queue:note-1" }],
];

describe("wakeCompactionSourceFor", () => {
  it.each(cases)("names %s", (source, fields) => {
    expect(wakeCompactionSourceFor(trigger(fields))).toBe(source);
  });

  it("exempts a compaction prompt", () => {
    expect(wakeCompactionSourceFor(trigger({ text: "/compact" }))).toBeNull();
  });
});

describe("staleWakeOneShot", () => {
  it.each(cases)("plans one compaction before a %s wake", (source, fields) => {
    expect(oneShot({ trigger: trigger(fields) })).toMatchObject({
      source,
      reason: `wake:${source}`,
      usedTokens: 318_000,
      thresholdTokens: 300_000,
    });
  });

  it("starts a warm thread directly", () => {
    expect(oneShot({ data: records({ updatedInMs: -10 * MINUTE_MS }) })).toBeNull();
  });

  it("starts a small thread directly", () => {
    expect(oneShot({ data: records({ usedTokens: 199_999 }) })).toBeNull();
  });

  it("uses Claude's auto-compact point as its cap", () => {
    expect(oneShot({ data: records({ usedTokens: 260_000 }) })).toBeNull();
    expect(name(oneShot({ data: records({ usedTokens: 300_000 }) }))).toBe("wake:agentMessage");
  });

  it("falls back to the 200k minimum when Claude reports no auto-compact point", () => {
    const data = records({ noAutoCompactThreshold: true, usedTokens: 200_000 });
    expect(oneShot({ data })).not.toBeNull();
  });

  it("compacts an expired cache before its reported expiry, not a live one", () => {
    expect(oneShot({ data: records({ cacheExpiresInMs: -MINUTE_MS }) })).not.toBeNull();
    expect(oneShot({ data: records({ cacheExpiresInMs: 30 * MINUTE_MS }) })).toBeNull();
  });

  it("exempts other providers, side threads, sub-agent threads and compactions", () => {
    expect(oneShot({ data: records({ driver: "codex" }) })).toBeNull();
    expect(oneShot({ data: records({ sideChat: true }) })).toBeNull();
    expect(oneShot({ data: records({ relationshipToParent: "subagent" }) })).toBeNull();
    expect(oneShot({ data: records({ latestText: "/compact" }) })).toBeNull();
  });

  it("exempts provider origins, steering or active restarts, and fresh contexts", () => {
    expect(oneShot({ trigger: trigger({ origin: "provider" }) })).toBeNull();
    expect(oneShot({ trigger: trigger({ origin: "maintenance" }) })).toBeNull();
    expect(oneShot({ trigger: trigger({ startsInProviderOrActiveTurn: true }) })).toBeNull();
    expect(oneShot({ trigger: trigger({ freshContext: true }) })).toBeNull();
  });

  it("does nothing with either switch off", () => {
    expect(oneShot({ compactStaleThreadsOnWake: false })).toBeNull();
    expect(oneShot({ idleCompaction: "off" })).toBeNull();
  });

  it("uses one id per waking message, so a second delivery adds no compaction", () => {
    expect(staleWakeCompactionMessageId("message-2")).toBe(
      staleWakeCompactionMessageId("message-2"),
    );
    expect(staleWakeCompactionMessageId("message-2")).not.toBe(
      staleWakeCompactionMessageId("message-3"),
    );
  });

  it("keeps the on defaults with no extra idle time", () => {
    expect(oneShot({ data: records({ updatedInMs: -90 * MINUTE_MS }) })?.idleMs).toBe(
      90 * MINUTE_MS,
    );
  });
});

function name(value: ReturnType<typeof staleWakeOneShot>): string | null {
  return value?.reason ?? null;
}
