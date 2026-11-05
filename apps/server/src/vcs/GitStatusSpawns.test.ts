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

// Local status runs after every turn and on every poll; each Windows git process costs about
// 60 ms. Warm means the repository paths, default branch and remote caches are filled.
const WARM_FEATURE_BRANCH_STATUS_GIT_BUDGET = 13;

const isGitCommand = (command: string) => {
  const name = command.split(/[\\/]/).at(-1)?.toLowerCase();
  return name === "git" || name === "git.exe";
};

const makeLayer = (spawns: Array<ReadonlyArray<string>>) =>
  GitVcsDriver.layer.pipe(
    Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "houston-status-spawns-" })),
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

const makeFeatureBranch = (branch: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const remote = yield* fileSystem.makeTempDirectoryScoped({ prefix: "houston-status-remote-" });
    const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "houston-status-spawns-" });
    yield* git(remote, ["init", "--bare", "-b", "main"]);
    yield* git(cwd, ["init", "-b", "main"]);
    yield* git(cwd, ["config", "user.email", "test@test.com"]);
    yield* git(cwd, ["config", "user.name", "Test"]);
    yield* fileSystem.writeFileString(path.join(cwd, "README.md"), "hello\n");
    yield* git(cwd, ["add", "."]);
    yield* git(cwd, ["commit", "-m", "init"]);
    yield* git(cwd, ["remote", "add", "origin", remote]);
    yield* git(cwd, ["push", "-u", "origin", "main"]);
    yield* git(cwd, ["remote", "set-head", "origin", "main"]);
    yield* git(cwd, ["checkout", "-b", branch]);
    yield* fileSystem.writeFileString(path.join(cwd, "README.md"), "hello world\n");
    return cwd;
  });

const localStatus = (cwd: string) =>
  Effect.gen(function* () {
    const driver = yield* GitVcsDriver.GitVcsDriver;
    return yield* driver.statusDetailsLocal(cwd, {
      includeDivergence: false,
      includeBranchChanges: true,
    });
  });

it.effect("refreshes a feature branch's local status within its git budget", () => {
  const spawns: Array<ReadonlyArray<string>> = [];
  return Effect.gen(function* () {
    const cwd = yield* makeFeatureBranch("feature");
    yield* localStatus(cwd);
    spawns.length = 0;
    const status = yield* localStatus(cwd);

    assert.deepEqual(status.branchChanges, {
      baseRef: "origin/main",
      insertions: 1,
      deletions: 1,
    });
    assert.isAtMost(
      spawns.length,
      WARM_FEATURE_BRANCH_STATUS_GIT_BUDGET,
      `local status started ${spawns.length} git processes: ${spawns.map((args) => args.join(" ")).join("; ")}`,
    );
  }).pipe(Effect.scoped, Effect.provide(makeLayer(spawns)));
});

it.effect.each([
  ["houston-merge-base-ref", "refs/heads/release.v2", "refs/heads/release.v2"],
  ["houston-merge-base", "release.v2", "release.v2"],
  ["gh-merge-base", "release.v2", "release.v2"],
] as const)(
  "reads a recorded %s for a branch whose name holds pattern characters",
  ([key, value, baseRef]) =>
    Effect.gen(function* () {
      const branch = "fix/a+b.(c)";
      const cwd = yield* makeFeatureBranch(branch);
      yield* git(cwd, ["branch", "release.v2", "main"]);
      yield* git(cwd, ["config", `branch.${branch}.${key}`, value]);
      // A branch whose name matches the escaped one only as a pattern must not leak its base.
      yield* git(cwd, ["config", "branch.fix/aab.xcx.houston-merge-base", "main"]);

      const status = yield* localStatus(cwd);

      assert.equal(status.branchChanges?.baseRef, baseRef);
    }).pipe(Effect.scoped, Effect.provide(makeLayer([]))),
);
