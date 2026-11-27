// Finds the git repositories a project folder covers. Discovery reads the filesystem only: a
// folder counts when `.git` is a directory, so linked worktrees and submodules (whose `.git` is a
// file) never count by walking, and declared submodules are added from `.gitmodules`.
import {
  HOUSTON_PROJECT_REPOSITORY_LIMITS,
  type HoustonProjectRepositoryNotice,
} from "@houston-app/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

export interface DiscoveredRepository {
  /** Path relative to the project folder, always with `/` separators; the root is ".". */
  readonly key: string;
  readonly root: string;
  readonly kind: "discovered" | "submodule";
}

export interface RepositoryDiscoveryResult {
  readonly repositories: ReadonlyArray<DiscoveredRepository>;
  readonly notices: ReadonlyArray<HoustonProjectRepositoryNotice>;
}

type Limits = {
  readonly [K in keyof typeof HOUSTON_PROJECT_REPOSITORY_LIMITS]?: number;
};

const LEADING_DOT_SLASH = /^\.\//;
const REGEXP_SPECIALS = /[.*+?^${}()|[\]\\]/g;
const LINE_BREAK = /\r?\n/;
const SUBMODULE_PATH_LINE = /^\s*path\s*=\s*(.+?)\s*$/;

const SKIPPED_NAMES = new Set(["node_modules"]);

const shouldSkipName = (name: string) => name.startsWith(".") || SKIPPED_NAMES.has(name);

/** A glob where `*` stays inside one path segment and `**` crosses them. */
const globToRegExp = (glob: string): RegExp | null => {
  const trimmed = glob.trim().replace(LEADING_DOT_SLASH, "");
  if (trimmed.length === 0) return null;
  let source = "^";
  for (let index = 0; index < trimmed.length; index += 1) {
    const character = trimmed[index] as string;
    if (character === "*" && trimmed[index + 1] === "*") {
      source += ".*";
      index += 1;
      if (trimmed[index + 1] === "/") index += 1;
      continue;
    }
    if (character === "*") {
      source += "[^/]*";
      continue;
    }
    if (character === "?") {
      source += "[^/]";
      continue;
    }
    source += character.replace(REGEXP_SPECIALS, "\\$&");
  }
  return new RegExp(`${source}$`);
};

const matchesIgnore = (patterns: ReadonlyArray<string>, key: string): boolean => {
  if (key === ".") return false;
  const name = key.split("/").at(-1) ?? key;
  return patterns.some((pattern) => {
    const expression = globToRegExp(pattern);
    return expression !== null && (expression.test(key) || expression.test(name));
  });
};

const parseSubmodulePaths = (contents: string): ReadonlyArray<string> =>
  contents.split(LINE_BREAK).flatMap((line) => {
    const match = SUBMODULE_PATH_LINE.exec(line);
    return match === null ? [] : [match[1] as string];
  });

/**
 * The repositories inside `projectRoot`: the folder itself when it is a repository, each direct
 * child repository, one more level inside direct children that are plain folders, and the
 * submodules declared by every repository found. `ignorePatterns` matches a repository's key or
 * its folder name, and a tripped bound is reported instead of applying.
 */
