// The houston.harness.* methods through the real `/ws` handlers and scope table.
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
import type {
  HoustonHarnessOverviewEvent,
  HoustonHarnessSnapshot,
} from "@t3tools/contracts/houston/harnessReview";
import * as AcpRegistryRuntimeCoordinator from "@t3tools/provider-acp-registry/server/AcpRegistryRuntimeCoordinator";
import * as AcpRegistrySupport from "@t3tools/provider-acp-registry/server/AcpRegistrySupport";
import * as ProviderLatestVersions from "@t3tools/provider-core/server/ProviderLatestVersions";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import type * as Scope from "effect/Scope";
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
import * as HoustonNightShiftService from "../nightShift/Service.ts";
import * as HoustonReviewState from "../reviewState.ts";
import * as HoustonTaskService from "../tasks/TaskService.ts";
import * as HoustonTaskV1Import from "../tasks/V1Import.ts";
import * as HoustonTaskSourceService from "../taskSources/SourceService.ts";
import * as HoustonTaskSourceV1Import from "../taskSources/V1Import.ts";
import * as HoustonTaskRuns from "../tasks/TaskRuns.ts";
import * as HoustonMergeQueueService from "../mergeQueue/Service.ts";
import {
  HoustonHarnessService,
  HoustonHarnessStore,
  createProject,
  layerKit,
  makeKit,
  model,
  NOW,
  reviewTask,
  seedPublished,
  type Kit,
} from "./harnessReview.testkit.ts";

