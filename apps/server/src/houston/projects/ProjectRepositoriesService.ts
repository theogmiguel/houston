// The repositories a project covers: discovery inside its folder, the folders a user tracked
// from elsewhere, and the git reads that name each one's branch.
import {
  HOUSTON_PROJECT_REPOSITORY_LIMITS,
  type HoustonProjectRepositoriesInput,
  type HoustonProjectRepositoriesResult,
  type HoustonProjectRepository,
  type HoustonProjectRepositoryErrorKind,
  type HoustonProjectRepositoryIgnoreInput,
  type HoustonProjectRepositoryTrackInput,
  type HoustonProjectRepositoryUntrackInput,
  type ProjectId,
} from "@houston-app/contracts";
import { HoustonProjectRepositoryError as RepositoryError } from "@houston-app/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import * as GitVcsDriver from "../../vcs/GitVcsDriver.ts";
import { isWithinRoot } from "../../workspace/KnownWorkspaces.ts";
import * as ProjectStore from "../../orchestration-v2/ProjectStore.ts";
import * as HoustonProjectFileLoader from "../../project/HoustonProjectFileLoader.ts";
import { discoverRepositories, type DiscoveredRepository } from "../../project/repositoryDiscovery.ts";
import {
  ThreadRepositoryResolver,
  type ThreadRepository,
} from "../../project/threadRepositories.ts";
import * as HoustonProjectRepositoriesStore from "./ProjectRepositoriesStore.ts";

const MAX_REPOSITORY_ERROR_LENGTH = 512;

interface ProjectFolder {
  readonly projectId: ProjectId;
  readonly workspaceRoot: string;
}

const refuse = (input: {
  readonly kind: HoustonProjectRepositoryErrorKind;
  readonly operation: string;
  readonly message: string;
  readonly limit?: number;
  readonly actual?: number;
}): RepositoryError => new RepositoryError(input);

const relativeKey = (path: Path.Path, from: string, to: string): string => {
  const relative = path.relative(from, to).split(path.sep).join("/");
  return relative.length === 0 ? "." : relative;
};

export class HoustonProjectRepositories extends Context.Service<
  HoustonProjectRepositories,
  {
    readonly list: (
      input: HoustonProjectRepositoriesInput,
    ) => Effect.Effect<HoustonProjectRepositoriesResult, RepositoryError>;
    readonly track: (
      input: HoustonProjectRepositoryTrackInput,
    ) => Effect.Effect<HoustonProjectRepositoriesResult, RepositoryError>;
    readonly untrack: (
      input: HoustonProjectRepositoryUntrackInput,
    ) => Effect.Effect<HoustonProjectRepositoriesResult, RepositoryError>;
    readonly setIgnorePatterns: (
      input: HoustonProjectRepositoryIgnoreInput,
    ) => Effect.Effect<HoustonProjectRepositoriesResult, RepositoryError>;
    /** Repository roots for thread resolution; never fails and always names at least the project. */
    readonly repositoriesForThread: (
      project: ProjectFolder,
    ) => Effect.Effect<ReadonlyArray<ThreadRepository>>;
  }
>()("@houston-app/cli/houston/projects/ProjectRepositoriesService/HoustonProjectRepositories") {}

