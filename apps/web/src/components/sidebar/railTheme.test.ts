import { describe, expect, it } from "vite-plus/test";

import { nextRailThemeMode, railThemeLabel } from "./railTheme";

describe("rail theme button", () => {
  it("cycles System → Graphite → Paper and back", () => {
    expect(nextRailThemeMode("system")).toBe("dark");
    expect(nextRailThemeMode("dark")).toBe("light");
    expect(nextRailThemeMode("light")).toBe("system");
  });

  it("names the modes the way the board does", () => {
    expect(railThemeLabel("system")).toBe("System");
    expect(railThemeLabel("dark")).toBe("Graphite");
    expect(railThemeLabel("light")).toBe("Paper");
  });
});
