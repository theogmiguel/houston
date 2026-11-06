import type { ContextMenuItem } from "@houston-app/contracts";

export type GridHeadingMenuAction =
  | "new-thread"
  | "rename"
  | "toggle-pin"
  | "move-up"
  | "move-down"
  | "hide"
  | "delete"
  | "close-ready"
  | "workspace"
  | "new-grid"
  | "hidden-grids"
  | `show-grid:${string}`;

const SHOW_GRID_PREFIX = "show-grid:";

/** The grid heading's menu, shared by its actions button, right-click and the context-menu key. */
export function gridHeadingMenuItems(input: {
  pinned: boolean;
  manualOrder: boolean;
  readyCount: number;
  workspaceTitle: string;
  hiddenGrids: ReadonlyArray<{ id: string; name: string }>;
}): ReadonlyArray<ContextMenuItem<GridHeadingMenuAction>> {
  const workspace: ContextMenuItem<GridHeadingMenuAction>[] = [
    { id: "new-grid", label: `New grid in ${input.workspaceTitle}` },
  ];
  if (input.hiddenGrids.length > 0) {
    workspace.push({
      id: "hidden-grids",
      label: "Show hidden grids",
      children: input.hiddenGrids.map((grid) => ({
        id: `${SHOW_GRID_PREFIX}${grid.id}`,
        label: grid.name,
      })),
    });
  }
  return [
    { id: "new-thread", label: "New thread" },
    { id: "rename", label: "Rename grid" },
    { id: "toggle-pin", label: input.pinned ? "Unpin grid" : "Pin grid", separatorBefore: true },
    ...(input.manualOrder
      ? ([
          { id: "move-up", label: "Move grid up" },
          { id: "move-down", label: "Move grid down" },
        ] as const)
      : []),
    { id: "hide", label: "Hide grid" },
    { id: "delete", label: "Delete grid…", destructive: true },
    {
      id: "close-ready",
      label: "Close all ready",
      disabled: input.readyCount === 0,
      separatorBefore: true,
    },
    { id: "workspace", label: "Workspace", separatorBefore: true, children: workspace },
  ];
}

/** The hidden grid a `show-grid:` action names, or null for every other action. */
export function hiddenGridIdFromAction(action: GridHeadingMenuAction): string | null {
  return action.startsWith(SHOW_GRID_PREFIX) ? action.slice(SHOW_GRID_PREFIX.length) : null;
}
