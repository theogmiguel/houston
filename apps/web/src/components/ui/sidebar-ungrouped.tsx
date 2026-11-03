import { PlusIcon } from "lucide-react";
import type { ReactNode } from "react";

import {
  SIDEBAR_GRID_ACTION_CLS,
  SIDEBAR_GRID_EMPTY_CLS,
  SIDEBAR_GRID_HEADING_CLS,
  SIDEBAR_GRID_NAME_CLS,
  SIDEBAR_GRID_WORKSPACE_CLS,
} from "./sidebar-grids";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./tooltip";

/**
 * A workspace's rows for threads no grid shows. It keeps the workspace on the
 * rail when it has no grid yet, and offers the grid it is missing.
 */
export function SidebarUngroupedSection({
  workspaceTitle,
  empty,
  onCreateGrid,
  children,
}: {
  workspaceTitle: string;
  empty: boolean;
  onCreateGrid: () => void;
  children: ReactNode;
}) {
  return (
    <div className="mt-1 flex flex-col gap-px">
      <div className="group/grid relative flex items-center">
        <div className={`${SIDEBAR_GRID_HEADING_CLS} cursor-default`}>
          <span className={SIDEBAR_GRID_NAME_CLS}>Ungrouped</span>
          <span className={SIDEBAR_GRID_WORKSPACE_CLS}>{workspaceTitle}</span>
          {empty ? <span className={SIDEBAR_GRID_EMPTY_CLS}>empty</span> : null}
        </div>
        <span className="absolute inset-y-0 right-1 flex items-center">
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  aria-label={`New grid in ${workspaceTitle}`}
                  onClick={onCreateGrid}
                  className={SIDEBAR_GRID_ACTION_CLS}
                />
              }
            >
              <PlusIcon aria-hidden className="size-3" />
            </TooltipTrigger>
            <TooltipPopup side="top">New grid</TooltipPopup>
          </Tooltip>
        </span>
      </div>
      <div className="flex flex-col gap-px">{children}</div>
    </div>
  );
}
