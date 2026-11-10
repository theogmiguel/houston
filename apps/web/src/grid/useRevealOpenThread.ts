import { useEffect, type RefObject } from "react";

import { observeResize } from "../lib/observeResize";

/**
 * How long after the open thread changes the reveal keeps the row in view while the rail's height
 * still moves, in ms. Sections open over 250ms (AnimatedHeight's fallback bound); twice that
 * covers a transition that starts as another ends.
 */
const REVEAL_SETTLE_MS = 500;

/**
 * Scrolls the open thread's row into view once it exists, and keeps it there while the sections above
 * it open. The row may arrive after the thread is known, so a missing row is awaited. A row under the
 * pointer is already in view; a wheel, touch, key or press by the user ends the tracking.
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
    const reveal = () => find()?.scrollIntoView({ block: "nearest" });
    const scroller = content.closest<HTMLElement>("[data-slot=scroll-area-viewport]") ?? content;

    let stopResize: (() => void) | null = null;
    let timer = 0;
    const arrival = new MutationObserver(() => {
      if (find() !== null) settle();
    });
    const stop = () => {
      window.clearTimeout(timer);
      arrival.disconnect();
      stopResize?.();
      for (const type of USER_SCROLL_EVENTS) scroller.removeEventListener(type, stop);
    };
    const settle = () => {
      arrival.disconnect();
      if (find()?.matches(":hover") !== false) return stop();
      reveal();
      // The rail's content element and its direct children: whichever of them holds the sections
      // that move, its size changes with them.
      stopResize = observeResize([content, ...content.children], reveal);
      timer = window.setTimeout(stop, REVEAL_SETTLE_MS);
    };

    for (const type of USER_SCROLL_EVENTS) scroller.addEventListener(type, stop, { passive: true });
    if (find() === null) arrival.observe(content, { childList: true, subtree: true });
    else settle();
    return stop;
  }, [rail, openThreadKey]);
}

const USER_SCROLL_EVENTS = ["wheel", "touchstart", "keydown", "pointerdown"] as const;
