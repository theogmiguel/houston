// The grid RPCs through the real `/ws` handlers over an in-memory database: put with a revision,
// list, the change stream and delete.
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  AuthSessionId,
  EnvironmentId,
  RpcScopeAuthorization,
  WS_METHODS,
  WsRpcGroup,
} from "@houston-app/contracts";
import * as AcpRegistryRuntimeCoordinator from "@houston-app/provider-acp-registry/server/AcpRegistryRuntimeCoordinator";
import * as AcpRegistrySupport from "@houston-app/provider-acp-registry/server/AcpRegistrySupport";
import * as ProviderLatestVersions from "@houston-app/provider-core/server/ProviderLatestVersions";
import * as SecretResolver from "@houston-app/secret-provider-core/server/SecretResolver";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
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
import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import * as HostResources from "../resourceTelemetry/HostResources.ts";
import * as Keybindings from "../keybindings.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import * as NpmRelease from "../cloud/npmRelease.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as McpAppRequests from "../mcpApps/McpAppRequests.ts";
import * as ModelManifest from "../provider/ModelManifest.ts";
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
import * as ProjectFaviconResolver from "../project/ProjectFaviconResolver.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProjectSetupScriptRunner from "../project/ProjectSetupScriptRunner.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ProviderAuthService from "../provider/ProviderAuthService.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as ProviderMaintenanceRunner from "../provider/providerMaintenanceRunner.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as PullRequestReviewGuideService from "../pullRequest/PullRequestReviewGuideService.ts";
import * as PullRequestService from "../pullRequest/PullRequestService.ts";
import * as PullRequestSyncReactor from "../orchestration-v2/PullRequestSyncReactor.ts";
import * as RemoteOpenTargets from "../environment/RemoteOpenTargets.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import * as ResourceTelemetry from "../resourceTelemetry/ResourceTelemetry.ts";
import * as ReviewService from "../review/ReviewService.ts";
import * as ScheduledTasks from "../scheduledTasks/ScheduledTaskService.ts";
import * as ScratchThreadPromotion from "../project/ScratchThreadPromotion.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as ServerBrowser from "../preview/ServerBrowser.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as OrchestrationEventStore from "../persistence/OrchestrationEventStore.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectEnrichment from "../project/ProjectEnrichmentService.ts";
import * as ProviderSessionManager from "../orchestration-v2/ProviderSessionManager.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ServerLifecycleEvents from "../serverLifecycleEvents.ts";
import * as ServerRuntimeStartup from "../serverRuntimeStartup.ts";
import * as AssetSigner from "../assets/AssetSigner.ts";
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
import * as ThreadSearch from "../orchestration-v2/ThreadSearch.ts";
import * as TraceDiagnostics from "../diagnostics/TraceDiagnostics.ts";
import * as TriageService from "../triage/TriageService.ts";
import * as UsageLimitSources from "../usage/UsageLimitSources.ts";
import * as UsageService from "../usage/UsageService.ts";
import * as VcsProvisioningService from "../vcs/VcsProvisioningService.ts";
import * as VcsStatusBroadcaster from "../vcs/VcsStatusBroadcaster.ts";
import * as WorkspaceEntries from "../workspace/WorkspaceEntries.ts";
import * as WorkspaceFileSystem from "../workspace/WorkspaceFileSystem.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import * as WorktreeSetupTracker from "../project/WorktreeSetupTracker.ts";
import { layerWsRpc, WS_RPC_SERVER_OPTIONS } from "../ws.ts";

import * as HoustonResumeSessions from "./resumeSessions.ts";
import * as HoustonReviewState from "./reviewState.ts";
import * as HoustonTaskService from "./tasks/TaskService.ts";
import * as HoustonTaskRuns from "./tasks/TaskRuns.ts";
import * as HoustonTaskV1Import from "./tasks/V1Import.ts";
import * as HoustonTaskSourceService from "./taskSources/SourceService.ts";
import * as HoustonGrids from "./grids.ts";
import * as HoustonSlackService from "./slack/Service.ts";
import * as HoustonSlackV1Import from "./slack/V1Import.ts";
import * as HoustonTaskSourceV1Import from "./taskSources/V1Import.ts";
import * as HoustonMergeQueueService from "./mergeQueue/Service.ts";

