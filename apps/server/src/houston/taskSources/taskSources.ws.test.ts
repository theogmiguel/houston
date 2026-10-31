// @effect-diagnostics nodeBuiltinImport:off - reads the database, trace and secrets files.
// The houston.taskSources.* methods through the real `/ws` handlers and scope table, and the
// token's absence from every file, log, trace and reply.
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
  HoustonTaskSourceLink,
  HoustonTaskSourceSettings,
  HoustonTaskSourceStreamEvent,
} from "@t3tools/contracts/houston/taskSources";
import { makeLocalFileTracer } from "@t3tools/shared/observability";
import * as AcpRegistryRuntimeCoordinator from "@t3tools/provider-acp-registry/server/AcpRegistryRuntimeCoordinator";
import * as AcpRegistrySupport from "@t3tools/provider-acp-registry/server/AcpRegistrySupport";
import * as ProviderLatestVersions from "@t3tools/provider-core/server/ProviderLatestVersions";
import * as Cause from "effect/Cause";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { Headers, HttpServerRequest, HttpServerResponse } from "effect/http";
import * as Logger from "effect/Logger";
import * as Redacted from "effect/Redacted";
import * as SqlClient from "effect/sql/SqlClient";
import { RpcMessage, RpcServer } from "effect/rpc";
import * as TestClock from "effect/testing/TestClock";

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
import * as ServerConfig from "../../config.ts";
import { layerJsonWithoutEcho } from "../rpcSerialization.ts";
import * as HoustonReviewState from "../reviewState.ts";
import * as HoustonTaskRuns from "../tasks/TaskRuns.ts";
import * as HoustonMergeQueueService from "../mergeQueue/Service.ts";
import * as HoustonHarnessService from "../harnessReview/Service.ts";
import * as HoustonTaskService from "../tasks/TaskService.ts";
import { createProject } from "../tasks/tasks.testkit.ts";
import { makeMemory } from "../secrets/HoustonKeychain.ts";
import { HoustonTaskSourceOutboxDrain } from "./Outbox.ts";
import {
  githubIssue,
  issuePages,
  layerSources,
  makeGithubFake,
  makeNotionFake,
  notionPage,
  notionServes,
  notionSettings,
  type SourcesTestOptions,
} from "./taskSources.testkit.ts";

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
  Layer.mock(HoustonTaskRuns.HoustonTaskRuns)({}),
  Layer.mock(HoustonMergeQueueService.HoustonMergeQueueService)({}),
  Layer.mock(HoustonHarnessService.HoustonHarnessService)({}),
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
    cookieName: "houston-sources-test",
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
      environmentId: EnvironmentId.make("houston-sources-test"),
      label: "Houston sources test",
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
        sessionCookieName: "houston-sources-test-session",
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
            sessionId: AuthSessionId.make("houston-sources-test"),
            subject: "houston-sources-test",
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
  | Layer.Success<ReturnType<typeof layerSources>>
  | Scope.Scope;

const layerServer = (options: SourcesTestOptions) =>
  layerUnusedRpcServices.pipe(Layer.provideMerge(layerSources(options)));

const TOKEN = "ntn_ws_secret_token_9f3e2a71";

const SESSION = {
  sessionId: AuthSessionId.make("houston-sources-test"),
  subject: "houston-sources-test",
  method: "browser-session-cookie" as const,
  scopes: [...ALL_SCOPES],
};

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

const credentialRequest = (payload: unknown) =>
  JSON.stringify({
    _tag: "Request",
    id: "1",
    tag: WS_METHODS.houstonTaskSourcesCredentialSet,
    payload,
    headers: [],
  });

const withServer = <A, E>(
  body: Effect.Effect<A, E, ServerServices>,
  options: SourcesTestOptions = {},
) =>
  body.pipe(
    Effect.provide(layerServer(options)),
    Effect.scoped,
    Effect.provide(NodeServices.layer),
  );

