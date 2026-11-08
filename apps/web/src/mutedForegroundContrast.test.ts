// @effect-diagnostics nodeBuiltinImport:off - reads the shipped theme tokens from index.css on disk.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { describe, expect, it } from "vite-plus/test";

const indexCss = NodeFS.readFileSync(
  NodePath.join(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "index.css"),
  "utf8",
);

type Rgb = readonly [number, number, number];

/** The WCAG AA minimum for normal-size text, which settings help text and thread meta are. */
const MIN_TEXT_CONTRAST = 4.5;

function themeBlock(selector: string): string {
  const start = indexCss.indexOf(selector);
  if (start < 0) throw new Error(`index.css has no theme block starting with ${selector}`);
  return indexCss.slice(start, indexCss.indexOf("\n}", start));
}

function tokenValue(block: string, token: string): string {
  const match = new RegExp(`${token}:\\s*([^;]+);`).exec(block);
  if (!match) throw new Error(`Expected ${token} in the theme block, found none`);
  return match[1]!.trim();
}

function parseColor(value: string): { rgb: Rgb; alpha: number } {
  const hex = /^#([0-9a-f]{6})$/i.exec(value);
  if (hex) {
    const n = Number.parseInt(hex[1]!, 16);
    return { rgb: [(n >> 16) & 255, (n >> 8) & 255, n & 255], alpha: 1 };
  }
  const rgba = /^rgba?\(\s*(\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\s*\)$/.exec(value);
  if (rgba) {
    return {
      rgb: [Number(rgba[1]), Number(rgba[2]), Number(rgba[3])],
      alpha: rgba[4] === undefined ? 1 : Number(rgba[4]),
    };
  }
  throw new Error(`Expected a #rrggbb or rgb(a) color, received ${value}`);
}

function luminance([r, g, b]: Rgb): number {
  const linear = (channel: number) => {
    const c = channel / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

function contrastOn(foreground: string, surface: string): number {
  const bg = parseColor(surface);
  const fg = parseColor(foreground);
  const flattened = fg.rgb.map((channel, index) =>
    Math.round(channel * fg.alpha + bg.rgb[index]! * (1 - fg.alpha)),
  ) as unknown as Rgb;
  const [lighter, darker] = [luminance(flattened), luminance(bg.rgb)].sort((a, b) => b - a);
  return (lighter! + 0.05) / (darker! + 0.05);
}

describe("muted text contrast", () => {
  const themes = [
    { name: "paper (light)", selector: ':root,\n[data-theme="paper"] {' },
    { name: "graphite (dark)", selector: '.dark,\n[data-theme="graphite"] {' },
  ];

  it.each(themes)(
    `keeps --houston at ${MIN_TEXT_CONTRAST}:1 or better on every ground in $name`,
    ({ selector }) => {
      const block = themeBlock(selector);
      const muted = tokenValue(block, "--houston");
      for (const ground of ["--rail", "--content", "--card", "--raised"]) {
        const ratio = contrastOn(muted, tokenValue(block, ground));
        expect(
          ratio,
          `--houston ${muted} on ${ground} ${tokenValue(block, ground)} is ${ratio.toFixed(2)}:1, expected at least ${MIN_TEXT_CONTRAST}:1`,
        ).toBeGreaterThanOrEqual(MIN_TEXT_CONTRAST);
      }
    },
  );
});
