import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { buildLayout } from "./layoutFixtures";
import { buildLayoutTabMenuItems, runLayoutTabMenuAction } from "./layoutTabMenu";
import { useLayoutStore } from "./layoutStore";
import { findLayoutTab } from "./layoutModel";

const ids = (items: readonly { id: string }[]) => items.map((item) => item.id);

beforeEach(() => useLayoutStore.getState().reset());
afterEach(() => useLayoutStore.getState().reset());

describe("buildLayoutTabMenuItems", () => {
  it("offers split and close for the only tab, and nothing that would do nothing", () => {
    const layout = buildLayout([[[["a"]]]]);
    expect(ids(buildLayoutTabMenuItems(layout, "a"))).toEqual([
      "layout:split-right",
      "layout:split-down",
      "layout:close-tab",
    ]);
  });

  it("adds a new column, close others and fill when the pane has siblings and there are several panes", () => {
    const layout = buildLayout([[[["a", "b"]], [["c"]]]]);
    expect(ids(buildLayoutTabMenuItems(layout, "a"))).toEqual([
      "layout:split-right",
      "layout:split-down",
      "layout:new-column",
      "layout:new-workspace",
      "layout:fill",
      "layout:close-tab",
      "layout:close-other-tabs",
    ]);
  });

  it("labels fill as showing every pane while the tab is maximized", () => {
    const layout = buildLayout([[[["a"]], [["b"]]]]);
    const fill = buildLayoutTabMenuItems(layout, "a", { maximizedTabId: "a" }).find(
      (item) => item.id === "layout:fill",
    );
    expect(fill?.label).toBe("Show every pane");
  });

  it("offers keeping a ghost tab", () => {
    const layout = buildLayout([[[["a"]]]]);
    layout.workspaces[0]!.columns[0]!.panes[0]!.tabs[0]!.ghostOf = null;
    expect(ids(buildLayoutTabMenuItems(layout, "a"))[0]).toBe("layout:keep");
  });

  it("offers a chat's find and project settings before copy link, which a pane without a header row has no other row for", () => {
    const layout = buildLayout([[[["a"]]]]);
    expect(
      ids(
        buildLayoutTabMenuItems(layout, "a", {
          canCopyLink: true,
          canFindInThread: true,
          canOpenProjectSettings: true,
        }),
      ),
    ).toEqual([
      "layout:split-right",
      "layout:split-down",
      "layout:find-in-thread",
      "layout:project-settings",
      "layout:copy-link",
      "layout:close-tab",
    ]);
  });

  it("runs a chat's find and project settings through the caller's handlers", () => {
    const layout = buildLayout([[[["a"]]]]);
    useLayoutStore.getState().setLayoutFromServer(layout);
    const calls: string[] = [];
    const handlers = {
      findInThread: () => calls.push("find"),
      openProjectSettings: () => calls.push("settings"),
    };
    runLayoutTabMenuAction("layout:find-in-thread", "a", handlers);
    runLayoutTabMenuAction("layout:project-settings", "a", handlers);
    expect(calls).toEqual(["find", "settings"]);
  });

  it("offers copy link only when the caller can build one", () => {
    const layout = buildLayout([[[["a"]]]]);
    expect(ids(buildLayoutTabMenuItems(layout, "a"))).not.toContain("layout:copy-link");
    expect(ids(buildLayoutTabMenuItems(layout, "a", { canCopyLink: true }))).toContain(
      "layout:copy-link",
    );
  });

  it("offers Move to workspace with the other workspaces and a new one, only when the caller has targets", () => {
    const layout = buildLayout([[[["a"]]]]);
    expect(ids(buildLayoutTabMenuItems(layout, "a"))).not.toContain("layout:move-to-workspace");
    const item = buildLayoutTabMenuItems(layout, "a", {
      moveToWorkspaceTargets: [{ workspaceId: "w2", name: "Docs" }],
    }).find((entry) => entry.id === "layout:move-to-workspace");
    expect(item?.label).toBe("Move to workspace");
    expect(ids(item?.children ?? [])).toEqual([
      "layout:move-to-workspace:w2",
      "layout:move-to-new-workspace",
    ]);
  });

  it("is empty for a tab that is not in the layout", () => {
    expect(buildLayoutTabMenuItems(buildLayout([[[["a"]]]]), "missing")).toEqual([]);
  });
});

describe("runLayoutTabMenuAction", () => {
  it("moves the tab to a new column to the right of its own", () => {
    useLayoutStore.getState().setLayoutFromServer(buildLayout([[[["a", "b"]], [["c"]]]]));
    runLayoutTabMenuAction("layout:new-column", "a");
    const { layout } = useLayoutStore.getState();
    expect(
      layout.workspaces[0]!.columns.map((column) =>
        column.panes.flatMap((p) => p.tabs.map((t) => t.id)),
      ),
    ).toEqual([["b"], ["a"], ["c"]]);
  });

  it("closes the other tabs of the pane and focuses the kept one", () => {
    useLayoutStore.getState().setLayoutFromServer(buildLayout([[[["a", "b", "c"]]]]));
    runLayoutTabMenuAction("layout:close-other-tabs", "b");
    const { layout } = useLayoutStore.getState();
    expect(findLayoutTab(layout, (tab) => tab.id === "a")).toBeNull();
    expect(findLayoutTab(layout, (tab) => tab.id === "b")).not.toBeNull();
  });

  it("hands a workspace choice and a new workspace to the caller's mover", () => {
    useLayoutStore.getState().setLayoutFromServer(buildLayout([[[["a"]]]]));
    const moved: string[] = [];
    const handlers = {
      moveToWorkspace: (tab: { id: string }, target: string) => moved.push(`${tab.id}>${target}`),
    };
    runLayoutTabMenuAction("layout:move-to-workspace:w2", "a", handlers);
    runLayoutTabMenuAction("layout:move-to-new-workspace", "a", handlers);
    expect(moved).toEqual(["a>w2", "a>new-workspace"]);
  });

  it("hands copy link to the caller's copier", () => {
    useLayoutStore.getState().setLayoutFromServer(buildLayout([[[["a"]]]]));
    const copied: string[] = [];
    runLayoutTabMenuAction("layout:copy-link", "a", { copyLink: (tab) => copied.push(tab.id) });
    expect(copied).toEqual(["a"]);
  });
});
