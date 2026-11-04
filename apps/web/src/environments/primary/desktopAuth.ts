import type { DesktopLocalServerStatus } from "@houston-app/contracts";
import * as Schema from "effect/Schema";

let desktopBearerTokenPromise: Promise<string> | null = null;

/** The host refused the bearer IPC, usually because the local server has not started yet. */
export class DesktopPrimaryBearerUnavailableError extends Schema.TaggedError<DesktopPrimaryBearerUnavailableError>()(
  "DesktopPrimaryBearerUnavailableError",
  {
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    const detail = this.cause instanceof Error ? this.cause.message : String(this.cause);
    return `The desktop host could not provide a credential for the local server: ${detail}`;
  }
}

export function readDesktopPrimaryBearerToken(): Promise<string | null> {
  if (typeof window === "undefined") {
    return Promise.resolve(null);
  }
  const bridge = window.hostBridge;
  if (!bridge) {
    return Promise.resolve(null);
  }

  desktopBearerTokenPromise ??= bridge.getLocalEnvironmentBearerToken().catch((error) => {
    desktopBearerTokenPromise = null;
    throw new DesktopPrimaryBearerUnavailableError({ cause: error });
  });
  return desktopBearerTokenPromise;
}

/** The server rejected the cached bearer: drop both caches so the next request exchanges anew. */
export function invalidateDesktopPrimaryBearerToken(): void {
  desktopBearerTokenPromise = null;
  void window.hostBridge?.invalidateLocalEnvironmentBearerToken?.().catch(() => undefined);
}

/** Null without a desktop host, or when the host cannot report its server. */
export async function readDesktopServerState(): Promise<DesktopLocalServerStatus["state"] | null> {
  const status = await window.hostBridge?.getServerStatus?.().catch(() => null);
  return status?.state ?? null;
}

/** Resolves at the host's next server status event, or after `timeoutMs` if none arrives. */
export function waitForDesktopServerStatus(timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    let unsubscribe: (() => void) | undefined;
    const finish = () => {
      clearTimeout(timer);
      unsubscribe?.();
      resolve();
    };
    const timer = setTimeout(finish, timeoutMs);
    unsubscribe = window.hostBridge?.onServerStatus?.(finish);
  });
}

export function __resetDesktopPrimaryAuthForTests(): void {
  desktopBearerTokenPromise = null;
}
