// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import { HOUSTON_PROJECT_FOLDER_SEARCH_LIMITS } from "@houston-app/contracts";
import * as HostProcess from "@houston-app/shared/HostProcess";
import * as FolderSearch from "./FolderSearchService.ts";

const layer = Layer.mergeAll(NodeServices.layer, NodeCrypto.layer);

const makeTempDir = Effect.fn(function* (prefix: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* fileSystem.makeTempDirectoryScoped({ prefix });
});

const makeFolder = Effect.fn(function* (path: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  yield* fileSystem.makeDirectory(path, { recursive: true });
});

const writeFile = Effect.fn(function* (path: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  yield* fileSystem.makeDirectory(yield* Path.Path.pipe(Effect.map((p) => p.dirname(path))), {
    recursive: true,
  });
  yield* fileSystem.writeFileString(path, "");
});

const search = (input: FolderSearch.SearchInput) => FolderSearch.searchProjectFolders(input);

it.effect("returns places to start when the query is empty", () =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const root = yield* makeTempDir("houston-folder-search-places-");
    const project = path.join(root, "dev", "alpha");
    const base = path.join(root, "base");
    yield* makeFolder(project);
    yield* makeFolder(base);

    const result = yield* search({
      query: "",
      baseDirectory: base,
      projectFolders: [project],
    });

    // Windows also lists the machine's drives as places; which ones depends on the host.
    assert.deepEqual(
      result.places
        .filter((place) => place.kind !== "drive")
        .map((place) => [place.kind, place.path]),
      [
        ["home", yield* HostProcess.HomeDirectory],
        ["project-parent", path.dirname(project)],
        ["base", base],
      ],
    );
    assert.lengthOf(result.folders, 0);
    assert.isFalse(result.truncated);
  }).pipe(Effect.provide(layer)),
);

it.effect(
  "finds folders under a registered project's parent and ranks git repositories first",
  () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const root = yield* makeTempDir("houston-folder-search-parent-");
      const dev = path.join(root, "dev");
      const registered = path.join(dev, "alpha-registered");
      yield* makeFolder(path.join(dev, "alpha-app"));
      yield* makeFolder(path.join(dev, "alpha-repository"));
      yield* writeFile(path.join(dev, "alpha-repository", ".git", "HEAD"));
      yield* makeFolder(registered);

      const result = yield* search({
        query: "alpha",
        baseDirectory: path.join(root, "unused-base"),
        projectFolders: [registered],
      });

      assert.deepEqual(
        result.folders.map((folder) => folder.path),
        [path.join(dev, "alpha-repository"), path.join(dev, "alpha-app"), registered],
      );
      assert.isTrue(result.folders[0]?.gitRepository);
      assert.isFalse(result.folders[1]?.gitRepository);
    }).pipe(Effect.provide(layer)),
);

it.effect("searches the base directory after project parents and skips build folders", () =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const root = yield* makeTempDir("houston-folder-search-base-");
    const projectParent = path.join(root, "projects");
    const base = path.join(root, "dev");
    yield* makeFolder(path.join(projectParent, "gamma-one"));
    yield* makeFolder(path.join(base, "gamma-two"));
    yield* makeFolder(path.join(base, "node_modules", "gamma-hidden"));
    yield* makeFolder(path.join(base, "dist", "gamma-dist"));

    const result = yield* search({
      query: "gamma",
      baseDirectory: base,
      projectFolders: [path.join(projectParent, "existing")],
    });

    assert.deepEqual(
      result.folders.map((folder) => folder.path),
      [path.join(projectParent, "gamma-one"), path.join(base, "gamma-two")],
    );
  }).pipe(Effect.provide(layer)),
);

it.effect("stops below the search depth and counts the walk as truncated", () =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const root = yield* makeTempDir("houston-folder-search-depth-");
    const base = path.join(root, "base");
    yield* makeFolder(path.join(base, "delta-visible"));
    yield* makeFolder(path.join(base, "one", "two", "three", "delta-deep"));

    const result = yield* search({
      query: "delta",
      baseDirectory: base,
      projectFolders: [],
    });

    assert.deepEqual(
      result.folders.map((folder) => folder.path),
      [path.join(base, "delta-visible")],
    );
    assert.isTrue(result.truncated);
  }).pipe(Effect.provide(layer)),
);

it.effect("caps the result count and reports truncation", () =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const root = yield* makeTempDir("houston-folder-search-count-");
    const base = path.join(root, "base");
    yield* Effect.forEach(
      Array.from({ length: HOUSTON_PROJECT_FOLDER_SEARCH_LIMITS.results + 10 }),
      (_, index) => makeFolder(path.join(base, `epsilon-${String(index).padStart(2, "0")}`)),
      { concurrency: 8, discard: true },
    );

    const result = yield* search({
      query: "epsilon",
      baseDirectory: base,
      projectFolders: [],
    });

    assert.lengthOf(result.folders, HOUSTON_PROJECT_FOLDER_SEARCH_LIMITS.results);
    assert.isTrue(result.truncated);
  }).pipe(Effect.provide(layer)),
);

it.effect("lists only the Windows drives that exist", () =>
  Effect.gen(function* () {
    assert.deepEqual(
      yield* FolderSearch.windowsDriveRoots(
        "win32",
        async (root) => root === "C:\\" || root === "D:\\",
      ),
      ["C:\\", "D:\\"],
    );
    assert.deepEqual(yield* FolderSearch.windowsDriveRoots("linux", async () => true), []);
  }),
);
