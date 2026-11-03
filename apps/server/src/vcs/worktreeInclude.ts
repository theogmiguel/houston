// Copies the ignored files a repository lists in `.worktreeinclude` into a new worktree.
// Git answers which paths match and which are ignored; nothing from the repository runs.
import type { GitCommandError } from "@houston-app/contracts";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import type * as FileSystem from "effect/FileSystem";
import type * as Path from "effect/Path";

export const INCLUDE_FILE = ".worktreeinclude";
// Local settings and secrets are a handful of small files; a longer listing is build output or
// data, which a new worktree should not copy again.
const MAX_FILES = 256;
const MAX_BYTES = 32 * 1024 * 1024;
// A warning names this many paths and counts the rest, so it stays one readable line.
const MAX_NAMED_PATHS = 5;

export interface WorktreeIncludeGitResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stdoutTruncated: boolean;
}

export type WorktreeIncludeExecute = (input: {
  readonly operation: string;
  readonly cwd: string;
  readonly args: ReadonlyArray<string>;
  readonly stdin?: string;
  readonly allowNonZeroExit?: boolean;
}) => Effect.Effect<WorktreeIncludeGitResult, GitCommandError>;

export interface WorktreeIncludeReport {
  readonly copied: ReadonlyArray<string>;
  readonly warnings: ReadonlyArray<string>;
}

const EMPTY_REPORT: WorktreeIncludeReport = { copied: [], warnings: [] };

const splitNul = (value: string): Array<string> =>
  value.split("\0").filter((entry) => entry.length > 0);

const isPlainRelative = (candidate: string, path: Path.Path): boolean => {
  if (candidate.length === 0 || path.isAbsolute(candidate)) return false;
  return candidate
    .split("/")
    .every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
};

const namePaths = (paths: ReadonlyArray<string>): string => {
  const named = paths.slice(0, MAX_NAMED_PATHS).join(", ");
  return paths.length > MAX_NAMED_PATHS
    ? `${named} (+${paths.length - MAX_NAMED_PATHS} more)`
    : named;
};

const isSymlink = (fileSystem: FileSystem.FileSystem, target: string) =>
  fileSystem.readLink(target).pipe(
    Effect.as(true),
    Effect.orElseSucceed(() => false),
  );

const inside = (root: string, target: string, path: Path.Path): boolean =>
  target === root || target.startsWith(`${root}${path.sep}`);

/**
 * Copies every file under `sourceRoot` that `.worktreeinclude` matches and git ignores into
 * `worktreePath`. Tracked files never qualify, an existing destination is never overwritten,
 * and a failure becomes a warning: the worktree stands.
 */