// Build the production RPC layer; unrelated capabilities fail if these tests call them.
const layerUnusedRpcServices = Layer.mergeAll(
  Layer.mock(DocumentText.DocumentText)({}),
  Layer.mock(OrchestrationEventStore.OrchestrationEventStore)({}),
  Layer.mock(Orchestrator.OrchestratorV2)({}),
  Layer.mock(ProjectEnrichment.ProjectEnrichmentService)({}),
  Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({}),
  Layer.mock(ThreadManagement.ThreadManagementService)({}),
  Layer.mock(AssetSigner.AssetSigner)({}),
  Layer.mock(ServerSecretStore.ServerSecretStore)({}),
  Layer.mock(WorkspacePaths.WorkspacePaths)({}),
  Layer.mock(TraceDiagnostics.TraceDiagnostics)({}),
  Layer.mock(TriageService.TriageService)({}),
  Layer.mock(ProjectFaviconResolver.ProjectFaviconResolver)({}),
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
  Layer.mock(HoustonReviewState.HoustonReviewState)({}),
  Layer.mock(HoustonResumeSessions.HoustonResumeSessions)({}),
  Layer.mock(HoustonTaskService.HoustonTaskService)({}),
  Layer.mock(HoustonTaskRuns.HoustonTaskRuns)({}),
  Layer.mock(HoustonTaskV1Import.HoustonTaskV1Import)({}),
  Layer.mock(HoustonTaskSourceService.HoustonTaskSourceService)({}),
  Layer.mock(HoustonSlackService.HoustonSlackService)({}),
  Layer.mock(HoustonSlackV1Import.HoustonSlackV1Import)({}),
  Layer.mock(HoustonTaskSourceV1Import.HoustonTaskSourceV1Import)({}),
  Layer.mock(HoustonMergeQueueService.HoustonMergeQueueService)({}),
  Layer.mock(McpAppRequests.McpAppRequests)({}),
  Layer.mock(OtlpEndpointCheck.OtlpEndpointCheck)({}),
  Layer.mock(PairingGrantStore.PairingGrantStore)({}),
  Layer.mock(PeerLinks.PeerLinks)({}),
  Layer.mock(PeerLinkRequests.PeerLinkRequests)({}),
  Layer.mock(PortScanner.PortDiscovery)({ trackAgent: () => () => undefined }),
  Layer.mock(PreviewManager.PreviewManager)({}),
  Layer.mock(ProcessDiagnostics.ProcessDiagnostics)({}),
  Layer.mock(ProcessResourceMonitor.ProcessResourceMonitor)({}),
  Layer.mock(ProjectCloneTracker.ProjectCloneTracker)({}),
  Layer.mock(ProjectSetupScriptRunner.ProjectSetupScriptRunner)({}),
  Layer.mock(ProviderAuthService.ProviderAuthService)({}),
  Layer.mock(ProviderMaintenanceRunner.ProviderMaintenanceRunner)({}),
  Layer.mock(PullRequestReviewGuideService.PullRequestReviewGuideService)({}),
  Layer.mock(PullRequestService.PullRequestService)({}),
  Layer.mock(PullRequestSyncReactor.PullRequestSyncReactor)({}),
  Layer.mock(RepositoryIdentityResolver.RepositoryIdentityResolver)({}),
  Layer.mock(ResourceTelemetry.ResourceTelemetry)({}),
  Layer.mock(ReviewService.ReviewService)({}),
  Layer.mock(ScheduledTasks.ScheduledTaskService)({}),
  Layer.mock(SecretRequests.SecretRequests)({}),
  Layer.mock(SecretResolver.SecretResolver)({}),
  Layer.mock(ServerLifecycleEvents.ServerLifecycleEvents)({}),
  Layer.mock(ServerRuntimeStartup.ServerRuntimeStartup)({}),
  Layer.mock(ServerSelfUpdate.ServerSelfUpdate)({}),
  Layer.mock(NpmRelease.NpmRelease)({}),
  Layer.mock(SessionStore.SessionStore)({ cookieName: "grid-test", legacyCookieName: undefined }),
  Layer.mock(SourceControlDiscovery.SourceControlDiscovery)({}),
  Layer.mock(SourceControlRepositoryService.SourceControlRepositoryService)({}),
  Layer.mock(SourceControlSignIn.SourceControlSignIn)({}),
  Layer.mock(StorageCleanup.StorageCleanup)({}),
  Layer.mock(DatabaseStorage.DatabaseStorage)({}),
  Layer.mock(TerminalManager.TerminalManager)({}),
  Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
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
      environmentId: EnvironmentId.make("grid-test"),
      label: "Grid test",
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
        sessionCookieName: "grid-test-session",
      }),
  }),
  Layer.mock(PreviewAutomationBroker.PreviewAutomationBroker)({}),
  Layer.mock(ServerBrowser.ServerBrowser)({}),
  Layer.mock(ModelManifest.ModelManifest)({}),
  Layer.mock(ProviderLatestVersions.ProviderLatestVersions)({}),
  Layer.mock(ProviderRegistry.ProviderRegistry)({}),
  Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({}),
  // Scope checks have their own tests; these calls run as a fully scoped client.
  Layer.succeed(RpcScopeAuthorization)((effect) => effect),
  // The shell stream's project side: no projects, no enrichment.
  Layer.mock(ProjectStore.ProjectStoreV2)({
    listShells: () => Effect.succeed([]),
    get: (projectId: string) => Effect.succeedSome({ projectId, deletedAt: null } as never),
  }),
  Layer.mock(ProjectService.ProjectService)({ getShell: () => Effect.succeedNone }),
);

