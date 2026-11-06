import type { RunResults } from "./run.ts";
import { holm, mannWhitneyU, medianRatioCi, quantile } from "./stats.ts";

export type Verdict = "faster" | "slower" | "unchanged";

export interface Delta {
  readonly query: string;
  readonly scale: number;
  readonly beforeP50: number;
  readonly afterP50: number;
  readonly beforeP95: number;
  readonly afterP95: number;
  /** After over before, medians; below 1 is faster. */
  readonly ratio: number;
  readonly ratioCi: readonly [number, number];
  readonly p: number;
  /** Holm-adjusted across every compared query and scale. */
  readonly pAdjusted: number;
  readonly verdict: Verdict;
  readonly failingBefore: boolean;
  readonly failingAfter: boolean;
}

export interface Comparison {
  readonly before: { readonly label: string; readonly gitSha: string; readonly startedAt: string };
  readonly after: { readonly label: string; readonly gitSha: string; readonly startedAt: string };
  readonly alpha: number;
  readonly deltas: ReadonlyArray<Delta>;
}

const median = (values: ReadonlyArray<number>) =>
  quantile(
    [...values].sort((a, b) => a - b),
    0.5,
  );
const p95 = (values: ReadonlyArray<number>) =>
  quantile(
    [...values].sort((a, b) => a - b),
    0.95,
  );

/** Median ratio with a bootstrap 95% CI and a Mann-Whitney U test per shared query and scale. */
export function compareResults(before: RunResults, after: RunResults, alpha = 0.05): Comparison {
  const raw: Array<Omit<Delta, "pAdjusted" | "verdict">> = [];
  for (const query of before.queries) {
    const counterpart = after.queries.find((q) => q.name === query.name);
    if (counterpart === undefined) continue;
    for (const scale of query.scales) {
      const other = counterpart.scales.find((s) => s.scale === scale.scale);
      if (other === undefined || scale.samples.length < 2 || other.samples.length < 2) continue;
      raw.push({
        query: query.name,
        scale: scale.scale,
        beforeP50: median(scale.samples),
        afterP50: median(other.samples),
        beforeP95: p95(scale.samples),
        afterP95: p95(other.samples),
        ratio: median(other.samples) / median(scale.samples),
        ratioCi: medianRatioCi(scale.samples, other.samples),
        p: mannWhitneyU(scale.samples, other.samples).p,
        failingBefore: query.failing.some((f) => f.scale === scale.scale),
        failingAfter: counterpart.failing.some((f) => f.scale === scale.scale),
      });
    }
  }
  const adjusted = holm(raw.map((d) => d.p));
  return {
    before: { label: before.label, gitSha: before.gitSha, startedAt: before.startedAt },
    after: { label: after.label, gitSha: after.gitSha, startedAt: after.startedAt },
    alpha,
    deltas: raw.map((d, i) => {
      const pAdjusted = adjusted[i]!;
      const significant = pAdjusted < alpha;
      const verdict: Verdict =
        significant && d.ratioCi[1] < 1
          ? "faster"
          : significant && d.ratioCi[0] > 1
            ? "slower"
            : "unchanged";
      return { ...d, pAdjusted, verdict };
    }),
  };
}

export function formatComparison(comparison: Comparison): string {
  const lines = [
    `before: ${comparison.before.label} (${comparison.before.gitSha.slice(0, 10)})  after: ${comparison.after.label} (${comparison.after.gitSha.slice(0, 10)})`,
    `${"query".padEnd(32)} ${"scale".padStart(5)} ${"p50 before".padStart(11)} ${"p50 after".padStart(10)} ${"ratio".padStart(6)} ${"95% CI".padStart(15)} ${"p (Holm)".padStart(9)}  verdict`,
  ];
  for (const d of comparison.deltas) {
    lines.push(
      `${d.query.padEnd(32)} ${`${d.scale}x`.padStart(5)} ${d.beforeP50.toFixed(2).padStart(11)} ${d.afterP50.toFixed(2).padStart(10)} ${d.ratio.toFixed(2).padStart(6)} ${`[${d.ratioCi[0].toFixed(2)}, ${d.ratioCi[1].toFixed(2)}]`.padStart(15)} ${d.pAdjusted.toExponential(1).padStart(9)}  ${d.verdict}${d.failingBefore && !d.failingAfter ? " (no longer failing)" : ""}${!d.failingBefore && d.failingAfter ? " (now failing)" : ""}`,
    );
  }
  return lines.join("\n");
}
