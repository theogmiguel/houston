import { parsePatchFiles } from "@pierre/diffs/utils/parsePatchFiles";
import { describe, expect, it } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import "~/index.css";
import { resolveDiffThemeName } from "~/lib/diffRendering";
import { render } from "../../../test/render";
import { StyledDiffCodeView } from "./StyledDiffCodeView";

const FADE_PX = 64;
// The right side panel of the 1440px layout.
const PANEL_WIDTH = 399;
const LONG_LINE = `const added = Math.ceil((Math.max(1, 2) * 1000 + Math.random() * 4000) / 100) * 100 + more_and_more_text;`;
const SHORT_LINE = "const added = 1;";

function patchOf(addedLine: string): string {
  return `diff --git a/a.ts b/a.ts
--- a/a.ts
+++ b/a.ts
@@ -1,3 +1,3 @@
 const keep = 1;
-const removed = "old";
+${addedLine}
 const tail = 2;
`;
}

const GAPPED_PATCH = `diff --git a/a.ts b/a.ts
--- a/a.ts
+++ b/a.ts
@@ -1,3 +1,3 @@
 const keep = 1;
-const removed = "old";
+const added = 1;
 const tail = 2;
@@ -40,3 +40,3 @@
 const far = 1;
-const farRemoved = "old";
+const farAdded = 1;
 const farTail = 2;
`;

function descendants(root: ParentNode): Element[] {
  return [...root.querySelectorAll("*")].flatMap((element) => [
    element,
    ...(element.shadowRoot ? descendants(element.shadowRoot) : []),
  ]);
}

let mounted = 0;

async function mount(addedLine: string, patch = patchOf(addedLine)) {
  // The phone layout draws a lighter scroll shadow; these checks are for the desktop fade.
  const previousViewport = { width: window.innerWidth, height: window.innerHeight };
  await page.viewport(1280, 900);
  const id = `fade-${(mounted += 1)}`;
  // The viewer caches rendered files by cache key, so each mount needs its own.
  const fileDiff = parsePatchFiles(patch, id)[0]!.files[0]!;
  const box = document.createElement("div");
  box.style.cssText = `width:${PANEL_WIDTH}px;height:400px`;
  document.documentElement.classList.add("dark");
  const scheme = document.createElement("style");
  scheme.textContent = "diffs-container { color-scheme: dark; }";
  box.append(scheme);
  const screen = await render(
    <StyledDiffCodeView
      className="h-full"
      items={[{ id, type: "diff", fileDiff, version: 1 }]}
      options={{
        diffStyle: "unified",
        lineDiffType: "none",
        overflow: "scroll",
        theme: resolveDiffThemeName("dark"),
        themeType: "dark",
      }}
    />,
    { container: box },
  );
  await expect
    .poll(() => descendants(box).some((e) => e.hasAttribute("data-line")), { timeout: 20_000 })
    .toBe(true);
  const code = descendants(box).find((e) => e.hasAttribute("data-code")) as HTMLElement;
  const gutter = code.querySelector("[data-gutter]") as HTMLElement;
  const disposable = {
    async [Symbol.asyncDispose]() {
      await screen[Symbol.asyncDispose]();
      document.documentElement.classList.remove("dark");
      await page.viewport(previousViewport.width, previousViewport.height);
    },
  };
  return { screen: disposable, box, code, gutter, fade: () => getComputedStyle(gutter, "::after") };
}

describe("the right-edge fade of non-wrapping diffs", () => {
  it("shows on an overflowing line at the right edge of the panel", async () => {
    const view = await mount(LONG_LINE);
    await using _screen = view.screen;
    expect(view.code.scrollWidth).toBeGreaterThan(view.code.clientWidth);
    expect(view.code.clientWidth).toBe(PANEL_WIDTH);
    await expect.poll(() => view.fade().opacity).toBe("1");
    // A fade, an edge shadow and a hard edge rule, so the clipped edge reads as a scroll edge at rest
    // and not as the line's end.
    expect(view.fade().backgroundImage.match(/linear-gradient/g)).toHaveLength(3);
    expect(view.fade().position).toBe("absolute");
    expect(view.fade().width).toBe(`${FADE_PX}px`);
    // The gutter is sticky at the left edge of the viewport, so the fade's left offset puts it
    // flush against the right edge.
    expect(view.gutter.getBoundingClientRect().left).toBe(view.code.getBoundingClientRect().left);
    expect(Number.parseFloat(view.fade().left)).toBeCloseTo(PANEL_WIDTH - FADE_PX, 0);
  });

  it("stays on when animations are finished, as a screenshot with animations disabled does", async () => {
    const view = await mount(LONG_LINE);
    await using _screen = view.screen;
    await expect.poll(() => view.fade().opacity).toBe("1");
    for (const animation of document.getAnimations()) animation.finish();
    expect(view.fade().content).toBe('""');
    expect(view.fade().opacity).toBe("1");
  });

  it("stays at the right edge while scrolled and goes away at the end of the line", async () => {
    const view = await mount(LONG_LINE);
    await using _screen = view.screen;
    await expect.poll(() => view.fade().opacity).toBe("1");
    view.code.scrollLeft = 40;
    await expect.poll(() => view.code.scrollLeft).toBeGreaterThan(0);
    expect(view.fade().opacity).toBe("1");
    expect(view.gutter.getBoundingClientRect().left).toBe(view.code.getBoundingClientRect().left);
    view.code.scrollLeft = view.code.scrollWidth;
    await expect.poll(() => view.fade().opacity).toBe("0");
  });

  it("does not show when no line overflows", async () => {
    const view = await mount(SHORT_LINE);
    await using _screen = view.screen;
    expect(view.code.scrollWidth).toBeLessThanOrEqual(view.code.clientWidth);
    expect(view.fade().opacity).toBe("0");
  });
});

describe("the hunk separators of a diff", () => {
  it("name what they reveal instead of describing the hidden lines", async () => {
    const view = await mount(SHORT_LINE, GAPPED_PATCH);
    await using _screen = view.screen;
    await expect
      .poll(() =>
        descendants(view.box)
          .filter((e) => e.hasAttribute("data-unmodified-lines"))
          .map((e) => e.textContent),
      )
      .toEqual(expect.arrayContaining([expect.stringMatching(/^Show \d+ more lines?$/)]));
    const texts = descendants(view.box)
      .filter((e) => e.hasAttribute("data-unmodified-lines"))
      .map((e) => e.textContent ?? "");
    for (const text of texts) {
      expect(text).toMatch(/^(Show \d+ more lines?|Expand context)$/);
    }
  });
});
