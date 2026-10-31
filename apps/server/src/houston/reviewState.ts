// Viewed marks and comment anchors for the local Changes review. A mark clears when a commit since
// it touches the file, or when the content differs; anchors map by content.
import { GitCommandError, type ReviewDiffPreviewError } from "@t3tools/contracts";
import {
  HoustonReviewAnchorRangeError,
  type HoustonReviewAnchorLinesInput,
  type HoustonReviewAnchorMapping,
  type HoustonReviewAnchorMapResult,
  type HoustonReviewFilesViewedInput,
  type HoustonReviewFilesViewedResult,
  type HoustonReviewFileViewedState,
  type HoustonReviewMapAnchorsInput,
  type HoustonReviewSetFilesViewedInput,
  type ReviewLineAnchor,
} from "@t3tools/contracts/houston/reviewState";
import { diffArrays } from "diff";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Semaphore from "effect/Semaphore";

import * as ReviewService from "../review/ReviewService.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as ReviewFilesViewed from "./reviewFilesViewed.ts";

/** A mark is viewed exactly while the path's content is the content it was marked on. */
export const judgeMark = (markedBlob: string, currentBlob: string): HoustonReviewFileViewedState =>
  markedBlob === currentBlob ? "viewed" : "dismissed";

const splitLines = (content: string): Array<string> => {
  if (content.length === 0) return [];
  const lines = content.split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  return lines;
};

export type AnchorLineMapping =
  | { readonly state: "current" | "moved"; readonly startLine: number; readonly endLine: number }
  | { readonly state: "outdated"; readonly reason: "changed" };

// Maps a line range of `before` into `after`: lines inserted or removed above shift it, a change
// inside outdates it, and changes below do not count.
export const mapAnchor = (input: {
  readonly before: string;
  readonly after: string;
  readonly startLine: number;
  readonly endLine: number;
}): AnchorLineMapping => {
  const { startLine, endLine } = input;
  const changed = { state: "outdated", reason: "changed" } as const;
  let consumed = 0;
  let shift = 0;
  for (const part of diffArrays(splitLines(input.before), splitLines(input.after))) {
    const count = part.value.length;
    if (part.added) {
      // Inserted after old line `consumed`.
      if (consumed < startLine) shift += count;
      else if (consumed < endLine) return changed;
    } else if (part.removed) {
      if (consumed + count < startLine) shift -= count;
      else if (consumed + 1 <= endLine) return changed;
      consumed += count;
    } else {
      consumed += count;
    }
  }
  return {
    state: shift === 0 ? "current" : "moved",
    startLine: startLine + shift,
    endLine: endLine + shift,
  };
};

// Larger files are refused rather than anchored on a truncated read.
const MAX_ANCHORED_FILE_BYTES = 8 * 1024 * 1024;

type Operation =
  | "houston.review.filesViewed"
  | "houston.review.setFilesViewed"
  | "houston.review.anchorLines"
  | "houston.review.mapAnchors";

export class HoustonReviewState extends Context.Service<
  HoustonReviewState,
  {
    readonly filesViewed: (
      input: HoustonReviewFilesViewedInput,
    ) => Effect.Effect<HoustonReviewFilesViewedResult, ReviewDiffPreviewError>;
    readonly setFilesViewed: (
      input: HoustonReviewSetFilesViewedInput,
    ) => Effect.Effect<void, ReviewDiffPreviewError>;
    readonly anchorLines: (
      input: HoustonReviewAnchorLinesInput,
    ) => Effect.Effect<ReviewLineAnchor, ReviewDiffPreviewError | HoustonReviewAnchorRangeError>;
    readonly mapAnchors: (
      input: HoustonReviewMapAnchorsInput,
    ) => Effect.Effect<HoustonReviewAnchorMapResult, ReviewDiffPreviewError>;
  }
>()("houston/houston/reviewState/HoustonReviewState") {}

interface Repository {
  readonly root: string;
  readonly refName: string;
  readonly headSha: string | null;
}

