import { describe, expect, it, vi } from "vite-plus/test";

import "~/index.css";
import { render } from "../../../test/render";
import { TimelineMinimap } from "./TimelineMinimap";
import type { TimelineMinimapItem } from "./timelineMinimapItems";

// Counted below cn(): mocking ~/lib/utils itself would wait on its own import cycle.
const merges = vi.hoisted(() => ({ count: 0 }));
vi.mock(import("tailwind-merge"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    extendTailwindMerge: ((...args: Parameters<typeof actual.extendTailwindMerge>) => {
      const merge = actual.extendTailwindMerge(...args);
      return (...classLists: Parameters<typeof merge>) => {
        merges.count += 1;
        return merge(...classLists);
      };
    }) as typeof actual.extendTailwindMerge,
  };
});

const ITEMS: TimelineMinimapItem[] = Array.from({ length: 400 }, (_, index) => ({
  id: `turn-${index}`,
  rowIndex: index * 4,
  userText: `Question ${index}`,
  assistantText: `Answer ${index}`,
}));

function minimap(currentIndex: number | null = null) {
  return (
    <div style={{ position: "relative", height: "800px" }}>
      <TimelineMinimap
        hasPersistentGutter
        hitStripWidth={24}
        currentIndex={currentIndex}
        items={ITEMS}
        stripMap={new Map()}
        onWheel={() => {}}
        onSelect={() => {}}
      />
    </div>
  );
}

function strips(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>("[data-minimap-strip]")];
}

describe("TimelineMinimap", () => {
  it("merges no class lists per strip", async () => {
    merges.count = 0;
    await using screen = await render(minimap(), { router: false });

    expect(strips(screen.container)).toHaveLength(ITEMS.length);
    // A handful for the frame and the navigation buttons, none per strip.
    expect(merges.count).toBeLessThan(40);
  });

  it("draws the focused strip and its neighbours at their fisheye widths", async () => {
    await using screen = await render(minimap(), { router: false });
    screen.container
      .querySelector<HTMLButtonElement>('button[aria-label^="Jump to message"]')!
      .focus();

    await expect.poll(() => strips(screen.container)[0]!.className).toContain("scale-x-100");
    const [first, second, third, fourth] = strips(screen.container);
    expect(first!.className).toContain("bg-muted-foreground/60");
    expect(second!.className).toContain("scale-x-[0.667]");
    expect(third!.className).toContain("scale-x-[0.417]");
    expect(fourth!.className).toContain("scale-x-[0.333]");
    expect(fourth!.className).toContain("bg-muted-foreground/25");
    for (const strip of [first, second, third, fourth]) {
      expect(
        strip!.className.split(" ").filter((name) => name.startsWith("scale-x-")),
      ).toHaveLength(1);
    }
  });
});
