/**
 * The camera: starts and finishes the zoom at the strip's real scroll position, pans and zooms the
 * stage by wheel while it is open, and keeps the stage mounted until the closing transform lands.
 * The host supplies the strip (`scrollerRef`) and the stage inside it (`stageRef`).
 */
import { useLayoutEffect, useRef } from "react";

import { useStableCallback } from "../hooks/useStableCallback";
import { observeResize } from "../lib/observeResize";
import { MotionAnimation, type MotionRun } from "../motion/animation";
import { closeHintHeight } from "./LayoutOverview";
import { inPopoverAbove, isInOpenLayer } from "./layoutKeyGuards";
import {
  boundOverviewTransform,
  OVERVIEW_ROW_GAP,
  overviewExitScrollLeft,
  overviewRowShift,
  overviewZoomedIn,
  overviewZoomedOut,
  type OverviewRow,
  type OverviewStageLayout,
  type StageTransform,
  type WindowSize,
} from "./overviewStage";
import {
  endOverviewGesture,
  getOverviewCamera,
  getOverviewEntry,
  getOverviewPhase,
  isOverviewInteractive,
  requestOverviewOpen,
  setOverviewCamera,
  setOverviewPhase,
  type OverviewPhase,
} from "./overviewPhase";
import {
  afterZoom,
  applyStageTransform,
  fadePanes,
  jumpStageTo,
  panesBesideWindow,
  pinOverviewFrame,
  readStageTransform,
  zoomTiming,
} from "./overviewZoom";

/** Manual zoom ranges from a quarter of the fitted view up to full pane size. */
const MIN_ZOOM_SHARE = 0.25;
const WHEEL_ZOOM_RATE = 0.002;
/** A wheel event this soon after the last one continues the same scroll or pinch. */
const WHEEL_STREAM_GAP_MS = 150;
/** Pinch travel that closes the overview beyond full pane size. */
const PINCH_THRESHOLD = 40;

function windowSize(): WindowSize {
  return { width: window.innerWidth, height: window.innerHeight };
}


/**
 * Start and finish the zoom at the strip real scroll position.
 * Keep the stage mounted until the closing transform lands, then restore strip scrolling.
 */
