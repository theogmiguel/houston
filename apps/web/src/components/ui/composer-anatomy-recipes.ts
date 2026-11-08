/** Visual recipes for the composer toolbar's collapsed workspace chip. */

/** The single workspace chip that replaces the checkout, branch and access controls. */
/**
 * The chip is as wide as its content: icon, 4px, label, 4px, chevron. It never shrinks: when the
 * toolbar is too narrow for the label, the composer drops the label (the chip keeps its icon and
 * chevron) instead of cutting it down to a stub.
 */
export const CONTEXT_CHIP_TRIGGER_CLS = "shrink-0 justify-start gap-1!";
export const CONTEXT_CHIP_BRANCH_CLS = "min-w-0 max-w-[28ch] truncate text-xs";
/** A chip label that dropped to its icon: out of sight, still the chip's accessible name. */
export const CHIP_LABEL_ICON_ONLY_CLS = "sr-only";
export const CONTEXT_CHIP_CHEVRON_CLS = "size-3 shrink-0";
/** The one panel the collapsed chip opens: the three controls stacked. */
export const CONTEXT_CHIP_PANEL_CLS = "flex w-72 flex-col gap-2 p-2";

/**
 * The first row inside a wide composer's border: checkout, branch and pull request on the left,
 * the pending-changes summary and its actions on the right. It shares the card's background and
 * is closed by a 1px divider; it never wraps.
 */
export const CONTEXT_ROW_CLS =
  "flex min-h-8 min-w-0 items-center gap-2 border-b border-(--divider) px-2 py-1 text-(--contrast-secondary-label) text-2xs leading-none whitespace-nowrap " +
  "[&_[data-composer-context-control]]:h-5.5! [&_[data-composer-context-control]]:rounded-md! [&_[data-composer-context-control]]:border-0! [&_[data-composer-context-control]]:px-1.5! [&_[data-composer-context-control]]:font-normal [&_[data-composer-context-control]]:text-2xs! [&_[data-composer-context-control]]:text-secondary-label!";

/** The row's left side: it yields width to the pending-changes actions on its right. */
export const CONTEXT_ROW_START_CLS = "flex min-w-0 flex-1 items-center gap-1";

/**
 * The scroll fade under the row. It covers only the editor's own 8px top padding, so it never
 * lies over a line of text; `snapComposerScroll` keeps the topmost visible line below it.
 */
export const COMPOSER_INPUT_TOP_FADE_CLS =
  "pointer-events-none absolute inset-x-0 -top-2 z-10 h-2 bg-linear-to-b from-(--composer) to-transparent [[data-draft-hero]_&]:from-(--surface-raised)";

/** A real branch name reads in the mono face; the checkout label stands in as plain text. */
export const CONTEXT_CHIP_BRANCH_MONO_CLS = `${CONTEXT_CHIP_BRANCH_CLS} font-mono`;
/** A server thread's checkout control moves to the strip's environment block on wide strips. */
export const CONTEXT_RUN_HIDDEN_WIDE_CLS = "@xl/composer-surface:hidden";

/** The pending-changes summary: its right-aligned form in the context row and its banner form. */
export const CHANGED_FILES_ROW_CLS = "flex shrink-0 items-center gap-2";
export const CHANGED_FILES_BANNER_CLS =
  "mb-1 flex h-9 min-w-0 items-center gap-2 rounded-xl border border-(--line-strong) bg-(--composer) px-2.5";
/** The expander: chevron and the file count open the review. */
export const CHANGED_FILES_TOGGLE_CLS =
  "flex min-w-0 items-center gap-1.5 rounded-sm text-foreground text-xs outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring";
