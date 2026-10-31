// A delivery as the renderer reads it: through the real `/ws` handlers over the orchestration
// runtime and the provider double of messageDelivery.testkit.ts.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  AuthSessionId,
  EnvironmentId,
  RpcScopeAuthorization,
  WsRpcGroup,
} from "@t3tools/contracts";
import * as AcpRegistryRuntimeCoordinator from "@t3tools/provider-acp-registry/server/AcpRegistryRuntimeCoordinator";
import * as AcpRegistrySupport from "@t3tools/provider-acp-registry/server/AcpRegistrySupport";
import * as ProviderLatestVersions from "@t3tools/provider-core/server/ProviderLatestVersions";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
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
import { MessageId, ORCHESTRATION_V2_WS_METHODS } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";

import { latest, makeHarness, runWith } from "./messageDelivery.testkit.ts";
import * as HoustonReviewState from "./reviewState.ts";
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
  Layer.mock(HoustonTaskSourceV1Import.HoustonTaskSourceV1Import)({}),
  Layer.mock(HoustonMergeQueueService.HoustonMergeQueueService)({}),
  Layer.mock(HoustonHarnessService.HoustonHarnessService)({}),
  Layer.mock(HoustonNightShiftService.HoustonNightShiftService)({}),
  Layer.mock(ScheduledTasks.ScheduledTaskService)({}),
  Layer.mock(SecretRequests.SecretRequests)({}),
  Layer.mock(ServerLifecycleEvents.ServerLifecycleEvents)({}),
  Layer.mock(ServerRuntimeStartup.ServerRuntimeStartup)({}),
  Layer.mock(ServerSelfUpdate.ServerSelfUpdate)({}),
  Layer.mock(SessionStore.SessionStore)({
    cookieName: "delivery-test",
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
      environmentId: EnvironmentId.make("delivery-test"),
      label: "Delivery test",
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
        sessionCookieName: "delivery-test-session",
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
          sessionId: AuthSessionId.make("delivery-test"),
          subject: "delivery-test",
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

/** Every user_message item carried by a value, at any depth. */
const userMessageItems = (
  value: unknown,
  messageId: string,
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
    if (record.type === "user_message" && record.messageId === messageId) found.push(record);
    for (const entry of Object.values(record)) visit(entry);
  };
  visit(value);
  return found;
};

/** turn-item.updated events in a value that carry a user_message's delivery. */
const deliveryEvents = (value: unknown, messageId: string) => {
  const events: Array<unknown> = [];
  const seen = new Set<unknown>();
  const visit = (node: unknown) => {
    if (node === null || typeof node !== "object" || seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) {
      for (const entry of node) visit(entry);
      return;
    }
    const record = node as Record<string, unknown>;
    const payload = record.payload as Record<string, unknown> | undefined;
    if (
      record.type === "turn-item.updated" &&
      payload?.type === "user_message" &&
      payload.messageId === messageId &&
      payload.delivery !== undefined
    ) {
      events.push(payload.delivery);
      return;
    }
    for (const entry of Object.values(record)) visit(entry);
  };
  visit(value);
  return events as ReadonlyArray<{ readonly state: string; readonly evidence: string | null }>;
};

/** The thread reads `/ws` makes through ThreadManagement, served by the double's runtime. */
const threadReads = Effect.map(
  Orchestrator.OrchestratorV2,
  (orchestrator) =>
    ({
      ensureLegacyTranscript: () => Effect.void,
      getThreadShell: orchestrator.getThreadShell,
      getThreadSnapshot: orchestrator.getThreadSnapshot,
      getThreadSnapshotWindow: orchestrator.getThreadSnapshotWindow,
      readShellSnapshot: orchestrator.readShellSnapshot,
      getThreadEventSequence: orchestrator.getThreadEventSequence,
      streamStoredEventsFrom: orchestrator.streamStoredEventsFrom,
      getTurnItem: orchestrator.getTurnItem,
      getThreadRecords: orchestrator.getThreadRecords,
    }) as unknown as ThreadManagement.ThreadManagementService["Service"],
);

const withThreadReads = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.flatMap(threadReads, (reads) =>
    effect.pipe(Effect.provideService(ThreadManagement.ThreadManagementService, reads)),
  );

const withWs = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.provide(
      layerUnusedRpcServices.pipe(
        Layer.provideMerge(layerConfigSources),
        Layer.provideMerge(
          ServerConfig.layerTest(process.cwd(), { prefix: "houston-delivery-ws-" }).pipe(
            Layer.provideMerge(NodeServices.layer),
          ),
        ),
      ),
    ),
    Effect.scoped,
  );

