import type { HostBridge } from "@houston-app/contracts";

export function getDesktopSnapShotBridge(): HostBridge | undefined {
  return typeof window === "undefined" ? undefined : window.hostBridge;
}