const layerConfigSources = Layer.mergeAll(
  Keybindings.layer,
  ServerSettings.layer.pipe(
    Layer.provide(Layer.merge(ServerSecretStore.layer, ManagedPolicy.layerTest())),
  ),
).pipe(Layer.provideMerge(Layer.fresh(SqlitePersistence.layerMemory)));

/** A `/ws` client of the real handlers; every response value lands in one queue. */
const makeWsClient = Effect.fn("makeWsClient")(function* () {
  const responses = yield* Queue.unbounded<unknown>();
  const browser = yield* ServerBrowser.ServerBrowser;
  const server = yield* RpcServer.makeNoSerialization(WsRpcGroup, {
    ...WS_RPC_SERVER_OPTIONS,
    onFromServer: (response) =>
      response._tag === "Chunk"
        ? Effect.forEach(response.values, (value) => Queue.offer(responses, value), {
            discard: true,
          })
        : response._tag === "Exit" && response.exit._tag === "Success"
          ? Queue.offer(responses, response.exit.value)
          : response._tag === "Exit"
            ? Queue.offer(responses, { failed: response.exit })
            : Effect.void,
  }).pipe(
    Effect.provide(
      layerWsRpc(
        {
          sessionId: AuthSessionId.make("grid-test"),
          subject: "grid-test",
          method: "browser-session-cookie",
          scopes: [],
        },
        {},
        browser,
        () => Effect.void,
      ),
    ),
  );
  const request = (id: string, tag: string, payload: object) =>
    server.write(0, {
      _tag: "Request",
      id: RpcMessage.RequestId(id),
      tag,
      payload,
      headers: Headers.empty,
    } as never);
  const ack = (id: string) => server.write(0, { _tag: "Ack", requestId: RpcMessage.RequestId(id) });
  const interrupt = (id: string) =>
    server.write(0, { _tag: "Interrupt", requestId: RpcMessage.RequestId(id), interruptors: [] });
  return { responses, request, ack, interrupt };
});

const layerGrids = HoustonGrids.layer.pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      layerUnusedRpcServices,
      Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
        getEnvironmentId: Effect.succeed(EnvironmentId.make("grid-test")),
      }),
    ),
  ),
);

