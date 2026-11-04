import { describe, expect, it } from "@effect/vitest";

import type { KeybindingShortcut } from "@houston-app/contracts";

import {
  DEFAULT_QUICK_COMPOSER_SHORTCUT,
  accelerator,
  chordLabel,
  normalizeShortcut,
  registrationFailureReason,
  sessionIsWayland,
} from "./shortcut.ts";

function chord(key: string, overrides: Partial<KeybindingShortcut> = {}): KeybindingShortcut {
  return {
    key,
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    modKey: false,
    ...overrides,
  };
}

describe("quick composer shortcut", () => {
  it("starts with Ctrl+Shift+Space", () => {
    expect(accelerator(DEFAULT_QUICK_COMPOSER_SHORTCUT)).toBe("Control+Shift+Space");
  });

  it("names every modifier and key shape", () => {
    const all = { ctrlKey: true, shiftKey: true, metaKey: true, altKey: true };
    expect(accelerator(chord("a", all))).toBe("Super+Control+Alt+Shift+A");
    expect(accelerator(chord("7", all))).toBe("Super+Control+Alt+Shift+7");
    expect(accelerator(chord("f12", all))).toBe("Super+Control+Alt+Shift+F12");
    expect(accelerator(chord(" ", all))).toBe("Super+Control+Alt+Shift+Space");
    expect(accelerator(chord("escape", all))).toBe("Super+Control+Alt+Shift+Esc");
    expect(accelerator(chord("arrowup", all))).toBe("Super+Control+Alt+Shift+Up");
  });

  it("maps a mod key to the platform's command modifier", () => {
    expect(accelerator(chord("j", { modKey: true }))).toBe("CommandOrControl+J");
  });

  it("normalizes a trimmed Space key to the word form", () => {
    expect(normalizeShortcut(chord(" ")).key).toBe("space");
    expect(normalizeShortcut(chord("")).key).toBe("space");
    expect(accelerator(chord("space", { ctrlKey: true }))).toBe("Control+Space");
  });

  it("refuses a chord without a modifier and names it", () => {
    expect(() => accelerator(chord("j"))).toThrowError(/j[^]*no modifier/);
  });

  it("refuses an unknown key and names it", () => {
    expect(() => accelerator(chord("hyperdrive", { ctrlKey: true }))).toThrowError(/hyperdrive/);
  });

  it("labels a chord the way Settings shows it", () => {
    expect(chordLabel(DEFAULT_QUICK_COMPOSER_SHORTCUT)).toBe("Ctrl+Shift+Space");
    expect(chordLabel(chord("k", { metaKey: true, altKey: true }))).toBe("Alt+Super+k");
  });

  it("names Wayland and the chord when a Wayland session refuses", () => {
    const reason = registrationFailureReason(
      DEFAULT_QUICK_COMPOSER_SHORTCUT,
      "not supported",
      true,
    );
    expect(reason).toContain("Wayland");
    expect(reason).toContain("Ctrl+Shift+Space");
    expect(reason).toContain("tray's New thread item");
  });

  it("points at Settings when another app owns the chord", () => {
    const reason = registrationFailureReason(
      DEFAULT_QUICK_COMPOSER_SHORTCUT,
      "hot key already registered",
      false,
    );
    expect(reason).toContain("Ctrl+Shift+Space");
    expect(reason).toContain("Settings > Keybindings");
  });

  it("detects a Wayland session from the environment", () => {
    expect(sessionIsWayland("linux", { WAYLAND_DISPLAY: "wayland-0" })).toBe(true);
    expect(sessionIsWayland("linux", { XDG_SESSION_TYPE: "wayland" })).toBe(true);
    expect(sessionIsWayland("linux", { XDG_SESSION_TYPE: "x11" })).toBe(false);
    expect(sessionIsWayland("win32", { WAYLAND_DISPLAY: "wayland-0" })).toBe(false);
  });
});
