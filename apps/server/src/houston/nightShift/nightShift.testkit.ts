// @effect-diagnostics nodeBuiltinImport:off globalDate:off - git fixtures in temp dirs; local wall clocks.
// Night shift over one database with the real orchestrator, projects, scheduled tasks and claim;
// threads, machine readings, readiness and the keep-awake child are doubles, git is real.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

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
import type { HoustonNightShiftSettings } from "@t3tools/contracts/houston/nightShift";
import type { ProviderReadiness } from "@t3tools/contracts/houston/providerReadiness";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as SourceControlRateLimit from "@t3tools/source-control-core/server/SourceControlRateLimit";
import * as GitHubAppSignIn from "@t3tools/source-control-github/server/GitHubAppSignIn";
import * as GitHubCredentials from "@t3tools/source-control-github/server/GitHubCredentials";
import * as GitHubQuota from "@t3tools/source-control-github/server/GitHubQuota";
import * as GitHubRest from "@t3tools/source-control-github/server/GitHubRest";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { TestClock } from "effect/testing";

import * as ServerConfig from "../../config.ts";
import * as McpSessionRegistry from "../../mcp/McpSessionRegistry.ts";
import * as EffectWorker from "../../orchestration-v2/EffectWorker.ts";
import * as Orchestrator from "../../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../../orchestration-v2/ProjectStore.ts";
import * as ProviderReplayHarness from "../../orchestration-v2/testkit/ProviderReplayHarness.ts";
import * as RuntimeLayer from "../../orchestration-v2/runtimeLayer.ts";
import * as ThreadLaunchService from "../../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../../orchestration-v2/ThreadManagementService.ts";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import * as ManagedPolicy from "../../policy/ManagedPolicy.ts";
import * as ManagedProjectFolders from "../../project/ManagedProjectFolders.ts";
import * as ProjectEnrichmentService from "../../project/ProjectEnrichmentService.ts";
import * as ProjectService from "../../project/ProjectService.ts";
import * as ScheduledTaskService from "../../scheduledTasks/ScheduledTaskService.ts";
import * as Scheduler from "../../scheduling/Scheduler.ts";
import * as SecretRequests from "../../secrets/SecretRequests.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as VcsProcess from "../../vcs/VcsProcess.ts";
import { HostedLaunch } from "../baseDir.ts";
import * as HoustonHarnessStore from "../harnessReview/Store.ts";
import * as HoustonBuildSlot from "../mergeQueue/BuildSlot.ts";
import * as HoustonMergeVerifier from "../mergeQueue/Verifier.ts";
import {
  ANTIGRAVITY,
  CLAUDE,
  CODEX,
  type DoubleSpec,
  makeHarness,
} from "../sideThreads.testkit.ts";
import {
  layerProjectMetadata,
  layerWorkspacePaths,
  layerInstances,
} from "../tasks/tasks.testkit.ts";
import * as CrewGate from "./CrewGate.ts";
import * as NightShiftGit from "./Git.ts";
import {
  NightShiftBacklog,
  NightShiftMachine,
  NightShiftMergeQueue,
  NightShiftProviders,
  NightShiftPullRequests,
  type MachineReadings,
  type ProviderState,
  type UpNextTask,
} from "./Host.ts";
import * as KeepAwake from "./KeepAwake.ts";
import * as Landing from "./landing/Landing.ts";
import { NightShiftCi, NightShiftLandingQueue } from "./landing/Ports.ts";
import { defaultSettings } from "./rules.ts";
import * as Runner from "./Runner.ts";
import { layerClaim, layerHoustonScheduledTaskRunner } from "./ScheduledTaskRunner.ts";
import * as Service from "./Service.ts";
import * as Store from "./Store.ts";
import { NightShiftThreads, type ThreadState } from "./Threads.ts";
import { localTimeZone } from "./window.ts";

/** An instant as this process's local clock reads it, `YYYY-MM-DD HH:MM`. */
export const localClock = (at: string | number) => {
  const date = new Date(at);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
};

/** The instant a local date and time names in this process's zone. */
export const localInstant = (
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
) => new Date(year, month - 1, day, hour, minute).getTime();

export const NOW = "2026-10-30T22:00:00.000Z";
const GIB = 1024 ** 3;

export const model = (instance: string, name = "test-model"): ModelSelection => ({
  instanceId: ProviderInstanceId.make(instance),
  model: name,
});

const OPENCODE: DoubleSpec = { driver: "opencode", capabilities: CLAUDE.capabilities };

export interface Spawned {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  stdinClosed: boolean;
  killed: boolean;
  /** A stubborn child ignores its closed stdin. */
  stubborn: boolean;
}

export interface Note {
  readonly threadId: string;
  readonly messageId: string;
  readonly text: string;
}

