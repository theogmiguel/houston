import type { EnvironmentThreadShell } from "@houston-app/client-runtime/state/models";
import { describe, expect, it } from "vite-plus/test";

import { revealedOpenThread } from "./collapsedRollup";
import type { GridRecord } from "./gridStore";

function shell(overrides: Record<string, unknown> = {}): EnvironmentThreadShell {
  return {
    id: "t",
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    pendingSubagentRequest: null,
    runtime: null,
    latestRun: null,
    lastVisitedAt: null,
    ...overrides,
  } as unknown as EnvironmentThreadShell;
}

describe("revealedOpenThread", () => {
  const grid = (id: string, focusedThreadId: string | null) =>
    ({ id, focusedThreadId }) as unknown as GridRecord;
  const entries = [
    { grid: grid("a", "t1"), threads: [shell({ id: "t1" }), shell({ id: "t2" })] },
    { grid: grid("b", "gone"), threads: [shell({ id: "thread-c" })] },
  ];

  it("returns the focused thread of the open grid", () => {
    expect(revealedOpenThread(entries, "a")?.thread.id).toBe("t1");
  });

  it("returns null when no grid is open, the grid is elsewhere, or the focused thread is not listed", () => {
    expect(revealedOpenThread(entries, null)).toBeNull();
    expect(revealedOpenThread(entries, "other")).toBeNull();
    expect(revealedOpenThread(entries, "b")).toBeNull();
  });
});
