import { describe, expect, it } from "vite-plus/test";

import { compareResults, formatComparison } from "./compare.ts";
import { makeRandom } from "./random.ts";
import { judge, type QueryResult, type RunResults } from "./run.ts";
import { summarize } from "./stats.ts";

const random = makeRandom(3);
const noisy = (center: number, n = 40) =>
  Array.from({ length: n }, () => center * (1 + 0.05 * random.normal()));

function query(
  name: string,
  samplesByScale: ReadonlyArray<readonly [number, ReadonlyArray<number>]>,
  budgetMs = 16,
): QueryResult {
  return judge({
    name,
    path: "interactive",
    calls: name,
    grows: "breadth",
    budgetMs,
    scales: samplesByScale.map(([scale, samples]) => ({
      scale,
      size: scale * 1_000,
      samples,
      summary: summarize(samples),
      statements: [],
    })),
  });
}

function results(label: string, queries: ReadonlyArray<QueryResult>): RunResults {
  return {
    version: 1,
    label,
    startedAt: "2026-11-06T00:00:00.000Z",
    gitSha: `${label}-sha`,
    machine: { cpu: "test", cpus: 1, memoryGb: 1, platform: "test", node: "v0" },
    budgets: { boot: 100, interactive: 16, search: 100, turn: 50, stream: 8, maintenance: 250 },
    databases: [],
    queries,
  };
}

describe("db-load comparison", () => {
  it("reports a halved query as faster and an untouched one as unchanged", () => {
    const before = results("before", [
      query("fixed", [[10, noisy(20)]]),
      query("same", [[10, noisy(5)]]),
    ]);
    const after = results("after", [
      query("fixed", [[10, noisy(10)]]),
      query("same", [[10, noisy(5)]]),
    ]);
    const comparison = compareResults(before, after);
    const fixed = comparison.deltas.find((d) => d.query === "fixed")!;
    const same = comparison.deltas.find((d) => d.query === "same")!;
    expect(fixed.verdict).toBe("faster");
    expect(fixed.ratio).toBeGreaterThan(0.4);
    expect(fixed.ratio).toBeLessThan(0.6);
    expect(fixed.ratioCi[1]).toBeLessThan(1);
    expect(fixed.failingBefore).toBe(true);
    expect(fixed.failingAfter).toBe(false);
    expect(same.verdict).toBe("unchanged");
    expect(formatComparison(comparison)).toContain("no longer failing");
  });

  it("reports a regression as slower", () => {
    const comparison = compareResults(
      results("before", [query("regressed", [[1, noisy(2)]])]),
      results("after", [query("regressed", [[1, noisy(3)]])]),
    );
    expect(comparison.deltas[0]!.verdict).toBe("slower");
  });

  it("skips queries and scales missing from either run", () => {
    const comparison = compareResults(
      results("before", [
        query("a", [
          [1, noisy(2)],
          [10, noisy(4)],
        ]),
        query("gone", [[1, noisy(1)]]),
      ]),
      results("after", [query("a", [[1, noisy(2)]])]),
    );
    expect(comparison.deltas.map((d) => `${d.query}@${d.scale}`)).toEqual(["a@1"]);
  });

  it("flags budget breaches per scale and fits the scaling exponent", () => {
    const judged = query("linear", [
      [1, noisy(2)],
      [10, noisy(20)],
      [100, noisy(200)],
    ]);
    expect(judged.fitP50!.exponent).toBeGreaterThan(0.95);
    expect(judged.fitP50!.exponent).toBeLessThan(1.05);
    expect(judged.failing.map((f) => f.scale)).toEqual([10, 100]);
    expect(judged.projectedP95At1000).toBeGreaterThan(1_500);
  });
});