export interface KitState {
  /** In order: launch, cancel:<thread>, ended:<thread>, stop:<thread>, notify:<message id>. */
  readonly ops: Array<string>;
  /** Seconds of test clock a cancelled crew thread takes to end; Infinity never ends. */
  readonly cancelDelays: Map<string, number>;
  readonly launches: Array<ThreadLaunchService.ThreadLaunchInput>;
  readonly notes: Array<Note>;
  readonly states: Map<string, ThreadState>;
  launchFailure: string | null;
  /** A launch that never answers, so a test can interrupt the start. */
  launchHangs: boolean;
  /** Called with each launch before it answers. */
  onLaunch: (input: ThreadLaunchService.ThreadLaunchInput) => void;
  readings: MachineReadings;
  readonly path: Set<string>;
  timeZone: string;
  providers: Array<ProviderState>;
  verification: string | null;
  /** Night shift's git calls by name: origin, defaultBranch, lsRemoteHeads. */
  readonly gitCalls: Array<string>;
  readonly spawns: Array<Spawned>;
  spawnFailure: string | null;
  /** Settle steps in order, as `<step>` names. */
  readonly settleSteps: Array<string>;
  /** Every HTTP request any layer of the kit sent, GitHub's included. */
  readonly httpRequests: Array<string>;
  /** Delegated task statuses by `<parent thread>|<task id>`. */
  readonly taskStatuses: Map<string, string>;
  /** Each thread's worktree and branch. */
  readonly workspaces: Map<string, { readonly worktreePath: string; readonly branch: string }>;
  /** The Tasks backlog in ready order, with each task's text. */
  backlog: Array<UpNextTask & { readonly text: string }>;
  /** Task keys whose status was set to done since a pick. */
  readonly doneSince: Set<string>;
  /** Pull request states GitHub answers; a missing number fails the read. */
  readonly pullRequestStates: Map<number, "open" | "closed" | "merged">;
  /** Each pull request state read, by number. */
  readonly pullRequestReads: Array<number>;
  /** GitHub's REST API as landing reaches it through upstream's GitHubRest. */
  readonly github: GitHubFake;
  /** Check reads by pull request number, as upstream's pull request service answers them. */
  readonly ciChecks: Map<number, ReadonlyArray<CiCheck>>;
  /** Each CI read, by pull request number. */
  readonly ciReads: Array<number>;
  /** Branches checked out in a managed worktree of the project. */
  readonly managed: Set<string>;
  /** The merge queue as landing reaches it. */
  readonly queue: QueueFake;
  /** Task statuses by key, as the report reads them for picks. */
  readonly backlogStatuses: Map<string, string>;
  /** Comments landing added to tasks: `<key>|<author>|<body>`. */
  readonly taskComments: Array<string>;
  /** Every git process run through VcsProcess: its arguments and GIT_CONFIG_* keys. */
  readonly gitRuns: Array<{
    readonly args: ReadonlyArray<string>;
    readonly config: ReadonlyArray<string>;
  }>;
}

export interface CiCheck {
  readonly name: string;
  readonly status: "passed" | "failed" | "pending";
  readonly url: string | null;
}

export interface GitHubRequest {
  readonly method: string;
  readonly path: string;
  readonly body: any;
}

export interface GitHubFake {
  readonly requests: Array<GitHubRequest>;
  nextNumber: number;
  /** Answers the next pull request create with this status and message. */
  createFailure: { readonly status: number; readonly message: string } | null;
  /** Workflow run statuses by run id. */
  readonly runs: Map<number, "completed" | "in_progress">;
  rerunRefused: boolean;
  closeFailure: string | null;
}

export interface QueueFake {
  /** `enqueue:<n>:after:<m|none>:owner:<thread>`, `dequeue:<n>`, in order. */
  readonly ops: Array<string>;
  readonly queued: Set<number>;
  enqueueFailure: string | null;
  /** The merge queue log: pushes and merges. */
  readonly log: Array<{
    readonly kind: string;
    readonly refName: string;
    readonly newSha: string | null;
    readonly at: string;
  }>;
}

const READY: ProviderReadiness = { state: "ready" };

export const freshState = (): KitState => ({
  ops: [],
  cancelDelays: new Map(),
  launches: [],
  notes: [],
  states: new Map(),
  launchFailure: null,
  launchHangs: false,
  onLaunch: () => undefined,
  readings: {
    onBattery: "false",
    freeMemoryBytes: 16 * GIB,
    freeDiskBytes: 100 * GIB,
    platform: "linux",
    inhibitAvailable: true,
    restartPending: false,
    activeHours: null,
  },
  path: new Set(["pnpm", "git"]),
  // Upstream's scheduler computes in the process's zone; Night shift's window must agree.
  timeZone: localTimeZone(),
  providers: [
    { instanceId: "claudeAgent", driver: "claudeAgent", readiness: READY },
    { instanceId: "codex", driver: "codex", readiness: READY },
    { instanceId: "opencode", driver: "opencode", readiness: READY },
    { instanceId: "antigravity", driver: "antigravity", readiness: READY },
  ],
  verification: null,
  gitCalls: [],
  spawns: [],
  spawnFailure: null,
  settleSteps: [],
  httpRequests: [],
  taskStatuses: new Map(),
  workspaces: new Map(),
  backlog: [],
  doneSince: new Set(),
  pullRequestStates: new Map(),
  pullRequestReads: [],
  github: {
    requests: [],
    nextNumber: 101,
    createFailure: null,
    runs: new Map(),
    rerunRefused: false,
    closeFailure: null,
  },
  ciChecks: new Map(),
  ciReads: [],
  managed: new Set(),
  queue: { ops: [], queued: new Set(), enqueueFailure: null, log: [] },
  backlogStatuses: new Map(),
  taskComments: [],
  gitRuns: [],
});

