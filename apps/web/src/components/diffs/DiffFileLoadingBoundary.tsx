import { useEffect, useState } from "react";

import { useStableCallback } from "~/hooks/useStableCallback";
import { observeIntersection } from "~/lib/observeIntersection";
import { DiffFileHeaderSkeleton } from "../DiffPanelShell";

/**
 * Asks for the next batch of files while it is near the viewport. The placeholder headers show
 * only while a batch is loading, so a settled diff leaves nothing below its last file.
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
    <div ref={observe} role={loading ? "status" : undefined} aria-label={loading ? "Loading diff…" : undefined}>
      {Array.from({ length: loading ? Math.min(count, 4) : 0 }, (_, index) => (
        <div key={index} aria-hidden className="border-b border-border/40">
          <DiffFileHeaderSkeleton titleWidth="medium" />
        </div>
      ))}
    </div>
  );
}
