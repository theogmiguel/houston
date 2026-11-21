import { EnvironmentId } from "@houston-app/contracts";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

const toasts = vi.hoisted(() => ({ added: [] as unknown[] }));

vi.mock(import("~/components/ui/toast"), () => ({
  stackedThreadToast: ((input: unknown) => input) as never,
  toastManager: { add: (toast: unknown) => void toasts.added.push(toast) } as never,
}));

import { forwardLoopbackUrl } from "./remotePortForwarding";

const ENVIRONMENT_ID = EnvironmentId.make("environment-remote");

function setBridge(startPortForward: (input: unknown) => Promise<{ localPort: number }>) {
  vi.stubGlobal("window", { hostBridge: { startPortForward } });
}

afterEach(() => {
  vi.unstubAllGlobals();
  toasts.added.length = 0;
});

describe("forwardLoopbackUrl", () => {
  it("rewrites a loopback URL to the forward's local port", async () => {
    setBridge(async () => ({ localPort: 5433 }));
    await expect(
      forwardLoopbackUrl(ENVIRONMENT_ID, "http://localhost:3000/app?x=1#top"),
    ).resolves.toBe("http://127.0.0.1:5433/app?x=1#top");
  });

  it("forwards the protocol's default port when the URL names none", async () => {
    const requested: unknown[] = [];
    setBridge(async (input) => {
      requested.push(input);
      return { localPort: 8080 };
    });
    await forwardLoopbackUrl(ENVIRONMENT_ID, "http://localhost/");
    await forwardLoopbackUrl(ENVIRONMENT_ID, "https://localhost/");
    expect(requested).toEqual([
      { environmentId: ENVIRONMENT_ID, remotePort: 80 },
      { environmentId: ENVIRONMENT_ID, remotePort: 443 },
    ]);
  });

  it("returns nothing when forwarding fails, so the caller never opens this machine's own port", async () => {
    setBridge(async () => {
      throw new Error("Port forwarding is off.");
    });
    await expect(forwardLoopbackUrl(ENVIRONMENT_ID, "http://localhost:3000/")).resolves.toBeNull();
    expect(toasts.added).toHaveLength(1);
  });

  it("leaves an address that is not loopback as written", async () => {
    setBridge(async () => ({ localPort: 1 }));
    await expect(forwardLoopbackUrl(ENVIRONMENT_ID, "https://build.example.com/")).resolves.toBe(
      "https://build.example.com/",
    );
  });
});