describe("a malformed credential request never echoes the token", () => {
  it.effect("a malformed credential request never echoes the token", () =>
    withServer(
      Effect.gen(function* () {
        const projectId = yield* createProject("echo");
        const raw = yield* makeRawClient();
        const bodies = [
          credentialRequest({ projectId, provider: "slack", token: TOKEN }),
          credentialRequest({ projectId, provider: TOKEN, token: TOKEN }),
          credentialRequest({ provider: "notion", token: TOKEN }),
          credentialRequest({ projectId, provider: "notion", token: TOKEN }).slice(0, -12),
          TOKEN,
          `${TOKEN}"}`,
        ];
        for (const body of bodies) {
          const answer = yield* raw(body);
          assert.isNotEmpty(answer, body);
          assert.notInclude(answer, TOKEN, body);
          assert.notInclude(answer, TOKEN.slice(0, 10), body);
          assert.notInclude(answer, "hasCredential", body);
        }
        const ok = yield* raw(credentialRequest({ projectId, provider: "notion", token: TOKEN }));
        assert.include(ok, "hasCredential");
        assert.notInclude(ok, TOKEN);
      }),
    ),
  );
});

describe("the token reaches no file, log, trace or reply", () => {
  it.effect("the token reaches no file, log, trace or reply", () => {
    const logs: Array<string> = [];
    const logger = Logger.make((options) => {
      logs.push(`${String(options.message)} ${Cause.pretty(options.cause)}`);
    });
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "houston-sources-leak-" });
      const databaseFile = NodePath.join(dir, "state.sqlite");
      const notion = yield* makeNotionFake;
      notionServes(notion, () => [notionPage(1), notionPage(2)]);
      const replies: Array<unknown> = [];
      // The tracer flushes its file when its scope closes, before the files are read.
      const paths = yield* Effect.scoped(
        Effect.gen(function* () {
          const config = yield* ServerConfig.ServerConfig;
          const tracer = yield* makeLocalFileTracer({
            filePath: config.serverTracePath,
            maxBytes: 4 * 1024 * 1024,
            maxFiles: 2,
            batchWindowMs: 10,
          });
          yield* Effect.gen(function* () {
            const projectId = yield* createProject("leak");
            const client = yield* makeWsClient(ALL_SCOPES);
            const listener = yield* makeWsClient(ALL_SCOPES);
            const subscription = yield* listener.send(WS_METHODS.houstonTaskSourcesSubscribe, {
              projectId,
            });
            replies.push(yield* Queue.take(listener.responses));
            const calls: ReadonlyArray<readonly [string, object]> = [
              [
                WS_METHODS.houstonTaskSourcesCredentialSet,
                { projectId, provider: "notion", token: Redacted.make(TOKEN) },
              ],
              [
                WS_METHODS.houstonTaskSourcesSettingsSet,
                { projectId, provider: "notion", settings: notionSettings() },
              ],
              [WS_METHODS.houstonTaskSourcesSyncNow, { projectId }],
              [WS_METHODS.houstonTaskSourcesSettingsGet, { projectId }],
              [WS_METHODS.houstonTaskSourcesLinksGet, { taskId: "HOU-1" }],
              [WS_METHODS.houstonTaskSourcesCredentialClear, { projectId, provider: "notion" }],
              [WS_METHODS.houstonTaskSourcesSyncNow, { projectId }],
            ];
            for (const [method, payload] of calls) {
              const reply = yield* client.call(method, payload);
              assert.isNull(failureOf(reply), `${method}: ${JSON.stringify(failureOf(reply))}`);
              replies.push(reply);
              yield* Effect.logWarning(`called ${method}`);
            }
            // Two links events and two state events reached the subscriber.
            for (let index = 0; index < 4; index += 1) {
              replies.push(yield* Queue.take(listener.responses));
            }
            yield* listener.interrupt(subscription);
            assert.isTrue(
              notion.requests.some((entry) => entry.authorization === `Bearer ${TOKEN}`),
            );
          }).pipe(Effect.withTracer(tracer));
          return { trace: config.serverTracePath, secrets: config.secretsDir };
        }),
      ).pipe(
        Effect.provide(
          layerServer({
            databaseFile,
            baseDir: dir,
            notionOrigin: notion.origin,
            keychain: makeMemory(),
          }),
        ),
      );

      const needle = Buffer.from(TOKEN, "utf8");
      const secrets = NodeFS.existsSync(paths.secrets)
        ? NodeFS.readdirSync(paths.secrets, { recursive: true, withFileTypes: true })
            .filter((entry) => entry.isFile())
            .map((entry) => NodePath.join(entry.parentPath, entry.name))
        : [];
      assert.isTrue(NodeFS.existsSync(paths.trace), "the trace file was written");
      assert.isNotEmpty(NodeFS.readFileSync(paths.trace, "utf8"));
      for (const file of [databaseFile, `${databaseFile}-wal`, paths.trace, ...secrets]) {
        if (!NodeFS.existsSync(file)) continue;
        assert.isFalse(NodeFS.readFileSync(file).includes(needle), file);
      }
      assert.isNotEmpty(logs);
      assert.notInclude(logs.join("\n"), TOKEN);
      assert.lengthOf(replies, 12);
      assert.notInclude(JSON.stringify(replies), TOKEN);
    }).pipe(
      Effect.provide(Logger.layer([logger])),
      Effect.scoped,
      Effect.provide(NodeServices.layer),
    );
  });

  it.effect("write-back errors, retries and outbox rows carry no token", () => {
    const logs: Array<string> = [];
    const logger = Logger.make((options) => {
      logs.push(`${String(options.message)} ${Cause.pretty(options.cause)}`);
    });
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "houston-sources-writeback-leak-" });
      const databaseFile = NodePath.join(dir, "state.sqlite");
      const notion = yield* makeNotionFake;
      // The page edit fails twice with an answer that echoes the bearer, then succeeds.
      let failures = 2;
      notionServes(notion, () => [notionPage(1)], {
        extra: (request) => {
          if (request.method !== "PATCH") return null;
          if (failures > 0) {
            failures -= 1;
            return {
              status: 500,
              body: { message: `bad gateway for ${request.authorization ?? ""}` },
            };
          }
          return { body: notionPage(1) };
        },
      });
      const rows = yield* Effect.gen(function* () {
        const projectId = yield* createProject("writeback-leak");
        const client = yield* makeWsClient(ALL_SCOPES);
        for (const [method, payload] of [
          [
            WS_METHODS.houstonTaskSourcesCredentialSet,
            { projectId, provider: "notion", token: Redacted.make(TOKEN) },
          ],
          [
            WS_METHODS.houstonTaskSourcesSettingsSet,
            { projectId, provider: "notion", settings: notionSettings() },
          ],
          [WS_METHODS.houstonTaskSourcesSyncNow, { projectId }],
        ] as const) {
          const reply = yield* client.call(method, payload);
          assert.isNull(failureOf(reply), `${method}: ${JSON.stringify(failureOf(reply))}`);
        }
        // The imported page becomes a delivery the user moves on: one status write-back.
        const tasks = yield* HoustonTaskService.HoustonTaskService;
        const imported = (yield* tasks.get({ id: "HOU-1" })).task;
        yield* tasks.saveDomain({
          id: imported.key,
          expectedRevision: imported.revision,
          kind: "delivery",
        });
        const placed = (yield* tasks.get({ id: "HOU-1" })).task;
        yield* tasks.save({
          id: placed.key,
          expectedRevision: placed.revision,
          patch: { status: "in_progress" },
        });
        const drain = (yield* HoustonTaskSourceOutboxDrain).drain;
        yield* drain;
        yield* TestClock.adjust(Duration.seconds(1));
        yield* drain;
        yield* TestClock.adjust(Duration.seconds(2));
        yield* drain;
        const sql = yield* SqlClient.SqlClient;
        const outbox = yield* sql<{
          readonly attempts: number;
          readonly receipt_json: string | null;
        }>`SELECT attempts, receipt_json FROM houston_task_source_outbox`;
        const links = yield* client.call(WS_METHODS.houstonTaskSourcesLinksGet, {
          taskId: "HOU-1",
        });
        assert.notInclude(JSON.stringify(links), TOKEN);
        return outbox;
      }).pipe(
        Effect.provide(
          layerServer({
            databaseFile,
            baseDir: dir,
            notionOrigin: notion.origin,
            keychain: makeMemory(),
          }),
        ),
      );

      // Two failed attempts and a retry that went through.
      assert.lengthOf(rows, 1);
      assert.strictEqual(rows[0]?.attempts, 2);
      assert.isNotNull(rows[0]?.receipt_json);
      const patches = notion.requests.filter((request) => request.method === "PATCH");
      assert.lengthOf(patches, 3);
      assert.isTrue(patches.every((request) => request.authorization === `Bearer ${TOKEN}`));
      const needle = Buffer.from(TOKEN, "utf8");
      for (const file of [databaseFile, `${databaseFile}-wal`]) {
        if (!NodeFS.existsSync(file)) continue;
        assert.isFalse(NodeFS.readFileSync(file).includes(needle), file);
      }
      assert.isTrue(logs.some((line) => line.includes("HTTP 500")));
      assert.notInclude(logs.join("\n"), TOKEN);
    }).pipe(
      Effect.provide(Logger.layer([logger])),
      Effect.scoped,
      Effect.provide(NodeServices.layer),
    );
  });
});

