// Readiness through the real ProviderRegistry, ProviderEventIngestor and `/ws` handlers.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  AuthSessionId,
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderTurnId,
  RunAttemptId,
  RunId,
  RpcScopeAuthorization,
  WS_METHODS,
  WsRpcGroup,
  type ModelSelection,
  type OrchestrationV2AppThread,
  type OrchestrationV2ProviderFailure,
  type ServerConfig as ServerConfigPayload,
  type ServerConfigStreamEvent,
  type ServerProvider,
} from "@t3tools/contracts";
import { ProviderReadiness } from "@t3tools/contracts/houston/providerReadiness";
import * as AcpRegistryRuntimeCoordinator from "@t3tools/provider-acp-registry/server/AcpRegistryRuntimeCoordinator";
import * as AcpRegistrySupport from "@t3tools/provider-acp-registry/server/AcpRegistrySupport";
import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProviderLatestVersions from "@t3tools/provider-core/server/ProviderLatestVersions";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { Headers, HttpClient, HttpClientResponse } from "effect/http";
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
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as EventStore from "../orchestration-v2/EventStore.ts";
import * as ExternalLauncher from "../process/externalLauncher.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import * as HostResources from "../resourceTelemetry/HostResources.ts";
import * as Keybindings from "../keybindings.ts";
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
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProjectSetupScriptRunner from "../project/ProjectSetupScriptRunner.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ProviderAuthService from "../provider/ProviderAuthService.ts";
import * as ProviderEventIngestor from "../orchestration-v2/ProviderEventIngestor.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as ProviderInstanceRegistryMutator from "../provider/ProviderInstanceRegistryMutator.ts";
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
import * as ThreadCommandExecutor from "../orchestration-v2/ThreadCommandExecutor.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
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
import { ReadinessLedger } from "./providerReadiness.ts";
import * as HoustonReviewState from "./reviewState.ts";
import * as HoustonTaskService from "./tasks/TaskService.ts";
import * as HoustonTaskRuns from "./tasks/TaskRuns.ts";
import * as HoustonTaskV1Import from "./tasks/V1Import.ts";
import * as HoustonTaskSourceService from "./taskSources/SourceService.ts";
import * as HoustonSlackService from "./slack/Service.ts";
import * as HoustonTaskSourceV1Import from "./taskSources/V1Import.ts";

const decodeReadiness = Schema.decodeUnknownSync(ProviderReadiness);

const makeProvider = (driver: string, overrides: Partial<ServerProvider> = {}): ServerProvider => ({
  instanceId: ProviderInstanceId.make(driver),
  driver: ProviderDriverKind.make(driver),
  displayName: { claudeAgent: "Claude", codex: "Codex", opencode: "OpenCode" }[driver] ?? driver,
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-10-29T12:00:00.000Z",
  models: [],
  slashCommands: [],
  skills: [],
  ...overrides,
});

const CLAUDE = makeProvider("claudeAgent");
const CODEX = makeProvider("codex");
const OPENCODE = makeProvider("opencode");

interface FakeInstance {
  readonly instance: ProviderInstance;
  readonly set: (next: ServerProvider) => Effect.Effect<void>;
}

const makeFakeInstance = Effect.fn("makeFakeInstance")(function* (initial: ServerProvider) {
  const snapshotRef = yield* Ref.make(initial);
  const changes = yield* PubSub.unbounded<ServerProvider>();
  const instance = {
    instanceId: initial.instanceId,
    driverKind: initial.driver,
    displayName: initial.displayName,
    enabled: initial.enabled,
    snapshot: {
      getSnapshot: Ref.get(snapshotRef),
      refresh: Ref.get(snapshotRef),
      streamChanges: Stream.fromPubSub(changes),
      resolveMaintenance: () => Effect.die("unused in this test"),
      applyUsageLimits: () => Effect.die("unused in this test"),
    },
  } as unknown as ProviderInstance;
  return {
    instance,
    set: (next: ServerProvider) =>
      Ref.set(snapshotRef, next).pipe(Effect.andThen(PubSub.publish(changes, next)), Effect.asVoid),
  } satisfies FakeInstance;
});

