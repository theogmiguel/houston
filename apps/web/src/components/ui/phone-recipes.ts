/** Visual recipes for the phone shell's own bars, which have no desktop counterpart. */

/** The phone home's 44px top bar: the wordmark, then search and new thread at the right. */
export const PHONE_HOME_BAR_CLS =
  "flex h-(--h-top) shrink-0 items-center gap-2 border-b border-b-(--divider) bg-sidebar px-2 text-sidebar-foreground";
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
/** A permission radio in the phone sheet. */
export const PHONE_PERMISSION_ROW_CLS = "min-h-11 rounded-none px-4";
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
/** A phone empty state card (usage with no data). */
export const PHONE_EMPTY_CARD_CLS =
  "rounded-(--r-group) border border-border bg-card px-4 py-6 text-center text-sm text-balance text-muted-foreground";
/** A phone full-page empty state: centred stack, title, body. */
export const PHONE_EMPTY_STACK_CLS =
  "flex min-h-0 flex-1 flex-col items-center justify-center gap-2 px-4 text-center";
export const PHONE_EMPTY_TITLE_CLS = "text-sm font-medium text-balance";
export const PHONE_EMPTY_BODY_CLS = "text-xs text-balance text-muted-foreground";
