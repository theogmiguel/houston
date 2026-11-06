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
    const root = css.slice(start, css.indexOf("@variant motion-reduce", start));
    const fromCss = Object.fromEntries(
      [...root.matchAll(/--motion-([a-z-]+): (\d+)ms;/g)].map(([, name, ms]) => [name, Number(ms)]),
    );
    expect(fromCss).toEqual(MOTION_ROLE_MS);
    for (const [name, points] of Object.entries(MOTION_EASE)) {
      expect(css).toContain(`--ease-${name}: cubic-bezier(${points.join(", ")});`);
    }
  });
});

describe("reduced motion", () => {
  // Shadow-root sheets cannot use the stylesheet's variants; each pairs its media query
  // with a `:host-context([data-motion="off"])` rule instead.
  const OWNERS = new Set([
    "motion/registry.ts",
    "index.css",
    "pierre-tree-theme.ts",
    "components/diffs/StyledDiffCodeView.tsx",
  ]);

  it("is read only through the registry, so the Animations setting reaches every animation", async () => {
    const { readdir, readFile } = await import("node:fs/promises");
    const root = new URL("../", import.meta.url);
    const files = await readdir(root, { recursive: true });
    const offenders: string[] = [];
    for (const file of files) {
      if (!/\.(ts|tsx|css)$/.test(file) || /\.test\.tsx?$/.test(file) || OWNERS.has(file)) continue;
      const source = await readFile(new URL(file, root), "utf8");
      if (source.includes("prefers-reduced-motion")) offenders.push(file);
    }
    expect(offenders, "use prefersReducedMotion/useReducedMotion or the motion-* variants").toEqual(
      [],
    );
  });
});
