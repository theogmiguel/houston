import type { PortForward } from "@houston-app/contracts/houston/portForwarding";
import { useEffect, useState } from "react";

const EMPTY: ReadonlyArray<PortForward> = [];

/** Every forward this device holds, kept current by the desktop host. */
export function usePortForwards(): ReadonlyArray<PortForward> {
  const [forwards, setForwards] = useState<ReadonlyArray<PortForward>>(EMPTY);

  // oxlint-disable-next-line houston/no-unreasoned-state-sync -- keeps the host's forward list in step with the panel while it is mounted
  useEffect(() => {
    const bridge = window.hostBridge;
    if (bridge === undefined) return;
    let active = true;
    void bridge
      .listPortForwards()
      .then((current) => {
        if (active) setForwards(current);
      })
      .catch(() => undefined);
    const unsubscribe = bridge.onPortForwardsChanged((next) => {
      if (active) setForwards(next);
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  return forwards;
}