const GITHUB_SETTINGS = {
  enabled: true,
  githubRepository: "octo-org/project",
  githubLabel: "import",
};

describe("links come back with their sync state", () => {
  it.effect("links come back with their sync state", () => {
    const github = makeGithubFake();
    issuePages(github, () => [githubIssue(1)]);
    return withServer(
      Effect.gen(function* () {
        const projectId = yield* createProject("links");
        const client = yield* makeWsClient(ALL_SCOPES);
        yield* client.call(WS_METHODS.houstonTaskSourcesSettingsSet, {
          projectId,
          provider: "github_issues",
          settings: GITHUB_SETTINGS,
        });
        yield* client.call(WS_METHODS.houstonTaskSourcesSyncNow, { projectId });
        const sql = yield* SqlClient.SqlClient;
        yield* sql`
          INSERT INTO houston_task_source_links (
            task_id, project_id, provider, external_id, source, url, snapshot_json, sync_state_json
          ) VALUES (
            1, ${projectId}, 'github_issues', 'https://github.com/octo-org/project/pull/9',
            'pull_request', 'https://github.com/octo-org/project/pull/9',
            '{"base":{},"local":{},"remote":{},"conflicts":[],"revision":1,"projectExternalId":null,"project":null}',
            '{"state":"current"}'
          )
        `;
        const links = (yield* client.call(WS_METHODS.houstonTaskSourcesLinksGet, {
          taskId: "HOU-1",
        })) as ReadonlyArray<HoustonTaskSourceLink>;
        assert.deepEqual(
          links.map((link) => [link.provider, link.externalId, link.source, link.syncState.state]),
          [
            [
              "github_issues",
              "https://github.com/octo-org/project/pull/9",
              "pull_request",
              "current",
            ],
            ["github_issues", "octo-org/project#1", "source", "current"],
          ],
        );
        const source = links.find((link) => link.source === "source");
        assert.strictEqual(source?.url, "https://github.com/octo-org/project/issues/1");
        assert.isString(source?.fetchedAt);
        assert.isString(source?.syncedAt);
        assert.deepEqual(source?.snapshot.conflicts, []);
        assert.strictEqual(source?.snapshot.remote.title, "Issue 1");
        const missing = failureOf(
          yield* client.call(WS_METHODS.houstonTaskSourcesLinksGet, { taskId: "HOU-404" }),
        );
        assert.strictEqual(missing?.kind, "not_found");
        assert.include(missing?.message ?? "", "HOU-404");
      }),
      { github },
    );
  });
});