// The production RPC layer; the harness review and what it reaches are real, the rest fails if called.
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
  Layer.mock(HoustonTaskService.HoustonTaskService)({}),
  Layer.mock(HoustonTaskV1Import.HoustonTaskV1Import)({}),
  Layer.mock(HoustonTaskSourceService.HoustonTaskSourceService)({}),
  Layer.mock(HoustonTaskSourceV1Import.HoustonTaskSourceV1Import)({}),
  Layer.mock(HoustonNightShiftService.HoustonNightShiftService)({}),
  Layer.mock(HoustonTaskRuns.HoustonTaskRuns)({}),
  Layer.mock(HoustonMergeQueueService.HoustonMergeQueueService)({}),
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
  Layer.mock(ServerLifecycleEvents.ServerLifecycleEvents)({}),
  Layer.mock(ServerRuntimeStartup.ServerRuntimeStartup)({}),
  Layer.mock(ServerSelfUpdate.ServerSelfUpdate)({}),
  Layer.mock(SessionStore.SessionStore)({
    cookieName: "houston-harness-test",
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
      environmentId: EnvironmentId.make("houston-harness-test"),
      label: "Houston harness test",
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
        sessionCookieName: "houston-harness-test-session",
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
            sessionId: AuthSessionId.make("houston-harness-test"),
            subject: "houston-harness-test",
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

describe("subscriptions", () => {
  it.effect("subscribers get the snapshot then each change", () =>
    Effect.gen(function* () {
      const kit = yield* makeKit("ws-subscribe", { reactor: false });
      yield* withServer(
        kit,
        Effect.gen(function* () {
          const store = yield* HoustonHarnessStore.HoustonHarnessStore;
          const { projectId } = yield* createProject("ws-subscribe");
          const listener = yield* makeWsClient(ALL_SCOPES);
          const overviewListener = yield* makeWsClient(ALL_SCOPES);
          const client = yield* makeWsClient(ALL_SCOPES);
          const subscription = yield* listener.send(WS_METHODS.houstonHarnessSubscribe, {
            projectId,
          });
          const first = (yield* Queue.take(listener.responses)) as HoustonHarnessSnapshot;
          assert.equal(first.projectId, projectId);
          assert.lengthOf(first.reviews, 0);
          const overviewSubscription = yield* overviewListener.send(
            WS_METHODS.houstonHarnessSubscribeOverview,
            {},
          );
          const overviewFirst = (yield* Queue.take(
            overviewListener.responses,
          )) as HoustonHarnessOverviewEvent;
          assert.equal(overviewFirst.type, "overview");

          // A review started.
          const review = yield* store.openReview({
            projectId,
            trigger: "manual",
            scheduledTaskId: null,
            providerInstanceId: "claudeAgent",
            startedAt: "2026-10-30T09:00:00.000Z",
          });
          const started = (yield* Queue.take(listener.responses)) as HoustonHarnessSnapshot;
          assert.equal(started.runningReviewId, review.id);
          assert.equal(started.reviews[0]?.status, "preparing");

          // Running: only a running review publishes.
          yield* store.markRunning(review.id, {
            threadId: ThreadId.make(`harness-review:${review.id}`),
            windowSince: "2026-10-16T09:00:00.000Z",
            windowUntil: "2026-10-30T09:00:00.000Z",
            threads: 1,
            prompts: 1,
          });
          const running = (yield* Queue.take(listener.responses)) as HoustonHarnessSnapshot;
          assert.equal(running.reviews[0]?.status, "running");

          // Published.
          yield* store.publish(review.id, {
            endedAt: "2026-10-30T08:50:00.000Z",
            windowSince: "2026-10-16T09:00:00.000Z",
            windowUntil: "2026-10-30T09:00:00.000Z",
            threads: 1,
            prompts: 1,
            costUsd: null,
            summary: "1 finding",
            findings: [
              {
                key: "denied-push",
                title: "Denied git push",
                category: "permissions",
                confidence: "high",
                sessions: ["t-1"],
                count: 1,
                quotes: ["q"],
                recommendationKind: "settings-allow",
                target: ".claude/settings.json",
                recommendation: "Allow it",
                applyPrompt: "Add the rule",
              },
            ],
            verifications: [],
          });
          const published = (yield* Queue.take(listener.responses)) as HoustonHarnessSnapshot;
          assert.equal(published.reviews[0]?.status, "published");
          assert.isNull(published.runningReviewId);
          assert.lengthOf(published.findings, 1);
          const overviewAfter = (yield* Queue.take(
            overviewListener.responses,
          )) as HoustonHarnessOverviewEvent;
          assert.equal(overviewAfter.type, "overview");

          // A decision, through the RPC.
          const decided = yield* client.call(WS_METHODS.houstonHarnessDecide, {
            projectId,
            key: "denied-push",
            state: "dismissed",
          });
          assert.isNull(failureOf(decided));
          const afterDecision = (yield* Queue.take(listener.responses)) as HoustonHarnessSnapshot;
          assert.equal(afterDecision.findings[0]?.state, "dismissed");

          yield* listener.interrupt(subscription);
          yield* overviewListener.interrupt(overviewSubscription);
        }),
      );
    }),
  );
});

describe("scopes and projects", () => {
  it.effect("each method requires its declared scope and a known project", () =>
    Effect.gen(function* () {
      const kit = yield* makeKit("ws-scopes", { reactor: false });
      yield* withServer(
        kit,
        Effect.gen(function* () {
          const harness = yield* HoustonHarnessService.HoustonHarnessService;
          const store = yield* HoustonHarnessStore.HoustonHarnessStore;
          const { projectId } = yield* createProject("ws-scopes");
          const reviewId = yield* seedPublished({
            projectId,
            findings: [{ key: "denied-push" }],
            endedAt: "2026-10-20T00:00:00.000Z",
          });
          const unknownProject = "project-never-registered";
          const methods: ReadonlyArray<
            readonly [string, AuthEnvironmentScope, object, object | null]
          > = [
            [
              WS_METHODS.houstonHarnessGet,
              AuthOrchestrationReadScope,
              { projectId },
              { projectId: unknownProject },
            ],
            [
              WS_METHODS.houstonHarnessSubscribe,
              AuthOrchestrationReadScope,
              { projectId },
              { projectId: unknownProject },
            ],
            [WS_METHODS.houstonHarnessOverview, AuthOrchestrationReadScope, {}, null],
            [WS_METHODS.houstonHarnessSubscribeOverview, AuthOrchestrationReadScope, {}, null],
            [
              WS_METHODS.houstonHarnessSetup,
              AuthSettingsWriteScope,
              { projectId, modelSelection: model("claudeAgent"), schedule: "manual" },
              {
                projectId: unknownProject,
                modelSelection: model("claudeAgent"),
                schedule: "manual",
              },
            ],
            [
              WS_METHODS.houstonHarnessRunNow,
              AuthOrchestrationOperateScope,
              { projectId },
              { projectId: unknownProject },
            ],
            [
              WS_METHODS.houstonHarnessReport,
              AuthOrchestrationReadScope,
              { reviewId },
              { reviewId: 999 },
            ],
            [
              WS_METHODS.houstonHarnessDecide,
              AuthOrchestrationOperateScope,
              { projectId, key: "denied-push", state: "dismissed" },
              { projectId: unknownProject, key: "denied-push", state: "dismissed" },
            ],
            [
              WS_METHODS.houstonHarnessMarkSeen,
              AuthOrchestrationOperateScope,
              { projectId, reviewId },
              { projectId: unknownProject, reviewId },
            ],
          ];
          assert.lengthOf(methods, 9);
          for (const [method, scope, payload] of methods) {
            const client = yield* makeWsClient(
              ALL_SCOPES.filter((candidate) => candidate !== scope),
            );
            const reply = yield* client.call(method, payload);
            assert.equal(failureOf(reply)?._tag, "EnvironmentAuthorizationError", method);
          }
          // Nothing changed: no schedule, no decision, no cursor move.
          assert.isUndefined(yield* reviewTask(projectId));
          const snapshot = yield* harness.get({ projectId });
          assert.equal(snapshot.findings[0]?.state, "open");
          assert.equal(snapshot.seenReviewId, 0);
          assert.isNull((yield* store.settings(projectId))?.scheduledTaskId ?? null);

          const client = yield* makeWsClient(ALL_SCOPES);
          for (const [method, , , unknown] of methods) {
            if (unknown === null) continue;
            const reply = yield* client.call(method, unknown);
            const failure = failureOf(reply);
            assert.equal(failure?.kind, "not_found", method);
            assert.include(
              failure?.message ?? "",
              method === WS_METHODS.houstonHarnessReport ? "999" : unknownProject,
              method,
            );
          }
        }),
      );
    }),
  );
});
