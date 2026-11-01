import type { ResolvedKeybindingsConfig } from "@t3tools/contracts";
import { useEffect, useEffectEvent } from "react";

import { resolveShortcutCommand } from "../keybindings";
import { isEditableFocused } from "../lib/editableFocus";
import { isTerminalFocused } from "../lib/terminalFocus";
import { type ClosedCell, useGridStore } from "./gridStore";
import { adjacentThreadKey, preorderThreads } from "./tree";

export interface GridShortcutsOptions {
  readonly gridId: string;
  readonly keybindings: ResolvedKeybindingsConfig;
  readonly maximizedThreadId: string | null;
  readonly setMaximizedThreadId: (threadId: string | null) => void;
  /** A closed cell only reopens while its thread still exists in the workspace. */
  readonly isThreadAvailable: (threadId: string) => boolean;
}

/**
 * The grid's keyboard commands: Ctrl+[ and Ctrl+] move pane focus in reading
 * order, Ctrl+Shift+Enter maximizes the focused pane, and Ctrl+Shift+T reopens
 * the most recently closed pane at its slot. They run in the capture phase so
 * the focused chat never sees them.
 */
export function useGridShortcuts(options: GridShortcutsOptions): void {
  const readThreadAvailable = useEffectEvent(options.isThreadAvailable);
  const setMaximizedThreadId = options.setMaximizedThreadId;

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return;
      if (event.target instanceof HTMLElement && event.target.closest("[data-keybinding-capture]"))
        return;
      const terminalFocus = isTerminalFocused();
      const editableFocus = isEditableFocused(event.target);
      const command = resolveShortcutCommand(event, options.keybindings, {
        context: { terminalFocus, editableFocus },
      });

      if (command === "navigation.back" || command === "navigation.forward") {
        if (terminalFocus) return;
        const state = useGridStore.getState();
        const grid = state.grids.find((entry) => entry.id === options.gridId);
        if (grid === undefined || grid.tree === null || grid.focusedThreadId === null) return;
        const next = adjacentThreadKey(
          grid.tree,
          grid.focusedThreadId,
          command === "navigation.back" ? -1 : 1,
        );
        if (next === null || next === grid.focusedThreadId) return;
        event.preventDefault();
        event.stopPropagation();
        state.focusThread(options.gridId, next);
        return;
      }

      if (command === "view.reopenClosed") {
        if (terminalFocus) return;
        const state = useGridStore.getState();
        let reopened: ClosedCell | null = null;
        for (;;) {
          const top = (state.closedCells[options.gridId] ?? []).at(-1);
          if (top === undefined) break;
          if (!readThreadAvailable(top.threadId)) {
            state.forgetClosedCell(options.gridId, top.threadId);
            continue;
          }
          reopened = state.reopenClosedCell(options.gridId);
          break;
        }
        if (reopened === null) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        return;
      }

      if (
        !(event.ctrlKey || event.metaKey) ||
        !event.shiftKey ||
        event.altKey ||
        event.key !== "Enter"
      )
        return;
      if (terminalFocus || editableFocus) return;
      const state = useGridStore.getState();
      const grid = state.grids.find((entry) => entry.id === options.gridId);
      if (grid === undefined || grid.tree === null || grid.focusedThreadId === null) return;
      if (preorderThreads(grid.tree).length < 2) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      setMaximizedThreadId(
        options.maximizedThreadId === grid.focusedThreadId ? null : grid.focusedThreadId,
      );
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [options.gridId, options.keybindings, options.maximizedThreadId, setMaximizedThreadId]);
}
