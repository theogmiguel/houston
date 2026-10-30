import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import {
  effectiveSnoozed,
  isThreadWokeUnseen,
  threadWokeAt,
} from "@t3tools/client-runtime/state/thread-settled";

import {
  resolveSidebarStatusGlyphState,
  resolveThreadStatusPill,
} from "../components/Sidebar.logic";
import type { GridRecord } from "./gridStore";
import { preorderThreads } from "./tree";

/**
 * The grid rail's one status vocabulary. `idle` cards show their age; every
 * other state shows an outlined glyph and a word.
 */
export type GridThreadState = "running" | "ready" | "needs" | "failed" | "back" | "idle";

export function resolveGridThreadState(
  thread: EnvironmentThreadShell,
  now: string,
): GridThreadState {
  const status = resolveThreadStatusPill({ thread });
  switch (resolveSidebarStatusGlyphState(status)) {
    case "working":
      return "running";
    case "needs":
      return "needs";
    case "error":
      return "failed";
    case "done":
      return "ready";
    case "idle":
      break;
  }
  const wokeAt = threadWokeAt(thread, { now });
  return isThreadWokeUnseen({
    wokeAt,
    settled: thread.settledOverride === "settled",
    lastVisitedAt: thread.lastVisitedAt,
    latestRunCompletedAt: thread.latestRun?.completedAt ?? null,
  })
    ? "back"
    : "idle";
}

export function gridThreadStateLabel(state: GridThreadState, elapsed?: string): string | null {
  switch (state) {
    case "running":
      return elapsed ? `Running ${elapsed}` : "Running";
    case "ready":
      return "Ready";
    case "needs":
      return "Needs you";
    case "failed":
      return "Failed";
    case "back":
      return "Back";
    case "idle":
      return null;
  }
}

export function threadCardsInPaneOrder(
  grid: GridRecord,
  threads: ReadonlyArray<EnvironmentThreadShell>,
): EnvironmentThreadShell[] {
  const byId = new Map<string, EnvironmentThreadShell>(
    threads.map((thread) => [thread.id, thread] as const),
  );
  return (grid.tree === null ? [] : preorderThreads(grid.tree)).flatMap((leaf) => {
    const thread = byId.get(leaf.threadId);
    return thread === undefined ? [] : [thread];
  });
}

/** Threads that still belong on the rail: not archived, closed or on hold. */
export function visibleGridThreads(
  grid: GridRecord,
  threads: ReadonlyArray<EnvironmentThreadShell>,
  now: string,
): EnvironmentThreadShell[] {
  return threadCardsInPaneOrder(grid, threads).filter(
    (thread) =>
      thread.archivedAt === null &&
      thread.settledOverride !== "settled" &&
      !effectiveSnoozed(thread, { now }),
  );
}

export interface OnHoldSummary {
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
  readonly nextWakeAt: string | null;
}

export function summarizeOnHold(
  grids: ReadonlyArray<GridRecord>,
  threads: ReadonlyArray<EnvironmentThreadShell>,
  now: string,
): OnHoldSummary {
  const inAnyGrid = new Set(
    grids.flatMap((grid) =>
      (grid.tree === null ? [] : preorderThreads(grid.tree)).map((leaf) => leaf.threadId),
    ),
  );
  const held = threads
    .filter(
      (thread) =>
        thread.archivedAt === null &&
        inAnyGrid.has(thread.id) &&
        effectiveSnoozed(thread, { now }),
    )
    .toSorted((left, right) => {
      const leftUntil = left.snoozedUntil === null ? Number.POSITIVE_INFINITY : Date.parse(left.snoozedUntil);
      const rightUntil =
        right.snoozedUntil === null ? Number.POSITIVE_INFINITY : Date.parse(right.snoozedUntil);
      return leftUntil - rightUntil;
    });
  return {
    threads: held,
    nextWakeAt: held.find((thread) => thread.snoozedUntil !== null)?.snoozedUntil ?? null,
  };
}

export function resolveGridThreadAttentionState(state: GridThreadState): boolean {
  return state === "needs" || state === "ready";
}

export interface AttentionCard {
  readonly gridId: string;
  readonly threadId: string;
  readonly state: GridThreadState;
}

export interface AttentionNavigationEvent {
  readonly key: string;
  readonly code?: string | undefined;
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
  readonly shiftKey: boolean;
}

/**
 * `Ctrl .` is next and `Ctrl Shift .` is previous. Shift turns the period key
 * into `>` on most layouts, so both keys count. `Ctrl J` never matches: the
 * terminal drawer keeps it.
 */
