import { scopeThreadRef } from "@houston-app/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@houston-app/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import {
  isLayoutDropUseful,
  layoutDropDestination,
  layoutDropLabel,
  openThreadToTheSide,
  resolveLayoutDropTarget,
  withOpenThreadToTheSideItem,
  type LayoutDragPane,
} from "./layoutDrag";
import {
  createLayoutState,
  findLayoutTab,
  selectFocusedTab,
  type LayoutState,
  type LayoutTabContent,
} from "./layoutModel";
import { useLayoutStore } from "./layoutStore";

const strip = { left: 0, top: 0, right: 1000, bottom: 600 };
const pane = (paneId: string, left: number, right: number, companion = false): LayoutDragPane => ({
  paneId,
  rect: { left, top: 0, right, bottom: 600 },
  companion,
});
const panes = [pane("a", 0, 500), pane("b", 500, 1000, true)];

describe("resolveLayoutDropTarget", () => {
  it("extends the layout at the strip's left, right and bottom edges", () => {
    expect(resolveLayoutDropTarget({ x: 3, y: 300 }, panes, strip)).toEqual({
      kind: "extend",
      edge: "left",
    });
    expect(resolveLayoutDropTarget({ x: 997, y: 300 }, panes, strip)).toEqual({
      kind: "extend",
      edge: "right",
    });
    expect(resolveLayoutDropTarget({ x: 300, y: 597 }, panes, strip)).toEqual({
      kind: "extend",
      edge: "bottom",
    });
  });

  it("still counts an edge just outside the strip, toward the sidebar gutter", () => {
    expect(resolveLayoutDropTarget({ x: -10, y: 300 }, panes, strip)).toEqual({
      kind: "extend",
      edge: "left",
    });
  });

  it("adds a tab when dropped on a pane's chrome row, but not on a companion pane's", () => {
    expect(resolveLayoutDropTarget({ x: 250, y: 20 }, panes, strip)).toEqual({
      kind: "into",
      paneId: "a",
    });
    expect(resolveLayoutDropTarget({ x: 750, y: 20 }, panes, strip)).toBeNull();
  });

  it.each([
    { point: { x: 60, y: 300 }, side: "left" },
    { point: { x: 440, y: 300 }, side: "right" },
    { point: { x: 250, y: 70 }, side: "up" },
    { point: { x: 250, y: 560 }, side: "down" },
  ])("splits the nearest side of a pane body: $side", ({ point, side }) => {
    expect(resolveLayoutDropTarget(point, panes, strip)).toEqual({
      kind: "side",
      paneId: "a",
      side,
    });
  });

  it("returns nothing outside every pane", () => {
    expect(resolveLayoutDropTarget({ x: 250, y: 300 }, [], strip)).toBeNull();
  });

  it("takes the chrome height from the caller for the settings editor's canvas", () => {
    expect(resolveLayoutDropTarget({ x: 250, y: 20 }, panes, strip, 0)).toMatchObject({
      kind: "side",
    });
  });
});

describe("layoutDropLabel", () => {
  it("names each target", () => {
    expect(layoutDropLabel({ kind: "into", paneId: "a" })).toBe("Add as tab");
    expect(layoutDropLabel({ kind: "extend", edge: "bottom" })).toBe("New workspace");
    expect(layoutDropLabel({ kind: "extend", edge: "left" })).toBe("New column");
    expect(layoutDropLabel({ kind: "side", paneId: "a", side: "left" })).toBe("Side by side");
    expect(layoutDropLabel({ kind: "side", paneId: "a", side: "up" })).toBe("Above");
    expect(layoutDropLabel({ kind: "side", paneId: "a", side: "down" })).toBe("Below");
  });
});

const environmentId = EnvironmentId.make("local");
const ref = (id: string) => scopeThreadRef(environmentId, ThreadId.make(id));
const chat = (id: string): LayoutTabContent => ({
  kind: "chat",
  target: { kind: "server", threadRef: ref(id) },
});

let original: LayoutState;
beforeEach(() => {
  original = useLayoutStore.getState().layout;
  useLayoutStore.setState({ layout: createLayoutState() });
});
afterEach(() => useLayoutStore.setState({ layout: original }));

const open = (content: LayoutTabContent, placement: "active-pane" | "new-column") =>
  useLayoutStore.getState().openTab(content, { placement, position: "end" });
const layout = () => useLayoutStore.getState().layout;
const tabOf = (content: LayoutTabContent) =>
  findLayoutTab(layout(), (tab) => JSON.stringify(tab.content) === JSON.stringify(content))!;

