/** Visual recipes for the phone shell's own bars, which have no desktop counterpart. */

/** The phone home's 44px top bar: the wordmark, then search and new thread at the right. */
export const PHONE_HOME_BAR_CLS =
  "flex h-(--h-top) shrink-0 items-center gap-2 border-b border-b-(--divider) bg-sidebar pr-0.5 pl-4 text-sidebar-foreground";
export const PHONE_HOME_BRAND_CLS = "min-w-0 gap-2 truncate text-base text-foreground";

/** The bottom tab bar spans the window above the safe-area inset. */
export const PHONE_TAB_BAR_CLS = "shrink-0 border-t border-t-(--divider) bg-sidebar pb-safe";
export const PHONE_TAB_ROW_CLS = "flex h-11 items-stretch";
export const PHONE_TAB_CLS =
  "flex min-h-11 min-w-0 flex-1 cursor-pointer flex-col items-center justify-center gap-1 outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset";
export const PHONE_TAB_ACTIVE_CLS = "text-(--accent-ink)";
export const PHONE_TAB_REST_CLS = "text-icon-muted";
export const PHONE_TAB_LABEL_CLS = "max-w-full truncate text-2xs leading-3.5";
export const PHONE_TAB_LABEL_ACTIVE_CLS = "text-foreground";
export const PHONE_TAB_LABEL_REST_CLS = "text-secondary-label";

export function phoneTabClass(active: boolean): string {
  return `${PHONE_TAB_CLS} ${active ? PHONE_TAB_ACTIVE_CLS : PHONE_TAB_REST_CLS}`;
}

export function phoneTabLabelClass(active: boolean): string {
  return `${PHONE_TAB_LABEL_CLS} ${active ? PHONE_TAB_LABEL_ACTIVE_CLS : PHONE_TAB_LABEL_REST_CLS}`;
}

/** A phone sheet's section divider: a rule above the block, full width. */
export const PHONE_SHEET_SECTION_CLS = "border-t border-border";
/** A permission radio in the phone sheet: the sheet row's gap, with the selected option's fill. */
export const PHONE_PERMISSION_ROW_CLS =
  "min-h-11 rounded-none px-4 aria-checked:bg-foreground/[0.06] aria-checked:text-foreground";
/** The icon beside a phone sheet row's label: 16px, so every sheet's label starts at x40. */
export const PHONE_SHEET_ROW_ICON_CLS = "size-4 shrink-0";
/** The model chip in the phone composer: the toolbar's text size, yielding width to its siblings. */
export const PHONE_MODEL_CHIP_CLS = "max-w-full min-w-0 text-sm";
/** The selected file's line counts in the phone's Changes file header. */
export const PHONE_FILE_STAT_CLS = "shrink-0 text-body";
/** The check that marks the selected row of a phone sheet list, on the 16px right gutter. */
export const PHONE_SHEET_ROW_CHECK_CLS = "ms-auto size-3.5 shrink-0 text-foreground";
/** A section label in a phone sheet ("Effort", "Permissions"): one style, set on the gutter by its container. */
export const PHONE_SHEET_SECTION_LABEL_CLS = "font-medium text-xs text-muted-foreground";
/** The plan-mode row in the phone sheet. */
export const PHONE_PLAN_ROW_CLS = "min-h-11 border-t border-border px-4 text-sm";

/** The full-height Changes and Files bar: the thread bar's height and divider, back on the 16px gutter. */
export const PHONE_PANEL_BAR_CLS =
  "h-11 min-h-11 border-b border-b-(--divider) bg-background pr-2 pl-0.5";

/** A phone page's 44px top bar: bottom border, the 16px gutter, no panel toggles. */
export const PHONE_PAGE_BAR_CLS =
  "flex h-(--h-top) shrink-0 items-center gap-2 border-b border-b-(--divider) bg-background px-4";
export const PHONE_PAGE_BAR_TITLE_CLS =
  "min-w-0 flex-1 truncate text-base font-medium text-foreground";

/** A short muted note on a phone page: empty lines, scope notices, hints. */
export const PHONE_NOTE_CLS = "text-sm text-muted-foreground";
/** The smaller muted note under a phone empty state. */
export const PHONE_NOTE_XS_CLS = "text-xs text-muted-foreground";
/** The separator glyph in a thread message's meta row, shown only on a phone. */
export const PHONE_META_SEPARATOR_CLS = "hidden text-muted-foreground max-phone:inline";
/** The rail's inline New thread action under a project with no threads. */
export const PHONE_ROW_ACTION_CLS =
  "flex h-11 w-full cursor-pointer items-center gap-2 px-2 text-left text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring";
export const PHONE_ROW_ACTION_ICON_CLS = "size-4 text-icon-muted";
/** The settings index's phone page bar sits on the sidebar surface. */
export const PHONE_PAGE_BAR_SIDEBAR_CLS = `${PHONE_PAGE_BAR_CLS} bg-sidebar`;
/** A settings index row on a phone: full-bleed, 44px. */
export const PHONE_NAV_ROW_CLS = "h-11 rounded-none px-4";
/** A phone empty state: a centred stack of a heading, one muted line and an optional 44px action. */
export const PHONE_EMPTY_STACK_CLS =
  "flex min-h-0 flex-1 flex-col items-center justify-center gap-2 px-4 text-center";
export const PHONE_EMPTY_TITLE_CLS = "text-heading font-medium text-balance text-foreground";
export const PHONE_EMPTY_BODY_CLS = "text-sm text-balance text-muted-foreground";
export const PHONE_EMPTY_ACTIONS_CLS = "mt-2 flex flex-wrap items-center justify-center gap-2";

/**
 * Every control a phone settings page draws is a 44px tap target: select triggers, buttons,
 * segmented-control segments and text fields. Switches and checkboxes keep their own hit area,
 * and inline affordances marked `touch-exempt` (the micro reset and info glyphs beside a row
 * title, the scope pickers set inside a sentence) keep their size.
 */
export const PHONE_SETTINGS_TAP_TARGETS_CLS =
  "max-phone:[&_[data-slot=select-trigger]]:min-h-11 max-phone:[&_button:not(.touch-exempt):not([role=switch]):not([role=checkbox])]:min-h-11 max-phone:[&_button:not(.touch-exempt):not([role=switch]):not([role=checkbox])]:min-w-11 max-phone:[&_[data-slot=toggle]]:min-h-11 max-phone:[&_[data-slot=input]]:min-h-11";

/** A card's body text on a phone: the 13px body size the other settings cards use. */
export const PHONE_CARD_TEXT_CLS = "max-phone:text-body";
/** A card or section heading on a phone: the section heading style, 15px semibold. */
export const PHONE_SECTION_HEADING_CLS =
  "max-phone:text-prose max-phone:leading-5 max-phone:font-semibold max-phone:text-foreground/80";
/** A table row's divider inside a phone card: a rule inset 16px at both ends instead of an edge-to-edge border. */
export const PHONE_CARD_ROW_DIVIDER_CLS =
  "max-phone:relative max-phone:border-t-0 max-phone:not-first:before:pointer-events-none max-phone:not-first:before:absolute max-phone:not-first:before:inset-x-4 max-phone:not-first:before:top-0 max-phone:not-first:before:h-px max-phone:not-first:before:bg-border max-phone:not-first:before:content-['']";
