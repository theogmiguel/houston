/** Visual recipes for the composer toolbar's collapsed workspace chip. */

/** The single workspace chip that replaces the checkout, branch and access controls. */
/** The chip yields width to the primary actions, but its branch keeps at least 10 characters. */
export const CONTEXT_CHIP_TRIGGER_CLS = "min-w-0 shrink";
export const CONTEXT_CHIP_BRANCH_CLS = "min-w-[10ch] max-w-[28ch] truncate text-xs";
/** The checkout label is text in wide panes and an icon (with a tooltip) in narrow ones. */
export const CONTEXT_CHIP_SEPARATOR_CLS =
  "hidden text-(--houston) text-xs @md/composer-surface:inline";
export const CONTEXT_CHIP_ENV_CLS = "hidden shrink-0 text-xs @md/composer-surface:inline";
export const CONTEXT_CHIP_ENV_ICON_CLS = "size-3 shrink-0 @md/composer-surface:hidden";
export const CONTEXT_CHIP_CHEVRON_CLS = "size-3 shrink-0";
/** The one panel the collapsed chip opens: the three controls stacked. */
export const CONTEXT_CHIP_PANEL_CLS = "flex w-72 flex-col gap-2 p-2";
