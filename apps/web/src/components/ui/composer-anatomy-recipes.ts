/** Visual recipes for the composer toolbar's collapsed workspace chip and its running stop. */

/** The single workspace chip that replaces the checkout, branch and access controls. */
export const CONTEXT_CHIP_BRANCH_CLS = "max-w-20 truncate text-xs";
export const CONTEXT_CHIP_SEPARATOR_CLS = "text-(--houston) text-xs";
export const CONTEXT_CHIP_ENV_CLS = "shrink-0 text-xs";
export const CONTEXT_CHIP_CHEVRON_CLS = "size-3 shrink-0";
/** The one panel the collapsed chip opens: the three controls stacked. */
export const CONTEXT_CHIP_PANEL_CLS = "flex w-72 flex-col gap-2 p-2";

/** The stop button's running state: a ring in the running status ink. */
export const COMPOSER_STOP_RUNNING_CLS =
  "ring-2 ring-(--status-running) ring-offset-2 ring-offset-(--composer)";