describe("subscribe sends settings then each state and link change", () => {
  it.effect("subscribe sends settings then each state and link change", () => {
    const github = makeGithubFake();
    let issues = [githubIssue(1), githubIssue(2)];
    issuePages(github, () => issues);
    return withServer(
      Effect.gen(function* () {
        const projectId = yield* createProject("subscribed");
        const other = yield* createProject("elsewhere");
        const client = yield* makeWsClient(ALL_SCOPES);
        for (const target of [projectId, other]) {
          yield* client.call(WS_METHODS.houstonTaskSourcesSettingsSet, {
            projectId: target,
            provider: "github_issues",
            settings: GITHUB_SETTINGS,
          });
        }
        const listener = yield* makeWsClient(ALL_SCOPES);
        const subscription = yield* listener.send(WS_METHODS.houstonTaskSourcesSubscribe, {
          projectId,
        });
        const first = (yield* Queue.take(listener.responses)) as HoustonTaskSourceStreamEvent;
        assert.isTrue("snapshot" in first);
        if ("snapshot" in first) {
          assert.deepEqual(
            first.snapshot.settings.map((entry) => [entry.provider, entry.enabled]),
            [
              ["github_issues", true],
              ["notion", false],
            ],
          );
        }
        yield* client.call(WS_METHODS.houstonTaskSourcesSyncNow, { projectId });
        // Another project's poll reaches its own subscribers only.
        yield* client.call(WS_METHODS.houstonTaskSourcesSyncNow, { projectId: other });
        issues = [githubIssue(1, { title: "Renamed" }), githubIssue(2)];
        yield* client.call(WS_METHODS.houstonTaskSourcesSyncNow, { projectId });
        const events: Array<string> = [];
        for (let index = 0; index < 5; index += 1) {
          const event = (yield* Queue.take(listener.responses)) as HoustonTaskSourceStreamEvent;
          events.push(
            "links" in event
              ? `links ${event.links.taskId}`
              : "state" in event
                ? `state ${event.state.provider} ${event.state.error}`
                : "snapshot",
          );
        }
        assert.deepEqual(events, [
          "links 1",
          "links 2",
          "state github_issues null",
          "links 1",
          "state github_issues null",
        ]);
        assert.strictEqual(yield* Queue.size(listener.responses), 0);
        yield* listener.interrupt(subscription);
      }),
      { github },
    );
  });
});

