/** 12px body type for the rows nested under a work group's header: the group's tokens retarget. */
export const NESTED_WORK_TYPE_CLASS = "[--text-body--line-height:1rem] [--text-body:0.75rem]";

/** The thin left rail the rows of an expanded work group hang from, under the header. */
export const NESTED_WORK_RAIL_CLASS = `ms-3.5 border-s border-border ps-2.5 ${NESTED_WORK_TYPE_CLASS}`;

/** Ink for a run that is in progress: the running status hue, never the accent. */
export const RUNNING_INK_CLS = "text-status-running-ink";

/** The running ring when it stands for a thread status: the bright glyph step of the hue. */
export const RUNNING_GLYPH_CLS = "text-status-running";
