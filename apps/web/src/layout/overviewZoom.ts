/** DOM helpers for the overview's zoom: its timing, the pinned frame, and the pane fades. */
import { MotionAnimation, playMotion, type MotionRun } from "../motion/animation";
import {
  overviewRowLeftShare,
  overviewZoomedIn,
  type OverviewRow,
  type OverviewStageLayout,
  type StageTransform,
} from "./overviewStage";
import { setOverviewPhase, type OverviewPhase } from "./overviewPhase";

/** The zoom's spring (overview-open-close) as a CSS transition's length and curve. */
export function zoomTiming(): { durationMs: number; easing: string } {
  const motion = MotionAnimation.start("overview-open-close", 0, 1);
  return { durationMs: motion.durationMs, easing: motion.cssEasing() };
}

/** The backdrop and hint fade with the zoom. */
export function overviewZoomTransition(): React.CSSProperties {
  const { durationMs, easing } = zoomTiming();
  return { transitionDuration: `${durationMs}ms`, transitionTimingFunction: easing };
}

/**
 * The strip's box, where the stage is pinned while it shows: the stage
 * leaves the strip's clip for the window but keeps the strip's size.
 */
export function pinOverviewFrame(strip: HTMLElement): void {
  const box = strip.getBoundingClientRect();
  // Set on the stage, which reads them; set higher up, they would not reach it (index.css).
  const stage = strip.querySelector<HTMLElement>(":scope > [data-layout-stage]");
  if (!stage) return;
  stage.style.setProperty("--overview-frame-left", `${box.left}px`);
  stage.style.setProperty("--overview-frame-top", `${box.top}px`);
  stage.style.setProperty("--overview-frame-width", `${box.width}px`);
  stage.style.setProperty("--overview-frame-height", `${box.height}px`);
}

/** Move to `next` once the stage's zoom lands; at once when it does not animate. */
export function afterZoom(
  element: HTMLElement,
  durationMs: number,
  next: OverviewPhase,
): (() => void) | undefined {
  if (durationMs === 0) {
    setOverviewPhase(next);
    return undefined;
  }
  const onEnd = (event: TransitionEvent) => {
    if (event.target === element && event.propertyName === "transform") setOverviewPhase(next);
  };
  // A transition that never runs (the tab hidden, say) must not strand the stage.
  const fallback = window.setTimeout(() => setOverviewPhase(next), durationMs + 100);
  element.addEventListener("transitionend", onEnd);
  return () => {
    window.clearTimeout(fallback);
    element.removeEventListener("transitionend", onEnd);
  };
}

/**
 * The live panes beside the window when the stage sits zoomed in on `row`
 * scrolled to `scroll`: off the strip, but within a window's size of it, so
 * they would linger over the sidebar and the window's edges until the
 * handoff. Panes further out leave the screen early in the zoom.
 */
export function panesBesideWindow(
  element: HTMLElement,
  stage: OverviewStageLayout,
  row: OverviewRow,
  scroll: number,
  box: DOMRect,
): HTMLElement[] {
  const camera = overviewZoomedIn(stage, row, scroll, box);
  const near = new Set<string>();
  for (const other of stage.rows) {
    const top = other.index * (box.height + stage.gap) + camera.y;
    const rowLeft = overviewRowLeftShare(other) * box.width + camera.x;
    const stripPx = other.stripWidth * box.width;
    for (const slot of other.slots) {
      const left = rowLeft + slot.rect.left * stripPx;
      const right = left + slot.rect.width * stripPx;
      const paneTop = top + slot.rect.top * box.height;
      const bottom = paneTop + slot.rect.height * box.height;
      const onStrip = right > 1 && left < box.width - 1 && bottom > 1 && paneTop < box.height - 1;
      const nearWindow =
        right > -box.left - window.innerWidth &&
        left < 2 * window.innerWidth - box.left &&
        bottom > -box.top - window.innerHeight &&
        paneTop < 2 * window.innerHeight - box.top;
      if (!onStrip && nearWindow) near.add(slot.paneId);
    }
  }
  return [...element.querySelectorAll<HTMLElement>("[data-layout-pane-id]")].filter((pane) =>
    near.has(pane.dataset.layoutPaneId ?? ""),
  );
}

/**
 * Fades `panes` with the zoom, to the chrome behind the stage and back. A
 * pane caught mid-fade turns from where it is; one held (null) starts from 0.
 * Faded out, a pane holds opacity 0 until the "closed" handoff clears it.
 */
export function fadePanes(
  fades: Map<HTMLElement, MotionRun | null>,
  panes: HTMLElement[],
  to: 0 | 1,
): void {
  for (const pane of panes) {
    const run = fades.get(pane);
    const from = run === undefined ? 1 - to : run === null ? 0 : run.value();
    run?.cancel();
    pane.style.opacity = to === 0 ? "0" : "";
    const motion = MotionAnimation.start("overview-open-close", from, to);
    fades.set(
      pane,
      playMotion(pane, motion, (opacity) => ({ opacity })),
    );
  }
}

export function readStageTransform(element: HTMLElement): StageTransform {
  const matrix = new DOMMatrixReadOnly(getComputedStyle(element).transform);
  return { x: matrix.m41, y: matrix.m42, scale: matrix.a };
}

/** Lands the stage on `transform` at once, so a transition set next starts from there. */
export function jumpStageTo(element: HTMLElement, transform: StageTransform): void {
  applyStageTransform(element, transform, 0);
  readStageTransform(element);
}

export function applyStageTransform(
  element: HTMLElement,
  transform: StageTransform,
  durationMs: number,
  overlay = element.querySelector<HTMLElement>("[data-layout-overview]"),
): void {
  // Manual input has no transition, so it needs no sampled spring curve.
  const timing = durationMs > 0 ? `${durationMs}ms ${zoomTiming().easing}` : "";
  const transition = durationMs > 0 ? `transform ${timing}` : "none";
  if (element.style.transition !== transition) element.style.transition = transition;
  // Scope inverse zoom to the overlay, not the thousands of nodes in the live panes.
  const scale = String(transform.scale);
  if (overlay && overlay.style.getPropertyValue("--overview-scale") !== scale) {
    overlay.style.setProperty("--overview-scale", scale);
  }
  element.style.transform = `translate(${transform.x}px, ${transform.y}px) scale(${transform.scale})`;
}

/**
 * Start and finish the zoom at the strip real scroll position.
 * Keep the stage mounted until the closing transform lands, then restore strip scrolling.
 */
