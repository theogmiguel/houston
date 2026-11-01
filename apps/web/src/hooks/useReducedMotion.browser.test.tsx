import { describe, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { render } from "../../test/render";
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

describe("useReducedMotion", () => {
  it("reports the query result in a render", async () => {
    const restore = withMediaMatches(true);
    try {
      function Probe() {
        return <output>{useReducedMotion() ? "reduced" : "full"}</output>;
      }
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
});
