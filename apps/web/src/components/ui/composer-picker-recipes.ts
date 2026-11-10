/** The model trigger's group marker, so its effort suffix can react to hover and open state. */
export const MODEL_TRIGGER_GROUP_CLASS = "group/model-trigger";

/**
 * The frame shared by the model list and the effort panel under it. A phone-width viewport keeps
 * the same two-part stack, so it only narrows.
 */
export const DOCKED_PICKER_FRAME_CLASS =
  "flex max-h-(--available-height) w-[26.75rem] max-w-[calc(100vw-2rem)] flex-col overflow-hidden rounded-lg border border-border bg-(--raised)";

/**
 * The effort panel under the model list, with the rule that separates them. It takes the
 * height of its rows, so a model with one row leaves no empty band above the footer.
 */
export const DOCKED_EFFORT_PANEL_CLASS =
  "flex max-h-40 shrink-0 flex-col overflow-y-auto overscroll-contain border-t border-border";

/** The list's frame inside a docked popup: the popup owns the border and radius. */
export const MODEL_PICKER_DOCKED_CLASS = "w-full border-0";

/** Hides a rail row's label from sight but keeps it as the row's accessible name. */
export const COMPACT_RAIL_LABEL_CLASS = "sr-only";

/** The provider name beside the search text when the rail shows icons only. */
export const PICKER_PROVIDER_NAME_CLASS = "max-w-24 shrink-0 truncate text-2xs text-(--houston)";

/** The multi-model hint that sits under the model list. */
export const MODEL_PICKER_HINT_CLS =
  "mx-1.5 mb-1.5 shrink-0 border-border/60 border-t px-1 pt-1.5 text-2xs text-(--houston)";

/** One segment of the permission modes' toggle; width and hover are the caller's. */
export const PERMISSION_SEGMENT_CLS =
  "flex h-6 cursor-pointer items-center justify-center rounded-md text-muted-foreground outline-none data-disabled:cursor-not-allowed data-disabled:opacity-40 data-checked:bg-input/72 data-checked:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset";
