import type { ContextMenuItem } from "@houston-app/contracts";
import { settlePromise } from "@houston-app/client-runtime/state/runtime";
import { useNavigate } from "@tanstack/react-router";

import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { useRemoveProjectMembers } from "../../hooks/useRemoveProjectMembers";
import { readLocalApi } from "../../localApi";
import type { SidebarProjectSnapshot } from "../../sidebarProjectGrouping";
import { stackedThreadToast, toastManager } from "../ui/toast";

export type ProjectSectionMenuAction = "new-grid" | "copy-path" | "project-settings" | "remove";

export const PROJECT_SECTION_MENU_ITEMS: ReadonlyArray<ContextMenuItem<ProjectSectionMenuAction>> =
  [
    { id: "new-grid", label: "New grid" },
    { id: "copy-path", label: "Copy path", separatorBefore: true },
    { id: "project-settings", label: "Project settings", icon: "settings" },
    { id: "remove", label: "Remove project…", destructive: true, separatorBefore: true },
  ];

/** The sidebar project label's menu: right-click, the context-menu key or Shift+F10. */
export function useProjectSectionMenu(): (
  group: SidebarProjectSnapshot,
  position: { x: number; y: number },
  onCreateGrid: () => void,
) => Promise<void> {
  const navigate = useNavigate();
  const removeProjectMembers = useRemoveProjectMembers();
  const { copyToClipboard } = useCopyToClipboard<{ path: string }>({
    onCopy: ({ path }) => {
      toastManager.add({ type: "success", title: "Path copied", description: path });
    },
    onError: (error) => {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Failed to copy path",
          description: error instanceof Error ? error.message : "An error occurred.",
        }),
      );
    },
  });

  return async (group, position, onCreateGrid) => {
    const api = readLocalApi();
    if (!api) return;
    const clicked = await settlePromise(() =>
      api.contextMenu.show(PROJECT_SECTION_MENU_ITEMS, position),
    );
    if (clicked._tag === "Failure") return;
    switch (clicked.value) {
      case "new-grid":
        onCreateGrid();
        return;
      case "copy-path":
        copyToClipboard(group.workspaceRoot, { path: group.workspaceRoot });
        return;
      case "project-settings":
        void navigate({
          to: "/settings/projects",
          search: { project: group.projectKey, machine: undefined },
        });
        return;
      case "remove":
        await removeProjectMembers({
          group,
          members: group.memberProjects,
          hasOtherMembers: false,
        });
        return;
    }
  };
}
