import { isDesktopHost } from "../env";
import { isMacPlatform } from "../lib/utils";

/** The three traffic lights and their margin: a window bar at the leading edge starts after them. */
export const MAC_TRAFFIC_LIGHTS_INSET = "4.75rem";

export interface LayoutChromeEnvironment {
  mac: boolean;
  desktopHost: boolean;
  /** The pane touches the window's top-left corner. */
  leadingEdge: boolean;
  /** The pane touches the window's top-right corner. */
  trailingEdge: boolean;
}

/**
 * The room a window-bar tab strip leaves for native window chrome: the macOS traffic lights at
 * the leading edge, and the caption buttons (`--workspace-native-controls-inset`, 0 where the
 * window has none) at the trailing edge.
 */
export function layoutChromeInsets(environment: LayoutChromeEnvironment): {
  leading: string | undefined;
  trailing: string | undefined;
} {
  const { mac, desktopHost, leadingEdge, trailingEdge } = environment;
  return {
    leading: mac && desktopHost && leadingEdge ? MAC_TRAFFIC_LIGHTS_INSET : undefined,
    trailing:
      !mac && desktopHost && trailingEdge ? "var(--workspace-native-controls-inset)" : undefined,
  };
}

export function currentLayoutChromeInsets(edges: { leadingEdge: boolean; trailingEdge: boolean }) {
  return layoutChromeInsets({
    mac: typeof navigator !== "undefined" && isMacPlatform(navigator.platform),
    desktopHost: isDesktopHost,
    ...edges,
  });
}
