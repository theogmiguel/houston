/** The model trigger's group marker, so its effort suffix can react to hover and open state. */
export const MODEL_TRIGGER_GROUP_CLASS = "group/model-trigger";

/**
 * The frame shared by the model list and the effort panel under it. A phone-width viewport keeps
 * the same two-part stack, so it only narrows.
 */
export const DOCKED_PICKER_FRAME_CLASS =
  "flex max-h-(--available-height) w-[25rem] max-w-[calc(100vw-2rem)] flex-col overflow-hidden rounded-lg border border-border bg-(--raised)";

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

/**
 * A segmented control inside the docked picker: a filled track holding equal-width segments. A
 * segment keeps its label whole (`min-w-fit`), so a narrow popup scrolls the track sideways
 * instead of clipping text.
 */
export const PICKER_SEGMENT_TRACK_CLS =
  "flex min-w-0 overflow-x-auto rounded-md bg-(--field) p-0.5 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden";
export const PICKER_SEGMENT_CLS =
  "flex h-7 min-w-fit flex-1 cursor-pointer items-center justify-center gap-1 whitespace-nowrap rounded-[calc(var(--r-ctl)-1px)] px-2.5 text-(--t2) text-xs outline-none transition-colors hover:text-(--t1) focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset data-checked:bg-(--sel) data-checked:text-(--t1) data-disabled:cursor-not-allowed data-disabled:opacity-40 disabled:cursor-not-allowed disabled:opacity-64";
/** The reasoning control's active segment carries the accent. */
export const PICKER_SEGMENT_ACCENT_CLS = "data-checked:text-(--accent-ink)";
/** A footer chip: a track around one or more segments, sized to its content. */
export const PICKER_CHIP_TRACK_CLS = "flex shrink-0 rounded-md bg-(--field) p-0.5";
export const PICKER_CHIP_SEGMENT_CLS = "flex-none";

/** The repository choice a multi-repository worktree starts from, sized like the branch picker. */
export const REPOSITORY_PICKER_POPUP_CLASS = "flex flex-col w-[min(22rem,calc(100vw-2rem))]";
export const REPOSITORY_PICKER_HEADER_CLASS =
  "flex min-w-0 items-center justify-between gap-2 border-b border-border/60 px-3 py-2";
export const REPOSITORY_PICKER_TITLE_CLASS = "text-xs font-medium text-foreground";
export const REPOSITORY_PICKER_LIST_CLASS =
  "min-h-0 max-h-56 overflow-y-auto overscroll-y-contain p-1";
export const REPOSITORY_PICKER_MESSAGE_CLASS = "px-2 py-3 text-xs text-muted-foreground";
export const REPOSITORY_PICKER_ROW_CLASS =
  "flex min-h-8 w-full min-w-0 cursor-pointer items-start gap-2 rounded-(--r-ctl) px-2 py-1.5 font-normal hover:bg-hover";
export const REPOSITORY_PICKER_ROW_DISABLED_CLASS = "cursor-not-allowed text-muted-foreground";
export const REPOSITORY_PICKER_NAME_CLASS =
  "min-w-0 max-w-[65%] shrink-0 text-xs font-medium text-foreground";
export const REPOSITORY_PICKER_BRANCH_CLASS =
  "min-w-0 flex-1 font-mono text-2xs text-muted-foreground";
export const REPOSITORY_PICKER_REASON_CLASS = "whitespace-normal text-2xs text-muted-foreground";
export const REPOSITORY_PICKER_BASE_SECTION_CLASS = "border-t border-border/60 px-3 py-2.5";
export const REPOSITORY_PICKER_BASE_LABEL_CLASS =
  "mb-1 flex text-2xs font-medium text-muted-foreground";
export const REPOSITORY_PICKER_ICON_CLASS = "size-3 shrink-0 text-icon-muted";
