import type { PointerEvent as ReactPointerEvent } from "react";

export type SweepAction = "close" | "reopen" | "wake";

const ACTION_ATTRIBUTE = "data-sweep-action";
const HIT_ATTRIBUTE = "data-sweep-hit";

let activeSweep: (() => void) | null = null;

/** The attributes that mark a row's action button as one a sweep can reach. */
export function sweepActionProps(action: SweepAction) {
  return { [ACTION_ATTRIBUTE]: action } as const;
}

/**
 * Rows a pointer at `point` reaches for `action`: the row's own button of that action. A row's
 * actions only take pointer events while it is hovered, so the row is found first and the button
 * inside it second.
 */
function rowUnderPoint(point: { x: number; y: number }, action: SweepAction): HTMLElement | null {
  const row = document
    .elementFromPoint(point.x, point.y)
    ?.closest<HTMLElement>("[data-thread-key]");
  if (row === null || row === undefined) return null;
  return row.querySelector(`[${ACTION_ATTRIBUTE}="${action}"]`) === null ? null : row;
}

/**
 * Press an action button and sweep across other rows' buttons of the same action: on release the
 * action applies to every row swept, the first included, and the release is not a click. A press
 * that never leaves its row stays a plain click.
 */
export function beginRowActionSweep(
  event: ReactPointerEvent<HTMLElement>,
  input: {
    readonly action: SweepAction;
    readonly threadKey: string;
    readonly apply: (action: SweepAction, threadKeys: ReadonlyArray<string>) => void;
  },
): void {
  if (event.button !== 0 || event.pointerType === "touch" || activeSweep !== null) return;
  const pointerId = event.pointerId;
  const origin = event.currentTarget;
  const swept = new Map<string, HTMLElement>([[input.threadKey, origin]]);
  origin.setAttribute(HIT_ATTRIBUTE, "");

  const move = (moveEvent: PointerEvent) => {
    if (moveEvent.pointerId !== pointerId) return;
    const row = rowUnderPoint({ x: moveEvent.clientX, y: moveEvent.clientY }, input.action);
    const key = row?.dataset.threadKey;
    if (row === null || key === undefined || swept.has(key)) return;
    const button = row.querySelector<HTMLElement>(`[${ACTION_ATTRIBUTE}="${input.action}"]`);
    if (button === null) return;
    button.setAttribute(HIT_ATTRIBUTE, "");
    swept.set(key, button);
  };

  const finish = (commit: boolean) => {
    window.removeEventListener("pointermove", move, true);
    window.removeEventListener("pointerup", up, true);
    window.removeEventListener("pointercancel", cancel, true);
    window.removeEventListener("keydown", key, true);
    activeSweep = null;
    for (const button of swept.values()) button.removeAttribute(HIT_ATTRIBUTE);
    if (swept.size < 2) return;
    // The release lands on a button; it must not also run that button's own click.
    const swallow = (clickEvent: MouseEvent) => {
      clickEvent.preventDefault();
      clickEvent.stopPropagation();
    };
    window.addEventListener("click", swallow, { capture: true, once: true });
    window.setTimeout(() => window.removeEventListener("click", swallow, true), 0);
    if (commit) input.apply(input.action, [...swept.keys()]);
  };
  const up = (upEvent: PointerEvent) => {
    if (upEvent.pointerId === pointerId) finish(true);
  };
  const cancel = () => finish(false);
  const key = (keyEvent: KeyboardEvent) => {
    if (keyEvent.key === "Escape") finish(false);
  };

  activeSweep = () => finish(false);
  window.addEventListener("pointermove", move, true);
  window.addEventListener("pointerup", up, true);
  window.addEventListener("pointercancel", cancel, true);
  window.addEventListener("keydown", key, true);
}
