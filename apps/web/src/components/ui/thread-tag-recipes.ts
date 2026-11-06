/** A tag chip in the grid sidebar's thread card. */
export const SIDEBAR_THREAD_TAG_CLASS =
  "max-w-28 truncate rounded-(--r-badge) bg-foreground/15 px-1.5 text-2xs leading-4 font-medium text-secondary-foreground";

/** A tag chip in a grid cell's pane label. */
export const PANE_THREAD_TAG_CLASS =
  "max-w-20 truncate rounded-(--r-badge) border border-(--divider) px-1 text-2xs leading-4 text-(--houston)";

/** The count that follows two pane tags, such as "+2". */
export const PANE_THREAD_TAG_COUNT_CLASS = "text-2xs text-(--houston)";

/** The status word on a sidebar thread card's meta line. */
export const SIDEBAR_THREAD_STATUS_CLASS =
  "inline-flex shrink-0 items-center gap-1 text-xs leading-3.5 whitespace-nowrap tabular-nums";

/** Running, needs you and failed take the state's ink; ready, idle and back keep the word muted. */
export const SIDEBAR_THREAD_STATUS_ATTENTION_CLASS = "font-medium";
export const SIDEBAR_THREAD_STATUS_QUIET_CLASS = "text-secondary-label";

/** The ink and size of a sidebar thread card's secondary text: meta line, badges and marks. */
export const SIDEBAR_THREAD_META_TEXT_CLASS = "text-xs leading-3.5 text-secondary-label";
