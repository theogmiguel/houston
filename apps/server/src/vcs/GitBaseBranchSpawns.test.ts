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

// A thread switch reads local status several times with the same repository state. Resolving the
// base afresh each time ran 5 merge-base probes plus their counts and timestamps per candidate.
const FIVE_STATUS_READS_GIT_BUDGET = 60;

const isGitCommand = (command: string) => {
  const name = command.split(/[\\/]/).at(-1)?.toLowerCase();
  return name === "git" || name === "git.exe";
};

const makeLayer = (spawns: Array<ReadonlyArray<string>>) =>
  GitVcsDriver.layer.pipe(
    Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "houston-base-branch-" })),
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

const REMOTE_BRANCHES = ["develop", "staging", "next", "release/2.0"] as const;

const makeFiveRemoteBranchFeature = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const remote = yield* fileSystem.makeTempDirectoryScoped({ prefix: "houston-base-remote-" });
  const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "houston-base-spawns-" });
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
  for (const branch of REMOTE_BRANCHES) {
    yield* git(cwd, ["branch", branch, "main"]);
  }
  yield* git(cwd, ["push", "origin", ...REMOTE_BRANCHES]);
  yield* git(cwd, ["checkout", "-b", "feature/x"]);
  yield* fileSystem.writeFileString(path.join(cwd, "README.md"), "hello world\n");
  yield* git(cwd, ["add", "."]);
  yield* git(cwd, ["commit", "-m", "feature"]);
  return cwd;
});

const localStatus = (cwd: string) =>
  Effect.gen(function* () {
    const driver = yield* GitVcsDriver.GitVcsDriver;
    return yield* driver.statusDetailsLocal(cwd, {
      includeDivergence: true,
      includeBranchChanges: true,
    });
  });

const countMergeBases = (spawns: ReadonlyArray<ReadonlyArray<string>>) =>
  spawns.filter((args) => args.includes("merge-base")).length;

it.effect("resolves a feature branch's base once across repeated status reads", () => {
  const spawns: Array<ReadonlyArray<string>> = [];
  return Effect.gen(function* () {
    const cwd = yield* makeFiveRemoteBranchFeature;
    // Warm the repository-path, default-branch and primary-remote caches so only the base
    // lookup is measured.
    yield* localStatus(cwd);
    spawns.length = 0;
    for (let index = 0; index < 5; index++) {
      const status = yield* localStatus(cwd);
      assert.equal(status.branchChanges?.baseRef, "origin/develop");
    }
    assert.isAtMost(
      spawns.length,
      FIVE_STATUS_READS_GIT_BUDGET,
      `five warm status reads started ${spawns.length} git processes, ` +
        `${countMergeBases(spawns)} of them merge-base: ` +
        spawns.map((args) => args.join(" ")).join("; "),
    );
    assert.equal(
      countMergeBases(spawns),
      0,
      `warm status reads re-ran base resolution: ${spawns
        .map((args) => args.join(" "))
        .join("; ")}`,
    );

    // Moving a remote branch changes the nearest base and must re-resolve.
    yield* git(cwd, ["push", "--force", "origin", "HEAD:main"]);
    spawns.length = 0;
    const afterRefChange = yield* localStatus(cwd);
    assert.equal(afterRefChange.branchChanges?.baseRef, "origin/main");
    assert.isAbove(countMergeBases(spawns), 0);

    // Recording a base in branch config changes the answer and must re-resolve.
    yield* git(cwd, ["config", "branch.feature/x.houston-merge-base", "origin/develop"]);
    spawns.length = 0;
    const afterConfigChange = yield* localStatus(cwd);
    assert.equal(afterConfigChange.branchChanges?.baseRef, "origin/develop");
    assert.isAbove(countMergeBases(spawns), 0);

    // The re-resolved answer is cached again; a later read does not serve the old base.
    yield* localStatus(cwd);
    const afterRepeat = yield* localStatus(cwd);
    assert.equal(afterRepeat.branchChanges?.baseRef, "origin/develop");
  }).pipe(Effect.scoped, Effect.provide(makeLayer(spawns)));
});
