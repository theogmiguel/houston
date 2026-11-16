import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { ReviewCommentContextRecord } from "../composerContext.ts";
import {
  HoustonReviewMapAnchorsInput,
  HoustonReviewSetFilesViewedInput,
  ReviewLineAnchor,
} from "./reviewState.ts";

const decodeSet = Schema.decodeUnknownExit(HoustonReviewSetFilesViewedInput);
const decodeMap = Schema.decodeUnknownExit(HoustonReviewMapAnchorsInput);
const decodeRecord = Schema.decodeUnknownSync(ReviewCommentContextRecord);
const encodeRecord = Schema.encodeSync(ReviewCommentContextRecord);
const decodeAnchor = Schema.decodeUnknownExit(ReviewLineAnchor);

const files = (count: number) =>
  Array.from({ length: count }, (_, index) => ({ path: `src/f${index}.ts`, viewed: true }));

const anchor = {
  path: "src/a.ts",
  side: "new",
  startLine: 10,
  endLine: 12,
  headSha: "0123456789abcdef0123456789abcdef01234567",
  blob: "89abcdef0123456789abcdef0123456789abcdef",
};

describe("set input bounds", () => {
  it("accepts 500 files and a 4096-character path", () => {
    expect(decodeSet({ cwd: "/repo", files: files(500) })._tag).toBe("Success");
    expect(
      decodeSet({ cwd: "/repo", files: [{ path: "a".repeat(4096), viewed: true }] })._tag,
    ).toBe("Success");
  });

  it("refuses 501 files, an empty path and a 4097-character path", () => {
    expect(decodeSet({ cwd: "/repo", files: files(501) })._tag).toBe("Failure");
    expect(decodeSet({ cwd: "/repo", files: [{ path: "", viewed: true }] })._tag).toBe("Failure");
    expect(
      decodeSet({ cwd: "/repo", files: [{ path: "a".repeat(4097), viewed: false }] })._tag,
    ).toBe("Failure");
  });
});

describe("map input bounds", () => {
  it("accepts 200 anchors and refuses 201", () => {
    const anchors = (count: number) => Array.from({ length: count }, () => ({ ...anchor }));
    expect(decodeMap({ cwd: "/repo", anchors: anchors(200) })._tag).toBe("Success");
    expect(decodeMap({ cwd: "/repo", anchors: anchors(201) })._tag).toBe("Failure");
  });

  it("refuses an anchor whose end is before its start", () => {
    expect(decodeAnchor({ ...anchor, startLine: 12, endLine: 10 })._tag).toBe("Failure");
    expect(decodeAnchor({ ...anchor, startLine: 0 })._tag).toBe("Failure");
    expect(decodeAnchor(anchor)._tag).toBe("Success");
  });
});

describe("anchor object ids are hex", () => {
  it("accepts 40- and 64-character lowercase hex ids and a null headSha", () => {
    expect(decodeAnchor({ ...anchor, headSha: null })._tag).toBe("Success");
    expect(decodeAnchor({ ...anchor, blob: "a".repeat(64), headSha: "b".repeat(64) })._tag).toBe(
      "Success",
    );
  });

  it.each([
    ["an option", "--output=/tmp/victim"],
    ["a revision name", "HEAD"],
    ["uppercase hex", "0123456789ABCDEF0123456789ABCDEF01234567"],
    ["39 hex characters", "0".repeat(39)],
    ["41 hex characters", "0".repeat(41)],
    ["a revision expression", `${"0".repeat(40)}:a.ts`],
  ])("refuses %s as headSha or blob", (_, id) => {
    expect(decodeAnchor({ ...anchor, headSha: id })._tag).toBe("Failure");
    expect(decodeAnchor({ ...anchor, blob: id })._tag).toBe("Failure");
    expect(decodeMap({ cwd: "/repo", anchors: [{ ...anchor, blob: id }] })._tag).toBe("Failure");
  });
});

describe("review comment records with and without an anchor", () => {
  const record = {
    version: 1,
    contextId: "review-1",
    label: "src/a.ts:10-12",
    kind: "review-comment",
    sectionId: "branch-range",
    sectionTitle: "Changes",
    filePath: "src/a.ts",
    startIndex: 4,
    endIndex: 6,
    rangeLabel: "L10-L12",
    text: "Why this branch?",
    diff: "+const a = 1;\n",
  };

  it("a record without an anchor decodes and encodes to the same JSON", () => {
    const decoded = decodeRecord(record);
    expect("anchor" in decoded).toBe(false);
    expect(JSON.stringify(encodeRecord(decoded))).toBe(JSON.stringify(record));
  });

  it("a record with an anchor round-trips", () => {
    const withAnchor = { ...record, anchor };
    const decoded = decodeRecord(withAnchor);
    expect(decoded.anchor).toEqual(anchor);
    expect(encodeRecord(decoded)).toEqual(withAnchor);
  });

  it("a record with a malformed anchor is refused", () => {
    expect(() => decodeRecord({ ...record, anchor: { ...anchor, side: "both" } })).toThrow();
  });
});
