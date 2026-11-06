import type {
  SidebarGridSortOrder,
  SidebarGridThreadSortOrder,
} from "@houston-app/contracts/settings";
import {
  CheckIcon,
  FolderIcon,
  FolderPlusIcon,
  PlusIcon,
  SlidersHorizontalIcon,
} from "lucide-react";
import { useState, type ReactNode } from "react";

import { cn } from "~/lib/utils";
import {
  Menu,
  MenuCheckboxItem,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuRadioItemIndicator,
  MenuSeparator,
  MenuTrigger,
} from "./menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./tooltip";

/**
 * A heading is one 12px/600 line: chevron, name, muted count, then the attention pips. A grid
 * heading is a project heading one step in. The actions overlay the pips and reserve their room
 * only while the heading is hovered or focused, so the name keeps the width otherwise.
 */
export const SIDEBAR_GRID_HEADING_CLS =
  "group/grid flex h-8 w-full min-w-0 cursor-pointer items-center gap-1.5 rounded-lg py-0 pr-2 pl-4 text-left text-xs transition-colors duration-(--motion-feedback) ease-standard outline-none hover:bg-sidebar-row-hover group-hover/grid:pr-13 group-has-focus-visible/grid:pr-13 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset";

export const SIDEBAR_GRID_HEADING_ACTIVE_CLS = "bg-sidebar-row-selected";

export const SIDEBAR_GRID_HEADING_DROP_CLS =
  "bg-(--accent-muted) ring-1 ring-(--accent-ink) ring-inset";

export const SIDEBAR_GRID_NAME_CLS =
  "min-w-0 truncate text-xs font-semibold text-sidebar-foreground";

export const SIDEBAR_GRID_EMPTY_CLS = "ml-auto shrink-0 text-xs text-secondary-label";

/** The muted thread count that follows a heading's name. */
export const SIDEBAR_GRID_COUNT_CLS =
  "shrink-0 text-xs font-medium text-secondary-label tabular-nums";

/**
 * A project heading sticks to the top of the rail's scroll area on the rail's own background at
 * full ink, and gains a 1px bottom border only while it is stuck (`data-stuck`). It sticks 1px
 * above the top so the observer that sets `data-stuck` sees it clipped.
 */
export const SIDEBAR_PROJECT_ROW_CLS =
  "group/project sticky -top-px z-10 mt-1 flex items-center border-b border-transparent bg-sidebar first:mt-0 data-stuck:border-sidebar-border";

export const SIDEBAR_PROJECT_LABEL_CLS =
  "flex h-8 w-full min-w-0 cursor-pointer items-center gap-1.5 rounded-lg py-0 pr-2 pl-2 text-left text-xs font-semibold text-sidebar-foreground transition-colors duration-(--motion-feedback) ease-standard outline-none hover:bg-sidebar-row-hover focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset";

/** A project label's room for its three hover actions (New thread, New grid, Project actions). */
export const SIDEBAR_PROJECT_ACTIONS_ROOM_CLS =
  "group-hover/project:pr-17 group-has-focus-visible/project:pr-17";

export const SIDEBAR_PROJECT_LABEL_TEXT_CLS = "min-w-0 truncate";

/** The project heading's muted thread count. */
export const SIDEBAR_PROJECT_SUMMARY_CLS = SIDEBAR_GRID_COUNT_CLS;

/** The heading's pips: hidden while the hover actions show in their place. */
export const SIDEBAR_HEADING_PIPS_CLS =
  "ml-auto flex shrink-0 items-center gap-1 transition-opacity duration-(--motion-feedback) ease-standard group-hover/project:opacity-0 group-has-focus-visible/project:opacity-0 group-hover/grid:opacity-0 group-has-focus-visible/grid:opacity-0";

const SIDEBAR_HEADING_PIP_CLS =
  "inline-flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-2xs leading-none font-semibold tabular-nums";

/** The project label's New thread and New grid actions, revealed on hover or keyboard focus, not a click's focus. */
export const SIDEBAR_PROJECT_ACTION_CLS =
  "inline-grid size-5 shrink-0 cursor-pointer place-items-center rounded-(--r-badge) text-secondary-label opacity-0 transition-opacity duration-(--motion-feedback) ease-standard hover:bg-(--sel) hover:text-foreground group-hover/project:opacity-100 group-has-focus-visible/project:opacity-100 focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset";

/** Indented to the project name, so it reads as the empty project's content. */
export const SIDEBAR_PROJECT_EMPTY_ACTION_CLS =
  "flex h-(--h-row) w-full cursor-pointer items-center gap-2 rounded-lg py-0 pr-2 pl-7.5 text-left text-xs text-secondary-label transition-colors duration-(--motion-feedback) ease-standard outline-none hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset";