const layerInstances = (instances: ReadonlyArray<FakeInstance>) =>
  Layer.merge(
    Layer.effect(
      ProviderInstanceRegistry.ProviderInstanceRegistry,
      Effect.gen(function* () {
        const changes = yield* PubSub.unbounded<void>();
        const list = instances.map((entry) => entry.instance);
        return {
          getInstance: (instanceId) =>
            Effect.succeed(list.find((instance) => instance.instanceId === instanceId)),
          listInstances: Effect.succeed(list),
          listUnavailable: Effect.succeed([]),
          streamChanges: Stream.never,
          subscribeChanges: PubSub.subscribe(changes),
        } satisfies ProviderInstanceRegistry.ProviderInstanceRegistry["Service"];
      }),
    ),
    Layer.succeed(ProviderInstanceRegistryMutator.ProviderInstanceRegistryMutator, {
      reconcile: () => Effect.void,
      reloadSecrets: () => Effect.void,
    }),
  );

const layerTestHttpClient = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make((request) =>
    Effect.succeed(HttpClientResponse.fromWeb(request, Response.json({ version: "0.0.0" }))),
  ),
);

const layerServerConfig = (prefix: string) =>
  ServerConfig.layerTest(process.cwd(), { prefix }).pipe(Layer.provideMerge(NodeServices.layer));

const layerRegistry = (instances: ReadonlyArray<FakeInstance>) =>
  ProviderRegistry.layer.pipe(
    Layer.provideMerge(layerInstances(instances)),
    Layer.provide(ModelManifest.layerTest),
    Layer.provide(ProviderLatestVersions.layer.pipe(Layer.provide(layerTestHttpClient))),
  );

const layerTestDatabase = SqlitePersistence.layerMemory;
const layerTestStores = Layer.merge(EventStore.layer, ProjectionStore.layer).pipe(
  Layer.provide(layerTestDatabase),
);
const layerTestEventSink = EventSink.layer.pipe(
  Layer.provide(Layer.mergeAll(layerTestStores, layerTestDatabase)),
);

/** server.ts provides ProviderRegistry.layer beneath the orchestration runtime. */
const layerRuntime = (instances: ReadonlyArray<FakeInstance>, prefix: string) =>
  ProviderEventIngestor.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        layerTestStores,
        layerTestEventSink,
        IdAllocator.layer,
        ThreadCommandExecutor.layer,
        GitVcsDriver.layer,
      ),
    ),
    Layer.provideMerge(Layer.mergeAll(layerTestEventSink, IdAllocator.layer)),
    Layer.provideMerge(layerRegistry(instances)),
    Layer.provideMerge(layerServerConfig(prefix)),
  );

