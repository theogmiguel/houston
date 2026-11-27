// The houston.bots.* requests through the real `/ws` handlers and scope table over an in-memory
// database: the switch, the scopes, the change stream and what reaches no log.
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  type AuthEnvironmentScope,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthSessionId,
  AuthSettingsWriteScope,
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
  WS_METHODS,
  WsRpcGroup,
} from "@houston-app/contracts";
import type {
  HoustonBot,
  HoustonBotRevisionsResult,
  HoustonBotStreamEvent,
} from "@houston-app/contracts/houston/bots";
import * as AcpRegistryRuntimeCoordinator from "@houston-app/provider-acp-registry/server/AcpRegistryRuntimeCoordinator";
import * as AcpRegistrySupport from "@houston-app/provider-acp-registry/server/AcpRegistrySupport";
import * as ProviderLatestVersions from "@houston-app/provider-core/server/ProviderLatestVersions";
import * as SecretResolver from "@houston-app/secret-provider-core/server/SecretResolver";
import { makeLocalFileTracer } from "@houston-app/shared/observability";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { Headers, HttpServer, HttpServerRequest, HttpServerResponse } from "effect/http";
import * as NetAddress from "effect/net/NetAddress";
import { RpcMessage, RpcServer } from "effect/rpc";

import * as AgentSessionImporter from "../../project/AgentSessionImporter.ts";
import * as AgentSessionScanner from "../../project/AgentSessionScanner.ts";
import * as AntigravityInstallation from "../../provider/AntigravityInstallation.ts";
import * as InferenceDiscovery from "../inference/InferenceDiscovery.ts";
import * as InferenceImageChecks from "../inference/InferenceImageChecks.ts";
import * as InferenceServerRegistry from "../inference/InferenceServerRegistry.ts";
import * as InferenceRequests from "../inference/InferenceRequests.ts";
import * as InferenceStops from "../inference/InferenceStops.ts";
import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import * as CheckpointDiffQuery from "../../checkpointing/CheckpointDiffQuery.ts";
import * as CodexInstallation from "../../provider/CodexInstallation.ts";
import * as CommandOutputHub from "../../orchestration-v2/CommandOutputHub.ts";
import * as DatabaseStorage from "../../persistence/DatabaseStorage.ts";
import * as DeviceService from "../../device/DeviceService.ts";
import * as DirectEndpoints from "../../environment/DirectEndpoints.ts";
import * as DocumentText from "../../provider/DocumentText.ts";
import * as RpcAuthorization from "../../auth/RpcAuthorization.ts";
import * as EnvironmentAuth from "../../auth/EnvironmentAuth.ts";
import * as EnvironmentTheme from "../../environmentTheme.ts";
import * as ExternalLauncher from "../../process/externalLauncher.ts";
import * as GitWorkflowService from "../../git/GitWorkflowService.ts";
import * as HostResources from "../../resourceTelemetry/HostResources.ts";
import * as Keybindings from "../../keybindings.ts";
import * as ManagedPolicy from "../../policy/ManagedPolicy.ts";
import * as NpmRelease from "../../cloud/npmRelease.ts";
import * as ManagedProjectFolders from "../../project/ManagedProjectFolders.ts";
import * as McpAppRequests from "../../mcpApps/McpAppRequests.ts";
import * as ModelManifest from "../../provider/ModelManifest.ts";
import * as OtlpEndpointCheck from "../../observability/OtlpEndpointCheck.ts";
import * as PairingGrantStore from "../../auth/PairingGrantStore.ts";
import * as PeerLinkRequests from "../../peer/PeerLinkRequests.ts";
import * as PeerLinks from "../../peer/PeerLinks.ts";
import * as PortScanner from "../../preview/PortScanner.ts";
import * as PreviewAutomationBroker from "../../mcp/PreviewAutomationBroker.ts";
import * as PreviewManager from "../../preview/Manager.ts";
import * as ProcessDiagnostics from "../../diagnostics/ProcessDiagnostics.ts";
import * as ProcessResourceMonitor from "../../diagnostics/ProcessResourceMonitor.ts";
import * as ProjectCloneTracker from "../../project/ProjectCloneTracker.ts";
import * as ProjectFaviconResolver from "../../project/ProjectFaviconResolver.ts";
import * as ProjectService from "../../project/ProjectService.ts";
import * as ProjectSetupScriptRunner from "../../project/ProjectSetupScriptRunner.ts";
import * as ProviderAuthService from "../../provider/ProviderAuthService.ts";
import * as ProviderMaintenanceRunner from "../../provider/providerMaintenanceRunner.ts";
import * as ProviderRegistry from "../../provider/ProviderRegistry.ts";
import * as PullRequestReviewGuideService from "../../pullRequest/PullRequestReviewGuideService.ts";
import * as PullRequestService from "../../pullRequest/PullRequestService.ts";
import * as IssueService from "../../issue/IssueService.ts";
import * as IssueTrackerConnections from "../../issue/IssueTrackerConnections.ts";
import * as PullRequestSyncReactor from "../../orchestration-v2/PullRequestSyncReactor.ts";
import * as RemoteOpenTargets from "../../environment/RemoteOpenTargets.ts";
import * as RepositoryIdentityResolver from "../../project/RepositoryIdentityResolver.ts";
import * as ResourceTelemetry from "../../resourceTelemetry/ResourceTelemetry.ts";
import * as ReviewService from "../../review/ReviewService.ts";
import * as ScheduledTasks from "../../scheduledTasks/ScheduledTaskService.ts";
import * as ScratchThreadPromotion from "../../project/ScratchThreadPromotion.ts";
import * as SecretRequests from "../../secrets/SecretRequests.ts";
import * as ServerBrowser from "../../preview/ServerBrowser.ts";
import * as ServerConfig from "../../config.ts";
import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import * as OrchestrationEventStore from "../../persistence/OrchestrationEventStore.ts";
import * as Orchestrator from "../../orchestration-v2/Orchestrator.ts";
import * as ProjectEnrichment from "../../project/ProjectEnrichmentService.ts";
import * as ProviderSessionManager from "../../orchestration-v2/ProviderSessionManager.ts";
import * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import * as ServerLifecycleEvents from "../../serverLifecycleEvents.ts";
import * as ServerRuntimeStartup from "../../serverRuntimeStartup.ts";
import * as AssetSigner from "../../assets/AssetSigner.ts";
import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import * as ServerSelfUpdate from "../../cloud/selfUpdate.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as SessionStore from "../../auth/SessionStore.ts";
import * as SourceControlDiscovery from "../../sourceControl/SourceControlDiscovery.ts";
import * as SourceControlRepositoryService from "../../sourceControl/SourceControlRepositoryService.ts";
import * as SourceControlSignIn from "../../sourceControl/SourceControlSignIn.ts";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import * as StorageCleanup from "../../storageCleanup.ts";
import * as TerminalManager from "../../terminal/Manager.ts";
import * as ThreadLaunchService from "../../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadSearch from "../../orchestration-v2/ThreadSearch.ts";
import * as TraceDiagnostics from "../../diagnostics/TraceDiagnostics.ts";
import * as TriageService from "../../triage/TriageService.ts";
import * as UsageLimitSources from "../../usage/UsageLimitSources.ts";
import * as UsageService from "../../usage/UsageService.ts";
import * as VcsProvisioningService from "../../vcs/VcsProvisioningService.ts";
import * as VcsStatusBroadcaster from "../../vcs/VcsStatusBroadcaster.ts";
import * as WorkspaceEntries from "../../workspace/WorkspaceEntries.ts";
import * as WorkspaceFileSystem from "../../workspace/WorkspaceFileSystem.ts";
import * as WorkspacePaths from "../../workspace/WorkspacePaths.ts";
import * as WorktreeSetupTracker from "../../project/WorktreeSetupTracker.ts";
import { layerWsRpc, WS_RPC_SERVER_OPTIONS } from "../../ws.ts";

