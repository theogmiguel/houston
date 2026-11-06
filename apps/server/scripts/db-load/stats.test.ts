import { describe, expect, it } from "vite-plus/test";

import { makeRandom } from "./random.ts";
import {
  bootstrapCi,
  fitPowerLaw,
  holm,
  mannWhitneyU,
  medianRatioCi,
  project,
  quantile,
  summarize,
} from "./stats.ts";

describe("db-load statistics", () => {
  it("interpolates quantiles linearly between ranks", () => {
    expect(quantile([1, 2, 3, 4], 0.5)).toBe(2.5);
    expect(quantile([1, 2, 3, 4], 0.95)).toBeCloseTo(3.85, 10);
    expect(quantile([7], 0.95)).toBe(7);
    expect(Number.isNaN(quantile([], 0.5))).toBe(true);
  });

  it("matches the asymptotic Mann-Whitney U with continuity correction", () => {
    // Reference: scipy.stats.mannwhitneyu(a, b, method="asymptotic") gives U=0, p=0.01219.
    const result = mannWhitneyU([1, 2, 3, 4, 5], [6, 7, 8, 9, 10]);
    expect(result.u).toBe(0);
    expect(result.p).toBeCloseTo(0.01219, 4);
    expect(result.commonLanguageEffect).toBe(1);
  });

  it("finds no difference between identical samples, ties included", () => {
    const result = mannWhitneyU([1, 1, 2, 2, 3], [1, 1, 2, 2, 3]);
    expect(result.p).toBeCloseTo(1, 6);
    expect(result.commonLanguageEffect).toBe(0.5);
  });

  it("brackets the true median with the bootstrap interval and collapses on constants", () => {
    const random = makeRandom(7);
    const samples = Array.from({ length: 200 }, () => 10 + random.normal());
    const [low, high] = bootstrapCi(samples, (s) => quantile(s, 0.5));
    expect(low).toBeLessThan(10.25);
    expect(high).toBeGreaterThan(9.75);
    expect(high - low).toBeLessThan(0.6);
    expect(bootstrapCi([4, 4, 4], (s) => quantile(s, 0.5))).toEqual([4, 4]);
  });

  it("summarizes samples with percentile intervals that contain the estimate", () => {
    const summary = summarize([5, 1, 4, 2, 3, 6, 9, 8, 7, 10]);
    expect(summary.n).toBe(10);
    expect(summary.p50).toBe(5.5);
    expect(summary.p50Ci[0]).toBeLessThanOrEqual(summary.p50);
    expect(summary.p50Ci[1]).toBeGreaterThanOrEqual(summary.p50);
    expect(summary.mean).toBe(5.5);
  });

  it("estimates a halved median with a ratio interval around one half", () => {
    const random = makeRandom(11);
    const before = Array.from({ length: 60 }, () => 20 + random.normal());
    const after = before.map((value) => value / 2);
    const [low, high] = medianRatioCi(before, after);
    expect(low).toBeLessThan(0.5);
    expect(high).toBeGreaterThan(0.5);
    expect(high).toBeLessThan(0.55);
  });

  it("adjusts p-values with Holm's step-down method", () => {
    const adjusted = holm([0.01, 0.04, 0.03]);
    expect(adjusted[0]).toBeCloseTo(0.03, 10);
    expect(adjusted[1]).toBeCloseTo(0.06, 10);
    expect(adjusted[2]).toBeCloseTo(0.06, 10);
  });

  it("fits scaling exponents on log-log axes and projects them", () => {
    const linear = fitPowerLaw([1, 10, 100], [2, 20, 200])!;
    expect(linear.exponent).toBeCloseTo(1, 10);
    expect(linear.coefficient).toBeCloseTo(2, 10);
    expect(linear.r2).toBeCloseTo(1, 10);
    expect(project(linear, 1000)).toBeCloseTo(2000, 6);
    expect(fitPowerLaw([1, 10, 100], [1, 100, 10_000])!.exponent).toBeCloseTo(2, 10);
    expect(fitPowerLaw([1, 10, 100], [3, 3, 3])!.exponent).toBeCloseTo(0, 10);
    expect(fitPowerLaw([10, 10], [1, 2])).toBeUndefined();
  });
});
