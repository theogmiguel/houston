import { describe, expect, it } from "vite-plus/test";

import "./fonts";
import "~/index.css";

describe("bundled fonts", () => {
  it("loads the code face from the app instead of the system", async () => {
    const mono = getComputedStyle(document.documentElement).getPropertyValue("--font-mono");
    const first = mono
      .split(",")[0]
      ?.trim()
      .replace(/^(['"])(.*)\1$/, "$2");
    expect(first).toBe("JetBrains Mono Variable");

    const faces = await document.fonts.load(`16px "${first}"`);
    expect(faces.length).toBeGreaterThan(0);
  });
});
