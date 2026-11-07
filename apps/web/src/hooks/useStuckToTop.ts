import { useEffect, useState, type RefObject } from "react";

/**
 * Whether a `position: sticky` element is pinned at the top of its scroll container. The element
 * must stick 1px above the top (`top: -1px`): pinned, it is clipped by that pixel, so it stops
 * being fully visible, and being fully visible again means it is back in its natural place.
 */
export function useStuckToTop(ref: RefObject<HTMLElement | null>): boolean {
  const [stuck, setStuck] = useState(false);
  // oxlint-disable-next-line houston/no-unreasoned-state-sync -- an IntersectionObserver reports whether the sticky heading is pinned; scroll position is external state
  useEffect(() => {
    const element = ref.current;
    if (element === null) return;
    const root = element.closest<HTMLElement>("[data-slot=scroll-area-viewport]");
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry === undefined) return;
        const rootTop = entry.rootBounds?.top ?? 0;
        setStuck(entry.intersectionRatio < 1 && entry.boundingClientRect.top <= rootTop);
      },
      { root, threshold: [1] },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  return stuck;
}

/**
 * After the rail scrolls, settles the first row that a pinned heading cuts in half
 * to its nearest whole edge, so the rail never rests on a half-drawn title line.
 * The heading itself stays opaque and above the rows; this only moves the scroll.
 */
export function useStickyRowSettle(
  headingRef: RefObject<HTMLElement | null>,
  stuck: boolean,
): void {
  // oxlint-disable-next-line houston/no-unreasoned-state-sync -- attaches a scroll listener to the heading's rail; scroll position is external state
  useEffect(() => {
    if (!stuck) return;
    const heading = headingRef.current;
    const viewport = heading?.closest<HTMLElement>("[data-slot=scroll-area-viewport]");
    if (!heading || !viewport) return;
    let timer = 0;
    const settle = () => {
      // The lowest pinned heading is the edge the rows currently scroll under.
      const pinned = [
        ...viewport.querySelectorAll<HTMLElement>("[data-project-heading][data-stuck]"),
      ]
        .map((element) => element.getBoundingClientRect().bottom)
        .sort((left, right) => right - left)[0];
      if (pinned === undefined) return;
      const targets = [...viewport.querySelectorAll<HTMLElement>("[data-sidebar-row]")];
      for (const target of targets) {
        if (target.closest("[data-project-heading]") !== null) continue;
        const box = target.getBoundingClientRect();
        if (box.bottom <= pinned + 1 || box.top >= pinned - 1) continue;
        const overlap = pinned - box.top;
        viewport.scrollTop += overlap >= box.height / 2 ? -overlap : box.height - overlap;
        return;
      }
    };
    const onScroll = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(settle, 90);
    };
    viewport.addEventListener("scroll", onScroll, { passive: true });
    // The rail may already be scrolled when the heading pins (a cold load on a thread).
    onScroll();
    return () => {
      viewport.removeEventListener("scroll", onScroll);
      window.clearTimeout(timer);
    };
  }, [headingRef, stuck]);
}
