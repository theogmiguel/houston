import { describe, expect, it } from "vite-plus/test";

import { fitMetaItems } from "./sidebar-row-meta";

const item = (label: string, width: number, keep = false, dropsFirst = false) => ({
  label,
  width,
  keep,
  dropsFirst,
});

describe("fitMetaItems", () => {
  it("shows every item, with no counter, when they all fit with their gaps", () => {
    const fit = fitMetaItems([item("a", 40), item("b", 40), item("c", 40)], 40 * 3 + 8 * 2);
    expect(fit.hidden).toEqual([false, false, false]);
    expect(fit.labels).toEqual([]);
  });

  it("drops whole items from the right and reserves room for the counter", () => {
    // Three items need 136px; with 30px reserved for the counter, two fit in 130px.
    const fit = fitMetaItems([item("a", 40), item("b", 40), item("c", 40)], 130);
    expect(fit.hidden).toEqual([false, false, true]);
    expect(fit.labels).toEqual(["c"]);
  });

  it("names every dropped item in the order the line draws them", () => {
    const fit = fitMetaItems(
      [item("status", 50, true), item("pr", 40), item("diff", 40), item("tag", 30)],
      60,
    );
    expect(fit.hidden).toEqual([false, true, true, true]);
    expect(fit.labels).toEqual(["pr", "diff", "tag"]);
  });

  it("never drops a kept item, even when it alone is wider than the line", () => {
    const fit = fitMetaItems([item("status", 120, true), item("pr", 40)], 80);
    expect(fit.hidden).toEqual([false, true]);
  });

  it("keeps a kept item that follows other items by keeping everything before it", () => {
    const fit = fitMetaItems([item("a", 60), item("time", 60, true), item("b", 60)], 70);
    expect(fit.hidden).toEqual([false, false, true]);
  });

  it("shows nothing and counts nothing for an empty line", () => {
    expect(fitMetaItems([], 100)).toEqual({ hidden: [], labels: [] });
  });

  it("drops an item marked to go first before any item to its left, then the rest from the right", () => {
    const items = [item("branch", 56), item("people", 24, false, true), item("tag", 40)];
    // All three need 136px: dropping only "people" leaves 56 + 8 + 40 = 104px, plus the counter.
    expect(fitMetaItems(items, 136).hidden).toEqual([false, false, false]);
    const fit = fitMetaItems(items, 134);
    expect(fit.hidden).toEqual([false, true, false]);
    expect(fit.labels).toEqual(["people"]);
    // Still too narrow once "people" is gone: the remaining items drop from the right.
    const narrow = fitMetaItems(items, 90);
    expect(narrow.hidden).toEqual([false, true, true]);
    expect(narrow.labels).toEqual(["people", "tag"]);
  });
});
