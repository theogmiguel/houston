import { afterEach, describe, expect, it } from "vite-plus/test";

import { configureMotion, motionSettings, resolveMotion } from "./registry";

afterEach(() => configureMotion({ off: false, slowdown: 1 }));

describe("resolveMotion", () => {
  it("plays the grid spring by default", () => {
    const { config, slowdown } = resolveMotion("grid-cell-movement");
    expect(config.kind).toBe("spring");
    expect(slowdown).toBe(1);
  });

  it("turns every animation off under the global switch", () => {
    configureMotion({ off: true });
    expect(resolveMotion("grid-cell-enter").config).toEqual({ kind: "off" });
  });

  it("honours a per-name override", () => {
    configureMotion({
      animations: { "grid-cell-enter": { kind: "easing", durationMs: 100, curve: "linear" } },
    });
    expect(resolveMotion("grid-cell-enter").config.kind).toBe("easing");
    expect(resolveMotion("grid-cell-movement").config.kind).toBe("spring");
  });

  it("clamps the slowdown to a usable range", () => {
    configureMotion({ slowdown: 5000 });
    expect(motionSettings().slowdown).toBe(1000);
    configureMotion({ slowdown: 0 });
    expect(motionSettings().slowdown).toBe(0.001);
  });
});
