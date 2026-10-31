import { describe, expect, it } from "vite-plus/test";

import {
  resolveContextStripLabelsCompact,
  resolveContextStripLabelsNarrow,
} from "./BranchToolbar.logic";
import { resolveRestingComposerControlsLayout } from "./composerFooterLayout";

describe("context strip labels", () => {
  it("keeps labels above the icon-only floor and collapses below it", () => {
    expect(
      resolveContextStripLabelsCompact({ compact: false, neededWidth: 1200, availableWidth: 724 }),
    ).toBe(false);
    expect(
      resolveContextStripLabelsCompact({ compact: false, neededWidth: 0, availableWidth: 220 }),
    ).toBe(false);
    expect(
      resolveContextStripLabelsCompact({ compact: false, neededWidth: 0, availableWidth: 219 }),
    ).toBe(true);
  });

  it("uses the short labels below 520px", () => {
    expect(resolveContextStripLabelsNarrow(520)).toBe(false);
    expect(resolveContextStripLabelsNarrow(519)).toBe(true);
  });
});

describe("resolveRestingComposerControlsLayout hysteresis", () => {
  const base = {
    gap: 4,
    naturalFixedWidth: 149,
    minimumFixedWidth: 105,
    blockWidths: [60, 140],
    overflowWidth: 24,
  };

  it("settles when the measured picker width jitters below a pixel", () => {
    let layout = { hiddenCount: 0, visible: true };
    const settled: string[] = [];
    for (let index = 0; index < 10; index += 1) {
      layout = resolveRestingComposerControlsLayout({
        ...base,
        naturalFixedWidth: index % 2 === 0 ? 149 : 149.5,
        hostWidth: 357,
        previous: layout,
      });
      if (index >= 2) settled.push(`${layout.hiddenCount}:${layout.visible}`);
    }
    expect(new Set(settled).size).toBe(1);
  });
});

describe("progressive composer controls", () => {
  const measurement = {
    gap: 4,
    naturalFixedWidth: 140,
    minimumFixedWidth: 80,
    modelIconOnlyWidth: 80,
    blockWidths: [80, 140],
    iconOnlyBlockWidths: [40, 60],
    overflowWidth: 24,
  };

  it("drops the model label to its icon before any block moves to the menu", () => {
    const at = (hostWidth: number) =>
      resolveRestingComposerControlsLayout({ ...measurement, hostWidth });
    // All labels fit: no icon-only step, no overflow.
    expect(at(400)).toMatchObject({ hiddenCount: 0, iconOnlyCount: 0, modelIconOnly: false });
    // Blocks lose their labels first.
    expect(at(288)).toMatchObject({ hiddenCount: 0, iconOnlyCount: 1, modelIconOnly: false });
    expect(at(248)).toMatchObject({ hiddenCount: 0, iconOnlyCount: 2, modelIconOnly: false });
    // The model label drops before the menu appears.
    expect(at(188)).toMatchObject({ hiddenCount: 0, modelIconOnly: true });
    expect(at(152)).toMatchObject({ hiddenCount: 1, modelIconOnly: true });
    expect(at(108)).toMatchObject({ hiddenCount: 2, modelIconOnly: true });
  });

  it("settles through fractional label-width changes at each threshold", () => {
    for (const hostWidth of [368, 288, 248]) {
      let previous = resolveRestingComposerControlsLayout({ ...measurement, hostWidth });
      for (let index = 0; index < 10; index += 1) {
        const next = resolveRestingComposerControlsLayout({
          ...measurement,
          hostWidth,
          previous,
          naturalFixedWidth: 140 + (index % 2) * 0.5,
        });
        if (index > 1) expect(next).toEqual(previous);
        previous = next;
      }
    }
  });
});
