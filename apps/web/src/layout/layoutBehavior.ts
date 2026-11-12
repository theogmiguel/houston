/**
 * How the layout behaves when things open: where the terminal and the side
 * pane go, which tab the side pane starts on, where new tabs land, and what
 * happens when a new pane has no room.
 */
import { create } from "zustand";

import type { LayoutCompanionKind } from "./layoutModel";
import { DEFAULT_LAYOUT_SETTINGS, type LayoutSettings } from "./layoutSettings";

export type {
  LayoutNewTabPosition,
  LayoutSidePaneOpensOn,
  LayoutSidePanePlacement,
  LayoutTerminalPlacement,
  LayoutWhenNoRoom,
} from "./layoutSettings";

export type LayoutBehavior = Omit<LayoutSettings, "template"> & {
  /** The share a new terminal or side pane takes from its chat. */
  readonly companionShares: Partial<Record<LayoutCompanionKind, number>>;
};

const DEFAULT_LAYOUT_BEHAVIOR: LayoutBehavior = {
  terminalPlacement: DEFAULT_LAYOUT_SETTINGS.terminalPlacement,
  sidePanePlacement: DEFAULT_LAYOUT_SETTINGS.sidePanePlacement,
  sidePaneOpensOn: DEFAULT_LAYOUT_SETTINGS.sidePaneOpensOn,
  newTabPosition: DEFAULT_LAYOUT_SETTINGS.newTabPosition,
  whenNoRoom: DEFAULT_LAYOUT_SETTINGS.whenNoRoom,
  companionShares: {},
};

export const useLayoutBehaviorStore = create<{ behavior: LayoutBehavior }>(() => ({
  behavior: DEFAULT_LAYOUT_BEHAVIOR,
}));

/** The layout behavior for this client. */
export function useLayoutBehavior(): LayoutBehavior {
  return useLayoutBehaviorStore((state) => state.behavior);
}

/** For event handlers and store actions outside React. */
export function getLayoutBehavior(): LayoutBehavior {
  return useLayoutBehaviorStore.getState().behavior;
}
