import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { ChildProcessSpawner } from "effect/process";

import * as ServerConfig from "../config.ts";
import * as GitVcsDriver from "./GitVcsDriver.ts";
import * as VcsProcess from "./VcsProcess.ts";

// The Diff panel requests one file at a time. A copy of a 5,000-entry index plus three extra
// git processes cost more than the intent-to-add the single file needs.
const TRACKED_INDEX_FILES = 5_000;
const SINGLE_FILE_REQUESTS = 5;

const isGitCommand = (command: string) => {
  const name = command.split(/[\\/]/).at(-1)?.toLowerCase();
  return name === "git" || name === "git.exe";
};

const makeLayer = (spawns: Array<ReadonlyArray<string>>) =>
  GitVcsDriver.layer.pipe(
    Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "houston-review-index-" })),
    Layer.provideMerge(VcsProcess.layer),
    Layer.provide(
      Layer.effect(
        ChildProcessSpawner.ChildProcessSpawner,
        Effect.gen(function* () {
          const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
          return ChildProcessSpawner.make((command) => {
            if (command._tag === "StandardCommand" && isGitCommand(command.command)) {
              spawns.push(command.args.map(String));
            }
            return spawner.spawn(command);
          });
        }),
      ).pipe(Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
    ),
    Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
  );

const git = (cwd: string, args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const process = yield* VcsProcess.VcsProcess;
    yield* process.run({ operation: "test.git", command: "git", args: ["-C", cwd, ...args], cwd });
  });

const makeLargeIndexRepository = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "houston-review-index-" });
  yield* git(cwd, ["init", "-b", "main"]);
  yield* git(cwd, ["config", "user.email", "test@test.com"]);
  yield* git(cwd, ["config", "user.name", "Test"]);
  yield* fileSystem.writeFileString(path.join(cwd, "README.md"), "hello\n");
  yield* Effect.forEach(
    Array.from({ length: TRACKED_INDEX_FILES }, (_, index) => `file-${index}.txt`),
    (name) => fileSystem.writeFileString(path.join(cwd, name), `${name}\n`),
    { concurrency: 64, discard: true },
  );
  yield* git(cwd, ["add", "."]);
  yield* git(cwd, ["commit", "-m", "init"]);
  yield* fileSystem.writeFileString(path.join(cwd, "untracked.txt"), "new\n");
  return cwd;
});

const singleFilePreview = (cwd: string) =>
  Effect.gen(function* () {
    const driver = yield* GitVcsDriver.GitVcsDriver;
    return yield* driver.getReviewDiffPreview({
      cwd,
      sourceKind: "working-tree",
      file: { path: "untracked.txt", previousPath: null, sourceKind: "working-tree" },
    });
  });

it.effect("reviews one untracked file without copying the repository index", () => {
  const spawns: Array<ReadonlyArray<string>> = [];
  return Effect.gen(function* () {
    const cwd = yield* makeLargeIndexRepository;
    // Warm the diff hashing path; the fixture repository is otherwise unchanged.
    yield* singleFilePreview(cwd);
    spawns.length = 0;
    const durations: Array<number> = [];
    for (let index = 0; index < SINGLE_FILE_REQUESTS; index++) {
      const started = yield* Effect.sync(() => performance.now());
      const preview = yield* singleFilePreview(cwd);
      durations.push((yield* Effect.sync(() => performance.now())) - started);
      assert.include(preview.sources[0]!.diff, "b/untracked.txt");
    }
    const sorted = durations.toSorted((left, right) => left - right);
    const median = sorted[Math.floor(sorted.length / 2)]!;
    const indexPathCopies = spawns.filter((args) =>
      args.includes("--no-split-index"),
    ).length;
    assert.isAtMost(
      spawns.length / SINGLE_FILE_REQUESTS,
      6,
      `single untracked file request: ${spawns.length} git processes over ` +
        `${SINGLE_FILE_REQUESTS} requests, median ${median.toFixed(1)} ms, ` +
        `${indexPathCopies} index copies: ${spawns
          .map((args) => args.join(" "))
          .join("; ")}`,
    );
  }).pipe(Effect.scoped, Effect.provide(makeLayer(spawns)));
});
