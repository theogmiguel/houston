import type { DesktopLocalServerStatus } from "@houston-app/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  DESKTOP_LOCAL_TOPOLOGY_SAFETY_POLL_MS,
  createDesktopLocalTopologyChanges,
  watchDesktopServerStatus,
} from "./desktopLocalTopology";

function fakeHost(initial: DesktopLocalServerStatus) {
  let status = initial;
  const statusListeners = new Set<(status: DesktopLocalServerStatus) => void>();
  const noticeListeners = new Set<() => void>();
  const bridge = {
    getServerStatus: vi.fn(async () => status),
    onServerStatus: (listener: (status: DesktopLocalServerStatus) => void) => {
      statusListeners.add(listener);
      return () => statusListeners.delete(listener);
    },
    onLocalEnvironmentBootstrapsChanged: (listener: () => void) => {
      noticeListeners.add(listener);
      return () => noticeListeners.delete(listener);
    },
  };
  return {
    bridge,
    subscriptions: () => statusListeners.size + noticeListeners.size,
    setStatus: (next: DesktopLocalServerStatus) => {
      status = next;
    },
    push: (next: DesktopLocalServerStatus) => {
      status = next;
      for (const listener of statusListeners) listener(next);
    },
  };
}

describe("desktop local topology", { concurrent: false }, () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("shares one host subscription and one safety poll among its readers", () => {
    const host = fakeHost({ state: "ready" });
    const subscribe = createDesktopLocalTopologyChanges(() => host.bridge);
    const first = vi.fn();
    const second = vi.fn();

    const stopFirst = subscribe(first);
    const stopSecond = subscribe(second);
    expect(vi.getTimerCount()).toBe(1);
    expect(host.subscriptions()).toBe(2);

    vi.advanceTimersByTime(DESKTOP_LOCAL_TOPOLOGY_SAFETY_POLL_MS);
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);

    stopFirst();
    stopSecond();
    expect(vi.getTimerCount()).toBe(0);
    expect(host.subscriptions()).toBe(0);
  });

  it("does not ask for the server status every few seconds while nothing changes", async () => {
    const host = fakeHost({ state: "ready" });
    const subscribe = createDesktopLocalTopologyChanges(() => host.bridge);
    const stop = watchDesktopServerStatus(host.bridge, () => undefined, subscribe);

    await vi.advanceTimersByTimeAsync(60_000);

    // One read at start and one per safety poll.
    expect(host.bridge.getServerStatus.mock.calls.length).toBeLessThanOrEqual(3);
    stop();
  });

  it("applies a pushed status at once and corrects a missed one on the safety poll", async () => {
    const host = fakeHost({ state: "starting" });
    const subscribe = createDesktopLocalTopologyChanges(() => host.bridge);
    const seen: Array<DesktopLocalServerStatus["state"] | undefined> = [];
    const stop = watchDesktopServerStatus(host.bridge, (next) => seen.push(next?.state), subscribe);
    await vi.advanceTimersByTimeAsync(0);
    expect(seen.at(-1)).toBe("starting");

    host.push({ state: "ready" });
    expect(seen.at(-1)).toBe("ready");

    host.setStatus({ state: "error", error: "The server exited." });
    await vi.advanceTimersByTimeAsync(DESKTOP_LOCAL_TOPOLOGY_SAFETY_POLL_MS - 1_000);
    expect(seen.at(-1)).toBe("ready");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(seen.at(-1)).toBe("error");
    stop();
  });
});
