import { describe, expect, it } from "vite-plus/test";

import {
  SPLIT_PRESETS,
  presetOf,
  snapSplitRatio,
  splitFractionLabel,
  stepSplitPreset,
} from "./resize";

describe("snapSplitRatio", () => {
  it("snaps within 12px of a preset", () => {
    const pairPx = 900;
    // 10px away from a third: inside the magnet.
    const close = 1 / 3 + 10 / pairPx;
    expect(snapSplitRatio(close, pairPx, 12)).toEqual({ value: 1 / 3, snapped: 1 / 3 });
  });

  it("leaves a value further than 12px alone", () => {
    const pairPx = 900;
    const far = 1 / 3 + 20 / pairPx;
    expect(snapSplitRatio(far, pairPx, 12)).toEqual({ value: far, snapped: null });
  });

  it("does not snap when the pair has no width", () => {
    expect(snapSplitRatio(0.5, 0, 12)).toEqual({ value: 0.5, snapped: null });
  });
});

describe("stepSplitPreset", () => {
  it("steps up and down through the presets", () => {
    expect(stepSplitPreset(0.2, 1)).toBe(SPLIT_PRESETS[0]);
    expect(stepSplitPreset(0.5, 1)).toBeCloseTo(2 / 3, 6);
    expect(stepSplitPreset(0.5, -1)).toBeCloseTo(1 / 3, 6);
  });

  it("stays put at either end", () => {
    expect(stepSplitPreset(1 / 3, -1)).toBeCloseTo(1 / 3, 6);
    expect(stepSplitPreset(2 / 3, 1)).toBeCloseTo(2 / 3, 6);
  });
});

describe("labels", () => {
  it("names a preset as a fraction and anything else as a percentage", () => {
    expect(splitFractionLabel(1 / 3, 1 / 3)).toBe("⅓");
    expect(splitFractionLabel(0.42, null)).toBe("42%");
  });

  it("recognises the presets", () => {
    expect(presetOf(1 / 2)).toBe(0.5);
    expect(presetOf(0.42)).toBeNull();
  });
});
