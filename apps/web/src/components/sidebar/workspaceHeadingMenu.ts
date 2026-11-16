import type { ContextMenuItem } from "@houston-app/contracts";

export type WorkspaceHeadingMenuAction =
  | "new-thread"
  | "rename"
  | "toggle-pin"
  | "move-up"
  | "move-down"
  | "hide"
  | "delete"
  | "close-ready"
  | "new-workspace"
  | "hidden-workspaces"
  | `show-workspace:${string}`;

const SHOW_WORKSPACE_PREFIX = "show-workspace:";

/** The workspace heading's menu, shared by its actions button, right-click and the context-menu key. */
export function workspaceHeadingMenuItems(input: {
  pinned: boolean;
  canMoveUp: boolean;
  canMoveDown: boolean;
  readyCount: number;
  hiddenWorkspaces: ReadonlyArray<{ id: string; name: string }>;
}): ReadonlyArray<ContextMenuItem<WorkspaceHeadingMenuAction>> {
  const items: ContextMenuItem<WorkspaceHeadingMenuAction>[] = [
    { id: "new-thread", label: "New thread" },
    { id: "rename", label: "Rename workspace" },
    {
      id: "toggle-pin",
      label: input.pinned ? "Unpin workspace" : "Pin workspace",
      separatorBefore: true,
    },
    { id: "move-up", label: "Move workspace up", disabled: !input.canMoveUp },
    { id: "move-down", label: "Move workspace down", disabled: !input.canMoveDown },
    { id: "hide", label: "Hide workspace" },
    { id: "delete", label: "Delete workspace…", destructive: true },
    {
      id: "close-ready",
      label: "Close all ready",
      disabled: input.readyCount === 0,
      separatorBefore: true,
    },
    { id: "new-workspace", label: "New workspace", separatorBefore: true },
  ];
  if (input.hiddenWorkspaces.length > 0) {
    items.push({
      id: "hidden-workspaces",
      label: "Show hidden workspaces",
      children: input.hiddenWorkspaces.map((workspace) => ({
        id: `${SHOW_WORKSPACE_PREFIX}${workspace.id}`,
        label: workspace.name,
      })),
    });
  }
  return items;
}

/** The hidden workspace a `show-workspace:` action names, or null for every other action. */
export function hiddenWorkspaceIdFromAction(action: WorkspaceHeadingMenuAction): string | null {
  return action.startsWith(SHOW_WORKSPACE_PREFIX)
    ? action.slice(SHOW_WORKSPACE_PREFIX.length)
    : null;
}
