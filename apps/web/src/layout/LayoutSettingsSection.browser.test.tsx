import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { render } from "../../test/render";
import "../index.css";
import { LayoutSettingsSection } from "./LayoutSettingsSection";
import {
  LAYOUT_DEVICE_SETTINGS_KEY,
  getLayoutDeviceSettings,
  resetLayoutDeviceSettings,
  updateLayoutDeviceSettings,
} from "./layoutDeviceSettings";
import { DEFAULT_LAYOUT_SETTINGS, DEFAULT_LAYOUT_TEMPLATE } from "./layoutSettings";
import { layoutTemplatesEqual } from "./layoutTemplate";

describe("LayoutSettingsSection", () => {
  beforeEach(() => {
    resetLayoutDeviceSettings();
  });
  afterEach(() => {
    window.localStorage.removeItem(LAYOUT_DEVICE_SETTINGS_KEY);
    resetLayoutDeviceSettings();
    document.body.innerHTML = "";
  });

  it("shows the defaults with no reset buttons", async () => {
    const screen = await render(<LayoutSettingsSection />);
    try {
      await expect.element(page.getByText("Your layout")).toBeVisible();
      await expect.element(page.getByText("Behavior")).toBeVisible();
      await expect.element(page.getByLabelText("Terminal")).toBeVisible();
      expect(document.body.textContent).not.toContain("Reset Terminal to default");
      await expect.element(page.getByRole("button", { name: "Undo" })).toBeDisabled();
      await expect.element(page.getByRole("button", { name: "Reset", exact: true })).toBeDisabled();
    } finally {
      await screen.unmount();
    }
  });

  it("offers a reset for a changed placement and restores the default", async () => {
    updateLayoutDeviceSettings({ terminalPlacement: "new-tab" });
    const screen = await render(<LayoutSettingsSection />);
    try {
      await page.getByRole("button", { name: "Reset Terminal to default" }).click();
      expect(getLayoutDeviceSettings().terminalPlacement).toBe(
        DEFAULT_LAYOUT_SETTINGS.terminalPlacement,
      );
    } finally {
      await screen.unmount();
    }
  });

  it("resets the template to the default and undoes the reset", async () => {
    const custom = {
      columns: [
        { size: 0.5, panes: [{ kind: "chat" as const, size: 1, span: "column" as const }] },
        { size: 0.5, panes: [{ kind: "terminal" as const, size: 1, span: "column" as const }] },
      ],
    };
    updateLayoutDeviceSettings({ template: custom });
    const screen = await render(<LayoutSettingsSection />);
    try {
      await page.getByRole("button", { name: "Reset", exact: true }).click();
      expect(layoutTemplatesEqual(getLayoutDeviceSettings().template, DEFAULT_LAYOUT_TEMPLATE)).toBe(true);
      await page.getByRole("button", { name: "Undo" }).click();
      expect(layoutTemplatesEqual(getLayoutDeviceSettings().template, custom)).toBe(true);
    } finally {
      await screen.unmount();
    }
  });

  it("shows the trackpad swipe switch only on macOS", async () => {
    const screen = await render(<LayoutSettingsSection />);
    try {
      const isMac = /mac/i.test(navigator.platform);
      const count = document.body.textContent?.includes("Three-finger swipe") ?? false;
      expect(count).toBe(isMac);
      if (isMac) {
        await page.getByRole("switch", { name: "Three-finger swipe" }).click();
        expect(getLayoutDeviceSettings().threeFingerSwipe).toBe(true);
      }
    } finally {
      await screen.unmount();
    }
  });
});
