// The houston.nightShift.* methods through the real `/ws` handlers and scope table.
import { assert, describe, it } from "@effect/vitest";
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthSessionId,
  AuthSettingsWriteScope,
  EnvironmentId,
  ThreadId,
  WS_METHODS,
  WsRpcGroup,
  type AuthEnvironmentScope,
} from "@t3tools/contracts";
import type { HoustonNightShiftOverviewEvent } from "@t3tools/contracts/houston/nightShift";
import * as AcpRegistryRuntimeCoordinator from "@t3tools/provider-acp-registry/server/AcpRegistryRuntimeCoordinator";
import * as AcpRegistrySupport from "@t3tools/provider-acp-registry/server/AcpRegistrySupport";
import * as ProviderLatestVersions from "@t3tools/provider-core/server/ProviderLatestVersions";
import * as SecretResolver from "@t3tools/secret-provider-core/server/SecretResolver";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import type * as Scope from "effect/Scope";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";
import { Headers } from "effect/http";
import { TestClock } from "effect/testing";
import { RpcMessage, RpcServer } from "effect/rpc";

import * as RpcAuthorization from "../../auth/RpcAuthorization.ts";
import * as AgentSessionImporter from "../../project/AgentSessionImporter.ts";
import * as AgentSessionScanner from "../../project/AgentSessionScanner.ts";
import * as AnalyticsService from "../../telemetry/AnalyticsService.ts";
import * as AntigravityInstallation from "../../provider/AntigravityInstallation.ts";
import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import * as CheckpointDiffQuery from "../../checkpointing/CheckpointDiffQuery.ts";
import * as CodexInstallation from "../../provider/CodexInstallation.ts";
import * as CommandOutputHub from "../../orchestration-v2/CommandOutputHub.ts";
import * as DatabaseStorage from "../../persistence/DatabaseStorage.ts";
import * as DeviceService from "../../device/DeviceService.ts";
import * as DirectEndpoints from "../../environment/DirectEndpoints.ts";
import * as DocumentText from "../../provider/DocumentText.ts";
import * as EnvironmentAuth from "../../auth/EnvironmentAuth.ts";
import * as EnvironmentTheme from "../../environmentTheme.ts";
import * as ExternalLauncher from "../../process/externalLauncher.ts";
import * as GitVcsDriver from "../../vcs/GitVcsDriver.ts";
import * as GitWorkflowService from "../../git/GitWorkflowService.ts";
import * as HostResources from "../../resourceTelemetry/HostResources.ts";
import * as Keybindings from "../../keybindings.ts";
import * as KnownWorkspaces from "../../workspace/KnownWorkspaces.ts";
import * as ManagedProjectFolders from "../../project/ManagedProjectFolders.ts";
import * as McpAppRequests from "../../mcpApps/McpAppRequests.ts";
import * as ModelManifest from "../../provider/ModelManifest.ts";
import * as NpmRelease from "../../cloud/npmRelease.ts";
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
import * as ProjectSetupScriptRunner from "../../project/ProjectSetupScriptRunner.ts";
import * as ProviderAuthService from "../../provider/ProviderAuthService.ts";
import * as ProviderMaintenanceRunner from "../../provider/providerMaintenanceRunner.ts";
import * as ProviderRegistry from "../../provider/ProviderRegistry.ts";
import * as PullRequestReviewGuideService from "../../pullRequest/PullRequestReviewGuideService.ts";
import * as PullRequestService from "../../pullRequest/PullRequestService.ts";
import * as PullRequestSyncReactor from "../../orchestration-v2/PullRequestSyncReactor.ts";
import * as RemoteOpenTargets from "../../environment/RemoteOpenTargets.ts";
import * as ResourceTelemetry from "../../resourceTelemetry/ResourceTelemetry.ts";
import * as ReviewService from "../../review/ReviewService.ts";
import * as ScratchThreadPromotion from "../../project/ScratchThreadPromotion.ts";
import * as SecretRequests from "../../secrets/SecretRequests.ts";
import * as ServerBrowser from "../../preview/ServerBrowser.ts";
import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import * as ServerLifecycleEvents from "../../serverLifecycleEvents.ts";
import * as ServerRuntimeStartup from "../../serverRuntimeStartup.ts";
import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import * as ServerSelfUpdate from "../../cloud/selfUpdate.ts";
import * as SessionStore from "../../auth/SessionStore.ts";
import * as SourceControlDiscovery from "../../sourceControl/SourceControlDiscovery.ts";
import * as SourceControlRepositoryService from "../../sourceControl/SourceControlRepositoryService.ts";
import * as SourceControlSignIn from "../../sourceControl/SourceControlSignIn.ts";
import * as StorageCleanup from "../../storageCleanup.ts";
import * as TerminalManager from "../../terminal/Manager.ts";
import * as ThreadLaunchService from "../../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import * as ThreadSearch from "../../orchestration-v2/ThreadSearch.ts";
import * as TraceDiagnostics from "../../diagnostics/TraceDiagnostics.ts";
import * as TriageService from "../../triage/TriageService.ts";
import * as UsageLimitSources from "../../usage/UsageLimitSources.ts";
import * as UsageService from "../../usage/UsageService.ts";
import * as VcsDriverRegistry from "../../vcs/VcsDriverRegistry.ts";
import * as VcsProvisioningService from "../../vcs/VcsProvisioningService.ts";
import * as VcsStatusBroadcaster from "../../vcs/VcsStatusBroadcaster.ts";
import * as WorkspaceEntries from "../../workspace/WorkspaceEntries.ts";
import * as WorkspaceFileSystem from "../../workspace/WorkspaceFileSystem.ts";
import * as WorktreeSetupTracker from "../../project/WorktreeSetupTracker.ts";
import { layerWsRpc, WS_RPC_SERVER_OPTIONS } from "../../ws.ts";
import * as HoustonHarnessService from "../harnessReview/Service.ts";
import * as HoustonTaskService from "../tasks/TaskService.ts";
import * as HoustonReviewState from "../reviewState.ts";
import * as HoustonTaskV1Import from "../tasks/V1Import.ts";
import * as HoustonTaskSourceService from "../taskSources/SourceService.ts";
import * as HoustonTaskSourceV1Import from "../taskSources/V1Import.ts";
import * as HoustonTaskRuns from "../tasks/TaskRuns.ts";
import * as HoustonMergeQueueService from "../mergeQueue/Service.ts";
import * as HoustonSlackService from "../slack/Service.ts";
import * as HoustonSlackV1Import from "../slack/V1Import.ts";
import {
  NOW,
  Runner,
  Store,
  createProject,
  layerKit,
  makeKit,
  makeRepository,
  seedNightShift,
  type Kit,
} from "./nightShift.testkit.ts";