describe("layoutDropDestination", () => {
  it("maps a side to an exact split and an edge to a column index", () => {
    open(chat("one"), "active-pane");
    const first = tabOf(chat("one")).pane.id;
    expect(layoutDropDestination(layout(), { kind: "side", paneId: first, side: "left" })).toEqual({
      kind: "split",
      paneId: first,
      side: "left",
      exact: true,
    });
    expect(layoutDropDestination(layout(), { kind: "into", paneId: first, index: 1 })).toEqual({
      kind: "pane",
      paneId: first,
      index: 1,
    });
    const workspaceId = layout().focusedWorkspaceId;
    expect(layoutDropDestination(layout(), { kind: "extend", edge: "left" })).toEqual({
      kind: "column",
      workspaceId,
      index: 0,
    });
    expect(layoutDropDestination(layout(), { kind: "extend", edge: "right" })).toEqual({
      kind: "column",
      workspaceId,
      index: 1,
    });
  });

  it("starts a workspace in the empty one below, and has none below the last", () => {
    open(chat("one"), "active-pane");
    const trailing = layout().workspaces.at(-1)!;
    expect(trailing.id).not.toBe(layout().focusedWorkspaceId);
    expect(layoutDropDestination(layout(), { kind: "extend", edge: "bottom" })).toEqual({
      kind: "column",
      workspaceId: trailing.id,
      index: 0,
    });
    useLayoutStore.getState().focusWorkspace(trailing.id);
    expect(layoutDropDestination(layout(), { kind: "extend", edge: "bottom" })).toBeNull();
  });
});

describe("isLayoutDropUseful", () => {
  it("rejects a drop that would leave the layout as it is", () => {
    open(chat("one"), "active-pane");
    open(chat("two"), "new-column");
    const one = tabOf(chat("one"));
    const source = { kind: "tab", tabId: one.tab.id } as const;
    expect(isLayoutDropUseful(layout(), source, { kind: "into", paneId: one.pane.id })).toBe(false);
    expect(
      isLayoutDropUseful(layout(), source, { kind: "side", paneId: one.pane.id, side: "left" }),
    ).toBe(false);
    expect(isLayoutDropUseful(layout(), source, { kind: "extend", edge: "left" })).toBe(false);
    expect(isLayoutDropUseful(layout(), source, { kind: "extend", edge: "right" })).toBe(true);
    expect(
      isLayoutDropUseful(layout(), source, {
        kind: "into",
        paneId: tabOf(chat("two")).pane.id,
      }),
    ).toBe(true);
  });

  it("accepts a dragged thread anywhere a destination exists", () => {
    open(chat("one"), "active-pane");
    const paneId = tabOf(chat("one")).pane.id;
    expect(
      isLayoutDropUseful(
        layout(),
        { kind: "thread", threadRef: ref("x") },
        { kind: "into", paneId },
      ),
    ).toBe(true);
  });

  it("rejects a tab the layout no longer holds", () => {
    expect(
      isLayoutDropUseful(
        layout(),
        { kind: "tab", tabId: "gone" },
        { kind: "extend", edge: "right" },
      ),
    ).toBe(false);
  });
});

describe("open to the side", () => {
  it("offers the row action only when another chat has focus", () => {
    open(chat("one"), "active-pane");
    expect(withOpenThreadToTheSideItem(ref("one"), [{ id: "x", label: "X" }])).toEqual([
      { id: "x", label: "X" },
    ]);
    const items = withOpenThreadToTheSideItem(ref("two"), [{ id: "x", label: "X" }]);
    expect(items[0]).toMatchObject({ id: "open-to-the-side", label: "Open to the side" });
    expect(items[1]).toMatchObject({ id: "x", separatorBefore: true });
  });

  it("opens the thread beside the focused chat's pane", () => {
    open(chat("one"), "active-pane");
    const first = tabOf(chat("one"));
    openThreadToTheSide(ref("two"));
    const second = tabOf(chat("two"));
    expect(second.pane.id).not.toBe(first.pane.id);
    expect(layout().workspaces.flatMap((workspace) => workspace.columns)).toHaveLength(2);
    expect(selectFocusedTab(layout())?.id).toBe(second.tab.id);
  });

  it("does nothing for the thread already in focus", () => {
    open(chat("one"), "active-pane");
    const before = layout();
    openThreadToTheSide(ref("one"));
    expect(layout()).toBe(before);
  });
});
