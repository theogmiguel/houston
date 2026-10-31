// The four houston.review.* methods through the real `/ws` handlers and the real scope table.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  AuthFilesystemReadScope,
  AuthSessionId,
  AuthSourceControlWriteScope,
  EnvironmentId,
  WS_METHODS,
  WsRpcGroup,
  type AuthEnvironmentScope,
} from "@t3tools/contracts";
import type { ReviewLineAnchor } from "@t3tools/contracts/houston/reviewState";
import * as AcpRegistryRuntimeCoordinator from "@t3tools/provider-acp-registry/server/AcpRegistryRuntimeCoordinator";
import * as AcpRegistrySupport from "@t3tools/provider-acp-registry/server/AcpRegistrySupport";
import * as ProviderLatestVersions from "@t3tools/provider-core/server/ProviderLatestVersions";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import type * as Scope from "effect/Scope";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";
import { Headers } from "effect/http";
import { RpcMessage, RpcServer } from "effect/rpc";

import * as AgentSessionImporter from "../project/AgentSessionImporter.ts";
import * as AgentSessionScanner from "../project/AgentSessionScanner.ts";
import * as AnalyticsService from "../telemetry/AnalyticsService.ts";
import * as AntigravityInstallation from "../provider/AntigravityInstallation.ts";
import * as BackgroundPolicy from "../background/BackgroundPolicy.ts";
import * as CheckpointDiffQuery from "../checkpointing/CheckpointDiffQuery.ts";
import * as CodexInstallation from "../provider/CodexInstallation.ts";
import * as CommandOutputHub from "../orchestration-v2/CommandOutputHub.ts";
import * as DatabaseStorage from "../persistence/DatabaseStorage.ts";
import * as DeviceService from "../device/DeviceService.ts";
import * as DirectEndpoints from "../environment/DirectEndpoints.ts";
import * as DocumentText from "../provider/DocumentText.ts";
import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as EnvironmentTheme from "../environmentTheme.ts";
import * as ExternalLauncher from "../process/externalLauncher.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import * as HostResources from "../resourceTelemetry/HostResources.ts";
import * as Keybindings from "../keybindings.ts";
import * as KnownWorkspaces from "../workspace/KnownWorkspaces.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as McpAppRequests from "../mcpApps/McpAppRequests.ts";
import * as ModelManifest from "../provider/ModelManifest.ts";
import * as OrchestrationEventStore from "../persistence/OrchestrationEventStore.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as OtlpEndpointCheck from "../observability/OtlpEndpointCheck.ts";
import * as PairingGrantStore from "../auth/PairingGrantStore.ts";
import * as PeerLinkRequests from "../peer/PeerLinkRequests.ts";
import * as PeerLinks from "../peer/PeerLinks.ts";
import * as PortScanner from "../preview/PortScanner.ts";
import * as PreviewAutomationBroker from "../mcp/PreviewAutomationBroker.ts";
import * as PreviewManager from "../preview/Manager.ts";
import * as ProcessDiagnostics from "../diagnostics/ProcessDiagnostics.ts";
import * as ProcessResourceMonitor from "../diagnostics/ProcessResourceMonitor.ts";
import * as ProjectCloneTracker from "../project/ProjectCloneTracker.ts";
import * as ProjectEnrichment from "../project/ProjectEnrichmentService.ts";
import * as ProjectFaviconResolver from "../project/ProjectFaviconResolver.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProjectSetupScriptRunner from "../project/ProjectSetupScriptRunner.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ProviderAuthService from "../provider/ProviderAuthService.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as ProviderMaintenanceRunner from "../provider/providerMaintenanceRunner.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ProviderSessionManager from "../orchestration-v2/ProviderSessionManager.ts";
import * as PullRequestReviewGuideService from "../pullRequest/PullRequestReviewGuideService.ts";
import * as PullRequestService from "../pullRequest/PullRequestService.ts";
import * as PullRequestSyncReactor from "../orchestration-v2/PullRequestSyncReactor.ts";
import * as RemoteOpenTargets from "../environment/RemoteOpenTargets.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import * as ResourceTelemetry from "../resourceTelemetry/ResourceTelemetry.ts";
import * as ReviewService from "../review/ReviewService.ts";
import * as RpcAuthorization from "../auth/RpcAuthorization.ts";
import * as ScheduledTasks from "../scheduledTasks/ScheduledTaskService.ts";
import * as ScratchThreadPromotion from "../project/ScratchThreadPromotion.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as ServerBrowser from "../preview/ServerBrowser.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ServerLifecycleEvents from "../serverLifecycleEvents.ts";
import * as ServerRuntimeStartup from "../serverRuntimeStartup.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerSelfUpdate from "../cloud/selfUpdate.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as SessionStore from "../auth/SessionStore.ts";
import * as SourceControlDiscovery from "../sourceControl/SourceControlDiscovery.ts";
import * as SourceControlRepositoryService from "../sourceControl/SourceControlRepositoryService.ts";
import * as SourceControlSignIn from "../sourceControl/SourceControlSignIn.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as StorageCleanup from "../storageCleanup.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ThreadSearch from "../orchestration-v2/ThreadSearch.ts";
import * as TraceDiagnostics from "../diagnostics/TraceDiagnostics.ts";
import * as TriageService from "../triage/TriageService.ts";
import * as UsageLimitSources from "../usage/UsageLimitSources.ts";
import * as UsageService from "../usage/UsageService.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProvisioningService from "../vcs/VcsProvisioningService.ts";
import * as VcsStatusBroadcaster from "../vcs/VcsStatusBroadcaster.ts";
import * as WorkspaceEntries from "../workspace/WorkspaceEntries.ts";
import * as WorkspaceFileSystem from "../workspace/WorkspaceFileSystem.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import * as WorktreeSetupTracker from "../project/WorktreeSetupTracker.ts";
import { layerWsRpc, WS_RPC_SERVER_OPTIONS } from "../ws.ts";
import * as HoustonReviewState from "./reviewState.ts";
import * as HoustonTaskService from "./tasks/TaskService.ts";
import * as HoustonTaskRuns from "./tasks/TaskRuns.ts";
import * as HoustonTaskV1Import from "./tasks/V1Import.ts";
import * as HoustonTaskSourceService from "./taskSources/SourceService.ts";
import * as HoustonTaskSourceV1Import from "./taskSources/V1Import.ts";
import * as HoustonMergeQueueService from "./mergeQueue/Service.ts";