export const discoverRepositories = Effect.fn("discoverRepositories")(function* (input: {
  readonly projectRoot: string;
  readonly ignorePatterns?: ReadonlyArray<string>;
  readonly limits?: Limits;
}): Effect.fn.Return<RepositoryDiscoveryResult, never, FileSystem.FileSystem | Path.Path> {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const limits = {
    repositories: input.limits?.repositories ?? HOUSTON_PROJECT_REPOSITORY_LIMITS.repositories,
    submodulesPerRepository:
      input.limits?.submodulesPerRepository ??
      HOUSTON_PROJECT_REPOSITORY_LIMITS.submodulesPerRepository,
    scannedEntries:
      input.limits?.scannedEntries ?? HOUSTON_PROJECT_REPOSITORY_LIMITS.scannedEntries,
  };
  const projectRoot = path.resolve(input.projectRoot);
  const patterns = input.ignorePatterns ?? [];

  const repositories: Array<DiscoveredRepository> = [];
  const notices: Array<HoustonProjectRepositoryNotice> = [];
  const seen = new Set<string>();
  let scannedEntries = 0;
  let scannedEntriesReported = false;

  const statType = (target: string) =>
    fs.stat(target).pipe(
      Effect.map((info) => info.type),
      Effect.orElseSucceed(() => null),
    );

  const isDirectory = (target: string) =>
    statType(target).pipe(Effect.map((type) => type === "Directory"));

  const isRepository = (target: string) =>
    statType(path.join(target, ".git")).pipe(Effect.map((type) => type === "Directory"));

  const readDirectory = (target: string) =>
    fs.readDirectory(target).pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));

  const addRepository = Effect.fn("discoverRepositories.addRepository")(function* (
    repository: DiscoveredRepository,
  ) {
    if (matchesIgnore(patterns, repository.key)) return false;
    if (seen.has(repository.root)) return false;
    if (repositories.length >= limits.repositories) {
      notices.push({
        limit: "repositories",
        limitValue: limits.repositories,
        actual: repositories.length,
        requested: repository.key,
      });
      return false;
    }
    seen.add(repository.root);
    repositories.push(repository);
    return true;
  });

  const scanEntries = Effect.fn("discoverRepositories.scanEntries")(function* (directory: string) {
    const names = (yield* readDirectory(directory)).toSorted();
    const kept: Array<string> = [];
    for (const name of names) {
      scannedEntries += 1;
      if (scannedEntries > limits.scannedEntries) {
        if (!scannedEntriesReported) {
          scannedEntriesReported = true;
          notices.push({
            limit: "scannedEntries",
            limitValue: limits.scannedEntries,
            actual: scannedEntries,
            requested: path.join(directory, name),
          });
        }
        break;
      }
      if (shouldSkipName(name)) continue;
      if (!(yield* isDirectory(path.join(directory, name)))) continue;
      kept.push(name);
    }
    return kept;
  });

  const addSubmodules = Effect.fn("discoverRepositories.addSubmodules")(function* (
    repository: DiscoveredRepository,
  ) {
    const modulesPath = path.join(repository.root, ".gitmodules");
    const contents = yield* fs.readFileString(modulesPath).pipe(Effect.orElseSucceed(() => ""));
    if (contents.length === 0) return;
    let submodules = 0;
    for (const submodulePath of parseSubmodulePaths(contents)) {
      const key = repository.key === "." ? submodulePath : `${repository.key}/${submodulePath}`;
      submodules += 1;
      if (submodules > limits.submodulesPerRepository) {
        notices.push({
          limit: "submodulesPerRepository",
          limitValue: limits.submodulesPerRepository,
          actual: submodules - 1,
          requested: key,
        });
        break;
      }
      const root = path.join(repository.root, submodulePath);
      if (!(yield* isDirectory(root))) continue;
      yield* addRepository({ key, root, kind: "submodule" });
    }
  });

  if (yield* isRepository(projectRoot)) {
    yield* addRepository({ key: ".", root: projectRoot, kind: "discovered" });
    yield* addSubmodules({ key: ".", root: projectRoot, kind: "discovered" });
  }

  for (const name of yield* scanEntries(projectRoot)) {
    const childRoot = path.join(projectRoot, name);
    if (yield* isRepository(childRoot)) {
      const child = { key: name, root: childRoot, kind: "discovered" as const };
      yield* addRepository(child);
      yield* addSubmodules(child);
      continue;
    }
    for (const grandchild of yield* scanEntries(childRoot)) {
      const grandchildRoot = path.join(childRoot, grandchild);
      if (!(yield* isRepository(grandchildRoot))) continue;
      const repository = {
        key: `${name}/${grandchild}`,
        root: grandchildRoot,
        kind: "discovered" as const,
      };
      yield* addRepository(repository);
      yield* addSubmodules(repository);
    }
  }

  return { repositories, notices };
});
