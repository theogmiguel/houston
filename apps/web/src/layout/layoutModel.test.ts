import { scopeThreadRef } from "@houston-app/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@houston-app/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  closeLayoutTab,
  createLayoutState,
  evenLayoutColumnEdge,
  focusLayoutTab,
  layoutChatSwaps,
  moveLayoutTab,
  moveLayoutTabToWorkspace,
  openLayoutGhostChat,
  openLayoutKeptTab,
  openLayoutTab,
  placeLayoutContent,
  placeLayoutTabs,
  replaceLayoutTabContent,
  fitLayoutColumns,
  resizeLayoutColumnEdge,
  selectFocusedChatTarget,
  selectFocusedTab,
  selectFocusedWorkspace,
  selectLayoutPaneSlots,
  showLayoutContent,
  type LayoutState,
  type LayoutTab,
  type LayoutTabContent,
  type LayoutTabPlacement,
} from "./layoutModel";
import type { DraftId } from "../composerDraftStore";
import type { ThreadRouteTarget } from "../threadRoutes";
import type { LayoutWhenNoRoom } from "./layoutBehavior";

const environmentId = EnvironmentId.make("local");
const threadRef = scopeThreadRef(environmentId, ThreadId.make("thread"));
const chat: LayoutTabContent = { kind: "chat", target: { kind: "server", threadRef } };
const diff: LayoutTabContent = { kind: "surface", threadRef, surfaceId: "diff" };
const next: LayoutTabContent = {
  kind: "chat",
  target: { kind: "server", threadRef: scopeThreadRef(environmentId, ThreadId.make("next")) },
};

const columnsOf = (state: LayoutState) =>
  state.workspaces[0]!.columns.map((column) =>
    column.panes.flatMap((pane) => pane.tabs.map((tab) => tab.content)),
  );

/*
 * Layouts as text: workspaces of columns of panes of tabs. `A` is a kept chat of thread A, `~A`
 * its ghost, `t:A` A's terminal, `+` a launcher, `PR` the pull requests page; `*` marks a pane's
 * active tab and `!` the focused one.
 */
type Shape = string[][][];

const refOf = (name: string) => scopeThreadRef(environmentId, ThreadId.make(name));
const chatOf = (name: string): LayoutTabContent => ({
  kind: "chat",
  target: { kind: "server", threadRef: refOf(name) },
});
const draftOf = (name: string): LayoutTabContent => ({
  kind: "chat",
  target: { kind: "draft", draftId: name as DraftId },
});

function tabOf(label: string): LayoutTab {
  const name = label.replace(/^~/, "");
  const content: LayoutTabContent =
    name === "+"
      ? { kind: "launcher", id: "launcher", context: null }
      : name === "PR"
        ? { kind: "pull-requests" }
        : name.startsWith("t:")
          ? { kind: "surface", threadRef: refOf(name.slice(2)), surfaceId: "thread-terminal" }
          : chatOf(name);
  return { id: name, content, ...(label.startsWith("~") ? { ghostOf: null } : {}) };
}

function layoutOf(...shapes: Shape[]): LayoutState {
  const paneId = (w: number, c: number, p: number) => `w${w}c${c}p${p}`;
  const focus = shapes
    .flatMap((columns, w) =>
      columns.flatMap((panes, c) =>
        panes.flatMap((labels, p) =>
          labels.some((label) => label.includes("!")) ? [{ w, pane: paneId(w, c, p) }] : [],
        ),
      ),
    )
    .at(0);
  const workspaces = shapes.map((columns, w) => ({
    id: `w${w}`,
    name: null,
    cameraWidth: null,
    focusedPaneId: focus?.w === w ? focus.pane : null,
    columns: columns.map((panes, c) => ({
      id: `w${w}c${c}`,
      width: 1,
      panes: panes.map((labels, p) => {
        const tabs = labels.map((label) => tabOf(label.replace(/[*!]/g, "")));
        const active = Math.max(
          labels.findIndex((label) => /[*!]/.test(label)),
          0,
        );
        return { id: paneId(w, c, p), size: 1 / panes.length, tabs, activeTabId: tabs[active]!.id };
      }),
    })),
  }));
  return { workspaces, focusedWorkspaceId: `w${focus?.w ?? 0}` };
}

