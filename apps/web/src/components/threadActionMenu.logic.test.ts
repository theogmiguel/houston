import { describe, expect, it } from "vite-plus/test";

import {
  buildThreadActionMenuItems,
  threadActionRequiresOperate,
  type ThreadActionMenuState,
} from "./threadActionMenu.logic";

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
    });
    expect(items.map((item) => item.id)).toEqual([
      "section:thread",
      "rename",
      "mark-unread",
      "copy",
      "section:status",
      "settle",
      "snooze",
      "section:organise",
      "tags",
      "filter-by-project",
      "new-thread-on-branch",
      "project-settings",
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
      "Organise",
    ]);
  });

  it("offers Move to workspace with every other workspace and New workspace, and nothing for a thread that cannot move", () => {
    const items = buildThreadActionMenuItems({
      ...baseState,
      workspace: {
        targets: [
          { workspaceId: "w2", name: "Reviews" },
          { workspaceId: "w3", name: "Today" },
        ],
      },
    });
    const move = items.find((item) => item.id === "move-to-workspace");
    expect(move?.label).toBe("Move to workspace");
    expect(move?.children?.map((item) => [item.id, item.label])).toEqual([
      ["move-to-workspace:w2", "Reviews"],
      ["move-to-workspace:w3", "Today"],
      ["move-to-new-workspace", "New workspace"],
    ]);
    const alone = buildThreadActionMenuItems({ ...baseState, workspace: { targets: [] } });
    expect(
      alone
        .find((item) => item.id === "move-to-workspace")
        ?.children?.map((item) => [item.id, item.label]),
    ).toEqual([["move-to-new-workspace", "New workspace"]]);
    // A child thread follows its parent: the surface passes no workspace, so no item appears.
    const child = buildThreadActionMenuItems({ ...baseState, workspace: undefined });
    expect(child.some((item) => item.id === "move-to-workspace")).toBe(false);
    expect(threadActionRequiresOperate("move-to-workspace:w2")).toBe(false);
    expect(threadActionRequiresOperate("move-to-new-workspace")).toBe(false);
  });

  it("keeps every action of the previous menu reachable", () => {
    const items = buildThreadActionMenuItems({
      ...baseState,
      branch: "main",
      canFind: true,
      canStartBranchThread: true,
      canTurnIntoProject: true,
      projectFilter: { label: "Houston", isActive: false },
    });
    const ids = (list: ReadonlyArray<{ id: string; children?: ReadonlyArray<never> }>): string[] =>
      list.flatMap((item) => [item.id, ...ids((item.children ?? []) as never)]);
    expect(ids(items as never)).toEqual(
      expect.arrayContaining([
        "find",
        "new-thread-on-branch",
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

  it("hides thread actions the surface cannot perform", () => {
    const items = buildThreadActionMenuItems({
      ...baseState,
      canFind: false,
      hasThread: false,
    });
    expect(items.map((item) => item.id)).not.toContain("rename");
    expect(items.map((item) => item.id)).not.toContain("section:status");
  });
});