import * as HoustonResumeSessions from "../resumeSessions.ts";
import * as HoustonReviewState from "../reviewState.ts";
import * as HoustonTaskService from "../tasks/TaskService.ts";
import * as HoustonTaskRuns from "../tasks/TaskRuns.ts";
import * as HoustonTaskV1Import from "../tasks/V1Import.ts";
import * as HoustonLayoutWorkspaces from "../layoutWorkspaces.ts";
import * as HoustonSlackService from "../slack/Service.ts";
import * as HoustonSlackV1Import from "../slack/V1Import.ts";
import * as HoustonIssueV1Import from "../../issue/V1Import.ts";
import * as HoustonMergeQueueService from "../mergeQueue/Service.ts";
import * as McpSessionRegistry from "../../mcp/McpSessionRegistry.ts";
import { layerJsonWithoutEcho } from "../rpcSerialization.ts";
import {
  botInput,
  CLAUDE,
  CODEX,
  DELETED_PROJECT,
  editOf,
  LAPTOP,
  layerTestAccounts,
  layerTestProjects,
  OTHER_PROJECT,
  setSwitch,
  storedBots,
} from "./bots.testkit.ts";
import { layerBots } from "./layer.ts";
import { BOTS_OFF_MESSAGE, refuse } from "./rules.ts";
import { HoustonBotRuns } from "./Runs.ts";
import { HoustonBotStore } from "./Store.ts";

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
  Layer.mock(AntigravityInstallation.AntigravityInstallation)({ managedDirectory: "/unused" }),
  Layer.mock(BackgroundPolicy.BackgroundPolicy)({}),
  Layer.mock(InferenceDiscovery.InferenceDiscovery)({}),
  Layer.mock(InferenceImageChecks.InferenceImageChecks)({}),
  Layer.mock(InferenceServerRegistry.InferenceServerRegistry)({}),
  Layer.mock(InferenceRequests.InferenceRequestLog)({}),
  Layer.mock(InferenceStops.InferenceStops)({}),
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
  Layer.mock(HoustonLayoutWorkspaces.HoustonLayoutWorkspaceService)({}),
  Layer.mock(HoustonSlackService.HoustonSlackService)({}),
  Layer.mock(HoustonSlackV1Import.HoustonSlackV1Import)({}),
  Layer.mock(HoustonIssueV1Import.HoustonIssueV1Import)({}),
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
  Layer.mock(IssueService.IssueService)({}),
  Layer.mock(IssueTrackerConnections.IssueTrackerConnections)({}),
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
  Layer.mock(SessionStore.SessionStore)({
    cookieName: "houston-bots-test",
    legacyCookieName: undefined,
  }),
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
      environmentId: EnvironmentId.make("houston-bots-test"),
      label: "Houston bots test",
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
        sessionCookieName: "houston-bots-test-session",
      }),
  }),
  Layer.mock(PreviewAutomationBroker.PreviewAutomationBroker)({}),
  Layer.mock(ServerBrowser.ServerBrowser)({}),
  Layer.mock(ModelManifest.ModelManifest)({}),
  Layer.mock(ProviderLatestVersions.ProviderLatestVersions)({}),
  Layer.mock(ProviderRegistry.ProviderRegistry)({}),
  Layer.mock(ProjectService.ProjectService)({ getShell: () => Effect.succeedNone }),
);

