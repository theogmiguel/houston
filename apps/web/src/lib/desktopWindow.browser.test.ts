import { describe, expect, it, vi } from "vite-plus/test";

import { stubGlobal } from "../../test/render";
import {
  hasCustomWindowChrome,
  isNativeDesktopHost,
  onWindowMaximizedChange,
  windowButtonLayout,
  windowControl,
  windowIsMaximized,
} from "./desktopWindow";

function createHostBridge(platform = "linux") {
  return {
    getClientPlatform: vi.fn(() => platform),
    closeWindow: vi.fn(async () => {}),
    minimizeWindow: vi.fn(async () => {}),
    toggleMaximizeWindow: vi.fn(async () => {}),
    getWindowMaximizedState: vi.fn((): boolean => true),
    onWindowMaximizedStateChange: vi.fn((_listener: (maximized: boolean) => void) => () => {}),
    getWindowButtonLayout: vi.fn(
      async (): Promise<string | null> => "appmenu:minimize,maximize,close",
    ),
  };
}

describe("desktopWindow under the Electron host", () => {
  it("drives the window through hostBridge", async () => {
    const bridge = createHostBridge();
    using _bridge = stubGlobal("hostBridge", bridge);

    expect(hasCustomWindowChrome()).toBe(true);
    expect(isNativeDesktopHost()).toBe(true);

    await windowControl("close");
    await windowControl("minimize");
    await windowControl("maximize");
    expect(bridge.closeWindow).toHaveBeenCalledOnce();
    expect(bridge.minimizeWindow).toHaveBeenCalledOnce();
    expect(bridge.toggleMaximizeWindow).toHaveBeenCalledOnce();

    expect(await windowIsMaximized()).toBe(true);
    expect(await windowButtonLayout()).toBe("appmenu:minimize,maximize,close");
  });

  it("forwards maximize changes from the host", () => {
    let notify: ((maximized: boolean) => void) | undefined;
    const bridge = createHostBridge();
    bridge.onWindowMaximizedStateChange.mockImplementation((listener: (value: boolean) => void) => {
      notify = listener;
      return () => {};
    });
    using _bridge = stubGlobal("hostBridge", bridge);

    const listener = vi.fn();
    onWindowMaximizedChange(listener);
    notify?.(true);

    expect(listener).toHaveBeenCalledWith(true);
  });

  it("leaves the native traffic lights on macOS", () => {
    using _bridge = stubGlobal("hostBridge", createHostBridge("darwin"));

    expect(hasCustomWindowChrome()).toBe(false);
    expect(isNativeDesktopHost()).toBe(true);
  });

  it("returns the host's null layout when the platform fixes the buttons", async () => {
    const bridge = createHostBridge("win32");
    bridge.getWindowButtonLayout.mockResolvedValue(null);
    using _bridge = stubGlobal("hostBridge", bridge);

    expect(await windowButtonLayout()).toBeNull();
  });
});

describe("desktopWindow outside a desktop host", () => {
  it("reports no host and leaves every command inert", async () => {
    expect(hasCustomWindowChrome()).toBe(false);
    expect(isNativeDesktopHost()).toBe(false);

    await expect(windowControl("close")).resolves.toBeUndefined();
    expect(await windowIsMaximized()).toBe(false);
    expect(await windowButtonLayout()).toBeNull();
    expect(onWindowMaximizedChange(vi.fn())).toBeTypeOf("function");
  });
});
