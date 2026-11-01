// The harness review over one database: the real orchestrator with the side-thread provider
// doubles, the real project and scheduled-task services, and the Houston claim, store, runner,
// service and reactor as the server composes them. No CLI, network or GitHub.
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type ModelSelection,
  type ScheduledTask,
} from "@t3tools/contracts";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as SourceControlRateLimit from "@t3tools/source-control-core/server/SourceControlRateLimit";
import * as GitHubAppSignIn from "@t3tools/source-control-github/server/GitHubAppSignIn";
import * as GitHubCredentials from "@t3tools/source-control-github/server/GitHubCredentials";
import * as GitHubQuota from "@t3tools/source-control-github/server/GitHubQuota";
import * as GitHubRest from "@t3tools/source-control-github/server/GitHubRest";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as SqlClient from "effect/sql/SqlClient";
import { HttpClient, HttpClientResponse } from "effect/http";
import { TestClock } from "effect/testing";

import * as ServerConfig from "../../config.ts";
import * as EffectWorker from "../../orchestration-v2/EffectWorker.ts";
import * as Orchestrator from "../../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../../orchestration-v2/ProjectStore.ts";
import * as ProviderReplayHarness from "../../orchestration-v2/testkit/ProviderReplayHarness.ts";
import * as RuntimeLayer from "../../orchestration-v2/runtimeLayer.ts";
import * as ThreadLaunchService from "../../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../../orchestration-v2/ThreadManagementService.ts";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import * as ManagedProjectFolders from "../../project/ManagedProjectFolders.ts";
import * as ProjectEnrichmentService from "../../project/ProjectEnrichmentService.ts";
import * as ProjectService from "../../project/ProjectService.ts";
import * as ScheduledTaskService from "../../scheduledTasks/ScheduledTaskService.ts";
import * as Scheduler from "../../scheduling/Scheduler.ts";
import * as SecretRequests from "../../secrets/SecretRequests.ts";
import * as ServerSettings from "../../serverSettings.ts";
import { HostedLaunch } from "../baseDir.ts";
import * as McpSessionRegistry from "../../mcp/McpSessionRegistry.ts";
import {
  CLAUDE,
  CODEX,
  ANTIGRAVITY,
  type DoubleSpec,
  type Harness,
  makeHarness,
  withReadOnlyRun,
} from "../sideThreads.testkit.ts";
import * as HoustonTaskService from "../tasks/TaskService.ts";
import * as HoustonTaskStore from "../tasks/TaskStore.ts";
import {
  layerInstances,
  layerProjectMetadata,
  layerWorkspacePaths,
} from "../tasks/tasks.testkit.ts";
import { ClaudeProviderCapabilitiesV2 } from "../../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import * as HoustonDefectIssues from "./defects/Issues.ts";
import * as HoustonDefects from "./defects/Defects.ts";
import { layerHarnessReview, layerHarnessScheduledTaskRunner } from "./layer.ts";
import * as HarnessReviewReactor from "./Reactor.ts";
import * as HoustonHarnessRunner from "./Runner.ts";
import * as HoustonHarnessService from "./Service.ts";
import type { VerificationWrite } from "./rules.ts";
import * as HoustonHarnessStore from "./Store.ts";

// The families test proves each adapter's own declaration; these doubles declare the same.
export const OPENCODE: DoubleSpec = {
  driver: "opencode",
  capabilities: withReadOnlyRun(ClaudeProviderCapabilitiesV2, "permissionRules"),
};
export const OPENCODE2: DoubleSpec = {
  driver: "opencode",
  instanceId: "opencode2",
  capabilities: withReadOnlyRun(ClaudeProviderCapabilitiesV2, "permissionRules"),
};

/** Claude, Codex, OpenCode 1 and 2 run read-only; Antigravity declares no read-only run. */
export const ALL_SPECS: ReadonlyArray<DoubleSpec> = [
  CLAUDE,
  CODEX,
  OPENCODE,
  OPENCODE2,
  ANTIGRAVITY,
];

