import { useEffect, type RefObject } from "react";

import { observeResize } from "../lib/observeResize";

/**
 * How long after the open thread changes the reveal keeps the row in view while the rail's height
 * still moves, in ms. Sections open over 250ms (AnimatedHeight's fallback bound); twice that
 * covers a transition that starts as another ends.
 */
const REVEAL_SETTLE_MS = 500;

/**
 * Scrolls the open thread's row into view when the open thread changes, so a thread opened from the
 * palette, history or a link is on the rail, and keeps it in view while the sections above it are
 * still opening. A row under the pointer was just clicked and is already in view; a wheel, touch
 * or key press by the user ends the tracking.
 */
export function useRevealOpenThread(
  rail: RefObject<HTMLElement | null>,
  openThreadKey: string | null,
): void {
  // oxlint-disable-next-line houston/no-unreasoned-state-sync -- scrolls the rail's own scroller to the row of the thread that navigation just opened
  useEffect(() => {
    const content = rail.current;
    if (openThreadKey === null || content === null) return;
    const find = () =>
      content.querySelector<HTMLElement>(`[data-thread-key="${CSS.escape(openThreadKey)}"]`);
    const first = find();
    if (first === null || first.matches(":hover")) return;
    const reveal = () => find()?.scrollIntoView({ block: "nearest" });
    reveal();

    const scroller = content.closest<HTMLElement>("[data-slot=scroll-area-viewport]") ?? content;
    // The rail's content element and its direct children: whichever of them holds the sections
    // that move, its size changes with them.
    const stopResize = observeResize([content, ...content.children], reveal);
    const stop = () => {
      window.clearTimeout(timer);
      stopResize();
      for (const type of USER_SCROLL_EVENTS) scroller.removeEventListener(type, stop);
    };
    const timer = window.setTimeout(stop, REVEAL_SETTLE_MS);
    for (const type of USER_SCROLL_EVENTS) scroller.addEventListener(type, stop, { passive: true });
    return stop;
  }, [rail, openThreadKey]);
}

const USER_SCROLL_EVENTS = ["wheel", "touchstart", "keydown", "pointerdown"] as const;
