import { describe, expect, it, vi } from "vite-plus/test";

import { cn } from "./utils";

const mergeConfigs = vi.hoisted(() => [] as unknown[]);
vi.mock(import("tailwind-merge"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    extendTailwindMerge: ((...args: Parameters<typeof actual.extendTailwindMerge>) => {
      mergeConfigs.push(args[0]);
      return actual.extendTailwindMerge(...args);
    }) as typeof actual.extendTailwindMerge,
  };
});

describe("cn", () => {
  it("keeps a background color next to a composer seam background image", () => {
    expect(cn("dark:before:bg-transparent dark:before:bg-composer-seam-below")).toBe(
      "dark:before:bg-transparent dark:before:bg-composer-seam-below",
    );
  });

  it("caches more class lists than one thread view merges", () => {
    // The default of 500 thrashed at boot; see TAILWIND_MERGE_CACHE_SIZE.
    const [config] = mergeConfigs as Array<{ readonly cacheSize?: number }>;
    expect(config?.cacheSize ?? 500).toBeGreaterThanOrEqual(2000);
  });
});
