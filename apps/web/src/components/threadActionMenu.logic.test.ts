import { describe, expect, it } from "vite-plus/test";

import { buildThreadActionMenuItems, type ThreadActionMenuState } from "./threadActionMenu.logic";

const baseState: ThreadActionMenuState = {
  canOperate: true,
  branch: null,
  projectFilter: null,
  isSettled: false,
  autoSettleEnabled: true,
  isSnoozed: false,
  canSnoozeNow: true,
  isRegeneratingTitle: false,
  isRunning: false,
  tags: [],
  tagSuggestions: [],
  supports: {
    settlement: true,
    autoSettleOptOut: true,
    snooze: true,
    titleRegeneration: true,
  },
  snoozePresets: [
    { id: "hour", label: "In 1 hour", whenLabel: "3:00 PM", snoozedUntil: "2026-08-07T15:00:00Z" },
  ],
};

describe("buildThreadActionMenuItems", () => {
  it.each([false, true])(
    "disables both lifecycle directions without permission (reversed: %s)",
    (reversed) => {
      const items = buildThreadActionMenuItems({
        ...baseState,
        canOperate: false,
        isSettled: reversed,
        isSnoozed: reversed,
      });
      const expected = [
        "rename",
        reversed ? "unsettle" : "settle",
        reversed ? "unsnooze" : "snooze",
        "tags",
        "archive",
        "delete",
      ];
      expect(items.filter((item) => item.disabled).map((item) => item.id)).toEqual(expected);
      expect(
        items.find((item) => item.id === "more")?.children?.every((child) => child.disabled),
      ).toBe(true);
      expect(
        items.find((item) => item.id === "snooze")?.children?.every((child) => child.disabled) ??
          true,
      ).toBe(true);
    },
  );

  it("disables archive and turning into a project while the thread is running", () => {
    const items = buildThreadActionMenuItems({
      ...baseState,
      isRunning: true,
      canTurnIntoProject: true,
    });
    expect(items.find((item) => item.id === "archive")?.disabled).toBe(true);
    expect(items.find((item) => item.id === "turn-into-project")?.disabled).toBe(true);
  });

  it("offers each workspace tag as a toggle and keeps the editor last", () => {
    const items = buildThreadActionMenuItems({
      ...baseState,
      tags: ["private"],
      tagSuggestions: ["demo", "private"],
    });
    const tags = items.find((item) => item.id === "tags");
    expect(tags?.children?.map((item) => [item.id, item.checked])).toEqual([
      ["tag-toggle:demo", false],
      ["tag-toggle:private", true],
      ["tag-edit", undefined],
    ]);
  });

  it("never offers a pin action", () => {
    const items = buildThreadActionMenuItems({
      ...baseState,
      branch: "main",
      projectFilter: { label: "Houston", isActive: false },
      canTurnIntoProject: true,
    });
    expect(items.map((item) => item.id)).not.toContain("pin");
    expect(items.map((item) => item.id)).not.toContain("unpin");
    expect(items.map((item) => item.label)).not.toContain("Pin thread");
    expect(items.map((item) => item.label)).not.toContain("Unpin thread");
  });

  it("orders the thread actions as one menu", () => {
    const items = buildThreadActionMenuItems({
      ...baseState,
      branch: "main",
      canStartBranchThread: true,
      projectFilter: { label: "Houston", isActive: false },
      grid: {
        canOpenInGrid: true,
        canMoveToGrid: true,
        moveTargets: [{ gridId: "grid-b", name: "Review" }],
      },
    });
    expect(items.map((item) => item.id)).toEqual([
      "section:thread",
      "rename",
      "mark-unread",
      "copy",
      "section:status",
      "settle",
      "snooze",
      "section:branch-project",
      "new-thread-on-branch",
      "project-settings",
      "section:organise",
      "open-in-grid",
      "move-to-grid",
      "tags",
      "filter-by-project",
      "more",
      "archive",
      "delete",
    ]);
    expect(items.find((item) => item.id === "more")?.children?.map((item) => item.id)).toEqual([
      "regenerate-title",
      "auto-settle",
    ]);
    expect(items.filter((item) => item.header).map((item) => item.label)).toEqual([
      "Thread",
      "Status",
      "Branch & project",
      "Organise",
    ]);
    expect(
      items.find((item) => item.id === "move-to-grid")?.children?.map((item) => item.id),
    ).toEqual(["move-to-grid:grid-b", "move-to-grid:new"]);
  });

  it("keeps every action of the previous menu reachable", () => {
    const items = buildThreadActionMenuItems({
      ...baseState,
      branch: "main",
      canFind: true,
      canStartBranchThread: true,
      canTurnIntoProject: true,
      projectFilter: { label: "Houston", isActive: false },
      grid: { canOpenInGrid: true, canMoveToGrid: true, moveTargets: [] },
    });
    const ids = (list: ReadonlyArray<{ id: string; children?: ReadonlyArray<never> }>): string[] =>
      list.flatMap((item) => [item.id, ...ids((item.children ?? []) as never)]);
    expect(ids(items as never)).toEqual(
      expect.arrayContaining([
        "find",
        "new-thread-on-branch",
        "open-in-grid",
        "move-to-grid",
        "settle",
        "snooze",
        "rename",
        "regenerate-title",
        "tags",
        "mark-unread",
        "filter-by-project",
        "turn-into-project",
        "auto-settle",
        "auto-settle:enabled",
        "copy",
        "copy-path",
        "copy-branch",
        "copy-thread",
        "copy-thread-id",
        "project-settings",
        "archive",
        "delete",
      ]),
    );
  });

  it("emits no header for an empty section", () => {
    const items = buildThreadActionMenuItems({
      ...baseState,
      supports: { ...baseState.supports, settlement: false, snooze: false },
    });
    expect(items.map((item) => item.id)).not.toContain("section:status");
  });

  it("hides grid and thread actions the surface cannot perform", () => {
    const items = buildThreadActionMenuItems({
      ...baseState,
      canFind: false,
      hasThread: false,
      cell: {
        split: { availableThreads: [], atCap: false, canCreateThread: false },
        swapTargets: [],
      },
    });
    expect(items.map((item) => item.id)).toEqual(["section:layout", "split-right", "split-down"]);
    expect(items[1]?.children?.map((item) => item.id)).toEqual(["split:right:none"]);
  });

  it("offers split and swap only with cell context", () => {
    const items = buildThreadActionMenuItems({
      ...baseState,
      cell: {
        split: {
          availableThreads: [{ threadId: "thread-b", title: "Beta" }],
          atCap: false,
          canCreateThread: true,
        },
        swapTargets: [{ threadId: "thread-c", title: "Gamma" }],
      },
    });
    expect(items.map((item) => item.id).slice(0, 4)).toEqual([
      "section:layout",
      "split-right",
      "split-down",
      "swap",
    ]);
    expect(items[1]?.children?.map((item) => item.id)).toEqual([
      "split:right:thread-b",
      "split:right:new",
    ]);
    expect(items[3]?.children?.map((item) => item.id)).toEqual(["swap:thread-c"]);
  });
});