// Build the production RPC layer; unrelated capabilities fail if these tests call them.
const layerUnusedRpcServices = Layer.mergeAll(
  Layer.mock(DocumentText.DocumentText)({}),
  Layer.mock(WorkspacePaths.WorkspacePaths)({}),
  Layer.mock(TraceDiagnostics.TraceDiagnostics)({}),
  Layer.mock(TriageService.TriageService)({}),
  Layer.mock(ProjectFaviconResolver.ProjectFaviconResolver)({}),
  Layer.mock(ProjectEnrichment.ProjectEnrichmentService)({}),
  Layer.mock(AcpRegistryRuntimeCoordinator.AcpRegistryRuntimeCoordinator)({}),
  Layer.mock(AcpRegistrySupport.AcpRegistryCatalog)({}),
  Layer.mock(AgentSessionImporter.AgentSessionImporter)({}),
  Layer.mock(AgentSessionScanner.AgentSessionScanner)({}),
  Layer.mock(AnalyticsService.AnalyticsService)({}),
  Layer.mock(AntigravityInstallation.AntigravityInstallation)({ managedDirectory: "/unused" }),
  Layer.mock(BackgroundPolicy.BackgroundPolicy)({}),
  Layer.mock(CheckpointDiffQuery.CheckpointDiffQuery)({}),
  Layer.mock(CommandOutputHub.CommandOutputHub)({}),
  Layer.mock(CodexInstallation.CodexInstallation)({ managedDirectory: "/unused" }),
  Layer.mock(DeviceService.DeviceService)({}),
  Layer.mock(EnvironmentTheme.EnvironmentThemeService)({}),
  Layer.mock(GitWorkflowService.GitWorkflowService)({}),
  Layer.mock(HostResources.HostResources)({}),
  Layer.mock(McpAppRequests.McpAppRequests)({}),
  Layer.mock(OrchestrationEventStore.OrchestrationEventStore)({}),
  Layer.mock(Orchestrator.OrchestratorV2)({}),
  Layer.mock(OtlpEndpointCheck.OtlpEndpointCheck)({}),
  Layer.mock(PairingGrantStore.PairingGrantStore)({}),
  Layer.mock(PeerLinks.PeerLinks)({}),
  Layer.mock(PeerLinkRequests.PeerLinkRequests)({}),
  Layer.mock(PortScanner.PortDiscovery)({ trackAgent: () => () => undefined }),
  Layer.mock(PreviewManager.PreviewManager)({}),
  Layer.mock(ProcessDiagnostics.ProcessDiagnostics)({}),
  Layer.mock(ProcessResourceMonitor.ProcessResourceMonitor)({}),
  Layer.mock(ProjectCloneTracker.ProjectCloneTracker)({}),
  Layer.mock(ProjectService.ProjectService)({}),
  Layer.mock(ProjectSetupScriptRunner.ProjectSetupScriptRunner)({}),
  Layer.mock(ProviderAuthService.ProviderAuthService)({}),
  Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({}),
  Layer.mock(ProviderMaintenanceRunner.ProviderMaintenanceRunner)({}),
  Layer.mock(ProviderRegistry.ProviderRegistry)({}),
  Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({}),
  Layer.mock(PullRequestReviewGuideService.PullRequestReviewGuideService)({}),
  Layer.mock(PullRequestService.PullRequestService)({}),
  Layer.mock(PullRequestSyncReactor.PullRequestSyncReactor)({}),
  Layer.mock(RepositoryIdentityResolver.RepositoryIdentityResolver)({}),
  Layer.mock(ResourceTelemetry.ResourceTelemetry)({}),
  Layer.mock(ScheduledTasks.ScheduledTaskService)({}),
  Layer.mock(HoustonTaskService.HoustonTaskService)({}),
  Layer.mock(HoustonTaskRuns.HoustonTaskRuns)({}),
  Layer.mock(HoustonTaskV1Import.HoustonTaskV1Import)({}),
  Layer.mock(HoustonTaskSourceService.HoustonTaskSourceService)({}),
  Layer.mock(HoustonTaskSourceV1Import.HoustonTaskSourceV1Import)({}),
  Layer.mock(HoustonMergeQueueService.HoustonMergeQueueService)({}),
  Layer.mock(SecretRequests.SecretRequests)({}),
  Layer.mock(ServerLifecycleEvents.ServerLifecycleEvents)({}),
  Layer.mock(ServerRuntimeStartup.ServerRuntimeStartup)({}),
  Layer.mock(ServerSelfUpdate.ServerSelfUpdate)({}),
  Layer.mock(SessionStore.SessionStore)({
    cookieName: "review-state-test",
    legacyCookieName: undefined,
  }),
  Layer.mock(SourceControlDiscovery.SourceControlDiscovery)({}),
  Layer.mock(SourceControlRepositoryService.SourceControlRepositoryService)({}),
  Layer.mock(SourceControlSignIn.SourceControlSignIn)({}),
  Layer.mock(StorageCleanup.StorageCleanup)({}),
  Layer.mock(DatabaseStorage.DatabaseStorage)({}),
  Layer.mock(TerminalManager.TerminalManager)({}),
  Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
  Layer.mock(ThreadManagement.ThreadManagementService)({}),
  Layer.mock(ThreadSearch.ThreadSearch)({}),
  Layer.mock(UsageService.UsageService)({}),
  Layer.mock(VcsProvisioningService.VcsProvisioningService)({}),
  Layer.mock(VcsStatusBroadcaster.VcsStatusBroadcaster)({}),
  Layer.mock(WorkspaceEntries.WorkspaceEntries)({}),
  Layer.mock(WorkspaceFileSystem.WorkspaceFileSystem)({}),
  Layer.mock(WorktreeSetupTracker.WorktreeSetupTracker)({}),
  Layer.mock(ExternalLauncher.ExternalLauncher)({
    resolveAvailableEditors: () => Effect.succeed([]),
    // @effect-diagnostics-next-line effectSucceedWithVoid:off - This optional result requires undefined, not the wider void type.
    resolveFileManagerRevealKind: () => Effect.succeed(undefined),
  }),
  Layer.mock(UsageLimitSources.UsageLimitSources)({
    current: Effect.succeed([]),
    refresh: Effect.void,
    streamChanges: Stream.make([]),
  }),
  Layer.mock(RemoteOpenTargets.RemoteOpenTargets)({ resolveTargets: () => Effect.succeed([]) }),
  Layer.mock(DirectEndpoints.DirectEndpoints)({ resolve: () => Effect.succeed([]) }),
  Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
    scratchRoot: Effect.succeedNone,
    namedProjectsRoot: process.cwd(),
  }),
  Layer.mock(ScratchThreadPromotion.ScratchThreadPromotion)({}),
  Layer.mock(ServerEnvironment.ServerEnvironment)({
    getDescriptor: Effect.succeed({
      environmentId: EnvironmentId.make("review-state-test"),
      label: "Review state test",
      platform: { os: "linux", arch: "x64" },
      serverVersion: "0.0.0",
      capabilities: { repositoryIdentity: false },
    }),
  }),
  Layer.mock(EnvironmentAuth.EnvironmentAuth)({
    getDescriptor: () =>
      Effect.succeed({
        policy: "loopback-browser",
        bootstrapMethods: [],
        sessionMethods: ["browser-session-cookie"],
        sessionCookieName: "review-state-test-session",
      }),
  }),
  Layer.mock(PreviewAutomationBroker.PreviewAutomationBroker)({}),
  Layer.mock(ServerBrowser.ServerBrowser)({}),
  Layer.mock(ModelManifest.ModelManifest)({}),
  Layer.mock(ProviderLatestVersions.ProviderLatestVersions)({}),
);

