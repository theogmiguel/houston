/**
 * Access has no chip in the toolbar in any form: the model picker's footer holds Permissions and
 * the model trigger's tooltip names a non-default mode. The mode block remains for the Plan
 * toggle only, and the model picker always answers composer.mode.
 */
export function resolveComposerControlsOwnership(input: {
  readonly planModeUiEnabled: boolean;
  /** How many trailing blocks the width measurement moved into the overflow menu. */
  readonly measuredHiddenBlockCount: number;
}) {
  const showModeBlock = input.planModeUiEnabled;
  const modeHidden = showModeBlock && input.measuredHiddenBlockCount > 0;
  const hiddenBlockIds = modeHidden ? (["mode"] as const) : ([] as const);
  return {
    accessDisplay: "hidden" as const,
    showModeBlock,
    hiddenBlockCount: hiddenBlockIds.length,
    hiddenBlockIds,
    /** The overflow menu holds the Plan toggle only; Permissions stay in the model picker. */
    overflowShowsPermissions: false,
    /** The model picker always answers composer.mode. */
    pickerOwnsModeShortcut: true,
  };
}