function shapeOf(state: LayoutState): Shape[] {
  const focused = selectFocusedTab(state);
  return state.workspaces
    .filter((workspace) => workspace.columns.length > 0)
    .map((workspace) =>
      workspace.columns.map((column) =>
        column.panes.map((pane) =>
          pane.tabs.map((tab) => {
            const content = tab.content;
            const name =
              content.kind === "launcher"
                ? "+"
                : content.kind === "pull-requests"
                  ? "PR"
                  : content.kind === "surface"
                    ? `t:${content.threadRef.threadId}`
                    : content.kind === "chat"
                      ? content.target.kind === "server"
                        ? content.target.threadRef.threadId
                        : `draft:${content.target.draftId}`
                      : content.kind;
            const mark =
              tab.id === focused?.id && workspace.id === state.focusedWorkspaceId
                ? "!"
                : tab.id === pane.activeTabId && pane.tabs.length > 1
                  ? "*"
                  : "";
            return `${tab.ghostOf !== undefined ? "~" : ""}${name}${mark}`;
          }),
        ),
      ),
    );
}

const column = (id: string, width: number) => ({
  id,
  width,
  panes: [{ id: `${id}-pane`, tabs: [], activeTabId: null, size: 1 }],
});

function drawnRightEdges(
  state: LayoutState,
  viewportWidth: number,
  whenNoRoom: LayoutWhenNoRoom = "shrink-then-scroll",
): number[] {
  const { slots, stripWidth } = selectLayoutPaneSlots(state.workspaces[0]!, {
    width: viewportWidth,
    whenNoRoom,
  });
  return slots.map((slot) =>
    Math.round((slot.rect.left + slot.rect.width) * stripWidth * viewportWidth),
  );
}

function chatFor(id: string): LayoutTabContent {
  return {
    kind: "chat",
    target: { kind: "server", threadRef: scopeThreadRef(environmentId, ThreadId.make(id)) },
  };
}

function tabContents(state: LayoutState) {
  return state.workspaces.map((workspace) =>
    workspace.columns
      .flatMap((column) => column.panes)
      .flatMap((pane) => pane.tabs.map((tab) => tab.content)),
  );
}

