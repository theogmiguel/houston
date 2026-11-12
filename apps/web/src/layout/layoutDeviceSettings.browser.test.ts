import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { useLayoutBehaviorStore } from "./layoutBehavior";
import {
  LAYOUT_DEVICE_SETTINGS_KEY,
  resetLayoutDeviceSettings,
  startLayoutDeviceSettingsSync,
  updateLayoutDeviceSettings,
  useLayoutDeviceSettingsStore,
} from "./layoutDeviceSettings";

beforeEach(() => {
  localStorage.removeItem(LAYOUT_DEVICE_SETTINGS_KEY);
  resetLayoutDeviceSettings();
});
afterEach(() => localStorage.removeItem(LAYOUT_DEVICE_SETTINGS_KEY));

describe("the device settings store", () => {
  it("persists an update and reads it back", () => {
    updateLayoutDeviceSettings({ newTabPosition: "end" });
    expect(JSON.parse(localStorage.getItem(LAYOUT_DEVICE_SETTINGS_KEY)!).newTabPosition).toBe("end");
    expect(useLayoutDeviceSettingsStore.getState().settings.newTabPosition).toBe("end");
  });

  it("still works when storage refuses the write", () => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = () => {
      throw new Error("quota");
    };
    try {
      updateLayoutDeviceSettings({ newTabPosition: "end" });
      expect(useLayoutDeviceSettingsStore.getState().settings.newTabPosition).toBe("end");
    } finally {
      Storage.prototype.setItem = original;
    }
  });

  it("feeds the layout behavior, keeping the remembered companion shares", () => {
    useLayoutBehaviorStore.setState({
      behavior: { ...useLayoutBehaviorStore.getState().behavior, companionShares: { terminal: 0.3 } },
    });
    const stop = startLayoutDeviceSettingsSync();
    try {
      updateLayoutDeviceSettings({ terminalPlacement: "new-column" });
      const behavior = useLayoutBehaviorStore.getState().behavior;
      expect(behavior.terminalPlacement).toBe("new-column");
      expect(behavior.companionShares).toEqual({ terminal: 0.3 });
    } finally {
      stop();
    }
  });
});
