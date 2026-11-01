import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import type { RefObject } from "react";

import { findThread } from "../../grid/tree";
import type { GridRecord } from "../../grid/gridStore";
import { shortcutLabelForCommand } from "../../keybindings";
import { useRightPanelStore } from "../../rightPanelStore";
import { primaryServerKeybindingsAtom } from "../../state/server";
import { selectThreadTerminalUiState, useTerminalUiStateStore } from "../../terminalUiStateStore";
import { PanelLayoutControls } from "../chat/PanelLayoutControls";
import { GridLayoutMenu } from "./GridLayoutMenu";

/** The grid route's titlebar controls follow the focused pane's thread. */
export function GridTopBarControls({
  grid,
  emptyDraftThreadId = null,
  threadPanelAnchorRef,
  detailsOpen,
  onToggleDetails,
}: {
  grid: GridRecord;
  /** The centred composer of an empty grid has no tree leaf yet. */
  emptyDraftThreadId?: string | null;
  /** Anchors the focused cell's popover details card under the top bar control. */
  threadPanelAnchorRef?: RefObject<HTMLElement | null>;
  /** The grid's one details flag; when the grid owns it the control follows it. */
  detailsOpen?: boolean;
  onToggleDetails?: (() => void) | undefined;
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
  const terminalOpen = useTerminalUiStateStore((state) =>
    focusedRef === null
      ? false
      : selectThreadTerminalUiState(state.terminalUiStateByThreadKey, focusedRef).terminalOpen,
  );
  const rightPanelOpen = useRightPanelStore(
    (state) =>
      focusedRef !== null && state.byThreadKey[scopedThreadKey(focusedRef)]?.isOpen === true,
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

  return (
    <PanelLayoutControls
      // While the panel is open its own header carries the terminal and panel toggles.
      showTerminalControl={!rightPanelOpen}
      showRightPanelControl={!rightPanelOpen}
      terminalAvailable={focusedRef !== null}
      terminalOpen={terminalOpen}
      terminalShortcutLabel={shortcutLabelForCommand(keybindings, "terminal.toggle")}
      threadPanelOpen={gridOwnsDetails ? detailsOpen === true : threadPanelOpen}
      threadPanelPresentation="inline"
      {...(threadPanelAnchorRef ? { threadPanelAnchorRef } : {})}
      threadPanelShortcutLabel={shortcutLabelForCommand(keybindings, "threadPanel.toggle")}
      rightPanelAvailable={focusedRef !== null}
      rightPanelOpen={rightPanelOpen}
      rightPanelShortcutLabel={shortcutLabelForCommand(keybindings, "rightPanel.toggle")}
      gridLayoutControl={<GridLayoutMenu grid={grid} />}
      onToggleTerminal={() => {
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
        if (focusedRef === null) return;
        // Opening shows the launcher until a surface or the + menu creates a tab.
        useRightPanelStore.getState().toggleVisibility(focusedRef);
      }}
    />
  );
}
