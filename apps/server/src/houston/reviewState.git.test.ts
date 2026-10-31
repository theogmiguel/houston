// Viewed marks and comment anchors against real temporary git repositories.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import type {
  HoustonReviewAnchorMapResult,
  HoustonReviewFilesViewedResult,
  ReviewLineAnchor,
} from "@t3tools/contracts/houston/reviewState";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import type * as Scope from "effect/Scope";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerConfig from "../config.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ReviewService from "../review/ReviewService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as KnownWorkspaces from "../workspace/KnownWorkspaces.ts";
import { HoustonReviewState, layer as layerHoustonReviewState } from "./reviewState.ts";

type Review = HoustonReviewState["Service"];

/** Runs `hold` before every `git hash-object`, so a tick can be overtaken by a later press. */
const layerHeldHashing = (hold: Effect.Effect<void>) =>
  Layer.effect(
    GitVcsDriver.GitVcsDriver,
    Effect.gen(function* () {
      const real = yield* GitVcsDriver.GitVcsDriver;
      return GitVcsDriver.GitVcsDriver.of({
        ...real,
        execute: (input) =>
          input.args.includes("hash-object")
            ? hold.pipe(Effect.andThen(real.execute(input)))
            : real.execute(input),
      });
    }),
  ).pipe(Layer.provide(GitVcsDriver.layer));

const layerReview = (input: {
  readonly workspaceRoot: string;
  readonly baseDir: string;
  readonly holdHashing?: Effect.Effect<void>;
}) => {
  const git =
    input.holdHashing === undefined ? GitVcsDriver.layer : layerHeldHashing(input.holdHashing);
  return layerHoustonReviewState.pipe(
    Layer.provideMerge(ReviewService.layer),
    Layer.provideMerge(KnownWorkspaces.layer),
    Layer.provideMerge(
      Layer.mock(ProjectStore.ProjectStoreV2)({ listShells: () => Effect.succeed([]) }),
    ),
    Layer.provideMerge(
      Layer.mock(VcsDriverRegistry.VcsDriverRegistry)({
        get: () => Effect.die("unexpected VCS registry get"),
        resolve: () => Effect.die("unexpected VCS registry resolve"),
        detect: () => Effect.die("unexpected VCS registry detect"),
      }),
    ),
    Layer.provideMerge(ServerSettings.ServerSettingsService.layerTest({})),
    Layer.provideMerge(git),
    Layer.provideMerge(SqlitePersistence.layerMemory),
    Layer.provideMerge(ServerConfig.layerTest(input.workspaceRoot, input.baseDir)),
    Layer.provideMerge(NodeServices.layer),
  );
};

const git = (cwd: string, args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const driver = yield* GitVcsDriver.GitVcsDriver;
    const result = yield* driver.execute({
      operation: "HoustonReviewState.test.git",
      cwd,
      args,
      timeoutMs: 30_000,
    });
    return result.stdout.trim();
  });

const gitExit = (cwd: string, args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const driver = yield* GitVcsDriver.GitVcsDriver;
    const result = yield* driver.execute({
      operation: "HoustonReviewState.test.gitExit",
      cwd,
      args,
      allowNonZeroExit: true,
      timeoutMs: 30_000,
    });
    return result.exitCode;
  });

const write = (cwd: string, file: string, content: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const target = path.join(cwd, file);
    yield* fs.makeDirectory(path.dirname(target), { recursive: true });
    yield* fs.writeFileString(target, content);
  });

const remove = (cwd: string, file: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* fs.remove(path.join(cwd, file), { recursive: true });
  });

const commitAll = (cwd: string, message: string) =>
  git(cwd, ["add", "-A"]).pipe(Effect.andThen(git(cwd, ["commit", "-q", "-m", message])));

const configure = (cwd: string) =>
  Effect.gen(function* () {
    yield* git(cwd, ["config", "user.email", "test@test.com"]);
    yield* git(cwd, ["config", "user.name", "Test"]);
    yield* git(cwd, ["config", "core.autocrlf", "false"]);
    yield* git(cwd, ["config", "commit.gpgsign", "false"]);
  });

const initRepo = (
  cwd: string,
  files: Readonly<Record<string, string>>,
  options = { commit: true },
) =>
  Effect.gen(function* () {
    yield* git(cwd, ["init", "-q", "-b", "main"]);
    yield* configure(cwd);
    for (const [file, content] of Object.entries(files)) yield* write(cwd, file, content);
    if (options.commit) yield* commitAll(cwd, "initial");
  });

const numbered = (count: number, prefix = "line") =>
  Array.from({ length: count }, (_, index) => `${prefix} ${index + 1}`);
const text = (rows: ReadonlyArray<string>) => `${rows.join("\n")}\n`;
const LINES_20 = text(numbered(20));

