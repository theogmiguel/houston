// @effect-diagnostics nodeBuiltinImport:off - reads the database, trace and secrets files.
// The houston.slack.* methods through the real `/ws` handlers and scope table, and the tokens'
// absence from every file, log, trace, reply and stream event, Socket Mode errors included.
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
  ProjectId,
  WS_METHODS,
  WsRpcGroup,
  type AuthEnvironmentScope,
} from "@t3tools/contracts";
import type {
  HoustonSlackInfo,
  HoustonSlackRequest,
  HoustonSlackStreamEvent,
} from "@t3tools/contracts/houston/slack";
import { makeLocalFileTracer } from "@t3tools/shared/observability";
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
import { Headers, HttpServerRequest, HttpServerResponse } from "effect/http";
import * as Logger from "effect/Logger";
import * as Redacted from "effect/Redacted";
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
import { makeMemory } from "../secrets/HoustonKeychain.ts";
import * as HoustonTaskSourceService from "../taskSources/SourceService.ts";
import * as HoustonTaskSourceV1Import from "../taskSources/V1Import.ts";
import { createProject } from "../tasks/tasks.testkit.ts";
import { HoustonSlackOutbox } from "./Outbox.ts";
import { makeSlackFake, mentionEnvelope, mentionEvent, type SlackFake } from "./slack.fake.ts";
import {
  APP_TOKEN,
  BOT_TOKEN,
  OWNER,
  advance,
  layerSlackTest,
  realTurn,
  until,
  untilAdvancing,
  type SlackTestOptions,
} from "./slack.testkit.ts";

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
    cookieName: "houston-slack-test",
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
      environmentId: EnvironmentId.make("houston-slack-test"),
      label: "Houston slack test",
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
        sessionCookieName: "houston-slack-test-session",
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
            sessionId: AuthSessionId.make("houston-slack-test"),
            subject: "houston-slack-test",
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
  | Layer.Success<ReturnType<typeof layerSlackTest>>
  | Scope.Scope;

const layerServer = (options: SlackTestOptions) =>
  layerUnusedRpcServices.pipe(Layer.provideMerge(layerSlackTest(options)));

