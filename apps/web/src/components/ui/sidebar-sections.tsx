import type { SidebarGridThreadSortOrder } from "@houston-app/contracts/settings";
import { SlidersHorizontalIcon } from "lucide-react";
import type { ReactNode } from "react";

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
import { SIDEBAR_ROW_SURFACE_CLS } from "./sidebar-rail-recipes";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./tooltip";

/**
 * The project row is the tree's only bold row; a grid row is a 24px regular, muted line, one step
 * in. A button fills its row, so the row's whole width toggles it; the actions overlay the right
 * edge and the count (when collapsed) sits there until they appear.
 */
export const SIDEBAR_GROUP_HEADING_CLS =
  "flex h-full min-w-0 flex-1 cursor-pointer items-center gap-1 rounded-lg py-0 pr-2 pl-0.75 text-left text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset";

/** The grid heading's row: the toggle and its actions share one hover, selection and drop fill. */
export const SIDEBAR_GROUP_HEADING_ROW_CLS =
  "group/grid relative -ml-0.75 flex h-6 items-center rounded-lg transition-colors duration-(--motion-feedback) ease-standard hover:bg-sidebar-row-hover";

export const SIDEBAR_GROUP_HEADING_ACTIVE_CLS = "bg-sidebar-row-selected";

export const SIDEBAR_GROUP_HEADING_DROP_CLS =
  "bg-(--accent-muted) ring-1 ring-(--accent-ink) ring-inset";

export const SIDEBAR_GROUP_NAME_CLS = "min-w-0 truncate text-xs font-normal text-secondary-label";

/** The name of the grid on screen takes primary ink, collapsed or not. */
export const SIDEBAR_GROUP_NAME_ON_SCREEN_CLS = "text-sidebar-foreground";

export const SIDEBAR_GROUP_EMPTY_CLS = "text-xs text-secondary-label";

/** The muted thread count that follows a heading's name. */
export const SIDEBAR_GROUP_COUNT_CLS =
  "shrink-0 text-xs font-medium text-secondary-label tabular-nums";

/**
 * The right-aligned slot of a collapsed row: its dot and count (or a grid's "empty" label). It
 * fades out, never leaves the layout, while the row's actions fade in over it.
 */
export const SIDEBAR_ROW_TRAILING_CLS =
  "ms-auto flex shrink-0 items-center transition-opacity duration-(--motion-feedback) ease-standard group-hover/grid:opacity-0 group-has-focus-visible/grid:opacity-0";

/** Six pixels of amber before a count: something inside waits on the user. */
export const SIDEBAR_NEEDS_YOU_DOT_CLS = "mr-1.5 size-1.5 shrink-0 rounded-full bg-warning";

/** A row's actions overlay its right edge, 3px in, instead of taking row width. */
export const SIDEBAR_ROW_ACTIONS_CLS =
  "absolute inset-y-0 right-0.75 flex shrink-0 items-center gap-0.5";

/**
 * A grid's cards hang from a 1px guide under the centre of its chevron; the grid on screen draws
 * it in the secondary text tone. The 4px of padding below, with the next row's 2px, make 6px.
 */
export const SIDEBAR_GROUP_GUIDE_CLS =
  "ml-1.5 flex flex-col gap-0.5 border-l border-border pb-1 pl-0.75";

export const SIDEBAR_GROUP_GUIDE_ON_SCREEN_CLS = "border-secondary-label";

/** A grid's card guide, in the stronger tone while the grid is on screen. */
export function sidebarGroupGuideCls(onScreen: boolean): string {
  return cn(SIDEBAR_GROUP_GUIDE_CLS, onScreen && SIDEBAR_GROUP_GUIDE_ON_SCREEN_CLS);
}

/** A grid's name, in primary ink while the grid is on screen. */
export function sidebarGroupNameCls(onScreen: boolean): string {
  return cn(SIDEBAR_GROUP_NAME_CLS, onScreen && SIDEBAR_GROUP_NAME_ON_SCREEN_CLS);
}

/** The 16px project glyph box at the start of a thread row's first line. */
export const SIDEBAR_PROJECT_ICON_BOX_CLS =
  "inline-grid size-4 shrink-0 place-items-center text-secondary-label";

/** The opt-in "Needs you" shelf above the workspaces and its heading. */
export const SIDEBAR_NEEDS_YOU_SECTION_CLS = "flex flex-col gap-0.5";

export const SIDEBAR_NEEDS_YOU_HEADING_CLS =
  "flex h-(--h-row) min-w-0 shrink-0 items-center gap-1 rounded-lg pr-1 pl-2 text-xs font-semibold text-secondary-label";

export const SIDEBAR_NEEDS_YOU_HEADING_GLYPH_CLS = "inline-grid size-3 shrink-0 place-items-center";

/** A thread row's project name on its first line. */
export const SIDEBAR_THREAD_PROJECT_CLS = "min-w-0 truncate";

/** Indented to the project name, so it reads as the empty list's content. */
export const SIDEBAR_PROJECT_EMPTY_ACTION_CLS =
  "flex h-(--h-row) w-full cursor-pointer items-center gap-2 rounded-lg py-0 pr-2 pl-7.5 text-left text-xs text-secondary-label transition-colors duration-(--motion-feedback) ease-standard outline-none hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset";

/**
 * Every thread row, in a grid or directly under its project, starts at the rail's own inset: its
 * status glyph sits under the project heading's chevron, so a 264px sidebar leaves the title the
 * rest of the width.
 */