const ingestTerminal = Effect.fn("ingestTerminal")(function* (input: {
  readonly provider: ServerProvider;
  readonly failure: OrchestrationV2ProviderFailure | null;
  readonly stale?: boolean;
}) {
  const idAllocator = yield* IdAllocator.IdAllocatorV2;
  const eventSink = yield* EventSink.EventSinkV2;
  const ingestor = yield* ProviderEventIngestor.ProviderEventIngestorV2;
  const now = yield* DateTime.now;
  const projectId = yield* idAllocator.allocate.project({ fixtureName: "provider-readiness" });
  const threadId = yield* idAllocator.allocate.thread({
    fixtureName: "provider-readiness",
    projectId,
  });
  const modelSelection = {
    instanceId: input.provider.instanceId,
    model: "default",
  } satisfies ModelSelection;
  const providerThreadId = idAllocator.derive.providerThread({
    driver: input.provider.driver,
    nativeThreadId: `native-${threadId}`,
  });
  const thread: OrchestrationV2AppThread = {
    createdBy: "user",
    creationSource: "web",
    id: threadId,
    projectId,
    title: "Provider readiness",
    providerInstanceId: input.provider.instanceId,
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    branchPullRequest: null,
    activeOrderKey: null,
    activeProviderThreadId: providerThreadId,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
    forkedFrom: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
  };
  yield* eventSink.write({
    events: [
      {
        id: yield* idAllocator.allocate.event({ threadId }),
        type: "thread.created",
        threadId,
        occurredAt: now,
        payload: thread,
      },
    ],
  });
  const providerTurnId = ProviderTurnId.make(`provider-turn:${threadId}`);
  const common = {
    driver: input.provider.driver,
    providerThreadId,
    providerTurnId,
    runOrdinal: 1,
    threadDisposition: "reusable" as const,
  };
  return yield* ingestor.ingestNormalized({
    providerSessionId: yield* idAllocator.allocate.providerSession({
      providerInstanceId: input.provider.instanceId,
      threadId,
    }),
    providerInstanceId: input.provider.instanceId,
    threadId,
    event:
      input.failure === null
        ? { type: "turn.terminal", ...common, status: "completed", failure: null }
        : {
            type: "turn.terminal",
            ...common,
            status: "failed",
            failureItemOrdinal: 1,
            failure: input.failure,
          },
    ...(input.stale === true
      ? {
          writeIfRunCurrent: {
            runId: RunId.make("run:stale"),
            activeAttemptId: RunAttemptId.make("attempt:stale"),
            expectedStatus: "running" as const,
          },
        }
      : {}),
  });
});

const CLAUDE_USAGE_LIMIT: OrchestrationV2ProviderFailure = {
  class: "usage_limit",
  message: "Claude usage limit reached. Send the message again once the limit resets.",
  code: "api_error_429",
  retryable: true,
  resetAt: "2099-10-29T18:00:00.000Z",
};
const CLAUDE_FORBIDDEN: OrchestrationV2ProviderFailure = {
  class: "provider_error",
  message: "Failed to authenticate. API Error: 403 Your organization does not have access.",
  code: "api_error_403",
  retryable: null,
};

const CODEX_SIGNED_OUT: OrchestrationV2ProviderFailure = {
  class: "provider_error",
  message: "Provider stopped this request.",
  code: "unauthorized",
  retryable: null,
};

const readinessIn = (providers: ReadonlyArray<ServerProvider>, provider: ServerProvider) =>
  providers.find((candidate) => candidate.instanceId === provider.instanceId)?.readiness;

