// @effect-diagnostics nodeBuiltinImport:off - builds the restart test's database path.
// The houston.mergeQueue.* methods through the real `/ws` handlers and scope table.
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthSessionId,
  AuthSettingsWriteScope,
  EnvironmentId,
  WS_METHODS,
  WsRpcGroup,
  type AuthEnvironmentScope,
} from "@t3tools/contracts";
import type {
  HoustonMergeQueueSnapshot,
  HoustonMergeQueueSummary,
} from "@t3tools/contracts/houston/mergeQueue";
import * as AcpRegistryRuntimeCoordinator from "@t3tools/provider-acp-registry/server/AcpRegistryRuntimeCoordinator";
import * as AcpRegistrySupport from "@t3tools/provider-acp-registry/server/AcpRegistrySupport";
import * as ProviderLatestVersions from "@t3tools/provider-core/server/ProviderLatestVersions";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { Headers } from "effect/http";
import * as SqlClient from "effect/sql/SqlClient";
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
import * as OrchestrationEventStore from "../../persistence/OrchestrationEventStore.ts";
import * as Orchestrator from "../../orchestration-v2/Orchestrator.ts";
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
import * as ProviderSessionManager from "../../orchestration-v2/ProviderSessionManager.ts";
import * as PullRequestReviewGuideService from "../../pullRequest/PullRequestReviewGuideService.ts";
import * as PullRequestSyncReactor from "../../orchestration-v2/PullRequestSyncReactor.ts";
import * as RemoteOpenTargets from "../../environment/RemoteOpenTargets.ts";
import * as ResourceTelemetry from "../../resourceTelemetry/ResourceTelemetry.ts";
import * as ReviewService from "../../review/ReviewService.ts";
import * as ScheduledTasks from "../../scheduledTasks/ScheduledTaskService.ts";
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
import * as HoustonReviewState from "../reviewState.ts";
import * as HoustonTaskSourceService from "../taskSources/SourceService.ts";
import * as HoustonTaskSourceV1Import from "../taskSources/V1Import.ts";
import * as HoustonTaskRuns from "../tasks/TaskRuns.ts";
import * as HoustonTaskService from "../tasks/TaskService.ts";
import * as HoustonTaskV1Import from "../tasks/V1Import.ts";
import {
  createProject,
  entryOf,
  layerMergeQueueTest,
  makeGitHub,
  makeRepos,
  openPull,
  pushBranch,
  type FakeGitHub,
  type MergeQueueTestOptions,
} from "./mergeQueue.testkit.ts";
import { HoustonMergeQueueRunner } from "./Runner.ts";
import { HoustonMergeQueueStore } from "./Store.ts";

