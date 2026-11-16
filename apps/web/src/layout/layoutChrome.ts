import { COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS } from "../workspaceTitlebar";

/**
 * The room the window's native caption buttons take at the trailing edge: Windows' and Linux's
 * (`.wco`) and Houston's own on a frameless window (`.custom-chrome`). The variable is 0 where the
 * window has none, so a browser and macOS need no case of their own.
 */
export const NATIVE_CONTROLS_INSET = "var(--workspace-native-controls-inset)";

export interface LayoutChromeEdges {
  /** The pane touches the window's top-left corner. */
  leadingEdge: boolean;
  /** The pane touches the window's top-right corner. */
  trailingEdge: boolean;
}

/**
 * The room a window-bar tab strip leaves for window chrome. Leading edge: the class pads by
 * `--workspace-titlebar-content-left` (the sidebar toggle and, on macOS, the traffic lights) while
 * the sidebar is collapsed. Trailing edge: the native caption buttons.
 */
export function layoutChromeInsets({ leadingEdge, trailingEdge }: LayoutChromeEdges): {
  leadingClassName: string | undefined;
  trailing: string | undefined;
} {
  return {
    leadingClassName: leadingEdge ? COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS : undefined,
    trailing: trailingEdge ? NATIVE_CONTROLS_INSET : undefined,
  };
}
