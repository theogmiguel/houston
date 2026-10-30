import * as Schema from "effect/Schema";

import { PositiveInt, TrimmedNonEmptyString } from "../baseSchemas.ts";

// The same bounds as pull-request viewed marks.
const MAX_FILE_PATH_LENGTH = 4_096;
const MAX_FILES_VIEWED_PRESSES = 500;
const MAX_MAPPED_ANCHORS = 200;

const FilePath = Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(MAX_FILE_PATH_LENGTH));
// A full SHA-1 or SHA-256 object id. Anchors come back from clients, and the server passes these
// ids to git, so nothing but an object id may decode.
const Sha = Schema.String.check(Schema.isPattern(/^[0-9a-f]{40}([0-9a-f]{24})?$/));

export const ReviewLineSide = Schema.Literals(["new", "old"]);
export type ReviewLineSide = typeof ReviewLineSide.Type;

/** Lines of one side of a local diff, pinned to the content they were drawn on. */
export const ReviewLineAnchor = Schema.Struct({
  path: FilePath,
  side: ReviewLineSide,
  startLine: PositiveInt,
  endLine: PositiveInt,
  headSha: Schema.NullOr(Sha),
  /** A blob in the worktree's object store; `git gc` may prune one written for uncommitted lines. */
  blob: Sha,
}).check(Schema.makeFilter((anchor) => anchor.endLine >= anchor.startLine));
export type ReviewLineAnchor = typeof ReviewLineAnchor.Type;

export const HoustonReviewFilesViewedInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
});
export type HoustonReviewFilesViewedInput = typeof HoustonReviewFilesViewedInput.Type;

export const HoustonReviewFileViewedState = Schema.Literals(["viewed", "dismissed"]);
export type HoustonReviewFileViewedState = typeof HoustonReviewFileViewedState.Type;

export const HoustonReviewFileViewed = Schema.Struct({
  path: FilePath,
  state: HoustonReviewFileViewedState,
  /** `HEAD` when the file was marked; null on an unborn `HEAD`. */
  headSha: Schema.NullOr(Sha),
});
export type HoustonReviewFileViewed = typeof HoustonReviewFileViewed.Type;

export const HoustonReviewFilesViewedResult = Schema.Struct({
  headSha: Schema.NullOr(Sha),
  /** `""` for a detached `HEAD`; null outside a git worktree. */
  refName: Schema.NullOr(Schema.String),
  /** A path missing from this list is unviewed. */
  files: Schema.Array(HoustonReviewFileViewed),
  truncated: Schema.Boolean,
});
export type HoustonReviewFilesViewedResult = typeof HoustonReviewFilesViewedResult.Type;

export const HoustonReviewSetFilesViewedInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  files: Schema.Array(
    Schema.Struct({
      path: FilePath,
      viewed: Schema.Boolean,
    }),
  ).check(Schema.isMaxLength(MAX_FILES_VIEWED_PRESSES)),
});
export type HoustonReviewSetFilesViewedInput = typeof HoustonReviewSetFilesViewedInput.Type;

export const HoustonReviewAnchorLinesInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  path: FilePath,
  side: ReviewLineSide,
  startLine: PositiveInt,
  endLine: PositiveInt,
  /** The Changes source's base; the `old` side reads the merge base of `HEAD` and this ref. */
  baseRef: Schema.optional(TrimmedNonEmptyString),
});
export type HoustonReviewAnchorLinesInput = typeof HoustonReviewAnchorLinesInput.Type;

export const HoustonReviewMapAnchorsInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  baseRef: Schema.optional(TrimmedNonEmptyString),
  anchors: Schema.Array(ReviewLineAnchor).check(Schema.isMaxLength(MAX_MAPPED_ANCHORS)),
});
export type HoustonReviewMapAnchorsInput = typeof HoustonReviewMapAnchorsInput.Type;

export const HoustonReviewAnchorMapping = Schema.Union([
  Schema.Struct({
    state: Schema.Literals(["current", "moved"]),
    path: FilePath,
    startLine: PositiveInt,
    endLine: PositiveInt,
  }),
  Schema.Struct({
    state: Schema.Literal("outdated"),
    path: FilePath,
    reason: Schema.Literals(["changed", "deleted", "unavailable"]),
  }),
]);
export type HoustonReviewAnchorMapping = typeof HoustonReviewAnchorMapping.Type;

export const HoustonReviewAnchorMapResult = Schema.Struct({
  /** One mapping per anchor, in input order. */
  anchors: Schema.Array(HoustonReviewAnchorMapping),
});
export type HoustonReviewAnchorMapResult = typeof HoustonReviewAnchorMapResult.Type;

export class HoustonReviewAnchorRangeError extends Schema.TaggedError<HoustonReviewAnchorRangeError>()(
  "HoustonReviewAnchorRangeError",
  {
    path: Schema.String,
    side: ReviewLineSide,
    startLine: Schema.Number,
    endLine: Schema.Number,
    lineCount: Schema.Number,
  },
) {
  override get message(): string {
    return `Lines ${this.startLine}-${this.endLine} are outside the ${this.side} side of ${this.path}, which has ${this.lineCount} lines.`;
  }
}
