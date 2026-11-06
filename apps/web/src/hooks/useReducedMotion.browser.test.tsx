import { describe, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import "../index.css";
import { render } from "../../test/render";
import { configureMotion } from "../motion/registry";
import { prefersReducedMotion, useReducedMotion } from "./useReducedMotion";

function withMediaMatches(matches: boolean) {
  const original = window.matchMedia;
  const matchMedia = vi.fn((query: string) =>
    Object.assign(new EventTarget(), { matches, media: query, onchange: null }),
  );
  window.matchMedia = matchMedia as unknown as typeof window.matchMedia;
  return () => {
    window.matchMedia = original;
  };
}

/** Restores the Animations setting when the test's scope ends. */
function restoreMotionAfterTest(): Disposable {
  return { [Symbol.dispose]: () => configureMotion({ off: false }) };
}

function Probe() {
  return <output>{useReducedMotion() ? "reduced" : "full"}</output>;
}

describe("useReducedMotion", () => {
  it("reports the query result in a render", async () => {
    const restore = withMediaMatches(true);
    try {
      await using _screen = await render(<Probe />, { router: false });
      await expect.element(page.getByText("reduced")).toBeInTheDocument();
    } finally {
      restore();
    }
  });

  it("reads the preference outside a render", () => {
    const restore = withMediaMatches(false);
    try {
      expect(prefersReducedMotion()).toBe(false);
    } finally {
      restore();
    }
  });

  it("follows the Animations setting when the system allows motion", async () => {
    using _motion = restoreMotionAfterTest();
    const restore = withMediaMatches(false);
    try {
      await using _screen = await render(<Probe />, { router: false });
      await expect.element(page.getByText("full")).toBeInTheDocument();

      configureMotion({ off: true });
      await expect.element(page.getByText("reduced")).toBeInTheDocument();
      expect(prefersReducedMotion()).toBe(true);

      configureMotion({ off: false });
      await expect.element(page.getByText("full")).toBeInTheDocument();
      expect(prefersReducedMotion()).toBe(false);
    } finally {
      restore();
    }
  });
});

describe("the Animations setting in CSS", () => {
  function probe(className: string): HTMLElement {
    const element = document.createElement("div");
    element.className = className;
    document.body.append(element);
    return element;
  }

  it("zeroes every motion role and flips the motion variants", () => {
    using _motion = restoreMotionAfterTest();
    const grid = document.createElement("div");
    grid.dataset.gridSurface = "";
    document.body.append(grid);
    const root = document.documentElement;
    const safe = probe("opacity-100 motion-safe:opacity-50");
    const reduce = probe("opacity-100 motion-reduce:opacity-50");
    try {
      configureMotion({ off: true });
      expect(root.dataset.motion).toBe("off");
      expect(getComputedStyle(safe).getPropertyValue("--motion-overlay-in").trim()).toBe("0ms");
      expect(getComputedStyle(safe).getPropertyValue("--motion-swap-rise").trim()).toBe("0px");
      expect(getComputedStyle(safe).opacity).toBe("1");
      expect(getComputedStyle(reduce).opacity).toBe("0.5");
      expect(getComputedStyle(grid).transitionProperty).toBe("none");

      configureMotion({ off: false });
      expect(root.dataset.motion).toBeUndefined();
      expect(getComputedStyle(safe).getPropertyValue("--motion-overlay-in").trim()).toBe("150ms");
      expect(getComputedStyle(safe).opacity).toBe("0.5");
      expect(getComputedStyle(reduce).opacity).toBe("1");
    } finally {
      safe.remove();
      reduce.remove();
      grid.remove();
    }
  });
});