export const make = Effect.gen(function* () {
  const review = yield* ReviewService.ReviewService;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const store = yield* ReviewFilesViewed.HoustonReviewFilesViewed;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const run = (
    operation: Operation,
    cwd: string,
    args: ReadonlyArray<string>,
    options: { readonly stdin?: string; readonly allowNonZeroExit?: boolean } = {},
  ) =>
    git.execute({
      operation,
      cwd,
      args,
      maxOutputBytes: MAX_ANCHORED_FILE_BYTES,
      ...options,
    });

  const failure = (operation: Operation, cwd: string, command: string, detail: string) =>
    new GitCommandError({ operation, command, cwd, detail });

  const readRepository = Effect.fn("HoustonReviewState.readRepository")(function* (
    operation: Operation,
    cwd: string,
  ) {
    const top = yield* run(operation, cwd, ["rev-parse", "--show-toplevel"], {
      allowNonZeroExit: true,
    });
    const root = top.stdout.trim();
    if (top.exitCode !== 0 || root.length === 0) return null;
    const head = yield* run(operation, root, ["rev-parse", "--verify", "--quiet", "HEAD"], {
      allowNonZeroExit: true,
    });
    const ref = yield* run(operation, root, ["symbolic-ref", "--quiet", "--short", "HEAD"], {
      allowNonZeroExit: true,
    });
    return {
      root,
      headSha: head.exitCode === 0 ? head.stdout.trim() : null,
      refName: ref.exitCode === 0 ? ref.stdout.trim() : "",
    } satisfies Repository;
  });

  const requireRepository = (operation: Operation, cwd: string) =>
    readRepository(operation, cwd).pipe(
      Effect.filterOrFail(
        (repository): repository is Repository => repository !== null,
        () =>
          failure(
            operation,
            cwd,
            "git rev-parse --show-toplevel",
            "This folder is not inside a git worktree.",
          ),
      ),
    );

  const worktreePath = (operation: Operation, root: string, file: string) => {
    const absolute = path.resolve(root, file);
    const relative = path.relative(root, absolute);
    return relative.length === 0 || relative.startsWith("..") || path.isAbsolute(relative)
      ? Effect.fail(
          failure(
            operation,
            root,
            "git hash-object",
            `The path '${file}' is outside the worktree ${root}.`,
          ),
        )
      : Effect.succeed(absolute);
  };

  const isFile = (absolute: string) =>
    fileSystem.stat(absolute).pipe(
      Effect.map((info) => info.type === "File"),
      Effect.orElseSucceed(() => false),
    );

  const exists = (absolute: string) =>
    fileSystem.exists(absolute).pipe(Effect.orElseSucceed(() => false));

  /** Blob ids of the paths' working-tree content, "" for an absent path. */
  const currentBlobs = Effect.fn("HoustonReviewState.currentBlobs")(function* (
    operation: Operation,
    root: string,
    files: ReadonlyArray<string>,
  ) {
    const present: Array<string> = [];
    for (const file of files) {
      if (yield* exists(yield* worktreePath(operation, root, file))) present.push(file);
    }
    const hashes = new Map<string, string>();
    if (present.length > 0) {
      const result = yield* run(operation, root, ["hash-object", "--stdin-paths"], {
        stdin: `${present.join("\n")}\n`,
      });
      const ids = result.stdout.trim().split("\n");
      if (ids.length !== present.length) {
        return yield* failure(
          operation,
          root,
          "git hash-object --stdin-paths",
          `Expected ${present.length} blob ids, read ${ids.length}.`,
        );
      }
      present.forEach((file, index) => hashes.set(file, ids[index]!.trim()));
    }
    return files.map((file) => hashes.get(file) ?? "");
  });

  const readBlob = Effect.fn("HoustonReviewState.readBlob")(function* (
    operation: Operation,
    root: string,
    blob: string,
  ) {
    const result = yield* run(operation, root, ["cat-file", "blob", "--end-of-options", blob]);
    if (result.stdoutTruncated) {
      return yield* failure(
        operation,
        root,
        "git cat-file blob",
        `Blob ${blob} is larger than ${MAX_ANCHORED_FILE_BYTES} bytes.`,
      );
    }
    return result.stdout;
  });

  /** The blob id of `file` at `rev`, or null when the path is absent there. */
  const blobAt = (operation: Operation, root: string, rev: string, file: string) =>
    run(
      operation,
      root,
      ["rev-parse", "--verify", "--quiet", "--end-of-options", `${rev}:${file}`],
      {
        allowNonZeroExit: true,
      },
    ).pipe(Effect.map((result) => (result.exitCode === 0 ? result.stdout.trim() : null)));

  const mergeBaseOf = (operation: Operation, root: string, baseRef: string | undefined) =>
    baseRef === undefined
      ? Effect.succeed("HEAD")
      : run(operation, root, ["merge-base", "--end-of-options", baseRef, "HEAD"]).pipe(
          Effect.map((result) => result.stdout.trim()),
        );

  /** Where a rename committed between `fromSha` and `HEAD` took `file`; null when there was none. */
  const renamedTo = Effect.fn("HoustonReviewState.renamedTo")(function* (
    operation: Operation,
    root: string,
    fromSha: string | null,
    file: string,
  ) {
    if (fromSha === null) return null;
    const result = yield* run(
      operation,
      root,
      ["diff", "-M", "--name-status", "--diff-filter=R", "-z", "--end-of-options", fromSha, "HEAD"],
      { allowNonZeroExit: true },
    );
    if (result.exitCode !== 0) return null;
    const fields = result.stdout.split("\0");
    for (let index = 0; index + 2 < fields.length; index += 3) {
      if (fields[index]?.startsWith("R") && fields[index + 1] === file) {
        return fields[index + 2] ?? null;
      }
    }
    return null;
  });

  // Paths a commit between `fromSha` and `HEAD` touched, mode changes included; null once `fromSha`
  // is no longer an ancestor of `HEAD` (rebase, reset, force-push, pruned).
  const touchedSince = Effect.fn("HoustonReviewState.touchedSince")(function* (
    operation: Operation,
    root: string,
    fromSha: string,
  ) {
    const ancestor = yield* run(
      operation,
      root,
      ["merge-base", "--is-ancestor", "--end-of-options", fromSha, "HEAD"],
      { allowNonZeroExit: true },
    );
    if (ancestor.exitCode !== 0) return null;
    // The net diff sees what a merge brought in; the log sees a change a later commit undid.
    const net = yield* run(operation, root, [
      "diff",
      "--name-only",
      "--no-renames",
      "-z",
      "--end-of-options",
      fromSha,
      "HEAD",
    ]);
    const each = yield* run(operation, root, [
      "log",
      "--name-only",
      "--no-renames",
      "--format=",
      "-z",
      "--end-of-options",
      `${fromSha}..HEAD`,
    ]);
    if (net.stdoutTruncated || each.stdoutTruncated) {
      return yield* failure(
        operation,
        root,
        "git log --name-only",
        `The files changed since ${fromSha} exceed ${MAX_ANCHORED_FILE_BYTES} bytes of output.`,
      );
    }
    return new Set(
      `${net.stdout}\0${each.stdout}`
        .split("\0")
        .map((file) => file.replace(/^\n+/, ""))
        .filter((file) => file.length > 0),
    );
  });

  // Serialize presses so a slower tick cannot overwrite a later untick. The key is the request's
  // cwd: the scope (worktree root and ref) is only known after git answers.
  const pressGates = new Map<string, { readonly gate: Semaphore.Semaphore; pending: number }>();
  const inPressOrder = <A, E>(cwd: string, press: Effect.Effect<A, E>) =>
    Effect.suspend(() => {
      const held = pressGates.get(cwd);
      const entry = held ?? { gate: Semaphore.makeUnsafe(1), pending: 0 };
      if (held === undefined) pressGates.set(cwd, entry);
      entry.pending += 1;
      return entry.gate
        .withPermits(1)(press)
        .pipe(
          Effect.ensuring(
            Effect.sync(() => {
              entry.pending -= 1;
              if (entry.pending === 0) pressGates.delete(cwd);
            }),
          ),
        );
    });

  const filesViewed: HoustonReviewState["Service"]["filesViewed"] = Effect.fn(
    "HoustonReviewState.filesViewed",
  )(function* (input) {
    const operation = "houston.review.filesViewed";
    yield* review.assertWorkspaceBoundCwd(operation, input.cwd);
    const repository = yield* readRepository(operation, input.cwd);
    if (repository === null) return { headSha: null, refName: null, files: [], truncated: false };
    const page = yield* store
      .list({ worktreeRoot: repository.root, refName: repository.refName })
      .pipe(Effect.orDie);
    const current = yield* currentBlobs(
      operation,
      repository.root,
      page.files.map((mark) => mark.path),
    );
    // A commit that touched the file since its mark clears it; content decides otherwise.
    const touched = new Map<string, ReadonlySet<string> | null>();
    if (repository.headSha !== null) {
      for (const mark of page.files) {
        if (mark.headSha === null || touched.has(mark.headSha)) continue;
        touched.set(
          mark.headSha,
          mark.headSha === repository.headSha
            ? new Set()
            : yield* touchedSince(operation, repository.root, mark.headSha),
        );
      }
    }
    const rootRelative = (file: string) =>
      path.relative(repository.root, path.resolve(repository.root, file)).split(path.sep).join("/");
    return {
      headSha: repository.headSha,
      refName: repository.refName,
      files: page.files.map((mark, index) => ({
        path: mark.path,
        state:
          mark.headSha !== null && touched.get(mark.headSha)?.has(rootRelative(mark.path))
            ? "dismissed"
            : judgeMark(mark.blob, current[index]!),
        headSha: mark.headSha,
      })),
      truncated: page.truncated,
    };
  });

  const setFilesViewed: HoustonReviewState["Service"]["setFilesViewed"] = (input) =>
    inPressOrder(
      input.cwd,
      Effect.gen(function* () {
        const operation = "houston.review.setFilesViewed";
        yield* review.assertWorkspaceBoundCwd(operation, input.cwd);
        const repository = yield* requireRepository(operation, input.cwd);
        const ticked = input.files.filter((file) => file.viewed).map((file) => file.path);
        for (const file of input.files) yield* worktreePath(operation, repository.root, file.path);
        const blobs = yield* currentBlobs(operation, repository.root, ticked);
        const blobOf = new Map(ticked.map((file, index) => [file, blobs[index]!]));
        yield* store
          .set({
            worktreeRoot: repository.root,
            refName: repository.refName,
            headSha: repository.headSha,
            files: input.files.map((file) => ({
              path: file.path,
              viewed: file.viewed,
              blob: blobOf.get(file.path) ?? "",
            })),
            viewedAt: DateTime.formatIso(yield* DateTime.now),
          })
          .pipe(Effect.orDie);
      }),
    ).pipe(Effect.withSpan("HoustonReviewState.setFilesViewed"));

  const anchorLines: HoustonReviewState["Service"]["anchorLines"] = Effect.fn(
    "HoustonReviewState.anchorLines",
  )(function* (input) {
    const operation = "houston.review.anchorLines";
    yield* review.assertWorkspaceBoundCwd(operation, input.cwd);
    const repository = yield* requireRepository(operation, input.cwd);
    const absolute = yield* worktreePath(operation, repository.root, input.path);
    let blob: string | null = null;
    if (input.side === "new") {
      if (yield* exists(absolute)) {
        const size = yield* fileSystem.stat(absolute).pipe(
          Effect.map((info) => Number(info.size)),
          Effect.orElseSucceed(() => 0),
        );
        if (size > MAX_ANCHORED_FILE_BYTES) {
          return yield* failure(
            operation,
            repository.root,
            "git hash-object -w",
            `The file '${input.path}' is larger than ${MAX_ANCHORED_FILE_BYTES} bytes.`,
          );
        }
        const written = yield* run(operation, repository.root, [
          "hash-object",
          "-w",
          "--",
          input.path,
        ]);
        blob = written.stdout.trim();
      }
    } else {
      const mergeBase = yield* mergeBaseOf(operation, repository.root, input.baseRef);
      blob = yield* blobAt(operation, repository.root, mergeBase, input.path);
    }
    const lineCount =
      blob === null ? 0 : splitLines(yield* readBlob(operation, repository.root, blob)).length;
    if (blob === null || input.endLine < input.startLine || input.endLine > lineCount) {
      return yield* new HoustonReviewAnchorRangeError({
        path: input.path,
        side: input.side,
        startLine: input.startLine,
        endLine: input.endLine,
        lineCount,
      });
    }
    return {
      path: input.path,
      side: input.side,
      startLine: input.startLine,
      endLine: input.endLine,
      headSha: repository.headSha,
      blob,
    };
  });

  const mapAnchors: HoustonReviewState["Service"]["mapAnchors"] = Effect.fn(
    "HoustonReviewState.mapAnchors",
  )(function* (input) {
    const operation = "houston.review.mapAnchors";
    yield* review.assertWorkspaceBoundCwd(operation, input.cwd);
    const repository = yield* requireRepository(operation, input.cwd);
    const { root } = repository;
    const mergeBase = input.anchors.some((anchor) => anchor.side === "old")
      ? yield* mergeBaseOf(operation, root, input.baseRef)
      : "HEAD";

    const currentContent = Effect.fn("HoustonReviewState.currentContent")(function* (
      side: ReviewLineAnchor["side"],
      file: string,
    ) {
      const absolute = yield* worktreePath(operation, root, file);
      if (side === "new") {
        if (!(yield* isFile(absolute))) return null;
        return yield* fileSystem
          .readFileString(absolute)
          .pipe(
            Effect.mapError(() =>
              failure(operation, root, "read", `Could not read '${file}' in the worktree.`),
            ),
          );
      }
      const blob = yield* blobAt(operation, root, mergeBase, file);
      return blob === null ? null : yield* readBlob(operation, root, blob);
    });

    const mapOne = Effect.fn("HoustonReviewState.mapOne")(function* (
      anchor: ReviewLineAnchor,
    ): Effect.fn.Return<HoustonReviewAnchorMapping, ReviewDiffPreviewError> {
      let currentPath = anchor.path;
      let after = yield* currentContent(anchor.side, anchor.path);
      if (after === null) {
        const renamed = yield* renamedTo(operation, root, anchor.headSha, anchor.path);
        if (renamed !== null) {
          currentPath = renamed;
          after = yield* currentContent(anchor.side, renamed);
        }
      }
      if (after === null) return { state: "outdated", path: anchor.path, reason: "deleted" };
      const present = yield* run(
        operation,
        root,
        ["cat-file", "-e", "--end-of-options", anchor.blob],
        {
          allowNonZeroExit: true,
        },
      );
      if (present.exitCode !== 0) {
        return { state: "outdated", path: currentPath, reason: "unavailable" };
      }
      const before = yield* readBlob(operation, root, anchor.blob);
      const mapped = mapAnchor({
        before,
        after,
        startLine: anchor.startLine,
        endLine: anchor.endLine,
      });
      return mapped.state === "outdated"
        ? { state: "outdated", path: currentPath, reason: mapped.reason }
        : { ...mapped, path: currentPath };
    });

    return { anchors: yield* Effect.forEach(input.anchors, mapOne) };
  });

  return HoustonReviewState.of({ filesViewed, setFilesViewed, anchorLines, mapAnchors });
});

export const layer = Layer.effect(HoustonReviewState, make).pipe(
  Layer.provide(ReviewFilesViewed.layer),
);
