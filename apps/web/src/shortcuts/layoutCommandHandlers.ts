import { LAYOUT_KEYBINDING_COMMANDS, type LayoutKeybindingCommand } from "@houston-app/contracts";

import { openLayoutNewTab, toggleFocusedLayoutFill } from "../layout/layoutActions";
import { OVERVIEW_LAYOUT_COMMANDS, runLayoutCommand } from "../layout/layoutCommands";
import { isLayoutModalOpen } from "../layout/layoutKeyGuards";
import { useLayoutStore } from "../layout/layoutStore";
import type { CommandHandlers } from "./dispatcher";

function runRouteLayoutCommand(command: LayoutKeybindingCommand): void {
  switch (command) {
    case "layout.splitRight":
      openLayoutNewTab("new-column");
      return;
    case "layout.splitDown":
      openLayoutNewTab("split-down");
      return;
    case "layout.fill":
      toggleFocusedLayoutFill();
      return;
    default:
      runLayoutCommand(command);
  }
}

/**
 * One handler per `layout.*` command except the overview, which has no stage to draw yet. A dialog
 * above the layout keeps the keys, and an open overview answers only the commands it lists.
 */
export function buildLayoutCommandHandlers(): CommandHandlers {
  const handlers: CommandHandlers = {};
  for (const command of LAYOUT_KEYBINDING_COMMANDS) {
    if (command === "layout.overview") continue;
    handlers[command] = (event) => {
      if (isLayoutModalOpen()) return false;
      const overviewOpen = useLayoutStore.getState().overviewOpen;
      if (overviewOpen && !OVERVIEW_LAYOUT_COMMANDS.has(command)) {
        event.preventDefault();
        return true;
      }
      event.preventDefault();
      event.stopPropagation();
      runRouteLayoutCommand(command);
      return true;
    };
  }
  return handlers;
}
