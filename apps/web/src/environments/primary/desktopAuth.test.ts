import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  __resetDesktopPrimaryAuthForTests,
  invalidateDesktopPrimaryBearerToken,
  readDesktopPrimaryBearerToken,
} from "./desktopAuth";

const bridge = {
  getLocalEnvironmentBearerToken: vi.fn(async () => "first-token"),
  invalidateLocalEnvironmentBearerToken: vi.fn(async () => undefined),
};

describe("desktop primary bearer", () => {
  beforeEach(() => {
    __resetDesktopPrimaryAuthForTests();
    bridge.getLocalEnvironmentBearerToken.mockReset();
    bridge.getLocalEnvironmentBearerToken.mockResolvedValue("first-token");
    bridge.invalidateLocalEnvironmentBearerToken.mockReset();
    vi.stubGlobal("window", { hostBridge: bridge });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("exchanges once and reuses the token for the app's lifetime", async () => {
    await expect(readDesktopPrimaryBearerToken()).resolves.toBe("first-token");
    await expect(readDesktopPrimaryBearerToken()).resolves.toBe("first-token");
    expect(bridge.getLocalEnvironmentBearerToken).toHaveBeenCalledTimes(1);
  });

  it("drops both caches after a rejection so the next request exchanges again", async () => {
    await readDesktopPrimaryBearerToken();
    invalidateDesktopPrimaryBearerToken();
    expect(bridge.invalidateLocalEnvironmentBearerToken).toHaveBeenCalledTimes(1);

    bridge.getLocalEnvironmentBearerToken.mockResolvedValue("second-token");
    await expect(readDesktopPrimaryBearerToken()).resolves.toBe("second-token");
    expect(bridge.getLocalEnvironmentBearerToken).toHaveBeenCalledTimes(2);
  });
});