/** A fresh repository as the configured workspace root, and the service over it. */
const withRepo = <A, E>(
  body: (
    repo: string,
    review: Review,
  ) => Effect.Effect<A, E, Layer.Success<ReturnType<typeof layerReview>> | Scope.Scope>,
  options: { readonly holdHashing?: Effect.Effect<void> } = {},
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const repo = yield* fs.makeTempDirectoryScoped({ prefix: "houston-review-repo-" });
    const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "houston-review-base-" });
    return yield* Effect.gen(function* () {
      const review = yield* HoustonReviewState;
      return yield* body(repo, review);
    }).pipe(
      Effect.provide(
        layerReview({
          workspaceRoot: repo,
          baseDir,
          ...(options.holdHashing === undefined ? {} : { holdHashing: options.holdHashing }),
        }),
      ),
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

const tick = (review: Review, cwd: string, ...paths: ReadonlyArray<string>) =>
  review.setFilesViewed({ cwd, files: paths.map((path) => ({ path, viewed: true })) });
const untick = (review: Review, cwd: string, ...paths: ReadonlyArray<string>) =>
  review.setFilesViewed({ cwd, files: paths.map((path) => ({ path, viewed: false })) });

const states = (result: HoustonReviewFilesViewedResult) =>
  Object.fromEntries(result.files.map((file) => [file.path, file.state]));

const viewedStates = (review: Review, cwd: string) =>
  review.filesViewed({ cwd }).pipe(Effect.map(states));

const rows = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql<{
    readonly worktree_root: string;
    readonly ref_name: string;
    readonly path: string;
    readonly head_sha: string | null;
    readonly blob: string;
  }>`SELECT worktree_root, ref_name, path, head_sha, blob FROM houston_review_files_viewed ORDER BY path`;
});

const looseObjects = (cwd: string) =>
  git(cwd, ["count-objects", "-v"]).pipe(
    Effect.map((output) => {
      const count = /^count: (\d+)$/m.exec(output)?.[1];
      const packed = /^in-pack: (\d+)$/m.exec(output)?.[1];
      return Number(count ?? "0") + Number(packed ?? "0");
    }),
  );

const pruneEverything = (cwd: string) =>
  Effect.gen(function* () {
    yield* git(cwd, ["reflog", "expire", "--expire=now", "--all"]);
    yield* git(cwd, ["gc", "-q", "--prune=now"]);
  });

const mapOne = (review: Review, cwd: string, anchor: ReviewLineAnchor, baseRef?: string) =>
  review
    .mapAnchors({ cwd, anchors: [anchor], ...(baseRef === undefined ? {} : { baseRef }) })
    .pipe(Effect.map((result: HoustonReviewAnchorMapResult) => result.anchors[0]));

// S1 - a viewed mark holds while the content it saw is the content now

describe("a tick records the head and the content it saw", () => {
  it.effect("over a clean file, an uncommitted edit, an untracked file and an absent path", () =>
    withRepo((repo, review) =>
      Effect.gen(function* () {
        yield* initRepo(repo, { "clean.ts": "clean\n", "edited.ts": "before\n" });
        yield* write(repo, "edited.ts", "after\n");
        yield* write(repo, "untracked.ts", "untracked\n");
        const head = yield* git(repo, ["rev-parse", "HEAD"]);
        const root = yield* git(repo, ["rev-parse", "--show-toplevel"]);
        const expected = [
          { path: "absent.ts", blob: "" },
          { path: "clean.ts", blob: yield* git(repo, ["rev-parse", "HEAD:clean.ts"]) },
          { path: "edited.ts", blob: yield* git(repo, ["hash-object", "edited.ts"]) },
          { path: "untracked.ts", blob: yield* git(repo, ["hash-object", "untracked.ts"]) },
        ];
        assert.notEqual(expected[2]!.blob, yield* git(repo, ["rev-parse", "HEAD:edited.ts"]));

        yield* tick(review, repo, "clean.ts", "edited.ts", "untracked.ts", "absent.ts");
        // A second tick of the same paths upserts the same rows.
        yield* tick(review, repo, "clean.ts", "edited.ts", "untracked.ts", "absent.ts");

        const stored = yield* rows;
        assert.deepEqual(
          stored.map((row) => ({ path: row.path, blob: row.blob })),
          expected,
        );
        for (const row of stored) {
          assert.equal(row.ref_name, "main");
          assert.equal(row.head_sha, head);
          assert.equal(
            row.worktree_root.replaceAll("\\", "/").toLowerCase(),
            root.replaceAll("\\", "/").toLowerCase(),
          );
        }

        const result = yield* review.filesViewed({ cwd: repo });
        assert.equal(result.headSha, head);
        assert.equal(result.refName, "main");
        assert.isFalse(result.truncated);
        assert.deepEqual(
          result.files,
          expected.map(({ path }) => ({ path, state: "viewed", headSha: head })),
        );
      }),
    ),
  );
});

describe("a commit dismisses only the files it changes", () => {
  it.effect("a.ts changed by a commit is dismissed and b.ts stays viewed", () =>
    withRepo((repo, review) =>
      Effect.gen(function* () {
        yield* initRepo(repo, { "a.ts": "a1\n", "b.ts": "b1\n" });
        yield* tick(review, repo, "a.ts", "b.ts");
        yield* write(repo, "a.ts", "a2\n");
        yield* commitAll(repo, "change a");
        assert.deepEqual(yield* viewedStates(review, repo), {
          "a.ts": "dismissed",
          "b.ts": "viewed",
        });
      }),
    ),
  );
});

describe("committing what was viewed dismisses it", () => {
  it.effect("a commit of exactly the marked uncommitted content", () =>
    withRepo((repo, review) =>
      Effect.gen(function* () {
        yield* initRepo(repo, { "a.ts": "a1\n", "b.ts": "b1\n" });
        yield* write(repo, "a.ts", "a2\n");
        yield* tick(review, repo, "a.ts", "b.ts");
        assert.deepEqual(yield* viewedStates(review, repo), { "a.ts": "viewed", "b.ts": "viewed" });
        yield* commitAll(repo, "commit what was read");
        const result = yield* review.filesViewed({ cwd: repo });
        assert.deepEqual(states(result), { "a.ts": "dismissed", "b.ts": "viewed" });
        assert.notEqual(result.headSha, result.files[0]?.headSha);
      }),
    ),
  );
});