export const NOW = "2026-10-30T09:00:00.000Z";

export const model = (instance: string, name = "test-model"): ModelSelection => ({
  instanceId: ProviderInstanceId.make(instance),
  model: name,
});

export interface Launched {
  readonly title: string;
  readonly prompt: string;
  readonly projectId: ProjectId;
  readonly threadId: ThreadId;
}

export interface GithubRequest {
  readonly method: string;
  readonly url: string;
  /** The JSON body of a write. */
  readonly body: unknown;
}

/** Answers every request to api.github.com in process and records it. */
export interface GithubFake {
  readonly requests: Array<GithubRequest>;
  respond: (url: URL, request: GithubRequest) => Response;
}

/** Upstream's GitHub client with a Settings credential, answered by `fake`. */
const layerGitHubFake = (fake: GithubFake) => {
  const credentials = Layer.succeed(
    GitHubCredentials.GitHubCredentials,
    GitHubCredentials.GitHubCredentials.of({
      get: (host) =>
        Effect.succeed({
          host,
          token: Redacted.make("ghp_settings_token_for_harness_tests"),
          source: "settings" as const,
          fingerprint: `${host}:settings`,
        }),
      saved: () => Effect.succeedNone,
      fingerprint: (host, token) => Effect.succeed(`${host}:${token.length}`),
      invalidate: () => Effect.void,
    }),
  );
  const http = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) => {
      const entry: GithubRequest = {
        method: request.method,
        url: request.url,
        body:
          request.body._tag === "Uint8Array"
            ? (JSON.parse(new TextDecoder().decode(request.body.body)) as unknown)
            : undefined,
      };
      fake.requests.push(entry);
      return Effect.succeed(
        HttpClientResponse.fromWeb(request, fake.respond(new URL(request.url), entry)),
      );
    }),
  );
  const appSignedOut = Layer.mock(GitHubAppSignIn.GitHubAppSignIn)({
    enabled: false,
    token: () => Effect.succeedNone,
    invalidate: () => Effect.void,
  });
  // Only the client and its credential leave the layer; nothing else reaches the fake.
  return GitHubRest.layer.pipe(
    Layer.provide(Layer.mergeAll(http, appSignedOut)),
    Layer.provideMerge(credentials),
    Layer.provideMerge(GitHubQuota.layer),
    Layer.provideMerge(SourceControlRateLimit.layer),
  );
};

export interface KitOptions {
  /** A database file that outlives the layer; in memory when absent. */
  readonly databaseFile?: string;
  readonly specs?: ReadonlyArray<DoubleSpec>;
  /** Whether the reactor starts with the layer, as in the server. */
  readonly reactor?: boolean;
  /** Wraps the real Tasks service, to place a yield or an interrupt inside a Tasks call. */
  readonly tasks?: (
    service: HoustonTaskService.HoustonTaskService["Service"],
  ) => HoustonTaskService.HoustonTaskService["Service"];
}

/** Thread launches of scheduled tasks Houston does not claim. */
const layerThreadLaunch = (launches: Array<Launched>) =>
  Layer.mock(ThreadLaunchService.ThreadLaunchService)({
    launch: (input: Parameters<ThreadLaunchService.ThreadLaunchService["Service"]["launch"]>[0]) =>
      Effect.sync(() => {
        const threadId = ThreadId.make(`launched:${launches.length + 1}`);
        launches.push({
          title: input.title,
          prompt: input.initialMessage?.text ?? "",
          projectId: input.projectId,
          threadId,
        });
        return { threadId } as never;
      }),
  });

