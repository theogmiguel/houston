/** Visual recipes for the model picker's provider column. */

/** The provider tab row above the search field: one square icon per provider, scrolling when it overflows. */
export const MODEL_PICKER_SIDEBAR_CLS = "w-full shrink-0 overflow-hidden border-b border-border";
export const MODEL_PICKER_SIDEBAR_SCROLL_CLS =
  "overflow-x-auto overflow-y-hidden overscroll-contain [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden";
export const MODEL_PICKER_TAB_TRACK_CLS = "relative flex items-center gap-1 p-1.5";
export const MODEL_PICKER_TAB_CLS =
  "relative isolate flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-md text-(--houston) transition-colors hover:bg-(--hover) hover:text-(--t1) focus-visible:bg-(--hover) focus-visible:text-(--t1) focus-visible:outline-none aria-pressed:bg-(--sel) aria-pressed:text-(--t1)";
export const MODEL_PICKER_TAB_DISABLED_CLS =
  "cursor-not-allowed opacity-50 hover:bg-transparent hover:text-(--houston)";

/** The labelled row recipes below serve the phone sheet's provider chips. */
export const MODEL_PICKER_SIDEBAR_FAVORITES_CLS =
  "relative isolate flex h-7 w-full cursor-pointer items-center gap-1.75 rounded-md px-2 text-left text-xs text-(--t2) transition-colors hover:bg-(--hover) hover:text-(--t1) focus-visible:bg-(--hover) focus-visible:text-(--t1) focus-visible:outline-none aria-pressed:bg-(--sel) aria-pressed:text-(--t1)";
export const MODEL_PICKER_SIDEBAR_LABEL_CLS = "min-w-0 flex-1 truncate leading-tight";
export const MODEL_PICKER_SIDEBAR_ROW_CLS =
  "relative isolate flex w-full cursor-pointer items-center gap-1.75 rounded-md px-2 text-left text-xs text-(--t2) transition-colors hover:bg-(--hover) hover:text-(--t1) focus-visible:bg-(--hover) focus-visible:text-(--t1) focus-visible:outline-none aria-pressed:bg-(--sel) aria-pressed:text-(--t1)";
export const MODEL_PICKER_SIDEBAR_ROW_DISABLED_CLS =
  "cursor-not-allowed text-(--houston) hover:bg-transparent";
export const MODEL_PICKER_SIDEBAR_NAME_CLS = "flex min-w-0 flex-1 flex-col leading-tight";
/** A long provider name wraps to two lines instead of truncating. */
export const MODEL_PICKER_SIDEBAR_NAME_TEXT_CLS = "line-clamp-2 break-words";
export const MODEL_PICKER_SIDEBAR_REASON_CLS = "truncate text-(--houston) text-2xs";

/** A phone sheet lays the provider column out as one scrolling row above the model list. */
export const MODEL_PICKER_SIDEBAR_PHONE_CLS =
  "w-full shrink-0 overflow-hidden border-b border-border bg-(--pane-head)";
export const MODEL_PICKER_SIDEBAR_PHONE_TRACK_CLS = "relative flex gap-1 px-4 py-1";
export const MODEL_PICKER_SIDEBAR_PHONE_ROW_CLS = "h-11 w-auto shrink-0 px-3 text-sm";