describe("deliveries reach the renderer's thread reads", () => {
  it.effect("every delivery change reaches the thread subscription", () =>
    withWs(
      Effect.gen(function* () {
        const harness = yield* makeHarness("ws-subscription", { steerAdopts: true });
        yield* runWith(harness, ({ send, startFirst, settle, threadId, deliveries }) =>
          withThreadReads(
            Effect.gen(function* () {
              const runId = yield* startFirst;
              const client = yield* makeWsClient();
              yield* client.request("thread", ORCHESTRATION_V2_WS_METHODS.subscribeThread, {
                threadId,
              });
              const received: Array<unknown> = [];
              const drain = Effect.gen(function* () {
                for (;;) {
                  const next = yield* Queue.poll(client.responses);
                  if (Option.isNone(next)) return;
                  received.push(next.value);
                  yield* client.ack("thread");
                }
              });
              yield* Effect.yieldNow;
              yield* drain;
              const messageId = MessageId.make("message:ws-steer");
              yield* send(messageId, "steer over ws", { type: "steer_active", targetRunId: runId });
              yield* settle;
              for (let round = 0; round < 20; round += 1) {
                yield* Effect.yieldNow;
                yield* drain;
              }
              for (const value of received) {
                const failed = (value as { readonly failed?: Exit.Exit<unknown, unknown> }).failed;
                if (failed !== undefined && Exit.isFailure(failed))
                  assert.fail(Cause.pretty(failed.cause));
              }
              const states = received.flatMap((value) => deliveryEvents(value, messageId));
              assert.deepEqual(
                states.map((delivery) => delivery.state),
                ["accepted", "delivered", "adopted"],
                JSON.stringify(states),
              );
              assert.equal(latest(deliveries(messageId))?.state, "adopted");
              yield* client.interrupt("thread");
            }),
          ),
        );
      }),
    ),
  );

  it.effect("the delivery survives a restart", () =>
    withWs(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dir = yield* fs.makeTempDirectoryScoped({ prefix: "houston-delivery-restart-" });
        const databasePath = path.join(dir, "state.sqlite");
        const messageId = MessageId.make("message:restart-steer");
        const first = yield* makeHarness("ws-restart", { steerAdopts: true });
        yield* runWith(
          first,
          ({ send, startFirst, settle }) =>
            Effect.gen(function* () {
              const runId = yield* startFirst;
              yield* send(messageId, "steer before restart", {
                type: "steer_active",
                targetRunId: runId,
              });
              yield* settle;
            }),
          { databasePath },
        );
        // A new runtime on the same database, as after a server restart.
        const second = yield* makeHarness("ws-restart");
        yield* runWith(
          second,
          ({ threadId }) =>
            withThreadReads(
              Effect.gen(function* () {
                const client = yield* makeWsClient();
                yield* client.request(
                  "projection",
                  ORCHESTRATION_V2_WS_METHODS.getThreadProjection,
                  {
                    threadId,
                  },
                );
                const projection = yield* Queue.take(client.responses);
                const items = userMessageItems(projection, messageId);
                assert.isAbove(items.length, 0, JSON.stringify(projection).slice(0, 2_000));
                assert.deepInclude(items[0]?.delivery as object, {
                  intent: "steer",
                  state: "adopted",
                  evidence: "codex.userMessage",
                });
              }),
            ),
          { databasePath, createThread: false },
        );
      }),
    ),
  );
});