/**
 * The attention pips of a project or grid heading: a failed count, then a count of threads that
 * wait for the user. Nothing renders when neither has a thread.
 */
export function SidebarAttentionPips({
  failed,
  needsYou,
}: {
  readonly failed: number;
  readonly needsYou: number;
}) {
  if (failed === 0 && needsYou === 0) return null;
  return (
    <span data-attention-pips="" className={SIDEBAR_HEADING_PIPS_CLS}>
      {failed === 0 ? null : (
        <span
          role="img"
          aria-label={failed === 1 ? "1 thread failed" : `${failed} threads failed`}
          data-attention-pip="failed"
          className={cn(SIDEBAR_HEADING_PIP_CLS, "bg-error-surface text-error-foreground")}
        >
          <span aria-hidden>{failed}</span>
        </span>
      )}
      {needsYou === 0 ? null : (
        <span
          role="img"
          aria-label={needsYou === 1 ? "1 thread needs you" : `${needsYou} threads need you`}
          data-attention-pip="needs-you"
          className={cn(SIDEBAR_HEADING_PIP_CLS, "bg-warning-surface text-warning-foreground")}
        >
          <span aria-hidden>{needsYou}</span>
        </span>
      )}
    </span>
  );
}

/** The grid rail's header controls: outside the window drag region so they stay clickable. */
export const SIDEBAR_HEADER_ACTIONS_CLS =
  "relative z-10 flex shrink-0 items-center gap-0.5 [-webkit-app-region:no-drag]";

/**
 * Every thread row, in a grid or directly under its project, starts at the rail's own inset: its
 * status glyph sits under the project heading's chevron, so a 264px sidebar leaves the title the
 * rest of the width.
 */
export const SIDEBAR_THREAD_ROW_INDENT_CLS = "pl-2";

/** A fixed 12px box in both states; the chevron rotates inside instead of swapping icons. */
export const SIDEBAR_GRID_CHEVRON_BOX_CLS =
  "inline-grid size-3 shrink-0 place-items-center text-secondary-label";

export const SIDEBAR_GRID_CHEVRON_CLS =
  "size-3 transition-transform duration-(--motion-disclosure) ease-standard";

export const SIDEBAR_GRID_CHEVRON_EXPANDED_CLS = "rotate-90";

export const SIDEBAR_GRID_ACTION_CLS =
  "inline-grid size-5 shrink-0 cursor-pointer place-items-center rounded-(--r-badge) text-secondary-label opacity-0 transition-opacity duration-(--motion-feedback) ease-standard hover:bg-(--sel) hover:text-foreground group-hover/grid:opacity-100 group-has-focus-visible/grid:opacity-100 focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset";

export const SIDEBAR_GRID_RENAME_CLS =
  "h-7 min-w-0 flex-1 rounded-(--r-ctl) border border-input bg-background px-2 text-xs font-semibold text-foreground outline-none focus:border-ring focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset";

export const SIDEBAR_SECTION_ACTION_CLS =
  "-my-1.5 inline-grid size-6 shrink-0 cursor-pointer place-items-center rounded-(--r-ctl) text-secondary-label transition-colors duration-(--motion-feedback) ease-standard outline-none hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset";

const SIDEBAR_SECTION_HEADER_ROW_CLS =
  "group/section flex h-(--h-row) shrink-0 items-center gap-1 rounded-lg pr-1 pl-2 text-xs font-semibold text-secondary-label";

const SIDEBAR_SECTION_HEADER_ACTIONS_CLS =
  "ml-auto flex items-center gap-0.5 opacity-0 transition-opacity duration-(--motion-feedback) ease-standard group-hover/section:opacity-100 group-focus-within/section:opacity-100";

/** A quiet section label whose icon actions appear while its row is hovered or focused. */
export function SidebarSectionHeaderRow({
  title,
  actions,
}: {
  readonly title: string;
  readonly actions?: ReactNode;
}) {
  return (
    <div className={SIDEBAR_SECTION_HEADER_ROW_CLS}>
      <span className="min-w-0 flex-1 truncate">{title}</span>
      {actions === undefined ? null : (
        <span className={SIDEBAR_SECTION_HEADER_ACTIONS_CLS}>{actions}</span>
      )}
    </div>
  );
}

export const SIDEBAR_NEW_GRID_POPOVER_CLS = "w-58 [&>div]:p-1.5";

const SIDEBAR_NEW_GRID_TITLE_CLS = "px-2 pt-1 pb-1.5 text-2xs font-semibold text-secondary-label";

