import type { EnvironmentId } from "@houston-app/contracts";
import { isLoopbackHost } from "@houston-app/shared/preview";

import { isDesktopLocalConnectionTarget } from "~/connection/desktopLocal";
import { isDesktopHost } from "~/env";
import { readPreparedConnection } from "~/state/session";
import { stackedThreadToast, toastManager } from "~/components/ui/toast";

/** Whether this environment runs somewhere other than this machine. */
export function isRemoteEnvironment(environmentId: EnvironmentId): boolean {
  const target = readPreparedConnection(environmentId)?.target;
  if (target === undefined) return false;
  return (
    target._tag === "SshConnectionTarget" ||
    (target._tag === "BearerConnectionTarget" && !isDesktopLocalConnectionTarget(target))
  );
}

/** A saved environment that is not this machine, and so has a port to forward. */
export function needsLoopbackForward(environmentId: EnvironmentId): boolean {
  return isDesktopHost && window.hostBridge !== undefined && isRemoteEnvironment(environmentId);
}

const DEFAULT_PORTS: Readonly<Record<string, number>> = { "http:": 80, "https:": 443 };

/**
 * Starts or reuses this device's forward for a loopback URL in a remote
 * environment and returns the local URL. An address that is not loopback is
 * returned as written. A failed forward returns null: the loopback address
 * would otherwise open this machine's own service on that port.
 */
export async function forwardLoopbackUrl(
  environmentId: EnvironmentId,
  rawUrl: string,
): Promise<string | null> {
  const parsed = URL.parse(rawUrl);
  if (parsed === null || window.hostBridge === undefined || !isLoopbackHost(parsed.hostname)) {
    return rawUrl;
  }
  const port =
    parsed.port === "" ? (DEFAULT_PORTS[parsed.protocol] ?? 0) : Number.parseInt(parsed.port, 10);
  if (!Number.isInteger(port) || port <= 0) return rawUrl;
  try {
    const forward = await window.hostBridge.startPortForward({ environmentId, remotePort: port });
    return `${parsed.protocol}//127.0.0.1:${forward.localPort}${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch (error) {
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title: "Could not forward port",
        description: error instanceof Error ? error.message : String(error),
      }),
    );
    return null;
  }
}
