import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef, scopedThreadKey } from "@houston-app/client-runtime/environment";
import type { EnvironmentId, ScopedThreadRef, ThreadId } from "@houston-app/contracts";
import type { RefObject } from "react";

import { toggleTerminal } from "../terminal/toggleTerminal";
import { findThread, preorderThreads } from "@houston-app/shared/grid/tree";
import type { GridRecord } from "../../grid/gridStore";
import { shortcutLabelForCommand } from "../../keybindings";
import { useRightPanelStore } from "../../rightPanelStore";
import { primaryServerKeybindingsAtom } from "../../state/server";
import { selectThreadTerminalUiState, useTerminalUiStateStore } from "../../terminalUiStateStore";
import { PanelLayoutControls } from "../chat/PanelLayoutControls";
import { GridLayoutMenu, GridLayoutMenuItems } from "./GridLayoutMenu";

/** The grid route's titlebar controls follow the focused pane's thread. */
export function GridTopBarControls({
  grid,
  gridTerminalRef = null,
  emptyDraftThreadId = null,
  rightPanelThreadId = null,
  threadPanelAnchorRef,
  detailsOpen,
  onToggleDetails,
  onArrange,
}: {
  grid: GridRecord;
  /** The grid's own terminal; absent while a cell is maximized or on the thread route. */
  gridTerminalRef?: ScopedThreadRef | null;
  /** The centred composer of an empty grid has no tree leaf yet. */
  emptyDraftThreadId?: string | null;
  /** The thread whose right panel the grid shows: the pinned thread, else the focused one. */
  rightPanelThreadId?: string | null;
  /** Anchors the focused cell's popover details card under the top bar control. */
  threadPanelAnchorRef?: RefObject<HTMLElement | null>;
  /** The grid's one details flag; when the grid owns it the control follows it. */
  detailsOpen?: boolean;
  onToggleDetails?: (() => void) | undefined;
  /** Runs after the Tidy control rearranges the grid. */
  onArrange?: (() => void) | undefined;
}) {
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const focusedLeaf =
    grid.focusedThreadId === null ? null : findThread(grid.tree, grid.focusedThreadId);
  const focusedRef =
    focusedLeaf === null
      ? null
      : scopeThreadRef(grid.environmentId as EnvironmentId, focusedLeaf.threadId as ThreadId);
  const threadPanelRef =
    focusedRef ??
    (emptyDraftThreadId === null
      ? null
      : scopeThreadRef(grid.environmentId as EnvironmentId, emptyDraftThreadId as ThreadId));
  const terminalRef = gridTerminalRef ?? focusedRef;
  const terminalOpen = useTerminalUiStateStore((state) =>
    terminalRef === null
      ? false
      : selectThreadTerminalUiState(state.terminalUiStateByThreadKey, terminalRef).terminalOpen,
  );
  const panelRef =
    rightPanelThreadId === null
      ? focusedRef
      : scopeThreadRef(grid.environmentId as EnvironmentId, rightPanelThreadId as ThreadId);
  const rightPanelOpen = useRightPanelStore(
    (state) => panelRef !== null && state.byThreadKey[scopedThreadKey(panelRef)]?.isOpen === true,
  );
  const threadPanelPresentation = useRightPanelStore((state) =>
    threadPanelRef === null
      ? "inline"
      : (state.threadPanelPresentationByThreadKey[scopedThreadKey(threadPanelRef)] ?? "inline"),
  );
  const threadPanelOpen = useRightPanelStore((state) => {
    if (threadPanelRef === null) return false;
    const visibility = state.threadPanelVisibilityByThreadKey[scopedThreadKey(threadPanelRef)];
    if (visibility === undefined) return false;
    return threadPanelPresentation === "popover" ? visibility.popoverOpen : visibility.inlineOpen;
  });
  const gridOwnsDetails = onToggleDetails !== undefined;
  // A grid of two or more panes carries the details toggle in each pane header. An empty grid's
  // draft and a single thread's flat canvas show no pane header, so the strip keeps it.
  const stripOwnsDetails = preorderThreads(grid.tree).length < 2;

  return (
    <PanelLayoutControls
      showThreadPanelControl={stripOwnsDetails}
      terminalAvailable={terminalRef !== null}
      terminalOpen={terminalOpen}
      terminalShortcutLabel={shortcutLabelForCommand(keybindings, "terminal.toggle")}
      threadPanelOpen={gridOwnsDetails ? detailsOpen === true : threadPanelOpen}
      threadPanelPresentation="inline"
      {...(stripOwnsDetails && threadPanelAnchorRef ? { threadPanelAnchorRef } : {})}
      threadPanelShortcutLabel={shortcutLabelForCommand(keybindings, "threadPanel.toggle")}
      rightPanelAvailable={panelRef !== null}
      rightPanelOpen={rightPanelOpen}
      rightPanelShortcutLabel={shortcutLabelForCommand(keybindings, "rightPanel.toggle")}
      gridLayoutControl={<GridLayoutMenu grid={grid} {...(onArrange ? { onArrange } : {})} />}
      gridLayoutMenuItems={
        <GridLayoutMenuItems grid={grid} {...(onArrange ? { onArrange } : {})} />
      }
      onToggleTerminal={() => {
        if (gridTerminalRef !== null) {
          toggleTerminal(gridTerminalRef);
          return;
        }
        if (focusedRef !== null) {
          useTerminalUiStateStore.getState().setTerminalOpen(focusedRef, !terminalOpen);
        }
      }}
      onToggleThreadPanel={() => {
        if (onToggleDetails !== undefined) {
          onToggleDetails();
          return;
        }
        if (threadPanelRef === null) return;
        const store = useRightPanelStore.getState();
        const open = !threadPanelOpen;
        store.setThreadPanelOpen(threadPanelRef, "inline", open);
        store.setThreadPanelOpen(threadPanelRef, "popover", open);
      }}
      onToggleRightPanel={() => {
        if (panelRef === null) return;
        // Opening shows the launcher until a surface or the + menu creates a tab.
        useRightPanelStore.getState().toggleVisibility(panelRef);
      }}
    />
  );
}