// The production RPC layer; Night shift and what it reaches are real, the rest fails if called.
const layerUnusedRpcServices = Layer.mergeAll(
  Layer.mock(DocumentText.DocumentText)({}),
  Layer.mock(TraceDiagnostics.TraceDiagnostics)({}),
  Layer.mock(TriageService.TriageService)({}),
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
  Layer.mock(GitVcsDriver.GitVcsDriver)({}),
  Layer.mock(GitWorkflowService.GitWorkflowService)({}),
  Layer.mock(HostResources.HostResources)({}),
  Layer.mock(HoustonReviewState.HoustonReviewState)({}),
  Layer.mock(HoustonTaskV1Import.HoustonTaskV1Import)({}),
  Layer.mock(HoustonTaskSourceService.HoustonTaskSourceService)({}),
  Layer.mock(HoustonTaskSourceV1Import.HoustonTaskSourceV1Import)({}),
  Layer.mock(HoustonHarnessService.HoustonHarnessService)({}),
  Layer.mock(HoustonTaskService.HoustonTaskService)({}),
  Layer.mock(HoustonTaskRuns.HoustonTaskRuns)({}),
  Layer.mock(HoustonMergeQueueService.HoustonMergeQueueService)({}),
  Layer.mock(HoustonSlackService.HoustonSlackService)({}),
  Layer.mock(HoustonSlackV1Import.HoustonSlackV1Import)({}),
  Layer.mock(KnownWorkspaces.KnownWorkspaces)({}),
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
  Layer.mock(ProviderRegistry.ProviderRegistry)({}),
  Layer.mock(PullRequestReviewGuideService.PullRequestReviewGuideService)({}),
  Layer.mock(PullRequestService.PullRequestService)({}),
  Layer.mock(PullRequestSyncReactor.PullRequestSyncReactor)({}),
  Layer.mock(ResourceTelemetry.ResourceTelemetry)({}),
  Layer.mock(ReviewService.ReviewService)({}),
  Layer.mock(SecretRequests.SecretRequests)({}),
  Layer.mock(SecretResolver.SecretResolver)({}),
  Layer.mock(ServerLifecycleEvents.ServerLifecycleEvents)({}),
  Layer.mock(ServerRuntimeStartup.ServerRuntimeStartup)({}),
  Layer.mock(ServerSelfUpdate.ServerSelfUpdate)({}),
  Layer.mock(NpmRelease.NpmRelease)({}),
  Layer.mock(SessionStore.SessionStore)({
    cookieName: "houston-night-ws-test",
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
  Layer.mock(VcsDriverRegistry.VcsDriverRegistry)({}),
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
      environmentId: EnvironmentId.make("houston-night-ws-test"),
      label: "Houston night ws test",
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
        sessionCookieName: "houston-night-ws-test-session",
      }),
  }),
  Layer.mock(PreviewAutomationBroker.PreviewAutomationBroker)({}),
  Layer.mock(ServerBrowser.ServerBrowser)({}),
  Layer.mock(ModelManifest.ModelManifest)({}),
  Layer.mock(ProviderLatestVersions.ProviderLatestVersions)({}),
  Keybindings.layer,
  ServerSecretStore.layer,
);