// Build the production RPC layer; unrelated capabilities fail if these tests call them.
const layerUnusedRpcServices = Layer.mergeAll(
  Layer.mock(DocumentText.DocumentText)({}),
  Layer.mock(ServerSecretStore.ServerSecretStore)({}),
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
  Layer.mock(ProjectStore.ProjectStoreV2)({}),
  Layer.mock(ProviderAuthService.ProviderAuthService)({}),
  Layer.mock(ProviderMaintenanceRunner.ProviderMaintenanceRunner)({}),
  Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({}),
  Layer.mock(PullRequestReviewGuideService.PullRequestReviewGuideService)({}),
  Layer.mock(PullRequestService.PullRequestService)({}),
  Layer.mock(PullRequestSyncReactor.PullRequestSyncReactor)({}),
  Layer.mock(RepositoryIdentityResolver.RepositoryIdentityResolver)({}),
  Layer.mock(ResourceTelemetry.ResourceTelemetry)({}),
  Layer.mock(ReviewService.ReviewService)({}),
  Layer.mock(HoustonReviewState.HoustonReviewState)({}),
  Layer.mock(HoustonTaskService.HoustonTaskService)({}),
  Layer.mock(HoustonTaskRuns.HoustonTaskRuns)({}),
  Layer.mock(HoustonTaskV1Import.HoustonTaskV1Import)({}),
  Layer.mock(HoustonTaskSourceService.HoustonTaskSourceService)({}),
  Layer.mock(HoustonSlackService.HoustonSlackService)({}),
  Layer.mock(HoustonTaskSourceV1Import.HoustonTaskSourceV1Import)({}),
  Layer.mock(ScheduledTasks.ScheduledTaskService)({}),
  Layer.mock(SecretRequests.SecretRequests)({}),
  Layer.mock(ServerLifecycleEvents.ServerLifecycleEvents)({}),
  Layer.mock(ServerRuntimeStartup.ServerRuntimeStartup)({}),
  Layer.mock(ServerSelfUpdate.ServerSelfUpdate)({}),
  Layer.mock(SessionStore.SessionStore)({
    cookieName: "readiness-test",
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
      environmentId: EnvironmentId.make("readiness-test"),
      label: "Readiness test",
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
        sessionCookieName: "readiness-test-session",
      }),
  }),
  Layer.mock(PreviewAutomationBroker.PreviewAutomationBroker)({}),
  Layer.mock(ServerBrowser.ServerBrowser)({}),
  Layer.mock(ModelManifest.ModelManifest)({}),
  Layer.mock(ProviderLatestVersions.ProviderLatestVersions)({}),
  // Scope checks have their own tests; these calls run as a fully scoped client.
  Layer.succeed(RpcScopeAuthorization)((effect) => effect),
);

const layerConfigSources = Layer.mergeAll(
  Keybindings.layer,
  ServerSettings.layer.pipe(Layer.provide(ServerSecretStore.layer)),
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
          sessionId: AuthSessionId.make("readiness-test"),
          subject: "readiness-test",
          method: "browser-session-cookie",
          scopes: [],
        },
        {},
        browser,
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

const getConfig = (client: Effect.Success<ReturnType<typeof makeWsClient>>, id: string) =>
  client.request(id, WS_METHODS.serverGetConfig, {}).pipe(
    Effect.andThen(Queue.take(client.responses)),
    Effect.map((value) => value as ServerConfigPayload),
  );

const refreshProviders = (
  client: Effect.Success<ReturnType<typeof makeWsClient>>,
  id: string,
  payload: object,
) =>
  client.request(id, WS_METHODS.serverRefreshProviders, payload).pipe(
    Effect.andThen(Queue.take(client.responses)),
    Effect.map(
      (value) => (value as { readonly providers: ReadonlyArray<ServerProvider> }).providers,
    ),
  );

const layerWs = (instances: ReadonlyArray<FakeInstance>, prefix: string) =>
  layerUnusedRpcServices.pipe(
    Layer.provideMerge(layerConfigSources),
    Layer.provideMerge(layerRuntime(instances, prefix)),
  );

const withWs = <A, E>(
  providers: ReadonlyArray<ServerProvider>,
  body: (
    instances: ReadonlyArray<FakeInstance>,
  ) => Effect.Effect<
    A,
    E,
    Layer.Success<ReturnType<typeof layerWs>> | import("effect/Scope").Scope
  >,
) =>
  Effect.gen(function* () {
    const instances = yield* Effect.forEach(providers, makeFakeInstance);
    return yield* body(instances).pipe(Effect.provide(layerWs(instances, "houston-readiness-ws-")));
  }).pipe(Effect.scoped);

