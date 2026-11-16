import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as MutableHashMap from "effect/MutableHashMap";
import * as Option from "effect/Option";

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
  const scope = yield* Effect.scope;
  const sweep = () => {
    const now = clock.currentTimeMillisUnsafe();
    // Collected first: removing while iterating a hash bucket can skip its neighbour.
    const idle = [...entries].filter(([, entry]) => now - entry.usedAt >= options.idleMs);
    for (const [key, entry] of idle) {
      MutableHashMap.remove(entries, key);
      retainedBytes -= entry.bytes;
    }
  };
  // Expiry runs on a timer, not on access, so an idle server releases what it held. The timer
  // exists only while entries do, and waits one interval at a time, so a clock jump sweeps once.
  let sweeping = false;
  const sweepWhileHolding = Effect.gen(function* () {
    while (MutableHashMap.size(entries) > 0) {
      yield* Effect.sleep(options.idleMs / 2);
      sweep();
    }
    sweeping = false;
  });
  return {
    get: (key: K, lookup: () => V) =>
      Effect.suspend(() => {
        const now = clock.currentTimeMillisUnsafe();
        const cached = MutableHashMap.get(entries, key);
        if (Option.isSome(cached)) {
          cached.value.usedAt = now;
          return Effect.succeed(cached.value.value);
        }
        const value = lookup();
        const bytes = options.bytes(key, value);
        if (
          retainedBytes + bytes > options.maxBytes ||
          MutableHashMap.size(entries) >= options.maxEntries
        ) {
          return Effect.succeed(value);
        }
        MutableHashMap.set(entries, key, { value, bytes, usedAt: now });
        retainedBytes += bytes;
        if (sweeping) return Effect.succeed(value);
        sweeping = true;
        return Effect.as(Effect.forkIn(sweepWhileHolding, scope), value);
      }),
    retainedBytes: () => retainedBytes,
  };
});

interface Entry<V> {
  readonly value: V;
  readonly bytes: number;
  usedAt: number;
}