describe("a change undone by a later commit dismisses the mark", () => {
  it.effect("change then restore", () =>
    withRepo((repo, review) =>
      Effect.gen(function* () {
        yield* initRepo(repo, { "a.ts": "a1\n" });
        yield* tick(review, repo, "a.ts");
        yield* write(repo, "a.ts", "a2\n");
        yield* commitAll(repo, "change");
        assert.deepEqual(yield* viewedStates(review, repo), { "a.ts": "dismissed" });
        yield* write(repo, "a.ts", "a1\n");
        yield* commitAll(repo, "restore");
        assert.equal(yield* git(repo, ["diff", "--name-only", "HEAD~2", "HEAD"]), "");
        assert.deepEqual(yield* viewedStates(review, repo), { "a.ts": "dismissed" });
      }),
    ),
  );
});

describe("a commit that leaves a file alone keeps its uncommitted mark", () => {
  it.effect("a.ts marked with an uncommitted edit, a commit of b.ts only", () =>
    withRepo((repo, review) =>
      Effect.gen(function* () {
        yield* initRepo(repo, { "a.ts": "a1\n", "b.ts": "b1\n" });
        yield* write(repo, "a.ts", "a2\n");
        yield* tick(review, repo, "a.ts");
        yield* write(repo, "b.ts", "b2\n");
        yield* git(repo, ["commit", "-q", "-m", "b only", "--", "b.ts"]);
        assert.deepEqual(yield* viewedStates(review, repo), { "a.ts": "viewed" });
        yield* write(repo, "a.ts", "a1\n");
        assert.deepEqual(yield* viewedStates(review, repo), { "a.ts": "dismissed" });
      }),
    ),
  );
});

describe("a mode-only commit dismisses the mark", () => {
  it.effect("chmod +x committed on a.ts", () =>
    withRepo((repo, review) =>
      Effect.gen(function* () {
        yield* initRepo(repo, { "a.ts": "a1\n", "b.ts": "b1\n" });
        yield* tick(review, repo, "a.ts", "b.ts");
        yield* git(repo, ["update-index", "--chmod=+x", "a.ts"]);
        yield* git(repo, ["commit", "-q", "-m", "a.ts executable"]);
        assert.equal(yield* git(repo, ["diff", "--name-only", "HEAD~1", "HEAD"]), "a.ts");
        assert.deepEqual(yield* viewedStates(review, repo), {
          "a.ts": "dismissed",
          "b.ts": "viewed",
        });
      }),
    ),
  );
});

describe("a rename dismisses the old path and leaves the new one unviewed", () => {
  it.effect.each([
    { name: "pure rename", edit: false },
    { name: "rename with edits", edit: true },
  ])("$name", ({ edit }) =>
    withRepo((repo, review) =>
      Effect.gen(function* () {
        yield* initRepo(repo, { "p.ts": LINES_20 });
        yield* tick(review, repo, "p.ts");
        yield* git(repo, ["mv", "p.ts", "r.ts"]);
        if (edit) yield* write(repo, "r.ts", `${LINES_20}extra\n`);
        yield* commitAll(repo, "rename");
        assert.deepEqual(yield* viewedStates(review, repo), { "p.ts": "dismissed" });
      }),
    ),
  );
});

describe("a deleted file is dismissed", () => {
  it.effect.each([
    { name: "deleted by a commit", commit: true },
    { name: "deleted in the working tree", commit: false },
  ])("$name", ({ commit }) =>
    withRepo((repo, review) =>
      Effect.gen(function* () {
        yield* initRepo(repo, { "a.ts": "a1\n", "b.ts": "b1\n" });
        yield* tick(review, repo, "a.ts", "b.ts");
        yield* remove(repo, "a.ts");
        if (commit) yield* commitAll(repo, "delete a");
        assert.deepEqual(yield* viewedStates(review, repo), {
          "a.ts": "dismissed",
          "b.ts": "viewed",
        });
      }),
    ),
  );
});

describe("a file viewed as deleted is dismissed when it returns", () => {
  it.effect(
    "viewed while absent, dismissed once it exists, viewed when the uncommitted file goes, dismissed for good once a commit adds it",
    () =>
      withRepo((repo, review) =>
        Effect.gen(function* () {
          yield* initRepo(repo, { "a.ts": "a1\n" });
          yield* tick(review, repo, "gone.ts");
          assert.deepEqual(yield* viewedStates(review, repo), { "gone.ts": "viewed" });
          yield* write(repo, "gone.ts", "back\n");
          assert.deepEqual(yield* viewedStates(review, repo), { "gone.ts": "dismissed" });
          yield* remove(repo, "gone.ts");
          assert.deepEqual(yield* viewedStates(review, repo), { "gone.ts": "viewed" });
          yield* write(repo, "gone.ts", "back\n");
          yield* commitAll(repo, "add gone");
          assert.deepEqual(yield* viewedStates(review, repo), { "gone.ts": "dismissed" });
          yield* remove(repo, "gone.ts");
          assert.deepEqual(yield* viewedStates(review, repo), { "gone.ts": "dismissed" });
        }),
      ),
  );
});