const ALL_SCOPES: ReadonlyArray<AuthEnvironmentScope> = [
  AuthOrchestrationReadScope,
  AuthOrchestrationOperateScope,
  AuthSettingsWriteScope,
];

const sessionOf = (label: string, scopes: ReadonlyArray<AuthEnvironmentScope>) => ({
  sessionId: AuthSessionId.make(`session-${label}`),
  subject: "houston-bots-test",
  method: "browser-session-cookie" as const,
  scopes: [...scopes],
  client: { label, deviceType: "desktop" as const },
});

/** A `/ws` client of the real handlers, authorized by the real scope table. */
const makeWsClient = Effect.fn("makeWsClient")(function* (
  scopes: ReadonlyArray<AuthEnvironmentScope> = ALL_SCOPES,
  label = "Laptop",
) {
  const responses = yield* Queue.unbounded<unknown>();
  const browser = yield* ServerBrowser.ServerBrowser;
  let ack: (requestId: unknown) => Effect.Effect<void> = () => Effect.void;
  const server = yield* RpcServer.makeNoSerialization(WsRpcGroup, {
    ...WS_RPC_SERVER_OPTIONS,
    onFromServer: (response) =>
      response._tag === "Chunk"
        ? Effect.forEach(response.values, (value) => Queue.offer(responses, value), {
            discard: true,
          }).pipe(Effect.andThen(ack(response.requestId)))
        : response._tag === "Exit" && response.exit._tag === "Success"
          ? Queue.offer(responses, response.exit.value)
          : response._tag === "Exit"
            ? Queue.offer(responses, { failed: response.exit })
            : Effect.void,
  }).pipe(
    Effect.provide(
      Layer.merge(
        layerWsRpc(sessionOf(label, scopes), browser, () => Effect.void),
        RpcAuthorization.layer(scopes),
      ),
    ),
  );
  ack = (requestId) => server.write(0, { _tag: "Ack", requestId } as never);
  let next = 0;
  const send = (tag: string, payload: object) =>
    Effect.gen(function* () {
      next += 1;
      const id = String(next);
      yield* server.write(0, {
        _tag: "Request",
        id: RpcMessage.RequestId(id),
        tag,
        payload,
        headers: Headers.empty,
      } as never);
      return id;
    });
  const call = (tag: string, payload: object) =>
    send(tag, payload).pipe(Effect.andThen(Queue.take(responses)));
  const interrupt = (id: string) =>
    server.write(0, {
      _tag: "Interrupt",
      requestId: RpcMessage.RequestId(id),
      interruptors: [],
    } as never);
  return { call, send, interrupt, responses };
});

