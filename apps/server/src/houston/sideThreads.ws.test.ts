// Side threads as the renderer reads them: the real `/ws` shell stream and projection handlers
// over the orchestration runtime of sideThreads.testkit.ts, on one database across a restart.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  AuthSessionId,
  CommandId,
  EnvironmentId,
  MessageId,
  ORCHESTRATION_V2_WS_METHODS,
  RpcScopeAuthorization,
  ThreadId,
  WsRpcGroup,
} from "@t3tools/contracts";
import * as AcpRegistryRuntimeCoordinator from "@t3tools/provider-acp-registry/server/AcpRegistryRuntimeCoordinator";
import * as AcpRegistrySupport from "@t3tools/provider-acp-registry/server/AcpRegistrySupport";
import * as ProviderLatestVersions from "@t3tools/provider-core/server/ProviderLatestVersions";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
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

import * as HoustonReviewState from "./reviewState.ts";
import { makeHarness, runWith } from "./sideThreads.testkit.ts";
import * as HoustonTaskService from "./tasks/TaskService.ts";
import * as HoustonTaskRuns from "./tasks/TaskRuns.ts";
import * as HoustonTaskV1Import from "./tasks/V1Import.ts";
import * as HoustonTaskSourceService from "./taskSources/SourceService.ts";
import * as HoustonTaskSourceV1Import from "./taskSources/V1Import.ts";
import * as HoustonMergeQueueService from "./mergeQueue/Service.ts";
import * as HoustonHarnessService from "./harnessReview/Service.ts";
import * as HoustonNightShiftService from "./nightShift/Service.ts";

// Build the production RPC layer; unrelated capabilities fail if these tests call them.
const layerUnusedRpcServices = Layer.mergeAll(
  Layer.mock(DocumentText.DocumentText)({}),
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
  Layer.mock(HoustonTaskService.HoustonTaskService)({}),
  Layer.mock(HoustonTaskRuns.HoustonTaskRuns)({}),
  Layer.mock(HoustonTaskV1Import.HoustonTaskV1Import)({}),
  Layer.mock(HoustonTaskSourceService.HoustonTaskSourceService)({}),
  Layer.mock(HoustonTaskSourceV1Import.HoustonTaskSourceV1Import)({}),
  Layer.mock(HoustonMergeQueueService.HoustonMergeQueueService)({}),
  Layer.mock(HoustonHarnessService.HoustonHarnessService)({}),
  Layer.mock(HoustonNightShiftService.HoustonNightShiftService)({}),
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
  Layer.mock(ServerLifecycleEvents.ServerLifecycleEvents)({}),
  Layer.mock(ServerRuntimeStartup.ServerRuntimeStartup)({}),
  Layer.mock(ServerSelfUpdate.ServerSelfUpdate)({}),
  Layer.mock(SessionStore.SessionStore)({ cookieName: "side-test", legacyCookieName: undefined }),
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
      environmentId: EnvironmentId.make("side-test"),
      label: "Side thread test",
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
        sessionCookieName: "side-test-session",
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
  Layer.mock(ProjectStore.ProjectStoreV2)({ listShells: () => Effect.succeed([]) }),
  Layer.mock(ProjectService.ProjectService)({ getShell: () => Effect.succeedNone }),
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
          sessionId: AuthSessionId.make("side-test"),
          subject: "side-test",
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

/** Every thread record a value carries for `threadId`, at any depth. */
const threadRecords = (
  value: unknown,
  threadId: string,
): ReadonlyArray<Record<string, unknown>> => {
  const found: Array<Record<string, unknown>> = [];
  const seen = new Set<unknown>();
  const visit = (node: unknown) => {
    if (node === null || typeof node !== "object" || seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) {
      for (const entry of node) visit(entry);
      return;
    }
    const record = node as Record<string, unknown>;
    if (record.id === threadId && "lineage" in record) found.push(record);
    for (const entry of Object.values(record)) visit(entry);
  };
  visit(value);
  return found;
};

/** The reads `/ws` makes through ThreadManagement and the event store, served by the runtime. */
const withRuntimeReads = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const events = yield* OrchestrationEventStore.OrchestrationEventStore;
    const enrichment = yield* PubSub.unbounded();
    return yield* effect.pipe(
      Effect.provideService(ThreadManagement.ThreadManagementService, {
        ensureLegacyTranscript: () => Effect.void,
        getThreadShell: orchestrator.getThreadShell,
        listActiveShellIndex: orchestrator.listActiveShellIndex,
        getShellSnapshot: orchestrator.getShellSnapshot,
        readShellSnapshot: orchestrator.readShellSnapshot,
        listActiveSubagentThreadIds: orchestrator.listActiveSubagentThreadIds,
        getThreadSnapshot: orchestrator.getThreadSnapshot,
        getThreadSnapshotWindow: orchestrator.getThreadSnapshotWindow,
        getThreadEventSequence: orchestrator.getThreadEventSequence,
        streamStoredEventsFrom: orchestrator.streamStoredEventsFrom,
        getTurnItem: orchestrator.getTurnItem,
        getThreadRecords: orchestrator.getThreadRecords,
      } as unknown as ThreadManagement.ThreadManagementService["Service"]),
      Effect.provideService(OrchestrationEventStore.OrchestrationEventStore, events),
      Effect.provideService(ProjectEnrichment.ProjectEnrichmentService, {
        subscribeChanges: PubSub.subscribe(enrichment),
      } as unknown as ProjectEnrichment.ProjectEnrichmentService["Service"]),
    );
  });

