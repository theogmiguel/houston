import { describe, expect, it } from "@effect/vitest";
import type { KeybindingShortcut } from "@houston-app/contracts";

import * as Keybindings from "./keybindings.ts";
import { matchesKeybindingShortcut } from "./keybindingMatching.ts";

const modAltV: KeybindingShortcut = {
  key: "v",
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  altKey: true,
  modKey: true,
};

const event = (overrides: Partial<Parameters<typeof matchesKeybindingShortcut>[0]> = {}) => ({
  key: "v",
  code: "KeyV",
  metaKey: false,
  ctrlKey: true,
  shiftKey: false,
  altKey: true,
  ...overrides,
});

describe("matchesKeybindingShortcut", () => {
  it("maps mod to ctrl off macOS and to meta on macOS", () => {
    expect(matchesKeybindingShortcut(event(), modAltV, "Linux")).toBe(true);
    expect(matchesKeybindingShortcut(event(), modAltV, "MacIntel")).toBe(false);
    expect(
      matchesKeybindingShortcut(event({ ctrlKey: false, metaKey: true }), modAltV, "MacIntel"),
    ).toBe(true);
  });

  it("matches the physical letter when the layout produces another character", () => {
    expect(matchesKeybindingShortcut(event({ key: "√" }), modAltV, "MacIntel")).toBe(false);
    expect(
      matchesKeybindingShortcut(
        event({ key: "√", ctrlKey: false, metaKey: true }),
        modAltV,
        "MacIntel",
      ),
    ).toBe(true);
  });

  it("rejects extra modifiers and AltGraph composition", () => {
    expect(matchesKeybindingShortcut(event({ shiftKey: true }), modAltV, "Linux")).toBe(false);
    expect(
      matchesKeybindingShortcut(
        event({ key: "€", code: "KeyV", getModifierState: () => true }),
        modAltV,
        "Linux",
      ),
    ).toBe(false);
  });

  it("stays exported from keybindings for existing importers", () => {
    expect(Keybindings.matchesKeybindingShortcut).toBe(matchesKeybindingShortcut);
  });
});
