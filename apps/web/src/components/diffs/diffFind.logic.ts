export interface FindableHunk {
  readonly additionStart: number;
  readonly additionCount: number;
  readonly additionLineIndex: number;
  readonly deletionStart: number;
  readonly deletionCount: number;
  readonly deletionLineIndex: number;
}

export interface FindableFileDiff {
  readonly additionLines: ReadonlyArray<string>;
  readonly deletionLines: ReadonlyArray<string>;
  readonly hunks: ReadonlyArray<FindableHunk>;
}

export type DiffFindSide = "additions" | "deletions";

export interface DiffFindMatch {
  readonly side: DiffFindSide;
  readonly lineNumber: number;
}

const fileLineFor = (
  hunks: ReadonlyArray<FindableHunk>,
  side: DiffFindSide,
  index: number,
): number | null => {
  for (const hunk of hunks) {
    const startIndex = side === "additions" ? hunk.additionLineIndex : hunk.deletionLineIndex;
    const count = side === "additions" ? hunk.additionCount : hunk.deletionCount;
    if (index >= startIndex && index < startIndex + count) {
      const startLine = side === "additions" ? hunk.additionStart : hunk.deletionStart;
      return startLine + (index - startIndex);
    }
  }
  return null;
};

/** Matches in the file's two sides, left before right, in file order. */
export function findDiffMatches(
  file: FindableFileDiff,
  query: string,
  matchCase: boolean,
): ReadonlyArray<DiffFindMatch> {
  const needle = matchCase ? query : query.toLowerCase();
  if (needle.length === 0) return [];
  const matches: DiffFindMatch[] = [];
  const sides: ReadonlyArray<[DiffFindSide, ReadonlyArray<string>]> = [
    ["deletions", file.deletionLines],
    ["additions", file.additionLines],
  ];
  for (const [side, lines] of sides) {
    for (const [index, line] of lines.entries()) {
      const haystack = matchCase ? line : line.toLowerCase();
      if (!haystack.includes(needle)) continue;
      const lineNumber = fileLineFor(file.hunks, side, index);
      if (lineNumber !== null) matches.push({ side, lineNumber });
    }
  }
  return matches;
}

export function stepFindMatch(index: number, count: number, direction: 1 | -1): number {
  if (count === 0) return 0;
  return (index + direction + count) % count;
}
