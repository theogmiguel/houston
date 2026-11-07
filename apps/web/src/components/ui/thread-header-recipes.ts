/** Visual recipes for the thread header and the new-thread project context. */
export const THREAD_HEADER_ROOT_CLS =
  "@container/thread-header flex min-w-0 flex-1 items-center gap-2";
export const THREAD_PROJECT_GROUP_CLS =
  "flex min-w-0 shrink items-center gap-1.5 text-sm text-muted-foreground @max-[48rem]/thread-header:hidden";
export const THREAD_PROJECT_TEXT_CLS = "max-w-40 min-w-0 truncate";
export const THREAD_PROJECT_SEPARATOR_CLS = "shrink-0 text-icon-muted";
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

export const DRAFT_PROJECT_CONTEXT_CLS =
  "pointer-events-auto w-full max-w-xl rounded-xl border border-border/60 bg-card/40 px-3 py-2 text-callout text-muted-foreground";
export const DRAFT_PROJECT_CONTEXT_LINK_CLS =
  "cursor-pointer rounded-sm outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring";
export const DRAFT_PROJECT_CONTEXT_BRANCH_CLS = "max-w-52 truncate font-mono";
export const DRAFT_PROJECT_CONTEXT_LIST_CLS = "mt-2 flex flex-col border-border/60 border-t pt-1.5";
export const DRAFT_PROJECT_CONTEXT_ROW_CLS =
  "flex h-7 w-full min-w-0 cursor-pointer items-center gap-2 rounded-md px-1 text-left outline-none hover:bg-hover focus-visible:bg-hover focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring";
export const DRAFT_PROJECT_CONTEXT_TITLE_CLS = "min-w-0 flex-1 truncate text-foreground/80";
