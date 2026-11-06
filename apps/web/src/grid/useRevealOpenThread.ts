import { useEffect, type RefObject } from "react";

/**
 * Scrolls the open thread's row into view when the open thread changes, so a
 * thread opened from the palette, history or a link is on the rail. A row under
 * the pointer was just clicked and is already in view.
 */
export function useRevealOpenThread(
  rail: RefObject<HTMLElement | null>,
  openThreadKey: string | null,
): void {
  // oxlint-disable-next-line houston/no-unreasoned-state-sync -- scrolls the rail's own scroller to the row of the thread that navigation just opened
  useEffect(() => {
    if (openThreadKey === null) return;
    const row = rail.current?.querySelector<HTMLElement>(
      `[data-thread-key="${CSS.escape(openThreadKey)}"]`,
    );
    if (row === null || row === undefined || row.matches(":hover")) return;
    row.scrollIntoView({ block: "nearest" });
  }, [rail, openThreadKey]);
}
