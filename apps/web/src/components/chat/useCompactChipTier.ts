import { useLayoutEffect, useState } from "react";

/**
 * The most chips that can drop their label: pull request, then branch, then model. Tier 0 shows
 * every label; each step collapses the next chip to its icon.
 */
export const COMPACT_CHIP_MAX_TIER = 3;

/** Sub-pixel layout rounding is not overflow. */
const OVERFLOW_TOLERANCE_PX = 1;

/**
 * Picks how many of the compact toolbar's chips collapse to their icon, measured on the toolbar
 * itself so the answer follows its width, not the window's. The tier starts from zero whenever
 * the toolbar's width or content changes and climbs, before paint, until nothing overflows;
 * chips never shrink, so a label is either whole or gone.
 */
export function useCompactChipTier(
  toolbar: HTMLElement | null,
  enabled: boolean,
  width: number,
): number {
  const [revision, setRevision] = useState(0);
  const key = `${width}:${revision}`;
  const [state, setState] = useState({ key, tier: 0 });
  const tier = state.key === key ? state.tier : 0;

  // oxlint-disable-next-line houston/no-unreasoned-state-sync -- the toolbar's children change when a branch or model is renamed, which only the DOM reports
  useLayoutEffect(() => {
    if (toolbar === null || !enabled) return;
    const observer = new MutationObserver(() => setRevision((current) => current + 1));
    observer.observe(toolbar, { childList: true, subtree: true, characterData: true });
    return () => observer.disconnect();
  }, [toolbar, enabled]);

  // oxlint-disable-next-line houston/no-unreasoned-state-sync -- overflow is a layout measurement; the next tier is set before paint
  useLayoutEffect(() => {
    if (toolbar === null || !enabled || tier >= COMPACT_CHIP_MAX_TIER) return;
    if (toolbar.scrollWidth > toolbar.clientWidth + OVERFLOW_TOLERANCE_PX) {
      // oxlint-disable-next-line react/set-state-in-effect -- overflow exists only after layout; the next tier must commit before paint
      setState({ key, tier: tier + 1 });
    }
  }, [toolbar, enabled, key, tier]);

  return enabled ? tier : 0;
}
