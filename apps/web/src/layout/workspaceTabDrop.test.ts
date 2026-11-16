import { afterEach, describe, expect, it } from "vite-plus/test";

import { buildLayout } from "./layoutFixtures";
import { findLayoutTab, setEmptyWorkspaceRetention } from "./layoutModel";
import { useLayoutStore } from "./layoutStore";
import { moveTabToWorkspaceDrop } from "./workspaceTabDrop";

afterEach(() => {
  setEmptyWorkspaceRetention(() => false);
  useLayoutStore.getState().reset();
});

function seed(shape: string[][][][]) {
  useLayoutStore.getState().reset();
  useLayoutStore.getState().setLayoutFromServer(buildLayout(shape));
}

const where = (tabId: string) =>
  findLayoutTab(useLayoutStore.getState().layout, (tab) => tab.id === tabId);

describe("moveTabToWorkspaceDrop", () => {
  it("case 20: moves a tab into the target workspace's focused pane and leaves the visible workspace visible", () => {
    seed([[[["a", "b"]]], [[["c"]]]]);
    moveTabToWorkspaceDrop("a", "w1");
    const moved = where("a");
    expect(moved?.workspace.id).toBe("w1");
    expect(moved?.pane.id).toBe("w1c0p0");
    expect(useLayoutStore.getState().layout.focusedWorkspaceId).toBe("w0");
  });

  it("case 12: moves one tab and leaves the thread's other tab where it was", () => {
    seed([[[["a", "a2"]]], [[["c"]]]]);
    moveTabToWorkspaceDrop("a", "w1");
    expect(where("a")?.workspace.id).toBe("w1");
    expect(where("a2")?.workspace.id).toBe("w0");
  });

  it("case 9 and 20: a tab dropped on the new-workspace zone gets a workspace of its own", () => {
    seed([[[["a", "b"]]]]);
    moveTabToWorkspaceDrop("a", "new-workspace");
    const layout = useLayoutStore.getState().layout;
    const moved = where("a");
    expect(moved?.workspace.id).not.toBe("w0");
    expect(layout.workspaces.some((workspace) => workspace.id === "w0")).toBe(true);
  });

  it("case 11: the last tab leaving a workspace that holds threads leaves the workspace in place", () => {
    seed([[[["a"]]], [[["c"]]]]);
    setEmptyWorkspaceRetention((workspaceId) => workspaceId === "w0");
    moveTabToWorkspaceDrop("a", "w1");
    const layout = useLayoutStore.getState().layout;
    expect(layout.workspaces.map((workspace) => workspace.id)).toContain("w0");
    expect(where("a")?.workspace.id).toBe("w1");
  });

  it("names the missing workspace and the layout's size when the target is gone", () => {
    seed([[[["a"]]]]);
    expect(() => moveTabToWorkspaceDrop("a", "w9")).toThrow(/'w9'.*1 workspaces/);
    expect(where("a")?.workspace.id).toBe("w0");
  });
});
