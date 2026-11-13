/**
 * The layout settings of this device: the template new panes open from, where opened things land,
 * and the trackpad swipe. They live in this browser's storage, not on the server, because they
 * describe this machine. `startLayoutDeviceSettingsSync` pushes them into the live behavior store.
 */
import { create } from "zustand";

import { useLayoutBehaviorStore } from "./layoutBehavior";
import {
  DEFAULT_LAYOUT_SETTINGS,
  type LayoutNewTabPosition,
  type LayoutPaneKind,
  type LayoutSettings,
  type LayoutSidePaneOpensOn,
  type LayoutSidePanePlacement,
  type LayoutTemplate,
  type LayoutTerminalPlacement,
  type LayoutWhenNoRoom,
} from "./layoutSettings";

export const LAYOUT_DEVICE_SETTINGS_KEY = "houston:layout-settings:v1";

export interface LayoutDeviceSettings extends LayoutSettings {
  /** macOS only: one three-finger flick moves one column or workspace. */
  readonly threeFingerSwipe: boolean;
}

const PANE_KINDS: ReadonlySet<string> = new Set<LayoutPaneKind>([
  "chat",
  "terminal",
  "diff",
  "files",
  "browser",
]);
const TERMINAL: ReadonlySet<string> = new Set<LayoutTerminalPlacement>([
  "attached-below",
  "new-tab",
  "new-column",
]);
const SIDE_PANE: ReadonlySet<string> = new Set<LayoutSidePanePlacement>([
  "beside-chat",
  "new-tab",
  "new-column",
]);
const OPENS_ON: ReadonlySet<string> = new Set<LayoutSidePaneOpensOn>([
  "last-used",
  "diff",
  "files",
  "browser",
  "pull-request",
]);
const NEW_TAB: ReadonlySet<string> = new Set<LayoutNewTabPosition>(["after-current", "end"]);
const NO_ROOM: ReadonlySet<string> = new Set<LayoutWhenNoRoom>([
  "shrink-then-scroll",
  "always-shrink",
  "always-scroll",
]);

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isShare = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value > 0 && value <= 1;

function decodeTemplate(value: unknown): LayoutTemplate | null {
  if (!isObject(value) || !Array.isArray(value.columns) || value.columns.length === 0) return null;
  let chats = 0;
  const columns = [];
  for (const column of value.columns) {
    if (!isObject(column) || !isShare(column.size)) return null;
    if (!Array.isArray(column.panes) || column.panes.length === 0) return null;
    const panes = [];
    for (const pane of column.panes) {
      if (!isObject(pane) || !isShare(pane.size)) return null;
      if (typeof pane.kind !== "string" || !PANE_KINDS.has(pane.kind)) return null;
      if (pane.span !== "column" && pane.span !== "full") return null;
      if (pane.kind === "chat") chats += 1;
      panes.push({
        kind: pane.kind as LayoutPaneKind,
        size: pane.size,
        span: pane.span as "column" | "full",
      });
    }
    columns.push({ size: column.size, panes });
  }
  return chats === 0 ? null : { columns };
}

function pick<T extends string>(value: unknown, allowed: ReadonlySet<string>, fallback: T): T {
  return typeof value === "string" && allowed.has(value) ? (value as T) : fallback;
}

/** Any stored value becomes valid settings: an invalid field falls back to its default. */
export function decodeLayoutDeviceSettings(value: unknown): LayoutDeviceSettings {
  const input = isObject(value) ? value : {};
  const defaults = DEFAULT_LAYOUT_SETTINGS;
  const settings: LayoutDeviceSettings = {
    template: decodeTemplate(input.template) ?? defaults.template,
    terminalPlacement: pick(input.terminalPlacement, TERMINAL, defaults.terminalPlacement),
    sidePanePlacement: pick(input.sidePanePlacement, SIDE_PANE, defaults.sidePanePlacement),
    sidePaneOpensOn: pick(input.sidePaneOpensOn, OPENS_ON, defaults.sidePaneOpensOn),
    newTabPosition: pick(input.newTabPosition, NEW_TAB, defaults.newTabPosition),
    whenNoRoom: pick(input.whenNoRoom, NO_ROOM, defaults.whenNoRoom),
    threeFingerSwipe: input.threeFingerSwipe === true,
  };
  return settings;
}

function read(): LayoutDeviceSettings {
  try {
    const raw = window.localStorage.getItem(LAYOUT_DEVICE_SETTINGS_KEY);
    return decodeLayoutDeviceSettings(raw === null ? null : JSON.parse(raw));
  } catch {
    return decodeLayoutDeviceSettings(null);
  }
}

function write(settings: LayoutDeviceSettings): void {
  try {
    window.localStorage.setItem(LAYOUT_DEVICE_SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // A blocked or full store leaves the settings for this session only.
  }
}

export const useLayoutDeviceSettingsStore = create<{ settings: LayoutDeviceSettings }>(() => ({
  settings: read(),
}));

export function getLayoutDeviceSettings(): LayoutDeviceSettings {
  return useLayoutDeviceSettingsStore.getState().settings;
}

export function updateLayoutDeviceSettings(patch: Partial<LayoutDeviceSettings>): void {
  const settings = { ...getLayoutDeviceSettings(), ...patch };
  useLayoutDeviceSettingsStore.setState({ settings });
  write(settings);
}

/** Back to the defaults, and forget the stored copy. */
export function resetLayoutDeviceSettings(): void {
  useLayoutDeviceSettingsStore.setState({ settings: decodeLayoutDeviceSettings(null) });
}

function pushToBehavior(settings: LayoutDeviceSettings): void {
  const { template: _template, threeFingerSwipe: _swipe, ...behavior } = settings;
  useLayoutBehaviorStore.setState((state) => ({
    behavior: { ...state.behavior, ...behavior },
  }));
}

/** Keep the live layout behavior in step with these settings; returns the stop function. */
export function startLayoutDeviceSettingsSync(): () => void {
  pushToBehavior(getLayoutDeviceSettings());
  return useLayoutDeviceSettingsStore.subscribe((state) => pushToBehavior(state.settings));
}
