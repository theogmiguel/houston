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