describe("rewritten history is judged by content", () => {
  it.effect("commit --amend that changes only b.ts", () =>
    withRepo((repo, review) =>
      Effect.gen(function* () {
        yield* initRepo(repo, { "a.ts": "a1\n", "b.ts": "b1\n" });
        yield* write(repo, "a.ts", "a2\n");
        yield* commitAll(repo, "work");
        yield* tick(review, repo, "a.ts", "b.ts");
        yield* write(repo, "b.ts", "b2\n");
        yield* git(repo, ["commit", "-q", "-a", "--amend", "--no-edit"]);
        assert.deepEqual(yield* viewedStates(review, repo), {
          "a.ts": "viewed",
          "b.ts": "dismissed",
        });
      }),
    ),
  );

  it.effect("rebase onto a base that changed a.ts", () =>
    withRepo((repo, review) =>
      Effect.gen(function* () {
        yield* initRepo(repo, { "a.ts": "a1\n", "b.ts": "b1\n" });
        yield* git(repo, ["switch", "-q", "-c", "feature"]);
        yield* write(repo, "c.ts", "c1\n");
        yield* commitAll(repo, "feature work");
        yield* tick(review, repo, "a.ts", "b.ts");
        yield* git(repo, ["switch", "-q", "main"]);
        yield* write(repo, "a.ts", "a2\n");
        yield* commitAll(repo, "main changes a");
        yield* git(repo, ["switch", "-q", "feature"]);
        yield* git(repo, ["rebase", "-q", "main"]);
        assert.deepEqual(yield* viewedStates(review, repo), {
          "a.ts": "dismissed",
          "b.ts": "viewed",
        });
      }),
    ),
  );

  it.effect("reset --hard to a force-pushed remote head where a.ts differs", () =>
    withRepo((repo, review) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const remote = yield* fs.makeTempDirectoryScoped({ prefix: "houston-review-remote-" });
        const other = yield* fs.makeTempDirectoryScoped({ prefix: "houston-review-other-" });
        yield* git(remote, ["init", "-q", "--bare", "-b", "main"]);
        yield* initRepo(repo, { "a.ts": "a1\n", "b.ts": "b1\n" });
        yield* git(repo, ["remote", "add", "origin", remote]);
        yield* git(repo, ["push", "-q", "-u", "origin", "main"]);
        yield* tick(review, repo, "a.ts", "b.ts");

        yield* git(other, ["clone", "-q", remote, "."]);
        yield* configure(other);
        yield* write(other, "a.ts", "a-rewritten\n");
        yield* git(other, ["commit", "-q", "-a", "--amend", "-m", "rewritten"]);
        yield* git(other, ["push", "-q", "--force", "origin", "main"]);

        yield* git(repo, ["fetch", "-q", "origin"]);
        yield* git(repo, ["reset", "-q", "--hard", "origin/main"]);
        assert.deepEqual(yield* viewedStates(review, repo), {
          "a.ts": "dismissed",
          "b.ts": "viewed",
        });
      }),
    ),
  );
});

describe("a mark whose head commit is gone is still judged", () => {
  it.effect("reflog expired and the commit pruned", () =>
    withRepo((repo, review) =>
      Effect.gen(function* () {
        yield* initRepo(repo, { "a.ts": "a1\n", "b.ts": "b1\n" });
        yield* write(repo, "b.ts", "b2\n");
        yield* commitAll(repo, "to be dropped");
        const dropped = yield* git(repo, ["rev-parse", "HEAD"]);
        yield* tick(review, repo, "a.ts", "b.ts");
        yield* git(repo, ["reset", "-q", "--hard", "HEAD~1"]);
        yield* pruneEverything(repo);
        assert.notEqual(yield* gitExit(repo, ["cat-file", "-e", `${dropped}^{commit}`]), 0);

        const result = yield* review.filesViewed({ cwd: repo });
        assert.deepEqual(states(result), { "a.ts": "viewed", "b.ts": "dismissed" });
        assert.equal(result.files[0]?.headSha, dropped);
      }),
    ),
  );
});

describe("each branch keeps its own marks", () => {
  it.effect("switch away, switch back, and switch back after a.ts changed", () =>
    withRepo((repo, review) =>
      Effect.gen(function* () {
        yield* initRepo(repo, { "a.ts": "a1\n" });
        yield* git(repo, ["switch", "-q", "-c", "feature"]);
        yield* tick(review, repo, "a.ts");
        yield* git(repo, ["switch", "-q", "main"]);
        const onMain = yield* review.filesViewed({ cwd: repo });
        assert.equal(onMain.refName, "main");
        assert.deepEqual(onMain.files, []);

        yield* git(repo, ["switch", "-q", "feature"]);
        assert.deepEqual(yield* viewedStates(review, repo), { "a.ts": "viewed" });

        yield* git(repo, ["switch", "-q", "main"]);
        yield* write(repo, "a.ts", "a2\n");
        yield* commitAll(repo, "main changes a");
        yield* git(repo, ["switch", "-q", "feature"]);
        yield* git(repo, ["merge", "-q", "--no-edit", "main"]);
        assert.deepEqual(yield* viewedStates(review, repo), { "a.ts": "dismissed" });
      }),
    ),
  );
});

describe("a detached head keys its marks by an empty ref name", () => {
  it.effect("ref name is empty while detached", () =>
    withRepo((repo, review) =>
      Effect.gen(function* () {
        yield* initRepo(repo, { "a.ts": "a1\n" });
        yield* git(repo, ["switch", "-q", "--detach"]);
        yield* tick(review, repo, "a.ts");
        assert.deepEqual(
          (yield* rows).map((row) => row.ref_name),
          [""],
        );
        const result = yield* review.filesViewed({ cwd: repo });
        assert.equal(result.refName, "");
        assert.deepEqual(states(result), { "a.ts": "viewed" });
        yield* git(repo, ["switch", "-q", "main"]);
        assert.deepEqual(yield* viewedStates(review, repo), {});
      }),
    ),
  );
});