type Client = Effect.Success<ReturnType<typeof makeWsClient>>;

const failureOf = (value: unknown) => {
  const exit = (value as { readonly failed?: Exit.Exit<unknown, unknown> } | undefined)?.failed;
  if (exit === undefined || !Exit.isFailure(exit)) return null;
  return Cause.squash(exit.cause) as {
    readonly _tag?: string;
    readonly kind?: string;
    readonly field?: string;
    readonly actual?: number;
    readonly message?: string;
  };
};

const saveBot = (client: Client, payload: object = botInput()) =>
  Effect.map(client.call(WS_METHODS.houstonBotsSave, payload), (reply) => {
    assert.isNull(failureOf(reply), JSON.stringify(failureOf(reply)));
    return reply as HoustonBot;
  });

// The socket's side of bot runs: the switch and the scopes. Runs.test.ts follows real threads.
const layerSocketRuns = Layer.effect(
  HoustonBotRuns,
  Effect.gen(function* () {
    const store = yield* HoustonBotStore;
    return HoustonBotRuns.of({
      ask: (input) =>
        Effect.as(store.requireOn("houston.bots.ask"), {
          botRunId: `run-${input.requestId}`,
          threadId: `bot-run-${input.requestId}`,
        }),
      stop: (input) =>
        Effect.andThen(
          store.requireOn("houston.bots.stop"),
          Effect.fail(refuse("not_found", "houston.bots.stop", `no bot run ${input.botRunId}`)),
        ),
      list: () =>
        Effect.as(store.requireOn("houston.bots.runs.list"), { runs: [], hasMore: false }),
      catchUp: Effect.void,
    });
  }),
);

const layerServer = (file?: string) =>
  layerSocketRuns.pipe(
    Layer.provideMerge(layerBots),
    Layer.provideMerge(
      Layer.mergeAll(layerUnusedRpcServices, layerTestProjects, layerTestAccounts),
    ),
    Layer.provideMerge(
      Layer.mergeAll(
        Keybindings.layer,
        ServerSettings.layer.pipe(
          Layer.provide(Layer.merge(ServerSecretStore.layer, ManagedPolicy.layerTest())),
        ),
      ).pipe(
        Layer.provideMerge(
          Layer.fresh(
            file === undefined
              ? SqlitePersistence.layerMemory
              : SqlitePersistence.layerFromPath(file),
          ),
        ),
      ),
    ),
    Layer.provideMerge(
      ServerConfig.layerTest(process.cwd(), { prefix: "houston-bots-ws-" }).pipe(
        Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
      ),
    ),
  );

type ServerServices = Layer.Success<ReturnType<typeof layerServer>>;

const withServer = <A, E>(
  body: Effect.Effect<A, E, ServerServices | import("effect/Scope").Scope>,
  options: { readonly file?: string; readonly on?: boolean } = {},
) =>
  Effect.gen(function* () {
    if (options.on !== false) yield* setSwitch(true);
    return yield* body;
  }).pipe(Effect.scoped, Effect.provide(layerServer(options.file)), Effect.scoped);