export function useOverviewStage(
  phaseNow: OverviewPhase,
  stage: OverviewStageLayout,
  scrollerRef: React.RefObject<HTMLDivElement | null>,
  stageRef: React.RefObject<HTMLDivElement | null>,
): void {
  const staged = useRef(false);
  const exitScroll = useRef(0);
  const manual = useRef<StageTransform | null>(null);
  const zoomShare = useRef(1);
  const selection = useRef("");
  const shownRows = useRef<OverviewRow[]>([]);
  const frameSize = useRef("");
  const fades = useRef(new Map<HTMLElement, MotionRun | null>());
  const interactive = phaseNow === "opening" || phaseNow === "open";
  const readStage = useStableCallback(() => stage);

  // oxlint-disable-next-line houston/no-unreasoned-state-sync -- Bind the overview camera to its mounted DOM and release gesture listeners on exit.
  useLayoutEffect(() => {
    const scroller = scrollerRef.current;
    const element = stageRef.current;
    if (!interactive || !scroller || !element) return;
    const overlay = element.querySelector<HTMLElement>("[data-layout-overview]");
    let box = scroller.getBoundingClientRect();
    let footerHeight = closeHintHeight();
    const visible = () => {
      if (manual.current) return manual.current;
      // Read the visible transition once at handoff, never after our camera write.
      box = scroller.getBoundingClientRect();
      footerHeight = closeHintHeight();
      return readStageTransform(element);
    };
    // The camera only moves a landed stage. Taken mid-zoom, the in-between
    // pose would become the overview's resting one, full size at the start.
    const move = (transform: StageTransform) => {
      if (getOverviewPhase() !== "open") return;
      const stage = readStage();
      manual.current = boundOverviewTransform(stage, box, transform, footerHeight, windowSize());
      zoomShare.current = manual.current.scale / stage.scale;
      applyStageTransform(element, manual.current, 0, overlay);
    };
    const camera = {
      pan: (x: number, y: number) => {
        const from = visible();
        move({ ...from, x: from.x + x, y: from.y + y });
      },
      zoom: (factor: number, x: number, y: number) => {
        const from = visible();
        const stage = readStage();
        const maximum = Math.max(1, stage.scale);
        const scale = Math.max(
          stage.scale * MIN_ZOOM_SHARE,
          Math.min(maximum, from.scale * factor),
        );
        const ratio = scale / from.scale;
        const anchorX = x - box.left;
        const anchorY = y - box.top;
        move({
          x: anchorX - (anchorX - from.x) * ratio,
          y: anchorY - (anchorY - from.y) * ratio,
          scale,
        });
        return Math.max(1, (from.scale * factor) / maximum);
      },
    };
    setOverviewCamera(camera);
    let pinchTravel = 0;
    let pinchReset: number | null = null;
    // A scroll still coasting from the chat, or the pinch that opened the
    // overview, runs on through the zoom; it ends at the first gap.
    let foreignWheelUntil = 0;
    const onWheel = (event: WheelEvent) => {
      if (!isOverviewInteractive() || event.defaultPrevented) return;
      if (isInOpenLayer(event.target)) return;
      event.preventDefault();
      // Own only the overview: do not also drive the strip's modifier-wheel handler.
      event.stopPropagation();
      if (getOverviewPhase() !== "open" || event.timeStamp < foreignWheelUntil) {
        foreignWheelUntil = event.timeStamp + WHEEL_STREAM_GAP_MS;
        return;
      }
      const unit = event.deltaMode === 1 ? 40 : event.deltaMode === 2 ? window.innerHeight : 1;
      if (event.ctrlKey || event.metaKey) {
        const overflow = camera.zoom(
          Math.exp(-event.deltaY * unit * WHEEL_ZOOM_RATE),
          event.clientX,
          event.clientY,
        );
        // Chromium pinch has fractional ctrl+wheel deltas; mouse-wheel zoom never closes.
        if (event.ctrlKey && !Number.isInteger(event.deltaY) && event.deltaY < 0) {
          pinchTravel += Math.log(overflow) / WHEEL_ZOOM_RATE;
          if (pinchReset !== null) window.clearTimeout(pinchReset);
          pinchReset = window.setTimeout(() => {
            pinchReset = null;
            pinchTravel = 0;
          }, 200);
          if (pinchTravel > PINCH_THRESHOLD) {
            pinchTravel = 0;
            requestOverviewOpen(false);
          }
        } else {
          pinchTravel = 0;
        }
      } else {
        pinchTravel = 0;
        const horizontal = event.shiftKey && event.deltaX === 0;
        const horizontalUnit = event.deltaMode === 2 ? window.innerWidth : unit;
        camera.pan(
          -(horizontal ? event.deltaY : event.deltaX) * horizontalUnit,
          horizontal ? 0 : -event.deltaY * unit,
        );
      }
    };
    window.addEventListener("wheel", onWheel, { passive: false, capture: true });
    // A genuine resize deliberately returns to the fitted view; rerenders do not.
    const resize = () => {
      const next = `${scroller.clientWidth}x${scroller.clientHeight}x${window.innerWidth}x${window.innerHeight}`;
      if (next === frameSize.current) return;
      const changed = frameSize.current !== "";
      frameSize.current = next;
      box = scroller.getBoundingClientRect();
      footerHeight = closeHintHeight();
      if (!changed) return;
      // The fixed stage must follow a resize even while its entry zoom is running.
      pinOverviewFrame(scroller);
      if (getOverviewPhase() !== "open") return;
      manual.current = null;
      zoomShare.current = 1;
      const stage = readStage();
      applyStageTransform(element, overviewZoomedOut(stage, box, windowSize()), 0, overlay);
    };
    resize();
    const stopObserving = observeResize([scroller, document.documentElement], resize);
    return () => {
      stopObserving();
      window.removeEventListener("wheel", onWheel, true);
      if (pinchReset !== null) window.clearTimeout(pinchReset);
      if (getOverviewCamera() === camera) {
        endOverviewGesture();
        setOverviewCamera(null);
      }
    };
  }, [interactive, scrollerRef, stageRef, readStage]);

  // oxlint-disable-next-line houston/no-unreasoned-state-sync -- Apply overview transforms and cancel in-flight animation frames when geometry changes.
  useLayoutEffect(() => {
    const scroller = scrollerRef.current;
    const element = stageRef.current;
    if (!scroller || !element) return;
    const box = scroller.getBoundingClientRect();
    // Navigation motion: the zoom always plays its spring; reduced motion makes it 0.
    const { durationMs } = zoomTiming();
    const nextSelection = `${stage.focusedRow.workspace.id}/${stage.focusedRow.workspace.focusedPaneId}`;
    const selectionChanged = selection.current !== nextSelection;
    selection.current = nextSelection;
    const rowShift = overviewRowShift(shownRows.current, stage.rows);
    shownRows.current = stage.rows;
    if (phaseNow === "closed") {
      manual.current = null;
      zoomShare.current = 1;
      frameSize.current = "";
      for (const [pane, run] of fades.current) {
        run?.cancel();
        pane.style.opacity = "";
      }
      fades.current.clear();
      if (!staged.current) return;
      staged.current = false;
      element.style.transition = "";
      element.style.transform = "";
      scroller.scrollLeft = exitScroll.current;
      // DOM focus comes back to the pane the overview landed on.
      if (!inPopoverAbove(document.activeElement)) {
        document
          .querySelector<HTMLElement>(
            "[data-layout-pane-focused='true'][data-layout-pane-id] [contenteditable='true']",
          )
          ?.focus({ preventScroll: true });
      }
      return;
    }
    if (phaseNow === "open") {
      const footerHeight = closeHintHeight();
      if (manual.current && !selectionChanged) {
        manual.current = boundOverviewTransform(stage, box, manual.current, footerHeight, windowSize());
        zoomShare.current = manual.current.scale / stage.scale;
        applyStageTransform(element, manual.current, 0);
      } else {
        if (rowShift !== 0 && durationMs > 0) {
          const from = readStageTransform(element);
          jumpStageTo(element, {
            ...from,
            y: from.y - rowShift * (box.height + stage.gap) * from.scale,
          });
        }
        manual.current = null;
        const scale = Math.max(
          stage.scale * MIN_ZOOM_SHARE,
          Math.min(Math.max(1, stage.scale), stage.scale * zoomShare.current),
        );
        applyStageTransform(
          element,
          boundOverviewTransform(stage, box, overviewZoomedOut(stage, box, windowSize(), scale), footerHeight, windowSize()),
          durationMs,
        );
      }
      return;
    }
    if (phaseNow === "opening") {
      if (!staged.current) {
        staged.current = true;
        const start = overviewZoomedIn(stage, stage.focusedRow, getOverviewEntry().scrollLeft, box);
        // A switch caught mid-flight: the focused row still sits that far off.
        start.y -= getOverviewEntry().rowOffset * (box.height + stage.gap);
        applyStageTransform(element, start, 0);
        // Panes beside the window hold at 0 and fade in with the zoom, rather
        // than appearing over the sidebar. Mid-switch two rows share the window.
        if (getOverviewEntry().rowOffset === 0) {
          for (const pane of panesBesideWindow(
            element,
            stage,
            stage.focusedRow,
            getOverviewEntry().scrollLeft,
            box,
          )) {
            pane.style.opacity = "0";
            fades.current.set(pane, null);
          }
        }
      }
      let stopZoom: (() => void) | undefined;
      let frame = window.requestAnimationFrame(() => {
        frame = window.requestAnimationFrame(() => {
          // Held panes, and any caught fading out by a reopen, come back.
          fadePanes(fades.current, [...fades.current.keys()], 1);
          if (manual.current) return;
          // Straight to the resting pose "open" keeps, so no pan follows the zoom.
          const footerHeight = closeHintHeight();
          applyStageTransform(
            element,
            boundOverviewTransform(stage, box, overviewZoomedOut(stage, box, windowSize()), footerHeight, windowSize()),
            durationMs,
          );
          stopZoom = afterZoom(element, durationMs, "open");
        });
      });
      return () => {
        window.cancelAnimationFrame(frame);
        stopZoom?.();
      };
    }
    // A host that mounts mid-zoom has no zoom to finish: it lands at once, and "closed" still hands the scroll back.
    const landMs = staged.current ? durationMs : 0;
    staged.current = true;
    manual.current = null;
    zoomShare.current = 1;
    exitScroll.current = overviewExitScrollLeft(stage.focusedRow, box.width, getOverviewEntry());
    // Panes beside the window fade out on the way, so the sidebar's
    // spot is chrome by the handoff instead of a neighbor that vanishes.
    fadePanes(
      fades.current,
      panesBesideWindow(element, stage, stage.focusedRow, exitScroll.current, box),
      0,
    );
    applyStageTransform(
      element,
      overviewZoomedIn(stage, stage.focusedRow, exitScroll.current, box),
      landMs,
    );
    return afterZoom(element, landMs, "closed");
  }, [phaseNow, scrollerRef, stage, stageRef]);
}
