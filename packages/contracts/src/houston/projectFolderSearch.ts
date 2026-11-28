import * as Schema from "effect/Schema";

import { NonNegativeInt, TrimmedNonEmptyString } from "../baseSchemas.ts";

const FOLDER_PATH_MAX_LENGTH = 512;
const FOLDER_NAME_MAX_LENGTH = 128;

/** What one add-project folder search reads before it stops. */
export const HOUSTON_PROJECT_FOLDER_SEARCH_LIMITS = {
  /** Folders a search returns. */
  results: 50,
  /** Directory levels below each search root. */
  depth: 3,
  /** Directory entries one search reads before it stops. */
  entries: 4_096,
  /** Search roots one request may name. */
  roots: 64,
  /** Wall-clock budget for the filesystem walk. */
  timeMs: 1_500,
} as const;

/** A folder to start browsing from, shown when nothing is typed. */
export const HoustonProjectFolderPlaceKind = Schema.Literals([
  "home",
  "project-parent",
  "base",
  "drive",
]);
export type HoustonProjectFolderPlaceKind = typeof HoustonProjectFolderPlaceKind.Type;

export const HoustonProjectFolderPlace = Schema.Struct({
  kind: HoustonProjectFolderPlaceKind,
  /** Short name for the row, such as "Home" or a drive letter. */
  label: TrimmedNonEmptyString,
  path: TrimmedNonEmptyString.check(Schema.isMaxLength(FOLDER_PATH_MAX_LENGTH)),
});
export type HoustonProjectFolderPlace = typeof HoustonProjectFolderPlace.Type;

/** An existing folder whose name matches the typed text. */
export const HoustonProjectFolderMatch = Schema.Struct({
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(FOLDER_NAME_MAX_LENGTH)),
  path: TrimmedNonEmptyString.check(Schema.isMaxLength(FOLDER_PATH_MAX_LENGTH)),
  gitRepository: Schema.Boolean,
});
export type HoustonProjectFolderMatch = typeof HoustonProjectFolderMatch.Type;

export const HoustonProjectFolderSearchInput = Schema.Struct({
  /** Empty asks for the places to start instead of name matches. */
  query: Schema.String.check(Schema.isMaxLength(FOLDER_NAME_MAX_LENGTH)),
  /** The add-project base directory; searched after the registered projects' parents. */
  baseDirectory: Schema.optionalKey(
    Schema.String.check(Schema.isMaxLength(FOLDER_PATH_MAX_LENGTH)),
  ),
  /** Workspace roots of the registered projects this search puts first. */
  projectFolders: Schema.Array(
    TrimmedNonEmptyString.check(Schema.isMaxLength(FOLDER_PATH_MAX_LENGTH)),
  ).check(Schema.isMaxLength(HOUSTON_PROJECT_FOLDER_SEARCH_LIMITS.roots)),
});
export type HoustonProjectFolderSearchInput = typeof HoustonProjectFolderSearchInput.Type;

export const HoustonProjectFolderSearchResult = Schema.Struct({
  places: Schema.Array(HoustonProjectFolderPlace),
  folders: Schema.Array(HoustonProjectFolderMatch),
  /** True when a depth, entry, result or time bound stopped the walk early. */
  truncated: Schema.Boolean,
  /** Directory entries read; helps a caller explain an empty result. */
  scannedEntries: NonNegativeInt,
});
export type HoustonProjectFolderSearchResult = typeof HoustonProjectFolderSearchResult.Type;