const decodeBody = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

/** api.github.com as landing uses it; every other host is refused. */
const answerGitHub = (github: GitHubFake, method: string, path: string, body: any): Response => {
  github.requests.push({ method, path, body });
  const pulls = /^\/repos\/([^/]+\/[^/]+)\/pulls$/.exec(path);
  if (method === "POST" && pulls !== null) {
    if (github.createFailure !== null) {
      const failure = github.createFailure;
      github.createFailure = null;
      return json({ message: failure.message }, failure.status);
    }
    const number = github.nextNumber++;
    return json({ number, html_url: `https://github.com/${pulls[1]}/pull/${number}` }, 201);
  }
  const pull = /^\/repos\/([^/]+\/[^/]+)\/pulls\/(\d+)$/.exec(path);
  if (method === "PATCH" && pull !== null) {
    if (body?.state === "closed" && github.closeFailure !== null) {
      return json({ message: github.closeFailure }, 403);
    }
    return json({
      number: Number(pull[2]),
      html_url: `https://github.com/${pull[1]}/pull/${pull[2]}`,
    });
  }
  const comment = /^\/repos\/[^/]+\/[^/]+\/issues\/(\d+)\/comments$/.exec(path);
  if (method === "POST" && comment !== null) return json({ id: 1 }, 201);
  const rerun = /^\/repos\/[^/]+\/[^/]+\/actions\/runs\/(\d+)\/rerun-failed-jobs$/.exec(path);
  if (method === "POST" && rerun !== null) {
    return github.rerunRefused ? json({ message: "Resource not accessible" }, 403) : json({}, 201);
  }
  const run = /^\/repos\/[^/]+\/[^/]+\/actions\/runs\/(\d+)$/.exec(path);
  if (method === "GET" && run !== null) {
    const status = github.runs.get(Number(run[1]));
    return status === undefined
      ? json({ message: "Not Found" }, 404)
      : json({ id: Number(run[1]), status });
  }
  return json({ message: `the Night shift GitHub fake has no answer for ${method} ${path}` }, 404);
};

const layerRecordingHttp = (state: KitState) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.sync(() => {
        state.httpRequests.push(`${request.method} ${request.url}`);
        const url = new URL(request.url);
        if (url.hostname !== "api.github.com") {
          throw new Error(`Night shift tests answer no HTTP request: ${request.url}`);
        }
        const body =
          request.body._tag === "Uint8Array"
            ? decodeBody(new TextDecoder().decode(request.body.body))
            : undefined;
        return HttpClientResponse.fromWeb(
          request,
          answerGitHub(state.github, request.method, url.pathname, body),
        );
      }),
    ),
  );

/** Upstream's GitHubRest with a Settings credential over the kit's HTTP client. */
const layerGitHubRest = GitHubRest.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      Layer.succeed(
        GitHubCredentials.GitHubCredentials,
        GitHubCredentials.GitHubCredentials.of({
          get: (host) =>
            Effect.succeed({
              host,
              token: Redacted.make("ghp_night_shift_test_token"),
              source: "settings" as const,
              fingerprint: `${host}:settings`,
            }),
          saved: () => Effect.succeedNone,
          fingerprint: (host, token) => Effect.succeed(`${host}:${token.length}`),
          invalidate: () => Effect.void,
        }),
      ),
      Layer.mock(GitHubAppSignIn.GitHubAppSignIn)({
        enabled: false,
        token: () => Effect.succeedNone,
        invalidate: () => Effect.void,
      }),
    ),
  ),
  Layer.provideMerge(GitHubQuota.layer),
  Layer.provideMerge(SourceControlRateLimit.layer),
);

/** The real VcsProcess, recording each git process's arguments and command-scope config keys. */
const layerRecordingVcs = (state: KitState) =>
  Layer.effect(
    VcsProcess.VcsProcess,
    Effect.gen(function* () {
      const real = yield* VcsProcess.VcsProcess;
      return VcsProcess.VcsProcess.of({
        run: (input) =>
          Effect.suspend(() => {
            const env = input.env ?? {};
            state.gitRuns.push({
              args: input.args,
              config: Object.keys(env)
                .filter((key) => key.startsWith("GIT_CONFIG_KEY_"))
                .map((key) => String(env[key])),
            });
            return real.run(input);
          }),
      });
    }),
  ).pipe(Layer.provide(VcsProcess.layer));

export interface KitOptions {
  readonly databaseFile?: string;
  /** Whether the runner recovers and ticks on its own, as in the server. */
  readonly serverRunner?: boolean;
  /** The server's base dir; a temporary one when absent. */
  readonly baseDir?: string;
  /** Whether the server runs as the desktop app's hosted server (v1's database sits beside it). */
  readonly hosted?: boolean;
}

