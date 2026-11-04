import { describe, expect, it } from "vite-plus/test";

import { Spring } from "./spring";

const CRITICAL = { dampingRatio: 1, stiffness: 800, epsilon: 0.0001 };

describe("Spring", () => {
  it("starts at from and ends within epsilon of to", () => {
    const spring = new Spring(0, 100, 0, CRITICAL);
    expect(spring.valueAt(0)).toBeCloseTo(0, 6);
    expect(Math.abs(100 - spring.valueAt(spring.duration()))).toBeLessThan(0.5);
  });

  it("never overshoots when critically damped", () => {
    const spring = new Spring(0, 100, 0, CRITICAL);
    for (let ms = 0; ms <= 1000; ms += 5) {
      expect(spring.valueAt(ms / 1000)).toBeLessThanOrEqual(100.0001);
    }
  });

  it("overshoots when underdamped", () => {
    const spring = new Spring(0, 100, 0, { dampingRatio: 0.5, stiffness: 500, epsilon: 0.0001 });
    let peak = 0;
    for (let ms = 0; ms <= 2000; ms += 5) {
      peak = Math.max(peak, spring.valueAt(ms / 1000));
    }
    expect(peak).toBeGreaterThan(100);
  });

  it("keeps a moving start in the direction of its velocity", () => {
    const spring = new Spring(0, 100, 500, CRITICAL);
    expect(spring.valueAt(0.01)).toBeGreaterThan(0);
  });

  it("reports no duration when nothing moves", () => {
    expect(new Spring(50, 50, 0, CRITICAL).duration()).toBe(0);
  });
});
