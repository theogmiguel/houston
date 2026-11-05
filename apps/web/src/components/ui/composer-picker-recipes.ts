/** The model trigger's group marker, so its effort suffix can react to hover and open state. */
export const MODEL_TRIGGER_GROUP_CLASS = "group/model-trigger";

/** The frame shared by the model list and its docked effort column. */
export const DOCKED_PICKER_FRAME_CLASS =
  "flex max-h-(--available-height) flex-col overflow-hidden rounded-lg border border-border bg-(--raised)";

/** The row that puts the effort column beside the list, stacking below it on narrow screens. */
export const DOCKED_PICKER_ROW_CLASS = "flex min-h-0 flex-row max-sm:flex-col";

/** The effort column beside the model list, with the rule that separates them. */
export const DOCKED_EFFORT_COLUMN_CLASS =
  "flex w-48 shrink-0 flex-col border-l border-border max-sm:max-h-60 max-sm:w-full max-sm:border-t max-sm:border-l-0";

/** The list column's frame inside a docked popup: the popup owns the border and radius. */
export const MODEL_PICKER_DOCKED_CLASS = "border-0 max-sm:h-auto max-sm:max-h-56";
