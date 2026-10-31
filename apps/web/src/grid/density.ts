/** How much of a thread a pane shows, chosen from the space the pane actually has. */
export type PaneDensity = "solo" | "comfortable" | "compact" | "glance";

/** A resize has to clear a threshold by this much before the pane re-tiers. */
export const DENSITY_HYSTERESIS_PX = 40;

const DENSITY_RANK: Record<PaneDensity, number> = {
  glance: 0,
  compact: 1,
  comfortable: 2,
  solo: 3,
};

export interface PaneSize {
  readonly width: number;
  readonly height: number;
}

/**
 * The density a pane would use at this size. Solo is reserved for a grid that
 * holds one thread: a wider pane in a crowded grid is comfortable, not solo.
 */
export function paneDensityFor(size: PaneSize, threadCount: number): PaneDensity {
  if (threadCount === 1 && size.width >= 900) return "solo";
  if (size.width >= 560 && size.height >= 520) return "comfortable";
  if (size.width >= 400 && size.height >= 340) return "compact";
  return "glance";
}

/**
 * The density after a resize ends: a pane gains a tier only when the new size
 * clears its threshold by the hysteresis margin, and loses one only when it
 * falls the same margin below the old threshold. Sizes between the two keep
 * the current tier, so dragging a divider never flickers.
 */
export function retierPaneDensity(
  current: PaneDensity,
  size: PaneSize,
  threadCount: number,
): PaneDensity {
  const smaller = {
    width: size.width - DENSITY_HYSTERESIS_PX,
    height: size.height - DENSITY_HYSTERESIS_PX,
  };
  const larger = {
    width: size.width + DENSITY_HYSTERESIS_PX,
    height: size.height + DENSITY_HYSTERESIS_PX,
  };
  const upgrade = paneDensityFor(smaller, threadCount);
  if (DENSITY_RANK[upgrade] > DENSITY_RANK[current]) return upgrade;
  const downgrade = paneDensityFor(larger, threadCount);
  if (DENSITY_RANK[downgrade] < DENSITY_RANK[current]) return downgrade;
  return current;
}

export interface PaneDensityLayout {
  /** A solo pane moves its title and actions to the window toolbar. */
  readonly showHeader: boolean;
  readonly showBranch: boolean;
  readonly showStatusLabel: boolean;
  /** The timeline max width in CSS pixels; null uses the pane width. */
  readonly timelineMaxWidth: number | null;
  readonly composerMaxWidth: number | null;
  /** Comfortable and solo panes keep the whole conversation. */
  readonly timeline: "full" | "latest-turn" | "latest-message";
  readonly messageLines: number | null;
}

export function paneDensityLayout(density: PaneDensity, width: number): PaneDensityLayout {
  switch (density) {
    case "solo":
      return {
        showHeader: false,
        showBranch: false,
        showStatusLabel: false,
        timelineMaxWidth: 720,
        composerMaxWidth: 760,
        timeline: "full",
        messageLines: null,
      };
    case "comfortable":
      return {
        showHeader: true,
        showBranch: width >= 640,
        showStatusLabel: true,
        timelineMaxWidth: 640,
        composerMaxWidth: null,
        timeline: "full",
        messageLines: null,
      };
    case "compact":
      return {
        showHeader: true,
        showBranch: false,
        showStatusLabel: true,
        timelineMaxWidth: null,
        composerMaxWidth: null,
        timeline: "latest-turn",
        messageLines: 5,
      };
    case "glance":
      return {
        showHeader: true,
        showBranch: false,
        showStatusLabel: false,
        timelineMaxWidth: null,
        composerMaxWidth: null,
        timeline: "latest-message",
        messageLines: 3,
      };
  }
}
