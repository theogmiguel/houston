import type { HostBridge } from "@houston-app/contracts";

type HostWindowBridge = Pick<
  HostBridge,
  | "getClientPlatform"
  | "closeWindow"
  | "minimizeWindow"
  | "toggleMaximizeWindow"
  | "getWindowMaximizedState"
  | "onWindowMaximizedStateChange"
  | "getWindowButtonLayout"
>;

export type WindowControlAction = "close" | "minimize" | "maximize";

/** The Electron preload bridge, when it carries every window chrome member. */
function hostWindowBridge(): HostWindowBridge | null {
  if (typeof window === "undefined") return null;
  const bridge = window.hostBridge;
  if (
    bridge === undefined ||
    typeof bridge.getClientPlatform !== "function" ||
    typeof bridge.closeWindow !== "function" ||
    typeof bridge.minimizeWindow !== "function" ||
    typeof bridge.toggleMaximizeWindow !== "function" ||
    typeof bridge.getWindowMaximizedState !== "function" ||
    typeof bridge.onWindowMaximizedStateChange !== "function" ||
    typeof bridge.getWindowButtonLayout !== "function"
  ) {
    return null;
  }
  return bridge;
}

/** Whether this renderer runs inside Houston's native desktop host. */
export function isNativeDesktopHost(): boolean {
  return hostWindowBridge() !== null;
}

/**
 * Whether the host lets Houston draw the window chrome. Electron uses native
 * traffic lights on macOS, so only Linux and Windows are frameless.
 */
export function hasCustomWindowChrome(): boolean {
  const bridge = hostWindowBridge();
  if (bridge === null) return false;
  try {
    return bridge.getClientPlatform() !== "darwin";
  } catch {
    return true;
  }
}

/** The quick composer is its own always-on-top window; it gets no window chrome. */
export function isQuickComposerWindow(): boolean {
  return (
    typeof window !== "undefined" &&
    window.location.hash.replace(/^#/, "").startsWith("/quick-composer")
  );
}

/** Ubuntu/GNOME's button layout, or null when the setting cannot be read. */
export async function windowButtonLayout(): Promise<string | null> {
  const bridge = hostWindowBridge();
  if (bridge === null) return null;
  try {
    return (await bridge.getWindowButtonLayout()) ?? null;
  } catch {
    return null;
  }
}

export async function windowControl(action: WindowControlAction): Promise<void> {
  const bridge = hostWindowBridge();
  if (bridge === null) return;
  if (action === "close") await bridge.closeWindow();
  else if (action === "minimize") await bridge.minimizeWindow();
  else await bridge.toggleMaximizeWindow();
}

export async function windowIsMaximized(): Promise<boolean> {
  const bridge = hostWindowBridge();
  return bridge === null ? false : bridge.getWindowMaximizedState();
}

/** A maximize that skips the window buttons, such as a title-bar double-click. */
export function onWindowMaximizedChange(listener: (maximized: boolean) => void): () => void {
  const bridge = hostWindowBridge();
  return bridge === null ? () => {} : bridge.onWindowMaximizedStateChange(listener);
}