const withServer = <A, E>(
  body: (fake: SlackFake) => Effect.Effect<A, E, ServerServices>,
  options: Omit<SlackTestOptions, "slackOrigin"> = {},
) =>
  Effect.gen(function* () {
    const fake = yield* makeSlackFake;
    return yield* body(fake).pipe(
      Effect.provide(layerServer({ ...options, slackOrigin: fake.origin })),
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

const SESSION = {
  sessionId: AuthSessionId.make("houston-slack-test"),
  subject: "houston-slack-test",
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

const connectRequest = (payload: unknown) =>
  JSON.stringify({
    _tag: "Request",
    id: "1",
    tag: WS_METHODS.houstonSlackConnect,
    payload,
    headers: [],
  });

const TOKENS = { appToken: Redacted.make(APP_TOKEN), botToken: Redacted.make(BOT_TOKEN) };

describe("a malformed connect never echoes a token", () => {
  it.effect("a malformed connect never echoes a token", () =>
    withServer(() =>
      Effect.gen(function* () {
        const raw = yield* makeRawClient();
        const bodies = [
          connectRequest({ appToken: APP_TOKEN, [BOT_TOKEN]: true }),
          connectRequest({
            appToken: APP_TOKEN,
            botToken: BOT_TOKEN,
            extra: { BOT_TOKEN },
          }).replace('"extra"', `"${BOT_TOKEN}"`),
          connectRequest({ appToken: 42, botToken: BOT_TOKEN }),
          connectRequest({ appToken: APP_TOKEN, botToken: BOT_TOKEN }).slice(0, -12),
          `${APP_TOKEN}"}`,
          BOT_TOKEN,
        ];
        for (const body of bodies) {
          const answer = yield* raw(body);
          assert.isNotEmpty(answer, body);
          for (const token of [APP_TOKEN, BOT_TOKEN]) {
            assert.notInclude(answer, token, body);
            assert.notInclude(answer, token.slice(0, 14), body);
          }
        }
      }),
    ),
  );
});

describe("slack tokens reach no file, log, trace or reply", () => {
  it.effect("slack tokens reach no file, log, trace or reply", () => {
    const logs: Array<string> = [];
    const logger = Logger.make((options) => {
      logs.push(`${String(options.message)} ${Cause.pretty(options.cause)}`);
    });
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "houston-slack-leak-" });
      const databaseFile = NodePath.join(dir, "state.sqlite");
      const fake = yield* makeSlackFake;
      const replies: Array<unknown> = [];
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
            const subscription = yield* listener.send(WS_METHODS.houstonSlackSubscribe, {});
            replies.push(yield* Queue.take(listener.responses));
            for (const [method, payload] of [
              [
                WS_METHODS.houstonSlackConfigure,
                { ownerUserId: OWNER, channels: [{ channelId: "C1", projectId }] },
              ],
              [WS_METHODS.houstonSlackConnect, TOKENS],
            ] as const) {
              const reply = yield* client.call(method, payload);
              assert.isNull(failureOf(reply), `${method}: ${JSON.stringify(failureOf(reply))}`);
              replies.push(reply);
            }
            yield* until(
              "connected",
              Effect.sync(() => fake.sockets.length === 1),
            );
            fake.sockets[0]?.send(
              mentionEnvelope("e1", mentionEvent("1700000000.000100", "leak test")),
            );
            const outbox = yield* HoustonSlackOutbox;
            yield* until(
              "filed",
              Effect.gen(function* () {
                const sql = yield* SqlClient.SqlClient;
                const rows = yield* sql<{ readonly n: number }>`
                  SELECT COUNT(*) AS n FROM houston_slack_outbox
                `;
                return (rows[0]?.n ?? 0) >= 2;
              }),
            );
            yield* outbox.tick;

            // Socket Mode errors and reconnects: Slack refuses the link, then the URL fails to open.
            let opens = 0;
            fake.override = (call) => {
              if (call.method !== "apps.connections.open") return null;
              opens += 1;
              if (opens === 1) return { body: { ok: false, error: "invalid_auth" } };
              if (opens === 2) return { body: { ok: true, url: "ws://127.0.0.1:1/link" } };
              return null;
            };
            fake.sockets[0]?.close();
            yield* untilAdvancing(
              "two failed attempts and a reconnect",
              Effect.sync(() => opens >= 3),
            );
            yield* advance(3);

            for (const [method, payload] of [
              [WS_METHODS.houstonSlackGet, {}],
              [WS_METHODS.houstonSlackRequestsList, { projectId }],
              [WS_METHODS.houstonSlackDisconnect, {}],
            ] as const) {
              const reply = yield* client.call(method, payload);
              assert.isNull(failureOf(reply), `${method}: ${JSON.stringify(failureOf(reply))}`);
              replies.push(reply);
            }
            for (let turn = 0; turn < 10; turn += 1) yield* realTurn;
            while ((yield* Queue.size(listener.responses)) > 0) {
              replies.push(yield* Queue.take(listener.responses));
            }
            yield* listener.interrupt(subscription);
            assert.isTrue(fake.calls.some((call) => call.token === BOT_TOKEN));
            assert.isTrue(fake.calls.some((call) => call.token === APP_TOKEN));
            yield* Effect.logWarning("slack leak test done");
          }).pipe(Effect.withTracer(tracer));
          return { trace: config.serverTracePath, secrets: config.secretsDir };
        }),
      ).pipe(
        Effect.provide(
          layerServer({
            databaseFile,
            baseDir: dir,
            slackOrigin: fake.origin,
            keychain: makeMemory(),
          }),
        ),
      );

      const secrets = NodeFS.existsSync(paths.secrets)
        ? NodeFS.readdirSync(paths.secrets, { recursive: true, withFileTypes: true })
            .filter((entry) => entry.isFile())
            .map((entry) => NodePath.join(entry.parentPath, entry.name))
        : [];
      assert.isTrue(NodeFS.existsSync(paths.trace), "the trace file was written");
      assert.isNotEmpty(NodeFS.readFileSync(paths.trace, "utf8"));
      for (const token of [APP_TOKEN, BOT_TOKEN]) {
        const needle = Buffer.from(token, "utf8");
        for (const file of [databaseFile, `${databaseFile}-wal`, paths.trace, ...secrets]) {
          if (!NodeFS.existsSync(file)) continue;
          assert.isFalse(NodeFS.readFileSync(file).includes(needle), `${file} holds a token`);
        }
        assert.notInclude(logs.join("\n"), token);
        assert.notInclude(JSON.stringify(replies), token);
      }
      assert.isTrue(
        logs.some((line) => line.includes("Slack")),
        "the Socket Mode errors were logged",
      );
      assert.isAtLeast(replies.length, 6);
    }).pipe(
      Effect.provide(Logger.layer([logger])),
      Effect.scoped,
      Effect.provide(NodeServices.layer),
    );
  });
});