const make = Effect.gen(function* () {
  const projects = yield* ProjectStore.ProjectStoreV2;
  const store = yield* HoustonProjectRepositoriesStore.HoustonProjectRepositoriesStore;
  const projectFile = yield* HoustonProjectFileLoader.HoustonProjectFileLoader;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const git = yield* GitVcsDriver.GitVcsDriver;

  const projectOf = (projectId: ProjectId) =>
    projects.get(projectId).pipe(
      Effect.mapError((cause) =>
        refuse({
          kind: "unsupported",
          operation: "HoustonProjectRepositories.project",
          message: `Could not read project ${projectId}: ${cause.message}`,
        }),
      ),
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(
              refuse({
                kind: "not_found",
                operation: "HoustonProjectRepositories.project",
                message: `Project ${projectId} was not found; expected a live project.`,
              }),
            ),
          onSome: (project) =>
            Effect.succeed({ projectId: project.projectId, workspaceRoot: project.workspaceRoot }),
        }),
      ),
    );

  const ignoredPatternsOf = Effect.fn("HoustonProjectRepositories.ignoredPatternsOf")(
    function* (projectId: ProjectId, workspaceRoot: string) {
      const loaded = yield* projectFile.load(workspaceRoot);
      const fromFile = Option.match(loaded, {
        onNone: (): ReadonlyArray<string> => [],
        onSome: (file) => file.ignoreRepositories ?? [],
      });
      const stored = yield* store.listIgnorePatterns(projectId).pipe(
        Effect.mapError((cause) =>
          refuse({
            kind: "unsupported",
            operation: "HoustonProjectRepositories.ignorePatterns",
            message: `Could not read ignore patterns for project ${projectId}: ${cause.message}`,
          }),
        ),
      );
      return [...new Set([...fromFile, ...stored])];
    },
  );

  const discoveredEntries = (project: ProjectFolder, ignorePatterns: ReadonlyArray<string>) =>
    discoverRepositories({ projectRoot: project.workspaceRoot, ignorePatterns }).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
      Effect.map((result) => ({
        repositories: result.repositories as ReadonlyArray<DiscoveredRepository>,
        notices: result.notices,
      })),
    );

  const trackedEntries = (project: ProjectFolder) =>
    store.listTracked(project.projectId).pipe(
      Effect.mapError((cause) =>
        refuse({
          kind: "unsupported",
          operation: "HoustonProjectRepositories.trackedFolders",
          message: `Could not read tracked folders for project ${project.projectId}: ${cause.message}`,
        }),
      ),
      Effect.map((rows) =>
        rows.map((row) => ({
          key: relativeKey(path, project.workspaceRoot, row.folderPath),
          root: row.folderPath,
          kind: "tracked" as const,
        })),
      ),
    );

  const entriesOf = Effect.fn("HoustonProjectRepositories.entriesOf")(
    function* (project: ProjectFolder) {
      const ignorePatterns = yield* ignoredPatternsOf(project.projectId, project.workspaceRoot);
      const discovered = yield* discoveredEntries(project, ignorePatterns);
      const tracked = yield* trackedEntries(project);
      return {
        repositories: [...discovered.repositories, ...tracked],
        notices: discovered.notices,
        ignored: ignorePatterns,
      };
    },
  );

  const withBranches = (entries: ReadonlyArray<{
    readonly key: string;
    readonly root: string;
    readonly kind: HoustonProjectRepository["kind"];
  }>) =>
    Effect.forEach(
      entries,
      (entry) =>
        git.statusDetailsLocal(entry.root).pipe(
          Effect.map(
            (details): HoustonProjectRepository =>
              details.isRepo
                ? {
                    key: entry.key,
                    root: entry.root,
                    branch: details.branch,
                    detached: details.branch === null,
                    kind: entry.kind,
                  }
                : {
                    key: entry.key,
                    root: entry.root,
                    branch: null,
                    detached: false,
                    kind: entry.kind,
                    error: `${entry.root} is not a readable git repository; expected a folder whose .git is a directory.`,
                  },
          ),
          Effect.catch((cause) => {
            const message =
              cause instanceof Error ? cause.message : String(cause);
            return Effect.succeed({
              key: entry.key,
              root: entry.root,
              branch: null,
              detached: false,
              kind: entry.kind,
              error: message.slice(0, MAX_REPOSITORY_ERROR_LENGTH),
            } satisfies HoustonProjectRepository);
          }),
        ),
      { concurrency: "unbounded" },
    );

  const resultOf = Effect.fn("HoustonProjectRepositories.resultOf")(
    function* (project: ProjectFolder) {
      const entries = yield* entriesOf(project);
      return {
        projectId: project.projectId,
        repositories: yield* withBranches(entries.repositories),
        ignored: entries.ignored,
        notices: entries.notices,
      } satisfies HoustonProjectRepositoriesResult;
    },
  );

  const list: HoustonProjectRepositories["Service"]["list"] = Effect.fn(
    "HoustonProjectRepositories.list",
  )(function* (input) {
    const project = yield* projectOf(input.projectId);
    return yield* resultOf(project);
  });

  const requireRepository = Effect.fn("HoustonProjectRepositories.requireRepository")(
    function* (folder: string) {
      const info = yield* fs.stat(folder).pipe(Effect.option);
      if (Option.isNone(info) || info.value.type !== "Directory") {
        return yield* refuse({
          kind: "invalid",
          operation: "HoustonProjectRepositories.track",
          message: `${folder} is not a directory; expected a folder that exists.`,
        });
      }
      const gitEntry = yield* fs.stat(path.join(folder, ".git")).pipe(Effect.option);
      if (Option.isNone(gitEntry) || gitEntry.value.type !== "Directory") {
        return yield* refuse({
          kind: "invalid",
          operation: "HoustonProjectRepositories.track",
          message: `${folder} is not a git repository; expected a folder whose .git is a directory.`,
        });
      }
    },
  );

  const track: HoustonProjectRepositories["Service"]["track"] = Effect.fn(
    "HoustonProjectRepositories.track",
  )(function* (input) {
    const project = yield* projectOf(input.projectId);
    if (!path.isAbsolute(input.path)) {
      return yield* refuse({
        kind: "invalid",
        operation: "HoustonProjectRepositories.track",
        message: `${input.path} is not absolute; expected an absolute folder path.`,
      });
    }
    const folder = yield* fs
      .realPath(path.resolve(input.path))
      .pipe(
        Effect.mapError(() =>
          refuse({
            kind: "invalid",
            operation: "HoustonProjectRepositories.track",
            message: `${input.path} does not exist; expected an absolute folder path.`,
          }),
        ),
      );
    yield* requireRepository(folder);
    if (isWithinRoot(path, folder, yield* fs.realPath(project.workspaceRoot).pipe(
      Effect.orElseSucceed(() => project.workspaceRoot),
    ))) {
      return yield* refuse({
        kind: "conflict",
        operation: "HoustonProjectRepositories.track",
        message: `${folder} is inside the project folder ${project.workspaceRoot}; expected a folder outside it.`,
      });
    }
    const tracked = yield* store.listTracked(input.projectId).pipe(
      Effect.mapError((cause) =>
        refuse({
          kind: "unsupported",
          operation: "HoustonProjectRepositories.track",
          message: `Could not read tracked folders for project ${project.projectId}: ${cause.message}`,
        }),
      ),
    );
    if (tracked.some((row) => row.folderPath === folder)) {
      return yield* refuse({
        kind: "conflict",
        operation: "HoustonProjectRepositories.track",
        message: `${folder} is already tracked by project ${project.projectId}; expected a folder outside it.`,
      });
    }
    if (tracked.length >= HOUSTON_PROJECT_REPOSITORY_LIMITS.trackedFolders) {
      return yield* refuse({
        kind: "limit",
        operation: "HoustonProjectRepositories.track",
        message: `Project ${project.projectId} already tracks ${tracked.length} folders and the limit is ${HOUSTON_PROJECT_REPOSITORY_LIMITS.trackedFolders}; ${folder} was not added.`,
        limit: HOUSTON_PROJECT_REPOSITORY_LIMITS.trackedFolders,
        actual: tracked.length,
      });
    }
    const addedAt = DateTime.formatIso(yield* DateTime.now);
    yield* store.addTracked({ projectId: input.projectId, folderPath: folder, addedAt }).pipe(
      Effect.mapError((cause) =>
        refuse({
          kind: "unsupported",
          operation: "HoustonProjectRepositories.track",
          message: `Could not store ${folder} for project ${project.projectId}: ${cause.message}`,
        }),
      ),
    );
    return yield* resultOf(project);
  });

  const untrack: HoustonProjectRepositories["Service"]["untrack"] = Effect.fn(
    "HoustonProjectRepositories.untrack",
  )(function* (input) {
    const project = yield* projectOf(input.projectId);
    if (!path.isAbsolute(input.path)) {
      return yield* refuse({
        kind: "invalid",
        operation: "HoustonProjectRepositories.untrack",
        message: `${input.path} is not absolute; expected an absolute folder path.`,
      });
    }
    const folder = path.resolve(input.path);
    const removed = yield* store
      .removeTracked({ projectId: input.projectId, folderPath: folder })
      .pipe(
        Effect.mapError((cause) =>
          refuse({
            kind: "unsupported",
            operation: "HoustonProjectRepositories.untrack",
            message: `Could not remove ${folder} from project ${project.projectId}: ${cause.message}`,
          }),
        ),
      );
    if (!removed) {
      return yield* refuse({
        kind: "not_found",
        operation: "HoustonProjectRepositories.untrack",
        message: `${folder} is not tracked by project ${project.projectId}; expected a tracked folder path.`,
      });
    }
    return yield* resultOf(project);
  });

  const setIgnorePatterns: HoustonProjectRepositories["Service"]["setIgnorePatterns"] = Effect.fn(
    "HoustonProjectRepositories.setIgnorePatterns",
  )(function* (input) {
    const project = yield* projectOf(input.projectId);
    const patterns: Array<string> = [];
    for (const raw of input.patterns) {
      const pattern = raw.trim();
      if (pattern.length === 0) {
        return yield* refuse({
          kind: "invalid",
          operation: "HoustonProjectRepositories.setIgnorePatterns",
          message: `Ignore pattern "${raw}" is empty; expected a non-empty glob.`,
        });
      }
      if (!patterns.includes(pattern)) patterns.push(pattern);
    }
    if (patterns.length > HOUSTON_PROJECT_REPOSITORY_LIMITS.ignorePatterns) {
      return yield* refuse({
        kind: "limit",
        operation: "HoustonProjectRepositories.setIgnorePatterns",
        message: `Project ${project.projectId} was asked for ${patterns.length} ignore patterns and the limit is ${HOUSTON_PROJECT_REPOSITORY_LIMITS.ignorePatterns}.`,
        limit: HOUSTON_PROJECT_REPOSITORY_LIMITS.ignorePatterns,
        actual: patterns.length,
      });
    }
    yield* store
      .setIgnorePatterns({
        projectId: input.projectId,
        patterns,
        updatedAt: DateTime.formatIso(yield* DateTime.now),
      })
      .pipe(
        Effect.mapError((cause) =>
          refuse({
            kind: "unsupported",
            operation: "HoustonProjectRepositories.setIgnorePatterns",
            message: `Could not store ignore patterns for project ${project.projectId}: ${cause.message}`,
          }),
        ),
      );
    return yield* resultOf(project);
  });

  const repositoriesForThread: HoustonProjectRepositories["Service"]["repositoriesForThread"] =
    Effect.fn("HoustonProjectRepositories.repositoriesForThread")(function* (project) {
      const entries = yield* entriesOf(project).pipe(
        Effect.catch((cause) =>
          Effect.logWarning("project repositories could not be resolved", {
            projectId: project.projectId,
            errorTag: cause._tag,
          }).pipe(Effect.as({ repositories: [], notices: [], ignored: [] })),
        ),
      );
      const repositories = entries.repositories.map(
        (entry): ThreadRepository => ({
          key: entry.key,
          root: entry.root,
          branch: null,
          baseBranch: null,
        }),
      );
      return repositories.length === 0
        ? [
            {
              key: ".",
              root: project.workspaceRoot,
              branch: null,
              baseBranch: null,
            },
          ]
        : repositories;
    });

  return HoustonProjectRepositories.of({
    list,
    track,
    untrack,
    setIgnorePatterns,
    repositoriesForThread,
  });
});

export const layer = Layer.effect(HoustonProjectRepositories, make);

/** Makes the runtime see every repository a project covers instead of its project folder alone. */
export const layerThreadRepositoryResolver = Layer.effect(
  ThreadRepositoryResolver,
  Effect.gen(function* () {
    const repositories = yield* HoustonProjectRepositories;
    return {
      list: Effect.fn("ThreadRepositoryResolver.list")((project) =>
        repositories.repositoriesForThread(project),
      ),
    };
  }),
);
