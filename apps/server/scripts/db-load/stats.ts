import { makeRandom, type Random } from "./random.ts";

/** Linear-interpolated quantile (R type 7) of an ascending array. */
export function quantile(sorted: ReadonlyArray<number>, q: number): number {
  if (sorted.length === 0) return Number.NaN;
  const position = (sorted.length - 1) * q;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  const low = sorted[lower]!;
  return low + (sorted[upper]! - low) * (position - lower);
}

const ascending = (values: ReadonlyArray<number>) => [...values].sort((a, b) => a - b);

export interface Summary {
  readonly n: number;
  readonly min: number;
  readonly max: number;
  readonly mean: number;
  readonly p50: number;
  readonly p95: number;
  readonly p50Ci: readonly [number, number];
  readonly p95Ci: readonly [number, number];
}

/** Percentile bootstrap confidence interval of `statistic`. */
export function bootstrapCi(
  samples: ReadonlyArray<number>,
  statistic: (sorted: ReadonlyArray<number>) => number,
  options: {
    readonly resamples?: number;
    readonly confidence?: number;
    readonly random?: Random;
  } = {},
): readonly [number, number] {
  const resamples = options.resamples ?? 2_000;
  const confidence = options.confidence ?? 0.95;
  const random = options.random ?? makeRandom(0xb007);
  if (samples.length === 0) return [Number.NaN, Number.NaN];
  const estimates = new Float64Array(resamples);
  const draw = new Array<number>(samples.length);
  for (let r = 0; r < resamples; r++) {
    for (let i = 0; i < samples.length; i++)
      draw[i] = samples[Math.floor(random.next() * samples.length)]!;
    draw.sort((a, b) => a - b);
    estimates[r] = statistic(draw);
  }
  estimates.sort();
  const tail = (1 - confidence) / 2;
  return [quantile(Array.from(estimates), tail), quantile(Array.from(estimates), 1 - tail)];
}

export function summarize(samples: ReadonlyArray<number>): Summary {
  const sorted = ascending(samples);
  return {
    n: sorted.length,
    min: sorted[0] ?? Number.NaN,
    max: sorted.at(-1) ?? Number.NaN,
    mean: sorted.reduce((total, value) => total + value, 0) / Math.max(1, sorted.length),
    p50: quantile(sorted, 0.5),
    p95: quantile(sorted, 0.95),
    p50Ci: bootstrapCi(sorted, (s) => quantile(s, 0.5)),
    p95Ci: bootstrapCi(sorted, (s) => quantile(s, 0.95)),
  };
}

function normalCdf(z: number): number {
  // Abramowitz and Stegun 7.1.26; absolute error below 1.5e-7.
  const t = 1 / (1 + (0.3275911 * Math.abs(z)) / Math.SQRT2);
  const erf =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-(z * z) / 2);
  return z >= 0 ? (1 + erf) / 2 : (1 - erf) / 2;
}

export interface MannWhitney {
  readonly u: number;
  readonly z: number;
  readonly p: number;
  /** Probability that a draw from `b` is larger than one from `a` (0.5 = no shift). */
  readonly commonLanguageEffect: number;
}