describe("an uncommitted edit dismisses and its undo restores", () => {
  it.effect("edit then undo", () =>
    withRepo((repo, review) =>
      Effect.gen(function* () {
        yield* initRepo(repo, { "a.ts": "a1\n" });
        yield* tick(review, repo, "a.ts");
        yield* write(repo, "a.ts", "a1 edited\n");
        assert.deepEqual(yield* viewedStates(review, repo), { "a.ts": "dismissed" });
        yield* write(repo, "a.ts", "a1\n");
        assert.deepEqual(yield* viewedStates(review, repo), { "a.ts": "viewed" });
      }),
    ),
  );
});

describe("an untick deletes the mark", () => {
  it.effect("the row is gone and the path is no longer listed", () =>
    withRepo((repo, review) =>
      Effect.gen(function* () {
        yield* initRepo(repo, { "a.ts": "a1\n", "b.ts": "b1\n" });
        yield* tick(review, repo, "a.ts", "b.ts");
        yield* untick(review, repo, "a.ts");
        assert.deepEqual(
          (yield* rows).map((row) => row.path),
          ["b.ts"],
        );
        assert.deepEqual(yield* viewedStates(review, repo), { "b.ts": "viewed" });
      }),
    ),
  );
});

describe("presses on one scope apply in arrival order", () => {
  it.live("tick then untick leaves the path absent; untick then tick leaves it viewed", () => {
    // Each pair holds the tick's hashing until the untick has finished. A press waiting its turn
    // signals nothing, so the bound is how the ordered (passing) case moves on.
    let untickDone = Deferred.makeUnsafe<void>();
    const holdHashing = Effect.suspend(() => Deferred.await(untickDone)).pipe(
      Effect.timeout(Duration.seconds(2)),
      Effect.ignore,
    );
    const untickThenSignal = (review: Review, repo: string, file: string) =>
      untick(review, repo, file).pipe(
        Effect.ensuring(Effect.suspend(() => Deferred.succeed(untickDone, undefined))),
      );
    return withRepo(
      (repo, review) =>
        Effect.gen(function* () {
          yield* initRepo(repo, { "a.ts": "a1\n", "b.ts": "b1\n" });
          yield* Effect.all([tick(review, repo, "a.ts"), untickThenSignal(review, repo, "a.ts")], {
            concurrency: "unbounded",
          });
          assert.deepEqual(yield* viewedStates(review, repo), {});

          untickDone = Deferred.makeUnsafe<void>();
          yield* untickThenSignal(review, repo, "b.ts");
          yield* tick(review, repo, "b.ts");
          untickDone = Deferred.makeUnsafe<void>();
          yield* Effect.all([untickThenSignal(review, repo, "b.ts"), tick(review, repo, "b.ts")], {
            concurrency: "unbounded",
          });
          assert.deepEqual(yield* viewedStates(review, repo), { "b.ts": "viewed" });
        }),
      { holdHashing },
    );
  });
});

describe("a scope reports at most 500 marks", () => {
  it.effect("500 marks are complete; 501 return the first 500 by path", () =>
    withRepo((repo, review) =>
      Effect.gen(function* () {
        yield* initRepo(repo, { "a.ts": "a1\n" });
        const paths = Array.from(
          { length: 501 },
          (_, index) => `gone/${String(index).padStart(3, "0")}.ts`,
        );
        yield* tick(review, repo, ...paths.slice(0, 500));
        const full = yield* review.filesViewed({ cwd: repo });
        assert.equal(full.files.length, 500);
        assert.isFalse(full.truncated);

        yield* tick(review, repo, paths[500]!);
        const truncated = yield* review.filesViewed({ cwd: repo });
        assert.isTrue(truncated.truncated);
        assert.deepEqual(
          truncated.files.map((file) => file.path),
          paths.slice(0, 500),
        );
      }),
    ),
  );
});

describe("outside a git worktree there is nothing to mark", () => {
  it.effect("filesViewed is empty and setFilesViewed fails without storing", () =>
    withRepo((dir, review) =>
      Effect.gen(function* () {
        yield* write(dir, "a.ts", "a1\n");
        assert.deepEqual(yield* review.filesViewed({ cwd: dir }), {
          headSha: null,
          refName: null,
          files: [],
          truncated: false,
        });
        const error = yield* tick(review, dir, "a.ts").pipe(Effect.flip);
        assert.equal(error._tag, "GitCommandError");
        assert.equal(
          (error as { readonly operation: string }).operation,
          "houston.review.setFilesViewed",
        );
        assert.deepEqual(yield* rows, []);
      }),
    ),
  );
});

describe("a path outside the worktree is refused", () => {
  it.effect("a relative and an absolute outside path fail every method and store nothing", () =>
    withRepo((repo, review) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        yield* initRepo(repo, { "a.ts": LINES_20 });
        const outsideDir = path.join(repo, "..");
        const outsideName = `houston-review-outside-${path.basename(repo)}.txt`;
        const outside = path.join(outsideDir, outsideName);
        yield* fs.writeFileString(outside, "outside the worktree\n");
        yield* Effect.addFinalizer(() => fs.remove(outside).pipe(Effect.ignore));
        const outsideBlob = yield* git(repo, ["hash-object", "--", outside]);
        const real = yield* review.anchorLines({
          cwd: repo,
          path: "a.ts",
          side: "new",
          startLine: 1,
          endLine: 1,
        });

        for (const file of [`../${outsideName}`, outside]) {
          const operations = [
            tick(review, repo, file),
            Effect.asVoid(
              review.anchorLines({ cwd: repo, path: file, side: "new", startLine: 1, endLine: 1 }),
            ),
            Effect.asVoid(review.mapAnchors({ cwd: repo, anchors: [{ ...real, path: file }] })),
            Effect.asVoid(
              review.mapAnchors({ cwd: repo, anchors: [{ ...real, path: file, side: "old" }] }),
            ),
          ];
          for (const operation of operations) {
            const error = yield* Effect.flip(operation);
            assert.equal(error._tag, "GitCommandError", file);
          }
        }
        assert.deepEqual(yield* rows, []);
        assert.notEqual(yield* gitExit(repo, ["cat-file", "-e", outsideBlob]), 0);
      }),
    ),
  );
});