const withWs = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.provide(
      layerGrids.pipe(
        Layer.provideMerge(layerConfigSources),
        Layer.provideMerge(
          ServerConfig.layerTest(process.cwd(), { prefix: "houston-grids-ws-" }).pipe(
            Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
          ),
        ),
      ),
    ),
    Effect.scoped,
  );

const grid = (overrides: Record<string, unknown> = {}) => ({
  id: "g1",
  environmentId: "grid-test",
  projectId: "p1",
  workspaceKey: "grid-test:p1",
  name: "Grid 1",
  tree: null,
  pinnedAt: null,
  hidden: false,
  createdAt: "2026-01-01T00:00:00.000Z",
  revision: 0,
  updatedAt: "2026-01-01T00:00:00.000Z",
  ...overrides,
});

describe("grids over /ws", () => {
  it.effect("put, list, conflict and delete round-trip through the handlers", () =>
    withWs(
      Effect.gen(function* () {
        const client = yield* makeWsClient();
        yield* client.request("put-1", WS_METHODS.houstonGridsPut, {
          grid: grid(),
          expectedRevision: 0,
        });
        const saved = (yield* Queue.take(client.responses)) as {
          status: string;
          grid: { revision: number };
        };
        assert.deepInclude(saved, { status: "saved" });
        assert.equal(saved.grid.revision, 1);

        yield* client.request("list-1", WS_METHODS.houstonGridsList, { projectId: "p1" });
        const listed = (yield* Queue.take(client.responses)) as ReadonlyArray<{ id: string }>;
        assert.deepEqual(
          listed.map((entry) => entry.id),
          ["g1"],
        );

        yield* client.request("put-2", WS_METHODS.houstonGridsPut, {
          grid: grid({ name: "Stale" }),
          expectedRevision: 0,
        });
        const conflict = (yield* Queue.take(client.responses)) as {
          status: string;
          current: { name: string; revision: number };
        };
        assert.equal(conflict.status, "conflict");
        assert.deepInclude(conflict.current, { name: "Grid 1", revision: 1 });

        yield* client.request("delete-1", WS_METHODS.houstonGridsDelete, { gridId: "g1" });
        assert.deepEqual(yield* Queue.take(client.responses), { deleted: true });
        yield* client.request("list-2", WS_METHODS.houstonGridsList, {});
        assert.deepEqual(yield* Queue.take(client.responses), []);
      }),
    ),
  );

  it.effect("the stream opens with a snapshot and then carries a later put", () =>
    withWs(
      Effect.gen(function* () {
        const watcher = yield* makeWsClient();
        const writer = yield* makeWsClient();
        yield* watcher.request("watch", WS_METHODS.houstonGridsSubscribe, {});
        assert.deepEqual(yield* Queue.take(watcher.responses), { snapshot: { grids: [] } });
        // The server sends the next chunk only after the client acknowledges this one.
        yield* watcher.ack("watch");

        yield* writer.request("put", WS_METHODS.houstonGridsPut, {
          grid: grid({ id: "g2", name: "Streamed" }),
          expectedRevision: 0,
        });
        yield* Queue.take(writer.responses);
        const event = (yield* Queue.take(watcher.responses)) as {
          upserted: { id: string; name: string; revision: number };
        };
        assert.deepInclude(event.upserted, { id: "g2", name: "Streamed", revision: 1 });
        yield* watcher.interrupt("watch");
      }),
    ),
  );

  it.effect("a grid name over the limit is refused before the handler runs", () =>
    withWs(
      Effect.gen(function* () {
        const client = yield* makeWsClient();
        yield* client.request("long", WS_METHODS.houstonGridsPut, {
          grid: grid({ name: "x".repeat(121) }),
          expectedRevision: 0,
        });
        const response = (yield* Queue.take(client.responses)) as { failed?: unknown };
        assert.isDefined(response.failed);
        yield* client.request("list", WS_METHODS.houstonGridsList, {});
        assert.deepEqual(yield* Queue.take(client.responses), []);
      }),
    ),
  );
});