export function attentionNavigationDirection(
  event: AttentionNavigationEvent,
): 1 | -1 | null {
  if (!(event.metaKey || event.ctrlKey) || event.altKey) return null;
  const isPeriod =
    event.code === "Period" || event.key === "." || event.key === ">";
  if (!isPeriod) return null;
  return event.shiftKey ? -1 : 1;
}

/**
 * `Ctrl .` walks Needs you and Ready cards across every workspace in rail
 * order: workspaces, then grids, then panes left to right, top to bottom.
 * `Ctrl Shift .` walks back. It wraps, and a focused card that needs nothing
 * starts the walk at the following card. `Ctrl J` stays the terminal drawer.
 */
export function nextAttentionCard(
  cards: ReadonlyArray<AttentionCard>,
  current: { readonly gridId: string; readonly threadId: string } | null,
  direction: 1 | -1,
): AttentionCard | null {
  const candidates = cards.filter((card) => resolveGridThreadAttentionState(card.state));
  if (candidates.length === 0) return null;
  if (current === null) return direction === 1 ? (candidates[0] ?? null) : (candidates.at(-1) ?? null);
  const currentIndex = cards.findIndex(
    (card) => card.gridId === current.gridId && card.threadId === current.threadId,
  );
  const start = currentIndex === -1 ? (direction === 1 ? -1 : cards.length) : currentIndex;
  for (let step = 1; step <= cards.length; step += 1) {
    const index = (((start + direction * step) % cards.length) + cards.length) % cards.length;
    const card = cards[index];
    if (card !== undefined && resolveGridThreadAttentionState(card.state)) return card;
  }
  return null;
}

export interface ThreadSelection {
  readonly selectedThreadKeys: ReadonlySet<string>;
  readonly anchorThreadKey: string | null;
}

export interface ThreadSelectionClick {
  readonly orderedKeys: ReadonlyArray<string>;
  readonly clickedKey: string;
  readonly shiftKey: boolean;
  readonly toggleKey: boolean;
}

/** Shift-click selects a range from the anchor; Ctrl-click toggles one card. */
export function updateThreadSelection(
  selection: ThreadSelection,
  click: ThreadSelectionClick,
): ThreadSelection {
  const toggle = (key: string): ThreadSelection => {
    const selected = new Set(selection.selectedThreadKeys);
    if (selected.has(key)) selected.delete(key);
    else selected.add(key);
    return { selectedThreadKeys: selected, anchorThreadKey: key };
  };
  if (click.toggleKey) return toggle(click.clickedKey);
  if (click.shiftKey && selection.anchorThreadKey !== null) {
    const anchor = click.orderedKeys.indexOf(selection.anchorThreadKey);
    const target = click.orderedKeys.indexOf(click.clickedKey);
    if (anchor !== -1 && target !== -1) {
      const selected = new Set(selection.selectedThreadKeys);
      for (let index = Math.min(anchor, target); index <= Math.max(anchor, target); index += 1) {
        const key = click.orderedKeys[index];
        if (key !== undefined) selected.add(key);
      }
      return { selectedThreadKeys: selected, anchorThreadKey: selection.anchorThreadKey };
    }
  }
  return {
    selectedThreadKeys: new Set([click.clickedKey]),
    anchorThreadKey: click.clickedKey,
  };
}

export function clearThreadSelection(): ThreadSelection {
  return { selectedThreadKeys: new Set(), anchorThreadKey: null };
}

/** The workspace row's uncommitted totals, when the renderer has them. */
export function formatGridDiffCounts(diff: { insertions: number; deletions: number }): string {
  return `+${diff.insertions} −${diff.deletions}`;
}

export interface SearchableThread {
  readonly title: string;
  readonly branch: string | null;
  readonly pullRequests: ReadonlyArray<{ readonly number: number }>;
}

export function threadMatchesGridSearch(thread: SearchableThread, query: string): boolean {
  const normalized = query.trim().toLocaleLowerCase();
  if (normalized.length === 0) return true;
  if (thread.title.toLocaleLowerCase().includes(normalized)) return true;
  if (thread.branch?.toLocaleLowerCase().includes(normalized)) return true;
  return thread.pullRequests.some((pullRequest) => `#${pullRequest.number}`.includes(normalized));
}

export function openPullRequestNumber(
  thread: Pick<EnvironmentThreadShell, "pullRequests" | "branchPullRequest">,
): number | null {
  const open = thread.pullRequests.find((link) => link.snapshot?.state === "open");
  return open?.number ?? thread.branchPullRequest?.number ?? null;
}

export function resolveThreadModelLabel(
  thread: Pick<EnvironmentThreadShell, "modelSelection">,
): string | null {
  const model = thread.modelSelection;
  return model?.model ?? null;
}
