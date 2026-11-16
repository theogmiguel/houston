export interface RailTarget {
  readonly threadId: string;
}

/**
 * The rail row `thread.previous` / `thread.next` moves to. The walk starts at
 * the focused row and stops at the ends; with no focused row it starts at the
 * matching end of the rail.
 */
export function nextRailTargetIndex(
  targets: ReadonlyArray<RailTarget>,
  current: RailTarget | null,
  direction: "previous" | "next",
): number | null {
  if (targets.length === 0) return null;
  const currentIndex =
    current === null ? -1 : targets.findIndex((target) => target.threadId === current.threadId);
  if (currentIndex === -1) return direction === "previous" ? targets.length - 1 : 0;
  const nextIndex = currentIndex + (direction === "previous" ? -1 : 1);
  return nextIndex < 0 || nextIndex >= targets.length ? null : nextIndex;
}

/** Pinned threads lead their workspace's rows; the rest keep their configured order. */
export function pinnedThreadsFirst<T extends { readonly pinnedAt: string | null }>(
  threads: ReadonlyArray<T>,
): T[] {
  return threads.toSorted(
    (left, right) => Number(right.pinnedAt !== null) - Number(left.pinnedAt !== null),
  );
}
