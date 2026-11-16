import { describe, expect, it } from "vite-plus/test";

import source from "./HoustonWordmark.tsx?raw";

// The mark renders at 16-18px in chrome rows; a raster source is downscaled by the
// webview and blurs on 1x displays, so the source must stay a vector.
describe("Houston mark asset", () => {
  it("is imported as an SVG, never a raster image", () => {
    const imports = [...source.matchAll(/import\s+\w+\s+from\s+"([^"]*assets\/[^"]+)"/g)].map(
      (match) => match[1] ?? "",
    );
    expect(imports.length).toBeGreaterThan(0);
    for (const specifier of imports) {
      expect(specifier, `brand mark import ${specifier} must end in .svg`).toMatch(/\.svg$/);
    }
  });
});
