// Project repositories against real temporary git repositories.
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  HOUSTON_PROJECT_REPOSITORY_LIMITS,
  type HoustonProjectRepositoryError,
  ProjectId,
} from "@houston-app/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import type * as Scope from "effect/Scope";

import * as ServerConfig from "../../config.ts";
import * as ProjectStore from "../../orchestration-v2/ProjectStore.ts";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import * as HoustonProjectFileLoader from "../../project/HoustonProjectFileLoader.ts";
import * as GitVcsDriver from "../../vcs/GitVcsDriver.ts";
import * as HoustonProjectRepositories from "./ProjectRepositoriesService.ts";
import * as HoustonProjectRepositoriesStore from "./ProjectRepositoriesStore.ts";

const projectId = ProjectId.make("project:repositories");

const projectRow = {
  projectId,
  title: "Project",
  workspaceRoot: "/placeholder",
  defaultModelSelection: null,
  defaultThreadEnvMode: null,
  autoPull: false,
  faviconPath: null,
  projectIcon: null,
  scripts: [],
  pinnedAt: null,
  archivedAt: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  deletedAt: null,
};

const layerFor = (workspaceRoot: string) =>
  HoustonProjectRepositories.layer.pipe(
    Layer.provideMerge(HoustonProjectRepositoriesStore.layer),
    Layer.provide(HoustonProjectFileLoader.layer),
    Layer.provide(
      Layer.mock(ProjectStore.ProjectStoreV2)({
        get: () => Effect.succeedSome({ ...projectRow, workspaceRoot }),
      }),
    ),
    Layer.provideMerge(GitVcsDriver.layer),
    Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "houston-project-repositories-" })),
    Layer.provideMerge(SqlitePersistence.layerMemory),
    Layer.provideMerge(NodeServices.layer),
    Layer.provideMerge(NodeCrypto.layer),
  );

const withProject = <A, E>(
  body: (input: {
    readonly root: string;
    readonly join: (...parts: ReadonlyArray<string>) => string;
    readonly repositories: HoustonProjectRepositories.HoustonProjectRepositories["Service"];
    readonly store: HoustonProjectRepositoriesStore.HoustonProjectRepositoriesStore["Service"];
  }) => Effect.Effect<
    A,
    E,
    | FileSystem.FileSystem
    | Path.Path
    | GitVcsDriver.GitVcsDriver
    | HoustonProjectRepositories.HoustonProjectRepositories
    | HoustonProjectRepositoriesStore.HoustonProjectRepositoriesStore
    | Scope.Scope
  >,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "houston-project-repositories-" });
    yield* Effect.gen(function* () {
      yield* body({
        root,
        join: (...parts) => path.join(root, ...parts),
        repositories: yield* HoustonProjectRepositories.HoustonProjectRepositories,
        store: yield* HoustonProjectRepositoriesStore.HoustonProjectRepositoriesStore,
      });
    }).pipe(Effect.provide(layerFor(root)));
  }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)));

const git = (cwd: string, args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const driver = yield* GitVcsDriver.GitVcsDriver;
    yield* driver.execute({
      operation: "ProjectRepositories.test.git",
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
    yield* git(cwd, [
      "-c",
      "user.email=test@example.com",
      "-c",
      "user.name=Test",
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      "init",
    ]);
  });

const writeFile = (target: string, contents: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* fs.makeDirectory(path.dirname(target), { recursive: true });
    yield* fs.writeFileString(target, contents);
  });

const failureOf = <A, E>(effect: Effect.Effect<A, E>) =>
  Effect.gen(function* () {
    const exit = yield* Effect.exit(effect);
    if (Exit.isSuccess(exit)) return null;
    return Option.getOrThrow(Exit.findErrorOption(exit));
  });

it.effect("lists the discovered repositories, the declared submodule and a tracked folder", () =>
  withProject(({ root, join, repositories }) =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      yield* initRepository(root);
      yield* writeFile(
        join(".gitmodules"),
        '[submodule "lib"]\n\tpath = modules/lib\n\turl = https://example.com/lib.git\n',
      );
      yield* writeFile(join("modules", "lib", ".git"), "gitdir: ../.git/modules/lib\n");
      yield* initRepository(join("child-repo"));
      yield* initRepository(join("plain", "grandchild-repo"));
      yield* writeFile(
        join("houston.json"),
        JSON.stringify({ ignoreRepositories: ["child-repo"] }),
      );
      const fs = yield* FileSystem.FileSystem;
      const outside = yield* fs.makeTempDirectoryScoped({
        prefix: "houston-project-tracked-",
      });
      yield* initRepository(outside);

      yield* repositories.track({ projectId, path: outside });
      const listed = yield* repositories.list({ projectId });
      assert.deepEqual(
        listed.repositories.map((repository) => [repository.key, repository.kind]),
        [
          [".", "discovered"],
          ["modules/lib", "submodule"],
          ["plain/grandchild-repo", "discovered"],
          [path.relative(root, outside).split(path.sep).join("/"), "tracked"],
        ],
      );
      assert.isTrue(
        listed.repositories
          .filter((repository) => repository.kind !== "submodule")
          .every((repository) => repository.branch !== null),
      );
      assert.deepEqual(listed.ignored, ["child-repo"]);
    }),
  ),
);

