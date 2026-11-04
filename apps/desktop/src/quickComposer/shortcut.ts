import type { KeybindingShortcut } from "@houston-app/contracts";

import { isWaylandSession, toElectronAccelerator } from "../snapShot/snapShot.ts";

export interface QuickComposerSettings {
  readonly enabled: boolean;
  readonly shortcut: KeybindingShortcut | null;
}

export const DEFAULT_QUICK_COMPOSER_SHORTCUT: KeybindingShortcut = {
  key: "space",
  metaKey: false,
  ctrlKey: true,
  shiftKey: true,
  altKey: false,
  modKey: false,
};

export const DEFAULT_QUICK_COMPOSER_SETTINGS: QuickComposerSettings = {
  enabled: true,
  shortcut: DEFAULT_QUICK_COMPOSER_SHORTCUT,
};

const NAMED_KEYS = new Set([
  "tab",
  "enter",
  "return",
  "escape",
  "esc",
  "backspace",
  "delete",
  "del",
  "insert",
  "ins",
  "home",
  "end",
  "pageup",
  "pagedown",
  "arrowleft",
  "arrowright",
  "arrowup",
  "arrowdown",
  "left",
  "right",
  "up",
  "down",
]);

function keyProblem(key: string): string | null {
  if (key === " ") return null;
  const trimmed = key.trim();
  if (trimmed.length === 0) {
    return "A global shortcut needs a key. Use a letter, digit, function key or Space.";
  }
  if (trimmed.toLowerCase() === "space") return null;
  if (trimmed.length === 1) return null;
  if (/^f([1-9]|1\d|2[0-4])$/i.test(trimmed)) return null;
  if (NAMED_KEYS.has(trimmed.toLowerCase())) return null;
  return `Houston cannot use ${JSON.stringify(trimmed)} as a global shortcut key. Use a letter, digit, function key, arrow or Space.`;
}

/** The contracts trim ` " " ` to an empty key, so Space travels as the word `space`. */
export function normalizeShortcut(shortcut: KeybindingShortcut): KeybindingShortcut {
  return shortcut.key === " " || shortcut.key === "" ? { ...shortcut, key: "space" } : shortcut;
}

export function chordLabel(shortcut: KeybindingShortcut): string {
  const parts: string[] = [];
  if (shortcut.ctrlKey || shortcut.modKey) parts.push("Ctrl");
  if (shortcut.altKey) parts.push("Alt");
  if (shortcut.shiftKey) parts.push("Shift");
  if (shortcut.metaKey) parts.push("Super");
  parts.push(isSpaceKey(shortcut.key) ? "Space" : shortcut.key);
  return parts.join("+");
}

function isSpaceKey(key: string): boolean {
  return key === " " || key === "" || key === "space";
}

/** The Electron accelerator for the chord; refuses a key without a modifier. */
export function accelerator(shortcut: KeybindingShortcut): string {
  const normalized = normalizeShortcut(shortcut);
  const problem = keyProblem(normalized.key);
  if (problem !== null) throw new Error(problem);
  const modifiers = [
    shortcut.ctrlKey,
    shortcut.altKey,
    shortcut.shiftKey,
    shortcut.metaKey,
    shortcut.modKey,
  ];
  if (!modifiers.some(Boolean)) {
    throw new Error(
      `${chordLabel(shortcut)} has no modifier. Add Ctrl, Alt, Shift or Super so the shortcut does not take a plain key from every app.`,
    );
  }
  return toElectronAccelerator({
    ...normalized,
    key: isSpaceKey(normalized.key) ? " " : normalized.key,
  });
}

export function registrationFailureReason(
  shortcut: KeybindingShortcut,
  error: string,
  wayland: boolean,
): string {
  const label = chordLabel(shortcut);
  if (wayland) {
    return `Wayland does not let apps register global shortcuts, so ${label} is unavailable. Use the tray's New thread item instead. (${error})`;
  }
  return `${label} could not be registered: ${error}. Another app may already use it; choose another shortcut in Settings > Keybindings.`;
}

export function sessionIsWayland(
  platform: NodeJS.Platform,
  environment: NodeJS.ProcessEnv,
): boolean {
  return isWaylandSession(platform, environment);
}
