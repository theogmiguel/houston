// @effect-diagnostics nodeBuiltinImport:off - fixture repositories are built with git in temp dirs.
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
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
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
import * as ManagedProjectFolders from "../../project/ManagedProjectFolders.ts";
import * as ProjectEnrichmentService from "../../project/ProjectEnrichmentService.ts";
import * as ProjectService from "../../project/ProjectService.ts";
import * as ScheduledTaskService from "../../scheduledTasks/ScheduledTaskService.ts";
import * as Scheduler from "../../scheduling/Scheduler.ts";
import * as SecretRequests from "../../secrets/SecretRequests.ts";
import * as ServerSettings from "../../serverSettings.ts";
import { HostedLaunch } from "../baseDir.ts";
import * as HoustonHarnessStore from "../harnessReview/Store.ts";
import { ANTIGRAVITY, CLAUDE, CODEX, type DoubleSpec, makeHarness } from "../sideThreads.testkit.ts";
import { layerProjectMetadata, layerWorkspacePaths, layerInstances } from "../tasks/tasks.testkit.ts";
import * as NightShiftGit from "./Git.ts";
import {
  NightShiftMachine,
  NightShiftMergeQueue,
  NightShiftProviders,
  type MachineReadings,
  type ProviderState,
} from "./Host.ts";
import * as KeepAwake from "./KeepAwake.ts";
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
  /** In order: launch, cancel:<thread>, stop:<thread>, notify:<message id>. */
  readonly ops: Array<string>;
  readonly launches: Array<ThreadLaunchService.ThreadLaunchInput>;
  readonly notes: Array<Note>;
  readonly states: Map<string, ThreadState>;
  launchFailure: string | null;
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
}

const READY: ProviderReadiness = { state: "ready" };

export const freshState = (): KitState => ({
  ops: [],
  launches: [],
  notes: [],
  states: new Map(),
  launchFailure: null,
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
});

export interface KitOptions {
  readonly databaseFile?: string;
  /** Whether the runner recovers and ticks on its own, as in the server. */
  readonly serverRunner?: boolean;
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

const layerThreads = (state: KitState) =>
  Layer.succeed(
    NightShiftThreads,
    NightShiftThreads.of({
      launch: (input) =>
        Effect.suspend(() => {
          state.ops.push("launch");
          state.launches.push(input);
          state.onLaunch(input);
          if (state.launchFailure !== null) return Effect.fail(state.launchFailure);
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
        Effect.sync(() => {
          state.ops.push(`cancel:${threadId}`);
          const current = state.states.get(threadId);
          if (current !== undefined) {
            state.states.set(threadId, { ...current, activeRun: false, lastRunStatus: "cancelled" });
          }
        }),
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
      state: (threadId) =>
        Effect.sync(
          () =>
            state.states.get(threadId) ?? { present: false, activeRun: false, lastRunStatus: null },
        ),
    }),
  );

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
      NightShiftMergeQueue.of({ verificationCommand: () => Effect.sync(() => state.verification) }),
    ),
  );

/** The real git over the fixtures, recording which call Night shift made. */
const layerRecordingGit = (state: KitState) =>
  Layer.effect(
    NightShiftGit.NightShiftGit,
    Effect.gen(function* () {
      const real = yield* NightShiftGit.NightShiftGit;
      return NightShiftGit.NightShiftGit.of({
        origin: (root) => Effect.sync(() => state.gitCalls.push("origin")).pipe(Effect.andThen(real.origin(root))),
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
        const child: Spawned = { command, args, stdinClosed: false, killed: false, stubborn: false };
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
  const runner = (kit.options.serverRunner === true ? Runner.layer : Runner.layerManual).pipe(
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
  return Service.layer.pipe(
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
    Layer.provideMerge(ServerSettings.layerTest()),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "houston-night-test-" })),
    Layer.provideMerge(NodeServices.layer),
    Layer.provideMerge(Layer.succeed(HostedLaunch, false)),
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

const git = (cwd: string, ...args: ReadonlyArray<string>) =>
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
    schedule: { type: "fixed_time", timeOfDay: schedule.timeOfDay, weekdays: [...schedule.weekdays] },
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

export { Runner, Service, Store };
