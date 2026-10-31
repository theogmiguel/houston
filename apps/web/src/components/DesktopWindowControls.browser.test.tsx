import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { render, stubGlobal } from "../../test/render";
import { DesktopWindowControls } from "./DesktopWindowControls";

describe("DesktopWindowControls", () => {
  it("reads the native layout and maximized state, then restores when clicked", async () => {
    const invoke = vi.fn((command: string) => {
      if (command === "window_button_layout") return Promise.resolve(":minimize,maximize,close");
      if (command === "plugin:window|is_maximized") return Promise.resolve(true);
      return Promise.resolve(undefined);
    });
    using _tauri = stubGlobal("__TAURI__", { core: { invoke } });

    await using screen = await render(<DesktopWindowControls />, { router: false });

    await expect.element(screen.getByRole("button", { name: "Minimize" })).toBeVisible();
    await expect.element(screen.getByRole("button", { name: "Restore" })).toBeVisible();
    await expect.element(screen.getByRole("button", { name: "Close" })).toBeVisible();

    await userEvent.click(screen.getByRole("button", { name: "Restore" }));
    expect(invoke).toHaveBeenCalledWith("plugin:window|toggle_maximize", {});
  });

  it("falls back to the documented buttons when the host reports no layout", async () => {
    const invoke = vi.fn((command: string) => {
      if (command === "window_button_layout") return Promise.resolve(null);
      return Promise.resolve(false);
    });
    using _tauri = stubGlobal("__TAURI__", { core: { invoke } });

    await using screen = await render(<DesktopWindowControls />, { router: false });

    await expect.element(screen.getByRole("button", { name: "Minimize" })).toBeVisible();
    await expect.element(screen.getByRole("button", { name: "Maximize" })).toBeVisible();
    await expect.element(screen.getByRole("button", { name: "Close" })).toBeVisible();
  });

  it("invokes minimize and close from the matching buttons", async () => {
    const invoke = vi.fn((command: string) => {
      if (command === "window_button_layout") return Promise.resolve(":minimize,maximize,close");
      return Promise.resolve(false);
    });
    using _tauri = stubGlobal("__TAURI__", { core: { invoke } });

    await using screen = await render(<DesktopWindowControls />, { router: false });

    await userEvent.click(screen.getByRole("button", { name: "Minimize" }));
    expect(invoke).toHaveBeenCalledWith("plugin:window|minimize", {});

    await userEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(invoke).toHaveBeenCalledWith("plugin:window|close", {});
  });

  it("renders nothing outside a Tauri host", async () => {
    await using screen = await render(<DesktopWindowControls />, { router: false });
    expect(screen.container.innerHTML).toBe("");
  });
});