export const makeKit = Effect.fn("HarnessReviewKit.make")(function* (
  name: string,
  options: KitOptions = {},
) {
  const harness = yield* makeHarness(`harness-${name}`, options.specs ?? ALL_SPECS, {
    git: false,
  });
  const launches: Array<Launched> = [];
  // Any request a test does not answer gets an empty search result.
  const github: GithubFake = {
    requests: [],
    respond: () => new Response(JSON.stringify({ total_count: 0, items: [] }), { status: 200 }),
  };
  // One layer value per kit: every consumer in a build shares the one database it memoizes.
  const database =
    options.databaseFile === undefined
      ? SqlitePersistence.layerMemory.pipe(Layer.provide(Layer.empty))
      : SqlitePersistence.layerFromPath(options.databaseFile).pipe(
          Layer.provide(NodeServices.layer),
        );
  return { name, harness, launches, github, database, options };
});

export type Kit = Effect.Success<ReturnType<typeof makeKit>>;

const layerOrchestration = (kit: Kit) =>
  ProviderReplayHarness.layerWithRegistry({ name: `harness-${kit.name}` }, kit.harness.registry, {
    runEffectWorker: false,
    configureMcp: true,
    databaseLayer: kit.database,
    mcpSessionRegistry: Layer.succeed(
      McpSessionRegistry.McpSessionRegistry,
      McpSessionRegistry.McpSessionRegistry.of({
        issue: ({ threadId, providerInstanceId }) =>
          Effect.sync(() => {
            kit.harness.log.mcpIssued.push(threadId);
            return {
              config: {
                environmentId: "environment:harness" as never,
                threadId,
                providerSessionId: `mcp-test:${threadId}`,
                providerInstanceId,
                endpoint: "http://127.0.0.1/mcp",
                authorizationHeader: `Bearer mcp-test:${threadId}`,
                browserToolsAvailable: false,
              },
            };
          }),
        // @effect-diagnostics-next-line effectSucceedWithVoid:off - This optional result requires undefined, not the wider void type.
        resolve: () => Effect.succeed(undefined),
        touch: () => Effect.void,
        revokeProviderSession: () => Effect.void,
        revokeThread: () => Effect.void,
        revokeAll: Effect.void,
      }),
    ),
  });

/** Everything a harness review test reaches, over the kit's one database. */
export const layerKit = (kit: Kit) => {
  const orchestration = layerOrchestration(kit);
  const registry = kit.harness.registry.pipe(Layer.provide(McpProviderSessions.layer));
  const scheduledTasks = ScheduledTaskService.layer.pipe(
    Layer.provideMerge(layerHarnessScheduledTaskRunner),
    Layer.provide(
      Layer.mergeAll(
        layerThreadLaunch(kit.launches),
        Layer.mock(ThreadManagementService.ThreadManagementService)({}),
        Layer.mock(SecretRequests.SecretRequests)({}),
        Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
          namedProjectsRoot: "/projects",
          isScratchProject: () => Effect.succeed(false),
        }),
        NodeCrypto.layer,
        Scheduler.layer,
      ),
    ),
  );
  // Without the reactor, nothing settles a review's run: the state a server stopped in.
  const harnessReview = (
    kit.options.reactor === false
      ? Layer.merge(
          HoustonHarnessService.layer,
          Layer.succeed(
            HarnessReviewReactor.HarnessReviewReactor,
            HarnessReviewReactor.HarnessReviewReactor.of({
              settleRun: () => Effect.void,
              recover: Effect.void,
            }),
          ),
        )
      : layerHarnessReview
  ).pipe(Layer.provideMerge(HoustonHarnessRunner.layer), Layer.provideMerge(scheduledTasks));
  const wrapTasks = kit.options.tasks;
  const taskService =
    wrapTasks === undefined
      ? HoustonTaskService.layer
      : Layer.effect(
          HoustonTaskService.HoustonTaskService,
          Effect.gen(function* () {
            return wrapTasks(yield* HoustonTaskService.HoustonTaskService);
          }),
        ).pipe(Layer.provide(HoustonTaskService.layer));
  return harnessReview.pipe(
    // Issue drafts and filing reach only the kit's GitHub fake.
    Layer.provideMerge(layerGitHubFake(kit.github)),
    // Fix tasks and verdict comments go through the real Tasks service, as in the server.
    Layer.provideMerge(taskService),
    Layer.provideMerge(Layer.mergeAll(RuntimeLayer.layerProjectService, ProjectStore.layer)),
    Layer.provideMerge(ProjectionStore.layer),
    Layer.provideMerge(registry),
    Layer.provideMerge(orchestration),
    Layer.provideMerge(Layer.merge(HoustonHarnessStore.layer, HoustonTaskStore.layer)),
    Layer.provideMerge(layerInstances(["claudeAgent", "codex", "opencode", "opencode2"])),
    Layer.provideMerge(ProjectEnrichmentService.layer),
    Layer.provideMerge(layerWorkspacePaths),
    Layer.provideMerge(layerProjectMetadata),
    Layer.provideMerge(kit.database),
    Layer.provideMerge(ServerSettings.layerTest()),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "houston-harness-test-" })),
    Layer.provideMerge(NodeServices.layer),
    Layer.provideMerge(Layer.succeed(HostedLaunch, false)),
  );
};

