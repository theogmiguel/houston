import type { HostBridge } from "@houston-app/contracts";

interface TauriCore {
  readonly invoke?: (command: string, args?: Record<string, unknown>) => Promise<unknown>;
}

interface TauriGlobal {
  readonly core?: TauriCore;
}

interface WindowWithTauri {
  readonly __TAURI__?: TauriGlobal;
}

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

export type WindowResizeDirection =
  | "north"
  | "south"
  | "east"
  | "west"
  | "north-east"
  | "north-west"
  | "south-east"
  | "south-west";

const WINDOW_CONTROL_COMMANDS: Record<WindowControlAction, string> = {
  close: "plugin:window|close",
  minimize: "plugin:window|minimize",
  maximize: "plugin:window|toggle_maximize",
};

function tauriCore(): TauriCore | null {
  if (typeof window === "undefined") return null;
  const core = (window as WindowWithTauri).__TAURI__?.core;
  return typeof core?.invoke === "function" ? core : null;
}

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

/** Whether this renderer runs inside one of Houston's native desktop hosts. */
export function isNativeDesktopHost(): boolean {
  return hostWindowBridge() !== null || tauriCore() !== null;
}

/**
 * Whether the host lets Houston draw the window chrome. Electron uses native
 * traffic lights on macOS, so only Linux and Windows are frameless there.
 */
export function hasCustomWindowChrome(): boolean {
  const bridge = hostWindowBridge();
  if (bridge === null) return tauriCore() !== null;
  try {
    return bridge.getClientPlatform() !== "darwin";
  } catch {
    return true;
  }
}

/** The Tauri host is still in the tree and keeps its own resize-drag command. */
export function isTauriHost(): boolean {
  return tauriCore() !== null;
}

/** The quick composer is its own always-on-top window; it gets no window chrome. */
export function isQuickComposerWindow(): boolean {
  return (
    typeof window !== "undefined" &&
    window.location.hash.replace(/^#/, "").startsWith("/quick-composer")
  );
}

async function invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  const core = tauriCore();
  if (core?.invoke === undefined) {
    throw new Error(
      `desktopWindow: ${command} needs a Tauri host, but __TAURI__.core.invoke is absent`,
    );
  }
  return (await core.invoke(command, args)) as T;
}

/** Ubuntu/GNOME's button layout, or null when the setting cannot be read. */
export async function windowButtonLayout(): Promise<string | null> {
  const bridge = hostWindowBridge();
  if (bridge !== null) {
    try {
      return (await bridge.getWindowButtonLayout()) ?? null;
    } catch {
      return null;
    }
  }
  if (!isTauriHost()) return null;
  try {
    return (await invoke<string | null>("window_button_layout", {})) ?? null;
  } catch {
    return null;
  }
}

export async function windowControl(action: WindowControlAction): Promise<void> {
  const bridge = hostWindowBridge();
  if (bridge !== null) {
    if (action === "close") await bridge.closeWindow();
    else if (action === "minimize") await bridge.minimizeWindow();
    else await bridge.toggleMaximizeWindow();
    return;
  }
  if (!isTauriHost()) return;
  await invoke<void>(WINDOW_CONTROL_COMMANDS[action], {});
}

export async function windowIsMaximized(): Promise<boolean> {
  const bridge = hostWindowBridge();
  if (bridge !== null) return bridge.getWindowMaximizedState();
  if (!isTauriHost()) return false;
  return invoke<boolean>("plugin:window|is_maximized", {});
}

/** A maximize that skips the window buttons, such as a title-bar double-click. */
export function onWindowMaximizedChange(listener: (maximized: boolean) => void): () => void {
  const bridge = hostWindowBridge();
  return bridge === null ? () => {} : bridge.onWindowMaximizedStateChange(listener);
}

export async function startResizeDragging(direction: WindowResizeDirection): Promise<void> {
  // Electron's frameless windows resize from their native edges.
  if (hostWindowBridge() !== null) return;
  if (!isTauriHost()) return;
  await invoke<void>("window_start_resize_dragging", { direction });
}