const withWs = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.provide(
      layerUnusedRpcServices.pipe(
        Layer.provideMerge(layerConfigSources),
        Layer.provideMerge(
          ServerConfig.layerTest(process.cwd(), { prefix: "houston-side-ws-" }).pipe(
            Layer.provideMerge(NodeServices.layer),
          ),
        ),
      ),
    ),
    Effect.scoped,
  );

describe("side threads reach the renderer's reads", () => {
  it.effect("side threads reach the shell and survive a restart", () =>
    withWs(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dir = yield* fs.makeTempDirectoryScoped({ prefix: "houston-side-restart-" });
        const databasePath = path.join(dir, "state.sqlite");
        const side = {
          kind: "aside",
          sourceThreadId: "source",
        };

        const first = yield* makeHarness("ws-shell");
        let sourceRunId = "";
        yield* runWith(
          first,
          (context) =>
            withRuntimeReads(
              Effect.gen(function* () {
                const source = yield* context.createThread({ threadId: "source", driver: "codex" });
                yield* context.turn(source, "message:source:1", "first");
                sourceRunId = (yield* context.orchestrator.getThreadProjection(source)).runs[0]!.id;
                const before = yield* makeWsClient();
                yield* before.request("shell", ORCHESTRATION_V2_WS_METHODS.subscribeShell, {});
                assert.lengthOf(threadRecords(yield* Queue.take(before.responses), "aside"), 0);
                yield* before.interrupt("shell");
                yield* context.dispatch({
                  type: "houston.aside.start",
                  commandId: CommandId.make("aside"),
                  sourceThreadId: source,
                  asideThreadId: ThreadId.make("aside"),
                  messageId: MessageId.make("message:aside"),
                  text: "What changed?",
                  attachments: [],
                  createdBy: "user",
                  creationSource: "web",
                });
                yield* context.settle;
                // The live tail projects each changed thread with getThreadShell.
                const live = yield* context.orchestrator.getThreadShell(ThreadId.make("aside"));
                assert.deepEqual(live?.side, { ...side, sourceRunId } as never);
                // A subscriber's first frame carries the aside's shell, once.
                const client = yield* makeWsClient();
                yield* client.request("shell", ORCHESTRATION_V2_WS_METHODS.subscribeShell, {});
                const snapshot = yield* Queue.take(client.responses);
                const shells = threadRecords(snapshot, "aside");
                assert.lengthOf(shells, 1, JSON.stringify(snapshot).slice(0, 2_000));
                assert.deepEqual(shells[0]?.side, { ...side, sourceRunId });
                yield* client.interrupt("shell");
              }),
            ),
          { databasePath },
        );

        // A new runtime on the same database, as after a server restart.
        const second = yield* makeHarness("ws-shell-restart");
        yield* runWith(
          second,
          () =>
            withRuntimeReads(
              Effect.gen(function* () {
                const client = yield* makeWsClient();
                yield* client.request(
                  "projection",
                  ORCHESTRATION_V2_WS_METHODS.getThreadProjection,
                  {
                    threadId: "aside",
                  },
                );
                const projection = yield* Queue.take(client.responses);
                const threads = threadRecords(projection, "aside");
                assert.isAbove(threads.length, 0, JSON.stringify(projection).slice(0, 2_000));
                assert.deepEqual(threads[0]?.side, { ...side, sourceRunId });

                yield* client.request("shell", ORCHESTRATION_V2_WS_METHODS.subscribeShell, {});
                const snapshot = yield* Queue.take(client.responses);
                const shells = threadRecords(snapshot, "aside");
                assert.isAbove(shells.length, 0, JSON.stringify(snapshot).slice(0, 2_000));
                assert.deepEqual(shells[0]?.side, { ...side, sourceRunId });
                const sourceShell = threadRecords(snapshot, "source")[0];
                assert.isDefined(sourceShell);
                assert.isFalse("side" in sourceShell, "an ordinary thread carries no side");
                yield* client.interrupt("shell");
              }),
            ),
          { databasePath },
        );
      }),
    ),
  );
});
