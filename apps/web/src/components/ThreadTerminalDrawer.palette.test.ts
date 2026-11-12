import { describe, expect, it } from "vite-plus/test";

import { TERMINAL_PALETTES } from "./ThreadTerminalDrawer";

function channel(value: number): number {
  const unit = value / 255;
  return unit <= 0.03928 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4;
}

type Rgb = { readonly r: number; readonly g: number; readonly b: number };

const WHITE: Rgb = { r: 255, g: 255, b: 255 };

function luminance({ r, g, b }: Rgb): number {
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrast(foreground: Rgb, background: Rgb): number {
  const [light, dark] = [luminance(foreground), luminance(background)].toSorted((a, b) => b - a);
  return (light! + 0.05) / (dark! + 0.05);
}

describe("terminal palettes", () => {
  it("keeps every light ANSI colour at WCAG AA against the white terminal", () => {
    const weak = TERMINAL_PALETTES.light
      .map(
        (color, index) =>
          `${index}:${color.r},${color.g},${color.b}=${contrast(color, WHITE).toFixed(2)}`,
      )
      .filter((entry) => Number(entry.split("=")[1]) < 4.5);
    expect(weak, "light ANSI colours below 4.5:1 on white (index:colour=ratio)").toEqual([]);
  });
});
