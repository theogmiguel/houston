// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";

import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";

import {
  HOUSTON_PROJECT_FOLDER_SEARCH_LIMITS,
  type HoustonProjectFolderMatch,
  type HoustonProjectFolderPlace,
  type HoustonProjectFolderSearchInput,
  type HoustonProjectFolderSearchResult,
} from "@houston-app/contracts";
import * as HostProcess from "@houston-app/shared/HostProcess";
import { expandHomePath } from "@houston-app/provider-core/server/pathExpansion";

/** Build folders a project search never walks into; a repository name is not stored there. */
export const SKIPPED_FOLDER_NAMES: ReadonlySet<string> = new Set([
  "node_modules",
  ".git",
  ".hg",
  ".svn",
  "dist",
  "build",
  "out",
  "coverage",
  "target",
  "vendor",
  "venv",
  "__pycache__",
  "pods",
  ".gradle",
  ".next",
  ".nuxt",
  ".cache",
  ".turbo",
  ".parcel-cache",
  "library",
  "appdata",
  "application data",
  "$recycle.bin",
  "system volume information",
  ".trash",
  "bin",
  "obj",
]);

/** A folder that may match the typed name, before git detection and ranking. */
export interface FolderSearchCandidate {
  readonly name: string;
  readonly path: string;
  readonly rootIndex: number;
  readonly depth: number;
}

export interface FolderSearchRankedCandidate extends FolderSearchCandidate {
  readonly gitRepository: boolean;
}

export type SearchInput = HoustonProjectFolderSearchInput;

export function isSkippedFolderName(name: string, query: string): boolean {
  if (SKIPPED_FOLDER_NAMES.has(name.toLowerCase())) return true;
  // Hidden folders are noise unless the user is expressly looking for one.
  return name.startsWith(".") && !query.startsWith(".");
}

export function folderNameMatches(name: string, query: string): boolean {
  return name.toLowerCase().includes(query.toLowerCase());
}

function folderNameRank(name: string, query: string): number {
  const lowerName = name.toLowerCase();
  const lowerQuery = query.toLowerCase();
  if (lowerName === lowerQuery) return 0;
  return lowerName.startsWith(lowerQuery) ? 1 : 2;
}

/** Git repositories first, then exact and prefix matches, then the shallowest folder. */
export function rankFolderSearchCandidates(
  candidates: ReadonlyArray<FolderSearchRankedCandidate>,
  query: string,
): FolderSearchRankedCandidate[] {
  return [...candidates].sort(
    (left, right) =>
      left.rootIndex - right.rootIndex ||
      Number(right.gitRepository) - Number(left.gitRepository) ||
      folderNameRank(left.name, query) - folderNameRank(right.name, query) ||
      left.depth - right.depth ||
      left.name.localeCompare(right.name) ||
      left.path.localeCompare(right.path),
  );
}

const TRAILING_PATH_SEPARATORS = /\/+$/u;

/** The drive roots Windows can open, in letter order. */
export const windowsDriveRoots = Effect.fn("HoustonProjectFolderSearch.windowsDriveRoots")(
  function* (
    platform: string,
    isAccessible: (root: string) => Promise<boolean>,
  ): Effect.fn.Return<ReadonlyArray<string>> {
    if (platform !== "win32") return [];
    const roots = Array.from({ length: 26 }, (_, index) => `${String.fromCharCode(65 + index)}:\\`);
    const found = yield* Effect.promise(() =>
      Promise.all(
        roots.map((root) => isAccessible(root).then((accessible) => (accessible ? root : null))),
      ),
    );
    return found.filter((root): root is string => root !== null);
  },
);

function pathKey(value: string): string {
  return value.toLowerCase().replaceAll("\\", "/").replace(TRAILING_PATH_SEPARATORS, "");
}

