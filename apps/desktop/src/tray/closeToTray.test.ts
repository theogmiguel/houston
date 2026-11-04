import { describe, expect, it } from "@effect/vitest";

import { shouldHideOnClose } from "./model.ts";

describe("close-to-tray", () => {
  it("hides only when a tray exists, the user kept it, and no quit is underway", () => {
    expect(shouldHideOnClose({ available: true, keepInTray: true, quitting: false })).toBe(true);
  });

  it("closes normally when the user turned keep-in-tray off", () => {
    expect(shouldHideOnClose({ available: true, keepInTray: false, quitting: false })).toBe(false);
  });

  it("closes normally when there is no tray to restore the window", () => {
    expect(shouldHideOnClose({ available: false, keepInTray: true, quitting: false })).toBe(false);
  });

  it("lets a quit close windows even while keep-in-tray is on", () => {
    expect(shouldHideOnClose({ available: true, keepInTray: true, quitting: true })).toBe(false);
  });
});
