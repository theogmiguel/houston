// @effect-diagnostics nodeBuiltinImport:off - reads the database, trace and output folders back.
// The houston.transfer.* methods through the real `/ws` handlers and scope table, and the
// passphrase's absence from every file, log, trace and reply.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  AuthFilesystemReadScope,
  AuthFilesystemWriteScope,
  AuthOrchestrationReadScope,
  AuthSessionId,
  EnvironmentId,
  WS_METHODS,
  WsRpcGroup,
  type AuthEnvironmentScope,
} from "@t3tools/contracts";
import type {
  HoustonTransferExportSummary,
  HoustonTransferStreamEvent,
} from "@t3tools/contracts/houston/transfer";
import { makeLocalFileTracer } from "@t3tools/shared/observability";
import * as AcpRegistryRuntimeCoordinator from "@t3tools/provider-acp-registry/server/AcpRegistryRuntimeCoordinator";
import * as AcpRegistrySupport from "@t3tools/provider-acp-registry/server/AcpRegistrySupport";
import * as ProviderLatestVersions from "@t3tools/provider-core/server/ProviderLatestVersions";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Queue from "effect/Queue";
import * as Redacted from "effect/Redacted";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { Headers, HttpServerRequest, HttpServerResponse } from "effect/http";
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
import * as PullRequestService from "../../pullRequest/PullRequestService.ts";
import * as PullRequestSyncReactor from "../../orchestration-v2/PullRequestSyncReactor.ts";
import * as RemoteOpenTargets from "../../environment/RemoteOpenTargets.ts";
import * as ResourceTelemetry from "../../resourceTelemetry/ResourceTelemetry.ts";
import * as ReviewService from "../../review/ReviewService.ts";
import * as ScheduledTasks from "../../scheduledTasks/ScheduledTaskService.ts";
import * as ScratchThreadPromotion from "../../project/ScratchThreadPromotion.ts";
import * as SecretRequests from "../../secrets/SecretRequests.ts";
import * as ServerBrowser from "../../preview/ServerBrowser.ts";
import * as ServerConfig from "../../config.ts";
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
import * as HoustonMergeQueueService from "../mergeQueue/Service.ts";
import * as HoustonReviewState from "../reviewState.ts";
import { layerJsonWithoutEcho } from "../rpcSerialization.ts";
import * as HoustonTaskSourceService from "../taskSources/SourceService.ts";
import * as HoustonTaskSourceV1Import from "../taskSources/V1Import.ts";
import * as HoustonTaskRuns from "../tasks/TaskRuns.ts";
import * as HoustonTaskService from "../tasks/TaskService.ts";
import * as HoustonTaskV1Import from "../tasks/V1Import.ts";
import { TransferProbe } from "./probe.ts";
import {
  createProject,
  layerTransferTest,
  makeRepos,
  PASSPHRASE,
  seedThread,
  write,
  type TransferTestOptions,
} from "./transfer.testkit.ts";

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
  Layer.mock(HoustonMergeQueueService.HoustonMergeQueueService)({}),
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
    cookieName: "houston-transfer-test",
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
      environmentId: EnvironmentId.make("houston-transfer-test"),
      label: "Houston transfer test",
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
        sessionCookieName: "houston-transfer-test-session",
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
  AuthFilesystemReadScope,
  AuthFilesystemWriteScope,
];

const SESSION = {
  sessionId: AuthSessionId.make("houston-transfer-test"),
  subject: "houston-transfer-test",
  method: "browser-session-cookie" as const,
  scopes: [...ALL_SCOPES],
};