describe("showLayoutContent", () => {
  it("opens a thread in place of the ghost chat whose side panel has focus, not in the panel", () => {
    const withPanel = openLayoutTab(showLayoutContent(createLayoutState(), chat), diff, {
      placement: "new-column",
    });
    expect(selectFocusedTab(withPanel)?.content).toBe(diff);

    const shown = showLayoutContent(withPanel, next);

    expect(columnsOf(shown)).toEqual([[next], [diff]]);
    expect(selectFocusedTab(shown)?.content).toBe(next);
  });

  // A sidebar click on D, per the open rules: a ghost or launcher is replaced in place, a kept
  // tab never is, and a thread already open is focused where it is.
  it.each<{ case: string; layout: Shape[]; expected: Shape[] }>([
    {
      case: "(a) the first open in an empty window is the ghost",
      layout: [],
      expected: [[[["~D!"]]]],
    },
    {
      case: "(a) one pane, its ghost is replaced in place",
      layout: [[[["~A!"]]]],
      expected: [[[["~D!"]]]],
    },
    {
      case: "(a) one pane, a kept tab gets the ghost after it",
      layout: [[[["A!"]]]],
      expected: [[[["A", "~D!"]]]],
    },
    {
      case: "(a) a launcher is replaced in place by the ghost",
      layout: [[[["A", "+!"]]]],
      expected: [[[["A", "~D!"]]]],
    },
    {
      case: "(a) a launcher replaces the pane's previous ghost, keeping its other tabs",
      layout: [[[["~A", "B", "+!", "C"]]]],
      expected: [[[["B", "~D!", "C"]]]],
    },
    {
      case: "(b) several tabs, the focused ghost is replaced in its slot",
      layout: [[[["A", "~B!", "C"]]]],
      expected: [[[["A", "~D!", "C"]]]],
    },
    {
      case: "(b) a focused kept tab keeps its place; the pane's one ghost moves after it",
      layout: [[[["A", "~B", "C!"]]]],
      expected: [[[["A", "C", "~D!"]]]],
    },
    {
      case: "(b) a page tab is kept",
      layout: [[[["PR!"]]]],
      expected: [[[["PR", "~D!"]]]],
    },
    {
      case: "(c) split, focus left: only the left pane changes",
      layout: [[[["A!"]], [["~B"]]]],
      expected: [[[["A", "~D!"]], [["~B"]]]],
    },
    {
      case: "(c) split, focus right: only the right pane changes",
      layout: [[[["A"]], [["~B!"]]]],
      expected: [[[["A"]], [["~D!"]]]],
    },
    {
      case: "(d) already open in the other pane: focus moves there",
      layout: [[[["A!"]], [["D"]]]],
      expected: [[[["A"]], [["D!"]]]],
    },
    {
      case: "(d) already open in a background tab: it becomes active",
      layout: [[[["A!", "D"]]]],
      expected: [[[["A", "D!"]]]],
    },
    {
      case: "(d) already open in another workspace: that workspace takes focus",
      layout: [[[["A!"]]], [[["D*"]]]],
      expected: [[[["A"]]], [[["D!"]]]],
    },
    {
      case: "(e) a focused terminal hands the open to its thread's ghost chat",
      layout: [[[["~A"], ["t:A!"]]]],
      expected: [[[["~D!"], ["t:A"]]]],
    },
    {
      case: "(e) a focused terminal whose thread's chat is kept: the ghost opens after that chat",
      layout: [[[["A"], ["t:A!"]]]],
      expected: [[[["A", "~D!"], ["t:A"]]]],
    },
    {
      case: "(e) a terminal with no chat of its thread is never replaced",
      layout: [[[["B"]], [["t:A!"]]]],
      expected: [[[["B"]], [["t:A", "~D!"]]]],
    },
  ])("$case", ({ layout, expected }) => {
    const state = layout.length === 0 ? createLayoutState() : layoutOf(...layout);
    expect(shapeOf(showLayoutContent(state, chatOf("D")))).toEqual(expected);
  });
});

describe("openLayoutKeptTab", () => {
  // (f) middle click: a kept tab after the open's target, or the open one kept.
  it.each<{ case: string; layout: Shape[]; expected: Shape[] }>([
    {
      case: "a kept tab after the focused tab, the pane's ghost left alone",
      layout: [[[["~A", "B!"]]]],
      expected: [[[["~A", "B", "D!"]]]],
    },
    {
      case: "a kept tab after a focused ghost, never replacing it",
      layout: [[[["~A!"]]]],
      expected: [[[["~A", "D!"]]]],
    },
    {
      case: "a ghost already showing the thread is kept",
      layout: [[[["A!", "~D"]]]],
      expected: [[[["A", "D!"]]]],
    },
  ])("$case", ({ layout, expected }) => {
    expect(shapeOf(openLayoutKeptTab(layoutOf(...layout), chatOf("D")))).toEqual(expected);
  });
});

