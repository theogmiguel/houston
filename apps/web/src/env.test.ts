import { afterEach, describe, expect, it, vi } from "vite-plus/test";

describe("desktop host detection", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("detects the desktop host bridge", async () => {
    vi.stubGlobal("window", { hostBridge: { preview: {} } });
    const env = await import("./env");
    expect(env.isDesktopHost).toBe(true);
  });

  it("treats a plain browser without the bridge as a web client", async () => {
    vi.stubGlobal("window", {});
    const env = await import("./env");
    expect(env.isDesktopHost).toBe(false);
  });
});
