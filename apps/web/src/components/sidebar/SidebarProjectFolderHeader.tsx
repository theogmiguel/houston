import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { ChevronDownIcon, SquarePenIcon } from "lucide-react";
import { memo } from "react";

import { cn } from "~/lib/utils";
import type { SidebarProjectSnapshot } from "../../sidebarProjectGrouping";
import { useUiStateStore } from "../../uiStateStore";
import { resolveSidebarFolderDot, resolveThreadLastVisitedAt } from "../Sidebar.logic";
import { Button } from "../ui/button";
import { SidebarStatusGlyph } from "./SidebarStatusGlyph";

const FOLDER_GLYPH_STATE = {
  attention: "needs",
  failed: "error",
  unread: "done",
  working: "working",
} as const;

const FOLDER_GLYPH_LABEL = {
  attention: "A thread needs you",
  failed: "A thread failed",
  unread: "A thread finished",
  working: "A thread is working",
} as const;

/** The folder's sidebar tree row; its thread rows name it as their parent. */
export function sidebarFolderRowId(projectKey: string) {
  return `folder:${projectKey}`;
}

/**
 * A project folder in the boring sidebar. It reads like a shelf header: a trailing
 * count and chevron, with the count and a status dot only while it is closed, so a
 * closed folder still says when a hidden thread needs you.
 */
export const SidebarProjectFolderHeader = memo(function SidebarProjectFolderHeader(props: {
  group: SidebarProjectSnapshot;
  collapsed: boolean;
  hiddenThreads: readonly EnvironmentThreadShell[];
  onToggle: (group: SidebarProjectSnapshot) => void;
  onNewThread: (group: SidebarProjectSnapshot) => void;
  onContextMenu: (group: SidebarProjectSnapshot, position: { x: number; y: number }) => void;
}) {
  const { group, collapsed, hiddenThreads } = props;
  const rowId = sidebarFolderRowId(group.projectKey);
  const localLastVisitedAtById = useUiStateStore((state) => state.threadLastVisitedAtById);
  const dot = collapsed
    ? resolveSidebarFolderDot(
        hiddenThreads.map((thread) => ({
          ...thread,
          lastVisitedAt: resolveThreadLastVisitedAt(
            thread.lastVisitedAt,
            localLastVisitedAtById[
              scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id))
            ],
          ),
        })),
      )
    : null;
  return (
    <li
      data-testid="sidebar-project-folder"
      className="group/project-folder relative mt-2 list-none first:mt-0"
    >
      <button
        type="button"
        role="treeitem"
        tabIndex={-1}
        data-sidebar-row={rowId}
        aria-expanded={!collapsed}
        onClick={() => props.onToggle(group)}
        onContextMenu={(event) => {
          event.preventDefault();
          props.onContextMenu(group, { x: event.clientX, y: event.clientY });
        }}
        className="flex h-7 w-full cursor-pointer items-center gap-2 rounded-(--control-radius) px-2 text-left text-sm font-semibold text-sidebar-foreground outline-none hover:bg-sidebar-row-hover focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      >
        <ChevronDownIcon
          aria-hidden
          className={cn(
            "size-3 shrink-0 text-secondary-label transition-transform",
            collapsed && "-rotate-90",
          )}
        />
        <span className="min-w-0 flex-1 truncate">{group.displayName}</span>
        {dot ? (
          <SidebarStatusGlyph state={FOLDER_GLYPH_STATE[dot]} label={FOLDER_GLYPH_LABEL[dot]} />
        ) : null}
        {collapsed && hiddenThreads.length > 0 ? (
          <span className="shrink-0 text-xs tabular-nums text-sidebar-muted-foreground group-hover/project-folder:invisible pointer-coarse:invisible">
            {hiddenThreads.length}
          </span>
        ) : null}
      </button>
      {/* Sits over the count, which hides on hover, and left of the chevron. */}
      <span className="absolute inset-y-0 right-6 flex items-center opacity-0 focus-within:opacity-100 group-hover/project-folder:opacity-100 pointer-coarse:opacity-100">
        <Button
          data-sidebar-action-for={rowId}
          size="icon-xs"
          variant="ghost-muted"
          aria-label={`New thread in ${group.displayName}`}
          onClick={() => props.onNewThread(group)}
        >
          <SquarePenIcon aria-hidden />
        </Button>
      </span>
    </li>
  );
});