describe("placeLayoutContent", () => {
  it("places exact side splits before companions while commands keep their grouping", () => {
    const before = openLayoutTab(showLayoutContent(createLayoutState(), chat), diff, {
      placement: "new-column",
    });
    const paneId = before.workspaces[0]!.columns[0]!.panes[0]!.id;
    const withNext = openLayoutTab(before, next, { placement: "new-column" });
    const tabId = selectFocusedTab(withNext)!.id;
    for (const exact of [false, true]) {
      const destination = { kind: "split", paneId, side: "right", exact } as const;
      const expected = exact ? [[chat], [next], [diff]] : [[chat], [diff], [next]];
      const placed = placeLayoutContent(before, next, destination);
      const moved = moveLayoutTab(withNext, tabId, destination);
      expect(columnsOf(placed)).toEqual(expected);
      expect(columnsOf(moved)).toEqual(expected);
      expect(selectFocusedTab(placed)?.content).toBe(next);
      expect(selectFocusedTab(moved)?.content).toBe(next);
    }
  });
});

describe("placeLayoutTabs", () => {
  // An app's open (focus: false) leaves the user where they are, an empty workspace included.
  const focusOn = (state: LayoutState, workspaceId: string) => ({
    ...state,
    focusedWorkspaceId: workspaceId,
  });
  it.each<{ case: string; layout: LayoutState; placement: LayoutTabPlacement; expected: Shape[] }>([
    {
      case: "into another workspace from an empty middle one",
      layout: focusOn(layoutOf([[["A"]]], [], [[["C"]]], []), "w1"),
      placement: { kind: "after", tabId: "C" },
      expected: [[[["A"]]], [[["C*", "X"]]]],
    },
    {
      case: "into another workspace from the empty last one",
      layout: focusOn(layoutOf([[["A"]]], [[["C"]]], []), "w2"),
      placement: { kind: "after", tabId: "C" },
      expected: [[[["A"]]], [[["C*", "X"]]]],
    },
    {
      case: "into a new workspace from an empty middle one",
      layout: focusOn(layoutOf([[["A"]]], [], [[["C"]]], []), "w1"),
      placement: { kind: "column", workspaceId: "w3", index: 0 },
      expected: [[[["A"]]], [[["C"]]], [[["X"]]]],
    },
    {
      case: "an exact side split from an empty workspace preserves focus",
      layout: focusOn(layoutOf([[["A"]], [["t:A"]]], []), "w1"),
      placement: { kind: "split", paneId: "w0c0p0", side: "right", exact: true },
      expected: [[[["A"]], [["X"]], [["t:A"]]]],
    },
    {
      case: "into the focused workspace",
      layout: layoutOf([[["A!"]], [["B"]]], []),
      placement: { kind: "after", tabId: "B" },
      expected: [[[["A!"]], [["B*", "X"]]]],
    },
  ])("$case", ({ layout, placement, expected }) => {
    const placed = placeLayoutTabs(layout, [tabOf("X")], placement, {
      activate: null,
      focus: false,
    });
    expect(shapeOf(placed)).toEqual(expected);
    expect(placed.focusedWorkspaceId).toBe(layout.focusedWorkspaceId);
  });
});

describe("closeLayoutTab", () => {
  it.each<{ case: string; content: LayoutTabContent }>([
    { case: "a chat", content: chatOf("A") },
    { case: "a draft", content: draftOf("d") },
    { case: "a surface", content: { kind: "surface", threadRef: refOf("A"), surfaceId: "diff" } },
  ])("gives the window's last $case tab a launcher without its context", ({ content }) => {
    const state = openLayoutTab(createLayoutState(), content);
    const closed = closeLayoutTab(state, selectFocusedTab(state)!.id);
    expect(columnsOf(closed)).toEqual([
      [{ kind: "launcher", id: expect.any(String), context: null }],
    ]);
  });
});

