import type { EnvironmentThreadShell } from "@houston-app/client-runtime/state/models";
import { describe, expect, it } from "vite-plus/test";

import {
  attentionCardsForWorkspaces,
  attentionNavigationDirection,
  type AttentionCard,
  clearThreadSelection,
  nextAttentionCard,
  openPullRequestNumber,
  partitionShelfThreads,
  resolveGridThreadState,
  runningSubagentsByParentThread,
  subagentParentKey,
  threadMatchesGridSearch,
  updateThreadSelection,
} from "./sidebar";

const NOW = "2026-10-29T12:00:00.000Z";

function thread(
  overrides: Omit<Partial<EnvironmentThreadShell>, "id"> & { id?: string } = {},
): EnvironmentThreadShell {
  return {
    environmentId: "env-1",
    id: "thread-a",
    projectId: "project-1",
    title: "A thread",
    providerInstanceId: "claude",
    modelSelection: { instanceId: "claude", model: "claude-opus" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: "houston/a-thread",
    worktreePath: null,
    lineage: {
      relationshipToParent: null,
      parentThreadId: null,
      rootThreadId: "thread-a",
    },
    forkedFrom: null,
    linkOrigin: null,
    delegatedFrom: null,
    activeProviderThreadId: null,
    latestRun: null,
    runtime: null,
    latestUserMessageAt: "2026-10-29T11:00:00.000Z",
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    pendingBackgroundTasks: [],
    providerInstanceHistory: ["claude"],
    goal: null,
    itemCount: 1,
    visibleItemCount: 1,
    createdAt: "2026-10-29T10:00:00.000Z",
    updatedAt: "2026-10-29T11:00:00.000Z",
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    unsettledAt: null,
    snoozedUntil: null,
    snoozedAt: null,
    pinnedAt: null,
    pinOrderKey: null,
    activeOrderKey: null,
    pullRequests: [],
    lastVisitedAt: "2026-10-29T11:00:00.000Z",
    deletedAt: null,
    ...overrides,
  } as EnvironmentThreadShell;
}

function subagentChild(
  id: string,
  parentThreadId: string,
  runtime: Partial<EnvironmentThreadShell["runtime"]> | null = null,
): EnvironmentThreadShell {
  return thread({
    id,
    lineage: {
      relationshipToParent: "subagent",
      parentThreadId: parentThreadId as never,
      rootThreadId: parentThreadId as never,
    },
    runtime: runtime === null ? null : ({ ...runtime, updatedAt: NOW } as never),
  });
}

describe("grid thread state", () => {
  it("maps a running thread to Running", () => {
    expect(
      resolveGridThreadState(
        thread({ runtime: { status: "running", updatedAt: NOW } as never }),
        NOW,
      ),
    ).toBe("running");
  });

  it("maps a pending request to Needs you", () => {
    expect(resolveGridThreadState(thread({ hasPendingApprovals: true }), NOW)).toBe("needs");
  });

  it("maps an unseen completion to Ready", () => {
    expect(
      resolveGridThreadState(
        thread({
          latestRun: {
            status: "completed",
            completedAt: "2026-10-29T11:30:00.000Z",
          } as never,
        }),
        NOW,
      ),
    ).toBe("ready");
  });

  it("maps an unseen failure to Failed", () => {
    expect(
      resolveGridThreadState(
        thread({
          latestRun: {
            status: "failed",
            completedAt: "2026-10-29T11:30:00.000Z",
          } as never,
        }),
        NOW,
      ),
    ).toBe("failed");
  });

  it("marks a thread woken from hold as Back until it is opened", () => {
    expect(
      resolveGridThreadState(
        thread({
          snoozedAt: "2026-10-29T09:00:00.000Z",
          snoozedUntil: "2026-10-29T11:00:00.000Z",
          lastVisitedAt: "2026-10-29T10:00:00.000Z",
        }),
        NOW,
      ),
    ).toBe("back");
  });

  it("marks a reopened thread as Back until it is opened", () => {
    expect(
      resolveGridThreadState(
        thread({
          settledOverride: null,
          unsettledAt: "2026-10-29T11:30:00.000Z",
          lastVisitedAt: "2026-10-29T10:00:00.000Z",
        }),
        NOW,
      ),
    ).toBe("back");
    expect(
      resolveGridThreadState(
        thread({
          settledOverride: null,
          unsettledAt: "2026-10-29T11:30:00.000Z",
          lastVisitedAt: "2026-10-29T11:45:00.000Z",
        }),
        NOW,
      ),
    ).toBe("idle");
  });

  it("shows a read thread as idle so the card shows its age", () => {
    expect(
      resolveGridThreadState(
        thread({
          latestRun: {
            status: "completed",
            completedAt: "2026-10-29T11:30:00.000Z",
          } as never,
          lastVisitedAt: "2026-10-29T11:45:00.000Z",
        }),
        NOW,
      ),
    ).toBe("idle");
  });
});

describe("running subagent count", () => {
  const parent = thread({ id: "thread-parent" });

  it("counts nothing when no subagent runs", () => {
    const counts = runningSubagentsByParentThread(
      [parent, subagentChild("child-a", "thread-parent", { status: "idle" })],
      NOW,
    );
    expect(counts.get(subagentParentKey(parent))).toBeUndefined();
  });

  it("counts the subagents still running when some finished", () => {
    const counts = runningSubagentsByParentThread(
      [
        parent,
        subagentChild("child-running", "thread-parent", { status: "running" }),
        subagentChild("child-done", "thread-parent", { status: "completed" }),
      ],
      NOW,
    );
    expect(counts.get(subagentParentKey(parent))).toBe(1);
  });

  it("counts every running subagent of the parent, not its grandchildren", () => {
    const counts = runningSubagentsByParentThread(
      [
        parent,
        subagentChild("child-a", "thread-parent", { status: "running" }),
        subagentChild("child-b", "thread-parent", { status: "running" }),
        subagentChild("grandchild", "child-a", { status: "running" }),
      ],
      NOW,
    );
    expect(counts.get(subagentParentKey(parent))).toBe(2);
    expect(counts.get(subagentParentKey(thread({ id: "child-a" })))).toBe(1);
  });

  it("counts nothing when every subagent finished", () => {
    const counts = runningSubagentsByParentThread(
      [
        parent,
        subagentChild("child-a", "thread-parent", { status: "completed" }),
        subagentChild("child-b", "thread-parent", { status: "interrupted" }),
      ],
      NOW,
    );
    expect(counts.get(subagentParentKey(parent))).toBeUndefined();
  });
});

describe("grid thread selection", () => {
  const orderedKeys = ["a", "b", "c", "d"];

  it("selects a range from the anchor when Shift is held", () => {
    const selection = updateThreadSelection(clearThreadSelection(), {
      orderedKeys,
      clickedKey: "b",
      shiftKey: false,
      toggleKey: false,
    });
    const ranged = updateThreadSelection(selection, {
      orderedKeys,
      clickedKey: "d",
      shiftKey: true,
      toggleKey: false,
    });
    expect([...ranged.selectedThreadKeys]).toEqual(["b", "c", "d"]);
    expect(ranged.anchorThreadKey).toBe("b");
  });

  it("toggles one card with Ctrl and keeps the anchor", () => {
    const first = updateThreadSelection(clearThreadSelection(), {
      orderedKeys,
      clickedKey: "a",
      shiftKey: false,
      toggleKey: false,
    });
    const added = updateThreadSelection(first, {
      orderedKeys,
      clickedKey: "c",
      shiftKey: false,
      toggleKey: true,
    });
    expect([...added.selectedThreadKeys]).toEqual(["a", "c"]);
    const removed = updateThreadSelection(added, {
      orderedKeys,
      clickedKey: "a",
      shiftKey: false,
      toggleKey: true,
    });
    expect([...removed.selectedThreadKeys]).toEqual(["c"]);
  });
});

describe("attention navigation shortcut", () => {
  const chord = (overrides: Partial<Parameters<typeof attentionNavigationDirection>[0]>) => ({
    key: ".",
    code: "Period",
    metaKey: false,
    ctrlKey: true,
    altKey: false,
    shiftKey: false,
    ...overrides,
  });

  it("uses Ctrl . for next and Ctrl Shift . for previous", () => {
    expect(attentionNavigationDirection(chord({}))).toBe(1);
    expect(attentionNavigationDirection(chord({ metaKey: true, ctrlKey: false }))).toBe(1);
    expect(attentionNavigationDirection(chord({ shiftKey: true }))).toBe(-1);
  });

  it("accepts the shifted period key on layouts that produce >", () => {
    expect(attentionNavigationDirection(chord({ key: ">", code: "Period", shiftKey: true }))).toBe(
      -1,
    );
  });

  it("leaves Ctrl J to the terminal drawer and ignores extra modifiers", () => {
    expect(attentionNavigationDirection(chord({ key: "j", code: "KeyJ" }))).toBeNull();
    expect(attentionNavigationDirection(chord({ altKey: true }))).toBeNull();
    expect(attentionNavigationDirection(chord({ ctrlKey: false, metaKey: false }))).toBeNull();
    expect(attentionNavigationDirection(chord({ key: ",", code: "Comma" }))).toBeNull();
  });
});

describe("attention navigation", () => {
  const cards: AttentionCard[] = [
    { workspaceId: "w-1", threadId: "running", state: "running" },
    { workspaceId: "w-1", threadId: "ready", state: "ready" },
    { workspaceId: "w-2", threadId: "needs", state: "needs" },
    { workspaceId: "w-2", threadId: "idle", state: "idle" },
  ];

  it("walks Ready and Needs you cards across workspaces and wraps", () => {
    expect(nextAttentionCard(cards, null, 1)?.threadId).toBe("ready");
    expect(nextAttentionCard(cards, { threadId: "ready" }, 1)?.threadId).toBe("needs");
    expect(nextAttentionCard(cards, { threadId: "needs" }, 1)?.threadId).toBe("ready");
  });

  it("walks backwards and starts after a card that needs nothing", () => {
    expect(nextAttentionCard(cards, null, -1)?.threadId).toBe("needs");
    expect(nextAttentionCard(cards, { threadId: "running" }, 1)?.threadId).toBe("ready");
    expect(nextAttentionCard(cards, { threadId: "idle" }, -1)?.threadId).toBe("needs");
  });

  it("lists every thread of the workspaces it is given, so hidden ones stay reachable with Ctrl .", () => {
    const cards = attentionCardsForWorkspaces(
      [{ workspaceId: "w-1", threads: [thread({ id: "thread-b", hasPendingApprovals: true })] }],
      NOW,
    );
    expect(cards).toEqual([{ workspaceId: "w-1", threadId: "thread-b", state: "needs" }]);
    expect(nextAttentionCard(cards, null, 1)?.threadId).toBe("thread-b");
  });

  it("returns null when no card needs attention", () => {
    expect(
      nextAttentionCard([{ workspaceId: "w-1", threadId: "idle", state: "idle" }], null, 1),
    ).toBeNull();
  });
});

describe("grid search and pull requests", () => {
  it("matches title, branch and pull request number", () => {
    const searchable = {
      title: "Port provider tests",
      branch: "houston/provider-tests",
      pullRequests: [{ number: 412 }],
    };
    expect(threadMatchesGridSearch(searchable, "provider")).toBe(true);
    expect(threadMatchesGridSearch(searchable, "#412")).toBe(true);
    expect(threadMatchesGridSearch(searchable, "missing")).toBe(false);
  });

  it("shows the number of an open pull request", () => {
    expect(
      openPullRequestNumber({
        pullRequests: [
          { number: 400, snapshot: { state: "merged" } } as never,
          { number: 412, snapshot: { state: "open" } } as never,
        ],
        branchPullRequest: null,
      }),
    ).toBe(412);
  });
});

describe("grid shelves", () => {
  const workspaceKeys = new Set(["env-1:project-1"]);

  it("sorts held threads by wake time and closed threads newest first", () => {
    const shelves = partitionShelfThreads(
      [
        thread({
          id: "held-late",
          snoozedAt: "2026-10-29T10:00:00.000Z",
          snoozedUntil: "2026-10-29T15:00:00.000Z",
        }),
        thread({
          id: "closed-old",
          settledOverride: "settled",
          settledAt: "2026-10-28T10:00:00.000Z",
        }),
        thread({
          id: "held-soon",
          snoozedAt: "2026-10-29T10:00:00.000Z",
          snoozedUntil: "2026-10-29T13:00:00.000Z",
        }),
        thread({
          id: "closed-new",
          settledOverride: "settled",
          settledAt: "2026-10-29T11:00:00.000Z",
        }),
      ],
      workspaceKeys,
      NOW,
    );
    expect(shelves.held.map((entry) => entry.id)).toEqual(["held-soon", "held-late"]);
    expect(shelves.closed.map((entry) => entry.id)).toEqual(["closed-new", "closed-old"]);
  });

  it("leaves out archived threads and other workspaces", () => {
    const shelves = partitionShelfThreads(
      [
        thread({ id: "held", snoozedUntil: "2026-10-29T13:00:00.000Z" }),
        thread({ id: "archived", archivedAt: "2026-10-29T11:00:00.000Z" }),
        thread({ id: "other", projectId: "project-2" as never }),
      ],
      workspaceKeys,
      NOW,
    );
    expect(shelves.held.map((entry) => entry.id)).toEqual(["held"]);
    expect(shelves.closed).toEqual([]);
  });

  it("leaves a subagent child thread off the shelves", () => {
    const shelves = partitionShelfThreads(
      [
        thread({ id: "held", snoozedUntil: "2026-10-29T13:00:00.000Z" }),
        thread({
          id: "held-child",
          snoozedUntil: "2026-10-29T13:00:00.000Z",
          snoozedAt: "2026-10-29T11:00:00.000Z",
          lineage: {
            relationshipToParent: "subagent",
            parentThreadId: "held" as never,
            rootThreadId: "held" as never,
          },
        }),
        thread({
          id: "closed-child",
          settledOverride: "settled",
          settledAt: "2026-10-29T11:00:00.000Z",
          lineage: {
            relationshipToParent: "subagent",
            parentThreadId: "held" as never,
            rootThreadId: "held" as never,
          },
        }),
      ],
      workspaceKeys,
      NOW,
    );
    expect(shelves.held.map((entry) => entry.id)).toEqual(["held"]);
    expect(shelves.closed).toEqual([]);
  });
});
