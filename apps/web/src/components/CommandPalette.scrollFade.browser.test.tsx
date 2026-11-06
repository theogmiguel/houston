import { describe, expect, it } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import "~/index.css";
import { render } from "../../test/render";
import { openCommandPalette } from "../commandPaletteBus";
import { useCommandPaletteStore } from "../commandPaletteStore";
import { CommandPalette } from "./CommandPalette";

describe("CommandPalette list edge", () => {
  it("fades the bottom edge of an overflowing list so no row is cut mid-glyph", async () => {
    useCommandPaletteStore.setState(useCommandPaletteStore.getInitialState(), true);
    // Short enough that the default action list overflows its panel.
    await page.viewport(800, 480);
    await using _screen = await render(<CommandPalette>{null}</CommandPalette>);

    openCommandPalette({});
    await expect
      .element(page.getByPlaceholder("Search commands, projects, and threads..."))
      .toBeVisible();

    const scrim = document.querySelector<HTMLElement>('[data-slot="command-dialog-backdrop"]');
    // 60% black or more, so the thread-details card behind the palette is visibly dimmed.
    expect(
      Number(getComputedStyle(scrim!).backgroundColor.match(/[\d.]+(?=\))/)?.[0]),
    ).toBeGreaterThanOrEqual(0.6);

    await expect
      .poll(() => {
        const list = document.querySelector('[data-slot="command-list"]');
        const scroller = list?.querySelector<HTMLElement>(".virtualized-scroll-fade");
        const overflows = list
          ? Array.from(list.querySelectorAll<HTMLElement>("*")).some(
              (node) =>
                node.scrollHeight - node.clientHeight > 1 &&
                getComputedStyle(node).overflowY !== "visible",
            )
          : false;
        const mask =
          scroller === null || scroller === undefined ? "" : getComputedStyle(scroller).maskImage;
        // The fade is at least one 32px row tall, so the last row never ends on crisp glyphs.
        return { overflows, faded: mask.includes("calc(100% - 32px)") };
      })
      .toEqual({ overflows: true, faded: true });
  });
});
