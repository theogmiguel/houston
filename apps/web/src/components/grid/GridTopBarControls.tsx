import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";

import { findThread } from "../../grid/tree";
import type { GridRecord } from "../../grid/gridStore";
import { shortcutLabelForCommand } from "../../keybindings";
import { useRightPanelStore } from "../../rightPanelStore";
import { primaryServerKeybindingsAtom } from "../../state/server";
import { selectThreadTerminalUiState, useTerminalUiStateStore } from "../../terminalUiStateStore";
import { PanelLayoutControls } from "../chat/PanelLayoutControls";
import { GridLayoutMenu } from "./GridLayoutMenu";

/** The grid route's titlebar controls follow the focused pane's thread. */
export function GridTopBarControls({ grid }: { grid: GridRecord }) {
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const focusedLeaf =
    grid.focusedThreadId === null ? null : findThread(grid.tree, grid.focusedThreadId);
  const focusedRef =
    focusedLeaf === null
      ? null
      : scopeThreadRef(grid.environmentId as EnvironmentId, focusedLeaf.threadId as ThreadId);
  const terminalOpen = useTerminalUiStateStore((state) =>
    focusedRef === null
      ? false
      : selectThreadTerminalUiState(state.terminalUiStateByThreadKey, focusedRef).terminalOpen,
  );
  const rightPanelOpen = useRightPanelStore(
    (state) =>
      focusedRef !== null && state.byThreadKey[scopedThreadKey(focusedRef)]?.isOpen === true,
  );
  const threadPanelOpen = useRightPanelStore((state) => {
    if (focusedRef === null) return false;
    const visibility = state.threadPanelVisibilityByThreadKey[scopedThreadKey(focusedRef)];
    return visibility?.inlineOpen === true || visibility?.popoverOpen === true;
  });

  return (
    <PanelLayoutControls
      terminalAvailable={focusedRef !== null}
      terminalOpen={terminalOpen}
      terminalShortcutLabel={shortcutLabelForCommand(keybindings, "terminal.toggle")}
      threadPanelOpen={threadPanelOpen}
      threadPanelPresentation="inline"
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
        if (focusedRef === null) return;
        const store = useRightPanelStore.getState();
        const open = !threadPanelOpen;
        store.setThreadPanelOpen(focusedRef, "inline", open);
        store.setThreadPanelOpen(focusedRef, "popover", open);
      }}
      onToggleRightPanel={() => {
        if (focusedRef === null) return;
        const store = useRightPanelStore.getState();
        if (rightPanelOpen) {
          store.toggleVisibility(focusedRef);
        } else {
          store.toggle(focusedRef, "diff");
        }
      }}
    />
  );
}
