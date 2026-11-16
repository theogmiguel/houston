import { describe, expect, it } from "vite-plus/test";

import {
  STOP_RUBBER_BAND,
  SwipeTracker,
  rubberBandClamp,
  rubberBandClampDerivative,
} from "./gesture";

describe("SwipeTracker", () => {
  it("measures travel per second over the recent window", () => {
    const tracker = new SwipeTracker();
    for (let i = 0; i < 5; i += 1) tracker.push(10, i * 10);
    expect(tracker.pos).toBe(50);
    expect(tracker.velocity()).toBeCloseTo(1250, 0);
  });

  it("forgets deltas older than the velocity window", () => {
    const tracker = new SwipeTracker();
    tracker.push(100, 0);
    tracker.push(10, 300);
    tracker.push(10, 310);
    expect(tracker.velocity()).toBeCloseTo(2000, 0);
  });

  it("projects past the current position at speed", () => {
    const tracker = new SwipeTracker();
    for (let i = 0; i < 5; i += 1) tracker.push(10, i * 10);
    expect(tracker.projectedEndPos()).toBeGreaterThan(tracker.pos);
  });
});

describe("rubber band", () => {
  it("does not move a value inside the range", () => {
    expect(rubberBandClamp(STOP_RUBBER_BAND, 0, 2, 1)).toBe(1);
  });

  it("damps an overshoot and never passes the limit", () => {
    const over = rubberBandClamp(STOP_RUBBER_BAND, 0, 2, 10);
    expect(over).toBeGreaterThan(2);
    expect(over).toBeLessThan(2 + STOP_RUBBER_BAND.limit);
  });

  it("keeps full velocity inside the range and less at the edge", () => {
    expect(rubberBandClampDerivative(STOP_RUBBER_BAND, 0, 2, 1)).toBe(1);
    expect(rubberBandClampDerivative(STOP_RUBBER_BAND, 0, 2, 2.05)).toBeLessThan(1);
  });
});