export const makeKit = Effect.fn("NightShiftKit.make")(function* (
  name: string,
  options: KitOptions = {},
  state: KitState = freshState(),
) {
  const harness = yield* makeHarness(`night-${name}`, [CLAUDE, CODEX, OPENCODE, ANTIGRAVITY], {
    git: false,
  });
  const database =
    options.databaseFile === undefined
      ? SqlitePersistence.layerMemory.pipe(Layer.provide(Layer.empty))
      : SqlitePersistence.layerFromPath(options.databaseFile).pipe(
          Layer.provide(NodeServices.layer),
        );
  return { name, harness, state, database, options };
});

export type Kit = Effect.Success<ReturnType<typeof makeKit>>;

const layerThreads = (state: KitState) => {
  /** When each slow cancelled crew thread's run ends, on the test clock. */
  const endsAt = new Map<string, number>();
  const end = (threadId: string) => {
    const current = state.states.get(threadId);
    if (current !== undefined) {
      state.states.set(threadId, { ...current, activeRun: false, lastRunStatus: "cancelled" });
    }
  };
  return Layer.succeed(
    NightShiftThreads,
    NightShiftThreads.of({
      launch: (input) =>
        Effect.suspend(() => {
          state.ops.push("launch");
          state.launches.push(input);
          state.onLaunch(input);
          if (state.launchFailure !== null) return Effect.fail(state.launchFailure);
          if (state.launchHangs) return Effect.never;
          const threadId = ThreadId.make(`night-orchestrator:${state.launches.length}`);
          state.states.set(threadId, { present: true, activeRun: true, lastRunStatus: "running" });
          const branch =
            input.workspaceStrategy.type === "worktree"
              ? (input.workspaceStrategy.branch ?? null)
              : null;
          return Effect.succeed({
            threadId,
            worktreePath: `/worktrees/${String(branch).replaceAll("/", "-")}`,
            branch,
          });
        }),
      cancelCrew: (threadId) =>
        Effect.flatMap(Clock.currentTimeMillis, (nowMs) =>
          Effect.sync(() => {
            state.ops.push(`cancel:${threadId}`);
            const delay = state.cancelDelays.get(threadId);
            if (delay !== undefined) {
              endsAt.set(threadId, nowMs + delay * 1000);
              return;
            }
            end(threadId);
          }),
        ),
      stop: (threadId) =>
        Effect.sync(() => {
          state.ops.push(`stop:${threadId}`);
          const current = state.states.get(threadId);
          if (current !== undefined) {
            state.states.set(threadId, {
              ...current,
              activeRun: false,
              lastRunStatus: "interrupted",
            });
          }
        }),
      notify: (input) =>
        Effect.sync(() => {
          if (state.notes.some((note) => note.messageId === input.messageId)) return;
          state.ops.push(`notify:${input.messageId}`);
          state.notes.push({
            threadId: input.threadId,
            messageId: input.messageId,
            text: input.text,
          });
        }),
      taskStatus: (parentThreadId, taskId) =>
        Effect.sync(() => state.taskStatuses.get(`${parentThreadId}|${taskId}`) ?? null),
      workspace: (threadId) =>
        Effect.sync(() => {
          const known = state.workspaces.get(threadId);
          return { worktreePath: known?.worktreePath ?? null, branch: known?.branch ?? null };
        }),
      state: (threadId) =>
        Effect.flatMap(Clock.currentTimeMillis, (nowMs) =>
          Effect.sync(() => {
            const due = endsAt.get(threadId);
            if (due !== undefined && nowMs >= due) {
              endsAt.delete(threadId);
              end(threadId);
              state.ops.push(`ended:${threadId}`);
            }
            return (
              state.states.get(threadId) ?? {
                present: false,
                activeRun: false,
                lastRunStatus: null,
              }
            );
          }),
        ),
    }),
  );
};