describe("subscribe sends the snapshot then each change", () => {
  it.effect("subscribe sends the snapshot then each change", () =>
    withServer((fake) =>
      Effect.gen(function* () {
        const projectId = yield* createProject("subscribed");
        const other = yield* createProject("elsewhere");
        const client = yield* makeWsClient(ALL_SCOPES);
        const listener = yield* makeWsClient(ALL_SCOPES);
        const subscription = yield* listener.send(WS_METHODS.houstonSlackSubscribe, {});
        const first = (yield* Queue.take(listener.responses)) as HoustonSlackStreamEvent;
        assert.isTrue("snapshot" in first);
        if ("snapshot" in first) {
          assert.isFalse(first.snapshot.info.enabled);
          assert.deepEqual(first.snapshot.requests, []);
        }
        yield* client.call(WS_METHODS.houstonSlackConfigure, {
          ownerUserId: OWNER,
          channels: [
            { channelId: "C1", projectId },
            { channelId: "C2", projectId: other },
          ],
        });
        yield* client.call(WS_METHODS.houstonSlackConnect, TOKENS);
        const events: Array<HoustonSlackStreamEvent> = [];
        const take = Effect.map(Queue.take(listener.responses), (event) => {
          events.push(event as HoustonSlackStreamEvent);
          return event as HoustonSlackStreamEvent;
        });
        // Settings, then the connection: off -> connecting -> connected.
        for (;;) {
          const event = yield* take;
          if ("info" in event && event.info.connection === "connected") break;
        }
        const infos = events.flatMap((event) => ("info" in event ? [event.info] : []));
        assert.strictEqual(infos[0]?.ownerUserId, OWNER);
        assert.include(
          infos.map((info) => info.connection),
          "connecting",
        );
        fake.sockets[0]?.send(mentionEnvelope("e1", mentionEvent("1700000000.000100", "first")));
        fake.sockets[0]?.send(
          mentionEnvelope("e2", mentionEvent("1700000000.000200", "second", { channel: "C2" })),
        );
        const requests: Array<HoustonSlackRequest> = [];
        while (requests.length < 2) {
          const event = yield* take;
          if ("request" in event) requests.push(event.request);
        }
        assert.deepEqual(
          requests.map((request) => [request.channelId, request.state, request.statusReaction]),
          [
            ["C1", "pending", "eyes"],
            ["C2", "pending", "eyes"],
          ],
        );
        const listed = (yield* client.call(WS_METHODS.houstonSlackRequestsList, {
          projectId,
        })) as ReadonlyArray<HoustonSlackRequest>;
        assert.deepEqual(
          listed.map((request) => request.channelId),
          ["C1"],
        );
        assert.isUndefined(listed[0]?.queuePosition);
        const all = (yield* client.call(
          WS_METHODS.houstonSlackRequestsList,
          {},
        )) as ReadonlyArray<HoustonSlackRequest>;
        assert.lengthOf(all, 2);
        yield* listener.interrupt(subscription);
      }),
    ),
  );
});

describe("each slack method requires its declared scope", () => {
  it.effect("each slack method requires its declared scope", () => {
    const keychain = makeMemory();
    return withServer(
      () =>
        Effect.gen(function* () {
          const projectId = yield* createProject("scoped");
          const sql = yield* SqlClient.SqlClient;
          const fingerprint = Effect.all([
            sql`SELECT * FROM houston_slack_settings`,
            sql`SELECT * FROM houston_slack_channels`,
            sql`SELECT * FROM houston_slack_requests`,
          ]).pipe(Effect.map((rows) => `${JSON.stringify(rows)} ${keychain.entries.size}`));
          const methods: ReadonlyArray<{
            readonly method: string;
            readonly scope: AuthEnvironmentScope;
            readonly payload: object;
          }> = [
            { method: WS_METHODS.houstonSlackGet, scope: AuthOrchestrationReadScope, payload: {} },
            {
              method: WS_METHODS.houstonSlackConfigure,
              scope: AuthSettingsWriteScope,
              payload: { ownerUserId: OWNER, channels: [{ channelId: "C1", projectId }] },
            },
            {
              method: WS_METHODS.houstonSlackConnect,
              scope: AuthSettingsWriteScope,
              payload: TOKENS,
            },
            {
              method: WS_METHODS.houstonSlackDisconnect,
              scope: AuthSettingsWriteScope,
              payload: {},
            },
            {
              method: WS_METHODS.houstonSlackRequestsList,
              scope: AuthOrchestrationReadScope,
              payload: { projectId },
            },
            {
              method: WS_METHODS.houstonSlackSubscribe,
              scope: AuthOrchestrationReadScope,
              payload: {},
            },
          ];
          for (const entry of methods) {
            const before = yield* fingerprint;
            const without = yield* makeWsClient(
              ALL_SCOPES.filter((scope) => scope !== entry.scope),
            );
            const denied = failureOf(yield* without.call(entry.method, entry.payload));
            assert.strictEqual(denied?._tag, "EnvironmentAuthorizationError", entry.method);
            assert.strictEqual(yield* fingerprint, before, `${entry.method} changed state`);
            const only = yield* makeWsClient([entry.scope]);
            const id = yield* only.send(entry.method, entry.payload);
            const allowed = yield* Queue.take(only.responses);
            assert.isNull(
              failureOf(allowed),
              `${entry.method}: ${JSON.stringify(failureOf(allowed))}`,
            );
            if (entry.method === WS_METHODS.houstonSlackSubscribe) yield* only.interrupt(id);
          }
        }),
      { keychain },
    );
  });
});

