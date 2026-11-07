/** Visual recipes for the thread header and the new-thread project context. */
export const THREAD_HEADER_ROOT_CLS =
  "@container/thread-header flex min-w-0 flex-1 flex-col justify-center gap-1";
export const THREAD_TITLE_ROW_CLS = "flex min-w-0 items-center gap-2";
export const THREAD_TITLE_GROUP_CLS = "flex min-w-0 flex-1 items-center gap-1.5";
export const THREAD_TITLE_INPUT_CLS =
  "min-w-0 flex-1 rounded-sm bg-transparent text-heading font-semibold text-foreground outline-none ring-1 ring-inset ring-ring/50 focus-visible:ring-ring";
export const THREAD_TITLE_BUTTON_CLS =
  "group/thread-title flex min-w-0 max-w-full flex-1 cursor-pointer items-center gap-1 rounded-sm text-left focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring";
export const THREAD_TITLE_TEXT_CLS =
  "line-clamp-2 min-w-0 flex-1 text-heading font-semibold wrap-anywhere";
export const THREAD_TITLE_CHEVRON_CLS =
  "size-3.5 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover/thread-title:opacity-100 group-focus-visible/thread-title:opacity-100";
export const THREAD_META_ROW_CLS =
  "flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-callout text-muted-foreground";
export const THREAD_META_PROJECT_CLS =
  "max-w-40 min-w-0 truncate @max-[34rem]/thread-header:max-w-24";
export const THREAD_META_CARET_CLS = "size-3 shrink-0 text-icon-muted";
export const THREAD_META_LINK_CLS =
  "inline-flex min-w-0 items-center gap-1 rounded-sm outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring";
export const THREAD_META_DIVIDER_CLS = "shrink-0 text-icon-muted";
export const THREAD_META_BRANCH_CLS = "max-w-40 min-w-0 truncate font-mono";
export const THREAD_META_STATUS_CLS = "inline-flex min-w-0 items-center gap-1";
export const THREAD_META_DIFF_BUTTON_CLS =
  "inline-flex shrink-0 cursor-pointer items-center rounded-sm outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring";
export const THREAD_META_MODEL_GROUP_CLS =
  "inline-flex min-w-0 items-center gap-2 @max-[46rem]/thread-header:hidden";
export const THREAD_META_MODEL_CLS = "inline-flex min-w-0 items-center gap-0.5";
export const THREAD_META_MODEL_NAME_CLS = "max-w-56 min-w-0 truncate";

export const DRAFT_PROJECT_CONTEXT_CLS =
  "pointer-events-auto mt-4 w-full max-w-xl rounded-xl border border-border/60 bg-card/40 px-3 py-2 text-callout text-muted-foreground";
export const DRAFT_PROJECT_CONTEXT_LINK_CLS =
  "cursor-pointer rounded-sm outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring";
export const DRAFT_PROJECT_CONTEXT_BRANCH_CLS = "max-w-52 truncate font-mono";
export const DRAFT_PROJECT_CONTEXT_LIST_CLS = "mt-2 flex flex-col border-border/60 border-t pt-1.5";
export const DRAFT_PROJECT_CONTEXT_ROW_CLS =
  "flex h-7 w-full min-w-0 cursor-pointer items-center gap-2 rounded-md px-1 text-left outline-none hover:bg-hover focus-visible:bg-hover focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring";
export const DRAFT_PROJECT_CONTEXT_TITLE_CLS = "min-w-0 flex-1 truncate text-foreground/80";
