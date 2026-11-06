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

  // The default action list is about 436px tall, so these windows leave it taller than its panel.
  it.each([420, 480, 560])(
    "ends the list under a whole row in a %ipx-tall window",
    async (height) => {
      useCommandPaletteStore.setState(useCommandPaletteStore.getInitialState(), true);
      await page.viewport(800, height);
      await using _screen = await render(<CommandPalette>{null}</CommandPalette>);

      openCommandPalette({});
      await expect
        .element(page.getByPlaceholder("Search commands, projects, and threads..."))
        .toBeVisible();

      await expect
        .poll(() => {
          const scroller = document.querySelector<HTMLElement>(
            '[data-slot="command-list"] .virtualized-scroll-fade',
          );
          if (!scroller) return "no list";
          const listBox = scroller.getBoundingClientRect();
          let rowParent: Element = scroller;
          while (
            rowParent.children.length === 1 &&
            rowParent.firstElementChild?.firstElementChild
          ) {
            rowParent = rowParent.firstElementChild;
          }
          const rows = Array.from(rowParent.children).filter(
            (row): row is HTMLElement => row instanceof HTMLElement && row.offsetHeight > 0,
          );
          const visible = rows.filter(
            (row) => row.getBoundingClientRect().top < listBox.bottom - 1,
          );
          const last = visible.at(-1)?.getBoundingClientRect();
          if (!last) return "no rows";
          const overflowing = scroller.scrollHeight - scroller.clientHeight > 1;
          return {
            cutPx: Math.max(0, Math.round(last.bottom - listBox.bottom)),
            overflowing,
          };
        })
        .toEqual({ cutPx: 0, overflowing: true });
    },
  );
  it("cuts no row and overflows nothing at 1440x900", async () => {
    useCommandPaletteStore.setState(useCommandPaletteStore.getInitialState(), true);
    await page.viewport(1440, 900);
    await using _screen = await render(<CommandPalette>{null}</CommandPalette>);

    openCommandPalette({});
    await expect
      .element(page.getByPlaceholder("Search commands, projects, and threads..."))
      .toBeVisible();

    await expect
      .poll(() => {
        const popup = document.querySelector<HTMLElement>('[data-slot="command-dialog-popup"]');
        const scroller = document.querySelector<HTMLElement>('[data-slot="command-list"] > div');
        if (!popup || !scroller) return "no list";
        const popupBox = popup.getBoundingClientRect();
        const listBox = scroller.getBoundingClientRect();
        let rowParent: Element = scroller;
        while (rowParent.children.length === 1 && rowParent.firstElementChild?.firstElementChild) {
          rowParent = rowParent.firstElementChild;
        }
        const rows = Array.from(rowParent.children).filter(
          (row): row is HTMLElement => row instanceof HTMLElement && row.offsetHeight > 0,
        );
        const visible = rows.filter((row) => row.getBoundingClientRect().top < listBox.bottom - 1);
        const last = visible.at(-1)?.getBoundingClientRect();
        if (!last) return "no rows";
        return {
          overflowing: scroller.scrollHeight - scroller.clientHeight > 1,
          cutPx: Math.max(0, Math.round(last.bottom - listBox.bottom)),
          listOverflowsDialogPx: Math.max(0, Math.round(listBox.bottom - popupBox.bottom)),
        };
      })
      .toEqual({ overflowing: true, cutPx: 0, listOverflowsDialogPx: 0 });
  });
});
