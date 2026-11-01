import { CheckIcon, FolderIcon, PlusIcon } from "lucide-react";
import { useRef, useState } from "react";

import { cn } from "~/lib/utils";
import { Popover, PopoverPopup, PopoverTrigger } from "./popover";

/** A grid heading reads as one quiet line: name, then workspace, then empty. */
export const SIDEBAR_GRID_HEADING_CLS =
  "group/grid flex h-7 w-full min-w-0 cursor-pointer items-center gap-2 rounded-lg px-2 text-left text-xs outline-none hover:bg-sidebar-row-hover focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset";

export const SIDEBAR_GRID_HEADING_ACTIVE_CLS = "bg-sidebar-row-selected";

export const SIDEBAR_GRID_HEADING_DROP_CLS =
  "bg-(--accent-muted) ring-1 ring-(--accent-ink) ring-inset";

export const SIDEBAR_GRID_NAME_CLS =
  "min-w-0 truncate text-xs font-semibold text-sidebar-foreground";

export const SIDEBAR_GRID_WORKSPACE_CLS = "min-w-0 truncate text-xs text-secondary-label";

export const SIDEBAR_GRID_EMPTY_CLS = "ml-auto shrink-0 text-xs text-secondary-label";

export const SIDEBAR_GRID_COLLAPSED_ICON_CLS = "size-3 shrink-0 text-secondary-label";

export const SIDEBAR_GRID_ACTION_CLS =
  "inline-grid size-5 shrink-0 cursor-pointer place-items-center rounded-(--r-badge) text-secondary-label opacity-0 hover:bg-(--sel) hover:text-foreground group-hover/grid:opacity-100 group-focus-within/grid:opacity-100 focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset";

export const SIDEBAR_GRID_RENAME_CLS =
  "h-7 min-w-0 flex-1 rounded-(--r-ctl) border border-input bg-background px-2 text-xs font-semibold text-foreground outline-none focus:border-ring focus-visible:ring-2 focus-visible:ring-ring";

export const SIDEBAR_SECTION_ADD_CLS =
  "-my-1.5 inline-grid size-6 shrink-0 cursor-pointer place-items-center rounded-(--control-radius) text-secondary-label transition-colors outline-none hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset";

export const SIDEBAR_SECTION_MENU_CLS =
  "-my-1.5 inline-grid size-6 shrink-0 cursor-pointer place-items-center rounded-(--control-radius) text-secondary-label transition-colors outline-none hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset";

export const SIDEBAR_NEW_GRID_POPOVER_CLS = "w-58 p-1.5";

const SIDEBAR_NEW_GRID_TITLE_CLS = "px-2 pt-1 pb-1.5 text-2xs font-semibold text-secondary-label";

const SIDEBAR_NEW_GRID_ROW_CLS =
  "flex h-7.5 w-full cursor-pointer items-center gap-2 rounded-(--r-ctl) px-2 text-left text-xs text-secondary-foreground outline-none hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset";

const SIDEBAR_NEW_GRID_ROW_SELECTED_CLS = "bg-sidebar-row-selected text-sidebar-foreground";

const SIDEBAR_NEW_GRID_ICON_CLS = "size-3.5 shrink-0 text-secondary-label";

const SIDEBAR_NEW_GRID_CHECK_CLS = "ml-auto size-3.5 shrink-0 text-sidebar-foreground";

const SIDEBAR_NEW_GRID_DIVIDER_CLS = "my-1.5 border-0 border-t border-sidebar-border";

export interface SidebarNewGridWorkspace {
  readonly key: string;
  readonly label: string;
}

/**
 * The Grids heading's +: creates a grid in the preselected workspace with Enter,
 * or opens the existing add-workspace flow from the last row.
 */
export function SidebarNewGridMenu({
  workspaces,
  selectedKey,
  onSelect,
  onOpenFolder,
}: {
  workspaces: ReadonlyArray<SidebarNewGridWorkspace>;
  selectedKey: string | null;
  onSelect: (workspaceKey: string) => void;
  onOpenFolder: () => void;
}) {
  const [open, setOpen] = useState(false);
  const selected = workspaces.find((workspace) => workspace.key === selectedKey) ?? workspaces[0];
  const selectedRef = useRef<HTMLButtonElement>(null);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={<button type="button" aria-label="New grid" className={SIDEBAR_SECTION_ADD_CLS} />}
      >
        <PlusIcon aria-hidden className="size-[15px]" />
      </PopoverTrigger>
      <PopoverPopup
        side="bottom"
        align="end"
        padding="none"
        className={SIDEBAR_NEW_GRID_POPOVER_CLS}
        initialFocus={selected === undefined ? true : selectedRef}
      >
        <div className={SIDEBAR_NEW_GRID_TITLE_CLS}>New grid in</div>
        {workspaces.map((workspace) => {
          const isSelected = workspace.key === selected?.key;
          return (
            <button
              key={workspace.key}
              ref={isSelected ? selectedRef : undefined}
              type="button"
              data-selected={isSelected ? "" : undefined}
              onClick={() => {
                setOpen(false);
                onSelect(workspace.key);
              }}
              className={cn(
                SIDEBAR_NEW_GRID_ROW_CLS,
                isSelected && SIDEBAR_NEW_GRID_ROW_SELECTED_CLS,
              )}
            >
              <FolderIcon aria-hidden className={SIDEBAR_NEW_GRID_ICON_CLS} />
              <span className="min-w-0 flex-1 truncate">{workspace.label}</span>
              {isSelected ? <CheckIcon aria-hidden className={SIDEBAR_NEW_GRID_CHECK_CLS} /> : null}
            </button>
          );
        })}
        {workspaces.length > 0 ? <hr className={SIDEBAR_NEW_GRID_DIVIDER_CLS} /> : null}
        <button
          type="button"
          onClick={() => {
            setOpen(false);
            onOpenFolder();
          }}
          className={SIDEBAR_NEW_GRID_ROW_CLS}
        >
          <PlusIcon aria-hidden className={SIDEBAR_NEW_GRID_ICON_CLS} />
          <span className="min-w-0 flex-1 truncate">Open folder…</span>
        </button>
      </PopoverPopup>
    </Popover>
  );
}
