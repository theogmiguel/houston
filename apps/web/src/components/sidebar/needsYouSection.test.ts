import type { EnvironmentThreadShell } from "@houston-app/client-runtime/state/models";
import { ThreadId } from "@houston-app/contracts";
import { describe, expect, it } from "vite-plus/test";

import { buildNeedsYouEntries, isNeedsYouThread } from "./needsYouSection";

function thread(id: string, overrides: Record<string, unknown> = {}): EnvironmentThreadShell {
  return {
    id,
    environmentId: "env-1",
    projectId: "project-1",
    title: id,
    branch: "main",
    pullRequests: [],
    branchPullRequest: null,
    providerInstanceId: "claude",
    snoozedUntil: null,
    settledOverride: null,
    archivedAt: null,
    deletedAt: null,
    updatedAt: "2026-01-01T00:00:00.000Z",
    latestUserMessageAt: null,
    latestRun: null,
    runtime: null,
    autoSettleDisabledAt: null,
    lastVisitedAt: null,
    unsettledAt: null,
    lineage: {
      relationshipToParent: null,
      parentThreadId: null,
      rootThreadId: ThreadId.make(id),
      sideChat: false,
    },
    ...overrides,
  } as unknown as EnvironmentThreadShell;
}

const now = "2026-01-04T00:00:00.000Z";
const projectKeys = new Set(["env-1:project-1"]);

describe("buildNeedsYouEntries", () => {
  it("orders Input, Approval, Failed, Back, then newest activity within a family", () => {
    const entries = buildNeedsYouEntries({
      nowIso: now,
      projectKeys,
      threads: [
        thread("back", {
          unsettledAt: "2026-01-03T00:00:00.000Z",
          lastVisitedAt: "2026-01-01T00:00:00.000Z",
        }),
        thread("failed", {
          latestRun: { status: "failed", completedAt: "2026-01-02T00:00:00.000Z" },
        }),
        thread("approval", { hasPendingApprovals: true }),
        thread("input-old", {
          hasPendingUserInput: true,
          updatedAt: "2026-01-01T00:00:00.000Z",
        }),
        thread("input-new", {
          hasPendingUserInput: true,
          updatedAt: "2026-01-03T00:00:00.000Z",
        }),
        // Waiting and plain running threads are not part of the section.
        thread("running", { runtime: { status: "running" } }),
        thread("ready"),
      ],
    });

    expect(entries.map((entry) => [entry.thread.id, entry.group])).toEqual([
      ["input-new", "input"],
      ["input-old", "input"],
      ["approval", "approval"],
      ["failed", "failed"],
      ["back", "back"],
    ]);
  });

  it("leaves out archived, closed, deleted and closed-project threads", () => {
    const entries = buildNeedsYouEntries({
      nowIso: now,
      projectKeys,
      threads: [
        thread("archived", { hasPendingUserInput: true, archivedAt: "2026-01-02T00:00:00.000Z" }),
        thread("closed", { hasPendingUserInput: true, settledOverride: "settled" }),
        thread("elsewhere", { hasPendingUserInput: true, projectId: "project-2" }),
        thread("deleted", { hasPendingUserInput: true, deletedAt: "2026-01-02T00:00:00.000Z" }),
      ],
    });
    expect(entries).toEqual([]);
  });
});

describe("isNeedsYouThread", () => {
  it("is true for a thread that waits on the user and false for one that does not", () => {
    expect(isNeedsYouThread(thread("input", { hasPendingUserInput: true }), now)).toBe(true);
    expect(isNeedsYouThread(thread("ready"), now)).toBe(false);
  });

  it("agrees with the section on archived, closed, deleted and snoozed threads", () => {
    const waiting = { hasPendingUserInput: true };
    expect(
      isNeedsYouThread(thread("a", { ...waiting, archivedAt: "2026-01-02T00:00:00.000Z" }), now),
    ).toBe(false);
    expect(isNeedsYouThread(thread("c", { ...waiting, settledOverride: "settled" }), now)).toBe(
      false,
    );
    expect(
      isNeedsYouThread(thread("d", { ...waiting, deletedAt: "2026-01-02T00:00:00.000Z" }), now),
    ).toBe(false);
  });
});
