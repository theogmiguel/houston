import { expect } from "vite-plus/test";

const LEFT_ALIGNED = /^(left|start)$/;

/** The shared phone sheet recipe: scrim, rounded top corners, a left title on the 16px inset, a centred 44px close. */
export function expectSheetRecipe(sheet: HTMLElement, width: number) {
  const header = sheet.querySelector<HTMLElement>("[data-phone-sheet-header]");
  expect(header, "sheet header").not.toBeNull();
  const title = header!.querySelector<HTMLElement>('[data-slot="sheet-title"]')!;
  const close = header!.querySelector<HTMLElement>('[aria-label="Close"]')!;
  const sheetRect = sheet.getBoundingClientRect();
  const titleRect = title.getBoundingClientRect();
  const closeRect = close.getBoundingClientRect();
  expect(sheetRect.left).toBeCloseTo(0, 0);
  expect(sheetRect.right).toBeCloseTo(width, 0);
  expect(titleRect.left - sheetRect.left).toBeCloseTo(16, 0);
  expect(getComputedStyle(title).textAlign).toMatch(LEFT_ALIGNED);
  expect(getComputedStyle(title).fontSize).toBe("16px");
  expect(title.scrollWidth, "title stays on one line").toBeLessThanOrEqual(title.clientWidth + 1);
  expect(titleRect.height).toBeLessThan(24);
  expect(closeRect.height).toBeGreaterThanOrEqual(44);
  expect(closeRect.width).toBeGreaterThanOrEqual(44);
  expect(closeRect.top + closeRect.height / 2).toBeCloseTo(titleRect.top + titleRect.height / 2, 0);
  expect(closeRect.right).toBeLessThanOrEqual(width + 0.5);
  expect(parseFloat(getComputedStyle(sheet).borderTopLeftRadius)).toBeGreaterThan(0);
  expect(document.querySelector('[data-slot="sheet-backdrop"]'), "scrim").not.toBeNull();
}

/** Every row spans the sheet edge to edge, is a 44px target and starts its content on the 16px gutter. */
export function expectFullWidthRows(
  sheet: HTMLElement,
  rows: ReadonlyArray<HTMLElement>,
  width: number,
) {
  const sheetRect = sheet.getBoundingClientRect();
  expect(rows.length).toBeGreaterThan(0);
  for (const row of rows) {
    const rect = row.getBoundingClientRect();
    const name = row.textContent?.trim() ?? "row";
    expect(rect.left - sheetRect.left, name).toBeCloseTo(0, 0);
    expect(sheetRect.right - rect.right, name).toBeCloseTo(0, 0);
    expect(rect.height, name).toBeGreaterThanOrEqual(43.5);
    expect(rect.right, name).toBeLessThanOrEqual(width + 0.5);
  }
}

/** The left edge of the first text node in `root` that contains `text`. */
export function textLeft(root: HTMLElement, text: string): number {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.textContent?.includes(text)) {
      const range = document.createRange();
      range.selectNodeContents(node);
      return range.getBoundingClientRect().left;
    }
  }
  throw new Error(`no text "${text}" in ${root.tagName.toLowerCase()}`);
}