/** Two-sided Mann-Whitney U test, normal approximation with tie and continuity corrections. */
export function mannWhitneyU(a: ReadonlyArray<number>, b: ReadonlyArray<number>): MannWhitney {
  const n1 = a.length;
  const n2 = b.length;
  const all = [
    ...a.map((value) => ({ value, group: 0 })),
    ...b.map((value) => ({ value, group: 1 })),
  ].sort((x, y) => x.value - y.value);
  const ranks = new Array<number>(all.length);
  let tieTerm = 0;
  for (let i = 0; i < all.length;) {
    let j = i;
    while (j + 1 < all.length && all[j + 1]!.value === all[i]!.value) j++;
    const rank = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) ranks[k] = rank;
    const ties = j - i + 1;
    tieTerm += ties ** 3 - ties;
    i = j + 1;
  }
  let rankSumA = 0;
  for (let i = 0; i < all.length; i++) if (all[i]!.group === 0) rankSumA += ranks[i]!;
  const uA = rankSumA - (n1 * (n1 + 1)) / 2;
  const uB = n1 * n2 - uA;
  const mean = (n1 * n2) / 2;
  const n = n1 + n2;
  const variance = ((n1 * n2) / 12) * (n + 1 - tieTerm / (n * (n - 1)));
  if (n1 === 0 || n2 === 0 || variance <= 0)
    return { u: uA, z: 0, p: 1, commonLanguageEffect: 0.5 };
  const z = (Math.abs(uA - mean) - 0.5) / Math.sqrt(variance);
  return {
    u: Math.min(uA, uB),
    z: Math.max(0, z),
    p: Math.min(1, 2 * (1 - normalCdf(Math.max(0, z)))),
    commonLanguageEffect: uB / (n1 * n2),
  };
}

/** Bootstrap CI of the ratio of medians, b over a. */
export function medianRatioCi(
  a: ReadonlyArray<number>,
  b: ReadonlyArray<number>,
  options: { readonly resamples?: number; readonly random?: Random } = {},
): readonly [number, number] {
  const resamples = options.resamples ?? 2_000;
  const random = options.random ?? makeRandom(0xd1ff);
  const ratios: Array<number> = [];
  const pick = (values: ReadonlyArray<number>) => {
    const draw = new Array<number>(values.length);
    for (let i = 0; i < values.length; i++)
      draw[i] = values[Math.floor(random.next() * values.length)]!;
    return quantile(ascending(draw), 0.5);
  };
  for (let r = 0; r < resamples; r++) ratios.push(pick(b) / pick(a));
  const sorted = ascending(ratios);
  return [quantile(sorted, 0.025), quantile(sorted, 0.975)];
}

/** Holm-Bonferroni adjusted p-values, in input order. */
export function holm(pValues: ReadonlyArray<number>): Array<number> {
  const order = pValues.map((p, index) => ({ p, index })).sort((x, y) => x.p - y.p);
  const adjusted = new Array<number>(pValues.length);
  let running = 0;
  order.forEach(({ p, index }, rank) => {
    running = Math.max(running, Math.min(1, (pValues.length - rank) * p));
    adjusted[index] = running;
  });
  return adjusted;
}

export interface PowerLawFit {
  /** Exponent b of time = a * size^b: about 0 is constant, 1 linear, 2 quadratic. */
  readonly exponent: number;
  readonly coefficient: number;
  readonly r2: number;
}

/** Least squares on log-log points; undefined with fewer than two distinct sizes. */
export function fitPowerLaw(
  sizes: ReadonlyArray<number>,
  times: ReadonlyArray<number>,
): PowerLawFit | undefined {
  const points = sizes
    .map((size, i) => [Math.log(size), Math.log(Math.max(times[i]!, 1e-6))] as const)
    .filter(([x, y]) => Number.isFinite(x) && Number.isFinite(y));
  if (new Set(points.map(([x]) => x)).size < 2) return undefined;
  const n = points.length;
  const meanX = points.reduce((t, [x]) => t + x, 0) / n;
  const meanY = points.reduce((t, [, y]) => t + y, 0) / n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (const [x, y] of points) {
    sxy += (x - meanX) * (y - meanY);
    sxx += (x - meanX) ** 2;
    syy += (y - meanY) ** 2;
  }
  const exponent = sxy / sxx;
  return {
    exponent,
    coefficient: Math.exp(meanY - exponent * meanX),
    r2: syy === 0 ? 1 : (sxy * sxy) / (sxx * syy),
  };
}

/** Projects a fitted power law to another size. */
export function project(fit: PowerLawFit, size: number): number {
  return fit.coefficient * size ** fit.exponent;
}