describe("every published provider carries one readiness", () => {
  // Live clock: the 200 ms status debounce fires on its own.
  it.live("in server.getConfig and in the first providerStatuses event", () =>
    withWs([CLAUDE, CODEX, OPENCODE], (instances) =>
      Effect.gen(function* () {
        const client = yield* makeWsClient();
        const config = yield* getConfig(client, "get-config");
        assert.equal(config.providers.length, 3);
        for (const provider of config.providers) {
          assert.equal(decodeReadiness(provider.readiness).state, "ready");
        }

        yield* client.request("config", WS_METHODS.subscribeServerConfig, {});
        const snapshot = (yield* Queue.take(client.responses)) as ServerConfigStreamEvent;
        if (snapshot.type !== "snapshot") return yield* Effect.die("Missing initial snapshot");
        assert.deepEqual(
          snapshot.config.providers.map((provider) => provider.readiness?.state),
          ["ready", "ready", "ready"],
        );
        yield* client.ack("config");

        yield* instances[1]!.set({ ...CODEX, enabled: false });
        const event = (yield* Queue.take(client.responses)) as ServerConfigStreamEvent;
        if (event.type !== "providerStatuses")
          return yield* Effect.die("Expected providerStatuses");
        assert.equal(event.payload.providers.length, 3);
        const states = event.payload.providers.map((provider) => [
          provider.instanceId,
          decodeReadiness(provider.readiness).state,
        ]);
        assert.deepInclude(states, ["codex", "turnedOff"]);
        assert.deepInclude(states, ["claudeAgent", "ready"]);
        assert.deepInclude(states, ["opencode", "ready"]);
        yield* client.interrupt("config");
      }),
    ),
  );
});

describe("refresh clears turn-derived states except a named reset", () => {
  const T = DateTime.makeUnsafe("1970-01-01T00:00:00.000Z");
  const cases = [
    {
      name: "signedOut from a turn",
      failure: {
        class: "provider_error",
        message: "Claude is signed out.",
        code: "api_error_401",
        retryable: null,
      },
      cleared: true,
    },
    { name: "rejected", failure: CLAUDE_FORBIDDEN, cleared: true },
    {
      name: "outOfUsage without a reset",
      failure: { ...CLAUDE_USAGE_LIMIT, resetAt: null },
      cleared: true,
    },
    { name: "outOfUsage with a future reset", failure: CLAUDE_USAGE_LIMIT, cleared: false },
  ] as const;

  it.effect.each(cases)("$name", ({ failure, cleared }) =>
    withWs([CLAUDE, CODEX], () =>
      Effect.gen(function* () {
        const ledger = yield* ReadinessLedger;
        const client = yield* makeWsClient();
        for (const provider of [CLAUDE, CODEX]) {
          yield* ledger.report({
            instanceId: provider.instanceId,
            driver: provider.driver,
            status: "failed",
            failure: provider === CODEX ? CODEX_SIGNED_OUT : failure,
            occurredAt: T,
          });
        }
        const before = yield* getConfig(client, "before");
        assert.notEqual(readinessIn(before.providers, CLAUDE)?.state, "ready");

        const refreshed = yield* refreshProviders(client, "refresh", {
          instanceId: CLAUDE.instanceId,
        });
        const readiness = readinessIn(refreshed, CLAUDE);
        if (cleared) {
          assert.deepEqual(readiness, { state: "ready" });
        } else {
          assert.deepInclude(readiness, {
            state: "outOfUsage",
            resetsAt: "2099-10-29T18:00:00.000Z",
          });
        }
        // Only the refreshed instance is cleared.
        assert.equal(readinessIn(refreshed, CODEX)?.state, "signedOut");
        const after = yield* getConfig(client, "after");
        assert.deepEqual(readinessIn(after.providers, CLAUDE), readiness);
      }),
    ),
  );

  it.effect("a refresh of every provider clears every instance", () =>
    withWs([CLAUDE, CODEX], () =>
      Effect.gen(function* () {
        const ledger = yield* ReadinessLedger;
        const client = yield* makeWsClient();
        for (const provider of [CLAUDE, CODEX]) {
          yield* ledger.report({
            instanceId: provider.instanceId,
            driver: provider.driver,
            status: "failed",
            failure: CLAUDE_FORBIDDEN,
            occurredAt: T,
          });
        }
        const refreshed = yield* refreshProviders(client, "refresh-all", {});
        assert.deepEqual(readinessIn(refreshed, CLAUDE), { state: "ready" });
        assert.deepEqual(readinessIn(refreshed, CODEX), { state: "ready" });
      }),
    ),
  );
  it.effect("refreshing one driver clears only that driver's default instance", () =>
    withWs([CLAUDE, CODEX], () =>
      Effect.gen(function* () {
        const ledger = yield* ReadinessLedger;
        const registry = yield* ProviderRegistry.ProviderRegistry;
        for (const provider of [CLAUDE, CODEX]) {
          yield* ledger.report({
            instanceId: provider.instanceId,
            driver: provider.driver,
            status: "failed",
            failure: provider === CODEX ? CODEX_SIGNED_OUT : CLAUDE_FORBIDDEN,
            occurredAt: T,
          });
        }
        const refreshed = yield* registry.refresh(CLAUDE.driver);
        assert.deepEqual(readinessIn(refreshed, CLAUDE), { state: "ready" });
        assert.equal(readinessIn(refreshed, CODEX)?.state, "signedOut");
      }),
    ),
  );
});

