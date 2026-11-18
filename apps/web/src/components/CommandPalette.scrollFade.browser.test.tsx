import { describe, expect, it } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import "~/index.css";
import { render } from "../../test/render";
import { openCommandPalette } from "../commandPaletteBus";
import { useCommandPaletteStore } from "../commandPaletteStore";
import { CommandPalette } from "./CommandPaletteShell";
// The shell loads its body on demand; loading it here keeps a cold transform out of the polls.
import "./CommandPalette";

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
        // A section heading never ends the list: "Projects" scrolls under the fade instead.
        const lastVisibleIsHeading =
          visible.at(-1)?.querySelector('[data-slot="command-group-label"]') != null;
        return {
          overflowing: scroller.scrollHeight - scroller.clientHeight > 1,
          cutPx: Math.max(0, Math.round(last.bottom - listBox.bottom)),
          listOverflowsDialogPx: Math.max(0, Math.round(listBox.bottom - popupBox.bottom)),
          lastVisibleIsHeading,
        };
      })
      .toEqual({
        overflowing: true,
        cutPx: 0,
        listOverflowsDialogPx: 0,
        lastVisibleIsHeading: false,
      });
  });

  async function openPalette(height: number, query?: string) {
    useCommandPaletteStore.setState(useCommandPaletteStore.getInitialState(), true);
    await page.viewport(1440, height);
    const screen = await render(<CommandPalette>{null}</CommandPalette>);
    openCommandPalette(query === undefined ? {} : { query });
    await expect
      .element(page.getByPlaceholder("Search commands, projects, and threads..."))
      .toBeVisible();
    return screen;
  }

  const scroller = () =>
    [...document.querySelectorAll<HTMLElement>('[data-slot="command-list"] *')].find((node) =>
      ["auto", "scroll"].includes(getComputedStyle(node).overflowY),
    );

  /** The gap between the last rendered row's bottom and the footer's top. */
  function gapToFooter() {
    const footer = document.querySelector<HTMLElement>('[data-slot="command-footer"]')!;
    const rows = [...document.querySelectorAll<HTMLElement>('[data-slot="command-item"]')];
    const last = rows.filter((row) => row.getBoundingClientRect().bottom > 0).at(-1)!;
    return footer.getBoundingClientRect().top - last.getBoundingClientRect().bottom;
  }

  it("leaves the last row undimmed when the whole list fits", async () => {
    // The default action list is taller than the 420px dialog at any window height; a query
    // narrows it to a list that fits.
    await using _screen = await openPalette(1600, "settings");
    await expect.poll(() => scroller() !== undefined).toBe(true);
    const list = scroller()!;
    await expect.poll(() => list.scrollHeight - list.clientHeight).toBeLessThanOrEqual(1);
    expect(getComputedStyle(list).maskImage).toBe("none");
    expect(gapToFooter()).toBeGreaterThanOrEqual(8);
  });

  it("drops the bottom fade once the list is scrolled to its end, and keeps 8px above the footer", async () => {
    await using _screen = await openPalette(480);
    await expect.poll(() => scroller()?.scrollHeight ?? 0).toBeGreaterThan(0);
    const list = scroller()!;
    await expect.poll(() => getComputedStyle(list).maskImage).toContain("calc(100% - 32px)");
    list.scrollTop = list.scrollHeight;
    await expect.poll(() => getComputedStyle(list).maskImage).not.toContain("calc(100% - 32px)");
    expect(gapToFooter()).toBeGreaterThanOrEqual(8);
  });
});
