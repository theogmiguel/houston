const HEADING_PATTERN = /^\s{0,3}#{1,6}\s+(.+)$/m;
const LINE_BREAK = /\r?\n/;
const START_PATTERN = /^\s{0,3}#{1,6}\s+/;
const FIRST_HEADING_MATCH_PATTERN = /^\s{0,3}#{1,6}\s+(.+)$/;

export function proposedPlanTitle(planMarkdown: string): string | null {
  const heading = planMarkdown.match(HEADING_PATTERN)?.[1]?.trim();
  return heading && heading.length > 0 ? heading : null;
}

export function stripDisplayedPlanMarkdown(planMarkdown: string): string {
  const lines = planMarkdown.trimEnd().split(LINE_BREAK);
  let start = lines[0] && START_PATTERN.test(lines[0]) ? 1 : 0;
  while (lines[start]?.trim().length === 0) {
    start += 1;
  }
  const firstHeadingMatch = lines[start]?.match(FIRST_HEADING_MATCH_PATTERN);
  if (firstHeadingMatch?.[1]?.trim().toLowerCase() === "summary") {
    start += 1;
    while (lines[start]?.trim().length === 0) {
      start += 1;
    }
  }
  return lines.slice(start).join("\n");
}