describe("an unstored failure leaves readiness unchanged", () => {
  it.effect("a stale run's failure is not stored and changes nothing; a stored one does", () =>
    withWs([CLAUDE], () =>
      Effect.gen(function* () {
        const registry = yield* ProviderRegistry.ProviderRegistry;
        const stale = yield* ingestTerminal({
          provider: CLAUDE,
          failure: CLAUDE_FORBIDDEN,
          stale: true,
        });
        assert.isEmpty(stale);
        assert.deepEqual(readinessIn(yield* registry.getProviders, CLAUDE), { state: "ready" });

        const stored = yield* ingestTerminal({ provider: CLAUDE, failure: CLAUDE_FORBIDDEN });
        assert.isNotEmpty(stored);
        assert.deepInclude(readinessIn(yield* registry.getProviders, CLAUDE), {
          state: "rejected",
          code: "api_error_403",
        });
      }),
    ),
  );
});

describe("a stale completion leaves readiness unchanged", () => {
  it.effect("a stale run's completion keeps a rejection; a current one clears it", () =>
    withWs([CLAUDE], () =>
      Effect.gen(function* () {
        const registry = yield* ProviderRegistry.ProviderRegistry;
        yield* ingestTerminal({ provider: CLAUDE, failure: CLAUDE_FORBIDDEN });
        assert.deepInclude(readinessIn(yield* registry.getProviders, CLAUDE), {
          state: "rejected",
          code: "api_error_403",
        });

        const stale = yield* ingestTerminal({ provider: CLAUDE, failure: null, stale: true });
        assert.isEmpty(stale);
        assert.deepInclude(readinessIn(yield* registry.getProviders, CLAUDE), {
          state: "rejected",
          code: "api_error_403",
        });

        yield* ingestTerminal({ provider: CLAUDE, failure: null });
        assert.deepEqual(readinessIn(yield* registry.getProviders, CLAUDE), { state: "ready" });
      }),
    ),
  );
});

describe("an ingested usage limit reaches the config stream", () => {
  // Live clock: the 200 ms status debounce fires on its own.
  it.live("a subscribed client receives outOfUsage with the failure's reset", () =>
    withWs([CLAUDE, CODEX], () =>
      Effect.gen(function* () {
        const client = yield* makeWsClient();
        yield* client.request("config", WS_METHODS.subscribeServerConfig, {});
        const snapshot = (yield* Queue.take(client.responses)) as ServerConfigStreamEvent;
        if (snapshot.type !== "snapshot") return yield* Effect.die("Missing initial snapshot");
        yield* client.ack("config");

        yield* ingestTerminal({ provider: CLAUDE, failure: CLAUDE_USAGE_LIMIT });
        const event = (yield* Queue.take(client.responses)) as ServerConfigStreamEvent;
        if (event.type !== "providerStatuses")
          return yield* Effect.die("Expected providerStatuses");
        assert.deepInclude(readinessIn(event.payload.providers, CLAUDE), {
          state: "outOfUsage",
          resetsAt: "2099-10-29T18:00:00.000Z",
          message: CLAUDE_USAGE_LIMIT.message,
        });
        assert.deepEqual(readinessIn(event.payload.providers, CODEX), { state: "ready" });
        yield* client.interrupt("config");
      }),
    ),
  );
});