describe("each method requires its declared scope", () => {
  it.effect("each method requires its declared scope", () => {
    const github = makeGithubFake();
    let remoteTitle = "Issue 1";
    issuePages(github, () => [githubIssue(1, { title: remoteTitle })]);
    return withServer(
      Effect.gen(function* () {
        const read = yield* makeWsClient(ALL_SCOPES);
        const projectId = yield* createProject("scoped");
        const tasks = yield* HoustonTaskService.HoustonTaskService;
        const sql = yield* SqlClient.SqlClient;
        const fingerprint = Effect.all([
          sql`SELECT * FROM houston_task_source_settings`,
          sql`SELECT project_id, provider, cursor_json, last_error FROM houston_task_source_poll`,
          sql`SELECT * FROM houston_task_source_links`,
          sql`SELECT * FROM houston_task_source_import`,
          sql`SELECT id, revision, title FROM houston_tasks`,
        ]).pipe(Effect.map((rows) => JSON.stringify(rows)));
        const resolvePayload = Effect.gen(function* () {
          const detail = yield* tasks.get({ id: "HOU-1" });
          const [link] = yield* sql<{ readonly snapshot_json: string }>`
            SELECT snapshot_json FROM houston_task_source_links WHERE task_id = 1
          `;
          return {
            taskId: "HOU-1",
            expectedTaskRevision: detail.task.revision,
            provider: "github_issues",
            externalId: "octo-org/project#1",
            field: "title",
            expectedLinkRevision: Number(/"revision":(\d+)/.exec(link?.snapshot_json ?? "")?.[1]),
            resolution: "local",
          };
        });
        const methods: ReadonlyArray<{
          readonly method: string;
          readonly scope: AuthEnvironmentScope;
          readonly payload: () => Effect.Effect<object, never, ServerServices>;
        }> = [
          {
            method: WS_METHODS.houstonTaskSourcesImportV1Status,
            scope: AuthOrchestrationReadScope,
            payload: () => Effect.succeed({}),
          },
          {
            method: WS_METHODS.houstonTaskSourcesSettingsGet,
            scope: AuthOrchestrationReadScope,
            payload: () => Effect.succeed({ projectId }),
          },
          {
            method: WS_METHODS.houstonTaskSourcesSettingsSet,
            scope: AuthSettingsWriteScope,
            payload: () =>
              Effect.succeed({ projectId, provider: "github_issues", settings: GITHUB_SETTINGS }),
          },
          {
            method: WS_METHODS.houstonTaskSourcesCredentialSet,
            scope: AuthSettingsWriteScope,
            payload: () =>
              Effect.succeed({ projectId, provider: "notion", token: Redacted.make(TOKEN) }),
          },
          {
            method: WS_METHODS.houstonTaskSourcesCredentialClear,
            scope: AuthSettingsWriteScope,
            payload: () => Effect.succeed({ projectId, provider: "notion" }),
          },
          {
            method: WS_METHODS.houstonTaskSourcesSyncNow,
            scope: AuthOrchestrationOperateScope,
            payload: () => Effect.succeed({ projectId }),
          },
          {
            method: WS_METHODS.houstonTaskSourcesLinksGet,
            scope: AuthOrchestrationReadScope,
            payload: () => Effect.succeed({ taskId: "HOU-1" }),
          },
          {
            method: WS_METHODS.houstonTaskSourcesConflictResolve,
            scope: AuthOrchestrationOperateScope,
            payload: () =>
              Effect.gen(function* () {
                // A local title edit and a remote rename make the conflict to resolve.
                const detail = yield* tasks.get({ id: "HOU-1" });
                yield* tasks.save({
                  id: "HOU-1",
                  expectedRevision: detail.task.revision,
                  patch: { title: "Local" },
                });
                remoteTitle = "Remote";
                yield* read.call(WS_METHODS.houstonTaskSourcesSyncNow, { projectId });
                return yield* resolvePayload;
              }).pipe(Effect.orDie),
          },
          {
            method: WS_METHODS.houstonTaskSourcesSubscribe,
            scope: AuthOrchestrationReadScope,
            payload: () => Effect.succeed({ projectId }),
          },
        ];
        for (const entry of methods) {
          const payload = yield* entry.payload();
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
          if (entry.method === WS_METHODS.houstonTaskSourcesSubscribe) yield* only.interrupt(id);
        }
        // importV1.run: refused without its scope; with it, it reaches the import (no v1 here).
        const without = yield* makeWsClient([
          AuthOrchestrationReadScope,
          AuthOrchestrationOperateScope,
        ]);
        const before = yield* fingerprint;
        assert.strictEqual(
          failureOf(yield* without.call(WS_METHODS.houstonTaskSourcesImportV1Run, {}))?._tag,
          "EnvironmentAuthorizationError",
        );
        assert.strictEqual(yield* fingerprint, before);
        const only = yield* makeWsClient([AuthSettingsWriteScope]);
        assert.strictEqual(
          failureOf(yield* only.call(WS_METHODS.houstonTaskSourcesImportV1Run, {}))?._tag,
          "HoustonTaskSourceError",
        );
      }),
      { github },
    );
  });
});

