// The Tasks backlog over one database with the real project service, as server.ts provides it.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { CommandId, ProjectId, type ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as PlatformError from "effect/PlatformError";
import type { MigrationError } from "effect/sql/Migrator";
import type * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";

import * as ServerConfig from "../../config.ts";
import * as ProjectStore from "../../orchestration-v2/ProjectStore.ts";
import * as RuntimeLayer from "../../orchestration-v2/runtimeLayer.ts";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import * as ProjectEnrichmentService from "../../project/ProjectEnrichmentService.ts";
import * as ProjectFaviconResolver from "../../project/ProjectFaviconResolver.ts";
import * as ProjectService from "../../project/ProjectService.ts";
import * as RepositoryIdentityResolver from "../../project/RepositoryIdentityResolver.ts";
import * as ProviderInstanceRegistry from "../../provider/ProviderInstanceRegistry.ts";
import * as ServerSettings from "../../serverSettings.ts";
import { HostedLaunch } from "../baseDir.ts";
import * as WorkspacePaths from "../../workspace/WorkspacePaths.ts";
import * as HoustonTaskService from "./TaskService.ts";
import * as HoustonTaskStore from "./TaskStore.ts";
import * as HoustonTaskV1Import from "./V1Import.ts";

/** Instances the settings check treats as configured unless a test names others. */
export const CONFIGURED_INSTANCES: ReadonlyArray<string> = ["claudeAgent", "codex"];

export const layerWorkspacePaths = Layer.succeed(WorkspacePaths.WorkspacePaths, {
  normalizeWorkspaceRoot: (workspaceRoot) => Effect.succeed(workspaceRoot),
  resolveRelativePathWithinRoot: ({ workspaceRoot, relativePath }) =>
    Effect.succeed({ absolutePath: `${workspaceRoot}/${relativePath}`, relativePath }),
});

export const layerProjectMetadata = Layer.merge(
  Layer.succeed(RepositoryIdentityResolver.RepositoryIdentityResolver, {
    resolve: () => Effect.succeed(null),
  }),
  Layer.succeed(ProjectFaviconResolver.ProjectFaviconResolver, {
    invalidate: () => Effect.void,
    resolvePath: () => Effect.succeed(null),
  }),
);

export const layerInstances = (configured: ReadonlyArray<string>) =>
  Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({
    getInstance: (instanceId: ProviderInstanceId) =>
      Effect.succeed(configured.includes(instanceId) ? ({ instanceId } as never) : undefined),
  });

export interface TasksTestOptions {
  /** A database file that outlives the layer; in memory when absent. */
  readonly databaseFile?: string;
  /** The server base dir the v1 import looks beside. */
  readonly baseDir?: string;
  readonly configuredInstances?: ReadonlyArray<string>;
  /** Whether a host launched the server; true by default when `baseDir` is given. */
  readonly hosted?: boolean;
  /** A database another layer shares, such as the orchestration runtime's; wins over the others. */
  readonly databaseLayer?: Layer.Layer<
    SqlClient.SqlClient,
    MigrationError | PlatformError.PlatformError | SqlError
  >;
}

export const layerTasks = (options: TasksTestOptions = {}) =>
  Layer.mergeAll(HoustonTaskService.layer, HoustonTaskV1Import.layer).pipe(
    Layer.provideMerge(RuntimeLayer.layerProjectService),
    Layer.provideMerge(ProjectStore.layer),
    Layer.provideMerge(HoustonTaskStore.layer),
    Layer.provideMerge(layerInstances(options.configuredInstances ?? CONFIGURED_INSTANCES)),
    Layer.provideMerge(ProjectEnrichmentService.layer),
    Layer.provideMerge(layerWorkspacePaths),
    Layer.provideMerge(layerProjectMetadata),
    Layer.provideMerge(
      options.databaseLayer !== undefined
        ? Layer.orDie(options.databaseLayer)
        : options.databaseFile === undefined
          ? Layer.fresh(SqlitePersistence.layerMemory)
          : Layer.fresh(SqlitePersistence.layerFromPath(options.databaseFile)),
    ),
    Layer.provideMerge(ServerSettings.layerTest()),
    Layer.provideMerge(
      ServerConfig.layerTest(process.cwd(), options.baseDir ?? { prefix: "houston-tasks-test-" }),
    ),
    Layer.provideMerge(NodeServices.layer),
    Layer.provideMerge(
      Layer.succeed(HostedLaunch, options.hosted ?? options.baseDir !== undefined),
    ),
  );

let projectCommands = 0;

/** Registers a project through the real project service and returns its id. */
export const createProject = Effect.fn("HoustonTasksTest.createProject")(function* (
  name: string,
  workspaceRoot = `/work/${name}`,
) {
  const projects = yield* ProjectService.ProjectService;
  projectCommands += 1;
  const projectId = ProjectId.make(`project-${name}`);
  yield* projects.create({
    commandId: CommandId.make(`command:houston-tasks-test:create:${projectCommands}`),
    projectId,
    title: name,
    workspaceRoot,
  });
  return projectId;
});

export const deleteProject = Effect.fn("HoustonTasksTest.deleteProject")(function* (
  projectId: ProjectId,
) {
  const projects = yield* ProjectService.ProjectService;
  projectCommands += 1;
  yield* projects.delete({
    commandId: CommandId.make(`command:houston-tasks-test:delete:${projectCommands}`),
    projectId,
  });
});