const SIDEBAR_NEW_GRID_NAME_CLS =
  "mb-1 h-7 w-full min-w-0 rounded-(--r-ctl) border border-input bg-background px-2 text-xs text-foreground outline-none placeholder:text-placeholder focus:border-ring focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring";

const SIDEBAR_NEW_GRID_ROW_CLS =
  "flex h-7.5 w-full cursor-pointer items-center gap-2 rounded-(--r-ctl) px-2 text-left text-xs text-secondary-foreground outline-none hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset";

const SIDEBAR_NEW_GRID_ROW_SELECTED_CLS = "bg-sidebar-row-selected text-sidebar-foreground";

const SIDEBAR_NEW_GRID_ICON_CLS = "size-3.5 shrink-0 text-secondary-label";

const SIDEBAR_NEW_GRID_CHECK_CLS = "ml-auto size-3.5 shrink-0 text-sidebar-foreground";

export interface SidebarNewGridWorkspace {
  readonly key: string;
  readonly label: string;
}

/**
 * The Grids heading's New grid: creates a grid in the preselected workspace with Enter,
 * or opens the existing add-workspace flow from the last row. The optional name
 * field names the new grid; empty keeps the default name.
 */
export function SidebarNewGridMenu({
  workspaces,
  selectedKey,
  onSelect,
  onOpenFolder,
}: {
  workspaces: ReadonlyArray<SidebarNewGridWorkspace>;
  selectedKey: string | null;
  onSelect: (workspaceKey: string, name?: string) => void;
  onOpenFolder: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const selected = workspaces.find((workspace) => workspace.key === selectedKey) ?? workspaces[0];
  const create = (workspaceKey: string) => {
    const trimmed = name.trim();
    setOpen(false);
    if (trimmed.length === 0) onSelect(workspaceKey);
    else onSelect(workspaceKey, trimmed);
  };
  return (
    <Menu
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setName("");
      }}
    >
      <MenuTrigger
        render={
          <button type="button" aria-label="New grid" className={SIDEBAR_SECTION_ACTION_CLS} />
        }
      >
        <FolderPlusIcon aria-hidden className="size-[15px]" />
      </MenuTrigger>
      <MenuPopup
        align="end"
        side="bottom"
        width="content"
        className={SIDEBAR_NEW_GRID_POPOVER_CLS}
        onKeyDown={(event) => {
          // The menu opens with no item highlighted; Enter keeps creating in the preselected
          // workspace, as the row-focused popover did, until the user moves the highlight.
          if (
            (event.key !== "Enter" && event.key !== " ") ||
            event.currentTarget.querySelector("[data-highlighted]") !== null
          ) {
            return;
          }
          if (event.target instanceof HTMLInputElement) return;
          event.preventDefault();
          if (selected) create(selected.key);
          else {
            setOpen(false);
            onOpenFolder();
          }
        }}
      >
        <input
          value={name}
          onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => {
            // Typing must not reach the menu's typeahead and item navigation.
            if (event.key !== "ArrowDown" && event.key !== "Escape") event.stopPropagation();
            if (event.key === "Enter" && !event.nativeEvent.isComposing && selected) {
              event.preventDefault();
              create(selected.key);
            }
          }}
          placeholder="Name (optional)"
          aria-label="Grid name"
          // Not tabbable, so the popup rather than this field takes focus on open and Enter or Space keep creating.
          tabIndex={-1}
          className={SIDEBAR_NEW_GRID_NAME_CLS}
        />
        <div className={SIDEBAR_NEW_GRID_TITLE_CLS}>New grid in</div>
        {workspaces.map((workspace) => {
          const isSelected = workspace.key === selected?.key;
          return (
            <MenuItem
              key={workspace.key}
              data-selected={isSelected ? "" : undefined}
              onClick={() => create(workspace.key)}
              className={cn(
                SIDEBAR_NEW_GRID_ROW_CLS,
                isSelected && SIDEBAR_NEW_GRID_ROW_SELECTED_CLS,
              )}
            >
              <FolderIcon aria-hidden className={SIDEBAR_NEW_GRID_ICON_CLS} />
              <span className="min-w-0 flex-1 truncate">{workspace.label}</span>
              {isSelected ? <CheckIcon aria-hidden className={SIDEBAR_NEW_GRID_CHECK_CLS} /> : null}
            </MenuItem>
          );
        })}
        {workspaces.length > 0 ? <MenuSeparator className="my-1.5 bg-sidebar-border" /> : null}
        <MenuItem
          onClick={() => {
            setOpen(false);
            onOpenFolder();
          }}
          className={SIDEBAR_NEW_GRID_ROW_CLS}
        >
          <PlusIcon aria-hidden className={SIDEBAR_NEW_GRID_ICON_CLS} />
          <span className="min-w-0 flex-1 truncate">Open folder…</span>
        </MenuItem>
      </MenuPopup>
    </Menu>
  );
}