describe("ghost tabs", () => {
  it("stay ghosts when a sent first message promotes their draft", () => {
    const state = showLayoutContent(createLayoutState(), draftOf("draft"));
    const promoted = replaceLayoutTabContent(state, selectFocusedTab(state)!.id, chatOf("D"));
    expect(shapeOf(promoted)).toEqual([[[["~D!"]]]]);
  });

  it("keep a plain ghost parent when its lineage child opens beside it", () => {
    const opened = openLayoutGhostChat(layoutOf([[["~A!"]]]), refOf("A"), {
      kind: "server",
      threadRef: refOf("child"),
    });
    expect(opened && shapeOf(opened)).toEqual([[[["A", "~child!"]]]]);
  });
});

describe("layoutChatSwaps", () => {
  // Companions follow the chat: the thread swapped off a pane hides its terminal and side panes.
  it.each<{ case: string; before: Shape[]; after: Shape[]; swaps: string[] }>([
    {
      case: "a ghost replaced in place",
      before: [[[["~A!"]]]],
      after: [[[["~D!"]]]],
      swaps: ["A>D"],
    },
    {
      case: "a kept chat with a ghost opened after it",
      before: [[[["A!"]]]],
      after: [[[["A", "~D!"]]]],
      swaps: ["A>D"],
    },
    {
      case: "focus moving to a thread open in the other pane",
      before: [[[["A!"]], [["D"]]]],
      after: [[[["A"]], [["D!"]]]],
      swaps: [],
    },
    {
      case: "a ghost opening beside a terminal with no chat",
      before: [[[["t:A!"]]]],
      after: [[[["t:A", "~D!"]]]],
      swaps: [],
    },
  ])("$case", ({ before, after, swaps }) => {
    const name = (target: ThreadRouteTarget) =>
      target.kind === "server" ? target.threadRef.threadId : target.kind;
    expect(
      layoutChatSwaps(layoutOf(...before), layoutOf(...after)).map(
        ({ from, to }) => `${name(from)}>${name(to)}`,
      ),
    ).toEqual(swaps);
  });
});

describe("placeLayoutTabs", () => {
  it("gives an empty workspace a focused pane when a surface arrives in the background", () => {
    const before = createLayoutState();
    const tab: LayoutTab = { id: "diff", content: diff };
    const after = placeLayoutTabs(
      before,
      [tab],
      { kind: "column", workspaceId: before.focusedWorkspaceId, index: 0 },
      { activate: null, focus: false },
    );
    expect(selectFocusedTab(after)).toBe(tab);
  });

  it("keeps the current chat focused when a surface arrives in the background", () => {
    const before = layoutOf([[["A!"]]]);
    const after = placeLayoutTabs(
      before,
      [{ id: "diff", content: diff }],
      { kind: "column", workspaceId: before.focusedWorkspaceId, index: 1 },
      { activate: null, focus: false },
    );
    expect(selectFocusedTab(after)).toBe(selectFocusedTab(before));
  });
});

describe("replaceLayoutTabContent", () => {
  it("leaves an open thread alone when the tab to replace has already closed", () => {
    const before = openLayoutTab(createLayoutState(), chat);
    expect(replaceLayoutTabContent(before, "closed-tab", chat)).toBe(before);
  });
});

