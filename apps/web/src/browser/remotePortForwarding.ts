import type { EnvironmentId } from "@houston-app/contracts";

import { isDesktopLocalConnectionTarget } from "~/connection/desktopLocal";
import { isDesktopHost } from "~/env";
import { readPreparedConnection } from "~/state/session";
import { stackedThreadToast, toastManager } from "~/components/ui/toast";

/** A saved environment that is not this machine, and so has a port to forward. */
export function needsLoopbackForward(environmentId: EnvironmentId): boolean {
  if (!isDesktopHost || window.hostBridge === undefined) return false;
  const target = readPreparedConnection(environmentId)?.target;
  if (target === undefined) return false;
  return (
    target._tag === "SshConnectionTarget" ||
    (target._tag === "BearerConnectionTarget" && !isDesktopLocalConnectionTarget(target))
  );
}

/**
 * Starts or reuses this device's forward for a loopback URL in a remote
 * environment and returns the local URL. A failure returns the original URL
 * so a directly reachable service can still open.
 */
export async function forwardLoopbackUrl(
  environmentId: EnvironmentId,
  rawUrl: string,
): Promise<string> {
  const parsed = URL.parse(rawUrl);
  if (parsed === null || window.hostBridge === undefined) return rawUrl;
  const port = Number.parseInt(parsed.port, 10);
  if (!Number.isInteger(port) || port <= 0) return rawUrl;
  try {
    const forward = await window.hostBridge.startPortForward({ environmentId, remotePort: port });
    return `${parsed.protocol}//localhost:${forward.localPort}${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch (error) {
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title: "Could not forward port",
        description: error instanceof Error ? error.message : String(error),
      }),
    );
    return rawUrl;
  }
}
