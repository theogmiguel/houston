interface TauriCore {
  readonly invoke?: (command: string, args?: Record<string, unknown>) => Promise<unknown>;
}

interface TauriGlobal {
  readonly core?: TauriCore;
}

interface WindowWithTauri {
  readonly __TAURI__?: TauriGlobal;
}

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

export function isTauriHost(): boolean {
  return tauriCore() !== null;
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
  if (!isTauriHost()) return null;
  try {
    return (await invoke<string | null>("window_button_layout", {})) ?? null;
  } catch {
    return null;
  }
}

export async function windowControl(action: WindowControlAction): Promise<void> {
  if (!isTauriHost()) return;
  await invoke<void>(WINDOW_CONTROL_COMMANDS[action], {});
}

export async function windowIsMaximized(): Promise<boolean> {
  if (!isTauriHost()) return false;
  return invoke<boolean>("plugin:window|is_maximized", {});
}

export async function startResizeDragging(direction: WindowResizeDirection): Promise<void> {
  if (!isTauriHost()) return;
  await invoke<void>("window_start_resize_dragging", { direction });
}