export const carryOverWorktreeInclude = Effect.fn("carryOverWorktreeInclude")(function* (
  execute: WorktreeIncludeExecute,
  fileSystem: FileSystem.FileSystem,
  path: Path.Path,
  input: { readonly sourceRoot: string; readonly worktreePath: string },
): Effect.fn.Return<WorktreeIncludeReport, never> {
  const warnings: Array<string> = [];
  const includePath = path.join(input.sourceRoot, INCLUDE_FILE);
  const warn = (detail: string) =>
    Effect.sync(() => {
      warnings.push(detail);
    });

  if (!(yield* fileSystem.exists(includePath).pipe(Effect.orElseSucceed(() => false)))) {
    return EMPTY_REPORT;
  }
  if (yield* isSymlink(fileSystem, includePath)) {
    yield* warn(`${INCLUDE_FILE} is a symlink; expected a regular file of gitignore patterns.`);
    return { copied: [], warnings };
  }
  const includeInfo = yield* fileSystem.stat(includePath).pipe(Effect.orElseSucceed(() => null));
  if (includeInfo === null || includeInfo.type !== "File") {
    yield* warn(`${INCLUDE_FILE} is not a regular file; expected a file of gitignore patterns.`);
    return { copied: [], warnings };
  }

  const listed = yield* execute({
    operation: "GitVcsDriver.createWorktree.worktreeInclude.list",
    cwd: input.sourceRoot,
    args: ["ls-files", "-z", "--others", "--ignored", `--exclude-from=${INCLUDE_FILE}`],
    allowNonZeroExit: true,
  }).pipe(Effect.orElseSucceed(() => null));
  if (listed === null || listed.exitCode !== 0) {
    yield* warn(`Could not read the paths ${INCLUDE_FILE} matches; nothing was copied.`);
    return { copied: [], warnings };
  }
  const matched = splitNul(listed.stdout);
  if (matched.length === 0) return { copied: [], warnings };

  const ignored = yield* execute({
    operation: "GitVcsDriver.createWorktree.worktreeInclude.checkIgnore",
    cwd: input.sourceRoot,
    args: ["check-ignore", "-z", "--stdin"],
    stdin: `${matched.join("\0")}\0`,
    allowNonZeroExit: true,
  }).pipe(Effect.orElseSucceed(() => null));
  // `check-ignore` exits 1 when nothing matches; that is an answer, not a failure.
  if (ignored === null || (ignored.exitCode !== 0 && ignored.exitCode !== 1)) {
    yield* warn(`Could not confirm which paths git ignores; nothing was copied.`);
    return { copied: [], warnings };
  }
  const candidates = [...new Set(splitNul(ignored.stdout))].sort();

  const sourceReal = yield* fileSystem
    .realPath(input.sourceRoot)
    .pipe(Effect.orElseSucceed(() => null));
  if (sourceReal === null) {
    yield* warn(`Could not resolve the checkout ${input.sourceRoot}; nothing was copied.`);
    return { copied: [], warnings };
  }

  const refused = new Map<string, Array<string>>();
  const refuse = (reason: string, file: string) => {
    const paths = refused.get(reason) ?? [];
    paths.push(file);
    refused.set(reason, paths);
  };
  const existing: Array<string> = [];
  const eligible: Array<{ path: string; size: number; mode: number }> = [];
  for (const file of candidates) {
    if (!isPlainRelative(file, path)) {
      refuse("the path leaves the checkout", file);
      continue;
    }
    const source = path.join(input.sourceRoot, file);
    if (yield* isSymlink(fileSystem, source)) {
      refuse("it is a symlink", file);
      continue;
    }
    const info = yield* fileSystem.stat(source).pipe(Effect.orElseSucceed(() => null));
    if (info === null) {
      refuse("it could not be read", file);
      continue;
    }
    if (info.type !== "File") {
      refuse("it is not a regular file", file);
      continue;
    }
    const resolved = yield* fileSystem.realPath(source).pipe(Effect.orElseSucceed(() => null));
    if (resolved === null || !inside(sourceReal, resolved, path)) {
      refuse("it resolves outside the checkout", file);
      continue;
    }
    if (
      yield* fileSystem
        .exists(path.join(input.worktreePath, file))
        .pipe(Effect.orElseSucceed(() => false))
    ) {
      existing.push(file);
      continue;
    }
    eligible.push({ path: file, size: Number(info.size), mode: info.mode & 0o777 });
  }

  const totalBytes = eligible.reduce((total, file) => total + file.size, 0);
  let copiedBytes = 0;
  const copied: Array<string> = [];
  for (const [index, file] of eligible.entries()) {
    if (copied.length >= MAX_FILES || copiedBytes + file.size > MAX_BYTES) {
      const left = eligible.slice(index).map((entry) => entry.path);
      const limit =
        copied.length >= MAX_FILES
          ? `the limit of ${MAX_FILES} files (asked for ${eligible.length} files)`
          : `the limit of ${MAX_BYTES} bytes (asked for ${totalBytes} bytes)`;
      warnings.push(
        `${INCLUDE_FILE}: copying into ${input.worktreePath} stopped at ${limit}; ` +
          `copied ${copied.length} file(s), not copied: ${namePaths(left)}`,
      );
      break;
    }
    const copiedFile = yield* copyOne(
      fileSystem,
      path,
      path.join(input.sourceRoot, file.path),
      input.worktreePath,
      file,
    ).pipe(Effect.result);
    if (Result.isFailure(copiedFile)) {
      warnings.push(
        `${INCLUDE_FILE}: ${file.path} was not copied into ${input.worktreePath}: ` +
          `${String(copiedFile.failure)}`,
      );
      continue;
    }
    copiedBytes += file.size;
    copied.push(file.path);
  }

  for (const [reason, paths] of refused) {
    warnings.push(
      `${INCLUDE_FILE}: not copied into ${input.worktreePath} because ${reason}: ${namePaths(paths)}`,
    );
  }
  if (existing.length > 0) {
    warnings.push(
      `${INCLUDE_FILE}: kept the worktree's own file, not overwritten: ${namePaths(existing)}`,
    );
  }
  for (const warning of warnings) yield* Effect.logWarning(warning);

  return { copied, warnings };
});

const copyOne = Effect.fn("copyOne")(function* (
  fileSystem: FileSystem.FileSystem,
  path: Path.Path,
  source: string,
  worktreePath: string,
  file: { readonly path: string; readonly mode: number },
) {
  const destination = path.join(worktreePath, file.path);
  let directory = worktreePath;
  for (const part of path.dirname(file.path).split("/")) {
    if (part === ".") continue;
    directory = path.join(directory, part);
    if (yield* isSymlink(fileSystem, directory)) {
      return yield* Effect.fail(`${directory} in the worktree is a symlink; expected a directory.`);
    }
    const info = yield* fileSystem.stat(directory).pipe(Effect.orElseSucceed(() => null));
    if (info === null) {
      yield* fileSystem.makeDirectory(directory);
    } else if (info.type !== "Directory") {
      return yield* Effect.fail(`${directory} in the worktree is not a directory.`);
    }
  }
  const contents = yield* fileSystem.readFile(source);
  // `wx` refuses a file that appeared after the existence check above.
  yield* fileSystem.writeFile(destination, contents, { flag: "wx", mode: file.mode });
});
