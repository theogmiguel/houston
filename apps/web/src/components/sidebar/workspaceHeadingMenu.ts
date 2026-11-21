import type { ContextMenuItem } from "@houston-app/contracts";
import type { Translate } from "~/i18n/useT";

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
  translate?: Translate;
}): ReadonlyArray<ContextMenuItem<WorkspaceHeadingMenuAction>> {
  const t = input.translate ?? ((source: string) => source);
  const items: ContextMenuItem<WorkspaceHeadingMenuAction>[] = [
    { id: "new-thread", label: t("New thread") },
    { id: "rename", label: t("Rename workspace") },
    {
      id: "toggle-pin",
      label: input.pinned ? t("Unpin workspace") : t("Pin workspace"),
      separatorBefore: true,
    },
    { id: "move-up", label: t("Move workspace up"), disabled: !input.canMoveUp },
    { id: "move-down", label: t("Move workspace down"), disabled: !input.canMoveDown },
    { id: "hide", label: t("Hide workspace") },
    { id: "delete", label: t("Delete workspace…"), destructive: true },
    {
      id: "close-ready",
      label: t("Close all ready"),
      disabled: input.readyCount === 0,
      separatorBefore: true,
    },
    { id: "new-workspace", label: t("New workspace"), separatorBefore: true },
  ];
  if (input.hiddenWorkspaces.length > 0) {
    items.push({
      id: "hidden-workspaces",
      label: t("Show hidden workspaces"),
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
