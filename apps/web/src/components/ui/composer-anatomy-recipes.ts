/** Visual recipes for the composer toolbar's collapsed workspace chip. */

/** The single workspace chip that replaces the checkout, branch and access controls. */
/**
 * The chip is as wide as its content: icon, 4px, label, 4px, chevron. It never shrinks: when a
 * compact toolbar is too narrow for the label, the composer drops the label (the chip keeps its
 * icon and chevron) instead of cutting it down to a stub.
 */
export const CONTEXT_CHIP_TRIGGER_CLS = "shrink-0 justify-start gap-1!";
export const CONTEXT_CHIP_BRANCH_CLS = "min-w-0 max-w-[28ch] truncate text-xs";
/** A chip label that dropped to its icon: out of sight, still the chip's accessible name. */
export const CHIP_LABEL_ICON_ONLY_CLS = "sr-only";
export const CONTEXT_CHIP_CHEVRON_CLS = "size-3 shrink-0";
/** The one panel the collapsed chip opens: the three controls stacked. */
export const CONTEXT_CHIP_PANEL_CLS = "flex w-72 flex-col gap-2 p-2";

/**
 * The tray attached to the top of a wide composer: inset from the card's edges, top corners
 * rounded, no bottom edge (the card covers it), one muted line that never wraps.
 */
export const CONTEXT_TRAY_CLS =
  "relative z-0 -mb-2 mx-2.5 flex min-w-0 items-center gap-1 overflow-hidden rounded-t-lg border border-b-0 border-(--card-edge) bg-(--app-chrome-background) px-1.5 pt-0.5 pb-2.5 text-(--contrast-secondary-label) text-2xs leading-none whitespace-nowrap " +
  "[&_[data-composer-context-control]]:h-5.5! [&_[data-composer-context-control]]:rounded-md! [&_[data-composer-context-control]]:border-0! [&_[data-composer-context-control]]:px-1.5! [&_[data-composer-context-control]]:font-normal [&_[data-composer-context-control]]:text-2xs! [&_[data-composer-context-control]]:text-secondary-label!";

/** A real branch name reads in the mono face; the checkout label stands in as plain text. */
export const CONTEXT_CHIP_BRANCH_MONO_CLS = `${CONTEXT_CHIP_BRANCH_CLS} font-mono`;
/** A server thread's checkout control moves to the strip's environment block on wide strips. */
export const CONTEXT_RUN_HIDDEN_WIDE_CLS = "@xl/composer-surface:hidden";

/** The changed-files bar above the composer; above an open composer it squares its bottom corners. */
export const CHANGED_FILES_BAR_CLS =
  "flex h-9 min-w-0 items-center gap-2 rounded-xl border border-(--line-strong) bg-(--composer) px-2.5 has-[+[data-slot=composer-shell]:not(.hidden)]:rounded-b-none has-[+[data-slot=composer-shell]:not(.hidden)]:border-b-(--border)";
/** The expander: chevron and the file count open the review. */
export const CHANGED_FILES_TOGGLE_CLS =
  "flex min-w-0 items-center gap-2 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring";