/** A `/ws` client of the real handlers, authorized by the real scope table. */
const makeWsClient = Effect.fn("makeWsClient")(function* (
  scopes: ReadonlyArray<AuthEnvironmentScope>,
) {
  const responses = yield* Queue.unbounded<unknown>();
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
        layerWsRpc({ ...SESSION, scopes: [...scopes] }, {}, browser),
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

/** Sends raw request bodies through the real RPC server and the `/ws` JSON serialization. */
const makeRawClient = Effect.fn("makeRawClient")(function* () {
  const browser = yield* ServerBrowser.ServerBrowser;
  const { protocol, httpEffect } = yield* RpcServer.makeProtocolWithHttpEffect();
  yield* RpcServer.make(WsRpcGroup, WS_RPC_SERVER_OPTIONS).pipe(
    Effect.provideService(RpcServer.Protocol, protocol),
    Effect.provide(
      Layer.merge(layerWsRpc(SESSION, {}, browser), RpcAuthorization.layer(ALL_SCOPES)),
    ),
    Effect.forkScoped,
  );
  return (body: string) =>
    httpEffect.pipe(
      Effect.provideService(
        HttpServerRequest.HttpServerRequest,
        HttpServerRequest.fromWeb(
          new Request("http://127.0.0.1/rpc", {
            method: "POST",
            body,
            headers: { "content-type": "application/json" },
          }),
        ),
      ),
      Effect.scoped,
      Effect.flatMap((response) => Effect.promise(() => HttpServerResponse.toWeb(response).text())),
    );
}, Effect.provide(layerJsonWithoutEcho));

const failureOf = (value: unknown) => {
  const exit = (value as { readonly failed?: Exit.Exit<unknown, unknown> } | undefined)?.failed;
  if (exit === undefined || !Exit.isFailure(exit)) return null;
  return Cause.squash(exit.cause) as {
    readonly _tag?: string;
    readonly kind?: string;
    readonly problem?: string;
  };
};

type ServerServices =
  | Layer.Success<typeof layerUnusedRpcServices>
  | Layer.Success<ReturnType<typeof layerTransferTest>>
  | Scope.Scope;

const layerServer = (options: TransferTestOptions) =>
  layerUnusedRpcServices.pipe(
    Layer.provideMerge(layerTransferTest({ workFactor: 10, ...options })),
  );

const withServer = <A, E>(
  body: Effect.Effect<A, E, ServerServices>,
  options: TransferTestOptions = {},
) =>
  body.pipe(
    Effect.provide(layerServer(options)),
    Effect.scoped,
    Effect.provide(NodeServices.layer),
  );

/** A project with one thread at a fresh checkout, and an empty output folder beside it. */
const project = (name: string) =>
  Effect.gen(function* () {
    const repos = makeRepos(`houston-transfer-ws-${name}-`);
    write(repos.checkout, "notes.txt", "untracked\n");
    const projectId = yield* createProject(name, repos.checkout);
    yield* seedThread({ threadId: `t-${name}`, projectId, title: `Thread ${name}` });
    const out = NodePath.join(repos.root, "out");
    NodeFS.mkdirSync(out);
    return { repos, projectId, out };
  });

describe("subscribe reports each stage in order", () => {
  it.effect("subscribe reports each stage in order", () =>
    withServer(
      Effect.gen(function* () {
        const { projectId, out } = yield* project("stages");
        const listener = yield* makeWsClient(ALL_SCOPES);
        const subscription = yield* listener.send(WS_METHODS.houstonTransferSubscribe, {});
        const first = (yield* Queue.take(listener.responses)) as HoustonTransferStreamEvent;
        assert.deepEqual(first, { type: "running", running: [] });

        // A subscriber that arrives while an export is held at packing sees it running.
        const reached = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        // The handlers run in the client's server fiber, so the probe goes where it is built.
        const client = yield* makeWsClient(ALL_SCOPES).pipe(
          Effect.provideService(TransferProbe, {
            ...TransferProbe.defaultValue(),
            onStage: (_operation, stage) =>
              stage === "packing"
                ? Deferred.succeed(reached, undefined).pipe(Effect.andThen(Deferred.await(release)))
                : Effect.void,
          }),
        );
        const exporting = yield* client
          .call(WS_METHODS.houstonTransferExport, {
            projectId,
            destination: NodePath.join(out, "move"),
            passphrase: Redacted.make(PASSPHRASE),
          })
          .pipe(Effect.forkScoped);
        yield* Deferred.await(reached);
        const late = yield* makeWsClient(ALL_SCOPES);
        const lateId = yield* late.send(WS_METHODS.houstonTransferSubscribe, {});
        assert.deepEqual(yield* Queue.take(late.responses), {
          type: "running",
          running: [{ operation: "export", projectId, stage: "packing" }],
        });
        yield* late.interrupt(lateId);
        yield* Deferred.succeed(release, undefined);
        const reply = yield* Fiber.join(exporting);
        assert.isNull(failureOf(reply), JSON.stringify(failureOf(reply)));

        const stages: Array<HoustonTransferStreamEvent> = [];
        for (let index = 0; index < 3; index += 1) {
          stages.push((yield* Queue.take(listener.responses)) as HoustonTransferStreamEvent);
        }
        assert.deepEqual(stages, [
          { type: "stage", operation: "export", projectId, stage: "checking" },
          { type: "stage", operation: "export", projectId, stage: "packing" },
          { type: "stage", operation: "export", projectId, stage: "done" },
        ]);
        yield* listener.interrupt(subscription);
      }),
    ),
  );
});

describe("each transfer method requires its declared scope", () => {
  it.effect("each transfer method requires its declared scope", () =>
    withServer(
      Effect.gen(function* () {
        const { projectId, out } = yield* project("scopes");
        const setup = yield* makeWsClient(ALL_SCOPES);
        const exported = (yield* setup.call(WS_METHODS.houstonTransferExport, {
          projectId,
          destination: NodePath.join(out, "setup"),
          passphrase: Redacted.make(PASSPHRASE),
        })) as HoustonTransferExportSummary;
        assert.isNull(failureOf(exported), JSON.stringify(failureOf(exported)));
        const sql = yield* SqlClient.SqlClient;
        const fingerprint = Effect.gen(function* () {
          const rows = yield* sql`SELECT * FROM houston_transfer_exports ORDER BY transfer_id`;
          return JSON.stringify([rows, NodeFS.readdirSync(out).toSorted()]);
        });
        let destinations = 0;
        const METHODS: ReadonlyArray<{
          readonly method: string;
          readonly scope: AuthEnvironmentScope;
          readonly payload: () => object;
          readonly stream?: boolean;
        }> = [
          {
            method: WS_METHODS.houstonTransferExport,
            scope: AuthFilesystemWriteScope,
            payload: () => {
              destinations += 1;
              return {
                projectId,
                destination: NodePath.join(out, `scoped-${destinations}`),
                passphrase: Redacted.make(PASSPHRASE),
              };
            },
          },
          {
            method: WS_METHODS.houstonTransferInspect,
            scope: AuthFilesystemReadScope,
            payload: () => ({ file: exported.file, passphrase: Redacted.make(PASSPHRASE) }),
          },
          {
            method: WS_METHODS.houstonTransferSubscribe,
            scope: AuthOrchestrationReadScope,
            payload: () => ({}),
            stream: true,
          },
        ];
        for (const entry of METHODS) {
          const before = yield* fingerprint;
          const without = yield* makeWsClient(ALL_SCOPES.filter((scope) => scope !== entry.scope));
          const denied = failureOf(yield* without.call(entry.method, entry.payload()));
          assert.strictEqual(denied?._tag, "EnvironmentAuthorizationError", entry.method);
          assert.strictEqual(yield* fingerprint, before, `${entry.method} changed state`);
          const only = yield* makeWsClient([entry.scope]);
          const id = yield* only.send(entry.method, entry.payload());
          const allowed = yield* Queue.take(only.responses);
          assert.isNull(
            failureOf(allowed),
            `${entry.method}: ${JSON.stringify(failureOf(allowed))}`,
          );
          if (entry.stream === true) yield* only.interrupt(id);
        }
      }),
    ),
  );
});

const exportRequest = (payload: unknown) =>
  JSON.stringify({
    _tag: "Request",
    id: "1",
    tag: WS_METHODS.houstonTransferExport,
    payload,
    headers: [],
  });

describe("a malformed export never echoes the passphrase", () => {
  it.effect("a malformed export never echoes the passphrase", () =>
    withServer(
      Effect.gen(function* () {
        const { projectId, out } = yield* project("echo");
        const destination = NodePath.join(out, "echo");
        const raw = yield* makeRawClient();
        const bodies = [
          exportRequest({ projectId, destination, [PASSPHRASE]: PASSPHRASE }),
          exportRequest({ projectId, destination, passphrase: PASSPHRASE, overwrite: PASSPHRASE }),
          exportRequest({ projectId: PASSPHRASE, destination: 7, passphrase: PASSPHRASE }),
          exportRequest({ projectId, destination, passphrase: PASSPHRASE }).slice(0, -12),
          PASSPHRASE,
          `${PASSPHRASE}"}`,
        ];
        for (const body of bodies) {
          const answer = yield* raw(body);
          assert.isNotEmpty(answer, body);
          assert.notInclude(answer, PASSPHRASE, body);
          assert.notInclude(answer, PASSPHRASE.slice(0, 12), body);
          assert.notInclude(answer, "transferId", body);
        }
        assert.deepEqual(NodeFS.readdirSync(out), []);
        const ok = yield* raw(exportRequest({ projectId, destination, passphrase: PASSPHRASE }));
        assert.include(ok, "transferId");
        assert.notInclude(ok, PASSPHRASE);
      }),
    ),
  );
});

describe("the passphrase reaches no file, log, trace or reply", () => {
  it.effect("the passphrase reaches no file, log, trace or reply", () => {
    const logs: Array<string> = [];
    const logger = Logger.make((options) => {
      logs.push(`${String(options.message)} ${Cause.pretty(options.cause)}`);
    });
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "houston-transfer-leak-" });
      const databaseFile = NodePath.join(dir, "state.sqlite");
      const replies: Array<unknown> = [];
      // The tracer flushes its file when its scope closes, before the files are read.
      const trace = yield* Effect.scoped(
        Effect.gen(function* () {
          const config = yield* ServerConfig.ServerConfig;
          const tracer = yield* makeLocalFileTracer({
            filePath: config.serverTracePath,
            maxBytes: 4 * 1024 * 1024,
            maxFiles: 2,
            batchWindowMs: 10,
          });
          yield* Effect.gen(function* () {
            const { projectId, out } = yield* project("leak");
            const client = yield* makeWsClient(ALL_SCOPES);
            const listener = yield* makeWsClient(ALL_SCOPES);
            const subscription = yield* listener.send(WS_METHODS.houstonTransferSubscribe, {});
            replies.push(yield* Queue.take(listener.responses));
            const exported = (yield* client.call(WS_METHODS.houstonTransferExport, {
              projectId,
              destination: NodePath.join(out, "leak"),
              passphrase: Redacted.make(PASSPHRASE),
            })) as HoustonTransferExportSummary;
            assert.isNull(failureOf(exported), JSON.stringify(failureOf(exported)));
            replies.push(exported);
            const calls: ReadonlyArray<readonly [string, object, boolean]> = [
              [
                WS_METHODS.houstonTransferInspect,
                { file: exported.file, passphrase: Redacted.make(PASSPHRASE) },
                true,
              ],
              [
                WS_METHODS.houstonTransferInspect,
                { file: exported.file, passphrase: Redacted.make(`${PASSPHRASE}-wrong`) },
                false,
              ],
              [
                WS_METHODS.houstonTransferExport,
                {
                  projectId,
                  destination: NodePath.join(out, "leak"),
                  passphrase: Redacted.make(PASSPHRASE),
                },
                false,
              ],
              [
                WS_METHODS.houstonTransferExport,
                {
                  projectId,
                  destination: NodePath.join(out, "short"),
                  passphrase: Redacted.make(PASSPHRASE.slice(0, 11)),
                },
                false,
              ],
            ];
            for (const [method, payload, succeeds] of calls) {
              const reply = yield* client.call(method, payload);
              assert.strictEqual(failureOf(reply) === null, succeeds, method);
              replies.push(failureOf(reply) ?? reply);
              yield* Effect.logWarning(`called ${method}`);
            }
            // checking, packing and done of the export reached the subscriber.
            for (let index = 0; index < 3; index += 1) {
              replies.push(yield* Queue.take(listener.responses));
            }
            yield* listener.interrupt(subscription);
          }).pipe(Effect.withTracer(tracer));
          return config.serverTracePath;
        }),
      ).pipe(Effect.provide(layerServer({ databaseFile, baseDir: dir })));

      const needles = [Buffer.from(PASSPHRASE, "utf8"), Buffer.from(PASSPHRASE.slice(0, 11))];
      assert.isTrue(NodeFS.existsSync(trace), "the trace file was written");
      assert.isNotEmpty(NodeFS.readFileSync(trace, "utf8"));
      for (const file of [databaseFile, `${databaseFile}-wal`, trace]) {
        if (!NodeFS.existsSync(file)) continue;
        for (const needle of needles) {
          assert.isFalse(NodeFS.readFileSync(file).includes(needle), file);
        }
      }
      assert.isNotEmpty(logs);
      assert.notInclude(logs.join("\n"), PASSPHRASE.slice(0, 11));
      assert.lengthOf(replies, 9);
      assert.notInclude(JSON.stringify(replies), PASSPHRASE.slice(0, 11));
    }).pipe(
      Effect.provide(Logger.layer([logger])),
      Effect.scoped,
      Effect.provide(NodeServices.layer),
    );
  });
});
