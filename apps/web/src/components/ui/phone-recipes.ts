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
