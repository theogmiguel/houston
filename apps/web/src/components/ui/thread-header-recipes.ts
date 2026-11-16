/** Visual recipes for the thread header and the new-thread project context. */
export const THREAD_HEADER_ROOT_CLS =
  "@container/thread-header flex min-w-0 flex-1 items-center gap-2";
export const THREAD_PROJECT_GROUP_CLS =
  "flex shrink-0 items-center gap-1.5 text-sm text-muted-foreground";
/** 120px cap with an ellipsis; under 600px of header width the name leaves the line for the icon (screen readers keep it). */
export const THREAD_PROJECT_TEXT_CLS =
  "max-w-[120px] min-w-0 truncate @max-[600px]/thread-header:sr-only";
/** The project mark and its name: the row never takes width from the title. */
export const THREAD_PROJECT_ROW_CLS = "flex min-w-0 items-center gap-1";
export const THREAD_PROJECT_ICON_CLS = "size-3.5 shrink-0";
export const THREAD_PROJECT_SEPARATOR_CLS =
  "shrink-0 text-icon-muted @max-[600px]/thread-header:hidden";
export const THREAD_TITLE_INPUT_CLS =
  "min-w-0 flex-1 rounded-sm bg-transparent text-sm font-medium text-foreground outline-none ring-1 ring-inset ring-ring/50 focus-visible:ring-ring";
export const THREAD_TITLE_BUTTON_CLS =
  "group/thread-title flex min-w-0 shrink cursor-pointer items-center gap-1 rounded-sm text-left focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring";
export const THREAD_TITLE_TEXT_CLS = "min-w-0 truncate text-sm font-medium text-foreground";
export const THREAD_TITLE_CHEVRON_CLS =
  "size-3.5 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover/thread-title:opacity-100 group-focus-visible/thread-title:opacity-100";
export const THREAD_PARENT_LINK_CLS =
  "inline-flex min-w-0 shrink items-center gap-1 rounded-sm text-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring";
export const THREAD_PARENT_TEXT_CLS = "max-w-40 min-w-0 truncate";

/** The phone's thread bar: one control row over the pane, divided from the chat below. */
export const PHONE_THREAD_BAR_CLS =
  "flex h-(--h-top) shrink-0 items-center gap-1 border-b border-b-(--divider) bg-background px-2";
/** The phone bar's title takes every pixel the controls leave; the project is on the home page. */
export const PHONE_THREAD_BAR_BREADCRUMB_CLS = "flex min-w-0 flex-1 items-center overflow-hidden";
export const PHONE_THREAD_BAR_TITLE_CLS =
  "min-w-0 flex-1 truncate text-sm font-medium text-foreground";
/** The bar's one button: the active tab's mark and title, the pane's tab count and a chevron. */
export const PHONE_TABS_TRIGGER_CLS =
  "flex h-11 min-w-0 flex-1 items-center gap-2 rounded-md px-2 text-start outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring";
export const PHONE_TABS_MARK_CLS = "inline-grid size-3.5 shrink-0 place-items-center";
/** The pane's tab count, a quiet chip before the chevron. */
export const PHONE_TABS_COUNT_CLS =
  "inline-flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-foreground/[0.06] px-1.5 text-2xs text-secondary-label";
export const PHONE_TABS_CHEVRON_CLS = "size-3.5 shrink-0 text-icon-muted";
/** A tab's row in the sheet: the pick area fills the row, the close button sits at its end. */
export const PHONE_TAB_SHEET_ROW_CLS = "flex items-center";
export const PHONE_TAB_SHEET_PICK_CLS = "min-w-0 flex-1";
export const PHONE_TAB_SHEET_TITLE_CLS = "min-w-0 flex-1 truncate text-start";

/** The new-thread summary tray: exactly the composer's width and radius, 8px above it. */
export const DRAFT_PROJECT_CONTEXT_CLS =
  "pointer-events-auto w-full rounded-xl border border-border/60 bg-card/40 px-3 py-2 text-callout text-muted-foreground";
/** A count chip; the pressed chip counts the list below it down to that family. */
export const DRAFT_PROJECT_CONTEXT_CHIP_CLS =
  "inline-flex h-6 min-w-0 shrink-0 cursor-pointer items-center gap-1 rounded-full border border-border/60 px-2 text-callout text-secondary-label transition-colors duration-(--motion-feedback) ease-standard outline-none hover:bg-hover hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring aria-pressed:border-transparent aria-pressed:bg-(--accent-muted) aria-pressed:text-foreground";
export const DRAFT_PROJECT_CONTEXT_LIST_CLS = "mt-2 flex flex-col border-border/60 border-t pt-1.5";
export const DRAFT_PROJECT_CONTEXT_ROW_CLS =
  "flex h-7 w-full min-w-0 cursor-pointer items-center gap-2 rounded-md px-1 text-left outline-none hover:bg-hover focus-visible:bg-hover focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring";
export const DRAFT_PROJECT_CONTEXT_TITLE_CLS = "min-w-0 flex-1 truncate text-foreground/80";