describe("marks on an unborn head are judged by content", () => {
  it.effect("head_sha is null and the mark follows the content", () =>
    withRepo((repo, review) =>
      Effect.gen(function* () {
        yield* initRepo(repo, { "a.ts": "a1\n" }, { commit: false });
        yield* tick(review, repo, "a.ts");
        assert.deepEqual(
          (yield* rows).map((row) => row.head_sha),
          [null],
        );
        const result = yield* review.filesViewed({ cwd: repo });
        assert.equal(result.headSha, null);
        assert.equal(result.refName, "main");
        assert.deepEqual(result.files, [{ path: "a.ts", state: "viewed", headSha: null }]);
        yield* write(repo, "a.ts", "a2\n");
        assert.deepEqual(yield* viewedStates(review, repo), { "a.ts": "dismissed" });
      }),
    ),
  );
});

describe("unreadable content fails the read instead of reporting viewed", () => {
  it.effect("a marked path replaced by a directory", () =>
    withRepo((repo, review) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        yield* initRepo(repo, { "a.ts": "a1\n", "b.ts": "b1\n" });
        yield* tick(review, repo, "a.ts", "b.ts");
        yield* remove(repo, "a.ts");
        yield* fs.makeDirectory(path.join(repo, "a.ts"));
        const error = yield* review.filesViewed({ cwd: repo }).pipe(Effect.flip);
        assert.equal(error._tag, "GitCommandError");
        assert.equal(
          (error as { readonly operation: string }).operation,
          "houston.review.filesViewed",
        );
      }),
    ),
  );
});

// S2 - a drafted comment knows where its lines went

describe("an anchor stores the content it was drawn on", () => {
  it.effect("new side on a clean file reuses HEAD's blob and writes nothing", () =>
    withRepo((repo, review) =>
      Effect.gen(function* () {
        yield* initRepo(repo, { "a.ts": LINES_20 });
        const before = yield* looseObjects(repo);
        const anchor = yield* review.anchorLines({
          cwd: repo,
          path: "a.ts",
          side: "new",
          startLine: 10,
          endLine: 12,
        });
        assert.deepEqual(anchor, {
          path: "a.ts",
          side: "new",
          startLine: 10,
          endLine: 12,
          headSha: yield* git(repo, ["rev-parse", "HEAD"]),
          blob: yield* git(repo, ["rev-parse", "HEAD:a.ts"]),
        });
        assert.equal(yield* looseObjects(repo), before);
        assert.equal(yield* gitExit(repo, ["cat-file", "-e", anchor.blob]), 0);
      }),
    ),
  );

  it.effect("new side on an uncommitted edit stores the edited content", () =>
    withRepo((repo, review) =>
      Effect.gen(function* () {
        yield* initRepo(repo, { "a.ts": LINES_20 });
        const edited = text(numbered(20, "edited"));
        yield* write(repo, "a.ts", edited);
        const anchor = yield* review.anchorLines({
          cwd: repo,
          path: "a.ts",
          side: "new",
          startLine: 10,
          endLine: 12,
        });
        assert.notEqual(anchor.blob, yield* git(repo, ["rev-parse", "HEAD:a.ts"]));
        assert.equal(yield* gitExit(repo, ["cat-file", "-e", anchor.blob]), 0);
        assert.equal(yield* git(repo, ["cat-file", "blob", anchor.blob]), edited.trim());
      }),
    ),
  );

  it.effect("old side stores the merge base's blob", () =>
    withRepo((repo, review) =>
      Effect.gen(function* () {
        yield* initRepo(repo, { "a.ts": LINES_20 });
        yield* git(repo, ["switch", "-q", "-c", "feature"]);
        yield* write(repo, "a.ts", text(numbered(20, "feature")));
        yield* commitAll(repo, "feature rewrites a");
        yield* git(repo, ["switch", "-q", "main"]);
        yield* write(repo, "main.ts", "main moves on\n");
        yield* commitAll(repo, "main moves on");
        yield* git(repo, ["switch", "-q", "feature"]);
        const mergeBase = yield* git(repo, ["merge-base", "main", "HEAD"]);
        const anchor = yield* review.anchorLines({
          cwd: repo,
          path: "a.ts",
          side: "old",
          startLine: 10,
          endLine: 12,
          baseRef: "main",
        });
        assert.equal(anchor.side, "old");
        assert.equal(anchor.blob, yield* git(repo, ["rev-parse", `${mergeBase}:a.ts`]));
        assert.equal(anchor.headSha, yield* git(repo, ["rev-parse", "HEAD"]));
      }),
    ),
  );
});

