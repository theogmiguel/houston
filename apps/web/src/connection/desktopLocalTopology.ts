import type { DesktopLocalServerStatus, HostBridge } from "@houston-app/contracts";

/** Heals a missed host notice; bootstrap tokens rotate in hours, so nothing needs it sooner. */
export const DESKTOP_LOCAL_TOPOLOGY_SAFETY_POLL_MS = 30_000;

type DesktopLocalTopologyBridge = Pick<
  HostBridge,
  "onServerStatus" | "onLocalEnvironmentBootstrapsChanged"
>;

/** One subscription to the host's notices and one safety poll, however many readers listen. */
export function createDesktopLocalTopologyChanges(
  resolveBridge: () => Partial<DesktopLocalTopologyBridge> | undefined,
): (listener: () => void) => () => void {
  const listeners = new Set<() => void>();
  let stop: (() => void) | null = null;
  const notify = () => {
    for (const listener of listeners) listener();
  };
  const start = () => {
    const bridge = resolveBridge();
    const unsubscribeStatus = bridge?.onServerStatus?.(notify);
    const unsubscribeBootstraps = bridge?.onLocalEnvironmentBootstrapsChanged?.(notify);
    const timer = setInterval(notify, DESKTOP_LOCAL_TOPOLOGY_SAFETY_POLL_MS);
    return () => {
      clearInterval(timer);
      unsubscribeStatus?.();
      unsubscribeBootstraps?.();
    };
  };
  return (listener) => {
    listeners.add(listener);
    stop ??= start();
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0 && stop !== null) {
        stop();
        stop = null;
      }
    };
  };
}

export const subscribeDesktopLocalTopology = createDesktopLocalTopologyChanges(() =>
  typeof window === "undefined" ? undefined : window.hostBridge,
);

/** Reports the host's server status now, on each pushed change and on the safety poll. */
export function watchDesktopServerStatus(
  bridge: Pick<HostBridge, "getServerStatus" | "onServerStatus">,
  onStatus: (status: DesktopLocalServerStatus | null) => void,
  subscribe: (listener: () => void) => () => void = subscribeDesktopLocalTopology,
): () => void {
  let active = true;
  const refresh = () => {
    void bridge
      .getServerStatus()
      .then((next) => {
        if (active) onStatus(next);
      })
      .catch(() => undefined);
  };
  refresh();
  const unsubscribeStatus = bridge.onServerStatus?.((next) => {
    if (active) onStatus(next);
  });
  const unsubscribeTopology = subscribe(refresh);
  return () => {
    active = false;
    unsubscribeStatus?.();
    unsubscribeTopology();
  };
}
