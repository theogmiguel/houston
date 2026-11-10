import { describe, expect, it } from "vite-plus/test";

import "~/index.css";

type Channels = readonly [number, number, number];

/** Resolves a token's computed colour through a canvas so wide-gamut spellings normalize. */
function normalize(variable: string): { rgb: Channels; alpha: number } {
  const probe = document.createElement("div");
  probe.style.backgroundColor = `var(${variable})`;
  document.body.append(probe);
  const color = getComputedStyle(probe).backgroundColor;
  probe.remove();

  const context = document.createElement("canvas").getContext("2d")!;
  context.fillStyle = "#000000";
  context.fillRect(0, 0, 1, 1);
  context.fillStyle = color;
  context.fillRect(0, 0, 1, 1);
  const [r, g, b] = context.getImageData(0, 0, 1, 1).data;
  // A translucent colour over black is not the colour itself; read its alpha from the spelling.
  const alphaMatch =
    color.match(/\/\s*([0-9.]+)\s*\)/) ?? color.match(/rgba\([^)]*,\s*([0-9.]+)\s*\)/);
  return {
    rgb: [r!, g!, b!],
    alpha: alphaMatch ? Number(alphaMatch[1]) : 1,
  };
}

function painted(variable: string): Channels {
  const probe = document.createElement("div");
  probe.style.backgroundColor = `var(${variable})`;
  document.body.append(probe);
  const resolved = getComputedStyle(probe).backgroundColor;
  probe.remove();
  if (/^color\(|^rgba?\(|^oklab\(/.test(resolved)) {
    const context = document.createElement("canvas").getContext("2d")!;
    context.fillStyle = resolved;
    context.fillRect(0, 0, 1, 1);
    const [r, g, b] = context.getImageData(0, 0, 1, 1).data;
    return [r!, g!, b!];
  }
  const match = resolved.match(/^#([0-9a-f]{6})$/i);
  if (match) {
    const value = match[1]!;
    return [
      Number.parseInt(value.slice(0, 2), 16),
      Number.parseInt(value.slice(2, 4), 16),
      Number.parseInt(value.slice(4, 6), 16),
    ];
  }
  expect(resolved, `${variable} resolves to a colour`).not.toBe("");
  const context = document.createElement("canvas").getContext("2d")!;
  context.fillStyle = resolved;
  context.fillRect(0, 0, 1, 1);
  const [r, g, b] = context.getImageData(0, 0, 1, 1).data;
  return [r!, g!, b!];
}

function alpha(variable: string): number {
  return normalize(variable).alpha;
}

function luminance([r, g, b]: Channels): number {
  const [rl, gl, bl] = [r, g, b].map((channel) => {
    const value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  }) as unknown as Channels;
  return 0.2126 * rl + 0.7152 * gl + 0.0722 * bl;
}

function contrast(a: Channels, b: Channels): number {
  const [lighter, darker] = [luminance(a), luminance(b)].toSorted((x, y) => y - x);
  return (lighter! + 0.05) / (darker! + 0.05);
}

function themed(dark: boolean): Disposable {
  const root = document.documentElement;
  root.classList.toggle("dark", dark);
  return { [Symbol.dispose]: () => root.classList.remove("dark") };
}

describe("surface levels", () => {
  it("separates chrome, canvas and raised in dark by their fills", () => {
    using _dark = themed(true);
    const chrome = painted("--rail");
    const canvas = painted("--content");
    const raised = painted("--raised");
    expect(chrome).not.toEqual(canvas);
    expect(canvas).not.toEqual(raised);
    expect(chrome).not.toEqual(raised);
    // Chrome sits below the canvas, which sits below the raised tier.
    expect(luminance(chrome)).toBeLessThan(luminance(canvas));
    expect(luminance(canvas)).toBeLessThan(luminance(raised));
  });

  it("separates chrome from the white canvas in light and draws raised edges", () => {
    using _light = themed(false);
    const chrome = painted("--rail");
    const canvas = painted("--content");
    // The light canvas and the raised cards share white; the edge and its lift separate them.
    expect(chrome).not.toEqual(canvas);
    expect(luminance(chrome)).toBeLessThan(luminance(canvas));
    expect(alpha("--card-edge")).toBeGreaterThan(0);
    expect(alpha("--card-edge")).toBeLessThan(0.25);
    const probe = document.createElement("div");
    probe.style.boxShadow = "var(--shadow-composer)";
    document.body.append(probe);
    const lift = getComputedStyle(probe).boxShadow;
    probe.remove();
    expect(lift).not.toBe("none");
  });

  it.each([false, true])(
    "keeps accent text readable on the accent fill and the canvas (dark=%s)",
    (dark) => {
      using _theme = themed(dark);
      const fill = painted("--accent");
      const onFill = painted("--primary-foreground");
      expect(contrast(fill, onFill)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(painted("--accent-ink"), painted("--content"))).toBeGreaterThanOrEqual(4.5);
    },
  );

  it.each([false, true])("fills a user turn with the card colour (dark=%s)", (dark) => {
    using _theme = themed(dark);
    const bubble = painted("--bubble");
    const card = painted("--card");
    expect(bubble).toEqual(card);
  });
});
