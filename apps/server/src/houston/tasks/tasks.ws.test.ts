// @effect-diagnostics nodeBuiltinImport:off - lays out a channel directory beside the base dir.
// The houston.tasks.* methods through the real `/ws` handlers and the real scope table.
import * as NodeFS from "node:fs";
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
  HoustonTask,
  HoustonTaskDetail,
  HoustonTaskRun,
  HoustonTaskStreamEvent,
} from "@t3tools/contracts/houston/tasks";
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
import * as PullRequestService from "../../pullRequest/PullRequestService.ts";
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
import * as HoustonTaskRuns from "./TaskRuns.ts";
import * as HoustonMergeQueueService from "../mergeQueue/Service.ts";
import * as HoustonHarnessService from "../harnessReview/Service.ts";
import * as HoustonNightShiftService from "../nightShift/Service.ts";
import * as HoustonTaskService from "./TaskService.ts";
import { createProject, layerTasks, type TasksTestOptions } from "./tasks.testkit.ts";
import { writeV1Database } from "./v1Fixture.ts";

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
  Layer.mock(HoustonTaskSourceService.HoustonTaskSourceService)({}),
  Layer.mock(HoustonTaskSourceV1Import.HoustonTaskSourceV1Import)({}),
  Layer.mock(HoustonMergeQueueService.HoustonMergeQueueService)({}),
  Layer.mock(HoustonHarnessService.HoustonHarnessService)({}),
  Layer.mock(HoustonNightShiftService.HoustonNightShiftService)({}),
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
  Layer.mock(PullRequestService.PullRequestService)({}),
  Layer.mock(PullRequestSyncReactor.PullRequestSyncReactor)({}),
  Layer.mock(ResourceTelemetry.ResourceTelemetry)({}),
  Layer.mock(ReviewService.ReviewService)({}),
  Layer.mock(ScheduledTasks.ScheduledTaskService)({}),
  Layer.mock(SecretRequests.SecretRequests)({}),
  Layer.mock(ServerLifecycleEvents.ServerLifecycleEvents)({}),
  Layer.mock(ServerRuntimeStartup.ServerRuntimeStartup)({}),
  Layer.mock(ServerSelfUpdate.ServerSelfUpdate)({}),
  Layer.mock(SessionStore.SessionStore)({
    cookieName: "houston-tasks-test",
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
      environmentId: EnvironmentId.make("houston-tasks-test"),
      label: "Houston tasks test",
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
        sessionCookieName: "houston-tasks-test-session",
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

type Response = unknown;

/** A `/ws` client of the real handlers, authorized by the real scope table. */
const makeWsClient = Effect.fn("makeWsClient")(function* (
  scopes: ReadonlyArray<AuthEnvironmentScope>,
) {
  const responses = yield* Queue.unbounded<Response>();
  const browser = yield* ServerBrowser.ServerBrowser;
  // Set once the server exists; a stream sends its next chunk after the client acks one.
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
            sessionId: AuthSessionId.make("houston-tasks-test"),
            subject: "houston-tasks-test",
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

// Runs launch threads, which TaskRuns.test.ts proves; here a double answers so the scope table is
// what the handlers' wiring meets.
const DOUBLE_RUN: HoustonTaskRun = {
  id: 1,
  taskId: 2,
  attempt: 1,
  kind: "implementation",
  state: "running",
  provider: "claudeAgent",
  reviewer: null,
  threadId: null,
  runId: null,
  worktreePath: null,
  branch: null,
  baseCommit: null,
  initialRevision: 1,
  summary: null,
  reason: null,
  startedAt: "2026-10-30T00:00:00.000Z",
  endedAt: null,
  prUrl: null,
  review: null,
};

const layerRunsDouble = Layer.effect(
  HoustonTaskRuns.HoustonTaskRuns,
  Effect.gen(function* () {
    const tasks = yield* HoustonTaskService.HoustonTaskService;
    const detail = (input: { readonly id?: string }) => tasks.get({ id: input.id ?? "HOU-2" });
    return HoustonTaskRuns.HoustonTaskRuns.of({
      start: () => Effect.succeed({ run: DOUBLE_RUN }),
      runControl: () => Effect.succeed(DOUBLE_RUN),
      handback: () => Effect.succeed(DOUBLE_RUN),
      planStart: detail,
      planAnswer: detail,
      planApprove: detail,
      reviewStart: () => detail({}),
    } as never);
  }),
);

const layerServer = (options: TasksTestOptions) =>
  layerUnusedRpcServices.pipe(
    Layer.provideMerge(layerRunsDouble),
    Layer.provideMerge(layerTasks(options)),
  );

type ServerServices = Layer.Success<ReturnType<typeof layerServer>> | Scope.Scope;

const withServer = <A, E>(
  body: (dirs: {
    readonly channel: string;
    readonly baseDir: string;
  }) => Effect.Effect<A, E, ServerServices>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const channel = yield* fs.makeTempDirectoryScoped({ prefix: "houston-tasks-ws-" });
    const baseDir = NodePath.join(channel, "v2");
    NodeFS.mkdirSync(baseDir);
    return yield* body({ channel, baseDir }).pipe(Effect.provide(layerServer({ baseDir })));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

describe("a task round trip over the socket", () => {
  it.effect("save, get, edit, comment, check and archive each return the new revision", () =>
    withServer(() =>
      Effect.gen(function* () {
        const client = yield* makeWsClient(ALL_SCOPES);
        const created = (yield* client.call(WS_METHODS.houstonTasksSave, {
          patch: { title: "Round trip", acceptance: ["first", "second"] },
        })) as HoustonTask;
        assert.isNull(failureOf(created));
        assert.strictEqual(created.key, "HOU-1");
        assert.strictEqual(created.revision, 1);

        const detail = (yield* client.call(WS_METHODS.houstonTasksGet, {
          id: "hou-1",
        })) as HoustonTaskDetail;
        assert.deepEqual(
          detail.acceptance.map((item) => item.text),
          ["first", "second"],
        );

        const edited = (yield* client.call(WS_METHODS.houstonTasksSave, {
          id: "HOU-1",
          expectedRevision: 1,
          patch: { title: "Round trip, edited" },
        })) as HoustonTask;
        assert.strictEqual(edited.revision, 2);
        const stale = yield* client.call(WS_METHODS.houstonTasksSave, {
          id: "HOU-1",
          expectedRevision: 1,
          patch: { title: "stale" },
        });
        assert.strictEqual(failureOf(stale)?.kind, "conflict");

        const commented = (yield* client.call(WS_METHODS.houstonTasksComment, {
          id: "HOU-1",
          body: "looks good",
        })) as HoustonTask;
        assert.strictEqual(commented.revision, 3);
        const checked = (yield* client.call(WS_METHODS.houstonTasksCheck, {
          id: "HOU-1",
          item: detail.acceptance[0]?.id,
          checked: true,
        })) as HoustonTask;
        assert.strictEqual(checked.revision, 4);
        const archived = (yield* client.call(WS_METHODS.houstonTasksArchive, {
          id: "HOU-1",
          archived: true,
          expectedRevision: 4,
        })) as HoustonTask;
        assert.strictEqual(archived.revision, 5);
        assert.isNotNull(archived.archivedAt);

        const after = (yield* client.call(WS_METHODS.houstonTasksGet, {
          id: String(created.id),
        })) as HoustonTaskDetail;
        assert.strictEqual(after.task.title, "Round trip, edited");
        assert.strictEqual(after.comments[0]?.body, "looks good");
        assert.strictEqual(after.acceptance[0]?.checkedBy, "user");
        const missing = yield* client.call(WS_METHODS.houstonTasksGet, { id: "HOU-404" });
        assert.strictEqual(failureOf(missing)?.kind, "not_found");
        assert.include(failureOf(missing)?.message ?? "", "HOU-404");
      }),
    ),
  );
});

describe("subscribe sends a snapshot then one event per write", () => {
  it.effect("a snapshot of summaries without descriptions, then changed events in order", () =>
    withServer(() =>
      Effect.gen(function* () {
        const client = yield* makeWsClient(ALL_SCOPES);
        yield* client.call(WS_METHODS.houstonTasksSave, {
          patch: { title: "Existing", description: "long text" },
        });
        const archived = (yield* client.call(WS_METHODS.houstonTasksSave, {
          patch: { title: "Archived" },
        })) as HoustonTask;
        yield* client.call(WS_METHODS.houstonTasksArchive, {
          id: archived.key,
          archived: true,
          expectedRevision: 1,
        });

        const subscription = yield* client.send(WS_METHODS.houstonTasksSubscribe, { scope: "all" });
        const first = (yield* Queue.take(client.responses)) as HoustonTaskStreamEvent;
        assert.isTrue("snapshot" in first);
        if (!("snapshot" in first)) return;
        assert.deepEqual(first.snapshot.tasks.map((task) => task.key).toSorted(), [
          "HOU-1",
          "HOU-2",
        ]);
        assert.isFalse(first.snapshot.tasks.some((task) => "description" in task));
        assert.isNotNull(first.snapshot.tasks.find((task) => task.key === "HOU-2")?.archivedAt);
        assert.strictEqual(first.snapshot.counts.backlog, 1);

        // Writes from another client reach the subscriber, one event each, in commit order.
        const writer = yield* makeWsClient(ALL_SCOPES);
        yield* writer.call(WS_METHODS.houstonTasksSave, { patch: { title: "Third" } });
        yield* writer.call(WS_METHODS.houstonTasksSave, {
          id: "HOU-1",
          expectedRevision: 1,
          patch: { status: "todo" },
        });
        const events = [
          (yield* Queue.take(client.responses)) as HoustonTaskStreamEvent,
          (yield* Queue.take(client.responses)) as HoustonTaskStreamEvent,
        ];
        assert.deepEqual(
          events.map((event) =>
            "changed" in event ? [event.changed.key, event.changed.status] : null,
          ),
          [
            ["HOU-3", "backlog"],
            ["HOU-1", "todo"],
          ],
        );
        yield* client.interrupt(subscription);
      }),
    ),
  );
});

describe("scopes select all, unassigned or one project", () => {
  it.effect("each scope lists its tasks; a project change leaves a scope as removed", () =>
    withServer(() =>
      Effect.gen(function* () {
        const projectA = yield* createProject("scope-a");
        const projectB = yield* createProject("scope-b");
        const client = yield* makeWsClient(ALL_SCOPES);
        const save = (patch: object) =>
          client.call(WS_METHODS.houstonTasksSave, { patch }) as Effect.Effect<HoustonTask>;
        yield* save({ title: "in A", projectId: projectA });
        yield* save({ title: "in B", projectId: projectB });
        yield* save({ title: "nowhere" });

        const snapshotOf = (scope: unknown) =>
          Effect.gen(function* () {
            const listener = yield* makeWsClient(ALL_SCOPES);
            const id = yield* listener.send(WS_METHODS.houstonTasksSubscribe, { scope });
            const first = yield* Queue.take(listener.responses);
            const failure = failureOf(first);
            if (failure !== null) return { failure, listener, id };
            const event = first as Extract<HoustonTaskStreamEvent, { snapshot: unknown }>;
            return {
              titles: event.snapshot.tasks.map((task) => task.title).toSorted(),
              listener,
              id,
            };
          });

        assert.deepEqual((yield* snapshotOf("all")).titles, ["in A", "in B", "nowhere"]);
        assert.deepEqual((yield* snapshotOf("unassigned")).titles, ["nowhere"]);
        const scopedA = yield* snapshotOf({ projectId: projectA });
        assert.deepEqual(scopedA.titles, ["in A"]);
        assert.deepEqual((yield* snapshotOf({ projectId: projectB })).titles, ["in B"]);
        const unknown = yield* snapshotOf({ projectId: "project-unknown" });
        assert.strictEqual(unknown.failure?.kind, "invalid");
        assert.include(unknown.failure?.message ?? "", "project-unknown");

        // Moving the task out of A reaches A's subscriber as removed.
        yield* client.call(WS_METHODS.houstonTasksSave, {
          id: "HOU-1",
          expectedRevision: 1,
          patch: { projectId: projectB },
        });
        const moved = (yield* Queue.take(scopedA.listener.responses)) as HoustonTaskStreamEvent;
        assert.isTrue("removed" in moved);
        if ("removed" in moved) assert.strictEqual(moved.removed.id, 1);
      }),
    ),
  );
});

describe("each method requires its declared scope", () => {
  const methods: ReadonlyArray<{
    readonly method: string;
    readonly scope: AuthEnvironmentScope;
    readonly payload: (state: { readonly projectId: string; readonly itemId: number }) => object;
  }> = [
    {
      method: WS_METHODS.houstonTasksImportV1Status,
      scope: AuthOrchestrationReadScope,
      payload: () => ({}),
    },
    {
      method: WS_METHODS.houstonTasksImportV1Run,
      scope: AuthSettingsWriteScope,
      payload: () => ({}),
    },
    {
      method: WS_METHODS.houstonTasksSave,
      scope: AuthOrchestrationOperateScope,
      payload: ({ projectId }) => ({ patch: { title: "scoped", projectId, acceptance: ["a"] } }),
    },
    {
      method: WS_METHODS.houstonTasksGet,
      scope: AuthOrchestrationReadScope,
      payload: () => ({ id: "HOU-2" }),
    },
    {
      method: WS_METHODS.houstonTasksComment,
      scope: AuthOrchestrationOperateScope,
      payload: () => ({ id: "HOU-2", body: "scoped comment" }),
    },
    {
      method: WS_METHODS.houstonTasksCheck,
      scope: AuthOrchestrationOperateScope,
      payload: ({ itemId }) => ({ id: "HOU-2", item: itemId, checked: true }),
    },
    {
      method: WS_METHODS.houstonTasksDomainSave,
      scope: AuthOrchestrationOperateScope,
      payload: () => ({ id: "HOU-2", expectedRevision: 3, blockedBy: [1] }),
    },
    {
      method: WS_METHODS.houstonTasksArchive,
      scope: AuthOrchestrationOperateScope,
      payload: () => ({ id: "HOU-2", archived: true, expectedRevision: 4 }),
    },
    {
      method: WS_METHODS.houstonTasksInitiativesSave,
      scope: AuthOrchestrationOperateScope,
      payload: ({ projectId }) => ({ projectId, name: "Scoped initiative" }),
    },
    {
      method: WS_METHODS.houstonTasksInitiativesList,
      scope: AuthOrchestrationReadScope,
      payload: ({ projectId }) => ({ projectId }),
    },
    {
      method: WS_METHODS.houstonTasksInitiativesArchive,
      scope: AuthOrchestrationOperateScope,
      payload: () => ({ id: 1, archived: true, expectedRevision: 1 }),
    },
    {
      method: WS_METHODS.houstonTasksSettingsGet,
      scope: AuthOrchestrationReadScope,
      payload: ({ projectId }) => ({ projectId }),
    },
    {
      method: WS_METHODS.houstonTasksSettingsSet,
      scope: AuthSettingsWriteScope,
      payload: ({ projectId }) => ({
        projectId,
        settings: {
          access: "read",
          startModel: { instanceId: "claudeAgent", model: "claude-opus-5-5" },
          delivery: "send",
          reviewer: null,
          focus: "bugs",
          reworkRounds: 1,
        },
      }),
    },
    {
      method: WS_METHODS.houstonTasksSubscribe,
      scope: AuthOrchestrationReadScope,
      payload: () => ({ scope: "all" }),
    },
    {
      method: WS_METHODS.houstonTasksStart,
      scope: AuthOrchestrationOperateScope,
      payload: () => ({ id: "HOU-2", overrideReadiness: true }),
    },
    {
      method: WS_METHODS.houstonTasksRunControl,
      scope: AuthOrchestrationOperateScope,
      payload: () => ({ runId: 1, action: "stop" }),
    },
    {
      method: WS_METHODS.houstonTasksHandback,
      scope: AuthOrchestrationOperateScope,
      payload: () => ({ id: "HOU-2", summary: "scoped handback" }),
    },
    {
      method: WS_METHODS.houstonTasksPlanStart,
      scope: AuthOrchestrationOperateScope,
      payload: () => ({
        id: "HOU-2",
        expectedRevision: 1,
        modelSelection: { instanceId: "codex", model: "gpt-5.1-codex" },
      }),
    },
    {
      method: WS_METHODS.houstonTasksPlanAnswer,
      scope: AuthOrchestrationOperateScope,
      payload: () => ({ id: "HOU-2", expectedRevision: 1, question: "q", answer: "a" }),
    },
    {
      method: WS_METHODS.houstonTasksPlanApprove,
      scope: AuthOrchestrationOperateScope,
      payload: () => ({ id: "HOU-2", expectedRevision: 1, planRevision: 1 }),
    },
    {
      method: WS_METHODS.houstonTasksReviewStart,
      scope: AuthOrchestrationOperateScope,
      payload: () => ({ runId: 1 }),
    },
  ];

  it.effect("without its scope a method fails and changes nothing; with only it, it succeeds", () =>
    withServer(({ channel }) =>
      Effect.gen(function* () {
        writeV1Database(NodePath.join(channel, "houston.db"), {
          nextNumber: 2,
          tasks: [
            { id: 1, workspace: null, number: 1, title: "from v1", status: "todo", createdAtMs: 0 },
          ],
        });
        const projectId = yield* createProject("scoped");
        const tasks = yield* HoustonTaskService.HoustonTaskService;
        const state = { projectId: projectId as string, itemId: 0 };
        const reader = yield* makeWsClient(ALL_SCOPES);
        const fingerprint = Effect.gen(function* () {
          const listener = yield* makeWsClient(ALL_SCOPES);
          const id = yield* listener.send(WS_METHODS.houstonTasksSubscribe, { scope: "all" });
          const first = yield* Queue.take(listener.responses);
          yield* listener.interrupt(id);
          const initiatives = yield* tasks.listInitiatives({ projectId });
          const settings = yield* tasks.getSettings({ projectId });
          return JSON.stringify({ first, initiatives, settings });
        });

        for (const entry of methods) {
          if (entry.method === WS_METHODS.houstonTasksCheck) {
            const detail = (yield* reader.call(WS_METHODS.houstonTasksGet, {
              id: "HOU-2",
            })) as HoustonTaskDetail;
            state.itemId = detail.acceptance[0]?.id ?? 0;
          }
          const payload = entry.payload(state);
          const before = yield* fingerprint;
          const without = yield* makeWsClient(ALL_SCOPES.filter((scope) => scope !== entry.scope));
          const denied = failureOf(yield* without.call(entry.method, payload));
          assert.strictEqual(denied?._tag, "EnvironmentAuthorizationError", entry.method);
          assert.strictEqual(yield* fingerprint, before, `${entry.method} changed state`);

          const only = yield* makeWsClient([entry.scope]);
          const id = yield* only.send(entry.method, payload);
          const allowed = yield* Queue.take(only.responses);
          assert.isNull(
            failureOf(allowed),
            `${entry.method}: ${JSON.stringify(failureOf(allowed))}`,
          );
          if (entry.method === WS_METHODS.houstonTasksSubscribe) yield* only.interrupt(id);
        }
      }),
    ),
  );
});

describe("tasks survive a restart", () => {
  it.effect("tasks, comments, history and the counter come back from the same file", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "houston-tasks-restart-" });
      const databaseFile = NodePath.join(dir, "state.sqlite");
      const before = yield* Effect.gen(function* () {
        const tasks = yield* HoustonTaskService.HoustonTaskService;
        const first = yield* tasks.save({ patch: { title: "Persisted", acceptance: ["kept"] } });
        yield* tasks.comment({ id: first.key, body: "remembered" });
        yield* tasks.save({ patch: { title: "Second" } });
        return yield* tasks.get({ id: first.key });
      }).pipe(Effect.provide(layerTasks({ databaseFile, baseDir: dir })));

      yield* Effect.gen(function* () {
        const tasks = yield* HoustonTaskService.HoustonTaskService;
        assert.deepEqual(yield* tasks.get({ id: "HOU-1" }), before);
        const snapshot = yield* Stream.take(tasks.subscribe({ scope: "all" }), 1).pipe(
          Stream.runCollect,
        );
        const first = snapshot[0];
        assert.isTrue(first !== undefined && "snapshot" in first);
        if (first !== undefined && "snapshot" in first) {
          assert.deepEqual(first.snapshot.tasks.map((task) => task.key).toSorted(), [
            "HOU-1",
            "HOU-2",
          ]);
        }
        assert.strictEqual((yield* tasks.save({ patch: { title: "Third" } })).key, "HOU-3");
      }).pipe(Effect.provide(layerTasks({ databaseFile, baseDir: dir })));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
