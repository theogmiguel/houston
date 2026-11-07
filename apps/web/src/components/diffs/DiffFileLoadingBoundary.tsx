import { useEffect, useState } from "react";

import { useStableCallback } from "~/hooks/useStableCallback";
import { observeIntersection } from "~/lib/observeIntersection";

/**
 * Asks for the next batch of files while it is near the viewport. It draws no placeholder
 * file headers: the panel shows one selected file, so a row of skeleton headers below loaded
 * content read as a second, broken file. The live region keeps the wait announced.
 */
export function DiffFileLoadingBoundary({
  load,
  count,
  loading,
}: {
  load: () => void;
  count: number;
  loading: boolean;
}) {
  const [isNear, setIsNear] = useState(false);
  const loadLatest = useStableCallback(load);
  // A fresh observe redelivers the current intersection, so this ref must keep its identity
  // across renders: it captures nothing but the state setter.
  const observe = (node: HTMLDivElement | null) => {
    if (!node) return;
    return observeIntersection(node, (entry) => setIsNear(entry.isIntersecting), {
      rootMargin: "600px",
    });
  };
  // A settled batch shrinks `count` without moving the boundary out of range, and no new
  // intersection entry arrives for that, so ask for the next batch whenever it changes.
  // oxlint-disable-next-line houston/no-unreasoned-state-sync -- requests the next diff batch while the boundary is near the viewport and files remain
  useEffect(() => {
    if (isNear && count > 0) loadLatest();
  }, [isNear, count, loadLatest]);

  return (
    <div
      ref={observe}
      role={loading ? "status" : undefined}
      aria-label={loading ? "Loading diff…" : undefined}
    >
      <span className="sr-only">{loading ? "Loading diff…" : null}</span>
    </div>
  );
}
