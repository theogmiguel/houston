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

function counts(threads: ReadonlyArray<EnvironmentThreadShell>) {
  return Object.fromEntries(
    attentionPips(threads, NOW).map((pip) => [pip.group, pip.count] as const),
  );
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
    expect(counts(threads)).toEqual({ failed: 1, needs: 3 });
  });

  it("counts a usage-limit stop with the warning family, not as a failure", () => {
    const limited = shell("limited", {
      latestRun: { status: "failed", completedAt: "2025-12-31T23:00:00.000Z" },
      runtime: { status: "failed", lastErrorClass: "usage_limit" },
    });
    expect(counts([limited])).toEqual({ needs: 1 });
  });

  it("counts a thread that came back unseen", () => {
    const back = shell("back", {
      lastVisitedAt: "2025-12-31T23:58:00.000Z",
      unsettledAt: "2025-12-31T23:59:00.000Z",
    });
    expect(counts([back])).toEqual({ back: 1 });
  });

  it("counts a thread listed twice once and records its first row", () => {
    const asks = shell("asks", { hasPendingUserInput: true });
    const [pip] = attentionPips([asks, asks], NOW);
    expect(pip).toEqual({
      group: "needs",
      count: 1,
      firstThreadKey: "env-1:asks",
    });
  });

  it("is empty for rows with nothing to report", () => {
    expect(attentionPips([], NOW)).toEqual([]);
  });
});