/** The review services as server.ts provides them, over one database. */
const layerReview = (input: {
  readonly workspaceRoot: string;
  readonly baseDir: string;
  /** A database file that outlives the layer; in memory when absent. */
  readonly databaseFile?: string;
}) =>
  HoustonReviewState.layer.pipe(
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
    Layer.provideMerge(GitVcsDriver.layer),
    Layer.provideMerge(
      Layer.mergeAll(
        Keybindings.layer,
        ServerSettings.layer.pipe(Layer.provide(ServerSecretStore.layer)),
        ServerSecretStore.layer,
      ),
    ),
    Layer.provideMerge(
      input.databaseFile === undefined
        ? Layer.fresh(SqlitePersistence.layerMemory)
        : Layer.fresh(SqlitePersistence.layerFromPath(input.databaseFile)).pipe(
            Layer.provide(NodeServices.layer),
          ),
    ),
    Layer.provideMerge(ServerConfig.layerTest(input.workspaceRoot, input.baseDir)),
    Layer.provideMerge(NodeServices.layer),
  );

const failureOf = (value: unknown) => {
  // A void success arrives as undefined.
  const exit = (value as { readonly failed?: Exit.Exit<unknown, unknown> } | undefined)?.failed;
  if (exit === undefined || !Exit.isFailure(exit)) return null;
  return Cause.squash(exit.cause) as { readonly _tag?: string; readonly operation?: string };
};

