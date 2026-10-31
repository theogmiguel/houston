import { describe, expect, it } from "vite-plus/test";
import type { ReviewCommentContextRecord } from "@t3tools/contracts";
import {
  formatComposerContextReference,
  projectComposerContextForProvider,
} from "@t3tools/shared/composerContextReferences";

import { judgeMark, mapAnchor } from "./reviewState.ts";

// Twenty distinct lines; the anchored range is lines 10-12.
const lines = Array.from({ length: 20 }, (_, index) => `line ${index + 1}`);
const text = (rows: ReadonlyArray<string>) => `${rows.join("\n")}\n`;
const BEFORE = text(lines);
const range = { startLine: 10, endLine: 12 };
const withRows = (edit: (rows: Array<string>) => void) => {
  const rows = [...lines];
  edit(rows);
  return text(rows);
};

describe("a mark is viewed only while its content is unchanged", () => {
  it.each([
    { marked: "a1b2", current: "a1b2", state: "viewed" },
    { marked: "", current: "", state: "viewed" },
    { marked: "a1b2", current: "c3d4", state: "dismissed" },
    { marked: "", current: "a1b2", state: "dismissed" },
    { marked: "a1b2", current: "", state: "dismissed" },
  ] as const)("$marked against $current is $state", ({ marked, current, state }) => {
    expect(judgeMark(marked, current)).toBe(state);
  });
});

describe("unchanged lines stay current", () => {
  it("identical content keeps the same lines", () => {
    expect(mapAnchor({ before: BEFORE, after: BEFORE, ...range })).toEqual({
      state: "current",
      startLine: 10,
      endLine: 12,
    });
  });

  it("an edit below the range keeps the same lines", () => {
    const after = withRows((rows) => {
      rows[17] = "changed line 18";
    });
    expect(mapAnchor({ before: BEFORE, after, ...range })).toEqual({
      state: "current",
      startLine: 10,
      endLine: 12,
    });
  });

  it("CRLF line endings in the working tree map like LF", () => {
    expect(mapAnchor({ before: BEFORE, after: BEFORE.replaceAll("\n", "\r\n"), ...range })).toEqual(
      { state: "current", startLine: 10, endLine: 12 },
    );
  });
});

describe("lines shifted from above move with their net count", () => {
  it.each([
    {
      name: "2 lines inserted above",
      after: withRows((rows) => rows.splice(3, 0, "new a", "new b")),
      expected: { state: "moved", startLine: 12, endLine: 14 },
    },
    {
      name: "2 lines inserted directly above the first line",
      after: withRows((rows) => rows.splice(9, 0, "new a", "new b")),
      expected: { state: "moved", startLine: 12, endLine: 14 },
    },
    {
      name: "1 line removed above",
      after: withRows((rows) => rows.splice(2, 1)),
      expected: { state: "moved", startLine: 9, endLine: 11 },
    },
    {
      name: "3 inserted and 1 removed above",
      after: withRows((rows) => {
        rows.splice(5, 1);
        rows.splice(1, 0, "x", "y", "z");
      }),
      expected: { state: "moved", startLine: 12, endLine: 14 },
    },
    {
      name: "lines inserted directly after line 12",
      after: withRows((rows) => rows.splice(12, 0, "after a", "after b")),
      expected: { state: "current", startLine: 10, endLine: 12 },
    },
    {
      name: "a line inserted between lines 10 and 11",
      after: withRows((rows) => rows.splice(10, 0, "inside")),
      expected: { state: "outdated", reason: "changed" },
    },
  ])("$name", ({ after, expected }) => {
    expect(mapAnchor({ before: BEFORE, after, ...range })).toEqual(expected);
  });
});

describe("a changed line inside the range outdates it", () => {
  it.each([
    { name: "first line modified", after: withRows((rows) => (rows[9] = "edited 10")) },
    { name: "middle line modified", after: withRows((rows) => (rows[10] = "edited 11")) },
    { name: "last line modified", after: withRows((rows) => (rows[11] = "edited 12")) },
    { name: "a line removed", after: withRows((rows) => rows.splice(10, 1)) },
    { name: "the whole range removed", after: withRows((rows) => rows.splice(9, 3)) },
  ])("$name", ({ after }) => {
    expect(mapAnchor({ before: BEFORE, after, ...range })).toEqual({
      state: "outdated",
      reason: "changed",
    });
  });

  it("a single-line anchor is outdated only by its own line", () => {
    const after = withRows((rows) => (rows[10] = "edited 11"));
    expect(mapAnchor({ before: BEFORE, after, startLine: 10, endLine: 10 })).toEqual({
      state: "current",
      startLine: 10,
      endLine: 10,
    });
    expect(mapAnchor({ before: BEFORE, after, startLine: 11, endLine: 11 })).toEqual({
      state: "outdated",
      reason: "changed",
    });
  });
});

describe("the anchor never reaches the prompt", () => {
  it("formats the same provider text with and without an anchor", () => {
    const record = {
      version: 1,
      kind: "review-comment",
      contextId: "review-1",
      label: "src/a.ts:10-12",
      sectionId: "branch-range",
      sectionTitle: "Changes",
      filePath: "src/a.ts",
      startIndex: 4,
      endIndex: 6,
      rangeLabel: "L10-L12",
      text: "Why this branch?",
      diff: "+const a = 1;\n",
    } as unknown as ReviewCommentContextRecord;
    const anchored = {
      ...record,
      anchor: {
        path: "src/a.ts",
        side: "new",
        startLine: 10,
        endLine: 12,
        headSha: "0123456789abcdef0123456789abcdef01234567",
        blob: "89abcdef0123456789abcdef0123456789abcdef",
      },
    } as ReviewCommentContextRecord;
    const message = `Look at ${formatComposerContextReference({
      kind: record.kind,
      contextId: record.contextId,
      label: record.label,
    })}`;
    const plain = projectComposerContextForProvider({ text: message, records: [record] });
    const withAnchor = projectComposerContextForProvider({ text: message, records: [anchored] });
    expect(plain).toContain("Why this branch?");
    expect(withAnchor).toBe(plain);
    expect(withAnchor).not.toContain("89abcdef0123456789abcdef0123456789abcdef");
  });
});
