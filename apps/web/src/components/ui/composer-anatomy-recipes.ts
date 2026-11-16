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
 * rounded, no bottom edge (the card covers it), one muted line that never wraps. It carries the
 * turn's pending changes; the workspace line sits under the card.
 */
export const CHANGED_FILES_TRAY_CLS =
  "relative z-0 -mb-2 mx-2.5 flex min-w-0 flex-col overflow-hidden rounded-t-lg border border-b-0 border-(--card-edge) bg-(--pane-head) px-1.5 pt-0.5 pb-2.5 text-(--contrast-secondary-label) text-2xs leading-none whitespace-nowrap";

/** A real branch name reads in the mono face; the checkout label stands in as plain text. */
export const CONTEXT_CHIP_BRANCH_MONO_CLS = `${CONTEXT_CHIP_BRANCH_CLS} font-mono`;
/** A server thread's checkout control moves to the strip's environment block on wide strips. */
export const CONTEXT_RUN_HIDDEN_WIDE_CLS = "@xl/composer-surface:hidden";

/** The changes tray's one line. */
export const CHANGED_FILES_TRAY_ROW_CLS = "flex h-6 min-w-0 items-center gap-1";

/** The changes half of the composer tab: never shrinks, sits at the row's end. */
export const CHANGED_FILES_BAR_CLS = "ms-auto flex shrink-0 items-center gap-1 text-xs";
/** The expander: chevron, file count and totals. */
export const CHANGED_FILES_TOGGLE_CLS =
  "flex h-5.5 items-center gap-1.5 rounded-md px-1.5 text-foreground outline-none hover:bg-(--hover) aria-expanded:bg-(--hover) focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring";
export const CHANGED_FILES_CHEVRON_CLS = "size-3 shrink-0 text-muted-foreground";
export const CHANGED_FILES_SEPARATOR_CLS = "mx-0.5 h-3 w-px shrink-0 bg-border";
/** The expanded file list above the row; past six files it scrolls. */
export const CHANGED_FILES_LIST_CLS =
  "-mx-1.5 mb-0.5 flex max-h-40 flex-col overflow-y-auto border-b border-border px-1 py-1 text-xs";
export const CHANGED_FILES_ROW_CLS =
  "flex h-6.5 w-full min-w-0 items-center gap-1.5 rounded-md px-1.5 text-left outline-none hover:bg-(--hover) focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring";
export const CHANGED_FILES_ROW_ICON_CLS = "size-3 shrink-0 text-muted-foreground";
export const CHANGED_FILES_ROW_DIR_CLS = "min-w-0 truncate text-muted-foreground";
export const CHANGED_FILES_ROW_NAME_CLS = "shrink-0 text-foreground";
export const CHANGED_FILES_ROW_STAT_CLS = "ms-auto shrink-0 ps-2";

/**
 * The queued messages joined to the top of the composer card: one hairline-edged tray of one-line
 * rows. The card below squares its top corners (`ComposerSurface.Main`) so the two read as one.
 */
export const QUEUE_TRAY_CLS =
  "relative z-10 flex w-full min-w-0 flex-col overflow-hidden rounded-t-xl border border-b-0 border-(--card-edge) bg-(--composer) text-xs";
/** The same tray standing alone, above a composer that an approval card has replaced. */
export const QUEUE_TRAY_DETACHED_CLS =
  "relative z-10 mb-1 flex w-full min-w-0 flex-col overflow-hidden rounded-xl border border-(--card-edge) bg-(--composer) text-xs";
export const QUEUE_ROW_CLS =
  "group/queued flex min-w-0 flex-col border-t border-(--border) first:border-t-0";
export const QUEUE_MORE_CLS =
  "flex min-h-7 items-center justify-end border-t border-(--border) px-3 pointer-coarse:[&_[data-slot=inline-button]]:relative pointer-coarse:[&_[data-slot=inline-button]]:after:absolute pointer-coarse:[&_[data-slot=inline-button]]:after:-inset-x-1.5 pointer-coarse:[&_[data-slot=inline-button]]:after:-inset-y-3.5";

/**
 * The context tab under the composer card: inset from the card's edges and tucked under its bottom
 * edge, opaque in the card's own fill so the thread never shows through its labels. Every control
 * in it is a borderless 22px, 12px sans text button in the muted label ink; a branch name keeps
 * the sans face.
 */
export const CONTEXT_TAB_CLS =
  "group/composer-context relative z-0 mx-2.5 -mt-2 flex h-8.5 min-w-0 items-center gap-px overflow-x-clip rounded-b-lg border border-t-0 border-(--card-edge) bg-(--composer) px-1.5 pt-2 text-(--contrast-secondary-label) text-xs " +
  "[&_[data-composer-context-control]]:max-w-none! [&_[data-composer-context-control]]:h-5.5! [&_[data-composer-context-control]]:rounded-(--r-ctl)! [&_[data-composer-context-control]]:border-0! [&_[data-composer-context-control]]:px-1.5! [&_[data-composer-context-control]]:font-normal [&_[data-composer-context-control]]:text-secondary-label! [&_[data-composer-context-control]]:text-xs! " +
  "[&_[data-composer-label]]:font-normal [&_[data-composer-label]]:text-secondary-label " +
  "[&_[data-composer-label]_*]:font-sans";
