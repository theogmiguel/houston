import { describe, expect, it } from "vite-plus/test";

import { FinishedTextCache } from "./finishedTextCache";

describe("FinishedTextCache", () => {
  it("evicts the oldest texts once their bytes exceed the bound", () => {
    // Three 20-character texts are 40 bytes each; 100 bytes hold two.
    const cache = new FinishedTextCache<number>(512, 100);
    const texts = ["a", "b", "c"].map((letter) => letter.repeat(20));
    texts.forEach((text, index) => cache.set(text, index));

    expect(cache.get(texts[0]!)).toBeUndefined();
    expect(cache.get(texts[1]!)).toBe(1);
    expect(cache.get(texts[2]!)).toBe(2);
  });

  it("keeps no text larger than the bound", () => {
    const cache = new FinishedTextCache<number>(512, 100);
    cache.set("x".repeat(51), 0);
    expect(cache.get("x".repeat(51))).toBeUndefined();
  });

  it("finds a text by value when the key was sliced from a larger one", () => {
    const cache = new FinishedTextCache<number>(512, 1_000);
    const message = `first block\n\n${"y".repeat(200)}`;
    cache.set(message.slice(0, 11), 7);
    expect(cache.get("first block")).toBe(7);
  });
});