describe("resizeLayoutColumnEdge", () => {
  it("keeps the dragged edge under the pointer when the strip was arranged wider than the window", () => {
    const viewportWidth = 1000;
    const base: LayoutState = {
      focusedWorkspaceId: "workspace",
      workspaces: [
        {
          id: "workspace",
          name: null,
          focusedPaneId: null,
          cameraWidth: 1200,
          columns: [column("chat", 0.5), column("terminal", 0.55)],
        },
      ],
    };
    const { unitWidth } = selectLayoutPaneSlots(base.workspaces[0]!, {
      width: viewportWidth,
      whenNoRoom: "shrink-then-scroll",
    });
    expect(drawnRightEdges(base, viewportWidth)).toEqual([600, 1260]);

    const pointers = Array.from({ length: 41 }, (_, index) => 300 + index * 10);
    const drawn = pointers.map((pointer) =>
      drawnRightEdges(
        resizeLayoutColumnEdge(
          base,
          "chat",
          pointer / viewportWidth,
          "shrink-then-scroll",
          viewportWidth,
          unitWidth,
        ),
        viewportWidth,
      ),
    );
    // Below 340 the pair no longer reaches the window's edge, so the terminal takes the rest.
    expect(drawn).toEqual(pointers.map((pointer) => [pointer, Math.max(pointer + 660, 1000)]));
  });

  const fitted = (...columns: ReturnType<typeof column>[]): LayoutState => ({
    focusedWorkspaceId: "workspace",
    workspaces: [{ id: "workspace", name: null, focusedPaneId: null, cameraWidth: 1000, columns }],
  });

  it("gives the next column the room a narrowed column leaves, so the strip still fills the window", () => {
    const base = fitted(column("chat", 0.5), column("diff", 0.25), column("terminal", 0.25));
    const narrowed = resizeLayoutColumnEdge(base, "chat", 0.3, "shrink-then-scroll", 1000);
    expect(drawnRightEdges(narrowed, 1000)).toEqual([300, 750, 1000]);
  });

  it("keeps the last column against the window's edge when it is the one narrowed", () => {
    const base = fitted(column("chat", 0.5), column("terminal", 0.5));
    const narrowed = resizeLayoutColumnEdge(base, "terminal", 0.3, "shrink-then-scroll", 1000);
    expect(drawnRightEdges(narrowed, 1000)).toEqual([500, 1000]);
  });

  it("fills only the room this drag left when the strip was already short", () => {
    const base = fitted(column("chat", 0.4), column("terminal", 0.4));
    const narrowed = resizeLayoutColumnEdge(base, "chat", 0.3, "shrink-then-scroll", 1000);
    expect(drawnRightEdges(narrowed, 1000)).toEqual([300, 800]);
  });

  it("leaves the gap when columns always scroll", () => {
    const base = fitted(column("chat", 0.5), column("terminal", 0.5));
    const narrowed = resizeLayoutColumnEdge(base, "chat", 0.3, "always-scroll", 1000);
    expect(drawnRightEdges(narrowed, 1000, "always-scroll")).toEqual([300, 800]);
  });

  it("lands the dragged edge where it is released when columns always shrink to fit", () => {
    const viewportWidth = 1000;
    const base: LayoutState = {
      focusedWorkspaceId: "workspace",
      workspaces: [
        {
          id: "workspace",
          name: null,
          focusedPaneId: null,
          cameraWidth: viewportWidth,
          columns: [column("chat", 0.4), column("diff", 0.4), column("terminal", 0.4)],
        },
      ],
    };
    const { unitWidth } = selectLayoutPaneSlots(base.workspaces[0]!, {
      width: viewportWidth,
      whenNoRoom: "always-shrink",
    });
    expect(drawnRightEdges(base, viewportWidth, "always-shrink")).toEqual([333, 667, 1000]);

    const released = resizeLayoutColumnEdge(
      base,
      "diff",
      (600 - 1000 / 3) / viewportWidth,
      "always-shrink",
      viewportWidth,
      unitWidth,
    );
    expect(drawnRightEdges(released, viewportWidth, "always-shrink")).toEqual([333, 600, 1000]);
  });
});

describe("evenLayoutColumnEdge", () => {
  const strip = (...columns: ReturnType<typeof column>[]): LayoutState => ({
    focusedWorkspaceId: "workspace",
    workspaces: [{ id: "workspace", name: null, focusedPaneId: null, cameraWidth: 1000, columns }],
  });
  const widths = (state: LayoutState) => state.workspaces[0]!.columns.map((entry) => entry.width);

  it("splits a column's width evenly with the next column and leaves the others", () => {
    const evened = evenLayoutColumnEdge(
      strip(column("a", 0.2), column("b", 0.6), column("c", 0.4)),
      "a",
    );
    expect(widths(evened)).toEqual([0.4, 0.4, 0.4]);
  });

  it("splits the last column's width evenly with the previous one", () => {
    const evened = evenLayoutColumnEdge(strip(column("a", 0.7), column("b", 0.3)), "b");
    expect(widths(evened)).toEqual([0.5, 0.5]);
  });

  it("leaves a lone column as it is", () => {
    const lone = strip(column("a", 0.7));
    expect(evenLayoutColumnEdge(lone, "a")).toBe(lone);
  });
});

