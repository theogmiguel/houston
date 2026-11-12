/** 12px body type for the rows nested under a work group's header: the group's tokens retarget. */
export const NESTED_WORK_TYPE_CLASS = "[--text-body--line-height:1rem] [--text-body:0.75rem]";

/** The thin left rail the rows of an expanded work group hang from, under the header. */
export const NESTED_WORK_RAIL_CLASS = `ms-3.5 border-s border-border ps-2.5 ${NESTED_WORK_TYPE_CLASS}`;

/** Ink for a run that is in progress: the running status hue, never the accent. */
export const RUNNING_INK_CLS = "text-status-running-ink";

/** The running ring when it stands for a thread status: the bright glyph step of the hue. */
export const RUNNING_GLYPH_CLS = "text-status-running";

/** The note a turn carries after a restart, and the tooltip listing each restart's time. */
export const RESTART_NOTE_TRIGGER_CLS = "min-w-0 truncate";
export const RESTART_NOTE_TITLE_CLS = "block font-medium";
export const RESTART_NOTE_LIST_CLS = "mt-0.5 flex flex-col gap-0.5";
export const RESTART_NOTE_TIME_CLS = "tabular-nums";
/** Ink of the note on a finished turn's fold line and on the running turn's working row. */
export const RESTART_NOTE_FOLD_CLS = "text-callout text-(--houston)";
export const RESTART_NOTE_WORKING_CLS = "text-(--t2)";

/**
 * The working row's interrupt hint. Below 28rem of row width (a layout pane of six or more) the
 * timer and restart note need the space, so the hint stays as screen-reader text and the row's
 * tooltip.
 */
export const WORKING_INTERRUPT_HINT_CLS =
  "shrink-0 text-callout text-(--houston) @max-md/working:sr-only";