describe("unknown projects and an unreachable keychain are refused by name", () => {
  it.effect("unknown projects and an unreachable keychain are refused by name", () => {
    const keychain = makeMemory();
    return withServer(
      () =>
        Effect.gen(function* () {
          const client = yield* makeWsClient(ALL_SCOPES);
          const projectId = yield* createProject("refusals");
          for (const [method, payload] of [
            [WS_METHODS.houstonSlackRequestsList, { projectId: "project-missing" }],
            [
              WS_METHODS.houstonSlackConfigure,
              { channels: [{ channelId: "C1", projectId: "project-missing" }] },
            ],
          ] as const) {
            const refused = failureOf(yield* client.call(method, payload));
            assert.strictEqual(refused?.kind, "not_found", method);
            assert.include(refused?.message ?? "", "project-missing", method);
          }
          yield* client.call(WS_METHODS.houstonSlackConfigure, {
            channels: [{ channelId: "C1", projectId }],
          });
          yield* client.call(WS_METHODS.houstonSlackConnect, TOKENS);
          keychain.failWith = "the keychain is locked";
          const refused = failureOf(yield* client.call(WS_METHODS.houstonSlackDisconnect, {}));
          assert.strictEqual(refused?.kind, "keychain_unavailable");
          assert.include(refused?.message ?? "", "the keychain is locked");
          keychain.failWith = null;
          const info = (yield* client.call(WS_METHODS.houstonSlackGet, {})) as HoustonSlackInfo;
          assert.isTrue(info.enabled);
        }),
      { keychain },
    );
  });
});

describe("slack state survives a restart", () => {
  it.effect("slack state survives a restart", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "houston-slack-restart-" });
      const fake = yield* makeSlackFake;
      const options: SlackTestOptions = {
        databaseFile: NodePath.join(dir, "state.sqlite"),
        baseDir: dir,
        keychain: makeMemory(),
        slackOrigin: fake.origin,
      };
      const read = Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        return JSON.stringify(
          yield* Effect.all([
            sql`SELECT * FROM houston_slack_settings`,
            sql`SELECT * FROM houston_slack_channels`,
            sql`SELECT * FROM houston_slack_requests`,
            sql`SELECT * FROM houston_slack_questions`,
            sql`SELECT * FROM houston_slack_outbox`,
          ]),
        );
      });
      const before = yield* Effect.gen(function* () {
        const projectId = yield* createProject("restart", "/work/restart");
        const client = yield* makeWsClient(ALL_SCOPES);
        yield* client.call(WS_METHODS.houstonSlackConfigure, {
          ownerUserId: OWNER,
          channels: [{ channelId: "C1", projectId }],
          language: "pt-BR",
        });
        const sql = yield* SqlClient.SqlClient;
        yield* sql`
          INSERT INTO houston_slack_requests (channel_id, ts, author, project_id, task_id, state, status_reaction, created_at)
          VALUES ('C1', '1700000000.000100', 'U2', ${projectId}, 1, 'pending', 'eyes', '2026-10-30T00:00:00.000Z')
        `;
        yield* sql`
          INSERT INTO houston_slack_questions (request_id, task_run_id, thread_id, form_json, created_at)
          VALUES (1, 1, 'task-1', '{}', '2026-10-30T00:00:00.000Z')
        `;
        yield* sql`
          INSERT INTO houston_slack_outbox (request_id, dedupe_key, target, text, created_at)
          VALUES (1, 'unsent', 'thread', 'still owed', '2026-10-30T00:00:00.000Z')
        `;
        return yield* read;
      }).pipe(Effect.provide(layerServer(options)));
      assert.include(before, "still owed");
      yield* Effect.gen(function* () {
        assert.strictEqual(yield* read, before);
        const client = yield* makeWsClient(ALL_SCOPES);
        const info = (yield* client.call(WS_METHODS.houstonSlackGet, {})) as HoustonSlackInfo;
        assert.strictEqual(info.ownerUserId, OWNER);
        assert.strictEqual(info.language, "pt-BR");
        assert.deepEqual(info.channels, [
          { channelId: "C1", projectId: ProjectId.make("project-restart") },
        ]);
        const requests = (yield* client.call(
          WS_METHODS.houstonSlackRequestsList,
          {},
        )) as ReadonlyArray<HoustonSlackRequest>;
        assert.lengthOf(requests, 1);
      }).pipe(Effect.provide(layerServer(options)));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