it.effect("reports an entry whose repository can no longer be read", () =>
  withProject(({ repositories }) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const outside = yield* fs.makeTempDirectoryScoped({ prefix: "houston-project-tracked-" });
      yield* initRepository(outside);
      yield* repositories.track({ projectId, path: outside });
      yield* fs.remove(outside, { recursive: true });

      const listed = yield* repositories.list({ projectId });
      const tracked = listed.repositories.find((repository) => repository.root === outside);

      assert.isDefined(tracked);
      assert.isString(tracked?.error);
      assert.isNull(tracked?.branch ?? null);
      assert.isFalse(tracked?.detached);
    }),
  ),
);

it.effect("tracks and untracks a folder outside the project", () =>
  withProject(({ repositories }) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const outside = yield* fs.makeTempDirectoryScoped({ prefix: "houston-project-tracked-" });
      yield* initRepository(outside);

      const tracked = yield* repositories.track({ projectId, path: outside });
      assert.deepEqual(
        tracked.repositories.filter((repository) => repository.kind === "tracked").map((r) => r.root),
        [outside],
      );

      const untracked = yield* repositories.untrack({ projectId, path: outside });
      assert.deepEqual(
        untracked.repositories.filter((repository) => repository.kind === "tracked"),
        [],
      );
    }),
  ),
);

it.effect("refuses folders that do not exist, are not repositories, or are already tracked", () =>
  withProject(({ root, join, repositories }) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* initRepository(root);
      const outside = yield* fs.makeTempDirectoryScoped({ prefix: "houston-project-tracked-" });
      yield* initRepository(outside);
      const plain = yield* fs.makeTempDirectoryScoped({ prefix: "houston-project-plain-" });

      const missing = yield* failureOf(
        repositories.track({ projectId, path: join("missing") }),
      );
      assert.equal((missing as HoustonProjectRepositoryError | null)?.kind, "invalid");
      assert.include((missing as HoustonProjectRepositoryError).message, "missing");

      const notRepository = yield* failureOf(repositories.track({ projectId, path: plain }));
      assert.equal((notRepository as HoustonProjectRepositoryError | null)?.kind, "invalid");
      assert.include((notRepository as HoustonProjectRepositoryError).message, plain);

      const inside = yield* failureOf(repositories.track({ projectId, path: root }));
      assert.equal((inside as HoustonProjectRepositoryError | null)?.kind, "conflict");
      assert.include((inside as HoustonProjectRepositoryError).message, "inside the project folder");

      yield* repositories.track({ projectId, path: outside });
      const duplicate = yield* failureOf(repositories.track({ projectId, path: outside }));
      assert.equal((duplicate as HoustonProjectRepositoryError | null)?.kind, "conflict");
      assert.include((duplicate as HoustonProjectRepositoryError).message, outside);

      const missingUntrack = yield* failureOf(
        repositories.untrack({ projectId, path: outside }),
      );
      assert.isNull(missingUntrack);
      const again = yield* failureOf(repositories.untrack({ projectId, path: outside }));
      assert.equal((again as HoustonProjectRepositoryError | null)?.kind, "not_found");
    }),
  ),
);

it.effect("refuses a tracked folder past the cap, naming the limit, count and folder", () =>
  withProject(({ repositories, store }) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const outside = yield* fs.makeTempDirectoryScoped({ prefix: "houston-project-tracked-" });
      yield* initRepository(outside);
      yield* Effect.forEach(
        Array.from({ length: HOUSTON_PROJECT_REPOSITORY_LIMITS.trackedFolders }, (_, index) =>
          store.addTracked({
            projectId,
            folderPath: `/elsewhere/repository-${index}`,
            addedAt: "2026-01-01T00:00:00.000Z",
          }),
        ),
        (effect) => effect,
        { discard: true },
      );

      const failure = yield* failureOf(repositories.track({ projectId, path: outside }));

      assert.equal((failure as HoustonProjectRepositoryError | null)?.kind, "limit");
      const error = failure as HoustonProjectRepositoryError;
      assert.equal(error.limit, HOUSTON_PROJECT_REPOSITORY_LIMITS.trackedFolders);
      assert.equal(error.actual, HOUSTON_PROJECT_REPOSITORY_LIMITS.trackedFolders);
      assert.include(error.message, outside);
    }),
  ),
);

it.effect("stores the project's ignore patterns and refuses an empty one", () =>
  withProject(({ repositories }) =>
    Effect.gen(function* () {
      const updated = yield* repositories.setIgnorePatterns({
        projectId,
        patterns: ["legacy", " legacy ", "vendor/**"],
      });
      assert.deepEqual(updated.ignored, ["legacy", "vendor/**"]);

      const failure = yield* failureOf(
        repositories.setIgnorePatterns({ projectId, patterns: ["  "] }),
      );
      assert.equal((failure as HoustonProjectRepositoryError | null)?.kind, "invalid");
      assert.include((failure as HoustonProjectRepositoryError).message, "empty");
    }),
  ),
);
