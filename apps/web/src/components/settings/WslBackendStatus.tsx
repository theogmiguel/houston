import type { DesktopWslState } from "@houston-app/contracts";
import { useEffect } from "react";

import { refreshDesktopWslState } from "~/state/desktopWslState";
import { LayoutErrorText } from "../ui/layout-overlay";
import { describeWslBackendStatus } from "./ConnectionsSettings.logic";

// Mirrors the local server banner's poll, the cadence for status the host does not push.
const WSL_BACKEND_STATUS_POLL_MS = 4_000;

/** The secondary WSL instance's status line, refreshed while it is enabled. */
export function WslBackendStatus({ state }: { readonly state: DesktopWslState }) {
  const enabled = state.enabled;

  // oxlint-disable-next-line houston/no-unreasoned-state-sync -- polls the host's WSL status while the row is visible
  useEffect(() => {
    if (!enabled) return;
    const timer = window.setInterval(refreshDesktopWslState, WSL_BACKEND_STATUS_POLL_MS);
    return () => window.clearInterval(timer);
  }, [enabled]);

  const status = describeWslBackendStatus(state);
  if (status === null) return null;

  if (status.failed) return <LayoutErrorText>{status.text}</LayoutErrorText>;
  return <p role="status">{status.text}</p>;
}
