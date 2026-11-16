/**
 * The layout commands as store operations. The palette and the keyboard run the same
 * `runLayoutCommand`, so a key and its menu entry cannot place a pane differently.
 */
import { LAYOUT_KEYBINDING_COMMANDS, type LayoutKeybindingCommand } from "@houston-app/contracts";

import {
  findLayoutPane,
  selectFocusedPane,
  selectFocusedWorkspace,
  type LayoutState,
} from "./layoutModel";
import { toggleLayoutShortcutSheet } from "./layoutOverlayStore";
import { selectIntendedLayout, useLayoutStore } from "./layoutStore";

/** Commands the chat route handles itself: they open tabs, which needs the route. */
export const ROUTE_LAYOUT_COMMANDS: ReadonlySet<LayoutKeybindingCommand> = new Set([
  "layout.splitRight",
  "layout.splitDown",
  "layout.fill",
]);

export function isLayoutCommand(command: string | null): command is LayoutKeybindingCommand {
  return (
    command !== null && (LAYOUT_KEYBINDING_COMMANDS as ReadonlyArray<string>).includes(command)
  );
}

/**
 * What the layout keys still do while the overview is open: move the
 * selection, move the selected pane or workspace, step rows. The rest only
 * make sense on the strip, so the overview swallows them.
 */
export const OVERVIEW_LAYOUT_COMMANDS: ReadonlySet<LayoutKeybindingCommand> = new Set([
  "layout.overview",
  "layout.focusLeft",
  "layout.focusRight",
  "layout.focusUp",
  "layout.focusDown",
  "layout.moveLeft",
  "layout.moveRight",
  "layout.moveUp",
  "layout.moveDown",
  "layout.focusFirstColumn",
  "layout.focusLastColumn",
  "layout.focusWorkspaceDown",
  "layout.focusWorkspaceUp",
  "layout.moveToWorkspaceDown",
  "layout.moveToWorkspaceUp",
  "layout.moveWorkspaceDown",
  "layout.moveWorkspaceUp",
]);

/** Commands after which a hint names the workspace the pane landed in. */
export const WORKSPACE_HINT_COMMANDS: ReadonlySet<LayoutKeybindingCommand> = new Set([
  "layout.moveToWorkspaceDown",
  "layout.moveToWorkspaceUp",
  "layout.moveWorkspaceDown",
  "layout.moveWorkspaceUp",
]);

/**
 * Workspaces as the hints count them: every workspace with something in it,
 * plus the empty one only while it has focus.
 */
export function countedLayoutWorkspaces(layout: LayoutState) {
  return layout.workspaces.filter(
    (workspace) => workspace.columns.length > 0 || workspace.id === layout.focusedWorkspaceId,
  );
}

/** Commands after which a hint shows where the pane landed. */
export const COLUMN_HINT_COMMANDS: ReadonlySet<LayoutKeybindingCommand> = new Set([
  "layout.moveLeft",
  "layout.moveRight",
  "layout.pullLeft",
  "layout.pullRight",
]);

/** Run a layout command against the store; DOM focus follows the focused pane. */
export function runLayoutCommand(command: LayoutKeybindingCommand): void {
  const store = useLayoutStore.getState();
  const before = store.layout;
  switch (command) {
    case "layout.focusLeft":
      store.focusDirection("left");
      break;
    case "layout.focusRight":
      store.focusDirection("right");
      break;
    case "layout.focusUp":
      store.focusDirection("up");
      break;
    case "layout.focusDown":
      store.focusDirection("down");
      break;
    case "layout.moveLeft":
      store.moveFocused("left");
      break;
    case "layout.moveRight":
      store.moveFocused("right");
      break;
    case "layout.moveUp":
      store.moveFocused("up");
      break;
    case "layout.moveDown":
      store.moveFocused("down");
      break;
    case "layout.focusFirstColumn":
      store.focusColumnEdge("first");
      break;
    case "layout.focusLastColumn":
      store.focusColumnEdge("last");
      break;
    case "layout.cycleColumnWidth": {
      const pane = selectFocusedPane(store.layout);
      const column = pane ? findLayoutPane(store.layout, pane.id)?.column : null;
      if (column) store.cycleColumnWidth(column.id);
      break;
    }
    case "layout.centerColumn":
      store.requestCenter();
      break;
    case "layout.pullLeft":
      store.pullPane("left");
      break;
    case "layout.pullRight":
      store.pullPane("right");
      break;
    case "layout.shortcutSheet":
      toggleLayoutShortcutSheet();
      return;
    case "layout.focusWorkspaceDown":
      store.focusWorkspaceStep(1);
      break;
    case "layout.focusWorkspaceUp":
      store.focusWorkspaceStep(-1);
      break;
    case "layout.moveToWorkspaceDown":
      store.moveTabToWorkspace(1);
      break;
    case "layout.moveToWorkspaceUp":
      store.moveTabToWorkspace(-1);
      break;
    case "layout.moveWorkspaceDown":
      store.moveWorkspace(1);
      break;
    case "layout.moveWorkspaceUp":
      store.moveWorkspace(-1);
      break;
    case "layout.overview":
      store.setOverviewOpen(!store.overviewOpen);
      return;
    case "layout.splitRight":
    case "layout.splitDown":
    case "layout.fill":
      return;
  }
  // Keyboard focus lands a frame later (layoutStore's focusSoon); hint what it lands on.
  const layout = selectIntendedLayout();
  // The overview shows where a pane landed; a hint would float off the stage.
  if (layout === before || store.overviewOpen) return;
  const workspace = selectFocusedWorkspace(layout);
  if (WORKSPACE_HINT_COMMANDS.has(command)) {
    const workspaces = countedLayoutWorkspaces(layout);
    store.showHint({
      kind: "workspace",
      workspaceId: workspace.id,
      index: workspaces.indexOf(workspace),
      count: workspaces.length,
      command,
    });
    return;
  }
  if (!COLUMN_HINT_COMMANDS.has(command)) return;
  const index = workspace.columns.findIndex((column) =>
    column.panes.some((pane) => pane.id === workspace.focusedPaneId),
  );
  if (index === -1) return;
  store.showHint({ kind: "column", index, count: workspace.columns.length, command });
}
