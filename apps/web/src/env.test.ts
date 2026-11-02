import { afterEach, describe, expect, it, vi } from "vite-plus/test";

describe("desktop host detection", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("accepts an Electron preload as a native browser host", async () => {
    vi.stubGlobal("window", { desktopBridge: { preview: {} } });
    const env = await import("./env");
    expect(env.isElectron).toBe(true);
    expect(env.hasNativeBrowserHost).toBe(true);
  });

  it("does not treat the Tauri bridge shim as a native browser host", async () => {
    // Tauri installs the same desktopBridge surface, but its preview members are no-ops.
    vi.stubGlobal("window", {
      desktopBridge: { preview: {} },
      __TAURI__: { core: { invoke: () => Promise.resolve() } },
    });
    const env = await import("./env");
    expect(env.isElectron).toBe(true);
    expect(env.hasNativeBrowserHost).toBe(false);
  });
});
