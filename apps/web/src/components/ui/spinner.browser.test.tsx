import { describe, expect, it } from "vite-plus/test";

import "~/index.css";
import { render } from "../../../test/render";
import { StreamingGlyph } from "../chat/TimelineRowParts";
import { Alert, AlertDescription } from "./alert";
import { Button } from "./button";
import { RefreshIcon } from "./refresh-icon";
import { Spinner } from "./spinner";

// Chromium never runs an SVG element's transform animation on the compositor, so a
// spinning <svg> restyles and repaints on the main thread every display frame.
function animatedTargets(): Element[] {
  return document
    .getAnimations()
    .map((animation) => (animation.effect as KeyframeEffect | null)?.target ?? null)
    .filter((target): target is Element => target !== null);
}

function rect(element: Element): DOMRect {
  return element.getBoundingClientRect();
}

function expectCentredIn(inner: Element, outer: Element) {
  const a = rect(inner);
  const b = rect(outer);
  expect(Math.abs(a.left + a.width / 2 - (b.left + b.width / 2))).toBeLessThan(0.5);
  expect(Math.abs(a.top + a.height / 2 - (b.top + b.height / 2))).toBeLessThan(0.5);
}

describe("spinning glyphs", () => {
  it("animate an HTML box, never the SVG itself", async () => {
    await using screen = await render(
      <div>
        <Spinner />
        <RefreshIcon refreshing />
        <StreamingGlyph />
      </div>,
      { router: false },
    );
    const targets = () => animatedTargets().filter((target) => screen.container.contains(target));
    await expect.poll(() => targets().length).toBe(3);
    for (const target of targets()) {
      expect(target).toBeInstanceOf(HTMLElement);
    }
  });

  it("pause the streaming glyph while it is off-screen", async () => {
    await using screen = await render(
      <div>
        <div data-testid="visible">
          <StreamingGlyph />
        </div>
        <div data-testid="hidden" style={{ position: "fixed", top: "-500px" }}>
          <StreamingGlyph />
        </div>
      </div>,
      { router: false },
    );
    const visible = screen.container.querySelector('[data-testid="visible"] [data-streaming-glyph]')!;
    const hidden = screen.container.querySelector('[data-testid="hidden"] [data-streaming-glyph]')!;
    await expect.poll(() => getComputedStyle(visible).animationPlayState).toBe("running");
    expect(getComputedStyle(hidden).animationPlayState).toBe("paused");
    expect(getComputedStyle(visible).animationDuration).toBe("1.1s");
  });

  it("keep their sizes and turn about the glyph's centre", async () => {
    await using screen = await render(
      <div>
        <Button>
          <Spinner data-testid="in-button" />
          Saving
        </Button>
        <Spinner data-testid="sized" size="sm" />
        <Spinner data-testid="class-sized" className="size-3" />
        <RefreshIcon data-testid="refresh" size="md" refreshing />
        <StreamingGlyph />
        <Alert>
          <Spinner data-testid="in-alert" />
          <AlertDescription>Reading the change</AlertDescription>
        </Alert>
      </div>,
      { router: false },
    );

    const cases: Array<[string, number]> = [
      ['[data-testid="in-button"]', 16],
      ['[data-testid="sized"]', 14],
      ['[data-testid="class-sized"]', 12],
      ['[data-testid="refresh"]', 16],
      ["[data-streaming-glyph]", 14],
      ['[data-testid="in-alert"]', 16],
    ];
    for (const [selector, size] of cases) {
      const box = screen.container.querySelector(selector)!;
      const glyph = box.querySelector("svg")!;
      expect(rect(glyph).width, selector).toBeCloseTo(size, 1);
      expect(rect(glyph).height, selector).toBeCloseTo(size, 1);
      expectCentredIn(glyph, box);
    }
  });

  it("keep the muted tone inside a button", async () => {
    await using screen = await render(
      <Button>
        <Spinner data-testid="muted" tone="muted" />
        <Spinner data-testid="current" />
      </Button>,
      { router: false },
    );

    const muted = screen.container.querySelector('[data-testid="muted"] svg')!;
    const current = screen.container.querySelector('[data-testid="current"] svg')!;
    expect(getComputedStyle(muted).color).not.toBe(getComputedStyle(current).color);
  });
});
