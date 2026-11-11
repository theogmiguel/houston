import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";

import { makeFindTextCache, TextKey } from "../orchestration-v2/ThreadFind.ts";

const key = (digest: string, cwd?: string) => new TextKey({ digest, cwd, skills: [] });

/** A parser that records each parse and returns `length` characters of rendered text. */
const counting = () => {
  const parsed: string[] = [];
  return {
    parsed,
    parse: (digest: string, length: number) => () => {
      parsed.push(digest);
      return [`${digest}:`.padEnd(length, "x")];
    },
  };
};

const BUDGET_BYTES = 64 * 1024 * 1024;

describe("find text cache", () => {
  it.effect("a scan larger than the budget keeps what fit and reparses only the rest", () =>
    Effect.gen(function* () {
      const { parsed, parse } = counting();
      const cache = yield* makeFindTextCache();
      // ~60 KB estimated per entry: 2,000 of them are well past the budget and the entry ceiling
      // the cache had before it was bounded by bytes.
      const scan = Effect.forEach(
        Array.from({ length: 2_000 }, (_, index) => index),
        (index) => cache.get(key(`m${index}`), parse(`m${index}`, 30_000)),
        { discard: true },
      );
      yield* scan;
      assert.isAtMost(cache.retainedBytes(), BUDGET_BYTES);
      parsed.length = 0;
      yield* scan;
      assert.isAbove(parsed.length, 0);
      assert.isBelow(parsed.length, 1_000);
      assert.strictEqual(parsed[0], `m${2_000 - parsed.length}`);
    }),
  );

  it.effect("an idle cache releases everything it held", () =>
    Effect.gen(function* () {
      const { parsed, parse } = counting();
      const cache = yield* makeFindTextCache();
      yield* cache.get(key("m0"), parse("m0", 30_000));
      assert.isAbove(cache.retainedBytes(), 0);
      yield* TestClock.adjust("91 seconds");
      assert.strictEqual(cache.retainedBytes(), 0);
      yield* cache.get(key("m0"), parse("m0", 30_000));
      assert.deepStrictEqual(parsed, ["m0", "m0"]);
    }),
  );

  it.effect("an entry in use outlives the idle window", () =>
    Effect.gen(function* () {
      const { parsed, parse } = counting();
      const cache = yield* makeFindTextCache();
      yield* cache.get(key("m0"), parse("m0", 100));
      yield* TestClock.adjust("50 seconds");
      yield* cache.get(key("m0"), parse("m0", 100));
      yield* TestClock.adjust("50 seconds");
      yield* cache.get(key("m0"), parse("m0", 100));
      assert.deepStrictEqual(parsed, ["m0"]);
    }),
  );

  it.effect("rendered text counts toward the budget", () =>
    Effect.gen(function* () {
      const { parsed, parse } = counting();
      const cache = yield* makeFindTextCache();
      // ~2 MB estimated per entry, so 40 of them cannot all fit.
      for (let index = 0; index < 40; index++) {
        yield* cache.get(key(`m${index}`), parse(`m${index}`, 1_000_000));
      }
      parsed.length = 0;
      yield* cache.get(key("m39"), parse("m39", 1_000_000));
      assert.deepStrictEqual(parsed, ["m39"]);
    }),
  );

  it.effect("equal keys share a parse and a different display context does not", () =>
    Effect.gen(function* () {
      const { parsed, parse } = counting();
      const cache = yield* makeFindTextCache();
      yield* cache.get(key("same"), parse("same", 10));
      yield* cache.get(key("same"), parse("same", 10));
      yield* cache.get(key("same", "/repo"), parse("same", 10));
      assert.strictEqual(parsed.length, 2);
    }),
  );
});