export interface SidebarGridOptions {
  readonly threadSort: SidebarGridThreadSortOrder;
  readonly gridSort: SidebarGridSortOrder;
  readonly showBranch: boolean;
  readonly showPullRequest: boolean;
  readonly showSubagents: boolean;
}

const THREAD_SORT_CHOICES = [
  { value: "grid", label: "Grid order" },
  { value: "updated_at", label: "Last activity" },
  { value: "created_at", label: "Created" },
] as const satisfies ReadonlyArray<{ value: SidebarGridThreadSortOrder; label: string }>;

const GRID_SORT_CHOICES = [
  { value: "updated_at", label: "Last activity" },
  { value: "created_at", label: "Created" },
  { value: "manual", label: "Manual" },
] as const satisfies ReadonlyArray<{ value: SidebarGridSortOrder; label: string }>;

// Radio and checkbox rows share one anatomy: a check in a fixed column, then the label.
const SIDEBAR_OPTIONS_RADIO_CLS = "gap-2 data-checked:bg-transparent data-highlighted:bg-(--sel)";
const SIDEBAR_OPTIONS_INDICATOR_BOX_CLS = "inline-flex size-4 shrink-0 items-center justify-center";

function OptionRadioItem({ value, label }: { value: string; label: string }) {
  return (
    <MenuRadioItem value={value} className={SIDEBAR_OPTIONS_RADIO_CLS}>
      <span className="flex items-center gap-2">
        <span className={SIDEBAR_OPTIONS_INDICATOR_BOX_CLS}>
          <MenuRadioItemIndicator />
        </span>
        {label}
      </span>
    </MenuRadioItem>
  );
}

/** The Grids heading's Sidebar options: how the rail sorts and what each thread row shows. */
export function SidebarOptionsMenu({
  options,
  onChange,
  onReset,
}: {
  options: SidebarGridOptions;
  onChange: (patch: Partial<SidebarGridOptions>) => void;
  onReset: () => void;
}) {
  return (
    <Menu>
      <Tooltip>
        <MenuTrigger
          render={
            <TooltipTrigger
              render={
                <button
                  type="button"
                  aria-label="View options"
                  className={cn(SIDEBAR_SECTION_ACTION_CLS, "data-popup-open:bg-(--sel)")}
                />
              }
            />
          }
        >
          <SlidersHorizontalIcon aria-hidden className="size-[15px]" />
        </MenuTrigger>
        <TooltipPopup side="bottom">View options</TooltipPopup>
      </Tooltip>
      <MenuPopup align="start" side="bottom" className="min-w-56">
        <MenuGroup>
          <MenuGroupLabel>Sort threads</MenuGroupLabel>
          <MenuRadioGroup
            value={options.threadSort}
            onValueChange={(value) => onChange({ threadSort: value as SidebarGridThreadSortOrder })}
          >
            {THREAD_SORT_CHOICES.map((choice) => (
              <OptionRadioItem key={choice.value} {...choice} />
            ))}
          </MenuRadioGroup>
        </MenuGroup>
        <MenuSeparator />
        <MenuGroup>
          <MenuGroupLabel>Sort grids</MenuGroupLabel>
          <MenuRadioGroup
            value={options.gridSort}
            onValueChange={(value) => onChange({ gridSort: value as SidebarGridSortOrder })}
          >
            {GRID_SORT_CHOICES.map((choice) => (
              <OptionRadioItem key={choice.value} {...choice} />
            ))}
          </MenuRadioGroup>
        </MenuGroup>
        <MenuSeparator />
        <MenuGroup>
          <MenuGroupLabel>Rows show</MenuGroupLabel>
          <MenuCheckboxItem
            checked={options.showBranch}
            onCheckedChange={(checked) => onChange({ showBranch: checked })}
          >
            Branch
          </MenuCheckboxItem>
          <MenuCheckboxItem
            checked={options.showPullRequest}
            onCheckedChange={(checked) => onChange({ showPullRequest: checked })}
          >
            Pull request and checks
          </MenuCheckboxItem>
          <MenuCheckboxItem
            checked={options.showSubagents}
            onCheckedChange={(checked) => onChange({ showSubagents: checked })}
          >
            Subagents
          </MenuCheckboxItem>
        </MenuGroup>
        <MenuSeparator />
        <MenuItem onClick={onReset}>
          <span className="w-4 shrink-0" aria-hidden />
          Reset to defaults
        </MenuItem>
      </MenuPopup>
    </Menu>
  );
}
