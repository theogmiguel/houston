import {
  isModifierPairShortcut,
  snapShotModifierPairLabel,
  snapShotShortcutModifierPair,
  type KeybindingShortcut,
  type SnapShotModifier,
  type SnapShotShortcut,
} from "@houston-app/contracts";
import { parseKeybindingShortcut } from "@houston-app/shared/keybindings";

import { formatShortcutKeyLabel, formatShortcutLabel, shortcutConflictKey } from "../keybindings";
import { isMacPlatform, isWindowsPlatform } from "./utils";

const TEXT_PATTERN = /^Press\s+/i;
const GTK_PATTERN = /^((?:<[^<>]+>)+)([^<>]+)$/;
const INPUT_PATTERN = /<([^<>]+)>/g;
const INPUT_PATTERN_2 = /\b(super|win|primary)\b/gi;
const PARSE_DESKTOP_SNAP_SHOT_SHORTCUT_PATTERN = /^[^\s<>]$/u;
const PARSE_DESKTOP_SNAP_SHOT_SHORTCUT_PATTERN_2 =
  /^(?:f(?:[1-9]|1\d|2[0-4])|enter|tab|escape|backspace|delete|insert|home|end|pageup|pagedown|arrow(?:left|right|up|down)|pause|printscreen)$/i;

const DESKTOP_KEY_ALIASES: Readonly<Record<string, string>> = {
  return: "enter",
  page_up: "pageup",
  page_down: "pagedown",
  left: "arrowleft",
  right: "arrowright",
  up: "arrowup",
  down: "arrowdown",
  plus: "+",
  minus: "-",
};

export function parseDesktopSnapShotShortcut(label: string): KeybindingShortcut | null {
  const text = label.trim().replace(TEXT_PATTERN, "");
  if (!text) return null;
  const gtk = text.match(GTK_PATTERN);
  const input = (gtk ? gtk[1]!.replace(INPUT_PATTERN, "$1+") + gtk[2]! : text).replace(
    INPUT_PATTERN_2,
    (modifier) => (modifier.toLowerCase() === "primary" ? "ctrl" : "meta"),
  );
  if (input !== "+" && input.endsWith("+") && !input.endsWith("++")) return null;
  const shortcut = parseKeybindingShortcut(input);
  if (!shortcut) return null;
  const key = DESKTOP_KEY_ALIASES[shortcut.key] ?? shortcut.key;
  if (
    key !== " " &&
    !PARSE_DESKTOP_SNAP_SHOT_SHORTCUT_PATTERN.test(key) &&
    !PARSE_DESKTOP_SNAP_SHOT_SHORTCUT_PATTERN_2.test(key)
  ) {
    return null;
  }
  return { ...shortcut, key };
}

export function formatSnapShotShortcutLabel(
  shortcut: SnapShotShortcut,
  platform = navigator.platform,
): string {
  return isModifierPairShortcut(shortcut)
    ? snapShotModifierPairLabel(snapShotShortcutModifierPair(shortcut), isMacPlatform(platform))
    : formatShortcutLabel(shortcut, platform);
}

function modifierKeyLabel(modifier: SnapShotModifier, platform: string): string {
  if (modifier === "shift") return "Shift";
  if (isMacPlatform(platform)) {
    if (modifier === "meta") return "Command";
    if (modifier === "control") return "Control";
    return "Option";
  }
  if (modifier === "meta") return isWindowsPlatform(platform) ? "Win" : "Super";
  return modifier === "control" ? "Ctrl" : "Alt";
}

export function snapShotShortcutKeyLabels(
  shortcut: SnapShotShortcut,
  platform = navigator.platform,
): readonly string[] {
  if (isModifierPairShortcut(shortcut)) {
    const label = modifierKeyLabel(snapShotShortcutModifierPair(shortcut), platform);
    return [label, label];
  }

  const useMetaForMod = isMacPlatform(platform);
  const modifiers: readonly [boolean, SnapShotModifier][] = [
    [shortcut.ctrlKey || (shortcut.modKey && !useMetaForMod), "control"],
    [shortcut.altKey, "alt"],
    [shortcut.shiftKey, "shift"],
    [shortcut.metaKey || (shortcut.modKey && useMetaForMod), "meta"],
  ];
  return [
    ...modifiers
      .filter(([enabled]) => enabled)
      .map(([, modifier]) => modifierKeyLabel(modifier, platform)),
    formatShortcutKeyLabel(shortcut.key),
  ];
}

export function sameSnapShotShortcut(
  left: SnapShotShortcut,
  right: SnapShotShortcut,
  platform = navigator.platform,
): boolean {
  if (isModifierPairShortcut(left) || isModifierPairShortcut(right)) {
    return (
      isModifierPairShortcut(left) &&
      isModifierPairShortcut(right) &&
      snapShotShortcutModifierPair(left) === snapShotShortcutModifierPair(right)
    );
  }
  return shortcutConflictKey(left, platform) === shortcutConflictKey(right, platform);
}

export function snapShotKeybindingConflict<Command extends string>(
  shortcut: SnapShotShortcut,
  keybindings: ReadonlyArray<{ readonly command: Command; readonly shortcut: KeybindingShortcut }>,
  platform = navigator.platform,
): Command | null {
  if (isModifierPairShortcut(shortcut)) return null;
  const key = shortcutConflictKey(shortcut, platform);
  return (
    keybindings.find((binding) => shortcutConflictKey(binding.shortcut, platform) === key)
      ?.command ?? null
  );
}