describe("an unknown project is refused naming it", () => {
  it.effect("an unknown project is refused naming it", () =>
    withServer(
      Effect.gen(function* () {
        const client = yield* makeWsClient(ALL_SCOPES);
        const projectId = "project-missing";
        const calls: ReadonlyArray<readonly [string, object]> = [
          [WS_METHODS.houstonTaskSourcesSettingsGet, { projectId }],
          [
            WS_METHODS.houstonTaskSourcesSettingsSet,
            { projectId, provider: "github_issues", settings: { enabled: false } },
          ],
          [
            WS_METHODS.houstonTaskSourcesCredentialSet,
            { projectId, provider: "notion", token: Redacted.make(TOKEN) },
          ],
          [WS_METHODS.houstonTaskSourcesCredentialClear, { projectId, provider: "notion" }],
          [WS_METHODS.houstonTaskSourcesSyncNow, { projectId }],
          [WS_METHODS.houstonTaskSourcesSubscribe, { projectId }],
        ];
        for (const [method, payload] of calls) {
          const refused = failureOf(yield* client.call(method, payload));
          assert.strictEqual(refused?.kind, "not_found", method);
          assert.include(refused?.message ?? "", projectId, method);
          assert.notInclude(refused?.message ?? "", TOKEN, method);
        }
      }),
    ),
  );
});

