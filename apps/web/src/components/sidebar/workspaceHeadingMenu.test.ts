import { describe, expect, it } from "vite-plus/test";

import { hiddenWorkspaceIdFromAction, workspaceHeadingMenuItems } from "./workspaceHeadingMenu";

const base = {
  pinned: false,
  canMoveUp: true,
  canMoveDown: true,
  readyCount: 2,
  hiddenWorkspaces: [],
};

describe("workspaceHeadingMenuItems", () => {
  it("offers every workspace action in order", () => {
    expect(workspaceHeadingMenuItems(base).map((item) => item.id)).toEqual([
      "new-thread",
      "rename",
      "toggle-pin",
      "move-up",
      "move-down",
      "hide",
      "delete",
      "close-ready",
      "new-workspace",
    ]);
  });

  it("names the pin action by the current state", () => {
    const label = (pinned: boolean) =>
      workspaceHeadingMenuItems({ ...base, pinned }).find((item) => item.id === "toggle-pin")
        ?.label;
    expect(label(false)).toBe("Pin workspace");
    expect(label(true)).toBe("Unpin workspace");
  });

  it("disables moves past either end and Close all ready with nothing ready", () => {
    const items = workspaceHeadingMenuItems({
      ...base,
      canMoveUp: false,
      canMoveDown: false,
      readyCount: 0,
    });
    const disabled = items.filter((item) => item.disabled).map((item) => item.id);
    expect(disabled).toEqual(["move-up", "move-down", "close-ready"]);
  });

  it("lists hidden workspaces as a submenu whose actions name them", () => {
    const items = workspaceHeadingMenuItems({
      ...base,
      hiddenWorkspaces: [{ id: "w9", name: "Archive" }],
    });
    const submenu = items.find((item) => item.id === "hidden-workspaces");
    expect(submenu?.children?.map((item) => [item.id, item.label])).toEqual([
      ["show-workspace:w9", "Archive"],
    ]);
    expect(hiddenWorkspaceIdFromAction("show-workspace:w9")).toBe("w9");
    expect(hiddenWorkspaceIdFromAction("rename")).toBeNull();
  });
});
