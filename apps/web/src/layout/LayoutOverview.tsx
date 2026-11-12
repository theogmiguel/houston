/**
 * The overview's controller: it listens for the hot corner, the pinch, and the keys that move the
 * selection while the map is open, and draws the footer hint. The stage itself is zoomed by
 * `useOverviewStage` and the rows are drawn by the strip host with `OverviewStageOverlay`.
 */
import { useAtomValue } from "@effect/atom-react";
import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";

import { isEditableFocused } from "../lib/editableFocus";
import { shortcutLabelForCommand } from "../keybindings";
import { settleStripCamera } from "../motion/stripCamera";
import { finishWorkspaceSwitch } from "../motion/workspaceSwitch";
import { isMacPlatform } from "../lib/utils";
import { registerCommands } from "../shortcuts/dispatcher";
import { useStableCallback } from "../hooks/useStableCallback";
import { primaryServerKeybindingsAtom } from "../state/server";
import { findInOpenLayers, inPopoverAbove, isInOpenLayer, isLayoutModalOpen } from "./layoutKeyGuards";
import { selectFocusedTab, type LayoutDirection, type LayoutTab } from "./layoutModel";
import { useLayoutStore } from "./layoutStore";
import {
  getOverviewCamera,
  getOverviewPhase,
  isOverviewInteractive,
  overviewKeysSuspended,
  requestOverviewOpen,
  setOverviewEntry,
  setOverviewPhase,
  useOverviewPhase,
} from "./overviewPhase";
import { overviewZoomTransition, pinOverviewFrame } from "./overviewZoom";

/** Resting in the hot corner this long opens the overview. */
export const HOT_CORNER_DWELL_MS = 250;
/** Pinch travel that opens the overview. */
const PINCH_THRESHOLD = 40;

const OVERVIEW_KEYS: Readonly<Record<string, LayoutDirection>> = {
  h: "left",
  ArrowLeft: "left",
  l: "right",
  ArrowRight: "right",
  j: "down",
  ArrowDown: "down",
  k: "up",
  ArrowUp: "up",
};

export interface LayoutOverviewProps {
  /**
   * Called with the tab that took focus when the person picks a pane, before the overview closes,
   * so the host can follow it (a route, say). `null` when the focused workspace is empty.
   */
  readonly onPick?: (tab: LayoutTab | null) => void;
}

export function LayoutOverview({ onPick }: LayoutOverviewProps) {
  useOverviewGestures();
  // Runs inside the store's set, before React renders the stage: the strip still has its scroll
  // position here, and loses it once the stage lays out.
  // oxlint-disable-next-line houston/no-unreasoned-state-sync -- Capture the DOM scroll frame before the external layout store opens the overview.
  useEffect(
    () =>
      useLayoutStore.subscribe((state, previous) => {
        if (state.overviewOpen === previous.overviewOpen) return;
        const phase = getOverviewPhase();
        if (!state.overviewOpen) {
          if (phase === "open" || phase === "opening") setOverviewPhase("closing");
          return;
        }
        if (phase === "closed") {
          // The zoom starts from what the window shows, mid-motion included.
          settleStripCamera();
          const handoff = finishWorkspaceSwitch();
          const strip = document.querySelector<HTMLElement>("[data-layout-strip]");
          if (strip) pinOverviewFrame(strip);
          setOverviewEntry({
            scrollLeft: handoff.scrollLeft ?? strip?.scrollLeft ?? 0,
            workspaceId: state.layout.focusedWorkspaceId,
            rowOffset: handoff.rowOffset,
          });
          // The panes go inert under the overview; keys belong to it now.
          const active = document.activeElement;
          if (active instanceof HTMLElement && !inPopoverAbove(active)) active.blur();
        }
        // Reopened mid-close too: "open" only once the zoom out lands.
        setOverviewPhase("opening");
      }),
    [],
  );
  useOverviewKeys(onPick);
  const phase = useOverviewPhase();
  const open = phase === "open" || phase === "opening";
  return (
    <>
      <LayoutHotCorner />
      {open ? <OverviewCloseHint /> : null}
    </>
  );
}

