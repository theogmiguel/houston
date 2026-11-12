import { createLayoutState } from "../src/layout/layoutModel";
import { LAYOUT_TOUR_KEY } from "../src/layout/LayoutOnboarding";
import { useLayoutStore } from "../src/layout/layoutStore";

/**
 * Gives the layout store a first snapshot with one empty workspace, as the server sends one, for
 * a returning user who has seen the layout tour. The fake environment answers no layout stream, so
 * an app mounted against it would otherwise never leave the loading state and draw no layout.
 */
export function loadEmptyLayout(): void {
  localStorage.setItem(LAYOUT_TOUR_KEY, "true");
  useLayoutStore.getState().setLayoutFromServer(createLayoutState());
}