export const SIDEBAR_THREAD_ROW_INDENT_CLS = "pl-2";

/** A fixed 14px box in both states; the chevron rotates inside instead of swapping icons. */
export const SIDEBAR_GROUP_CHEVRON_BOX_CLS =
  "inline-grid size-3.5 shrink-0 place-items-center text-secondary-label";

export const SIDEBAR_GROUP_CHEVRON_CLS =
  "size-3 transition-transform duration-(--motion-disclosure) ease-standard";

export const SIDEBAR_GROUP_CHEVRON_EXPANDED_CLS = "rotate-90";

/** The empty workspace's "New thread": a small outlined button, a 44px tap target on a phone. */
export const SIDEBAR_EMPTY_ACTION_CLS =
  "inline-flex h-6 cursor-pointer items-center rounded-(--r-ctl) border border-(--line-strong) px-2 text-xs text-foreground hover:bg-sidebar-row-hover max-phone:h-11 max-phone:px-4 max-phone:text-sm";
export const SIDEBAR_GROUP_ACTION_CLS =
  "inline-grid size-5 shrink-0 cursor-pointer place-items-center rounded-(--r-badge) text-secondary-label opacity-0 transition-opacity duration-(--motion-feedback) ease-standard hover:bg-(--sel) hover:text-foreground group-hover/grid:opacity-100 group-has-focus-visible/grid:opacity-100 focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset";

export const SIDEBAR_GROUP_RENAME_CLS =
  "h-6 min-w-0 flex-1 rounded-(--r-ctl) border border-input bg-background px-1.5 text-xs font-normal text-foreground outline-none focus:border-ring focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset";

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

export interface SidebarMenuOptions {
  readonly threadSort: SidebarGridThreadSortOrder;
  readonly showBranch: boolean;
  readonly showPullRequest: boolean;
  readonly showSubagents: boolean;
  readonly showNeedsYou: boolean;
}

const THREAD_SORT_CHOICES = [
  { value: "grid", label: "Workspace order" },
  { value: "updated_at", label: "Last activity" },
  { value: "created_at", label: "Created" },
] as const satisfies ReadonlyArray<{ value: SidebarGridThreadSortOrder; label: string }>;

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
  options: SidebarMenuOptions;
  onChange: (patch: Partial<SidebarMenuOptions>) => void;
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
        <MenuGroup>
          <MenuGroupLabel>Sections</MenuGroupLabel>
          <MenuCheckboxItem
            checked={options.showNeedsYou}
            onCheckedChange={(checked) => onChange({ showNeedsYou: checked })}
          >
            Show Needs you
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

/** The search match inside a row's text. */
export const SIDEBAR_SEARCH_MARK_CLS = "rounded-(--r-badge) bg-(--warn-wash) px-px text-inherit";

/** Numbers and times on a row keep a steady width as they tick. */
export const SIDEBAR_TABULAR_CLS = "tabular-nums";

/** A thread row's frame: three lines, the focus ring painted on the row. */
export const SIDEBAR_THREAD_ROW_CLS =
  "group/th relative flex h-15 w-full cursor-pointer items-center gap-2 rounded-lg pr-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset";

/** The row's frame with its drag, file-drop and surface states. */
export function sidebarThreadRowCls(state: {
  readonly dragging: boolean;
  readonly fileDropOver: boolean;
  readonly selected: boolean;
  readonly highlighted: boolean;
  readonly active: boolean;
}): string {
  const surface = state.selected
    ? "selected"
    : state.highlighted
      ? "searchHighlight"
      : state.active
        ? "active"
        : "rest";
  return cn(
    SIDEBAR_THREAD_ROW_CLS,
    state.dragging && "opacity-50",
    state.fileDropOver && "bg-(--accent-muted) ring-1 ring-(--accent-ink) ring-inset",
    SIDEBAR_ROW_SURFACE_CLS[surface],
  );
}

/** A text button on a row's hover actions (Close, Wake, Reopen). */
export const SIDEBAR_THREAD_TEXT_ACTION_CLS =
  "inline-flex h-5.5 cursor-pointer items-center gap-1 rounded-(--r-badge) px-1.5 text-xs text-secondary-foreground data-sweep-hit:bg-(--sel) hover:bg-(--sel) hover:text-foreground";

/** An icon button on a row's hover actions (Hold, Thread actions). */
export const SIDEBAR_THREAD_ICON_ACTION_CLS =
  "inline-grid size-5.5 cursor-pointer place-items-center rounded-(--r-badge) text-secondary-foreground hover:bg-(--sel) hover:text-foreground";

/** The title button inside a row; the row paints the focus ring. */
export const SIDEBAR_THREAD_TITLE_BUTTON_CLS =
  "flex min-w-0 flex-1 cursor-pointer items-center text-left outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset";

/** The title while its name is being regenerated. */
export const SIDEBAR_THREAD_TITLE_REGENERATING_CLS = "opacity-55";

/** Visually hidden text for assistive technology. */
export const SIDEBAR_SR_ONLY_CLS = "sr-only";

/** The small heading inside a thread's Hold menu. */
export const SIDEBAR_MENU_HEADING_CLS =
  "px-2 pt-1 pb-1 text-2xs font-semibold text-secondary-label";

/** The secondary text at the end of a menu item. */
export const SIDEBAR_MENU_HINT_CLS = "ml-auto text-2xs text-secondary-label";