const layerHostDoubles = (state: KitState) =>
  Layer.mergeAll(
    Layer.succeed(
      NightShiftMachine,
      NightShiftMachine.of({
        readings: () => Effect.sync(() => state.readings),
        onPath: (program) => Effect.sync(() => state.path.has(program)),
        timeZone: Effect.sync(() => state.timeZone),
      }),
    ),
    Layer.succeed(
      NightShiftProviders,
      NightShiftProviders.of({ list: Effect.sync(() => state.providers) }),
    ),
    Layer.succeed(
      NightShiftMergeQueue,
      NightShiftMergeQueue.of({
        verificationCommand: () => Effect.sync(() => state.verification),
        log: (_projectId, since) =>
          Effect.sync(() => state.queue.log.filter((row) => row.at >= since)),
      }),
    ),
    Layer.succeed(
      NightShiftCi,
      NightShiftCi.of({
        checks: (_projectId, _root, number) =>
          Effect.suspend(() => {
            state.ciReads.push(number);
            const checks = state.ciChecks.get(number);
            return checks === undefined
              ? Effect.fail(`GitHub could not be read for #${number}`)
              : Effect.succeed(checks);
          }),
      }),
    ),
    Layer.succeed(
      NightShiftLandingQueue,
      NightShiftLandingQueue.of({
        managedBranches: () => Effect.sync(() => new Set(state.managed) as ReadonlySet<string>),
        queued: () => Effect.sync(() => new Set(state.queue.queued) as ReadonlySet<number>),
        enqueue: (input) =>
          Effect.suspend(() => {
            if (state.queue.enqueueFailure !== null) {
              return Effect.fail(state.queue.enqueueFailure);
            }
            state.queue.ops.push(
              `enqueue:${input.number}:after:${input.dependsOn ?? "none"}:owner:${input.ownerThreadId}`,
            );
            state.queue.queued.add(input.number);
            return Effect.void;
          }),
        dequeue: (_projectId, number) =>
          Effect.sync(() => {
            state.queue.ops.push(`dequeue:${number}`);
            state.queue.queued.delete(number);
          }),
      }),
    ),
    Layer.succeed(
      NightShiftBacklog,
      NightShiftBacklog.of({
        tasks: (projectId) =>
          Effect.sync(() => state.backlog.filter((task) => task.projectId === projectId)),
        text: (key) =>
          Effect.sync(() => state.backlog.find((task) => task.key === key)?.text ?? ""),
        doneSince: (key) => Effect.sync(() => state.doneSince.has(key)),
        status: (key) => Effect.sync(() => state.backlogStatuses.get(key) ?? null),
        comment: (key, body, author) =>
          Effect.sync(() => {
            state.taskComments.push(`${key}|${author}|${body}`);
          }),
      }),
    ),
    Layer.succeed(
      NightShiftPullRequests,
      NightShiftPullRequests.of({
        state: (_projectId, _root, number) =>
          Effect.suspend(() => {
            state.pullRequestReads.push(number);
            const known = state.pullRequestStates.get(number);
            return known === undefined
              ? Effect.fail(`GitHub could not be read for #${number}`)
              : Effect.succeed(known);
          }),
      }),
    ),
  );

/** The real git over the fixtures, recording which call Night shift made. */
const layerRecordingGit = (state: KitState) =>
  Layer.effect(
    NightShiftGit.NightShiftGit,
    Effect.gen(function* () {
      const real = yield* NightShiftGit.NightShiftGit;
      return NightShiftGit.NightShiftGit.of({
        origin: (root) =>
          Effect.sync(() => state.gitCalls.push("origin")).pipe(Effect.andThen(real.origin(root))),
        defaultBranch: (root) =>
          Effect.sync(() => state.gitCalls.push("defaultBranch")).pipe(
            Effect.andThen(real.defaultBranch(root)),
          ),
        lsRemoteHeads: (root) =>
          Effect.sync(() => state.gitCalls.push("lsRemoteHeads")).pipe(
            Effect.andThen(real.lsRemoteHeads(root)),
          ),
      });
    }),
  ).pipe(Layer.provide(NightShiftGit.layer));

export const layerKeepAwake = (state: KitState) =>
  KeepAwake.layer.pipe(
    Layer.provide(
      Layer.succeed(KeepAwake.KeepAwakeSpawner, (command, args) => {
        if (state.spawnFailure !== null) throw new Error(state.spawnFailure);
        const child: Spawned = {
          command,
          args,
          stdinClosed: false,
          killed: false,
          stubborn: false,
        };
        state.spawns.push(child);
        return {
          closeStdin: () => {
            child.stdinClosed = true;
          },
          kill: () => {
            child.killed = true;
          },
          alive: () => !child.killed && (child.stubborn || !child.stdinClosed),
        };
      }),
    ),
    Layer.provide(Layer.succeed(HostProcess.Platform, "linux")),
  );

