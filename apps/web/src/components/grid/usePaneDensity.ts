import { useLayoutEffect, useRef, useState } from "react";

import { paneDensityFor, retierPaneDensity, type PaneDensity } from "../../grid/density";
import { observeResize } from "../../lib/observeResize";

const RESIZE_SETTLE_MS = 150;

/** Moves running on any cell of the pane's grid: a pane resized in place re-renders mid-swap too. */
function movingCells(element: HTMLElement): Animation[] {
  const scope =
    element.closest<HTMLElement>("[data-grid-surface]") ??
    element.closest<HTMLElement>("[data-grid-cell]") ??
    element;
  const cells = scope.matches("[data-grid-cell]")
    ? [scope]
    : [...scope.querySelectorAll<HTMLElement>("[data-grid-cell]")];
  // The cell's own moves and its card layer's fade, not the chat's spinners inside it.
  return cells.flatMap((cell) =>
    cell
      .getAnimations({ subtree: true })
      .filter(
        (animation) =>
          animation.playState === "running" &&
          animation.effect instanceof KeyframeEffect &&
          animation.effect.target === cell,
      ),
  );
}

/**
 * Runs `commit` once the pane's grid stops moving. A swap or a maximize resizes the
 * cell on its first frame, and re-rendering the whole chat inside a running move or
 * colour morph drops frames mid-animation; after it, nothing is moving to stutter.
 */
function afterCellMotion(element: HTMLElement, commit: () => void): () => void {
  const running = movingCells(element);
  if (running.length === 0) {
    commit();
    return () => {};
  }
  let cancelled = false;
  let cancelNext = () => {};
  void Promise.allSettled(running.map((animation) => animation.finished)).then(() => {
    if (cancelled) return;
    // A move retargeted mid-flight starts a new animation; wait for that one too.
    cancelNext = afterCellMotion(element, commit);
  });
  return () => {
    cancelled = true;
    cancelNext();
  };
}

interface PaneMeasurement {
  readonly density: PaneDensity;
  readonly width: number;
  readonly height: number;
}

const INITIAL: PaneMeasurement = { density: "glance", width: 0, height: 0 };

/**
 * Measures a pane and re-tiers it when a resize settles, never on every frame
 * of a divider drag. The hysteresis keeps a pane from flickering between
 * densities while the pointer crosses a threshold.
 */
export function usePaneDensity(threadCount: number) {
  const ref = useRef<HTMLElement | null>(null);
  const currentRef = useRef<PaneMeasurement>(INITIAL);
  const [measurement, setMeasurement] = useState<PaneMeasurement>(INITIAL);

  // oxlint-disable-next-line houston/no-unreasoned-state-sync -- keeps the pane tier in step with the measured DOM size while mounted
  useLayoutEffect(() => {
    const element = ref.current;
    if (element === null) return;
    const commit = (size: { width: number; height: number }, resolve: "raw" | "retier") => {
      const density =
        resolve === "raw"
          ? paneDensityFor(size, threadCount)
          : retierPaneDensity(currentRef.current.density, size, threadCount);
      const next = { ...size, density };
      currentRef.current = next;
      setMeasurement((previous) =>
        previous.density === next.density &&
        Math.abs(previous.width - next.width) < 1 &&
        Math.abs(previous.height - next.height) < 1
          ? previous
          : next,
      );
    };

    const initial = element.getBoundingClientRect();
    commit({ width: initial.width, height: initial.height }, "raw");

    let timer: number | null = null;
    let cancelPending = () => {};
    const stop = observeResize(element, (entries) => {
      const rect = entries.at(-1)?.contentRect;
      if (rect === undefined) return;
      if (timer !== null) window.clearTimeout(timer);
      cancelPending();
      timer = window.setTimeout(() => {
        timer = null;
        cancelPending = afterCellMotion(element, () =>
          commit({ width: rect.width, height: rect.height }, "retier"),
        );
      }, RESIZE_SETTLE_MS);
    });
    return () => {
      stop();
      cancelPending();
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [threadCount]);

  return { ref, ...measurement };
}
