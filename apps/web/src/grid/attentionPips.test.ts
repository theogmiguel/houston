import type { EnvironmentThreadShell } from "@houston-app/client-runtime/state/models";
import { describe, expect, it } from "vite-plus/test";

import { attentionPips } from "./attentionPips";

const NOW = "2026-01-01T00:00:00.000Z";

function shell(id: string, overrides: Record<string, unknown> = {}): EnvironmentThreadShell {
  return {
    id,
    environmentId: "env-1",
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    pendingSubagentRequest: null,
    runtime: null,
    latestRun: null,
    lastVisitedAt: null,
    settledOverride: null,
    unsettledAt: null,
    ...overrides,
  } as unknown as EnvironmentThreadShell;
}

describe("attentionPips", () => {
  it("counts failed rows apart from rows that wait for the user", () => {
    const threads = [
      shell("failed", {
        latestRun: { status: "failed", completedAt: "2025-12-31T23:00:00.000Z" },
        runtime: { status: "failed", lastErrorClass: "provider" },
      }),
      shell("approval", { hasPendingApprovals: true }),
      shell("input", { hasPendingUserInput: true }),
      shell("request", { pendingSubagentRequest: "approval" }),
      shell("running", { runtime: { status: "running", lastErrorClass: null } }),
      shell("idle"),
    ];
    expect(attentionPips(threads, NOW)).toEqual({ failed: 1, needsYou: 3 });
  });

  it("counts a usage-limit stop as waiting for the user, not as a failure", () => {
    const limited = shell("limited", {
      latestRun: { status: "failed", completedAt: "2025-12-31T23:00:00.000Z" },
      runtime: { status: "failed", lastErrorClass: "usage_limit" },
    });
    expect(attentionPips([limited], NOW)).toEqual({ failed: 0, needsYou: 1 });
  });

  it("counts a thread listed twice once", () => {
    const asks = shell("asks", { hasPendingUserInput: true });
    expect(attentionPips([asks, asks], NOW)).toEqual({ failed: 0, needsYou: 1 });
  });

  it("is empty for rows with nothing to report", () => {
    expect(attentionPips([], NOW)).toEqual({ failed: 0, needsYou: 0 });
  });
});
