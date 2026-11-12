/**
 * Most message-only results the rail lists under the thread matches. The server ranks them, so the
 * best few are the ones worth a row; a longer list would push the thread matches off the rail.
 */
export const SIDEBAR_SEARCH_CONTENT_LIMIT = 8;

export interface SearchableMatch {
  readonly environmentId: string;
  readonly threadId: string;
}

/** The keys in order, each once, at the place it first appears. */
export function orderSearchResults(...groups: ReadonlyArray<ReadonlyArray<string>>): string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const key of groups.flat()) {
    if (seen.has(key)) continue;
    seen.add(key);
    ordered.push(key);
  }
  return ordered;
}

/**
 * Message matches for threads the rail's own title matches do not already show: one per thread,
 * best first, and only threads the rail may show (the project filter's).
 */
export function contentOnlyMatches<T extends SearchableMatch>(
  matches: ReadonlyArray<T>,
  input: {
    readonly keyOf: (match: T) => string;
    readonly shownKeys: ReadonlySet<string>;
    readonly isVisible: (match: T) => boolean;
    readonly limit?: number;
  },
): T[] {
  const limit = input.limit ?? SIDEBAR_SEARCH_CONTENT_LIMIT;
  const seen = new Set(input.shownKeys);
  const kept: T[] = [];
  for (const match of matches) {
    if (kept.length >= limit) break;
    const key = input.keyOf(match);
    if (seen.has(key) || !input.isVisible(match)) continue;
    seen.add(key);
    kept.push(match);
  }
  return kept;
}

/** Moves the highlight one result, wrapping at both ends; with no results it stays at 0. */
export function moveSearchHighlight(current: number, count: number, direction: 1 | -1): number {
  if (count <= 0) return 0;
  return (((current + direction) % count) + count) % count;
}

/** The highlight index kept inside the results, since the list can shrink while it is set. */
export function clampSearchHighlight(index: number, count: number): number {
  return count <= 0 ? 0 : Math.min(Math.max(index, 0), count - 1);
}
