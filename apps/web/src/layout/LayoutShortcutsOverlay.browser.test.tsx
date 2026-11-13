import { describe, expect, it } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render } from "../../test/render";
import "../index.css";
import { LayoutShortcutsOverlay } from "./LayoutShortcutsOverlay";
import {
  setLayoutOverlayMode,
  toggleLayoutShortcutSheet,
  useLayoutOverlayStore,
} from "./layoutOverlayStore";

/** Puts the stores in a known state for one test and restores them when the test ends. */
function openSession(): Disposable {
  return {
    [Symbol.dispose]() {
      setLayoutOverlayMode(null);
    },
  };
}

describe("LayoutShortcutsOverlay", () => {
  it("pins the full sheet and closes it on Escape", async () => {
    using _session = openSession();
    await using _screen = await render(<LayoutShortcutsOverlay />);
    toggleLayoutShortcutSheet();
    await expect.element(page.getByRole("heading", { name: "Keyboard shortcuts" })).toBeVisible();
    await userEvent.keyboard("{Escape}");
    expect(useLayoutOverlayStore.getState().mode).toBeNull();
  });

  it("shows the hold menu while the layout modifier is held and drops it on release", async () => {
    using _session = openSession();
    await using _screen = await render(<LayoutShortcutsOverlay />);
    await userEvent.keyboard("{Control>}{Alt>}");
    await expect.poll(() => useLayoutOverlayStore.getState().mode, { timeout: 3000 }).toBe("hold");
    await expect.element(page.getByRole("dialog", { name: "Layout keys" })).toBeVisible();
    await userEvent.keyboard("{/Alt}{/Control}");
    expect(useLayoutOverlayStore.getState().mode).toBeNull();
  });

  it("shows nothing for a modifier tapped and released at once", async () => {
    using _session = openSession();
    await using _screen = await render(<LayoutShortcutsOverlay />);
    await userEvent.keyboard("{Control>}{Alt>}{/Alt}{/Control}");
    expect(useLayoutOverlayStore.getState().mode).toBeNull();
  });

  it("clears the overlay when it unmounts", async () => {
    using _session = openSession();
    const screen = await render(<LayoutShortcutsOverlay />);
    setLayoutOverlayMode("hold");
    await screen.unmount();
    expect(useLayoutOverlayStore.getState().mode).toBeNull();
    await screen[Symbol.asyncDispose]();
  });
});