/** A `/ws` client of the real handlers, authorized by the real scope table. */
const makeWsClient = Effect.fn("makeWsClient")(function* (
  scopes: ReadonlyArray<AuthEnvironmentScope>,
) {
  const responses = yield* Queue.unbounded<unknown>();
  const browser = yield* ServerBrowser.ServerBrowser;
  const server = yield* RpcServer.makeNoSerialization(WsRpcGroup, {
    ...WS_RPC_SERVER_OPTIONS,
    onFromServer: (response) =>
      response._tag === "Exit" && response.exit._tag === "Success"
        ? Queue.offer(responses, response.exit.value)
        : response._tag === "Exit"
          ? Queue.offer(responses, { failed: response.exit })
          : Effect.void,
  }).pipe(
    Effect.provide(
      Layer.merge(
        layerWsRpc(
          {
            sessionId: AuthSessionId.make("review-state-test"),
            subject: "review-state-test",
            method: "browser-session-cookie",
            scopes: [...scopes],
          },
          {},
          browser,
        ),
        RpcAuthorization.layer(scopes),
      ),
    ),
  );
  let next = 0;
  const call = (tag: string, payload: object) =>
    Effect.gen(function* () {
      next += 1;
      yield* server.write(0, {
        _tag: "Request",
        id: RpcMessage.RequestId(String(next)),
        tag,
        payload,
        headers: Headers.empty,
      } as never);
      return yield* Queue.take(responses);
    });
  return { call };
});

