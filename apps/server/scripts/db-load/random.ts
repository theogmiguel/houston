// Seeded generator: the same seed builds the same database, so before and after runs compare
// like for like.
export interface Random {
  readonly next: () => number;
  readonly int: (min: number, max: number) => number;
  readonly pick: <T>(items: ReadonlyArray<T>) => T;
  readonly chance: (probability: number) => boolean;
  readonly normal: () => number;
  readonly logNormalLength: (mean: number, max: number, min?: number) => number;
  readonly hex: (length: number) => string;
  readonly shuffle: <T>(items: ReadonlyArray<T>) => Array<T>;
}

export function makeRandom(seed: number): Random {
  let state = seed >>> 0 || 0x9e3779b9;
  // mulberry32
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (min: number, max: number) => min + Math.floor(next() * (max - min + 1));
  const normal = () => {
    const u = Math.max(next(), Number.EPSILON);
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * next());
  };
  return {
    next,
    int,
    pick: (items) => items[Math.floor(next() * items.length)]!,
    chance: (probability) => next() < probability,
    normal,
    // Lognormal with sigma 1 and the requested mean, clipped: matches the long tail of real
    // payload sizes (most rows small, a few tens of kilobytes).
    logNormalLength: (mean, max, min = 1) => {
      const sigma = 1;
      const mu = Math.log(mean) - (sigma * sigma) / 2;
      return Math.max(min, Math.min(max, Math.round(Math.exp(mu + sigma * normal()))));
    },
    hex: (length) => {
      let out = "";
      while (out.length < length) out += Math.floor(next() * 16).toString(16);
      return out;
    },
    shuffle: (items) => {
      const out = [...items];
      for (let i = out.length - 1; i > 0; i--) {
        const j = Math.floor(next() * (i + 1));
        [out[i], out[j]] = [out[j]!, out[i]!];
      }
      return out;
    },
  };
}
