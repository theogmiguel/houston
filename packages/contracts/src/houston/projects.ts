import * as Schema from "effect/Schema";

import { ProjectId } from "../baseSchemas.ts";

/**
 * The bounds a project's repositories are checked against. A refusal names the bound, the value at
 * the bound and the repository asked for.
 */
export const HOUSTON_PROJECT_REPOSITORY_LIMITS = {
  /** Discovered, submodule and tracked repositories one project may resolve. */
  repositories: 64,
  /** Submodules one discovered repository may contribute. */
  submodulesPerRepository: 32,
  /** Directory entries one discovery pass may read before it stops. */
  scannedEntries: 4_096,
  /** Folders a user may add from outside the project folder. */
  trackedFolders: 128,
  /** Ignore patterns one project may store alongside its repositories. */
  ignorePatterns: 200,
} as const;

export const HoustonProjectRepositoryKind = Schema.Literals([
  "discovered",
  "submodule",
  "tracked",
]);
export type HoustonProjectRepositoryKind = typeof HoustonProjectRepositoryKind.Type;

export const HoustonProjectRepositoryNoticeLimit = Schema.Literals([
  "repositories",
  "submodulesPerRepository",
  "scannedEntries",
]);
export type HoustonProjectRepositoryNoticeLimit = typeof HoustonProjectRepositoryNoticeLimit.Type;

/** A discovery bound that tripped, with the bound, the value at it and what was requested. */
export const HoustonProjectRepositoryNotice = Schema.Struct({
  limit: HoustonProjectRepositoryNoticeLimit,
  limitValue: Schema.Int,
  actual: Schema.Int,
  requested: Schema.String,
});
export type HoustonProjectRepositoryNotice = typeof HoustonProjectRepositoryNotice.Type;

export const HoustonProjectRepository = Schema.Struct({
  /** Path relative to the project folder; the project's own repository is ".". */
  key: Schema.String,
  root: Schema.String,
  /** Null on a detached head, and on an entry whose repository could not be read. */
  branch: Schema.NullOr(Schema.String),
  detached: Schema.Boolean,
  kind: HoustonProjectRepositoryKind,
  /** Why the repository could not be read, when it could not. */
  error: Schema.optionalKey(Schema.String),
});
export type HoustonProjectRepository = typeof HoustonProjectRepository.Type;

export const HoustonProjectRepositoriesInput = Schema.Struct({ projectId: ProjectId });
export type HoustonProjectRepositoriesInput = typeof HoustonProjectRepositoriesInput.Type;

export const HoustonProjectRepositoriesResult = Schema.Struct({
  projectId: ProjectId,
  repositories: Schema.Array(HoustonProjectRepository),
  /** The patterns this project ignores, from `houston.json` and its stored list. */
  ignored: Schema.Array(Schema.String),
  notices: Schema.Array(HoustonProjectRepositoryNotice),
});
export type HoustonProjectRepositoriesResult = typeof HoustonProjectRepositoriesResult.Type;

export const HoustonProjectRepositoryTrackInput = Schema.Struct({
  projectId: ProjectId,
  path: Schema.String.check(Schema.isNonEmpty()),
});
export type HoustonProjectRepositoryTrackInput = typeof HoustonProjectRepositoryTrackInput.Type;

export const HoustonProjectRepositoryUntrackInput = Schema.Struct({
  projectId: ProjectId,
  path: Schema.String.check(Schema.isNonEmpty()),
});
export type HoustonProjectRepositoryUntrackInput = typeof HoustonProjectRepositoryUntrackInput.Type;

export const HoustonProjectRepositoryIgnoreInput = Schema.Struct({
  projectId: ProjectId,
  patterns: Schema.Array(Schema.String),
});
export type HoustonProjectRepositoryIgnoreInput = typeof HoustonProjectRepositoryIgnoreInput.Type;

export const HoustonProjectRepositoryErrorKind = Schema.Literals([
  "invalid",
  "limit",
  "not_found",
  "conflict",
  "unsupported",
]);
export type HoustonProjectRepositoryErrorKind = typeof HoustonProjectRepositoryErrorKind.Type;

export class HoustonProjectRepositoryError extends Schema.TaggedError<HoustonProjectRepositoryError>()(
  "HoustonProjectRepositoryError",
  {
    kind: HoustonProjectRepositoryErrorKind,
    message: Schema.String,
    operation: Schema.String,
    limit: Schema.optional(Schema.Number),
    actual: Schema.optional(Schema.Number),
  },
) {}
