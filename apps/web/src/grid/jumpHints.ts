import type { ResolvedKeybindingsConfig } from "@houston-app/contracts";

import { shortcutLabelForCommand, threadJumpCommandForIndex } from "../keybindings";

/**
 * The jump shortcut label for each of the first rows in rail order, by thread
 * key. Rows past the ninth, and rows whose jump command has no binding, get none.
 */
export function jumpHintLabels(
  orderedThreadKeys: ReadonlyArray<string>,
  keybindings: ResolvedKeybindingsConfig,
): Map<string, string> {
  const labels = new Map<string, string>();
  for (const [index, key] of orderedThreadKeys.entries()) {
    const command = threadJumpCommandForIndex(index);
    if (command === null) break;
    const label = shortcutLabelForCommand(keybindings, command);
    if (label !== null) labels.set(key, label);
  }
  return labels;
}
