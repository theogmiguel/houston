import type { FileDiffMetadata } from "@pierre/diffs";

interface ContextRun {
  readonly newStart: number;
  readonly newEnd: number;
  readonly offset: number;
}

/**
 * Maps a line number in the new file to the number the same unchanged line has in the old file.
 * The viewer's unified gutter prints one number per row (the new one for context rows); this
 * supplies the other side so the gutter can show both.
 */
export function createOldLineResolver(fileDiff: FileDiffMetadata): (newLine: number) => number {
  const runs: ContextRun[] = [];
  for (const [index, hunk] of fileDiff.hunks.entries()) {
    let newLine = hunk.additionStart;
    let offset = hunk.deletionStart - hunk.additionStart;
    for (const content of hunk.hunkContent) {
      if (content.type === "context") {
        runs.push({ newStart: newLine, newEnd: newLine + content.lines - 1, offset });
        newLine += content.lines;
      } else {
        newLine += content.additions;
        offset += content.deletions - content.additions;
      }
    }
    const next = fileDiff.hunks[index + 1];
    // Unchanged rows after a hunk, up to the next hunk (or the end of the file).
    runs.push({
      newStart: newLine,
      newEnd: next === undefined ? Number.POSITIVE_INFINITY : next.additionStart - 1,
      offset,
    });
  }
  return (newLine) => {
    // Rows between hunks (expanded context) share the offset of the hunk before them.
    let found = 0;
    for (const run of runs) {
      if (run.newStart > newLine) break;
      found = run.offset;
      if (newLine <= run.newEnd) break;
    }
    return newLine + found;
  };
}
