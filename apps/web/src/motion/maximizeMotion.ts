/**
 * The grid's maximize and restore: a stand-in card carries the cell's box from its old
 * rect to its new one on the compositor, while the chat itself is already laid out at
 * its final size and fades in once the card is under way. Nothing is ever scaled that
 * holds text, and no cell relayouts mid-motion.
 */
import { MotionAnimation, playMotion, toDevicePixel } from "./animation";
import { probeCellMoveFrames } from "./frameProbe";
import { MOTION_EASE, MOTION_ROLE_MS } from "./registry";

export interface CellRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

const STANDARD = `cubic-bezier(${MOTION_EASE.standard.join(",")})`;
const EXIT = `cubic-bezier(${MOTION_EASE.exit.join(",")})`;
/** How far the chat rises while it fades in, matching `--motion-swap-rise`. */
const CONTENT_RISE_PX = 6;

const running = new WeakMap<HTMLElement, () => void>();

/** Ends a morph still running on `root` at its final frame. */
export function finishMaximizeMorph(root: HTMLElement): void {
  running.get(root)?.();
}

/**
 * Morphs `cell` between `from` and `to` (both in `root`'s layout coordinates).
 * `opening` is true for maximize, false for restore; `others` are the neighbours'
 * frames, which fade out on maximize and back in on restore.
 */
export function animateMaximizeMorph(
  root: HTMLElement,
  cell: HTMLElement,
  from: CellRect,
  to: CellRect,
  opening: boolean,
  others: readonly HTMLElement[],
): void {
  finishMaximizeMorph(root);
  if (to.width <= 0 || to.height <= 0) return;
  const motion = MotionAnimation.start("grid-cell-maximize", 1, 0);
  if (motion.durationMs <= 0) return;

  const card = document.createElement("div");
  card.dataset.gridMorphCard = "";
  // The card layer of a cell sits 1px outside it (`inset: -1px`), and so does its stand-in.
  Object.assign(card.style, {
    left: `${to.x - 1}px`,
    top: `${to.y - 1}px`,
    width: `${to.width + 2}px`,
    height: `${to.height + 2}px`,
  });
  root.prepend(card);
  root.dataset.maximizeMorph = "";
  cell.dataset.maximizeMorph = "";

  const scaleX = (from.width + 2) / (to.width + 2);
  const scaleY = (from.height + 2) / (to.height + 2);
  const dx = from.x - to.x;
  const dy = from.y - to.y;
  const travel = playMotion(card, motion, (progress) => ({
    transform: `translate(${toDevicePixel(dx * progress)}px, ${toDevicePixel(dy * progress)}px) scale(${1 + (scaleX - 1) * progress}, ${1 + (scaleY - 1) * progress})`,
  }));
  // Maximize ends on the single-thread look (no card); restore ends on the grid's card.
  const tint = card.animate([{ opacity: opening ? 1 : 0 }, { opacity: opening ? 0 : 1 }], {
    duration: motion.durationMs,
    easing: STANDARD,
    fill: "forwards",
  });
  const contentDelay = Math.max(MOTION_ROLE_MS["content-delay"], motion.durationMs * 0.25);
  const content = cell.animate(
    [
      { opacity: 0, transform: `translateY(${CONTENT_RISE_PX}px)` },
      { opacity: 1, transform: "none" },
    ],
    {
      duration: MOTION_ROLE_MS["swap-in"],
      delay: contentDelay,
      easing: STANDARD,
      fill: "backwards",
    },
  );
  const neighbours = others.map((frame) => {
    if (opening) {
      frame.style.visibility = "visible";
      return frame.animate([{ opacity: 1 }, { opacity: 0 }], {
        duration: MOTION_ROLE_MS["overlay-out"],
        easing: EXIT,
        fill: "forwards",
      });
    }
    return frame.animate([{ opacity: 0 }, { opacity: 1 }], {
      duration: motion.durationMs * 0.8,
      delay: MOTION_ROLE_MS["content-delay"],
      easing: STANDARD,
      fill: "backwards",
    });
  });

  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    running.delete(root);
    travel.cancel();
    tint.cancel();
    content.cancel();
    for (const animation of neighbours) animation.cancel();
    if (opening) for (const frame of others) frame.style.visibility = "hidden";
    card.remove();
    // The cell's own card shows again with transitions still off for one frame, so it
    // takes over from the stand-in in place instead of fading in a second time.
    delete cell.dataset.maximizeMorph;
    requestAnimationFrame(() => {
      if (!running.has(root)) delete root.dataset.maximizeMorph;
    });
  };
  running.set(root, finish);
  void Promise.allSettled([
    tint.finished,
    content.finished,
    ...neighbours.map((a) => a.finished),
  ]).then(() => {
    if (running.get(root) === finish) finish();
  });
  probeCellMoveFrames(1, motion.durationMs, "maximize");
}
