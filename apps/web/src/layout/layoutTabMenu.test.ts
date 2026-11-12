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

  it("offers copy link only when the caller can build one", () => {
    const layout = buildLayout([[[["a"]]]]);
    expect(ids(buildLayoutTabMenuItems(layout, "a"))).not.toContain("layout:copy-link");
    expect(ids(buildLayoutTabMenuItems(layout, "a", { canCopyLink: true }))).toContain(
      "layout:copy-link",
    );
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

  it("hands copy link to the caller's copier", () => {
    useLayoutStore.getState().setLayoutFromServer(buildLayout([[[["a"]]]]));
    const copied: string[] = [];
    runLayoutTabMenuAction("layout:copy-link", "a", { copyLink: (tab) => copied.push(tab.id) });
    expect(copied).toEqual(["a"]);
  });
});
