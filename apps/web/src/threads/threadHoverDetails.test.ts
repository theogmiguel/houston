import { describe, expect, it } from "vite-plus/test";

import { HOVER_ERROR_MAX_CHARS, threadHoverDetails } from "./threadHoverDetails";

const providerEntries = new Map([
  [
    "claude",
    {
      displayName: "Claude",
      models: [{ slug: "claude-opus-4", name: "Opus 4", isCustom: false }],
    },
  ],
  ["codex", { displayName: "Codex", models: [] }],
]) as never;

function details(thread: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) {
  return threadHoverDetails({
    thread: {
      branch: "feature/x",
      worktreePath: null,
      pullRequests: [],
      providerInstanceId: "claude",
      providerInstanceHistory: ["claude"],
      modelSelection: { instanceId: "claude", model: "claude-opus-4" },
      runtime: null,
      ...thread,
    } as never,
    providerEntries,
    checkoutBranch: "feature/x",
    environmentLabel: null,
    terminalCount: 0,
    nowMs: Date.parse("2026-01-01T00:00:00.000Z"),
    ...extra,
  });
}

describe("threadHoverDetails", () => {
  it("names the provider and the model's display name", () => {
    expect(details()).toMatchObject({ provider: "Claude", model: "Opus 4" });
  });

  it("falls back to the raw model slug when the provider does not list it", () => {
    expect(details({ modelSelection: { instanceId: "claude", model: "custom-x" } }).model).toBe(
      "custom-x",
    );
  });

  it("warns when the checkout is on another branch than the thread's", () => {
    expect(details({}, { checkoutBranch: "main" }).branchWarning).toBe(
      "Checkout is on main, not feature/x",
    );
  });

  it("does not warn for a worktree, a matching branch or an unknown checkout branch", () => {
    expect(details({ worktreePath: "/w" }, { checkoutBranch: "main" })).toMatchObject({
      branchWarning: null,
      checkout: "worktree",
    });
    expect(details().branchWarning).toBeNull();
    expect(details({}, { checkoutBranch: null }).branchWarning).toBeNull();
  });

  it("lists the providers a moved thread ran on, in order, and nothing for one that never moved", () => {
    expect(details({ providerInstanceHistory: ["claude", "codex", "other"] }).handoffs).toEqual([
      "Claude",
      "Codex",
      "other",
    ]);
    expect(details().handoffs).toEqual([]);
  });

  it("reports a usage limit while its reset is ahead, else the last error", () => {
    const runtime = {
      usageLimitResetAt: "2026-01-01T05:00:00.000Z",
      lastError: "rate limited",
    };
    expect(details({ runtime }).problem).toEqual({
      kind: "limit",
      resetAt: "2026-01-01T05:00:00.000Z",
    });
    expect(
      details({ runtime: { ...runtime, usageLimitResetAt: "2025-12-31T00:00:00.000Z" } }).problem,
    ).toEqual({ kind: "error", text: "rate limited" });
    expect(details({ runtime: { usageLimitResetAt: null, lastError: null } }).problem).toBeNull();
  });

  it("keeps a long error on one line within the limit", () => {
    const problem = details({
      runtime: { usageLimitResetAt: null, lastError: `line one\n${"x".repeat(500)}` },
    }).problem;
    expect(problem?.kind === "error" && problem.text.length).toBe(HOVER_ERROR_MAX_CHARS);
    expect(problem?.kind === "error" && problem.text.includes("\n")).toBe(false);
  });

  it("lists the first pull requests and counts the rest", () => {
    const pullRequests = [1, 2, 3, 4, 5].map((number) => ({
      number,
      snapshot: { title: `PR ${number}`, state: "open" },
    }));
    const result = details({ pullRequests });
    expect(result.pullRequests.map((pr) => pr.number)).toEqual([1, 2, 3]);
    expect(result.morePullRequests).toBe(2);
  });
});
