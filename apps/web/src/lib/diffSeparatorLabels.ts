const KNOWN_COUNT = /^(\d+) unmodified lines?$/;
const UNKNOWN_COUNT = "More unchanged context may be available";

/** The label for a separator that hides `count` lines, or the control's name when the count is unknown. */
export function separatorLabel(count: number | null): string {
  if (count === null) return "Expand context";
  return `Show ${count} more ${count === 1 ? "line" : "lines"}`;
}

/**
 * The viewer words its hunk separators as a statement ("18 unmodified lines", "More unchanged
 * context may be available"); the separator is the control that reveals them, so it is renamed
 * to say what it does. Text this does not recognise is left as the viewer wrote it.
 */
export function relabelDiffSeparators(container: HTMLElement): void {
  const root = container.shadowRoot ?? container;
  for (const span of root.querySelectorAll<HTMLElement>("[data-unmodified-lines]")) {
    const text = span.textContent ?? "";
    if (text === UNKNOWN_COUNT) {
      span.textContent = separatorLabel(null);
      continue;
    }
    const match = KNOWN_COUNT.exec(text);
    if (match) span.textContent = separatorLabel(Number(match[1]));
  }
}