describe("a file over the anchor bound is refused before it is stored", () => {
  it.effect("an untracked file of 8 MiB and one byte fails and writes no object", () =>
    withRepo((repo, review) =>
      Effect.gen(function* () {
        yield* initRepo(repo, { "a.ts": "a1\n" });
        yield* write(repo, "big.txt", `${"x".repeat(8 * 1024 * 1024)}\n`);
        const blob = yield* git(repo, ["hash-object", "--", "big.txt"]);
        const error = yield* review
          .anchorLines({ cwd: repo, path: "big.txt", side: "new", startLine: 1, endLine: 1 })
          .pipe(Effect.flip);
        assert.equal(error._tag, "GitCommandError");
        assert.notEqual(yield* gitExit(repo, ["cat-file", "-e", blob]), 0);
      }),
    ),
  );
});

describe("an anchor outside the file is refused with its line count", () => {
  it.effect(
    "accepts 10-12 of 12 lines and refuses 10-13, end before start and an absent old side",
    () =>
      withRepo((repo, review) =>
        Effect.gen(function* () {
          yield* initRepo(repo, { "a.ts": text(numbered(12)) });
          const anchor = (input: {
            readonly path?: string;
            readonly side?: "new" | "old";
            readonly startLine: number;
            readonly endLine: number;
          }) =>
            review.anchorLines({
              cwd: repo,
              path: input.path ?? "a.ts",
              side: input.side ?? "new",
              startLine: input.startLine,
              endLine: input.endLine,
              baseRef: "main",
            });
          const accepted = yield* anchor({ startLine: 10, endLine: 12 });
          assert.equal(accepted.endLine, 12);

          const tooLong = yield* anchor({ startLine: 10, endLine: 13 }).pipe(Effect.flip);
          assert.deepInclude(tooLong, {
            _tag: "HoustonReviewAnchorRangeError",
            path: "a.ts",
            side: "new",
            startLine: 10,
            endLine: 13,
            lineCount: 12,
          });

          const reversed = yield* anchor({ startLine: 12, endLine: 10 }).pipe(Effect.flip);
          assert.deepInclude(reversed, {
            _tag: "HoustonReviewAnchorRangeError",
            startLine: 12,
            endLine: 10,
            lineCount: 12,
          });

          yield* git(repo, ["switch", "-q", "-c", "feature"]);
          yield* write(repo, "new.ts", text(numbered(5)));
          yield* commitAll(repo, "add new.ts");
          const absent = yield* anchor({
            path: "new.ts",
            side: "old",
            startLine: 1,
            endLine: 1,
          }).pipe(Effect.flip);
          assert.deepInclude(absent, {
            _tag: "HoustonReviewAnchorRangeError",
            path: "new.ts",
            side: "old",
            lineCount: 0,
          });
        }),
      ),
  );
});

describe("an anchor follows a committed rename", () => {
  it.effect("git mv a.ts b.ts maps current at b.ts", () =>
    withRepo((repo, review) =>
      Effect.gen(function* () {
        yield* initRepo(repo, { "a.ts": LINES_20 });
        const anchor = yield* review.anchorLines({
          cwd: repo,
          path: "a.ts",
          side: "new",
          startLine: 10,
          endLine: 12,
        });
        yield* git(repo, ["mv", "a.ts", "b.ts"]);
        yield* commitAll(repo, "rename");
        assert.deepEqual(yield* mapOne(review, repo, anchor), {
          state: "current",
          path: "b.ts",
          startLine: 10,
          endLine: 12,
        });
      }),
    ),
  );
});

describe("an anchor on a deleted file is outdated", () => {
  it.effect("a.ts deleted, and a.ts gone with the anchor's head commit pruned", () =>
    withRepo((repo, review) =>
      Effect.gen(function* () {
        yield* initRepo(repo, { "keep.ts": "keep\n" });
        yield* write(repo, "a.ts", LINES_20);
        yield* commitAll(repo, "add a");
        const anchor = yield* review.anchorLines({
          cwd: repo,
          path: "a.ts",
          side: "new",
          startLine: 10,
          endLine: 12,
        });
        yield* git(repo, ["rm", "-q", "a.ts"]);
        yield* commitAll(repo, "delete a");
        assert.deepEqual(yield* mapOne(review, repo, anchor), {
          state: "outdated",
          path: "a.ts",
          reason: "deleted",
        });

        yield* git(repo, ["reset", "-q", "--hard", "HEAD~2"]);
        yield* pruneEverything(repo);
        assert.notEqual(yield* gitExit(repo, ["cat-file", "-e", `${anchor.headSha}^{commit}`]), 0);
        assert.deepEqual(yield* mapOne(review, repo, anchor), {
          state: "outdated",
          path: "a.ts",
          reason: "deleted",
        });
      }),
    ),
  );
});

describe("a pruned anchor is unavailable", () => {
  it.effect("an anchor on uncommitted lines after gc --prune=now", () =>
    withRepo((repo, review) =>
      Effect.gen(function* () {
        yield* initRepo(repo, { "a.ts": LINES_20 });
        yield* write(repo, "a.ts", text(numbered(20, "uncommitted")));
        const anchor = yield* review.anchorLines({
          cwd: repo,
          path: "a.ts",
          side: "new",
          startLine: 10,
          endLine: 12,
        });
        yield* git(repo, ["checkout", "--", "a.ts"]);
        yield* pruneEverything(repo);
        assert.notEqual(yield* gitExit(repo, ["cat-file", "-e", anchor.blob]), 0);
        assert.deepEqual(yield* mapOne(review, repo, anchor), {
          state: "outdated",
          path: "a.ts",
          reason: "unavailable",
        });
      }),
    ),
  );
});