const ALL_SCOPES: ReadonlyArray<AuthEnvironmentScope> = [
  AuthOrchestrationReadScope,
  AuthOrchestrationOperateScope,
  AuthSettingsWriteScope,
];

/** A `/ws` client of the real handlers, authorized by the real scope table. */
const makeWsClient = Effect.fn("makeWsClient")(function* (
  scopes: ReadonlyArray<AuthEnvironmentScope>,
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
        layerWsRpc(
          {
            sessionId: AuthSessionId.make("houston-night-ws-test"),
            subject: "houston-night-ws-test",
            method: "browser-session-cookie",
            scopes: [...scopes],
          },
          {},
          browser,
          () => Effect.void,
        ),
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

const failureOf = (value: unknown) => {
  const exit = (value as { readonly failed?: Exit.Exit<unknown, unknown> } | undefined)?.failed;
  if (exit === undefined || !Exit.isFailure(exit)) return null;
  return Cause.squash(exit.cause) as {
    readonly _tag?: string;
    readonly kind?: string;
    readonly message?: string;
  };
};

const layerServer = (kit: Kit) => layerUnusedRpcServices.pipe(Layer.provideMerge(layerKit(kit)));

const withServer = <A, E>(
  kit: Kit,
  body: Effect.Effect<A, E, Layer.Success<ReturnType<typeof layerServer>> | Scope.Scope>,
) =>
  Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse(NOW));
    const context = yield* Layer.build(layerServer(kit));
    return yield* body.pipe(Effect.provideContext(context));
  }).pipe(Effect.scoped);

