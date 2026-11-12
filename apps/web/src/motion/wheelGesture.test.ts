import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { isDiscreteWheel, WheelTail, wheelDeltaPx, WHEEL_STREAM_IDLE_MS } from "./wheelGesture";

const DOM_DELTA_PIXEL = 0;
const DOM_DELTA_LINE = 1;
const DOM_DELTA_PAGE = 2;

beforeEach(() => {
  vi.stubGlobal("WheelEvent", { DOM_DELTA_PIXEL, DOM_DELTA_LINE, DOM_DELTA_PAGE });
});
afterEach(() => vi.unstubAllGlobals());

const wheel = (init: { deltaY: number; deltaMode?: number; wheelDeltaY?: number }) =>
  ({ deltaMode: DOM_DELTA_PIXEL, ...init }) as unknown as WheelEvent;

describe("isDiscreteWheel", () => {
  it("treats line and page deltas as notches", () => {
    expect(isDiscreteWheel(wheel({ deltaY: 3, deltaMode: DOM_DELTA_LINE }))).toBe(true);
    expect(isDiscreteWheel(wheel({ deltaY: 1, deltaMode: DOM_DELTA_PAGE }))).toBe(true);
  });

  it("treats a pixel delta with a 120-unit legacy delta as a notch", () => {
    expect(isDiscreteWheel(wheel({ deltaY: 100, wheelDeltaY: -120 }))).toBe(true);
  });

  it("treats precise trackpad deltas as a swipe", () => {
    expect(isDiscreteWheel(wheel({ deltaY: 7 }))).toBe(false);
    expect(isDiscreteWheel(wheel({ deltaY: 7, wheelDeltaY: -21 }))).toBe(false);
    // A 120-multiple that is exactly the pixel delta's own scaling is still a trackpad.
    expect(isDiscreteWheel(wheel({ deltaY: 40, wheelDeltaY: -120 }))).toBe(false);
    expect(isDiscreteWheel(wheel({ deltaY: 120, wheelDeltaY: -120 }))).toBe(false);
  });
});

describe("wheelDeltaPx", () => {
  it("converts lines and pages to px and leaves pixels alone", () => {
    expect(wheelDeltaPx(2, wheel({ deltaY: 0, deltaMode: DOM_DELTA_LINE }))).toBe(80);
    expect(wheelDeltaPx(1, wheel({ deltaY: 0, deltaMode: DOM_DELTA_PAGE }))).toBe(800);
    expect(wheelDeltaPx(5, wheel({ deltaY: 0 }))).toBe(5);
  });
});

describe("WheelTail", () => {
  /** Five fast deltas (3750px/s), the fingers' swipe. */
  function swipe(tail: WheelTail, pastEdge = false) {
    return [1, 2, 3, 4, 5].map((step) => tail.push(30, step * 8, pastEdge));
  }

  it("keeps a fast swipe a gesture, then calls the fingers lifted when momentum drops under its share of the peak", () => {
    const tail = new WheelTail();
    expect(swipe(tail)).toEqual(["gesture", "gesture", "gesture", "gesture", "gesture"]);
    expect(tail.push(100, 90)).toBe("gesture");
    expect(tail.push(1, 160)).toBe("lifted");
  });

  it("swallows the tail so jittery deltas cannot start a second step", () => {
    const tail = new WheelTail();
    swipe(tail);
    tail.push(100, 90);
    tail.push(1, 160);
    expect(tail.push(2, 176)).toBe("tail");
    expect(tail.push(1, 192)).toBe("tail");
  });

  it("resumes only on a reversal inside the tail", () => {
    const tail = new WheelTail();
    swipe(tail);
    tail.push(100, 90);
    tail.push(1, 160);
    expect(tail.push(-30, 200)).toBe("resumed");
    expect(tail.push(-30, 208)).toBe("gesture");
  });

  it("keeps a slow drag a gesture: it ends on idle alone", () => {
    const tail = new WheelTail();
    const kinds = [1, 2, 1, 2, 1].map((delta, i) => tail.push(delta, i * 16));
    expect(new Set(kinds)).toEqual(new Set(["gesture"]));
  });

  it("calls a swipe pressed past the last stop lifted at the first slowing, where an open one is not", () => {
    expect(swipe(new WheelTail(), true)).toContain("lifted");
    expect(swipe(new WheelTail(), false)).not.toContain("lifted");
  });

  it("closes a stream after an idle gap longer than the wheel's own event interval", () => {
    expect(WHEEL_STREAM_IDLE_MS).toBeGreaterThan(17);
  });
});
