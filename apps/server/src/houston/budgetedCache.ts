import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as MutableHashMap from "effect/MutableHashMap";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";

export interface BudgetedCacheOptions<K, V> {
  /** Estimated bytes an entry keeps reachable, key included. */
  readonly bytes: (key: K, value: V) => number;
  readonly maxBytes: number;
  readonly maxEntries: number;
  /** An entry unused for this long is dropped by the next sweep. */
  readonly idleMs: number;
}

/** A cache bounded by estimated retained bytes and entry count; keys compare by `Equal`. */
// A full cache admits nothing new, so repeated in-order scans keep hitting what it holds.
export const makeBudgetedCache = Effect.fn("makeBudgetedCache")(function* <K, V>(
  options: BudgetedCacheOptions<K, V>,
) {
  const clock = yield* Clock.Clock;
  const entries = MutableHashMap.empty<K, Entry<V>>();
  let retainedBytes = 0;
  const sweep = Effect.sync(() => {
    const now = clock.currentTimeMillisUnsafe();
    // Collected first: removing while iterating a hash bucket can skip its neighbour.
    const idle = [...entries].filter(([, entry]) => now - entry.usedAt >= options.idleMs);
    for (const [key, entry] of idle) {
      MutableHashMap.remove(entries, key);
      retainedBytes -= entry.bytes;
    }
  });
  // Expiry is enforced on a timer, not on access, so an idle server releases what it held.
  yield* sweep.pipe(Effect.repeat(Schedule.spaced(options.idleMs / 2)), Effect.forkScoped);
  return {
    get: (key: K, lookup: () => V) =>
      Effect.sync(() => {
        const now = clock.currentTimeMillisUnsafe();
        const cached = MutableHashMap.get(entries, key);
        if (Option.isSome(cached)) {
          cached.value.usedAt = now;
          return cached.value.value;
        }
        const value = lookup();
        const bytes = options.bytes(key, value);
        if (
          retainedBytes + bytes > options.maxBytes ||
          MutableHashMap.size(entries) >= options.maxEntries
        ) {
          return value;
        }
        MutableHashMap.set(entries, key, { value, bytes, usedAt: now });
        retainedBytes += bytes;
        return value;
      }),
    retainedBytes: () => retainedBytes,
  };
});

interface Entry<V> {
  readonly value: V;
  readonly bytes: number;
  usedAt: number;
}
