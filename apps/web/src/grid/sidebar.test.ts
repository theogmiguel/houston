import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { describe, expect, it } from "vite-plus/test";

import {
  attentionNavigationDirection,
  type AttentionCard,
  clearThreadSelection,
  nextAttentionCard,
  openPullRequestNumber,
  resolveGridThreadState,
  threadCardsInPaneOrder,
  threadMatchesGridSearch,
  updateThreadSelection,
  visibleGridThreads,
} from "./sidebar";
import type { GridRecord } from "./gridStore";

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

function grid(tree: GridRecord["tree"], overrides: Partial<GridRecord> = {}): GridRecord {
  return {
    id: "g-1",
    name: "Grid 1",
    environmentId: "env-1",
    projectId: "project-1",
    workspaceKey: "env-1:project-1",
    tree,
    focusedThreadId: null,
    pinnedAt: null,
    hidden: false,
    createdAt: "2026-10-29T10:00:00.000Z",
    ...overrides,
  };
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

describe("grid tree order", () => {
  it("lists cards in pane order, left to right, top to bottom", () => {
    const order = grid({
      kind: "split",
      dir: "col",
      weights: [50, 50],
      children: [
        {
          kind: "split",
          dir: "row",
          weights: [50, 50],
          children: [
            { kind: "thread", threadId: "thread-b", id: "p2" },
            { kind: "thread", threadId: "thread-a", id: "p1" },
          ],
        },
        { kind: "thread", threadId: "thread-c", id: "p3" },
      ],
    });
    const threads = [
      thread({ id: "thread-a" }),
      thread({ id: "thread-b" }),
      thread({ id: "thread-c" }),
    ];
    expect(threadCardsInPaneOrder(order, threads).map((entry) => entry.id)).toEqual([
      "thread-b",
      "thread-a",
      "thread-c",
    ]);
  });

  it("drops archived, closed and held threads from the rail", () => {
    const order = grid({
      kind: "split",
      dir: "row",
      weights: [25, 25, 25, 25],
      children: [
        { kind: "thread", threadId: "thread-open", id: "p1" },
        { kind: "thread", threadId: "thread-closed", id: "p2" },
        { kind: "thread", threadId: "thread-held", id: "p3" },
        { kind: "thread", threadId: "thread-archived", id: "p4" },
      ],
    });
    const threads = [
      thread({ id: "thread-open" }),
      thread({ id: "thread-closed", settledOverride: "settled" }),
      thread({
        id: "thread-held",
        snoozedUntil: "2026-10-29T13:00:00.000Z",
        snoozedAt: "2026-10-29T11:00:00.000Z",
      }),
      thread({ id: "thread-archived", archivedAt: "2026-10-29T11:30:00.000Z" }),
    ];
    expect(visibleGridThreads(order, threads, NOW).map((entry) => entry.id)).toEqual([
      "thread-open",
    ]);
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
    { gridId: "g-1", threadId: "running", state: "running" },
    { gridId: "g-1", threadId: "ready", state: "ready" },
    { gridId: "g-2", threadId: "needs", state: "needs" },
    { gridId: "g-2", threadId: "idle", state: "idle" },
  ];

  it("walks Ready and Needs you cards across workspaces and wraps", () => {
    expect(nextAttentionCard(cards, null, 1)?.threadId).toBe("ready");
    expect(nextAttentionCard(cards, { gridId: "g-1", threadId: "ready" }, 1)?.threadId).toBe(
      "needs",
    );
    expect(nextAttentionCard(cards, { gridId: "g-2", threadId: "needs" }, 1)?.threadId).toBe(
      "ready",
    );
  });

  it("walks backwards and starts after a card that needs nothing", () => {
    expect(nextAttentionCard(cards, null, -1)?.threadId).toBe("needs");
    expect(nextAttentionCard(cards, { gridId: "g-1", threadId: "running" }, 1)?.threadId).toBe(
      "ready",
    );
    expect(nextAttentionCard(cards, { gridId: "g-2", threadId: "idle" }, -1)?.threadId).toBe(
      "needs",
    );
  });

  it("returns null when no card needs attention", () => {
    expect(
      nextAttentionCard(
        [{ gridId: "g-1", threadId: "idle", state: "idle" }],
        null,
        1,
      ),
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