describe("fitLayoutColumns", () => {
  const strip = (...columns: ReturnType<typeof column>[]): LayoutState => ({
    focusedWorkspaceId: "workspace",
    workspaces: [{ id: "workspace", name: null, focusedPaneId: null, cameraWidth: 1650, columns }],
  });
  const widthsOf = (state: LayoutState) =>
    state.workspaces[0]!.columns.map((column) => Math.round(column.width * 1650));

  it("fits a new column in the window when one column is already at the readable width", () => {
    const before = strip(column("chat", 0.25), column("notes", 0.49));
    const after = strip(column("chat", 0.25), column("notes", 0.49), column("files", 0.5));
    const widths = widthsOf(fitLayoutColumns(before, after, "shrink-then-scroll", 1650));
    // The chat stops at 420px, and the other two share what is left instead of running past the edge.
    expect(widths[0]).toBe(420);
    expect(widths.reduce((sum, width) => sum + width, 0)).toBe(1650);
    expect(widths[1]! / widths[2]!).toBeCloseTo(0.49 / 0.37, 1);
  });

  it("scrolls once every column is at the readable width", () => {
    const before = strip(column("a", 1 / 3), column("b", 1 / 3), column("c", 1 / 3));
    const after = strip(
      column("a", 1 / 3),
      column("b", 1 / 3),
      column("c", 1 / 3),
      column("d", 1 / 3),
    );
    expect(widthsOf(fitLayoutColumns(before, after, "shrink-then-scroll", 1650))).toEqual([
      420, 420, 420, 420,
    ]);
  });
});

describe("moveLayoutTabToWorkspace", () => {
  it("moves the top workspace's tab into a new workspace above it", () => {
    const first = chatFor("first");
    const second = chatFor("second");
    const state = [first, second].reduce(
      (layout, content) =>
        openLayoutTab(layout, content, { placement: "active-pane", position: "end" }),
      createLayoutState(),
    );

    const moved = moveLayoutTabToWorkspace(state, -1);

    expect(tabContents(moved)).toEqual([[second], [first], []]);
    expect(selectFocusedWorkspace(moved)).toBe(moved.workspaces[0]);
    expect(selectFocusedTab(moved)?.content).toBe(second);
  });
});

describe("selectFocusedChatTarget", () => {
  it("returns the same reference on every read, so a store subscription settles", () => {
    const state = layoutOf([[["a!"]], [["b"]]]);
    const target = selectFocusedChatTarget(state);
    expect(target).toEqual({ kind: "server", threadRef: refOf("a") });
    expect(selectFocusedChatTarget(state)).toBe(target);
  });

  it("is null while the focused tab is not a chat", () => {
    expect(selectFocusedChatTarget(layoutOf([[["a", "+!"]]]))).toBeNull();
  });

  it("focuses the open tab of a page instead of adding a second one", () => {
    const opened = openLayoutTab(showLayoutContent(createLayoutState(), chat), { kind: "tasks" });
    const tasksTab = selectFocusedTab(opened)!;
    const refocused = openLayoutTab(
      focusLayoutTab(opened, selectFocusedWorkspace(opened).columns[0]!.panes[0]!.tabs[0]!.id),
      { kind: "tasks", href: "/tasks?new=true" },
    );
    expect(selectFocusedTab(refocused)?.id).toBe(tasksTab.id);
    expect(selectFocusedWorkspace(refocused).columns[0]!.panes[0]!.tabs).toHaveLength(2);
  });
});
