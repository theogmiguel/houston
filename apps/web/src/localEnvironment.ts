export function isLocalEnvironmentDisabled(): boolean {
  return typeof window !== "undefined" && window.hostBridge?.getLocalEnvironmentEnabled() === false;
}
