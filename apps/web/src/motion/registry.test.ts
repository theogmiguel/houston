import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  configureMotion,
  MOTION_EASE,
  MOTION_ROLE_MS,
  motionSettings,
  resolveMotion,
} from "./registry";

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

describe("motion roles", () => {
  it("match the stylesheet's tokens", async () => {
    const { readFile } = await import("node:fs/promises");
    const css = await readFile(new URL("../index.css", import.meta.url), "utf8");
    const start = css.indexOf("--motion-feedback");
    const root = css.slice(start, css.indexOf("@media (prefers-reduced-motion", start));
    const fromCss = Object.fromEntries(
      [...root.matchAll(/--motion-([a-z-]+): (\d+)ms;/g)].map(([, name, ms]) => [name, Number(ms)]),
    );
    expect(fromCss).toEqual(MOTION_ROLE_MS);
    for (const [name, points] of Object.entries(MOTION_EASE)) {
      expect(css).toContain(`--ease-${name}: cubic-bezier(${points.join(", ")});`);
    }
  });
});