const layerOrchestration = (kit: Kit) =>
  ProviderReplayHarness.layerWithRegistry({ name: `night-${kit.name}` }, kit.harness.registry, {
    runEffectWorker: false,
    configureMcp: true,
    databaseLayer: kit.database,
    mcpSessionRegistry: Layer.succeed(
      McpSessionRegistry.McpSessionRegistry,
      McpSessionRegistry.McpSessionRegistry.of({
        issue: ({ threadId, providerInstanceId }) =>
          Effect.succeed({
            config: {
              environmentId: "environment:night" as never,
              threadId,
              providerSessionId: `mcp-test:${threadId}`,
              providerInstanceId,
              endpoint: "http://127.0.0.1/mcp",
              authorizationHeader: `Bearer mcp-test:${threadId}`,
              browserToolsAvailable: false,
            },
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

/** Everything a Night shift test reaches, over the kit's one database. */
export const layerKit = (kit: Kit) => {
  const { state } = kit;
  const ports = Layer.mergeAll(
    layerThreads(state),
    layerHostDoubles(state),
    layerRecordingGit(state),
    layerKeepAwake(state),
    Layer.succeed(Runner.SettleObserver, (step: string) => {
      state.settleSteps.push(step);
    }),
  );
  // The server's crew gate over the kit's store, readiness and threads.
  const runner = (kit.options.serverRunner === true ? Runner.layer : Runner.layerManual).pipe(
    Layer.provideMerge(CrewGate.layer),
    Layer.provideMerge(ports),
  );
  const nightShift = layerClaim.pipe(Layer.provideMerge(runner));
  const scheduledTasks = ScheduledTaskService.layer.pipe(
    Layer.provideMerge(layerHoustonScheduledTaskRunner.pipe(Layer.provideMerge(nightShift))),
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
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
  // Landing over the merge queue's slot and verifier, upstream's GitHubRest and the real git.
  const landing = Landing.layer.pipe(
    Layer.provideMerge(Layer.mergeAll(HoustonMergeVerifier.layer, HoustonBuildSlot.layer)),
    Layer.provideMerge(layerGitHubRest),
    Layer.provideMerge(layerRecordingVcs(state)),
  );
  return Service.layer.pipe(
    Layer.provideMerge(landing),
    Layer.provideMerge(scheduledTasks),
    Layer.provideMerge(Layer.mergeAll(RuntimeLayer.layerProjectService, ProjectStore.layer)),
    Layer.provideMerge(ProjectionStore.layer),
    Layer.provideMerge(kit.harness.registry.pipe(Layer.provide(McpProviderSessions.layer))),
    Layer.provideMerge(layerOrchestration(kit)),
    Layer.provideMerge(Layer.merge(Store.layer, HoustonHarnessStore.layer)),
    Layer.provideMerge(layerInstances(["claudeAgent", "codex", "opencode", "antigravity"])),
    Layer.provideMerge(ProjectEnrichmentService.layer),
    Layer.provideMerge(layerWorkspacePaths),
    Layer.provideMerge(layerProjectMetadata),
    Layer.provideMerge(kit.database),
    // A scheduled task's webhook policy is read from the machine-wide policy; unmanaged here.
    Layer.provideMerge(ManagedPolicy.layerTest()),
    Layer.provideMerge(ServerSettings.layerTest()),
    Layer.provideMerge(
      ServerConfig.layerTest(
        process.cwd(),
        kit.options.baseDir ?? { prefix: "houston-night-test-" },
      ),
    ),
    Layer.provideMerge(NodeServices.layer),
    Layer.provideMerge(Layer.succeed(HostedLaunch, kit.options.hosted ?? false)),
    Layer.provideMerge(layerRecordingHttp(state)),
  );
};

export type KitServices = Layer.Success<ReturnType<typeof layerKit>>;

/** Pins the test clock at NOW, then builds the kit. */
export const runKit = <A, E>(
  kit: Kit,
  body: Effect.Effect<A, E, KitServices | import("effect/Scope").Scope>,
  at: string | number = NOW,
) =>
  Effect.gen(function* () {
    const atMs = typeof at === "number" ? at : Date.parse(at);
    if (atMs > (yield* Clock.currentTimeMillis)) yield* TestClock.setTime(atMs);
    const context = yield* Layer.build(layerKit(kit));
    return yield* body.pipe(Effect.provideContext(context));
  }).pipe(Effect.scoped);

export const git = (cwd: string, ...args: ReadonlyArray<string>) =>
  NodeChildProcess.execFileSync("git", [...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Night",
      GIT_AUTHOR_EMAIL: "night@example.com",
      GIT_COMMITTER_NAME: "Night",
      GIT_COMMITTER_EMAIL: "night@example.com",
    },
  }).trim();

export interface Fixture {
  readonly root: string;
  readonly bare: string | null;
  readonly head: string;
}

/** A repository with one commit on main; its origin is a local bare repository or a URL. */
export const makeRepository = (
  name: string,
  origin: { readonly kind: "bare" } | { readonly kind: "url"; readonly url: string } | null,
  files: Record<string, string> = {},
): Fixture => {
  const base = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), `night-${name}-`));
  const root = NodePath.join(base, "work");
  NodeFS.mkdirSync(root);
  git(root, "init", "--quiet", "--initial-branch=main");
  for (const [file, content] of Object.entries({ "README.md": "# fixture\n", ...files })) {
    NodeFS.mkdirSync(NodePath.dirname(NodePath.join(root, file)), { recursive: true });
    NodeFS.writeFileSync(NodePath.join(root, file), content);
  }
  git(root, "add", ".");
  git(root, "commit", "--quiet", "-m", "init");
  const head = git(root, "rev-parse", "HEAD");
  let bare: string | null = null;
  if (origin?.kind === "bare") {
    bare = NodePath.join(base, "origin.git");
    git(base, "init", "--quiet", "--bare", "--initial-branch=main", bare);
    git(root, "remote", "add", "origin", bare);
    git(root, "push", "--quiet", "origin", "main");
    git(root, "fetch", "--quiet", "origin");
    git(root, "remote", "set-head", "origin", "main");
  } else if (origin?.kind === "url") {
    git(root, "remote", "add", "origin", origin.url);
  }
  return { root, bare, head };
};

/** Names `origin` as github.com `repository` while git still reaches the bare repository. */
export const githubOrigin = (fixture: Fixture, repository = "o/r") => {
  const url = `https://github.com/${repository}.git`;
  git(fixture.root, "remote", "set-url", "origin", url);
  git(fixture.root, "config", `url.${fixture.bare!}.insteadOf`, url);
  return url;
};

/** A worktree of the fixture on a new branch from main with one commit; answers its path and head. */
export const crewWorktree = (fixture: Fixture, branch: string) => {
  const path = NodePath.join(NodePath.dirname(fixture.root), branch.replaceAll("/", "-"));
  git(fixture.root, "worktree", "add", "--quiet", "-b", branch, path, "main");
  return { path, head: commitIn(path, `${branch} 1`) };
};

/** Commits one new file in `dir`; answers the new head. */
export const commitIn = (dir: string, label: string) => {
  NodeFS.writeFileSync(NodePath.join(dir, `${label.replaceAll(/[^a-z0-9]/gi, "-")}.txt`), label);
  git(dir, "add", ".");
  git(dir, "commit", "--quiet", "-m", label);
  return git(dir, "rev-parse", "HEAD");
};

/** Moves `branch` on the bare origin to a new commit made in a scratch clone. */
export const pushToOrigin = (fixture: Fixture, branch: string) => {
  const clone = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "night-clone-"));
  git(clone, "clone", "--quiet", fixture.bare!, "c");
  const dir = NodePath.join(clone, "c");
  git(dir, "checkout", "--quiet", "-B", branch);
  NodeFS.writeFileSync(NodePath.join(dir, `${branch.replaceAll("/", "-")}.txt`), branch);
  git(dir, "add", ".");
  git(dir, "commit", "--quiet", "-m", branch);
  git(dir, "push", "--quiet", "--force", "origin", `${branch}:refs/heads/${branch}`);
  return git(dir, "rev-parse", "HEAD");
};

let projectCommands = 0;

export const createProject = Effect.fn("NightShiftKit.createProject")(function* (
  name: string,
  root: string,
) {
  const projects = yield* ProjectService.ProjectService;
  projectCommands += 1;
  const projectId = ProjectId.make(`project-${name}`);
  yield* projects.create({
    commandId: CommandId.make(`command:night-test:create:${projectCommands}`),
    projectId,
    title: name,
    workspaceRoot: root,
  });
  return projectId;
});

export const deleteProject = Effect.fn("NightShiftKit.deleteProject")(function* (
  projectId: ProjectId,
) {
  const projects = yield* ProjectService.ProjectService;
  projectCommands += 1;
  yield* projects.delete({
    commandId: CommandId.make(`command:night-test:delete:${projectCommands}`),
    projectId,
  });
});

/** The scheduled task a project's Night shift runs as. */
export const nightTask = Effect.fn("NightShiftKit.nightTask")(function* (projectId: ProjectId) {
  const store = yield* Store.HoustonNightShiftStore;
  const scheduled = yield* ScheduledTaskService.ScheduledTaskService;
  const stored = yield* store.settings(projectId);
  const { tasks } = yield* scheduled.list();
  return tasks.find((task) => task.id === stored?.scheduledTaskId) as ScheduledTask | undefined;
});

/** Sets a project up as `create` does, for a bare local origin that `create` would refuse. */
export const seedNightShift = Effect.fn("NightShiftKit.seedNightShift")(function* (
  projectId: ProjectId,
  patch: Partial<HoustonNightShiftSettings> = {},
  schedule: { readonly timeOfDay: string; readonly weekdays: ReadonlyArray<number> } = {
    timeOfDay: "23:30",
    weekdays: [],
  },
) {
  const store = yield* Store.HoustonNightShiftStore;
  const scheduled = yield* ScheduledTaskService.ScheduledTaskService;
  const settings = {
    ...defaultSettings({
      orchestrator: model("claudeAgent"),
      checks: [{ command: "pnpm lint", source: "ci.yml · checks" }],
      startCommand: null,
    }),
    ...patch,
  };
  const created = yield* scheduled.upsert({
    title: `Night shift · ${projectId}`,
    prompt: Service.TASK_PROMPT,
    enabled: schedule.weekdays.length > 0 && settings.enabled,
    schedule: {
      type: "fixed_time",
      timeOfDay: schedule.timeOfDay,
      weekdays: [...schedule.weekdays],
    },
    projectId,
    workspaceStrategy: { type: "worktree", baseRef: "main" },
    modelSelection: settings.orchestrator,
    runtimeMode: "full-access",
    interactionMode: "default",
  });
  yield* store.createSettings({
    projectId,
    settings,
    scheduledTaskId: created.task.id,
    at: NOW,
  });
  return created.task;
});

export const LANDING_ORCHESTRATOR = ThreadId.make("land-orchestrator");
export const LANDING_WORKER = ThreadId.make("land-worker");
export const LANDING_REVIEWER = ThreadId.make("land-reviewer");

export interface LandingRun {
  readonly fixture: Fixture;
  readonly runId: number;
  readonly projectId: ProjectId;
  readonly worktree: { readonly path: string; readonly head: string };
}

/** A live run whose origin is a bare repository named github.com/o/r; a worker on `t3/fix-ws`. */
export const seedLandingRun = Effect.fn("NightShiftKit.seedLandingRun")(function* (
  kit: Kit,
  name: string,
  patch: Partial<HoustonNightShiftSettings> = {},
) {
  const fixture = makeRepository(name, { kind: "bare" });
  githubOrigin(fixture);
  const projectId = yield* createProject(name, fixture.root);
  yield* seedNightShift(projectId, { checks: [], ...patch });
  const store = yield* Store.HoustonNightShiftStore;
  const stored = yield* store.settings(projectId);
  const run = yield* store.openRun({
    projectId,
    trigger: "manual",
    scheduledTaskId: null,
    settings: stored!.settings,
    startedAt: NOW,
    wrapUpAt: "2026-10-31T06:45:00.000Z",
    hardStopAt: "2026-10-31T07:30:00.000Z",
    operation: "test",
  });
  const heads: Record<string, string> = {};
  for (const line of git(fixture.root, "ls-remote", "--heads", "origin").split("\n")) {
    const [sha, ref] = line.trim().split(/\s+/);
    if (sha !== undefined && ref !== undefined) heads[ref] = sha;
  }
  yield* store.markRunning(run.id, {
    threadId: LANDING_ORCHESTRATOR,
    worktreePath: "/worktrees/night",
    branch: `houston/night/${run.id}`,
    remoteHeads: heads,
  });
  const worktree = crewWorktree(fixture, "t3/fix-ws");
  kit.state.managed.add("t3/fix-ws");
  kit.state.managed.add(`houston/night/${run.id}`);
  for (const [threadId, role, branch] of [
    [LANDING_ORCHESTRATOR, "orchestrator", `houston/night/${run.id}`],
    [LANDING_WORKER, "implementation", "t3/fix-ws"],
    [LANDING_REVIEWER, "review", null],
  ] as const) {
    yield* store.addCrew({
      runId: run.id,
      threadId,
      taskId: role === "orchestrator" ? null : `task:${threadId}`,
      parentThreadId: role === "orchestrator" ? null : LANDING_ORCHESTRATOR,
      role,
      providerInstanceId: "claudeAgent",
      requestedInstanceId: null,
      worktreePath: branch === "t3/fix-ws" ? worktree.path : null,
      branch,
      startedAt: NOW,
      endedAt: null,
    });
  }
  return { fixture, runId: run.id, projectId, worktree } satisfies LandingRun;
});

/** `houston_night_pr`'s input for the worker's branch at its head. */
export const landingInput = (seeded: LandingRun, patch: Record<string, unknown> = {}) => ({
  runId: seeded.runId,
  callerThreadId: LANDING_ORCHESTRATOR,
  head: seeded.worktree.head,
  branch: "t3/fix-ws",
  title: "Fix the websocket retry",
  body: "Retries a dropped socket.",
  theme: "reliability",
  plans: [] as ReadonlyArray<number>,
  builtBy: [LANDING_WORKER] as ReadonlyArray<ThreadId>,
  visible: false,
  ...patch,
});

/** Runs effects the orchestrator queued, as the server's worker would. */
export const settleOrchestrator = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
  for (let round = 0; round < 4; round += 1) {
    yield* Effect.yieldNow;
    yield* worker.drain();
    yield* orchestrator.resumeQueuedRuns;
    yield* worker.drain();
  }
});

