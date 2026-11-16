import { THREAD_TERMINAL_SURFACE_ID, type LayoutTab } from "../layout/layoutModel";
import { selectThreadRightPanelState, useRightPanelStore } from "../rightPanelStore";

/**
 * Whether a tab is one the phone does not offer: a terminal or a browser. Neither can be created
 * there, and a tab restored from another device must not open a desktop-only surface.
 */
export function useHiddenOnPhone(): (tab: LayoutTab) => boolean {
  const panels = useRightPanelStore((state) => state.byThreadKey);
  return (tab) => {
    const content = tab.content;
    if (content.kind !== "surface") return false;
    if (content.surfaceId === THREAD_TERMINAL_SURFACE_ID) return true;
    const surface = selectThreadRightPanelState(panels, content.threadRef).surfaces.find(
      (entry) => entry.id === content.surfaceId,
    );
    return surface?.kind === "terminal" || surface?.kind === "preview";
  };
}
