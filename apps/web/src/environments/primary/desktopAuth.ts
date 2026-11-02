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

export function __resetDesktopPrimaryAuthForTests(): void {
  desktopBearerTokenPromise = null;
}