describe("bots over /ws", () => {
  it.effect("create, edit, restore, switch and delete, each naming its client", () =>
    withServer(
      Effect.gen(function* () {
        const laptop = yield* makeWsClient(ALL_SCOPES, "Laptop");
        const phone = yield* makeWsClient(ALL_SCOPES, "Phone");
        const bot = yield* saveBot(laptop);
        assert.deepInclude(bot, { slug: "digest-writer", enabled: false, rowRevision: 1 });
        assert.equal(bot.instructions.acceptedByLabel, "Laptop");

        const edited = yield* saveBot(
          phone,
          editOf(bot, { instructions: "Changed", unattendedFullAccess: true }),
        );
        assert.deepInclude(edited.instructions, { n: 2, acceptedByLabel: "Phone" });
        assert.deepEqual(
          edited.recentChanges.map((change) => [change.field, change.byLabel]),
          [["full_access", "Phone"]],
        );

        const stale = failureOf(
          yield* laptop.call(WS_METHODS.houstonBotsSave, editOf(bot, { job: "late" })),
        );
        assert.deepInclude(stale, { _tag: "HoustonBotError", kind: "conflict", actual: 2 });

        const restored = (yield* phone.call(WS_METHODS.houstonBotsRestoreRevision, {
          botId: bot.id,
          n: 1,
          expectedRevision: 2,
        })) as HoustonBot;
        assert.deepInclude(restored.instructions, { n: 3, restoredFrom: 1 });
        const read = (yield* laptop.call(WS_METHODS.houstonBotsRevisions, {
          botId: bot.id,
        })) as HoustonBotRevisionsResult;
        assert.deepEqual(
          read.revisions.map((revision) => [revision.n, revision.text]),
          [
            [3, botInput().instructions],
            [2, "Changed"],
            [1, botInput().instructions],
          ],
        );

        const on = (yield* laptop.call(WS_METHODS.houstonBotsSetEnabled, {
          botId: bot.id,
          enabled: true,
        })) as HoustonBot;
        assert.isTrue(on.enabled);
        assert.deepEqual(yield* laptop.call(WS_METHODS.houstonBotsDelete, { botId: bot.id }), {
          deleted: true,
        });
        const gone = failureOf(
          yield* laptop.call(WS_METHODS.houstonBotsRevisions, { botId: bot.id }),
        );
        assert.equal(gone?.kind, "not_found");
      }),
    ),
  );

  it.effect("an unknown project, another provider and an unknown account are refused by name", () =>
    withServer(
      Effect.gen(function* () {
        const client = yield* makeWsClient();
        for (const [overrides, kind, field, named] of [
          [
            { defaultProjectId: "project-missing" },
            "not_found",
            "defaultProjectId",
            "project-missing",
          ],
          [{ defaultProjectId: DELETED_PROJECT }, "not_found", "defaultProjectId", DELETED_PROJECT],
          [{ otherProjectIds: [OTHER_PROJECT, "nope"] }, "not_found", "otherProjectIds", "nope"],
          [
            { modelSelection: { instanceId: CODEX, model: "gpt" } },
            "unsupported",
            "modelSelection",
            "codex",
          ],
          [
            { modelSelection: { instanceId: ProviderInstanceId.make("gone"), model: "x" } },
            "not_found",
            "modelSelection",
            "gone",
          ],
          [{ name: "n".repeat(61) }, "limit", "name", "61"],
        ] as const) {
          const reply = yield* client.call(WS_METHODS.houstonBotsSave, {
            ...botInput(),
            ...overrides,
          });
          const refusal = failureOf(reply);
          assert.deepInclude(refusal, { _tag: "HoustonBotError", kind, field });
          assert.include(refusal?.message, "houston.bots.save");
          assert.include(refusal?.message, named);
        }
        assert.deepEqual((yield* storedBots).bots, []);
        const bot = yield* saveBot(client);
        const moved = editOf(bot, { modelSelection: { instanceId: CODEX, model: "gpt" } });
        assert.equal(
          failureOf(yield* client.call(WS_METHODS.houstonBotsSave, moved))?.kind,
          "unsupported",
        );
        assert.equal((yield* storedBots).bots[0]?.["row_revision"], 1);
        assert.include(String((yield* storedBots).bots[0]?.["model_selection_json"]), CLAUDE);
      }),
    ),
  );

  it.effect("the account is checked only when a bot is made or its account changes", () =>
    withServer(
      Effect.gen(function* () {
        const store = yield* HoustonBotStore;
        const client = yield* makeWsClient();
        // An account that Houston cannot reach now, such as one whose secrets are locked.
        const away = ProviderInstanceId.make("away");
        const bot = yield* store.save(
          botInput({ modelSelection: { instanceId: away, model: "opus" } }),
          LAPTOP,
        );
        const edited = yield* saveBot(client, editOf(bot, { job: "Writes the evening digest" }));
        assert.equal(edited.job, "Writes the evening digest");
        assert.equal(edited.modelSelection.instanceId, away);
        for (const [instanceId, kind] of [
          [ProviderInstanceId.make("gone"), "not_found"],
          [CODEX, "unsupported"],
        ] as const) {
          const moved = editOf(edited, { modelSelection: { instanceId, model: "x" } });
          const refusal = failureOf(yield* client.call(WS_METHODS.houstonBotsSave, moved));
          assert.deepInclude(refusal, { kind, field: "modelSelection" });
          assert.include(refusal?.message, instanceId);
        }
        assert.equal((yield* storedBots).bots[0]?.["row_revision"], 2);
      }),
    ),
  );

  it.effect("subscribe sends the snapshot, then each change, then the switch", () =>
    withServer(
      Effect.gen(function* () {
        const store = yield* HoustonBotStore;
        const client = yield* makeWsClient();
        const listener = yield* makeWsClient();
        const subscription = yield* listener.send(WS_METHODS.houstonBotsSubscribe, {});
        const take = Effect.map(
          Queue.take(listener.responses),
          (event) => event as HoustonBotStreamEvent,
        );
        assert.deepEqual(yield* take, { snapshot: { bots: [] } });
        const bot = yield* saveBot(client);
        assert.deepEqual(yield* take, { upserted: bot });
        const edited = yield* saveBot(client, editOf(bot, { job: "Another" }));
        assert.deepEqual(yield* take, { upserted: edited });
        const on = yield* client.call(WS_METHODS.houstonBotsSetEnabled, {
          botId: bot.id,
          enabled: true,
        });
        assert.deepEqual(yield* take, { upserted: on as HoustonBot });
        yield* setSwitch(false);
        assert.deepEqual(yield* take, { off: true, stopping: 0 });
        // A change made while it is off, as switching a bot off is, is not sent.
        const off = yield* store.setEnabled({ botId: bot.id, enabled: false });
        for (let turn = 0; turn < 50; turn += 1) yield* Effect.yieldNow;
        assert.equal(yield* Queue.size(listener.responses), 0);
        yield* setSwitch(true);
        assert.deepEqual(yield* take, { snapshot: { bots: [off] } });
        yield* client.call(WS_METHODS.houstonBotsDelete, { botId: bot.id });
        assert.deepEqual(yield* take, { deleted: { botId: bot.id } });
        yield* listener.interrupt(subscription);
      }),
    ),
  );

  it.effect("bots survive a restart of the server", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "houston-bots-restart-" });
      const file = path.join(dir, "state.sqlite");
      const bot = yield* withServer(Effect.flatMap(makeWsClient(), saveBot), { file });
      yield* withServer(
        Effect.gen(function* () {
          const listener = yield* makeWsClient();
          yield* listener.send(WS_METHODS.houstonBotsSubscribe, {});
          assert.deepEqual(yield* Queue.take(listener.responses), { snapshot: { bots: [bot] } });
        }),
        { file },
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});

