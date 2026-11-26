// Discovery against real temporary git repositories.
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import { discoverRepositories } from "./repositoryDiscovery.ts";

const layerTest = GitVcsDriver.layer.pipe(
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "houston-discovery-" })),
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(NodeCrypto.layer),
);

const git = (cwd: string, args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const driver = yield* GitVcsDriver.GitVcsDriver;
    yield* driver.execute({
      operation: "repositoryDiscovery.test.git",
      cwd,
      args,
      timeoutMs: 30_000,
    });
  });

const initRepository = (cwd: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.makeDirectory(cwd, { recursive: true });
    yield* git(cwd, ["init", "-q"]);
  });

const makeDirectory = (cwd: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.makeDirectory(cwd, { recursive: true });
  });

const writeFile = (target: string, contents: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* fs.makeDirectory(path.dirname(target), { recursive: true });
    yield* fs.writeFileString(target, contents);
  });

const withProject = <A, E>(
  body: (paths: {
    readonly root: string;
    readonly join: (...parts: ReadonlyArray<string>) => string;
  }) => Effect.Effect<
    A,
    E,
    FileSystem.FileSystem | Path.Path | GitVcsDriver.GitVcsDriver
  >,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "houston-repositories-" });
    return yield* body({ root, join: (...parts) => path.join(root, ...parts) });
  }).pipe(Effect.scoped, Effect.provide(layerTest));

it.effect("finds the project repository, direct children and one level below plain folders", () =>
  withProject(({ root, join }) =>
    Effect.gen(function* () {
      yield* initRepository(root);
      yield* initRepository(join("child-repo"));
      yield* makeDirectory(join("plain"));
      yield* initRepository(join("plain", "grandchild-repo"));
      yield* initRepository(join("plain", "great-grandchild", "too-deep"));

      const result = yield* discoverRepositories({ projectRoot: root });

      assert.deepEqual(
        result.repositories.map((repository) => repository.key),
        [".", "child-repo", "plain/grandchild-repo"],
      );
      assert.deepEqual(result.notices, []);
    }),
  ),
);

it.effect("skips hidden names, node_modules and a linked worktree's .git file", () =>
  withProject(({ root, join }) =>
    Effect.gen(function* () {
      yield* initRepository(root);
      yield* initRepository(join(".hidden"));
      yield* initRepository(join("node_modules", "package"));
      yield* makeDirectory(join("linked"));
      yield* writeFile(join("linked", ".git"), "gitdir: /elsewhere/.git/worktrees/linked\n");

      const result = yield* discoverRepositories({ projectRoot: root });

      assert.deepEqual(
        result.repositories.map((repository) => repository.key),
        ["."],
      );
    }),
  ),
);

it.effect("adds declared submodules whose .git is a file", () =>
  withProject(({ root, join }) =>
    Effect.gen(function* () {
      yield* initRepository(root);
      yield* makeDirectory(join("modules", "lib"));
      yield* writeFile(join("modules", "lib", ".git"), "gitdir: ../.git/modules/lib\n");
      yield* writeFile(
        join(".gitmodules"),
        '[submodule "lib"]\n\tpath = modules/lib\n\turl = https://example.com/lib.git\n',
      );

      const result = yield* discoverRepositories({ projectRoot: root });

      assert.deepEqual(result.repositories, [
        { key: ".", root, kind: "discovered" },
        { key: "modules/lib", root: join("modules", "lib"), kind: "submodule" },
      ]);
    }),
  ),
);

it.effect("leaves out repositories matched by the ignore patterns", () =>
  withProject(({ root, join }) =>
    Effect.gen(function* () {
      yield* initRepository(root);
      yield* initRepository(join("keep"));
      yield* initRepository(join("legacy"));
      yield* initRepository(join("group", "generated"));

      const result = yield* discoverRepositories({
        projectRoot: root,
        ignorePatterns: ["legacy", "group/**"],
      });

      assert.deepEqual(
        result.repositories.map((repository) => repository.key),
        [".", "keep"],
      );
    }),
  ),
);

it.effect("reports the repository bound with its value and what was requested", () =>
  withProject(({ root, join }) =>
    Effect.gen(function* () {
      yield* initRepository(root);
      yield* initRepository(join("one"));
      yield* initRepository(join("two"));

      const result = yield* discoverRepositories({
        projectRoot: root,
        limits: { repositories: 2 },
      });

      assert.deepEqual(
        result.repositories.map((repository) => repository.key),
        [".", "one"],
      );
      assert.deepEqual(result.notices, [
        { limit: "repositories", limitValue: 2, actual: 2, requested: "two" },
      ]);
    }),
  ),
);

it.effect("reports the submodule bound with its value and what was requested", () =>
  withProject(({ root, join }) =>
    Effect.gen(function* () {
      yield* initRepository(root);
      for (const name of ["one", "two"]) {
        yield* makeDirectory(join("modules", name));
        yield* writeFile(join("modules", name, ".git"), "gitdir: ../.git/modules/x\n");
      }
      yield* writeFile(
        join(".gitmodules"),
        '[submodule "one"]\n\tpath = modules/one\n[submodule "two"]\n\tpath = modules/two\n',
      );

      const result = yield* discoverRepositories({
        projectRoot: root,
        limits: { submodulesPerRepository: 1 },
      });

      assert.deepEqual(
        result.repositories.map((repository) => repository.key),
        [".", "modules/one"],
      );
      assert.deepEqual(result.notices, [
        {
          limit: "submodulesPerRepository",
          limitValue: 1,
          actual: 1,
          requested: "modules/two",
        },
      ]);
    }),
  ),
);

it.effect("reports the scanned-entry bound with its value and what was requested", () =>
  withProject(({ root, join }) =>
    Effect.gen(function* () {
      yield* initRepository(root);
      yield* makeDirectory(join("plain"));
      yield* initRepository(join("plain", "nested"));

      const result = yield* discoverRepositories({
        projectRoot: root,
        limits: { scannedEntries: 2 },
      });

      assert.deepEqual(
        result.repositories.map((repository) => repository.key),
        ["."],
      );
      assert.deepEqual(result.notices, [
        {
          limit: "scannedEntries",
          limitValue: 2,
          actual: 3,
          requested: join("plain", "nested"),
        },
      ]);
    }),
  ),
);