describe("sources survive a restart", () => {
  it.effect("sources survive a restart", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "houston-sources-restart-" });
      const github = makeGithubFake();
      issuePages(github, () => [githubIssue(1)]);
      const options: SourcesTestOptions = {
        databaseFile: NodePath.join(dir, "state.sqlite"),
        baseDir: dir,
        keychain: makeMemory(),
        github,
      };
      const read = Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        return JSON.stringify(
          yield* Effect.all([
            sql`SELECT * FROM houston_task_source_settings`,
            sql`SELECT * FROM houston_task_source_poll`,
            sql`SELECT * FROM houston_task_source_links`,
            sql`SELECT * FROM houston_task_source_identity`,
          ]),
        );
      });
      const before = yield* Effect.gen(function* () {
        const projectId = yield* createProject("restart", "/work/restart");
        const client = yield* makeWsClient(ALL_SCOPES);
        yield* client.call(WS_METHODS.houstonTaskSourcesSettingsSet, {
          projectId,
          provider: "github_issues",
          settings: GITHUB_SETTINGS,
        });
        yield* client.call(WS_METHODS.houstonTaskSourcesSyncNow, { projectId });
        // Disabled before the reopen, so the reopened server's loop does not poll it.
        yield* client.call(WS_METHODS.houstonTaskSourcesSettingsSet, {
          projectId,
          provider: "github_issues",
          settings: { ...GITHUB_SETTINGS, enabled: false },
        });
        const sql = yield* SqlClient.SqlClient;
        yield* sql`INSERT INTO houston_task_source_identity (id, namespace) VALUES (1, 'feedface')`;
        return yield* read;
      }).pipe(Effect.provide(layerServer(options)));
      assert.include(before, "octo-org/project#1");
      yield* Effect.gen(function* () {
        assert.strictEqual(yield* read, before);
        const client = yield* makeWsClient(ALL_SCOPES);
        const settings = (yield* client.call(WS_METHODS.houstonTaskSourcesSettingsGet, {
          projectId: "project-restart",
        })) as ReadonlyArray<HoustonTaskSourceSettings>;
        assert.strictEqual(settings[0]?.githubRepository, "octo-org/project");
        assert.strictEqual(settings[0]?.revision, 2);
        assert.isString(settings[0]?.lastSyncAt);
        const links = (yield* client.call(WS_METHODS.houstonTaskSourcesLinksGet, {
          taskId: "HOU-1",
        })) as ReadonlyArray<HoustonTaskSourceLink>;
        assert.lengthOf(links, 1);
      }).pipe(Effect.provide(layerServer(options)));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
