/** Visual recipes for the sidebar rail's rows, results, hover card and inline controls. */

/** A small icon button at the end of a menu row, such as a project's settings gear. */
export const RAIL_MENU_ROW_BUTTON_CLS =
  "cursor-pointer rounded-(--r-badge) text-secondary-label hover:bg-(--sel) hover:text-foreground";

/** The dot that marks the project filter as active. */
export const RAIL_FILTER_DOT_CLS = "rounded-full";

export const RAIL_EMPTY_TITLE_CLS = "text-xs font-medium text-foreground";
export const RAIL_EMPTY_HINT_CLS = "text-xs text-secondary-label";

export const RAIL_SECTION_LABEL_CLS = "text-xs font-medium text-secondary-label";
export const RAIL_NOTICE_CLS = "text-sm text-secondary-label";

/** A search result row that is a button of its own. */
export const RAIL_RESULT_ROW_CLS = `cursor-pointer rounded-lg text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring`;
export const RAIL_RESULT_TITLE_CLS = "text-sm text-sidebar-foreground";
export const RAIL_RESULT_SNIPPET_CLS = "line-clamp-2 text-xs break-words text-secondary-label";

export const HOVER_CARD_BODY_CLS = "text-xs leading-4 text-secondary-foreground";
export const HOVER_CARD_TITLE_CLS = "text-xs leading-4 font-semibold break-words text-foreground";
export const HOVER_CARD_MUTED_CLS = "text-secondary-label";
export const HOVER_CARD_WARN_CLS = "text-warning-foreground";
export const HOVER_CARD_TEXT_CLS = "break-words";

/** The keyboard hint that labels a row with its jump shortcut. */
export const RAIL_KBD_CLS = "border border-sidebar-border font-sans text-3xs text-secondary-label";

/**
 * A row's diff totals use the timeline's diff colours at rest, so a changed checkout reads
 * without hovering. The mono 2xs digits stay below the title in size and weight.
 */
export const ROW_DIFF_COUNTS_CLS = "font-mono text-2xs tabular-nums";
export const ROW_DIFF_ADDED_CLS = "text-diff-addition-foreground";
export const ROW_DIFF_REMOVED_CLS = "text-diff-deletion-foreground";

/** The unsent-draft mark; the pencil gives way to a cross on hover or focus. */
export const ROW_DRAFT_MARK_CLS = `group/draft cursor-pointer text-warning-foreground outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring`;
export const ROW_DRAFT_PENCIL_CLS =
  "group-hover/draft:invisible group-focus-visible/draft:invisible";
export const ROW_DRAFT_CROSS_CLS =
  "invisible group-hover/draft:visible group-focus-visible/draft:visible";

export const ROW_BACK_DISMISS_CLS = `cursor-pointer rounded-(--r-badge) outline-none hover:underline focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring`;

export const ROW_TITLE_INPUT_CLS =
  "border border-input bg-background text-xs text-foreground outline-none focus-visible:border-ring";
export const ROW_TITLE_INPUT_INVALID_CLS =
  "border-error-foreground focus-visible:border-error-foreground";
export const ROW_TITLE_MESSAGE_CLS = "text-2xs text-error-foreground";

/**
 * Scroll margins of a thread row, so scrolling it into view leaves it clear of the sticky project
 * heading above (32px plus its border) and of the 24px fade above the footer.
 */
export const ROW_SCROLL_MARGIN_CLS = "scroll-mt-9 scroll-mb-8";

/** A thread row's title: 14px medium on the first line. */
export const ROW_TITLE_TEXT_CLS = "text-sm leading-5 font-medium text-foreground";

/** An icon-only shortcut of the rail's shortcut row: a 16px icon in a 28px-tall button. */
export const RAIL_SHORTCUT_CLS =
  "group/shortcut flex h-7 min-w-0 flex-1 cursor-pointer items-center justify-center rounded-(--control-radius) px-1 outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset";
export const RAIL_SHORTCUT_ACTIVE_CLS = "bg-sidebar-row-selected text-sidebar-foreground";
export const RAIL_SHORTCUT_REST_CLS =
  "text-secondary-foreground hover:bg-sidebar-row-hover hover:text-sidebar-foreground";

export const RAIL_SHORTCUT_ICON_CLS =
  "relative inline-grid size-4 shrink-0 place-items-center [&>svg]:size-4";
export const RAIL_SHORTCUT_ICON_ACTIVE_CLS = "text-sidebar-foreground";
export const RAIL_SHORTCUT_ICON_REST_CLS = "text-secondary-label";

/** A thread row's surface per state. */
export const SIDEBAR_ROW_SURFACE_CLS = {
  selected: "bg-(--row-current)",
  searchHighlight: "bg-(--sidebar-row-active)",
  active: "bg-(--raised) shadow-[var(--shadow-1)]",
  rest: "hover:bg-(--sidebar-row-hover)",
} as const;