const git = (cwd: string, args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const driver = yield* GitVcsDriver.GitVcsDriver;
    const result = yield* driver.execute({
      operation: "HoustonReviewState.ws.test.git",
      cwd,
      args,
      timeoutMs: 30_000,
    });
    return result.stdout.trim();
  });

const initRepo = (repo: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* git(repo, ["init", "-q", "-b", "main"]);
    yield* git(repo, ["config", "user.email", "test@test.com"]);
    yield* git(repo, ["config", "user.name", "Test"]);
    yield* git(repo, ["config", "core.autocrlf", "false"]);
    yield* git(repo, ["config", "commit.gpgsign", "false"]);
    yield* fs.writeFileString(
      path.join(repo, "a.ts"),
      `${Array.from({ length: 20 }, (_, index) => `line ${index + 1}`).join("\n")}\n`,
    );
    yield* git(repo, ["add", "-A"]);
    yield* git(repo, ["commit", "-q", "-m", "initial"]);
  });

const markRows = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql<{ readonly path: string }>`SELECT path FROM houston_review_files_viewed`;
});

const looseObjectCount = (repo: string) =>
  git(repo, ["count-objects", "-v"]).pipe(
    Effect.map((output) => Number(/^count: (\d+)$/m.exec(output)?.[1] ?? "0")),
  );

const layerServer = (input: Parameters<typeof layerReview>[0]) =>
  layerUnusedRpcServices.pipe(Layer.provideMerge(layerReview(input)));

type ServerServices = Layer.Success<ReturnType<typeof layerServer>> | Scope.Scope;

const withServer = <A, E>(
  body: (dirs: {
    readonly repo: string;
    readonly outside: string;
  }) => Effect.Effect<A, E, ServerServices>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const repo = yield* fs.makeTempDirectoryScoped({ prefix: "houston-review-ws-repo-" });
    const outside = yield* fs.makeTempDirectoryScoped({ prefix: "houston-review-ws-outside-" });
    const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "houston-review-ws-base-" });
    return yield* body({ repo, outside }).pipe(
      Effect.provide(layerServer({ workspaceRoot: repo, baseDir })),
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

const anchorPayload = (cwd: string) => ({
  cwd,
  path: "a.ts",
  side: "new",
  startLine: 10,
  endLine: 12,
});

describe("write methods need the source control write scope", () => {
  it.effect("without it set and anchor are refused and change nothing; with it they succeed", () =>
    withServer(({ repo }) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        yield* initRepo(repo);
        // An uncommitted edit, so an accepted anchor would write a new object.
        yield* fs.writeFileString(path.join(repo, "a.ts"), "edited\n".repeat(20));
        const objectsBefore = yield* looseObjectCount(repo);

        const reader = yield* makeWsClient([AuthFilesystemReadScope]);
        const refusedSet = yield* reader.call(WS_METHODS.houstonReviewSetFilesViewed, {
          cwd: repo,
          files: [{ path: "a.ts", viewed: true }],
        });
        assert.equal(failureOf(refusedSet)?._tag, "EnvironmentAuthorizationError");
        const refusedAnchor = yield* reader.call(
          WS_METHODS.houstonReviewAnchorLines,
          anchorPayload(repo),
        );
        assert.equal(failureOf(refusedAnchor)?._tag, "EnvironmentAuthorizationError");
        assert.deepEqual(yield* markRows, []);
        assert.equal(yield* looseObjectCount(repo), objectsBefore);

        // The read methods need only the scope review.getDiffPreview needs.
        const listed = yield* reader.call(WS_METHODS.houstonReviewFilesViewed, { cwd: repo });
        assert.isNull(failureOf(listed));
        assert.deepEqual((listed as { readonly files: unknown }).files, []);

        const writer = yield* makeWsClient([AuthFilesystemReadScope, AuthSourceControlWriteScope]);
        const set = yield* writer.call(WS_METHODS.houstonReviewSetFilesViewed, {
          cwd: repo,
          files: [{ path: "a.ts", viewed: true }],
        });
        assert.isNull(failureOf(set));
        assert.deepEqual(
          (yield* markRows).map((row) => row.path),
          ["a.ts"],
        );
        const anchor = yield* writer.call(WS_METHODS.houstonReviewAnchorLines, anchorPayload(repo));
        assert.isNull(failureOf(anchor));
        assert.equal(yield* looseObjectCount(repo), objectsBefore + 1);

        const viewed = yield* reader.call(WS_METHODS.houstonReviewFilesViewed, { cwd: repo });
        assert.deepEqual(
          (viewed as { readonly files: ReadonlyArray<{ readonly state: string }> }).files.map(
            (file) => file.state,
          ),
          ["viewed"],
        );
        const mapped = yield* reader.call(WS_METHODS.houstonReviewMapAnchors, {
          cwd: repo,
          anchors: [anchor as ReviewLineAnchor],
        });
        assert.isNull(failureOf(mapped));
        assert.deepEqual((mapped as { readonly anchors: unknown }).anchors, [
          { state: "current", path: "a.ts", startLine: 10, endLine: 12 },
        ]);

        // Without the read scope even the read methods are refused.
        const nobody = yield* makeWsClient([]);
        const unread = yield* nobody.call(WS_METHODS.houstonReviewFilesViewed, { cwd: repo });
        assert.equal(failureOf(unread)?._tag, "EnvironmentAuthorizationError");
        const unmapped = yield* nobody.call(WS_METHODS.houstonReviewMapAnchors, {
          cwd: repo,
          anchors: [anchor as ReviewLineAnchor],
        });
        assert.equal(failureOf(unmapped)?._tag, "EnvironmentAuthorizationError");
      }),
    ),
  );
});

