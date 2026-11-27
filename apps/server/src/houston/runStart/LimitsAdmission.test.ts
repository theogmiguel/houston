import {
  type OrchestrationV2Run,
  type OrchestrationV2TurnItem,
  ProviderInstanceId,
  RunId,
  ThreadId,
  TurnItemId,
} from "@houston-app/contracts";
import * as DateTime from "effect/DateTime";
import { assert, describe, it } from "@effect/vitest";

import { limitsAdmission } from "./LimitsAdmission.ts";

const providerInstanceId = ProviderInstanceId.make("codex");
const threadId = ThreadId.make("thread:limited");
const now = DateTime.makeUnsafe("2026-01-01T00:00:00.000Z");

const failedRun = (overrides: Partial<OrchestrationV2Run> = {}): OrchestrationV2Run =>
  ({
    id: RunId.make("run:limited"),
    threadId,
    ordinal: 1,
    providerInstanceId,
    status: "failed",
    rootNodeId: "node:root",
    activeAttemptId: "attempt:1",
    startedAt: DateTime.makeUnsafe("2025-12-31T23:00:00.000Z"),
    completedAt: DateTime.makeUnsafe("2025-12-31T23:59:00.000Z"),
    ...overrides,
  }) as OrchestrationV2Run;

const limitItem = (resetAt: string | null, runId = "run:limited"): OrchestrationV2TurnItem =>
  ({
    id: TurnItemId.make("item:error"),
    type: "error",
    threadId,
    runId,
    nodeId: "node:root",
    status: "failed",
    ordinal: 2,
    updatedAt: DateTime.makeUnsafe("2025-12-31T23:59:00.000Z"),
    failure: {
      class: "usage_limit",
      message: "Usage limit reached.",
      code: "usage_limit",
      resetAt,
    },
  }) as OrchestrationV2TurnItem;

const input = (overrides: Partial<Parameters<typeof limitsAdmission>[0]> = {}) => ({
  origin: "automatic" as const,
  providerInstanceId,
  runs: [failedRun()],
  turnItems: [limitItem("2026-01-01T01:00:00.000Z")],
  snoozeLimitedThreads: true,
  nowMs: DateTime.toEpochMillis(now),
  ...overrides,
});

describe("limitsAdmission", () => {
  it("holds an automatic turn while the reported reset is ahead", () => {
    const hold = limitsAdmission(input());
    assert.isNotNull(hold);
    assert.equal(hold?.type, "hold");
    if (hold === null || hold.type !== "hold") return;
    assert.equal(hold.reason.kind, "usage_limit");
    assert.match(hold.reason.message, /usage limit/i);
    assert.match(hold.reason.message, /2026-01-01T01:00:00.000Z/);
    assert.equal(hold.releaseAt, "2026-01-01T01:00:00.000Z");
  });

  it("never holds a user or provider start", () => {
    assert.isNull(limitsAdmission(input({ origin: "user" })));
    assert.isNull(limitsAdmission(input({ origin: "provider" })));
  });

  it("does not hold when Hold until limits reset is off", () => {
    assert.isNull(limitsAdmission(input({ snoozeLimitedThreads: false })));
  });

  it("does not hold a limit whose reset time the provider did not report", () => {
    assert.isNull(limitsAdmission(input({ turnItems: [limitItem(null)] })));
  });

  it("does not hold once the reset has passed", () => {
    assert.isNull(
      limitsAdmission(
        input({
          turnItems: [limitItem("2025-12-31T23:30:00.000Z")],
        }),
      ),
    );
  });

  it("does not hold a run that failed on another provider", () => {
    assert.isNull(
      limitsAdmission(
        input({
          runs: [failedRun({ providerInstanceId: ProviderInstanceId.make("claude") })],
        }),
      ),
    );
  });
});