describe("the status cache stores no readiness", () => {
  it.effect("the cache file has no readiness and a rebooted registry derives it afresh", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const config = yield* ServerConfig.ServerConfig;
      const cacheFile = path.join(config.providerStatusCacheDir, `${CLAUDE.instanceId}.json`);
      const updated = { ...CLAUDE, version: "1.0.1" };

      const first = yield* makeFakeInstance(CLAUDE);
      yield* Effect.gen(function* () {
        const registry = yield* ProviderRegistry.ProviderRegistry;
        const ledger = yield* ReadinessLedger;
        yield* ledger.report({
          instanceId: CLAUDE.instanceId,
          driver: CLAUDE.driver,
          status: "failed",
          failure: CLAUDE_FORBIDDEN,
          occurredAt: yield* DateTime.now,
        });
        assert.equal(readinessIn(yield* registry.getProviders, CLAUDE)?.state, "rejected");
        // A probe result that arrives while the rejection is live is persisted.
        const published = yield* Queue.unbounded<ReadonlyArray<ServerProvider>>();
        yield* Stream.runForEach(registry.streamChanges, (providers) =>
          Queue.offer(published, providers),
        ).pipe(Effect.forkIn(yield* Effect.scope, { startImmediately: true }));
        yield* first.set(updated);
        let latest = yield* Queue.take(published);
        while (!latest.some((provider) => provider.version === "1.0.1")) {
          latest = yield* Queue.take(published);
        }
        assert.equal(readinessIn(latest, CLAUDE)?.state, "rejected");
      }).pipe(Effect.provide(Layer.fresh(layerRegistry([first]))), Effect.scoped);

      const cached = JSON.parse(yield* fileSystem.readFileString(cacheFile)) as Record<
        string,
        unknown
      >;
      assert.equal(cached.instanceId, CLAUDE.instanceId);
      assert.equal(cached.version, "1.0.1");
      assert.notInclude(JSON.stringify(cached), "readiness");

      // A rebooted registry has no ledger entry: readiness comes from the snapshot alone.
      const second = yield* makeFakeInstance(updated);
      const rebooted = yield* Effect.gen(function* () {
        const registry = yield* ProviderRegistry.ProviderRegistry;
        return readinessIn(yield* registry.getProviders, CLAUDE);
      }).pipe(Effect.provide(Layer.fresh(layerRegistry([second]))), Effect.scoped);
      assert.deepEqual(rebooted, { state: "ready" });
    }).pipe(Effect.provide(layerServerConfig("houston-readiness-cache-")), Effect.scoped),
  );
});

describe("the production layer shares one ledger", () => {
  it.effect("the ingestor reports into the ledger ProviderRegistry.layer reads", () =>
    withWs([CLAUDE], () =>
      Effect.gen(function* () {
        const registry = yield* ProviderRegistry.ProviderRegistry;
        const ledger = yield* ReadinessLedger;
        yield* ingestTerminal({ provider: CLAUDE, failure: CLAUDE_FORBIDDEN });
        const entries = yield* ledger.entries;
        assert.equal(entries.get(CLAUDE.instanceId)?.state, "rejected");
        assert.equal(readinessIn(yield* registry.getProviders, CLAUDE)?.state, "rejected");

        yield* ingestTerminal({ provider: CLAUDE, failure: null });
        assert.isFalse((yield* ledger.entries).has(CLAUDE.instanceId));
        assert.deepEqual(readinessIn(yield* registry.getProviders, CLAUDE), { state: "ready" });
      }),
    ),
  );
});