let projectCommands = 0;

/** A project registered through the real project service, rooted at a fresh temp directory. */
export const createProject = Effect.fn("HarnessReviewKit.createProject")(function* (
  name: string,
  root?: string,
) {
  const projects = yield* ProjectService.ProjectService;
  const fs = yield* FileSystem.FileSystem;
  const workspaceRoot = root ?? (yield* fs.makeTempDirectoryScoped({ prefix: `harness-${name}-` }));
  projectCommands += 1;
  const projectId = ProjectId.make(`project-${name}`);
  yield* projects.create({
    commandId: CommandId.make(`command:harness-test:create:${projectCommands}`),
    projectId,
    title: name,
    workspaceRoot,
  });
  return { projectId, root: workspaceRoot };
});

export const deleteProject = Effect.fn("HarnessReviewKit.deleteProject")(function* (
  projectId: ProjectId,
) {
  const projects = yield* ProjectService.ProjectService;
  projectCommands += 1;
  yield* projects.delete({
    commandId: CommandId.make(`command:harness-test:delete:${projectCommands}`),
    projectId,
  });
});

/** Runs effects the orchestrator queued and lets the reactor see every run end. */
export const settle = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
  for (let round = 0; round < 8; round += 1) {
    yield* Effect.yieldNow;
    yield* worker.drain();
    yield* orchestrator.resumeQueuedRuns;
    yield* worker.drain();
    yield* TestClock.adjust("1 second");
  }
  for (let round = 0; round < 20; round += 1) yield* Effect.yieldNow;
});

// @effect-diagnostics-next-line globalTimers:off - real time; the test clock does not move disk writes.
const realPause = Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 25)));

/** Waits, in real time, until a fired task's run has ended; its files are real disk writes. */
export const awaitRun = Effect.fn("HarnessReviewKit.awaitRun")(function* (task: ScheduledTask) {
  const scheduled = yield* ScheduledTaskService.ScheduledTaskService;
  for (let attempt = 0; attempt < 400; attempt += 1) {
    yield* Effect.yieldNow;
    const { tasks } = yield* scheduled.list();
    const current = tasks.find((candidate) => candidate.id === task.id);
    if (
      current === undefined ||
      (current.runCount > task.runCount && current.lastRunStatus !== "running")
    ) {
      break;
    }
    yield* realPause;
  }
  yield* settle;
});

/** Drives the orchestrator until `done` holds, in real time: a review's files are real disk writes. */
export const until = Effect.fn("HarnessReviewKit.until")(function* <E, R>(
  label: string,
  done: Effect.Effect<boolean, E, R>,
) {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (yield* done) return;
    yield* worker.drain();
    yield* orchestrator.resumeQueuedRuns;
    yield* worker.drain();
    yield* TestClock.adjust("1 second");
    yield* realPause;
  }
  return yield* Effect.die(new Error(`timed out waiting until ${label}`));
});