describe("with Labs ▸ Bots off", () => {
  const requestsFor = (botId: string) =>
    [
      [WS_METHODS.houstonBotsSave, botInput()],
      [WS_METHODS.houstonBotsRevisions, { botId }],
      [WS_METHODS.houstonBotsRestoreRevision, { botId, n: 1, expectedRevision: 1 }],
      [WS_METHODS.houstonBotsSetEnabled, { botId, enabled: true }],
      [WS_METHODS.houstonBotsSetEnabled, { botId, enabled: false }],
      [WS_METHODS.houstonBotsDelete, { botId }],
      [WS_METHODS.houstonBotsAsk, { requestId: "click-1", botId, ownerText: "Go" }],
      [WS_METHODS.houstonBotsStop, { botRunId: "run-1" }],
      [WS_METHODS.houstonBotsRunsList, { botId }],
    ] as const;

  it.effect("it is off by default, every request names the switch and nothing is stored", () =>
    withServer(
      Effect.gen(function* () {
        const client = yield* makeWsClient();
        for (const [method, payload] of requestsFor("bot-1")) {
          const refusal = failureOf(yield* client.call(method, payload));
          assert.deepInclude(refusal, { kind: "off", message: BOTS_OFF_MESSAGE }, method);
        }
        yield* client.send(WS_METHODS.houstonBotsSubscribe, {});
        assert.deepEqual(yield* Queue.take(client.responses), { off: true, stopping: 0 });
        assert.deepEqual(yield* storedBots, { bots: [], revisions: [], changes: [] });
      }),
      { on: false },
    ),
  );

  it.effect("turning it off refuses every request and keeps the stored bot", () =>
    withServer(
      Effect.gen(function* () {
        const client = yield* makeWsClient();
        const bot = yield* saveBot(client);
        yield* client.call(WS_METHODS.houstonBotsSetEnabled, { botId: bot.id, enabled: true });
        yield* setSwitch(false);
        const before = yield* storedBots;
        for (const [method, payload] of requestsFor(bot.id)) {
          const refusal = failureOf(yield* client.call(method, payload));
          assert.deepInclude(refusal, { kind: "off", message: BOTS_OFF_MESSAGE }, method);
        }
        assert.deepEqual(yield* storedBots, before);
      }),
    ),
  );
});

