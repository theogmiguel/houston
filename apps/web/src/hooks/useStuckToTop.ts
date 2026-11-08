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
