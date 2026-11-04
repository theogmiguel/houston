import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { render, stubGlobal } from "../../test/render";
import { DesktopWindowControls } from "./DesktopWindowControls";

describe("DesktopWindowControls", () => {
  it("drives the window through hostBridge on the Electron host", async () => {
    const bridge = {
      getClientPlatform: () => "linux",
      closeWindow: vi.fn(async () => {}),
      minimizeWindow: vi.fn(async () => {}),
      toggleMaximizeWindow: vi.fn(async () => {}),
      getWindowMaximizedState: () => false,
      onWindowMaximizedStateChange: () => () => {},
      getWindowButtonLayout: async () => "appmenu:minimize,maximize,close",
    };
    using _bridge = stubGlobal("hostBridge", bridge);

    await using screen = await render(<DesktopWindowControls />, { router: false });

    await expect.element(screen.getByRole("button", { name: "Maximize" })).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Maximize" }));
    expect(bridge.toggleMaximizeWindow).toHaveBeenCalledOnce();

    await userEvent.click(screen.getByRole("button", { name: "Minimize" }));
    expect(bridge.minimizeWindow).toHaveBeenCalledOnce();

    await userEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(bridge.closeWindow).toHaveBeenCalledOnce();
  });

  it("leaves the native macOS traffic lights alone", async () => {
    using _bridge = stubGlobal("hostBridge", {
      getClientPlatform: () => "darwin",
      closeWindow: vi.fn(async () => {}),
      minimizeWindow: vi.fn(async () => {}),
      toggleMaximizeWindow: vi.fn(async () => {}),
      getWindowMaximizedState: () => false,
      onWindowMaximizedStateChange: () => () => {},
      getWindowButtonLayout: async () => null,
    });

    await using screen = await render(<DesktopWindowControls />, { router: false });
    expect(screen.container.innerHTML).toBe("");
  });

  it("renders nothing outside a desktop host", async () => {
    await using screen = await render(<DesktopWindowControls />, { router: false });
    expect(screen.container.innerHTML).toBe("");
  });
});
