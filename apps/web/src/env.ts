// Preload installs desktopBridge before web code runs, so module-load detection is reliable.
export const isElectron = typeof window !== "undefined" && window.desktopBridge !== undefined;

interface WindowWithTauri {
  readonly __TAURI__?: unknown;
}

/**
 * The Tauri host installs a `desktopBridge` shim with no-op preview members so the shared
 * renderer can run, but it has no webview host: browser tabs there render through the server
 * stream. Anything that needs a real Electron webview must check this, not `isElectron`.
 */
export const hasNativeBrowserHost =
  isElectron && (window as WindowWithTauri).__TAURI__ === undefined;

export const isSecretsFeatureEnabled = ["1", "true"].includes(
  import.meta.env.T3CODE_FEATURE_SECRETS?.trim().toLowerCase() ?? "",
);
