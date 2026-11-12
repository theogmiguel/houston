import type { EnvironmentThreadShell } from "@houston-app/client-runtime/state/models";
import { describe, expect, it } from "vite-plus/test";

import { closedAgeLabel, threadStatusKind, threadStatusWord } from "./statusWord";

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

describe("threadStatusWord", () => {
  it("names what a thread that needs you is waiting for", () => {
    expect(threadStatusWord(shell({ hasPendingApprovals: true }), "needs")).toBe("Approval");
    expect(threadStatusWord(shell({ hasPendingUserInput: true }), "needs")).toBe("Input");
    expect(threadStatusWord(shell({ pendingSubagentRequest: "approval" }), "needs")).toBe(
      "Request",
    );
    expect(threadStatusWord(shell(), "needs")).toBe("Needs you");
  });

  it("puts an own approval ahead of an own input and a subagent request", () => {
    const thread = shell({
      hasPendingApprovals: true,
      hasPendingUserInput: true,
      pendingSubagentRequest: "user_input",
    });
    expect(threadStatusWord(thread, "needs")).toBe("Approval");
  });

  it("calls a usage-limit failure Limited and any other failure Failed", () => {
    const limited = shell({ runtime: { status: "failed", lastErrorClass: "usage_limit" } });
    const broken = shell({ runtime: { status: "failed", lastErrorClass: "provider" } });
    expect(threadStatusWord(limited, "failed")).toBe("Limited");
    expect(threadStatusWord(broken, "failed")).toBe("Failed");
  });

  it("separates a goal run and a thread waiting on another thread from plain running", () => {
    const running = { status: "running" };
    expect(threadStatusWord(shell({ runtime: running }), "running")).toBe("Running");
    expect(
      threadStatusWord(shell({ runtime: running, goal: { status: "active" } }), "running"),
    ).toBe("Goal");
    expect(
      threadStatusWord(shell({ runtime: running, blockedOnThreadWait: true }), "running"),
    ).toBe("Waiting");
  });

  it("keeps Ready and Back, and gives an idle thread no word", () => {
    expect(threadStatusWord(shell(), "ready")).toBe("Ready");
    expect(threadStatusWord(shell(), "back")).toBe("Back");
    expect(threadStatusWord(shell(), "idle")).toBeNull();
  });
});

describe("threadStatusKind", () => {
  it("gives every word the second line can say its own kind", () => {
    const running = { status: "running" };
    const kinds = [
      threadStatusKind(shell({ hasPendingApprovals: true }), "needs"),
      threadStatusKind(shell({ hasPendingUserInput: true }), "needs"),
      threadStatusKind(shell({ pendingSubagentRequest: "approval" }), "needs"),
      threadStatusKind(shell(), "needs"),
      threadStatusKind(shell({ runtime: { status: "failed", lastErrorClass: "x" } }), "failed"),
      threadStatusKind(
        shell({ runtime: { status: "failed", lastErrorClass: "usage_limit" } }),
        "failed",
      ),
      threadStatusKind(shell({ runtime: running, blockedOnThreadWait: true }), "running"),
      threadStatusKind(shell({ runtime: running }), "running"),
      threadStatusKind(shell({ runtime: running, goal: { status: "active" } }), "running"),
      threadStatusKind(shell(), "back"),
      threadStatusKind(shell(), "ready"),
      threadStatusKind(shell(), "idle"),
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
