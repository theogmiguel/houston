import { createContext, use, useLayoutEffect, useRef } from "react";

import { BackgroundThreadContext } from "../components/chat/backgroundThread";

/**
 * Only the focused chat handles global input; only visible chats count as visited.
 * Outside a layout host, the default is one focused, visible view.
 */
export interface LayoutPaneState {
  readonly tabId: string | null;
  /** The pane the tab sits in; its notch lists the pane's other tabs. */
  readonly paneId: string | null;
  /**
   * Several panes share the strip: each draws its own pane, so window-anchored header controls
   * anchor to the pane instead.
   */
  readonly split: boolean;
  /** The pane is too narrow for the right panel beside the chat; it opens as a sheet. */
  readonly narrow: boolean;
  /** The pane touches the window's top-left corner, where the sidebar toggle and traffic lights sit. */
  readonly leadingEdge: boolean;
  /** The pane touches the window's top-right corner, where the caption buttons sit. */
  readonly trailingEdge: boolean;
  /** The pane holds keyboard focus; the URL follows this tab. Exactly one pane does. */
  readonly focused: boolean;
  /**
   * A chat whose thread's surface tab has focus. It answers only the thread's own commands and
   * lends the surface its composer; DOM focus and every other shortcut belong to the focused
   * surface.
   */
  readonly related: boolean;
  /** The tab is on screen: the active tab of a pane in the focused workspace. */
  readonly visible: boolean;
  /**
   * The tab's pane is within a window of the strip's camera (or drawn large enough to read in the
   * overview): an expensive tab, a chat, draws its content when it is.
   */
  readonly near: boolean;
  /**
   * An expensive tab that is drawn stays drawn while kept: near the camera, focused, or among the
   * few most recently near. Otherwise it may release its content and stand in for it.
   */
  readonly kept: boolean;
}

export const LONE_PANE: LayoutPaneState = {
  tabId: null,
  paneId: null,
  split: false,
  narrow: false,
  leadingEdge: true,
  trailingEdge: true,
  focused: true,
  related: false,
  visible: true,
  near: true,
  kept: true,
};

export const LayoutPaneContext = createContext<LayoutPaneState>(LONE_PANE);

export function useLayoutPane(): LayoutPaneState {
  return use(LayoutPaneContext);
}

/**
 * For window and document listeners: read `.current` when the event fires so a focus change does
 * not have to re-subscribe every handler. False while the thread is kept mounted in the background.
 */
export function useLayoutPaneFocusedRef(): React.RefObject<boolean> {
  const { focused } = useLayoutPane();
  const background = use(BackgroundThreadContext);
  const active = focused && !background;
  const ref = useRef(active);
  // oxlint-disable-next-line houston/no-unreasoned-state-sync -- publishes committed pane ownership to the ref read by window-level keyboard listeners
  useLayoutEffect(() => {
    ref.current = active;
  }, [active]);
  return ref;
}

/**
 * As `useLayoutPaneFocusedRef`, also true while related: for listeners that answer the thread's
 * own commands from its focused surface tab.
 */
export function useLayoutPaneOwnsThreadRef(): React.RefObject<boolean> {
  const { focused, related } = useLayoutPane();
  const background = use(BackgroundThreadContext);
  const active = (focused || related) && !background;
  const ref = useRef(active);
  // oxlint-disable-next-line houston/no-unreasoned-state-sync -- publishes committed related-pane ownership for thread command listeners without resubscribing them
  useLayoutEffect(() => {
    ref.current = active;
  }, [active]);
  return ref;
}