// @effect-diagnostics-next-line globalTimers:off - real time; the test clock does not move disk writes.
const realPause = Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 25)));

/** Waits, in real time, until a fired task's run has ended. */
export const awaitTask = Effect.fn("NightShiftKit.awaitTask")(function* (task: ScheduledTask) {
  const scheduled = yield* ScheduledTaskService.ScheduledTaskService;
  for (let attempt = 0; attempt < 400; attempt += 1) {
    yield* Effect.yieldNow;
    const { tasks } = yield* scheduled.list();
    const current = tasks.find((candidate) => candidate.id === task.id);
    if (
      current === undefined ||
      (current.runCount > task.runCount && current.lastRunStatus !== "running")
    ) {
      return current;
    }
    yield* realPause;
  }
  return undefined;
});

/** Moves the clock just past the task's next run and lets the scheduler poll fire it. */
export const fireDue = Effect.fn("NightShiftKit.fireDue")(function* (task: ScheduledTask) {
  if (task.nextRunAt === null) throw new Error(`task ${task.id} has no next run`);
  yield* TestClock.setTime(Date.parse(task.nextRunAt) + 1_000);
  yield* TestClock.adjust("6 seconds");
  return yield* awaitTask(task);
});

export const sql = SqlClient.SqlClient;
export const kindOf = (error: unknown) => (error as { readonly kind?: string }).kind;
export const messageOf = (error: unknown) => (error as { readonly message?: string }).message ?? "";

export { CrewGate, Landing, Runner, Service, Store };
