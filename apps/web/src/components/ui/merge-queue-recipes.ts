/** Visual recipes for the merge queue. Feature code composes these with layout utilities. */
export const MERGE_QUEUE_SECTION_HEADING =
  "flex items-center gap-2 px-3 pb-1 text-xs font-medium text-muted-foreground/70";
export const MERGE_QUEUE_SECTION_COUNT = "shrink-0 tabular-nums text-muted-foreground/50";
export const MERGE_QUEUE_ROW_FRAME = "mx-1.5 flex items-center rounded-lg";
export const MERGE_QUEUE_ROW_FRAME_IDLE = "hover:bg-hover/60";
export const MERGE_QUEUE_ROW_FRAME_SELECTED = "bg-hover";
export const MERGE_QUEUE_ROW_BUTTON =
  "min-w-0 flex-1 cursor-pointer px-2.5 py-2 transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring";
export const MERGE_QUEUE_RANK =
  "w-4 shrink-0 pt-0.5 text-center font-mono text-xs font-semibold tabular-nums text-muted-foreground";
export const MERGE_QUEUE_RANK_ICON =
  "flex w-4 shrink-0 justify-center pt-0.5 text-muted-foreground";
export const MERGE_QUEUE_ROW_TITLE = "min-w-0 truncate text-sm";
export const MERGE_QUEUE_ROW_NUMBER =
  "shrink-0 font-mono text-xs tabular-nums text-muted-foreground";
export const MERGE_QUEUE_ROW_META =
  "flex min-w-0 items-center gap-1.5 overflow-hidden text-2xs text-muted-foreground";
export const MERGE_QUEUE_ROW_DEPENDS =
  "inline-flex shrink-0 items-center gap-1 text-2xs text-muted-foreground";
export const MERGE_QUEUE_ROW_HIDDEN = "invisible";
export const MERGE_QUEUE_COUNT_BADGE =
  "ml-1 rounded-[var(--r-ctl)] px-1 font-mono text-2xs tabular-nums text-muted-foreground";
export const MERGE_QUEUE_COUNT_BADGE_PARKED =
  "ml-1 rounded-[var(--r-ctl)] px-1 font-mono text-2xs tabular-nums bg-warning-surface text-warning-foreground";
export const MERGE_QUEUE_PAGE_NOTE = "px-1 py-6 text-sm text-muted-foreground";
export const MERGE_QUEUE_POLICY = "px-1 text-xs leading-4 text-muted-foreground";
export const MERGE_QUEUE_GATE_LIST =
  "overflow-hidden rounded-[var(--r-group)] border border-border bg-card p-0";
export const MERGE_QUEUE_GATE_ROW =
  "flex min-h-10 items-center gap-2.5 border-t border-border px-4 py-2 first:border-t-0";
export const MERGE_QUEUE_GATE_LABEL = "min-w-0 flex-1 text-sm";
export const MERGE_QUEUE_GATE_REASON =
  "min-w-0 max-w-[55%] truncate text-right text-xs text-muted-foreground";
export const MERGE_QUEUE_SECTION_TITLE = "text-headline font-semibold";
export const MERGE_QUEUE_NOTE = "text-xs leading-5 text-muted-foreground";
export const MERGE_QUEUE_FAILURE_TITLE = "block text-sm font-semibold";
export const MERGE_QUEUE_FAILURE_NOTE = "mt-1 block text-xs";
export const MERGE_QUEUE_FAILURE_FILES =
  "mt-2 flex flex-col gap-0.5 font-mono text-xs text-muted-foreground";
export const MERGE_QUEUE_OUTPUT =
  "mt-2 max-h-52 overflow-auto whitespace-pre-wrap rounded-md border border-border bg-(--pane) p-2 font-mono text-xs leading-5 text-muted-foreground";
export const MERGE_QUEUE_META_LINE =
  "inline-flex items-center gap-1.5 text-xs text-muted-foreground";
export const MERGE_QUEUE_FIELD_ERROR = "text-right text-xs text-destructive";
export const MERGE_QUEUE_SCOPE_NOTE = "block text-xs text-muted-foreground/80";
export const MERGE_QUEUE_COMMAND_INPUT = "w-full font-mono";
export const MERGE_QUEUE_UNIT = "text-xs text-muted-foreground";
export const MERGE_QUEUE_HISTORY_ACTION = "text-xs font-normal text-muted-foreground";
export const MERGE_QUEUE_HISTORY_TITLE = "flex min-w-0 items-baseline gap-2 font-mono text-xs";
export const MERGE_QUEUE_HISTORY_TIME = "tabular-nums text-muted-foreground";
export const MERGE_QUEUE_HISTORY_NUMBER = "text-muted-foreground";
export const MERGE_QUEUE_HISTORY_LINE = "min-w-0 truncate font-sans text-sm text-foreground";
export const MERGE_QUEUE_SETTINGS_ERROR = "px-1 text-xs text-destructive";
export const MERGE_QUEUE_LINK_BUTTON = "underline";
export const MERGE_QUEUE_DIALOG_NOTE = "text-xs leading-4 text-muted-foreground";
export const MERGE_QUEUE_DIALOG_EMPTY = "text-sm text-muted-foreground";
export const MERGE_QUEUE_MODE_ITEM = "grid gap-0.5";
export const MERGE_QUEUE_MODE_LABEL = "inline-flex items-center gap-1.5 font-medium";
export const MERGE_QUEUE_MODE_ICON = "size-3.5 shrink-0 text-muted-foreground";
export const MERGE_QUEUE_MODE_DESCRIPTION = "text-xs leading-4 text-muted-foreground";

const GATE_ICON_BY_TONE = {
  ok: "text-success",
  warn: "text-warning",
  error: "text-destructive",
  info: "text-info",
  neutral: "text-muted-foreground/60",
} as const;

export function mergeQueueGateIconClass(tone: keyof typeof GATE_ICON_BY_TONE): string {
  return GATE_ICON_BY_TONE[tone];
}

export const MERGE_QUEUE_BRANCH = "font-mono";

export const MERGE_QUEUE_NUMBER_INPUT = "text-right";

export const MERGE_QUEUE_COMMAND_INPUT_FULL = "w-full font-mono";
export const MERGE_QUEUE_LIMIT_INPUT = "w-20 text-right";

export const MERGE_QUEUE_SCROLL = "scrollbar-gutter-both h-full overflow-y-auto";

export const MERGE_QUEUE_ROW_TIME = "ml-auto shrink-0 tabular-nums";
export const MERGE_QUEUE_MENU_HINT = "ml-auto text-xs text-muted-foreground";