/** Bounded add-project folder search; reads directory entries only, never file contents. */
export const searchProjectFolders = Effect.fn("HoustonProjectFolderSearch.search")(function* (
  input: SearchInput,
): Effect.fn.Return<HoustonProjectFolderSearchResult, never, Path.Path> {
  const path = yield* Path.Path;
  const platform = yield* HostProcess.Platform;
  const home = yield* HostProcess.HomeDirectory;

  const resolveHostPath = (value: string): string => path.resolve(expandHomePath(value, home));

  const readDirectory = (directory: string) =>
    Effect.tryPromise({
      try: () => NodeFSP.readdir(directory, { withFileTypes: true }),
      catch: () => null,
    }).pipe(Effect.orElseSucceed(() => []));

  const isGitRepository = (folderPath: string): Promise<boolean> =>
    NodeFSP.stat(path.join(folderPath, ".git")).then(
      (stat) => stat.isDirectory() || stat.isFile(),
      () => false,
    );

  const windowsDrives = () =>
    windowsDriveRoots(platform, (root) =>
      NodeFSP.stat(root).then(
        (stat) => stat.isDirectory(),
        () => false,
      ),
    );

  const homePath = resolveHostPath(home);
  const projectParents = [
    ...new Set(input.projectFolders.map((folder) => path.dirname(resolveHostPath(folder)))),
  ];
  const baseDirectory =
    input.baseDirectory === undefined || input.baseDirectory.trim().length === 0
      ? null
      : resolveHostPath(input.baseDirectory.trim());

  const seenPlaces = new Set<string>();
  const places: HoustonProjectFolderPlace[] = [];
  const addPlace = (place: HoustonProjectFolderPlace) => {
    const key = pathKey(place.path);
    if (seenPlaces.has(key)) return;
    seenPlaces.add(key);
    places.push(place);
  };
  addPlace({ kind: "home", label: "Home", path: homePath });
  for (const parent of projectParents) {
    addPlace({
      kind: "project-parent",
      label: path.basename(parent) || parent,
      path: parent,
    });
  }
  if (baseDirectory !== null) {
    addPlace({ kind: "base", label: "Base folder", path: baseDirectory });
  }
  for (const drive of yield* windowsDrives()) {
    addPlace({ kind: "drive", label: drive.slice(0, 2), path: drive });
  }

  const query = input.query.trim();
  if (query.length === 0) {
    return { places, folders: [], truncated: false, scannedEntries: 0 };
  }

  // Project parents lead, then the configured base directory (home when none is set).
  const searchRoots = [
    ...new Set(
      [...projectParents, ...(baseDirectory === null ? [homePath] : [baseDirectory])].map(pathKey),
    ),
  ].map((key) => {
    const projectParent = projectParents.find((parent) => pathKey(parent) === key);
    return projectParent ?? baseDirectory ?? homePath;
  });

  const resultLimit = HOUSTON_PROJECT_FOLDER_SEARCH_LIMITS.results;
  const candidateLimit = resultLimit * 4;
  const maxDepth = HOUSTON_PROJECT_FOLDER_SEARCH_LIMITS.depth;
  const maxEntries = HOUSTON_PROJECT_FOLDER_SEARCH_LIMITS.entries;
  const startedAt = yield* Clock.currentTimeMillis;
  const deadline = startedAt + HOUSTON_PROJECT_FOLDER_SEARCH_LIMITS.timeMs;
  const candidates: FolderSearchCandidate[] = [];
  const seenCandidates = new Set<string>();
  const queue: Array<{
    readonly directory: string;
    readonly depth: number;
    readonly rootIndex: number;
  }> = searchRoots.map((root, rootIndex) => ({ directory: root, depth: 0, rootIndex }));
  let scannedEntries = 0;
  let truncated = false;

  while (queue.length > 0) {
    if ((yield* Clock.currentTimeMillis) > deadline || candidates.length >= candidateLimit) {
      truncated = true;
      break;
    }
    const current = queue.shift();
    if (current === undefined) break;
    const entries = yield* readDirectory(current.directory);
    for (const entry of entries) {
      scannedEntries += 1;
      if (scannedEntries > maxEntries) {
        truncated = true;
        break;
      }
      if (!entry.isDirectory()) continue;
      if (isSkippedFolderName(entry.name, query)) continue;
      const childDepth = current.depth + 1;
      const childPath = path.join(current.directory, entry.name);
      if (folderNameMatches(entry.name, query)) {
        const key = pathKey(childPath);
        if (!seenCandidates.has(key)) {
          seenCandidates.add(key);
          candidates.push({
            name: entry.name,
            path: childPath,
            rootIndex: current.rootIndex,
            depth: childDepth,
          });
        }
      }
      if (childDepth < maxDepth) {
        queue.push({ directory: childPath, depth: childDepth, rootIndex: current.rootIndex });
      } else {
        // Another level exists but the depth bound keeps the walk out of it.
        truncated = true;
      }
    }
    if (scannedEntries > maxEntries) break;
  }

  const ranked = rankFolderSearchCandidates(
    yield* Effect.promise(() =>
      Promise.all(
        candidates.map(async (candidate) => ({
          ...candidate,
          gitRepository: await isGitRepository(candidate.path),
        })),
      ),
    ),
    query,
  ).slice(0, resultLimit);
  if (ranked.length < candidates.length) truncated = true;

  const folders: HoustonProjectFolderMatch[] = ranked.map((candidate) => ({
    name: candidate.name,
    path: candidate.path,
    gitRepository: candidate.gitRepository,
  }));
  return { places, folders, truncated, scannedEntries };
});
