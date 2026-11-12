import { LAYOUT_KEYBINDING_COMMANDS } from "@houston-app/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import {
  COLUMN_HINT_COMMANDS,
  countedLayoutWorkspaces,
  isLayoutCommand,
  OVERVIEW_LAYOUT_COMMANDS,
  ROUTE_LAYOUT_COMMANDS,
  runLayoutCommand,
  WORKSPACE_HINT_COMMANDS,
} from "./layoutCommands";
import {
  createLayoutState,
  selectFocusedTab,
  selectFocusedWorkspace,
  type LayoutState,
  type LayoutTabContent,
} from "./layoutModel";
import { setLayoutOverlayMode, useLayoutOverlayStore } from "./layoutOverlayStore";
import { landPendingLayoutFocus, useLayoutStore } from "./layoutStore";

const page = (id: string): LayoutTabContent => ({ kind: "launcher", id, context: null });

let original: LayoutState;
beforeEach(() => {
  original = useLayoutStore.getState().layout;
  useLayoutStore.setState({ layout: createLayoutState(), overviewOpen: false, hint: null });
});
afterEach(() => {
  landPendingLayoutFocus();
  useLayoutStore.setState({ layout: original, overviewOpen: false, hint: null });
  setLayoutOverlayMode(null);
});

/** Three launcher tabs, one per column, focus on the last. */
function threeColumns() {
  const store = useLayoutStore.getState();
  for (const id of ["one", "two", "three"]) {
    store.openTab(page(id), { placement: "new-column", position: "end" });
  }
}

const focusedLauncherId = () => {
  landPendingLayoutFocus();
  const content = selectFocusedTab(useLayoutStore.getState().layout)?.content;
  return content?.kind === "launcher" ? content.id : null;
};

describe("isLayoutCommand", () => {
  it("accepts every layout command and nothing else", () => {
    for (const command of LAYOUT_KEYBINDING_COMMANDS) expect(isLayoutCommand(command)).toBe(true);
    expect(isLayoutCommand("tab.close")).toBe(false);
    expect(isLayoutCommand("layout.unknown")).toBe(false);
    expect(isLayoutCommand(null)).toBe(false);
  });

  it("only names commands the contract declares", () => {
    const declared = new Set<string>(LAYOUT_KEYBINDING_COMMANDS);
    for (const set of [
      ROUTE_LAYOUT_COMMANDS,
      OVERVIEW_LAYOUT_COMMANDS,
      WORKSPACE_HINT_COMMANDS,
      COLUMN_HINT_COMMANDS,
    ]) {
      for (const command of set) expect(declared.has(command)).toBe(true);
    }
  });
});

describe("runLayoutCommand", () => {
  it("moves focus between columns", () => {
    threeColumns();
    expect(focusedLauncherId()).toBe("three");
    runLayoutCommand("layout.focusLeft");
    expect(focusedLauncherId()).toBe("two");
    runLayoutCommand("layout.focusFirstColumn");
    expect(focusedLauncherId()).toBe("one");
    runLayoutCommand("layout.focusRight");
    expect(focusedLauncherId()).toBe("two");
    runLayoutCommand("layout.focusLastColumn");
    expect(focusedLauncherId()).toBe("three");
  });

  it("hints where a moved pane landed", () => {
    threeColumns();
    runLayoutCommand("layout.moveLeft");
    expect(useLayoutStore.getState().hint).toMatchObject({
      kind: "column",
      index: 1,
      count: 3,
      command: "layout.moveLeft",
    });
  });

  it("shows no hint when a move changed nothing", () => {
    threeColumns();
    runLayoutCommand("layout.moveRight");
    expect(useLayoutStore.getState().hint).toBeNull();
  });

  it("toggles the overview and the shortcut sheet without a hint", () => {
    runLayoutCommand("layout.overview");
    expect(useLayoutStore.getState().overviewOpen).toBe(true);
    runLayoutCommand("layout.overview");
    expect(useLayoutStore.getState().overviewOpen).toBe(false);
    runLayoutCommand("layout.shortcutSheet");
    expect(useLayoutOverlayStore.getState().mode).toBe("sheet");
    expect(useLayoutStore.getState().hint).toBeNull();
  });

  it("leaves the commands the route answers alone", () => {
    threeColumns();
    const before = useLayoutStore.getState().layout;
    for (const command of ROUTE_LAYOUT_COMMANDS) runLayoutCommand(command);
    expect(useLayoutStore.getState().layout).toBe(before);
  });

  it("answers every command of the contract without throwing", () => {
    threeColumns();
    for (const command of LAYOUT_KEYBINDING_COMMANDS) {
      expect(() => runLayoutCommand(command)).not.toThrow();
      useLayoutStore.setState({ overviewOpen: false });
      setLayoutOverlayMode(null);
    }
  });

  it("runs the workspace commands: scrolling workspaces are always on", () => {
    threeColumns();
    const before = selectFocusedWorkspace(useLayoutStore.getState().layout).id;
    runLayoutCommand("layout.focusWorkspaceDown");
    landPendingLayoutFocus();
    expect(selectFocusedWorkspace(useLayoutStore.getState().layout).id).not.toBe(before);
  });
});

describe("countedLayoutWorkspaces", () => {
  it("counts workspaces with something in them, plus the empty one while it has focus", () => {
    const layout = createLayoutState();
    const filled = {
      ...layout.workspaces[0]!,
      id: "filled",
      columns: [
        {
          id: "c",
          width: 1,
          panes: [
            { id: "p", size: 1, activeTabId: "t", tabs: [{ id: "t", content: page("x") }] },
          ],
        },
      ],
    };
    const empty = { ...layout.workspaces[0]!, id: "empty", columns: [] };
    const base = { workspaces: [filled, empty], focusedWorkspaceId: "filled" };
    expect(countedLayoutWorkspaces(base).map((workspace) => workspace.id)).toEqual(["filled"]);
    expect(
      countedLayoutWorkspaces({ ...base, focusedWorkspaceId: "empty" }).map(
        (workspace) => workspace.id,
      ),
    ).toEqual(["filled", "empty"]);
  });
});
