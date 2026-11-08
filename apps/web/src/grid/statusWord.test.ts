import type { EnvironmentThreadShell } from "@houston-app/client-runtime/state/models";
import { describe, expect, it } from "vite-plus/test";

import { closedAgeLabel, gridThreadStatusKind, gridThreadStatusWord } from "./statusWord";

function shell(overrides: Record<string, unknown> = {}): EnvironmentThreadShell {
  return {
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    pendingSubagentRequest: null,
    runtime: null,
    latestRun: null,
    goal: null,
    settledAt: null,
    unsettledAt: null,
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  } as unknown as EnvironmentThreadShell;
}

describe("gridThreadStatusWord", () => {
  it("names what a thread that needs you is waiting for", () => {
    expect(gridThreadStatusWord(shell({ hasPendingApprovals: true }), "needs")).toBe("Approval");
    expect(gridThreadStatusWord(shell({ hasPendingUserInput: true }), "needs")).toBe("Input");
    expect(gridThreadStatusWord(shell({ pendingSubagentRequest: "approval" }), "needs")).toBe(
      "Request",
    );
    expect(gridThreadStatusWord(shell(), "needs")).toBe("Needs you");
  });

  it("puts an own approval ahead of an own input and a subagent request", () => {
    const thread = shell({
      hasPendingApprovals: true,
      hasPendingUserInput: true,
      pendingSubagentRequest: "user_input",
    });
    expect(gridThreadStatusWord(thread, "needs")).toBe("Approval");
  });

  it("calls a usage-limit failure Limited and any other failure Failed", () => {
    const limited = shell({ runtime: { status: "failed", lastErrorClass: "usage_limit" } });
    const broken = shell({ runtime: { status: "failed", lastErrorClass: "provider" } });
    expect(gridThreadStatusWord(limited, "failed")).toBe("Limited");
    expect(gridThreadStatusWord(broken, "failed")).toBe("Failed");
  });

  it("separates a goal run and a thread waiting on another thread from plain running", () => {
    const running = { status: "running" };
    expect(gridThreadStatusWord(shell({ runtime: running }), "running")).toBe("Running");
    expect(
      gridThreadStatusWord(shell({ runtime: running, goal: { status: "active" } }), "running"),
    ).toBe("Goal");
    expect(
      gridThreadStatusWord(shell({ runtime: running, blockedOnThreadWait: true }), "running"),
    ).toBe("Waiting");
  });

  it("keeps Ready and Back, and gives an idle thread no word", () => {
    expect(gridThreadStatusWord(shell(), "ready")).toBe("Ready");
    expect(gridThreadStatusWord(shell(), "back")).toBe("Back");
    expect(gridThreadStatusWord(shell(), "idle")).toBeNull();
  });
});

describe("gridThreadStatusKind", () => {
  it("gives every word the second line can say its own kind", () => {
    const running = { status: "running" };
    const kinds = [
      gridThreadStatusKind(shell({ hasPendingApprovals: true }), "needs"),
      gridThreadStatusKind(shell({ hasPendingUserInput: true }), "needs"),
      gridThreadStatusKind(shell({ pendingSubagentRequest: "approval" }), "needs"),
      gridThreadStatusKind(shell(), "needs"),
      gridThreadStatusKind(shell({ runtime: { status: "failed", lastErrorClass: "x" } }), "failed"),
      gridThreadStatusKind(
        shell({ runtime: { status: "failed", lastErrorClass: "usage_limit" } }),
        "failed",
      ),
      gridThreadStatusKind(shell({ runtime: running, blockedOnThreadWait: true }), "running"),
      gridThreadStatusKind(shell({ runtime: running }), "running"),
      gridThreadStatusKind(shell({ runtime: running, goal: { status: "active" } }), "running"),
      gridThreadStatusKind(shell(), "back"),
      gridThreadStatusKind(shell(), "ready"),
      gridThreadStatusKind(shell(), "idle"),
    ];
    expect(kinds).toEqual([
      "approval",
      "input",
      "request",
      "needs",
      "failed",
      "limited",
      "waiting",
      "running",
      "goal",
      "back",
      "ready",
      "idle",
    ]);
  });
});

describe("closedAgeLabel", () => {
  it("shows when the thread was closed, not when it last changed", () => {
    const thread = shell({
      settledAt: "2026-01-01T10:00:00.000Z",
      updatedAt: "2026-01-01T11:59:00.000Z",
    });
    expect(closedAgeLabel(thread, Date.parse("2026-01-01T12:00:00.000Z"))).toBe("Closed 2h");
  });
});
