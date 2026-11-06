import { parsePatchFiles } from "@pierre/diffs/utils/parsePatchFiles";
import { afterEach, describe, expect, it } from "vite-plus/test";

import "~/index.css";
import { resolveDiffThemeName } from "~/lib/diffRendering";
import { render } from "../../../test/render";
import { StyledDiffCodeView } from "./StyledDiffCodeView";

const LONG_LINE = `const added = Math.ceil((Math.max(1, 2) * 1000 + Math.random() * 4000) / 100) * 100 + more_and_more_text;`;

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

function descendants(root: ParentNode): Element[] {
  return [...root.querySelectorAll("*")].flatMap((element) => [
    element,
    ...(element.shadowRoot ? descendants(element.shadowRoot) : []),
  ]);
}

let mounted = 0;

async function mount(addedLine: string, colorScheme: "light" | "dark") {
  const id = `diff-${(mounted += 1)}`;
  // The viewer caches rendered files by cache key, so each mount needs its own.
  const fileDiff = parsePatchFiles(patchOf(addedLine), id)[0]!.files[0]!;
  // The side panel is 400px wide; the viewer renders in a shadow root under a custom element.
  const box = document.createElement("div");
  box.style.cssText = "width:400px;height:400px";
  document.documentElement.classList.toggle("dark", colorScheme === "dark");
  // The viewer's own :host rule lets the OS preference pick light-dark(); the app pins the scheme.
  const scheme = document.createElement("style");
  scheme.textContent = `diffs-container { color-scheme: ${colorScheme}; }`;
  box.append(scheme);
  const screen = await render(
    <StyledDiffCodeView
      className="h-full"
      items={[{ id, type: "diff", fileDiff, version: 1 }]}
      options={{
        diffStyle: "unified",
        lineDiffType: "none",
        overflow: "scroll",
        theme: resolveDiffThemeName(colorScheme),
        themeType: colorScheme,
      }}
    />,
    { container: box },
  );
  await expect
    .poll(() => descendants(box).some((e) => e.hasAttribute("data-line")), { timeout: 20_000 })
    .toBe(true);
  return { box, screen, all: () => descendants(box) };
}

/** Resolves any CSS colour (the tints compute to lab()) to 0-255 sRGB channels. */
function toRgb(color: string): readonly [number, number, number] {
  const context = document.createElement("canvas").getContext("2d", { colorSpace: "srgb" })!;
  context.clearRect(0, 0, 1, 1);
  context.fillStyle = color;
  context.fillRect(0, 0, 1, 1);
  const [r, g, b] = context.getImageData(0, 0, 1, 1).data;
  return [r!, g!, b!];
}

function distance(a: string, b: string): number {
  const [from, to] = [toRgb(a), toRgb(b)];
  return Math.max(...from.map((channel, index) => Math.abs(channel - to[index]!)));
}

function rowBackgrounds(all: Element[]) {
  const byType = (type: string) =>
    all
      .filter((e) => e.getAttribute("data-line-type") === type && e.hasAttribute("data-line"))
      .map((e) => getComputedStyle(e).backgroundColor);
  return {
    context: byType("context"),
    added: byType("change-addition"),
    removed: byType("change-deletion"),
  };
}

afterEach(() => document.documentElement.classList.remove("dark"));

// The first mount waits for the highlighter worker, which is slow while other suites run.
describe("added and removed rows", { timeout: 30_000 }, () => {
  it.each(["light", "dark"] as const)(
    "carry a full-row background tint in the %s theme",
    async (scheme) => {
      const view = await mount(LONG_LINE, scheme);
      await using _screen = view.screen;
      const rows = rowBackgrounds(view.all());
      expect(rows.added).toHaveLength(1);
      expect(rows.removed).toHaveLength(1);
      expect(rows.context.length).toBeGreaterThan(0);
      for (const color of [...rows.added, ...rows.removed]) {
        expect(color).not.toBe("rgba(0, 0, 0, 0)");
      }
      // Context rows stay on the plain code surface; the changed rows differ from it.
      expect(new Set(rows.context).size).toBe(1);
      expect(rows.added[0]).not.toBe(rows.context[0]);
      expect(rows.removed[0]).not.toBe(rows.context[0]);
      expect(rows.added[0]).not.toBe(rows.removed[0]);
      // Both tints stay subtle: visible against the code surface, never a solid fill.
      for (const tinted of [rows.added[0]!, rows.removed[0]!]) {
        expect(distance(tinted, rows.context[0]!)).toBeGreaterThanOrEqual(16);
        expect(distance(tinted, rows.context[0]!)).toBeLessThanOrEqual(60);
      }
    },
  );
});

describe("horizontal overflow cue", { timeout: 30_000 }, () => {
  const fadeOn = "100% 100%";
  const fadeOff = "calc(100% + 24px) 100%";
  const scroller = (all: Element[]) =>
    all.find((e) => e.hasAttribute("data-code")) as HTMLElement | undefined;

  it("fades the right edge while a line runs past it, and not once the end is reached", async () => {
    const view = await mount(LONG_LINE, "dark");
    await using _screen = view.screen;
    const code = scroller(view.all())!;
    expect(code.scrollWidth).toBeGreaterThan(code.clientWidth);
    expect(getComputedStyle(code).maskImage).toContain("linear-gradient");
    await expect.poll(() => getComputedStyle(code).maskSize).toBe(fadeOn);
    code.scrollLeft = code.scrollWidth;
    await expect.poll(() => getComputedStyle(code).maskSize).toBe(fadeOff);
  });

  it("shows no fade when every line fits", async () => {
    const view = await mount("const added = 1;", "dark");
    await using _screen = view.screen;
    const code = scroller(view.all())!;
    expect(code.scrollWidth).toBeLessThanOrEqual(code.clientWidth);
    await expect.poll(() => getComputedStyle(code).maskSize).toBe(fadeOff);
  });
});
