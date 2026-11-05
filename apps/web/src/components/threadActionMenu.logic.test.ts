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
        reversed ? "unsettle" : "settle",
        reversed ? "unsnooze" : "snooze",
        "rename",
        "regenerate-title",
        "auto-settle",
        "archive",
        "delete",
      ];
      expect(items.filter((item) => item.disabled).map((item) => item.id)).toEqual(expected);
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
      "new-thread-on-branch",
      "open-in-grid",
      "move-to-grid",
      "settle",
      "snooze",
      "rename",
      "regenerate-title",
      "mark-unread",
      "filter-by-project",
      "auto-settle",
      "copy",
      "project-settings",
      "archive",
      "delete",
    ]);
    expect(
      items.find((item) => item.id === "move-to-grid")?.children?.map((item) => item.id),
    ).toEqual(["move-to-grid:grid-b", "move-to-grid:new"]);
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
    expect(items.map((item) => item.id)).toEqual(["split-right", "split-down"]);
    expect(items[0]?.children?.map((item) => item.id)).toEqual(["split:right:none"]);
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
    expect(items.map((item) => item.id).slice(0, 3)).toEqual(["split-right", "split-down", "swap"]);
    expect(items[0]?.children?.map((item) => item.id)).toEqual([
      "split:right:thread-b",
      "split:right:new",
    ]);
    expect(items[2]?.children?.map((item) => item.id)).toEqual(["swap:thread-c"]);
  });
});
