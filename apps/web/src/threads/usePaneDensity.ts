import { useLayoutEffect, useRef, useState } from "react";

import { paneDensityFor, retierPaneDensity, type PaneDensity } from "./density";
import { observeResize } from "../lib/observeResize";

const RESIZE_SETTLE_MS = 150;

interface PaneMeasurement {
  readonly density: PaneDensity;
  readonly width: number;
  readonly height: number;
  /** The thread count `density` was resolved for. */
  readonly threadCount: number;
}

const INITIAL: PaneMeasurement = { density: "glance", width: 0, height: 0, threadCount: 0 };

/**
 * Measures a pane and re-tiers it when a resize settles, never on every frame
 * of a divider drag. The hysteresis keeps a pane from flickering between
 * densities while the pointer crosses a threshold.
 */
export function usePaneDensity(threadCount: number) {
  const ref = useRef<HTMLElement | null>(null);
  const [measurement, setMeasurement] = useState<PaneMeasurement>(INITIAL);
  // A new thread count re-tiers the last measured size in this render, never in a second one.
  const shown =
    measurement.threadCount === threadCount || measurement.threadCount === 0
      ? measurement
      : { ...measurement, density: paneDensityFor(measurement, threadCount), threadCount };
  const currentRef = useRef<PaneMeasurement>(shown);
  const threadCountRef = useRef(threadCount);
  // oxlint-disable-next-line houston/no-unreasoned-state-sync -- hands the resize observer the tier and thread count this render shows
  useLayoutEffect(() => {
    currentRef.current = shown;
    threadCountRef.current = threadCount;
  });

  // oxlint-disable-next-line houston/no-unreasoned-state-sync -- keeps the pane tier in step with the measured DOM size while mounted
  useLayoutEffect(() => {
    const element = ref.current;
    if (element === null) return;
    const commit = (size: { width: number; height: number }, resolve: "raw" | "retier") => {
      const threadCount = threadCountRef.current;
      const density =
        resolve === "raw"
          ? paneDensityFor(size, threadCount)
          : retierPaneDensity(currentRef.current.density, size, threadCount);
      const next = { ...size, density, threadCount };
      currentRef.current = next;
      setMeasurement((previous) =>
        previous.threadCount === next.threadCount &&
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
    const stop = observeResize(element, (entries) => {
      const rect = entries.at(-1)?.contentRect;
      if (rect === undefined) return;
      if (timer !== null) window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        timer = null;
        commit({ width: rect.width, height: rect.height }, "retier");
      }, RESIZE_SETTLE_MS);
    });
    return () => {
      stop();
      if (timer !== null) window.clearTimeout(timer);
    };
  }, []);

  return { ref, density: shown.density, width: shown.width, height: shown.height };
}