/** Focus the tab (or the focused pane's), tell the host, and zoom into it. */
export function chooseOverviewTab(
  tabId: string | null,
  onPick?: (tab: LayoutTab | null) => void,
): void {
  const store = useLayoutStore.getState();
  if (tabId !== null) store.focusTab(tabId);
  onPick?.(selectFocusedTab(useLayoutStore.getState().layout));
  requestOverviewOpen(false);
}

/**
 * Overview focus changes are real. Typing and Escape stay with any palette or dialog opened above
 * the overview.
 */
function useOverviewKeys(onPick?: (tab: LayoutTab | null) => void): void {
  const pick = useStableCallback((tabId: string | null) => chooseOverviewTab(tabId, onPick));
  // oxlint-disable-next-line houston/no-unreasoned-state-sync -- Route overview navigation keys only while its host is mounted.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!isOverviewInteractive() || event.defaultPrevented) return;
      if (overviewKeysSuspended()) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const direction = OVERVIEW_KEYS[event.key];
      if (!direction && inPopoverAbove(event.target)) return;
      // The overview owns the keyboard: other text goes nowhere, not into the composer behind it,
      // and Tab does not walk the sidebar under it.
      const text = event.key.length === 1 && !isEditableFocused(event.target);
      const owned = event.key === "Escape" || event.key === "Enter" || event.key === "Tab";
      if (!owned && !direction && !text) return;
      event.preventDefault();
      event.stopPropagation();
      if (direction) useLayoutStore.getState().focusDirection(direction);
      else if (event.key === "Enter") pick(null);
      else if (event.key === "Escape") requestOverviewOpen(false);
    };
    return registerCommands(
      {},
      {
        capture: true,
        onKeyDown: (event) => {
          onKeyDown(event);
          return event.defaultPrevented;
        },
      },
    );
  }, [pick]);
}

/** The footer row's height, which the stage keeps clear; read on every wheel step. */
export function closeHintHeight(): number {
  return findInOpenLayers("[data-overview-close-hint]")?.clientHeight ?? 0;
}

/** "hjkl or arrows to move, Enter to open, Esc to close", with the user's own keys. */
export function overviewCloseHintText(
  closeKey: string | null,
  focusKey: string | null,
): string {
  // The layout focus keys move the selection too ("Alt+Shift+Left" reads as "Alt+Shift+arrows");
  // a rebinding off the arrows is left unnamed.
  const modifiers = focusKey?.endsWith("Left") ? focusKey.slice(0, -"Left".length) : null;
  const arrows = modifiers ? `${modifiers}${modifiers.endsWith("+") ? "" : " "}arrows` : null;
  return `${arrows ? `hjkl, arrows or ${arrows}` : "hjkl or arrows"} to move, Enter to open, ${closeKey ? `${closeKey} or ` : ""}Esc to close`;
}

function OverviewCloseHint() {
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const text = overviewCloseHintText(
    shortcutLabelForCommand(keybindings, "layout.overview"),
    shortcutLabelForCommand(keybindings, "layout.focusLeft"),
  );
  return createPortal(
    <div
      data-overview-close-hint=""
      className="pointer-events-none fixed inset-x-0 bottom-0 z-40 flex h-(--h-top) items-center justify-center bg-(--app-chrome-background) text-caption text-muted-foreground motion-safe:transition-opacity motion-safe:duration-(--motion-overlay-in) motion-safe:ease-standard motion-safe:starting:opacity-0"
      style={overviewZoomTransition()}
    >
      {text}
    </div>,
    document.body,
  );
}

/**
 * The bottom-left corner of the window: the top-left holds the traffic lights and the top-right
 * the window controls off macOS, so it is the one corner nothing else claims.
 */