const SCOPE_OF: Record<string, AuthEnvironmentScope> = {
  [WS_METHODS.houstonNightShiftGet]: AuthOrchestrationReadScope,
  [WS_METHODS.houstonNightShiftSubscribe]: AuthOrchestrationReadScope,
  [WS_METHODS.houstonNightShiftSubscribeOverview]: AuthOrchestrationReadScope,
  [WS_METHODS.houstonNightShiftCreate]: AuthSettingsWriteScope,
  [WS_METHODS.houstonNightShiftUpdate]: AuthSettingsWriteScope,
  [WS_METHODS.houstonNightShiftDelete]: AuthSettingsWriteScope,
  [WS_METHODS.houstonNightShiftPreflight]: AuthOrchestrationReadScope,
  [WS_METHODS.houstonNightShiftRunNow]: AuthOrchestrationOperateScope,
  [WS_METHODS.houstonNightShiftWrapUp]: AuthOrchestrationOperateScope,
  [WS_METHODS.houstonNightShiftStop]: AuthOrchestrationOperateScope,
  [WS_METHODS.houstonNightShiftReport]: AuthOrchestrationReadScope,
  [WS_METHODS.houstonNightShiftDecide]: AuthOrchestrationOperateScope,
  [WS_METHODS.houstonNightShiftMarkQaPassed]: AuthOrchestrationOperateScope,
  [WS_METHODS.houstonNightShiftClosePullRequests]: AuthOrchestrationOperateScope,
  [WS_METHODS.houstonNightShiftImportV1Status]: AuthOrchestrationReadScope,
  [WS_METHODS.houstonNightShiftImportV1Run]: AuthSettingsWriteScope,
};

/** Every event already delivered to a client, without waiting for more. */
const drain = (responses: Queue.Queue<unknown>) =>
  Effect.gen(function* () {
    for (let round = 0; round < 20; round += 1) yield* Effect.yieldNow;
    const events: Array<unknown> = [];
    for (;;) {
      const next = yield* Queue.poll(responses);
      if (next._tag === "None") return events;
      events.push(next.value);
    }
  });