// Build the production RPC layer; unrelated capabilities fail if these tests call them.
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
  Layer.mock(HoustonTaskRuns.HoustonTaskRuns)({}),
  Layer.mock(HoustonTaskV1Import.HoustonTaskV1Import)({}),
  Layer.mock(HoustonTaskSourceService.HoustonTaskSourceService)({}),
  Layer.mock(HoustonTaskSourceV1Import.HoustonTaskSourceV1Import)({}),
  Layer.mock(KnownWorkspaces.KnownWorkspaces)({}),
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
  Layer.mock(ProjectSetupScriptRunner.ProjectSetupScriptRunner)({}),
  Layer.mock(ProviderAuthService.ProviderAuthService)({}),
  Layer.mock(ProviderMaintenanceRunner.ProviderMaintenanceRunner)({}),
  Layer.mock(ProviderRegistry.ProviderRegistry)({}),
  Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({}),
  Layer.mock(PullRequestReviewGuideService.PullRequestReviewGuideService)({}),
  Layer.mock(PullRequestSyncReactor.PullRequestSyncReactor)({}),
  Layer.mock(ResourceTelemetry.ResourceTelemetry)({}),
  Layer.mock(ReviewService.ReviewService)({}),
  Layer.mock(ScheduledTasks.ScheduledTaskService)({}),
  Layer.mock(SecretRequests.SecretRequests)({}),
  Layer.mock(ServerLifecycleEvents.ServerLifecycleEvents)({}),
  Layer.mock(ServerRuntimeStartup.ServerRuntimeStartup)({}),
  Layer.mock(ServerSelfUpdate.ServerSelfUpdate)({}),
  Layer.mock(SessionStore.SessionStore)({
    cookieName: "houston-mq-test",
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
      environmentId: EnvironmentId.make("houston-mq-test"),
      label: "Houston merge queue test",
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
        sessionCookieName: "houston-mq-test-session",
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
            sessionId: AuthSessionId.make("houston-mq-test"),
            subject: "houston-mq-test",
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

type ServerServices =
  | Layer.Success<typeof layerUnusedRpcServices>
  | Layer.Success<ReturnType<typeof layerMergeQueueTest>>
  | Scope.Scope;

const layerServer = (options: MergeQueueTestOptions) =>
  layerUnusedRpcServices.pipe(
    Layer.provideMerge(layerMergeQueueTest({ loops: false, ...options })),
  );

const withServer = <A, E>(
  body: Effect.Effect<A, E, ServerServices>,
  options: MergeQueueTestOptions,
) =>
  body.pipe(
    Effect.provide(layerServer(options)),
    Effect.scoped,
    Effect.provide(NodeServices.layer),
  );

/** A project whose pull requests are open on the fake and pushed to the bare remote. */
const project = (name: string, github: FakeGitHub, numbers: ReadonlyArray<number>) =>
  Effect.gen(function* () {
    for (const number of numbers) {
      pushBranch(github.repos!, `houston/${number}`, { [`f${number}.txt`]: `${number}\n` });
      openPull(github, number);
    }
    return yield* createProject(name, github.repos!.checkout);
  });

const SETTINGS = {
  mergeWhenVerified: false,
  verificationCommand: "git --version",
  timeLimitMinutes: 30,
};

describe("subscribers get the snapshot then each change", () => {
  it.effect("subscribers get the snapshot then each change", () => {
    const github = makeGitHub(makeRepos());
    return withServer(
      Effect.gen(function* () {
        const projectId = yield* project("subscribe", github, [1, 2]);
        const store = yield* HoustonMergeQueueStore;
        yield* store.appendLog(projectId, {
          kind: "push",
          number: 9,
          repository: "o/r",
          url: "https://github.com/o/r/pull/9",
          title: "Old push",
          refName: "houston/9",
          oldSha: null,
          newSha: null,
          headSha: null,
          forkSha: null,
          method: null,
          detail: null,
          unattended: false,
        });
        const client = yield* makeWsClient(ALL_SCOPES);
        const listener = yield* makeWsClient(ALL_SCOPES);
        const id = yield* listener.send(WS_METHODS.houstonMergeQueueSubscribe, { projectId });
        const first = (yield* Queue.take(listener.responses)) as HoustonMergeQueueSnapshot;
        assert.deepEqual(first.entries, []);
        assert.deepEqual(
          first.log.map((row) => [row.kind, row.number]),
          [["push", 9]],
        );
        assert.strictEqual(first.settings.revision, 0);
        assert.isFalse(first.globalPaused);
        assert.deepEqual(first.away, { merged: 0, parked: 0 });
        assert.isNull(first.handOff);

        const calls: ReadonlyArray<readonly [string, object]> = [
          [WS_METHODS.houstonMergeQueueEnqueue, { projectId, pullRequest: 1 }],
          [WS_METHODS.houstonMergeQueueEnqueue, { projectId, pullRequest: 2, dependsOn: 1 }],
          [WS_METHODS.houstonMergeQueueSettingsSet, { projectId, ...SETTINGS }],
          [WS_METHODS.houstonMergeQueuePause, { projectId, paused: true }],
          [WS_METHODS.houstonMergeQueueDequeue, { projectId, number: 2 }],
        ];
        const snapshots: Array<HoustonMergeQueueSnapshot> = [];
        for (const [method, payload] of calls) {
          const reply = yield* client.call(method, payload);
          assert.isNull(failureOf(reply), `${method}: ${JSON.stringify(failureOf(reply))}`);
          snapshots.push((yield* Queue.take(listener.responses)) as HoustonMergeQueueSnapshot);
        }
        assert.deepEqual(
          snapshots.map((snapshot) => snapshot.entries.map((entry) => entry.number)),
          [[1], [1, 2], [1, 2], [1, 2], [1]],
        );
        assert.strictEqual(snapshots[1]!.entries[1]!.dependsOn, 1);
        assert.strictEqual(snapshots[2]!.settings.verificationCommand, "git --version");
        assert.isTrue(snapshots[3]!.settings.paused);
        assert.strictEqual(entryOf(snapshots[3]!, 1).status, "paused");
        assert.strictEqual(yield* Queue.size(listener.responses), 0);
        yield* listener.interrupt(id);

        // The summary counts parked entries and the global pause.
        const summary = yield* makeWsClient(ALL_SCOPES);
        const summaryId = yield* summary.send(WS_METHODS.houstonMergeQueueSubscribeSummary, {});
        const start = (yield* Queue.take(summary.responses)) as HoustonMergeQueueSummary;
        assert.deepEqual(start, { parked: [{ projectId, parked: 0 }], globalPaused: false });
        yield* client.call(WS_METHODS.houstonMergeQueueSettingsSet, {
          projectId,
          ...SETTINGS,
          verificationCommand: "exit 1",
        });
        yield* client.call(WS_METHODS.houstonMergeQueuePause, { projectId, paused: false });
        const runner = yield* HoustonMergeQueueRunner;
        yield* runner.step(projectId);
        let parked = (yield* Queue.take(summary.responses)) as HoustonMergeQueueSummary;
        while (parked.parked[0]?.parked !== 1) {
          parked = (yield* Queue.take(summary.responses)) as HoustonMergeQueueSummary;
        }
        assert.deepEqual(parked, { parked: [{ projectId, parked: 1 }], globalPaused: false });
        yield* client.call(WS_METHODS.houstonMergeQueuePause, { paused: true });
        let paused = (yield* Queue.take(summary.responses)) as HoustonMergeQueueSummary;
        while (!paused.globalPaused) {
          paused = (yield* Queue.take(summary.responses)) as HoustonMergeQueueSummary;
        }
        assert.deepEqual(paused, { parked: [{ projectId, parked: 1 }], globalPaused: true });
        yield* summary.interrupt(summaryId);
      }),
      { github },
    );
  });
});

describe("each method requires its declared scope and a known project", () => {
  it.effect("each method requires its declared scope and a known project", () => {
    const github = makeGitHub(makeRepos());
    return withServer(
      Effect.gen(function* () {
        const projectId = yield* project("scoped", github, [1, 2]);
        const sql = yield* SqlClient.SqlClient;
        const fingerprint = Effect.all([
          sql`SELECT * FROM houston_merge_queue_entries ORDER BY number`,
          sql`SELECT * FROM houston_merge_queue_settings`,
          sql`SELECT * FROM houston_merge_queue_log`,
          sql`SELECT * FROM houston_merge_queue_global`,
        ]).pipe(Effect.map((rows) => JSON.stringify(rows)));
        const setup = yield* makeWsClient(ALL_SCOPES);
        yield* setup.call(WS_METHODS.houstonMergeQueueEnqueue, { projectId, pullRequest: 1 });
        const head = "0".repeat(40);
        const METHODS: ReadonlyArray<{
          readonly method: string;
          readonly scope: AuthEnvironmentScope;
          readonly payload: object;
          readonly stream?: boolean;
        }> = [
          {
            method: WS_METHODS.houstonMergeQueueGet,
            scope: AuthOrchestrationReadScope,
            payload: { projectId },
          },
          {
            method: WS_METHODS.houstonMergeQueueSubscribe,
            scope: AuthOrchestrationReadScope,
            payload: { projectId },
            stream: true,
          },
          {
            method: WS_METHODS.houstonMergeQueueSubscribeSummary,
            scope: AuthOrchestrationReadScope,
            payload: {},
            stream: true,
          },
          {
            method: WS_METHODS.houstonMergeQueueEnqueue,
            scope: AuthOrchestrationOperateScope,
            payload: { projectId, pullRequest: 2 },
          },
          {
            method: WS_METHODS.houstonMergeQueueMergeHead,
            scope: AuthOrchestrationOperateScope,
            payload: { projectId, number: 1, expectedHeadSha: head },
          },
          {
            method: WS_METHODS.houstonMergeQueueSettingsSet,
            scope: AuthSettingsWriteScope,
            payload: { projectId, ...SETTINGS },
          },
          {
            method: WS_METHODS.houstonMergeQueuePause,
            scope: AuthOrchestrationOperateScope,
            payload: { projectId, paused: true },
          },
          {
            method: WS_METHODS.houstonMergeQueuePause,
            scope: AuthSettingsWriteScope,
            payload: { paused: true },
          },
          {
            method: WS_METHODS.houstonMergeQueueDequeue,
            scope: AuthOrchestrationOperateScope,
            payload: { projectId, number: 1 },
          },
        ];
        for (const entry of METHODS) {
          const before = yield* fingerprint;
          const without = yield* makeWsClient(ALL_SCOPES.filter((scope) => scope !== entry.scope));
          const denied = failureOf(yield* without.call(entry.method, entry.payload));
          assert.strictEqual(denied?._tag, "EnvironmentAuthorizationError", entry.method);
          assert.strictEqual(yield* fingerprint, before, `${entry.method} changed state`);
          const only = yield* makeWsClient([entry.scope]);
          const id = yield* only.send(entry.method, entry.payload);
          const allowed = failureOf(yield* Queue.take(only.responses));
          assert.notStrictEqual(allowed?._tag, "EnvironmentAuthorizationError", entry.method);
          if (entry.stream === true) yield* only.interrupt(id);
        }

        const client = yield* makeWsClient(ALL_SCOPES);
        const unknown = "project-missing";
        for (const [method, payload] of [
          [WS_METHODS.houstonMergeQueueGet, { projectId: unknown }],
          [WS_METHODS.houstonMergeQueueSubscribe, { projectId: unknown }],
          [WS_METHODS.houstonMergeQueueEnqueue, { projectId: unknown, pullRequest: 1 }],
          [WS_METHODS.houstonMergeQueueDequeue, { projectId: unknown, number: 1 }],
          [
            WS_METHODS.houstonMergeQueueMergeHead,
            { projectId: unknown, number: 1, expectedHeadSha: head },
          ],
          [WS_METHODS.houstonMergeQueueSettingsSet, { projectId: unknown, ...SETTINGS }],
          [WS_METHODS.houstonMergeQueuePause, { projectId: unknown, paused: true }],
        ] as const) {
          const refused = failureOf(yield* client.call(method, payload));
          assert.strictEqual(refused?.kind, "not_found", method);
          assert.include(refused?.message, unknown, method);
        }
      }),
      { github },
    );
  });
});

describe("the queue survives a restart", () => {
  it.effect("the queue survives a restart", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "houston-mq-restart-" });
      const github = makeGitHub(makeRepos());
      const options: MergeQueueTestOptions = {
        databaseFile: NodePath.join(dir, "state.sqlite"),
        baseDir: dir,
        github,
      };
      const read = Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        return JSON.stringify(
          yield* Effect.all([
            sql`SELECT * FROM houston_merge_queue_entries ORDER BY number`,
            sql`SELECT * FROM houston_merge_queue_settings`,
            sql`SELECT * FROM houston_merge_queue_log ORDER BY id`,
            sql`SELECT * FROM houston_merge_queue_global`,
          ]),
        );
      });
      const logRow = {
        kind: "merge" as const,
        number: 1,
        repository: "o/r",
        url: "https://github.com/o/r/pull/1",
        title: "PR 1",
        refName: "main",
        oldSha: null,
        newSha: null,
        headSha: null,
        forkSha: null,
        method: "squash" as const,
        detail: null,
        unattended: true,
      };
      const before = yield* Effect.gen(function* () {
        const projectId = yield* project("restart", github, [1, 2]);
        const client = yield* makeWsClient(ALL_SCOPES);
        yield* client.call(WS_METHODS.houstonMergeQueueEnqueue, { projectId, pullRequest: 1 });
        yield* client.call(WS_METHODS.houstonMergeQueueEnqueue, { projectId, pullRequest: 2 });
        yield* client.call(WS_METHODS.houstonMergeQueueSettingsSet, { projectId, ...SETTINGS });
        yield* client.call(WS_METHODS.houstonMergeQueuePause, { paused: true });
        const store = yield* HoustonMergeQueueStore;
        const sql = yield* SqlClient.SqlClient;
        yield* store.appendLog(projectId, logRow);
        // On the test clock it is 1970-01-01: a row 32 days old goes on the next insert.
        yield* sql`UPDATE houston_merge_queue_log SET at = '1969-11-30T00:00:00.000Z'`;
        yield* store.appendLog(projectId, { ...logRow, number: 2 });
        const ages = yield* sql<{ readonly number: number }>`
          SELECT number FROM houston_merge_queue_log ORDER BY id
        `;
        assert.deepEqual(
          ages.map((row) => row.number),
          [2],
        );
        return yield* read;
      }).pipe(Effect.provide(layerServer(options)));
      assert.include(before, "git --version");
      yield* Effect.gen(function* () {
        assert.strictEqual(yield* read, before);
        const client = yield* makeWsClient(ALL_SCOPES);
        const snapshot = (yield* client.call(WS_METHODS.houstonMergeQueueGet, {
          projectId: "project-restart",
        })) as HoustonMergeQueueSnapshot;
        assert.deepEqual(
          snapshot.entries.map((entry) => entry.number),
          [1, 2],
        );
        assert.strictEqual(snapshot.settings.verificationCommand, "git --version");
        assert.isTrue(snapshot.globalPaused);
        assert.deepEqual(
          snapshot.log.map((row) => [row.kind, row.number]),
          [["merge", 2]],
        );
      }).pipe(Effect.provide(layerServer(options)));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
