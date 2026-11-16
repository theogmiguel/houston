import type { EnvironmentThreadShell } from "@houston-app/client-runtime/state/models";
import { describe, expect, it } from "vite-plus/test";

import { membershipKeyOf, type ThreadMembershipState } from "../../layout/threadMembership";
import {
  deleteWorkspaceThreads,
  planWorkspaceDeletion,
  workspaceDeletionMessage,
} from "./workspaceDeletion";

const NOW = "2026-06-01T12:00:00.000Z";

function thread(id: string, overrides: Record<string, unknown> = {}): EnvironmentThreadShell {
  return {
    id,
    environmentId: "env-1",
    projectId: "p1",
    title: `Title ${id}`,
    archivedAt: null,
    deletedAt: null,
    settledOverride: null,
    snoozedUntil: null,
    runtime: null,
    latestRun: null,
    lastVisitedAt: null,
    unsettledAt: null,
    lineage: {
      relationshipToParent: null,
      parentThreadId: null,
      rootThreadId: id,
      sideChat: false,
    },
    ...overrides,
  } as unknown as EnvironmentThreadShell;
}

const running = { status: "running", activeRunId: "run-1", lastError: null };

function memberships(
  rows: ReadonlyArray<readonly [string, string, string | null]>,
): ThreadMembershipState {
  return {
    loaded: true,
    byThread: new Map(
      rows.map(([id, workspaceId, parentThreadId]) => [
        membershipKeyOf("env-1", id),
        { workspaceId, parentThreadId },
      ]),
    ),
    occupied: new Set(rows.map(([, workspaceId]) => workspaceId)),
  };
}

describe("planWorkspaceDeletion", () => {
  const state = memberships([
    ["a", "w1", null],
    ["a-child", "w1", "a"],
    ["archived", "w1", null],
    ["other", "w2", null],
    ["gone", "w1", null],
  ]);
  const threads = [
    thread("a", { runtime: running }),
    thread("a-child"),
    thread("archived", { archivedAt: NOW }),
    thread("other"),
    thread("gone", { deletedAt: NOW }),
  ];

  it("lists every live thread of the workspace, archived ones included, children first", () => {
    const plan = planWorkspaceDeletion({
      workspaceId: "w1",
      memberships: state,
      threads,
      nowIso: NOW,
    });
    expect(plan.threads.map((entry) => entry.id)).toEqual(["a-child", "a", "archived"]);
  });

  it("counts the running threads", () => {
    const plan = planWorkspaceDeletion({
      workspaceId: "w1",
      memberships: state,
      threads,
      nowIso: NOW,
    });
    expect(plan.running).toBe(1);
  });

  it("plans nothing for a workspace no thread belongs to", () => {
    const plan = planWorkspaceDeletion({
      workspaceId: "w9",
      memberships: state,
      threads,
      nowIso: NOW,
    });
    expect(plan).toEqual({ threads: [], running: 0 });
  });
});

describe("workspaceDeletionMessage", () => {
  it("names the workspace, the thread count and how many are running", () => {
    const plan = { threads: [thread("a"), thread("b"), thread("c")], running: 2 };
    expect(workspaceDeletionMessage("Docs", plan)).toBe(
      "Delete the workspace “Docs” and its 3 threads? 2 threads are running and will be stopped. This permanently clears their conversation history.",
    );
  });

  it("says nothing about running when none is", () => {
    expect(workspaceDeletionMessage("Docs", { threads: [thread("a")], running: 0 })).toBe(
      "Delete the workspace “Docs” and its 1 thread? This permanently clears their conversation history.",
    );
  });
});

describe("deleteWorkspaceThreads", () => {
  const plan = { threads: [thread("a"), thread("b"), thread("c")], running: 0 };

  it("deletes every planned thread in order, telling each what is already gone", async () => {
    const seen: string[] = [];
    const failure = await deleteWorkspaceThreads({
      workspaceName: "Docs",
      plan,
      deleteThread: async (entry, deleted) => {
        seen.push(`${entry.id}:${[...deleted].length}`);
        return null;
      },
    });
    expect(failure).toBeNull();
    expect(seen).toEqual(["a:0", "b:1", "c:2"]);
  });

  it("stops at the first failure and names the thread and the workspace", async () => {
    const seen: string[] = [];
    const failure = await deleteWorkspaceThreads({
      workspaceName: "Docs",
      plan,
      deleteThread: async (entry) => {
        seen.push(entry.id);
        return entry.id === "b" ? "worktree is busy" : null;
      },
    });
    expect(seen).toEqual(["a", "b"]);
    expect(failure).toContain("“Title b” (b)");
    expect(failure).toContain("workspace “Docs”");
    expect(failure).toContain("worktree is busy");
  });
});
