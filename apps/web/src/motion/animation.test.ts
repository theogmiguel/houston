import { afterEach, describe, expect, it } from "vite-plus/test";

import { MotionAnimation } from "./animation";
import { configureMotion } from "./registry";

afterEach(() => configureMotion({ off: false, slowdown: 1 }));

describe("MotionAnimation", () => {
  it("settles a pane move in the prototype's ~460ms", () => {
    const motion = MotionAnimation.start("workspace-switch", 1, 0);
    expect(motion.durationMs).toBeGreaterThan(400);
    expect(motion.durationMs).toBeLessThan(520);
    expect(motion.valueAt(0)).toBe(1);
    expect(motion.valueAt(motion.durationMs)).toBe(0);
  });

  it("completes at once when motion is off", () => {
    configureMotion({ off: true });
    const motion = MotionAnimation.start("workspace-switch", 1, 0);
    expect(motion.durationMs).toBe(0);
    expect(motion.valueAt(0)).toBe(0);
  });

  it("scales the duration by the slowdown", () => {
    configureMotion({ slowdown: 2 });
    const motion = MotionAnimation.start("workspace-switch", 1, 0);
    expect(motion.durationMs).toBeGreaterThan(800);
  });

  it("samples a CSS easing that starts at 0 and ends at 1", () => {
    const motion = MotionAnimation.start("workspace-switch", 0, 100);
    const easing = motion.cssEasing();
    expect(easing.startsWith("linear(")).toBe(true);
    const points = easing.slice("linear(".length, -1).split(", ").map(Number);
    expect(points[0]).toBe(0);
    expect(points.at(-1)).toBe(1);
  });

  it("reports zero velocity once it has settled", () => {
    const motion = MotionAnimation.start("workspace-switch", 0, 100);
    expect(motion.velocityAt(motion.durationMs)).toBe(0);
    expect(Math.abs(motion.velocityAt(0))).toBeGreaterThan(0);
  });
});