describe("night shift over /ws", () => {
  it.effect("each method requires its declared scope and a known id", () =>
    Effect.gen(function* () {
      const kit = yield* makeKit("ws-scopes");
      yield* withServer(
        kit,
        Effect.gen(function* () {
          const store = yield* Store.HoustonNightShiftStore;
          const sql = yield* SqlClient.SqlClient;
          const fixture = makeRepository("ws-scopes", { kind: "bare" });
          const projectId = yield* createProject("ws-scopes", fixture.root);
          yield* seedNightShift(projectId);
          const settings = (yield* store.settings(projectId))!.settings;
          const unknownProject = "project-unknown";
          const payloads: Record<string, object> = {
            [WS_METHODS.houstonNightShiftGet]: { projectId: unknownProject },
            [WS_METHODS.houstonNightShiftSubscribe]: { projectId: unknownProject },
            [WS_METHODS.houstonNightShiftSubscribeOverview]: {},
            [WS_METHODS.houstonNightShiftCreate]: { projectId: unknownProject },
            [WS_METHODS.houstonNightShiftUpdate]: {
              projectId: unknownProject,
              settings,
              expectedRevision: 1,
            },
            [WS_METHODS.houstonNightShiftDelete]: { projectId: unknownProject },
            [WS_METHODS.houstonNightShiftPreflight]: { projectId: unknownProject },
            [WS_METHODS.houstonNightShiftRunNow]: {
              projectId: unknownProject,
              durationMinutes: 60,
            },
            [WS_METHODS.houstonNightShiftWrapUp]: { runId: 9_001 },
            [WS_METHODS.houstonNightShiftStop]: { runId: 9_002 },
            [WS_METHODS.houstonNightShiftReport]: { runId: 9_003 },
            [WS_METHODS.houstonNightShiftDecide]: { entryId: 9_004, choice: "yes" },
            [WS_METHODS.houstonNightShiftMarkQaPassed]: { entryId: 9_005 },
            [WS_METHODS.houstonNightShiftClosePullRequests]: { runId: 9_006, numbers: [1] },
            [WS_METHODS.houstonNightShiftImportV1Status]: {},
            [WS_METHODS.houstonNightShiftImportV1Run]: {},
          };
          const named: Record<string, string> = {
            [WS_METHODS.houstonNightShiftWrapUp]: "9001",
            [WS_METHODS.houstonNightShiftStop]: "9002",
            [WS_METHODS.houstonNightShiftReport]: "9003",
            [WS_METHODS.houstonNightShiftDecide]: "9004",
            [WS_METHODS.houstonNightShiftMarkQaPassed]: "9005",
            [WS_METHODS.houstonNightShiftClosePullRequests]: "9006",
          };
          const nightMethods = Object.values(WS_METHODS).filter((method) =>
            method.startsWith("houston.nightShift."),
          );
          assert.lengthOf(nightMethods, 16);
          assert.deepEqual(nightMethods.toSorted(), Object.keys(SCOPE_OF).toSorted());
          const rowsBefore = yield* sql`SELECT * FROM houston_night_shift_settings`;

          for (const method of nightMethods) {
            const required = SCOPE_OF[method]!;
            // Every scope but the declared one: refused before the handler runs.
            const without = yield* makeWsClient(ALL_SCOPES.filter((scope) => scope !== required));
            const denied = failureOf(yield* without.call(method, payloads[method]!));
            assert.equal(denied?._tag, "EnvironmentAuthorizationError", method);
            // The declared scope alone reaches the handler.
            const only = yield* makeWsClient([required]);
            const failure = failureOf(yield* only.call(method, payloads[method]!));
            assert.notEqual(failure?._tag, "EnvironmentAuthorizationError", method);
            if (method === WS_METHODS.houstonNightShiftSubscribeOverview) continue;
            if (method === WS_METHODS.houstonNightShiftImportV1Status) {
              assert.isNull(failure, method);
              continue;
            }
            assert.equal(failure?.kind, "not_found", `${method}: ${failure?.message}`);
            if (method === WS_METHODS.houstonNightShiftImportV1Run) continue;
            assert.include(failure?.message ?? "", named[method] ?? unknownProject, method);
          }
          // No refused or unknown call changed anything.
          assert.deepEqual(yield* sql`SELECT * FROM houston_night_shift_settings`, rowsBefore);
          assert.lengthOf(yield* sql`SELECT * FROM houston_night_runs`, 0);
        }),
      );
    }),
  );

  it.effect("a settled run is noticed once", () =>
    Effect.gen(function* () {
      const kit = yield* makeKit("ws-notice");
      yield* withServer(
        kit,
        Effect.gen(function* () {
          const runner = yield* Runner.HoustonNightShiftRunner;
          const fixture = makeRepository("ws-notice", { kind: "bare" });
          const projectId = yield* createProject("ws-notice", fixture.root);
          yield* seedNightShift(projectId);
          const listener = yield* makeWsClient(ALL_SCOPES);
          const subscription = yield* listener.send(
            WS_METHODS.houstonNightShiftSubscribeOverview,
            {},
          );
          const first = (yield* Queue.take(listener.responses)) as HoustonNightShiftOverviewEvent;
          assert.equal(first.type, "overview");

          const run = yield* runner.start({
            projectId,
            trigger: "manual",
            scheduledTaskId: null,
            durationMinutes: 120,
            operation: "runNow",
          });
          yield* runner.stop(run.runId);
          const seen = (yield* drain(listener.responses)) as Array<HoustonNightShiftOverviewEvent>;
          const notices = seen.filter((event) => event.type === "notice");
          assert.lengthOf(notices, 1);
          assert.deepEqual(notices[0], {
            type: "notice",
            projectId,
            runId: run.runId,
            headline: "0 pull requests, 0 open decisions",
          });
          yield* listener.interrupt(subscription);

          // A later subscriber sees the run as the last run, and no notice.
          const later = yield* makeWsClient(ALL_SCOPES);
          yield* later.send(WS_METHODS.houstonNightShiftSubscribeOverview, {});
          const overview = (yield* Queue.take(later.responses)) as HoustonNightShiftOverviewEvent;
          assert.equal(overview.type, "overview");
          const row =
            overview.type === "overview"
              ? overview.rows.find((candidate) => candidate.projectId === projectId)
              : undefined;
          assert.equal(row?.lastRun?.runId, run.runId);
          assert.equal(row?.lastRun?.headline, "0 pull requests, 0 open decisions");
          const after = (yield* drain(later.responses)) as Array<HoustonNightShiftOverviewEvent>;
          assert.isFalse(after.some((event) => event.type === "notice"));
        }),
      );
    }),
  );
});
