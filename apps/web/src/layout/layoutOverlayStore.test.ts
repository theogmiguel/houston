import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  setLayoutOverlayMode,
  toggleLayoutShortcutSheet,
  useLayoutOverlayStore,
} from "./layoutOverlayStore";

afterEach(() => setLayoutOverlayMode(null));

describe("layoutOverlayStore", () => {
  it("starts closed", () => {
    expect(useLayoutOverlayStore.getState().mode).toBeNull();
  });

  it("toggles the pinned sheet open and closed", () => {
    toggleLayoutShortcutSheet();
    expect(useLayoutOverlayStore.getState().mode).toBe("sheet");
    toggleLayoutShortcutSheet();
    expect(useLayoutOverlayStore.getState().mode).toBeNull();
  });

  it("pins the sheet over the hold menu instead of closing it", () => {
    setLayoutOverlayMode("hold");
    toggleLayoutShortcutSheet();
    expect(useLayoutOverlayStore.getState().mode).toBe("sheet");
  });

  it("does not notify subscribers when the mode is unchanged", () => {
    let notified = 0;
    const unsubscribe = useLayoutOverlayStore.subscribe(() => (notified += 1));
    setLayoutOverlayMode(null);
    setLayoutOverlayMode("hold");
    setLayoutOverlayMode("hold");
    unsubscribe();
    expect(notified).toBe(1);
  });
});
