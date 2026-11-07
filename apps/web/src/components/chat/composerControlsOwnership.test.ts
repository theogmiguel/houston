import { describe, expect, it } from "vite-plus/test";

import { resolveComposerControlsOwnership } from "./composerControlsOwnership";

describe("resolveComposerControlsOwnership", () => {
  it("shows no access chip and lets the model picker answer composer.mode", () => {
    const result = resolveComposerControlsOwnership({
      planModeUiEnabled: false,
      measuredHiddenBlockCount: 0,
    });
    expect(result).toMatchObject({
      accessDisplay: "hidden",
      showModeBlock: false,
      hiddenBlockIds: [],
      overflowShowsPermissions: false,
      pickerOwnsModeShortcut: true,
    });
  });

  it("keeps the Plan toggle block and overflows it without moving Permissions", () => {
    const result = resolveComposerControlsOwnership({
      planModeUiEnabled: true,
      measuredHiddenBlockCount: 1,
    });
    expect(result.showModeBlock).toBe(true);
    expect(result.hiddenBlockIds).toEqual(["mode"]);
    expect(result.accessDisplay).toBe("hidden");
    expect(result.overflowShowsPermissions).toBe(false);
    expect(result.pickerOwnsModeShortcut).toBe(true);
  });
});
