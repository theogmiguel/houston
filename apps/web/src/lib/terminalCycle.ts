export type TerminalCycleDirection = "next" | "previous";

/**
 * The terminal after (or before) `activeTerminalId` in `terminalIds`, wrapping at either end.
 * Null when there is no other terminal to move to. An active id outside the list starts from the
 * first (next) or last (previous) terminal.
 */
export function cycleTerminalId(
  terminalIds: ReadonlyArray<string>,
  activeTerminalId: string,
  direction: TerminalCycleDirection,
): string | null {
  if (terminalIds.length === 0) return null;
  const activeIndex = terminalIds.indexOf(activeTerminalId);
  if (activeIndex >= 0 && terminalIds.length === 1) return null;
  const step = direction === "next" ? 1 : -1;
  const fallbackIndex = direction === "next" ? 0 : terminalIds.length - 1;
  const nextIndex =
    activeIndex < 0
      ? fallbackIndex
      : (activeIndex + step + terminalIds.length) % terminalIds.length;
  return terminalIds[nextIndex] ?? null;
}
