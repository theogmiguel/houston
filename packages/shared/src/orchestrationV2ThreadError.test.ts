import {
  MessageId,
  NodeId,
  ProviderInstanceId,
  ProviderThreadId,
  RunId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2Run,
} from "@houston-app/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { usageLimitBlockedRun } from "./orchestrationV2ThreadError.ts";

const claude = ProviderInstanceId.make("claude");
const codex = ProviderInstanceId.make("codex");
const threadId = ThreadId.make("thread:usage-limit-scope");
const now = DateTime.makeUnsafe("2026-06-20T00:00:00.000Z");

function run(
  id: string,
  ordinal: number,
  status: OrchestrationV2Run["status"],
  providerInstanceId: ProviderInstanceId,
  completedAt: DateTime.Utc | null = now,
): OrchestrationV2Run {
  return {
    id: RunId.make(id),
    threadId,
    ordinal,
    providerInstanceId,
    modelSelection: { instanceId: providerInstanceId, model: "test-model" },
    providerThreadId: ProviderThreadId.make(`provider-thread:${id}`),
    userMessageId: MessageId.make(`message:${id}`),
    rootNodeId: NodeId.make(`node:${id}`),
    activeAttemptId: null,
    status,
    requestedAt: now,
    startedAt: status === "queued" ? null : now,
    completedAt,
    checkpointId: null,
    contextHandoffId: null,
  };
}

function usageLimitErrorItem(runId: RunId) {
  return {
    id: TurnItemId.make(`turn-item:${runId}`),
    threadId,
    runId,
    nodeId: NodeId.make(`node:${runId}`),
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: 1,
    type: "error" as const,
    status: "failed" as const,
    title: "Usage limit reached",
    startedAt: now,
    completedAt: now,
    updatedAt: now,
    failure: {
      class: "usage_limit" as const,
      message: "Plan limit reached",
      code: "usageLimitExceeded",
      retryable: null,
    },
  };
}

describe("usageLimitBlockedRun", () => {
  it("ignores a later successful run from a different provider instance", () => {
    const limited = run("claude-limited", 1, "failed", claude);
    const laterSuccess = run("codex-success", 2, "completed", codex);
    const turnItems = [usageLimitErrorItem(limited.id)];

    // Without scoping, the latest executed run belongs to the other provider, so
    // no limit is reported for the limited provider.
    expect(usageLimitBlockedRun([limited, laterSuccess], turnItems, null)).toBeNull();

    // Scoped to the limited provider, its failed run is the one that holds the queue.
    expect(
      usageLimitBlockedRun([limited, laterSuccess], turnItems, null, claude)?.id,
    ).toBe(limited.id);
  });

  it("still reports a limit when the same provider's later run is also limited", () => {
    const first = run("claude-limited-1", 1, "failed", claude);
    const second = run("claude-limited-2", 2, "failed", claude);
    const turnItems = [usageLimitErrorItem(first.id), usageLimitErrorItem(second.id)];

    expect(usageLimitBlockedRun([first, second], turnItems, null, claude)?.id).toBe(second.id);
  });
});
