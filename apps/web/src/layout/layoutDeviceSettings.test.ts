import { describe, expect, it } from "vite-plus/test";

import { decodeLayoutDeviceSettings } from "./layoutDeviceSettings";
import { DEFAULT_LAYOUT_SETTINGS } from "./layoutSettings";

describe("decodeLayoutDeviceSettings", () => {
  it("falls back to the defaults for anything that is not an object", () => {
    expect(decodeLayoutDeviceSettings(null)).toEqual({
      ...DEFAULT_LAYOUT_SETTINGS,
      threeFingerSwipe: false,
    });
    expect(decodeLayoutDeviceSettings("nope")).toEqual({
      ...DEFAULT_LAYOUT_SETTINGS,
      threeFingerSwipe: false,
    });
  });

  it("keeps valid fields and defaults the invalid ones", () => {
    const settings = decodeLayoutDeviceSettings({
      terminalPlacement: "new-tab",
      sidePanePlacement: "sideways",
      whenNoRoom: "always-scroll",
    });
    expect(settings.terminalPlacement).toBe("new-tab");
    expect(settings.sidePanePlacement).toBe(DEFAULT_LAYOUT_SETTINGS.sidePanePlacement);
    expect(settings.whenNoRoom).toBe("always-scroll");
  });

  it("rejects a template with an unknown pane kind", () => {
    const settings = decodeLayoutDeviceSettings({
      template: { columns: [{ size: 1, panes: [{ kind: "video", size: 1, span: "column" }] }] },
    });
    expect(settings.template).toEqual(DEFAULT_LAYOUT_SETTINGS.template);
  });

  it("rejects a template with no chat pane", () => {
    const settings = decodeLayoutDeviceSettings({
      template: { columns: [{ size: 1, panes: [{ kind: "terminal", size: 1, span: "column" }] }] },
    });
    expect(settings.template).toEqual(DEFAULT_LAYOUT_SETTINGS.template);
  });

  it("reads the swipe flag only when it is a boolean", () => {
    expect(decodeLayoutDeviceSettings({ threeFingerSwipe: true }).threeFingerSwipe).toBe(true);
    expect(decodeLayoutDeviceSettings({ threeFingerSwipe: "yes" }).threeFingerSwipe).toBe(false);
  });
});
