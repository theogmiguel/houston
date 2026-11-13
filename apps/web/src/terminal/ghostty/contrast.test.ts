import { describe, expect, it } from "vite-plus/test";

import { contrastRatio, ensureTextContrast, TERMINAL_MINIMUM_CONTRAST } from "./contrast";

const WHITE = { r: 255, g: 255, b: 255 };
const BLACK = { r: 0, g: 0, b: 0 };

describe("ensureTextContrast", () => {
  it("darkens a pastel prompt colour on white to the minimum ratio, keeping its hue", () => {
    const pastelPink = { r: 245, g: 194, b: 231 };
    const result = ensureTextContrast(pastelPink, WHITE);
    expect(contrastRatio(result, WHITE)).toBeGreaterThanOrEqual(TERMINAL_MINIMUM_CONTRAST);
    expect(result.r).toBeGreaterThan(result.g);
  });

  it("lightens a dark colour on a dark background", () => {
    const result = ensureTextContrast({ r: 40, g: 40, b: 90 }, BLACK);
    expect(contrastRatio(result, BLACK)).toBeGreaterThanOrEqual(TERMINAL_MINIMUM_CONTRAST);
  });

  it("returns a colour that already meets the ratio unchanged", () => {
    const ink = { r: 20, g: 20, b: 20 };
    expect(ensureTextContrast(ink, WHITE)).toBe(ink);
  });
});
