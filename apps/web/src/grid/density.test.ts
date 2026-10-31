import { describe, expect, it } from "vite-plus/test";

import {
  DENSITY_HYSTERESIS_PX,
  paneDensityFor,
  paneDensityLayout,
  retierPaneDensity,
} from "./density";

describe("paneDensityFor", () => {
  it("uses solo only for a single thread in a wide pane", () => {
    expect(paneDensityFor({ width: 900, height: 700 }, 1)).toBe("solo");
    expect(paneDensityFor({ width: 899, height: 700 }, 1)).toBe("comfortable");
    expect(paneDensityFor({ width: 1200, height: 800 }, 2)).toBe("comfortable");
  });

  it("steps through comfortable, compact and glance by measured size", () => {
    expect(paneDensityFor({ width: 560, height: 520 }, 3)).toBe("comfortable");
    expect(paneDensityFor({ width: 559, height: 700 }, 3)).toBe("compact");
    expect(paneDensityFor({ width: 700, height: 519 }, 3)).toBe("compact");
    expect(paneDensityFor({ width: 400, height: 340 }, 3)).toBe("compact");
    expect(paneDensityFor({ width: 399, height: 700 }, 3)).toBe("glance");
    expect(paneDensityFor({ width: 700, height: 339 }, 3)).toBe("glance");
  });
});

describe("retierPaneDensity", () => {
  it("needs a threshold plus the hysteresis margin to gain a tier", () => {
    expect(retierPaneDensity("comfortable", { width: 939, height: 700 }, 1)).toBe("comfortable");
    expect(retierPaneDensity("comfortable", { width: 940, height: 700 }, 1)).toBe("solo");
    expect(retierPaneDensity("compact", { width: 599, height: 700 }, 2)).toBe("compact");
    expect(retierPaneDensity("compact", { width: 620, height: 700 }, 2)).toBe("comfortable");
  });

  it("keeps its tier until the size falls the margin below the threshold", () => {
    expect(retierPaneDensity("comfortable", { width: 540, height: 700 }, 2)).toBe("comfortable");
    expect(retierPaneDensity("comfortable", { width: 500, height: 700 }, 2)).toBe("compact");
    expect(retierPaneDensity("compact", { width: 380, height: 700 }, 2)).toBe("compact");
    expect(retierPaneDensity("compact", { width: 350, height: 700 }, 2)).toBe("glance");
  });

  it("keeps a tier whose size is still inside the same band", () => {
    expect(retierPaneDensity("comfortable", { width: 700, height: 600 }, 2)).toBe("comfortable");
    expect(retierPaneDensity("compact", { width: 460, height: 420 }, 2)).toBe("compact");
    expect(retierPaneDensity("glance", { width: 300, height: 260 }, 2)).toBe("glance");
  });

  it("exposes the margin as a named constant", () => {
    expect(DENSITY_HYSTERESIS_PX).toBe(40);
  });
});

describe("paneDensityLayout", () => {
  it("moves chrome into the toolbar in solo and keeps a 720/760 measure", () => {
    const layout = paneDensityLayout("solo", 1200);
    expect(layout.showHeader).toBe(false);
    expect(layout.timelineMaxWidth).toBe(720);
    expect(layout.composerMaxWidth).toBe(760);
  });

  it("shows the branch only in a comfortable pane at least 640px wide", () => {
    expect(paneDensityLayout("comfortable", 640).showBranch).toBe(true);
    expect(paneDensityLayout("comfortable", 639).showBranch).toBe(false);
    expect(paneDensityLayout("compact", 900).showBranch).toBe(false);
  });

  it("limits compact and glance timelines", () => {
    expect(paneDensityLayout("compact", 500).timeline).toBe("latest-turn");
    expect(paneDensityLayout("compact", 500).messageLines).toBe(5);
    expect(paneDensityLayout("glance", 300).timeline).toBe("latest-message");
    expect(paneDensityLayout("glance", 300).messageLines).toBe(3);
  });
});
