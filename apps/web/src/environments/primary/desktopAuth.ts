let desktopBearerTokenPromise: Promise<string> | null = null;

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
    throw error;
  });
  return desktopBearerTokenPromise;
}

/**
 * The server rejected the cached bearer (expired, or a new bootstrap exchange
 * revoked it). Drop both caches so the next request exchanges a fresh token.
 */
export function invalidateDesktopPrimaryBearerToken(): void {
  desktopBearerTokenPromise = null;
  void window.hostBridge?.invalidateLocalEnvironmentBearerToken?.().catch(() => undefined);
}

export function __resetDesktopPrimaryAuthForTests(): void {
  desktopBearerTokenPromise = null;
}
