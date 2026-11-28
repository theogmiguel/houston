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

import {
  accountLimitHold,
  limitWindowState,
  limitsAdmission,
  MAX_HOLD_WITHOUT_RESET_MS,
} from "./LimitsAdmission.ts";
import { nextTestReleaseAt, type LimitWindowRecord } from "./LimitWindowRegistry.ts";

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
  model: "gpt-5.4",
  windows: [],
  holdUnlimitedThreads: false,
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

const windowRecord = (overrides: Partial<LimitWindowRecord> = {}): LimitWindowRecord => ({
  providerInstanceId,
  scope: "*",
  resetAt: "2026-01-01T01:00:00.000Z",
  observedAt: "2026-01-01T00:00:00.000Z",
  testAttempt: 0,
  nextTestAt: null,
  ...overrides,
});

describe("account limit windows", () => {
  const nowMs = DateTime.toEpochMillis(now);

  it("is active while the reported reset is ahead and never overdue for a timed window", () => {
    assert.deepEqual(limitWindowState(windowRecord(), nowMs), {
      active: true,
      overdue: false,
      releaseAt: "2026-01-01T01:00:00.000Z",
    });
    const afterReset = limitWindowState(windowRecord(), Date.parse("2026-01-01T01:20:00.000Z"));
    assert.isFalse(afterReset.active);
    assert.isFalse(afterReset.overdue);
    assert.isFalse(
      limitWindowState(windowRecord({ resetAt: "2025-12-31T23:00:00.000Z" }), nowMs).active,
    );
  });

  it("keeps a no-reset failure recent and overdue after three failed tests", () => {
    const record = windowRecord({ resetAt: null, testAttempt: 3 });
    assert.isTrue(limitWindowState(record, nowMs).active);
    assert.isTrue(limitWindowState(record, nowMs).overdue);
    assert.isFalse(limitWindowState(record, nowMs + MAX_HOLD_WITHOUT_RESET_MS + 1).active);
  });

  it("schedules test releases after 15, 30, then 60 minutes", () => {
    const start = nowMs;
    assert.equal(nextTestReleaseAt(start, 0), start + 15 * 60_000);
    assert.equal(nextTestReleaseAt(start, 1), start + 30 * 60_000);
    assert.equal(nextTestReleaseAt(start, 2), start + 60 * 60_000);
    assert.equal(nextTestReleaseAt(start, 9), start + 60 * 60_000);
  });

  it("holds an automatic start on another thread of the same account", () => {
    const hold = accountLimitHold({
      origin: "automatic",
      providerInstanceId,
      model: "gpt-5.4",
      windows: [windowRecord()],
      holdUnlimitedThreads: true,
      nowMs,
    });
    assert.isNotNull(hold);
    assert.equal(hold?.reason.kind, "usage_limit");
    assert.equal(hold?.releaseAt, "2026-01-01T01:00:00.000Z");
  });

  it("does not hold a user start or a limit scoped to another model", () => {
    assert.isNull(
      accountLimitHold({
        origin: "user",
        providerInstanceId,
        model: "gpt-5.4",
        windows: [windowRecord()],
        holdUnlimitedThreads: true,
        nowMs,
      }),
    );
    assert.isNull(
      accountLimitHold({
        origin: "automatic",
        providerInstanceId,
        model: "gpt-5.4",
        windows: [windowRecord({ scope: "claude-opus" })],
        holdUnlimitedThreads: true,
        nowMs,
      }),
    );
  });

  it("holds nothing while the new row is off", () => {
    assert.isNull(
      accountLimitHold({
        origin: "automatic",
        providerInstanceId,
        model: "gpt-5.4",
        windows: [windowRecord()],
        holdUnlimitedThreads: false,
        nowMs,
      }),
    );
  });

  it("marks a hold overdue in its reason", () => {
    const hold = accountLimitHold({
      origin: "automatic",
      providerInstanceId,
      model: "gpt-5.4",
      windows: [windowRecord({ resetAt: null, testAttempt: 3 })],
      holdUnlimitedThreads: true,
      nowMs,
    });
    assert.isTrue(hold?.reason.overdue);
  });
});
