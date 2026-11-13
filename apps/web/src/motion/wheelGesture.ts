/**
 * How a browser wheel stream maps onto a gesture: which wheel events are notches, which scroller
 * owns a sideways swipe, and where a trackpad swipe's momentum begins. The swipe tracker and the
 * rubber band they feed are in `gesture.ts`.
 */
import { SwipeTracker } from "./gesture";

/** Legacy wheelDeltaY distinguishes discrete 120-unit notches from precise trackpad deltas;
 * ambiguous pixel events remain swipe gestures. */
export function isDiscreteWheel(event: WheelEvent): boolean {
  if (event.deltaMode !== WheelEvent.DOM_DELTA_PIXEL) return true;
  const legacy = (event as WheelEvent & { wheelDeltaY?: number }).wheelDeltaY;
  if (typeof legacy !== "number" || legacy === 0 || legacy % 120 !== 0) return false;
  return legacy !== -3 * event.deltaY && legacy !== -event.deltaY;
}

/** Wheel deltas in px; a notch in lines or pages counts as one screenful step anyway. */
export function wheelDeltaPx(delta: number, event: WheelEvent): number {
  if (event.deltaMode === WheelEvent.DOM_DELTA_LINE) return delta * 40;
  if (event.deltaMode === WheelEvent.DOM_DELTA_PAGE) return delta * 800;
  return delta;
}

function scrollsSideways(element: Element): boolean {
  if (element.scrollWidth <= element.clientWidth) return false;
  const { overflowX } = getComputedStyle(element);
  return overflowX === "auto" || overflowX === "scroll";
}

export function sidewaysWheelScrollsStrip(
  path: readonly EventTarget[],
  strip: Element,
  deltaX: number,
  deltaY: number,
): boolean {
  if (Math.abs(deltaX) <= Math.abs(deltaY)) return false;
  for (const node of path) {
    if (node === strip) return scrollsSideways(strip);
    if (node instanceof Element && scrollsSideways(node)) return false;
  }
  return false;
}

/**
 * The browser sends a trackpad swipe as wheel events with no begin or end,
 * and keeps sending the OS's momentum after the fingers lift. A stream ends
 * after this long without an event: fingers resting or lifted, momentum
 * spent. Events while fingers move or momentum runs come every 8-17ms.
 */
export const WHEEL_STREAM_IDLE_MS = 120;
/**
 * The fingers count as lifted once the stream's velocity falls under this
 * share of its peak: momentum only ever decays, so the rest of the stream
 * is the tail. Pressed past the last stop, any slowing counts (`EDGE_SHARE`).
 * Below `TAIL_MIN_PEAK` (px/s) a stream is a slow drag that ends on idle alone.
 */
const TAIL_SHARE = 0.4;
const EDGE_SHARE = 0.8;
const TAIL_MIN_PEAK = 1200;

/** Only a reversal starts a new gesture inside a momentum stream. Swallow the tail so coalesced or
 * jittery deltas cannot trigger a second step. */
export class WheelTail {
  private tracker = new SwipeTracker();
  private peak = 0;
  private sign = 0;
  private lifted = false;

  /** `pastEdge`: the gesture already overshoots its last stop. */
  push(delta: number, time: number, pastEdge = false): "gesture" | "lifted" | "tail" | "resumed" {
    const sign = Math.sign(delta);
    this.tracker.push(delta, time);
    const speed = Math.abs(this.tracker.velocity());
    if (this.lifted) {
      if (sign !== 0 && sign !== this.sign && Math.abs(delta) >= 2) {
        this.reset(sign, time, delta);
        return "resumed";
      }
      return "tail";
    }
    if (sign !== 0) this.sign ||= sign;
    this.peak = Math.max(this.peak, speed);
    if (this.peak >= TAIL_MIN_PEAK && speed < this.peak * (pastEdge ? EDGE_SHARE : TAIL_SHARE)) {
      this.lifted = true;
      return "lifted";
    }
    return "gesture";
  }

  private reset(sign: number, time: number, delta: number): void {
    this.tracker = new SwipeTracker();
    this.tracker.push(delta, time);
    this.peak = 0;
    this.sign = sign;
    this.lifted = false;
  }
}

/**
 * Elements that scroll on the wheel by themselves, with no overflow to read
 * (a terminal's canvas): whether they would still move `dy`'s way. A plain
 * vertical swipe over one switches workspaces only when this says no.
 */
const wheelScrollers = new WeakMap<object, (dy: number) => boolean>();

export function setWheelScroller(
  element: object,
  canScroll: ((dy: number) => boolean) | null,
): void {
  if (canScroll) wheelScrollers.set(element, canScroll);
  else wheelScrollers.delete(element);
}
