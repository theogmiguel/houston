import { describe, expect, it } from "vite-plus/test";

import { usageRetentionShortens } from "./usageRetention";

describe("usage retention changes", () => {
  it("asks for confirmation only when a selected machine would purge saved records", () => {
    expect(usageRetentionShortens([92], 30)).toBe(true);
    expect(usageRetentionShortens([92, 365], 180)).toBe(true);
    expect(usageRetentionShortens([null], 365)).toBe(false);
    expect(usageRetentionShortens([30], 92)).toBe(false);
    expect(usageRetentionShortens([30], null)).toBe(false);
    expect(usageRetentionShortens([], 1)).toBe(false);
  });
});