describe("who may call the bots requests", () => {
  it.effect("each method requires its declared scope", () =>
    withServer(
      Effect.gen(function* () {
        const bot = yield* Effect.flatMap(makeWsClient(), saveBot);
        const botId = bot.id;
        const methods: ReadonlyArray<readonly [string, AuthEnvironmentScope, object]> = [
          [WS_METHODS.houstonBotsSubscribe, AuthOrchestrationReadScope, {}],
          [WS_METHODS.houstonBotsRevisions, AuthOrchestrationReadScope, { botId }],
          [WS_METHODS.houstonBotsSave, AuthSettingsWriteScope, botInput()],
          [
            WS_METHODS.houstonBotsRestoreRevision,
            AuthSettingsWriteScope,
            { botId, n: 1, expectedRevision: 1 },
          ],
          [WS_METHODS.houstonBotsSetEnabled, AuthSettingsWriteScope, { botId, enabled: true }],
          [WS_METHODS.houstonBotsDelete, AuthSettingsWriteScope, { botId }],
          [
            WS_METHODS.houstonBotsAsk,
            AuthOrchestrationOperateScope,
            { requestId: "click-1", botId, ownerText: "Go" },
          ],
          [WS_METHODS.houstonBotsStop, AuthOrchestrationOperateScope, { botRunId: "run-1" }],
          [WS_METHODS.houstonBotsRunsList, AuthOrchestrationReadScope, { botId }],
        ];
        for (const [method, scope, payload] of methods) {
          const before = yield* storedBots;
          const without = yield* makeWsClient(ALL_SCOPES.filter((entry) => entry !== scope));
          const denied = failureOf(yield* without.call(method, payload));
          assert.equal(denied?._tag, "EnvironmentAuthorizationError", method);
          assert.deepEqual(yield* storedBots, before, `${method} changed state`);
          const only = yield* makeWsClient([scope]);
          const id = yield* only.send(method, payload);
          const allowed = failureOf(yield* Queue.take(only.responses));
          assert.notEqual(allowed?._tag, "EnvironmentAuthorizationError", method);
          if (method === WS_METHODS.houstonBotsSubscribe) yield* only.interrupt(id);
        }
      }),
    ),
  );

  it.effect("a thread's own token cannot open the socket", () =>
    Effect.gen(function* () {
      const registry = yield* McpSessionRegistry.__testing.make({ now: () => 1_000 }).pipe(
        Effect.provideService(
          HttpServer.HttpServer,
          HttpServer.HttpServer.of({
            address: NetAddress.inetAddressFromIpStringUnsafe("127.0.0.1", 43_123),
            serve: (() => Effect.void) as HttpServer.HttpServer["Service"]["serve"],
          }),
        ),
        Effect.provideService(
          ServerEnvironment.ServerEnvironment,
          ServerEnvironment.ServerEnvironment.of({
            getEnvironmentId: Effect.succeed(EnvironmentId.make("houston-bots-test")),
            getDescriptor: Effect.die("unused"),
          }),
        ),
      );
      const issued = yield* registry.issue({
        threadId: ThreadId.make("thread-agent"),
        providerInstanceId: CLAUDE,
        capabilities: new Set(["orchestration"]),
      });
      const token = issued.config.authorizationHeader.replace(/^Bearer\s+/, "");
      assert.isDefined(yield* registry.resolve(token));

      const auth = yield* EnvironmentAuth.EnvironmentAuth;
      const cookie = (yield* auth.getDescriptor()).sessionCookieName;
      const upgrade = (request: object) =>
        Effect.flip(
          auth.authenticateWebSocketUpgrade(
            { method: "GET", url: "/ws", cookies: {}, headers: {}, ...request } as never,
            "rpc",
          ),
        );
      for (const request of [
        { headers: { authorization: issued.config.authorizationHeader } },
        { url: `/ws?wsTicket=${encodeURIComponent(token)}` },
        { cookies: { [cookie]: token } },
      ]) {
        const refusal = yield* upgrade(request);
        assert.include(refusal._tag, "Credential", JSON.stringify(Object.keys(request)));
      }
    }).pipe(
      Effect.provide(
        EnvironmentAuth.layer.pipe(
          Layer.provide(ManagedPolicy.layerTest()),
          Layer.provideMerge(SqlitePersistence.layerMemory),
          Layer.provide(ServerSecretStore.layer),
          Layer.provide(ServerEnvironment.layerIdentity),
          Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "houston-bots-auth-" })),
          Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
        ),
      ),
    ),
  );
});