describe("a deleted-line anchor follows the merge base", () => {
  it.effect("current after branch commits, outdated after a rebase onto changed lines", () =>
    withRepo((repo, review) =>
      Effect.gen(function* () {
        yield* initRepo(repo, { "a.ts": LINES_20 });
        yield* git(repo, ["switch", "-q", "-c", "feature"]);
        const featureRows = numbered(20);
        featureRows[1] = "feature line 2";
        yield* write(repo, "a.ts", text(featureRows));
        yield* commitAll(repo, "feature edits line 2");
        const anchor = yield* review.anchorLines({
          cwd: repo,
          path: "a.ts",
          side: "old",
          startLine: 10,
          endLine: 12,
          baseRef: "main",
        });

        yield* write(repo, "c.ts", "c1\n");
        yield* commitAll(repo, "more feature work");
        assert.deepEqual(yield* mapOne(review, repo, anchor, "main"), {
          state: "current",
          path: "a.ts",
          startLine: 10,
          endLine: 12,
        });

        yield* git(repo, ["switch", "-q", "main"]);
        const mainRows = numbered(20);
        mainRows[10] = "main line 11";
        yield* write(repo, "a.ts", text(mainRows));
        yield* commitAll(repo, "main edits line 11");
        yield* git(repo, ["switch", "-q", "feature"]);
        yield* git(repo, ["rebase", "-q", "main"]);
        assert.deepEqual(yield* mapOne(review, repo, anchor, "main"), {
          state: "outdated",
          path: "a.ts",
          reason: "changed",
        });
      }),
    ),
  );
});

describe("anchors map by content across rewrites and branches", () => {
  it.effect("amend, branch switch and reset --hard", () =>
    withRepo((repo, review) =>
      Effect.gen(function* () {
        yield* initRepo(repo, { "a.ts": LINES_20 });
        yield* git(repo, ["switch", "-q", "-c", "feature"]);
        yield* write(repo, "b.ts", "b1\n");
        yield* commitAll(repo, "feature work");
        const anchor = yield* review.anchorLines({
          cwd: repo,
          path: "a.ts",
          side: "new",
          startLine: 10,
          endLine: 12,
        });

        yield* write(repo, "a.ts", text(["x", "y", "z", ...numbered(20)]));
        yield* git(repo, ["commit", "-q", "-a", "--amend", "--no-edit"]);
        assert.deepEqual(yield* mapOne(review, repo, anchor), {
          state: "moved",
          path: "a.ts",
          startLine: 13,
          endLine: 15,
        });

        yield* git(repo, ["switch", "-q", "main"]);
        assert.deepEqual(yield* mapOne(review, repo, anchor), {
          state: "current",
          path: "a.ts",
          startLine: 10,
          endLine: 12,
        });

        yield* git(repo, ["switch", "-q", "-c", "other"]);
        const otherRows = numbered(20);
        otherRows[10] = "other line 11";
        yield* write(repo, "a.ts", text(otherRows));
        yield* commitAll(repo, "other edits line 11");
        const otherHead = yield* git(repo, ["rev-parse", "HEAD"]);
        yield* git(repo, ["switch", "-q", "feature"]);
        yield* git(repo, ["reset", "-q", "--hard", otherHead]);
        assert.deepEqual(yield* mapOne(review, repo, anchor), {
          state: "outdated",
          path: "a.ts",
          reason: "changed",
        });
      }),
    ),
  );
});

describe("mappings come back in input order", () => {
  it.effect("moved, outdated and current in the order sent", () =>
    withRepo((repo, review) =>
      Effect.gen(function* () {
        yield* initRepo(repo, { "a.ts": LINES_20 });
        const anchorAt = (startLine: number, endLine: number) =>
          review.anchorLines({ cwd: repo, path: "a.ts", side: "new", startLine, endLine });
        const current = yield* anchorAt(2, 3);
        const moved = yield* anchorAt(10, 12);
        const outdated = yield* anchorAt(18, 18);
        const rows = numbered(20);
        rows[17] = "edited line 18";
        rows.splice(5, 0, "inserted a", "inserted b");
        yield* write(repo, "a.ts", text(rows));

        const result = yield* review.mapAnchors({ cwd: repo, anchors: [moved, outdated, current] });
        assert.deepEqual(result.anchors, [
          { state: "moved", path: "a.ts", startLine: 12, endLine: 14 },
          { state: "outdated", path: "a.ts", reason: "changed" },
          { state: "current", path: "a.ts", startLine: 2, endLine: 3 },
        ]);
      }),
    ),
  );
});

describe("an anchor id never reaches git as an option", () => {
  it.effect("an --output headSha or blob leaves a file outside the repository unchanged", () =>
    withRepo((repo, review) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const outside = yield* fs.makeTempDirectoryScoped({ prefix: "houston-review-victim-" });
        const victim = path.join(outside, "victim.txt");
        yield* fs.writeFileString(victim, "precious content\n");
        yield* initRepo(repo, { "a.ts": LINES_20 });
        const real = yield* review.anchorLines({
          cwd: repo,
          path: "a.ts",
          side: "new",
          startLine: 10,
          endLine: 12,
        });
        const option = `--output=${victim}`;
        // The service is called past the contract's decode, as a defect upstream of it would.
        const result = yield* review.mapAnchors({
          cwd: repo,
          anchors: [
            { ...real, path: "gone.ts", headSha: option },
            { ...real, blob: option },
          ],
        });
        assert.equal(yield* fs.readFileString(victim), "precious content\n");
        assert.deepEqual(result.anchors, [
          { state: "outdated", path: "gone.ts", reason: "deleted" },
          { state: "outdated", path: "a.ts", reason: "unavailable" },
        ]);
      }),
    ),
  );
});