/** Waits until review `reviewId` is stored and `ready` holds for it. */
export const awaitReview = (
  reviewId: number,
  ready: (review: HoustonHarnessStore.StoredReview) => boolean,
) =>
  until(
    `review ${reviewId} is ready`,
    Effect.flatMap(HoustonHarnessStore.HoustonHarnessStore, (store) =>
      store.getReview(reviewId),
    ).pipe(Effect.map((review) => review !== undefined && ready(review))),
  );

/** The scheduled task a project's review runs as. */
export const reviewTask = Effect.fn("HarnessReviewKit.reviewTask")(function* (
  projectId: ProjectId,
) {
  const store = yield* HoustonHarnessStore.HoustonHarnessStore;
  const scheduled = yield* ScheduledTaskService.ScheduledTaskService;
  const settings = yield* store.settings(projectId);
  const { tasks } = yield* scheduled.list();
  return tasks.find((task) => task.id === settings?.scheduledTaskId) as ScheduledTask | undefined;
});

/** A published review of `projectId` whose answer is `findingsJson`, through the store. */
export const seedPublished = Effect.fn("HarnessReviewKit.seedPublished")(function* (input: {
  readonly projectId: ProjectId;
  readonly findings: ReadonlyArray<Record<string, unknown>>;
  readonly endedAt: string;
  readonly report?: string;
  readonly verifications?: ReadonlyArray<VerificationWrite>;
}) {
  const store = yield* HoustonHarnessStore.HoustonHarnessStore;
  const review = yield* store.openReview({
    projectId: input.projectId,
    trigger: "manual",
    scheduledTaskId: null,
    providerInstanceId: "claudeAgent",
    startedAt: input.endedAt,
  });
  yield* store.markRunning(review.id, {
    threadId: ThreadId.make(`seeded-review:${review.id}`),
    windowSince: input.endedAt,
    windowUntil: input.endedAt,
    threads: 1,
    prompts: 1,
  });
  yield* store.publish(review.id, {
    endedAt: input.endedAt,
    windowSince: input.endedAt,
    windowUntil: input.endedAt,
    threads: 1,
    prompts: 1,
    costUsd: null,
    summary: `${input.findings.length} findings`,
    findings: input.findings.map((finding) => ({
      key: String(finding.key),
      title: String(finding.title ?? finding.key),
      category: "permissions",
      confidence: String(finding.confidence ?? "high"),
      sessions: ["t-1"],
      count: 1,
      quotes: (finding.quotes as ReadonlyArray<string> | undefined) ?? ["a quote"],
      recommendationKind: "settings-allow",
      target: ".claude/settings.json",
      recommendation: String(finding.recommendation ?? "Allow it"),
      applyPrompt: String(finding.applyPrompt ?? "Add the rule"),
    })),
    verifications: input.verifications ?? [],
  });
  return review.id;
});

export type KitServices = Layer.Success<ReturnType<typeof layerKit>>;

/** Pins the test clock at NOW, then builds the kit: its poll loops start from NOW, not 1970. */
export const runKit = <A, E>(
  kit: Kit,
  body: Effect.Effect<A, E, KitServices | import("effect/Scope").Scope>,
) =>
  Effect.gen(function* () {
    if (Date.parse(NOW) > (yield* Clock.currentTimeMillis)) {
      yield* TestClock.setTime(Date.parse(NOW));
    }
    const context = yield* Layer.build(layerKit(kit));
    return yield* body.pipe(Effect.provideContext(context));
  }).pipe(Effect.scoped);

export {
  HoustonDefectIssues,
  HoustonDefects,
  HarnessReviewReactor,
  HoustonHarnessRunner,
  HoustonHarnessService,
  HoustonHarnessStore,
  HoustonTaskService,
};
export type { Harness };

/** The database handle, for tests that read rows directly. */
export const sql = SqlClient.SqlClient;