/** Sends raw request bodies through the real RPC server and the `/ws` JSON serialization. */
const makeRawClient = Effect.fn("makeRawClient")(function* () {
  const browser = yield* ServerBrowser.ServerBrowser;
  const { protocol, httpEffect } = yield* RpcServer.makeProtocolWithHttpEffect();
  yield* RpcServer.make(WsRpcGroup, WS_RPC_SERVER_OPTIONS).pipe(
    Effect.provideService(RpcServer.Protocol, protocol),
    Effect.provide(
      Layer.merge(
        layerWsRpc(sessionOf("Raw", ALL_SCOPES), browser, () => Effect.void),
        RpcAuthorization.layer(ALL_SCOPES),
      ),
    ),
    Effect.forkScoped,
  );
  return (tag: string, payload: object) =>
    httpEffect.pipe(
      Effect.provideService(
        HttpServerRequest.HttpServerRequest,
        HttpServerRequest.fromWeb(
          new Request("http://127.0.0.1/rpc", {
            method: "POST",
            body: JSON.stringify({ _tag: "Request", id: "1", tag, payload, headers: [] }),
            headers: { "content-type": "application/json" },
          }),
        ),
      ),
      Effect.scoped,
      Effect.flatMap((response) => Effect.promise(() => HttpServerResponse.toWeb(response).text())),
    );
}, Effect.provide(layerJsonWithoutEcho));

describe("a bot's text reaches no log or trace", () => {
  it.effect("a bot's text reaches no log or trace", () => {
    const SECRET = "zebra-instructions-9c41e7";
    const JOB = "zebra-job-5f2c9d";
    const OWNER = "zebra-owner-text-3b7a01";
    const logs: Array<string> = [];
    const logger = Logger.make((options) => {
      logs.push(`${JSON.stringify(options.message)} ${Cause.pretty(options.cause)}`);
    });
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const traces = yield* withServer(
        Effect.gen(function* () {
          const config = yield* ServerConfig.ServerConfig;
          yield* Effect.scoped(
            Effect.gen(function* () {
              const tracer = yield* makeLocalFileTracer({
                filePath: config.serverTracePath,
                maxBytes: 4 * 1024 * 1024,
                maxFiles: 2,
                batchWindowMs: 10,
              });
              yield* Effect.gen(function* () {
                const client = yield* makeWsClient();
                const bot = yield* saveBot(client, botInput({ instructions: SECRET, job: JOB }));
                yield* saveBot(client, editOf(bot, { instructions: `${SECRET} two` }));
                yield* client.call(WS_METHODS.houstonBotsRevisions, { botId: bot.id });
                yield* client.call(WS_METHODS.houstonBotsRestoreRevision, {
                  botId: bot.id,
                  n: 1,
                  expectedRevision: 2,
                });
                // Each kind of refusal, with the text in the request.
                for (const overrides of [
                  { instructions: SECRET.repeat(1_000) },
                  { job: `${JOB}\n` },
                  { defaultProjectId: "project-missing" },
                  { target: { botId: bot.id, expectedRevision: 1 } },
                ]) {
                  const reply = yield* client.call(
                    WS_METHODS.houstonBotsSave,
                    botInput({ instructions: SECRET, job: JOB, ...(overrides as object) }),
                  );
                  assert.notInclude(String(failureOf(reply)?.message), SECRET);
                }
                const raw = yield* makeRawClient();
                const malformed = yield* raw(WS_METHODS.houstonBotsSave, {
                  ...botInput({ job: JOB }),
                  instructions: { SECRET, text: SECRET },
                });
                assert.isNotEmpty(malformed);
                assert.notInclude(malformed, SECRET);
                // What the owner types to a bot, well formed and not.
                yield* client.call(WS_METHODS.houstonBotsAsk, {
                  requestId: "click-1",
                  botId: bot.id,
                  ownerText: OWNER,
                });
                const malformedAsk = yield* raw(WS_METHODS.houstonBotsAsk, {
                  requestId: "click-2",
                  botId: bot.id,
                  ownerText: { OWNER, text: OWNER },
                });
                assert.isNotEmpty(malformedAsk);
                assert.notInclude(malformedAsk, OWNER);
                yield* Effect.logWarning("bots leak test done");
              }).pipe(Effect.withTracer(tracer));
            }),
          );
          return yield* fs.readFileString(config.serverTracePath);
        }),
      );
      assert.include(traces, "houston.bots.save");
      assert.include(traces, "houston.bots.ask");
      assert.include(logs.join("\n"), "bots leak test done");
      for (const text of [SECRET, JOB, OWNER]) {
        assert.notInclude(traces, text);
        assert.notInclude(logs.join("\n"), text);
      }
    }).pipe(
      Effect.provide(Logger.layer([logger])),
      Effect.scoped,
      Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
    );
  });
});
