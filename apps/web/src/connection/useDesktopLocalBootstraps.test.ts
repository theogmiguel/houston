import type { DesktopEnvironmentBootstrap, HostBridge } from "@houston-app/contracts";
import { AtomRegistry } from "effect/reactivity";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

// A fresh module per test, so its shared host subscription binds that test's bridge.
const loadAtom = async () =>
  (await import("./useDesktopLocalBootstraps")).desktopLocalBootstrapsAtom;

const wsl: DesktopEnvironmentBootstrap = {
  id: "wsl:default",
  label: "WSL",
  runningDistro: "Ubuntu",
  httpBaseUrl: "http://127.0.0.1:4000",
  wsBaseUrl: "ws://127.0.0.1:4000",
};

function installHost() {
  let entries: Array<DesktopEnvironmentBootstrap> = [];
  const notices = new Set<() => void>();
  const bridge = {
    getLocalEnvironmentBootstraps: vi.fn(() => entries.map((entry) => ({ ...entry }))),
    onServerStatus: () => () => undefined,
    onLocalEnvironmentBootstrapsChanged: (listener: () => void) => {
      notices.add(listener);
      return () => notices.delete(listener);
    },
  };
  vi.stubGlobal("window", { hostBridge: bridge as unknown as HostBridge });
  return {
    bridge,
    setEntries: (next: Array<DesktopEnvironmentBootstrap>) => {
      entries = next;
    },
    notice: () => {
      for (const listener of notices) listener();
    },
  };
}

describe("desktop local bootstraps", { concurrent: false }, () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("does not re-read the host every two seconds while nothing changes", async () => {
    const host = installHost();
    const desktopLocalBootstrapsAtom = await loadAtom();
    const registry = AtomRegistry.make();
    const release = registry.mount(desktopLocalBootstrapsAtom);

    vi.advanceTimersByTime(60_000);

    // One read on mount and one per safety poll.
    expect(host.bridge.getLocalEnvironmentBootstraps.mock.calls.length).toBeLessThanOrEqual(3);
    release();
  });

  it("re-reads as soon as the host announces a change", async () => {
    const host = installHost();
    const desktopLocalBootstrapsAtom = await loadAtom();
    const registry = AtomRegistry.make();
    const release = registry.mount(desktopLocalBootstrapsAtom);
    expect(registry.get(desktopLocalBootstrapsAtom)).toEqual([]);

    host.setEntries([wsl]);
    host.notice();

    expect(registry.get(desktopLocalBootstrapsAtom)).toEqual([wsl]);
    release();
  });

  it("corrects a missed announcement on the safety poll", async () => {
    const host = installHost();
    const desktopLocalBootstrapsAtom = await loadAtom();
    const registry = AtomRegistry.make();
    const release = registry.mount(desktopLocalBootstrapsAtom);

    host.setEntries([wsl]);
    vi.advanceTimersByTime(29_000);
    expect(registry.get(desktopLocalBootstrapsAtom)).toEqual([]);
    vi.advanceTimersByTime(1_000);

    expect(registry.get(desktopLocalBootstrapsAtom)).toEqual([wsl]);
    release();
  });
});