describe("every method refuses a cwd outside the workspaces", () => {
  it.effect("all four fail with VcsRepositoryDetectionError", () =>
    withServer(({ repo, outside }) =>
      Effect.gen(function* () {
        yield* initRepo(repo);
        yield* initRepo(outside);
        const anchor = {
          path: "a.ts",
          side: "new",
          startLine: 10,
          endLine: 12,
          headSha: yield* git(outside, ["rev-parse", "HEAD"]),
          blob: yield* git(outside, ["rev-parse", "HEAD:a.ts"]),
        };
        const client = yield* makeWsClient([AuthFilesystemReadScope, AuthSourceControlWriteScope]);
        const calls = [
          [WS_METHODS.houstonReviewFilesViewed, { cwd: outside }],
          [
            WS_METHODS.houstonReviewSetFilesViewed,
            { cwd: outside, files: [{ path: "a.ts", viewed: true }] },
          ],
          [WS_METHODS.houstonReviewAnchorLines, anchorPayload(outside)],
          [WS_METHODS.houstonReviewMapAnchors, { cwd: outside, anchors: [anchor] }],
        ] as const;
        for (const [method, payload] of calls) {
          const response = yield* client.call(method, payload);
          assert.equal(failureOf(response)?._tag, "VcsRepositoryDetectionError", method);
        }
        assert.deepEqual(yield* markRows, []);
      }),
    ),
  );
});

describe("marks survive a restart", () => {
  it.effect("a file-backed database closed and reopened keeps the marks", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dataDir = yield* fs.makeTempDirectoryScoped({ prefix: "houston-review-ws-data-" });
      const databaseFile = path.join(dataDir, "state.sqlite");
      const repo = yield* fs.makeTempDirectoryScoped({ prefix: "houston-review-ws-restart-" });
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "houston-review-ws-base-" });
      // Each run builds and closes its own server layer over the same database file.
      const run = <A, E>(body: Effect.Effect<A, E, ServerServices>) =>
        body.pipe(
          Effect.provide(layerServer({ workspaceRoot: repo, baseDir, databaseFile })),
          Effect.scoped,
        );

      yield* run(
        Effect.gen(function* () {
          yield* initRepo(repo);
          const client = yield* makeWsClient([
            AuthFilesystemReadScope,
            AuthSourceControlWriteScope,
          ]);
          const set = yield* client.call(WS_METHODS.houstonReviewSetFilesViewed, {
            cwd: repo,
            files: [{ path: "a.ts", viewed: true }],
          });
          assert.isNull(failureOf(set));
        }),
      );

      const after = yield* run(
        Effect.gen(function* () {
          const client = yield* makeWsClient([AuthFilesystemReadScope]);
          return yield* client.call(WS_METHODS.houstonReviewFilesViewed, { cwd: repo });
        }),
      );
      assert.deepEqual(
        (
          after as {
            readonly files: ReadonlyArray<{ readonly path: string; readonly state: string }>;
          }
        ).files.map((file) => [file.path, file.state]),
        [["a.ts", "viewed"]],
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