function LayoutHotCorner() {
  const timer = useRef<number | null>(null);
  const cancel = useStableCallback(() => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
  });
  // oxlint-disable-next-line houston/no-unreasoned-state-sync -- Cancel the pending hot-corner timer when its target unmounts.
  useEffect(() => cancel, [cancel]);
  return (
    <div
      aria-hidden
      data-layout-hot-corner=""
      className="fixed bottom-0 left-0 z-50 size-1"
      onPointerEnter={(event) => {
        if (event.pointerType !== "mouse" || event.buttons !== 0) return;
        cancel();
        timer.current = window.setTimeout(() => {
          timer.current = null;
          requestOverviewOpen(true);
        }, HOT_CORNER_DWELL_MS);
      }}
      onPointerLeave={cancel}
    />
  );
}

/** macOS pinch opens the overview while it is closed; open-wheel handling belongs to the camera. */
function useOverviewGestures(): void {
  // oxlint-disable-next-line houston/no-unreasoned-state-sync -- Own native wheel and pinch gesture subscriptions for the layout overview.
  useEffect(() => {
    if (!isMacPlatform(navigator.platform)) return;
    let travel = 0;
    let resetTimer: number | null = null;
    let gestureScale = 1;
    let gestureOverflow = 1;
    const onWheel = (event: WheelEvent) => {
      if (event.defaultPrevented || isLayoutModalOpen() || isOverviewInteractive()) return;
      if (isInOpenLayer(event.target)) return;
      if (!event.ctrlKey || Number.isInteger(event.deltaY)) return;
      event.preventDefault();
      travel += event.deltaY;
      if (resetTimer !== null) window.clearTimeout(resetTimer);
      resetTimer = window.setTimeout(() => {
        resetTimer = null;
        travel = 0;
      }, 200);
      if (!useLayoutStore.getState().overviewOpen && travel > PINCH_THRESHOLD) {
        travel = 0;
        requestOverviewOpen(true);
      }
    };
    // Safari's GestureEvent is not in the DOM typings; its scale is cumulative.
    const startGesture = (event: Event) => {
      if (isLayoutModalOpen() || isInOpenLayer(event.target)) return;
      event.preventDefault();
      gestureScale = 1;
      gestureOverflow = 1;
    };
    const onGesture = (event: Event) => {
      if (isLayoutModalOpen() || isInOpenLayer(event.target)) return;
      event.preventDefault();
      const gesture = event as Event & { scale?: number; clientX?: number; clientY?: number };
      const scale = gesture.scale ?? 1;
      if (scale <= 0) return;
      const factor = scale / gestureScale;
      gestureScale = scale;
      if (isOverviewInteractive()) {
        const overflow = getOverviewCamera()?.zoom(
          factor,
          gesture.clientX ?? window.innerWidth / 2,
          gesture.clientY ?? window.innerHeight / 2,
        );
        gestureOverflow = factor > 1 ? gestureOverflow * (overflow ?? 1) : 1;
        if (gestureOverflow > 1.25) {
          gestureOverflow = 1;
          requestOverviewOpen(false);
        }
      } else if (!useLayoutStore.getState().overviewOpen && scale < 0.8) {
        requestOverviewOpen(true);
      }
    };
    window.addEventListener("wheel", onWheel, { passive: false });
    window.addEventListener("gesturestart", startGesture, { passive: false });
    window.addEventListener("gesturechange", onGesture, { passive: false });
    window.addEventListener("gestureend", startGesture, { passive: false });
    return () => {
      if (resetTimer !== null) window.clearTimeout(resetTimer);
      window.removeEventListener("wheel", onWheel);
      window.removeEventListener("gesturestart", startGesture);
      window.removeEventListener("gesturechange", onGesture);
      window.removeEventListener("gestureend", startGesture);
    };
  }, []);
}
