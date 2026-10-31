// @effect-diagnostics nodeBuiltinImport:off - drives a real temporary git repository.
// Task runs over the real orchestrator, launcher and effect worker with sideThreads.testkit.ts's
// provider doubles; no CLI and no network, and the git double runs real `git worktree` commands.
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  MessageId,
  ProviderInstanceId,
  type ModelSelection,
  type ProjectId,
  type ThreadId,
} from "@t3tools/contracts";
import type {
  HoustonTask,
  HoustonTaskError,
  HoustonTaskPatch,
  HoustonTaskSettingsInput,
} from "@t3tools/contracts/houston/tasks";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { TestClock } from "effect/testing";

import * as GitWorkflow from "../../git/GitWorkflowService.ts";
import * as McpSessionRegistry from "../../mcp/McpSessionRegistry.ts";
import * as McpSessionRegistryTestkit from "../../mcp/McpSessionRegistry.testkit.ts";
import * as CommandReceiptStore from "../../orchestration-v2/CommandReceiptStore.ts";
import * as EffectWorker from "../../orchestration-v2/EffectWorker.ts";
import * as Orchestrator from "../../orchestration-v2/Orchestrator.ts";
import * as ThreadLaunch from "../../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import * as ProviderReplayHarness from "../../orchestration-v2/testkit/ProviderReplayHarness.ts";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import * as ManagedProjectFolders from "../../project/ManagedProjectFolders.ts";
import * as ProjectCloneTracker from "../../project/ProjectCloneTracker.ts";
import * as ProjectSetupScriptRunner from "../../project/ProjectSetupScriptRunner.ts";
import * as WorktreeSetupTracker from "../../project/WorktreeSetupTracker.ts";
import * as ProviderRegistryMock from "../../provider/testUtils/providerRegistryMock.ts";
import * as TerminalManager from "../../terminal/Manager.ts";
import * as Server from "../../server.ts";
import * as TextGeneration from "../../textGeneration/TextGeneration.ts";
import * as SideThreads from "../sideThreads.testkit.ts";
import * as HoustonTaskRuns from "./TaskRuns.ts";
import * as HoustonTaskService from "./TaskService.ts";
import { createProject, layerTasks } from "./tasks.testkit.ts";

export const { CLAUDE, CODEX, ANTIGRAVITY } = SideThreads;

/** `git` in `cwd`, trimmed; throws with git's stderr on a non-zero exit. */
export const git = (cwd: string, ...args: ReadonlyArray<string>): string =>
  execFileSync("git", ["-c", "core.autocrlf=false", ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();

/** Writes `lines` lines to `file` in `cwd` and commits them; returns the new head. */
export const commitLines = (cwd: string, file: string, lines: number, tag = file): string => {
  writeFileSync(
    join(cwd, file),
    Array.from({ length: lines }, (_, index) => `${tag} ${index}`).join("\n"),
  );
  git(cwd, "add", file);
  git(cwd, "commit", "-q", "-m", `change ${file}`);
  return git(cwd, "rev-parse", "HEAD");
};

/** A repository on `main` with one commit, and a bare `origin` it pushes to. */
const makeRepository = (name: string) => {
  const root = mkdtempSync(join(tmpdir(), `houston-task-runs-${name}-`));
  const repo = join(root, "repo");
  const origin = join(root, "origin.git");
  const worktrees = join(root, "worktrees");
  mkdirSync(repo);
  mkdirSync(worktrees);
  git(root, "init", "-q", "--bare", origin);
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.email", "tasks@houston.test");
  git(repo, "config", "user.name", "Houston test");
  git(repo, "config", "commit.gpgsign", "false");
  git(repo, "remote", "add", "origin", origin);
  commitLines(repo, "README.md", 1, "readme");
  git(repo, "push", "-q", "origin", "main");
  return { root, repo, origin, worktrees };
};

export const makeRunsHarness = Effect.fn("taskRunsHarness")(function* (
  name: string,
  specs: ReadonlyArray<SideThreads.DoubleSpec> = [CLAUDE, CODEX, ANTIGRAVITY],
) {
  const doubles = yield* SideThreads.makeHarness(`tasks-${name}`, specs, { git: false });
  return { name, doubles, ...makeRepository(name) };
});

export type RunsHarness = Effect.Success<ReturnType<typeof makeRunsHarness>>;

// The launcher's git double: real worktrees in the harness's worktree folder.
const layerGit = (harness: RunsHarness) =>
  Layer.mock(GitWorkflow.GitWorkflowService)({
    createWorktree: (input) =>
      Effect.sync(() => {
        const branch = input.newRefName ?? input.refName;
        const path = input.path ?? join(harness.worktrees, branch.replaceAll("/", "-"));
        git(input.cwd, "worktree", "add", "-q", "-b", branch, path, input.refName);
        return {
          worktree: { path, refName: branch, headSha: git(path, "rev-parse", "HEAD") },
        } as never;
      }),
    removeWorktree: (input) =>
      Effect.sync(() => {
        git(input.cwd, "worktree", "remove", "--force", input.path);
      }),
    hasCommit: (input) =>
      Effect.sync(() => {
        try {
          git(input.cwd, "rev-parse", "--verify", "--quiet", `${input.refName}^{commit}`);
          return true;
        } catch {
          return false;
        }
      }),
    hasRefNamed: () => Effect.succeed(false),
    resolveWorktreeBaseRemote: () => Effect.succeed(null),
    fetchWorktreeBaseCommit: () => Effect.succeed(null),
    renameBranch: (input) => Effect.succeed({ branch: input.newBranch }),
  });

const layerLaunchServices = (harness: RunsHarness) =>
  Layer.mergeAll(
    WorktreeSetupTracker.layer,
    Layer.mock(ProjectCloneTracker.ProjectCloneTracker)({ get: () => Effect.succeed(null) }),
    Layer.mock(TerminalManager.TerminalManager)({ close: () => Effect.void }),
    layerGit(harness),
    Layer.succeed(ProjectSetupScriptRunner.ProjectSetupScriptRunner, {
      runForThread: () => Effect.succeed({ status: "no-script" as const }),
    }),
    Layer.mock(TextGeneration.TextGeneration)({
      generateThreadTitle: () => Effect.succeed({ title: "unused" }),
      generateBranchName: () => Effect.succeed({ branch: "unused" }),
    }),
    ProviderRegistryMock.layer(),
    Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
      namedProjectsRoot: harness.root,
      isScratchProject: () => Effect.succeed(false),
      folderForThread: () => Effect.succeedNone,
    }),
  );

// Upstream's test credential, with the capabilities the real registry gives each request.
const layerScopedMcpRegistry = Layer.effect(
  McpSessionRegistry.McpSessionRegistry,
  Effect.gen(function* () {
    const base = yield* McpSessionRegistry.McpSessionRegistry;
    return McpSessionRegistry.McpSessionRegistry.of({
      ...base,
      issue: (request) =>
        Effect.map(base.issue(request), (issued) => ({
          config: {
            ...issued.config,
            capabilities: new Set(
              request.houstonTaskSubmitOnly === true
                ? ["houston-task-submit"]
                : ["orchestration", "worktree", "pull-requests", ...(request.capabilities ?? [])],
            ),
          },
        })),
    });
  }),
).pipe(Layer.provide(McpSessionRegistryTestkit.layer));

export interface RunsOptions {
  /** A database file that survives a restart; in memory when absent. */
  readonly databaseFile?: string;
  /** Boots as a restarted server: upstream's recovery settles runs whose provider is gone. */
  readonly restarted?: boolean;
}

const databaseOf = (options: RunsOptions) =>
  options.databaseFile === undefined
    ? SqlitePersistence.layerMemory
    : SqlitePersistence.layerFromPath(options.databaseFile).pipe(Layer.provide(NodeServices.layer));

const layerOrchestration = (
  harness: RunsHarness,
  options: RunsOptions,
  database: ReturnType<typeof databaseOf>,
) =>
  ProviderReplayHarness.layerWithRegistry(
    { name: `tasks-${harness.name}` },
    harness.doubles.registry,
    {
      databaseLayer: database,
      configureMcp: true,
      mcpSessionRegistry: layerScopedMcpRegistry,
      // The server's own provision, so a server that drops it fails these tests.
      readOnlyThreads: Server.layerHoustonTaskPersistence.pipe(
        Layer.provide(database),
        Layer.orDie,
      ),
      ...(options.restarted === true ? { recoverOnStartup: true } : { runEffectWorker: false }),
    },
  );

/** The threads alone over the runs' database file: what happens while task runs follow nothing. */
export const withThreadsOnly = <A, E, R>(
  harness: RunsHarness,
  body: (orchestrator: Orchestrator.OrchestratorV2["Service"]) => Effect.Effect<A, E, R>,
  options: RunsOptions & { readonly databaseFile: string },
) =>
  Effect.flatMap(Orchestrator.OrchestratorV2, body).pipe(
    Effect.provide(layerOrchestration(harness, options, databaseOf(options))),
  );

/** Everything a task run touches, over one database. */
export const layerRuns = (harness: RunsHarness, options: RunsOptions = {}) => {
  const database = databaseOf(options);
  const orchestration = layerOrchestration(harness, options, database);
  const tasks = layerTasks({ databaseLayer: database });
  const receipts = CommandReceiptStore.layer.pipe(Layer.provide(database));
  const threadManagement = ThreadManagement.layer.pipe(
    Layer.provide(Layer.mergeAll(orchestration, receipts, tasks)),
  );
  const launch = ThreadLaunch.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        layerLaunchServices(harness),
        threadManagement,
        receipts,
        IdAllocator.layer,
        tasks,
      ),
    ),
  );
  const registry = harness.doubles.registry.pipe(Layer.provide(McpProviderSessions.layer));
  const runs = HoustonTaskRuns.layer.pipe(
    Layer.provide(Layer.mergeAll(launch, orchestration, registry, threadManagement, tasks)),
  );
  return Layer.mergeAll(runs, tasks, orchestration, threadManagement, launch);
};

export const selection = (driver: string, model = "test-model"): ModelSelection => ({
  instanceId: ProviderInstanceId.make(driver),
  model,
});

// Async git and the launcher's background preparation need real event-loop turns.
const yieldToRuntime = Effect.yieldNow.pipe(
  Effect.andThen(Effect.promise(() => new Promise<void>((resolve) => setImmediate(resolve)))),
);

export interface RunsContext {
  readonly harness: RunsHarness;
  readonly projectId: ProjectId;
  readonly tasks: HoustonTaskService.HoustonTaskService["Service"];
  readonly runs: HoustonTaskRuns.HoustonTaskRuns["Service"];
  readonly orchestrator: Orchestrator.OrchestratorV2["Service"];
  /** Drains the effect worker, moves the clock and lets task runs follow the threads. */
  readonly settle: Effect.Effect<void>;
  /** Settles until `check` holds; dies naming `label` after a bounded number of rounds. */
  readonly until: <E>(label: string, check: Effect.Effect<boolean, E>) => Effect.Effect<void, E>;
  /** A `todo` task that is ready: it has the project and one acceptance item. */
  readonly readyTask: (
    title: string,
    patch?: HoustonTaskPatch,
  ) => Effect.Effect<HoustonTask, HoustonTaskError>;
  readonly setSettings: (
    settings: Partial<HoustonTaskSettingsInput>,
  ) => Effect.Effect<void, HoustonTaskError>;
  /** Sends a user message to a thread, as the composer would. */
  readonly send: (threadId: ThreadId, messageId: string, text: string) => Effect.Effect<void>;
}

let sentMessages = 0;

export const runWith = <A, E, R>(
  harness: RunsHarness,
  body: (context: RunsContext) => Effect.Effect<A, E, R>,
  options: RunsOptions & { readonly projectId?: ProjectId } = {},
) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
    const tasks = yield* HoustonTaskService.HoustonTaskService;
    const runs = yield* HoustonTaskRuns.HoustonTaskRuns;
    const projectId =
      options.projectId ?? (yield* createProject(`runs-${harness.name}`, harness.repo));
    const settle = Effect.gen(function* () {
      for (let round = 0; round < 4; round += 1) {
        for (let turn = 0; turn < 5; turn += 1) yield* yieldToRuntime;
        yield* worker.drain();
        yield* orchestrator.resumeQueuedRuns;
        yield* worker.drain();
        yield* TestClock.adjust("1 minute");
        yield* runs.catchUp;
      }
    }).pipe(Effect.orDie);
    const until: RunsContext["until"] = <E>(label: string, check: Effect.Effect<boolean, E>) =>
      Effect.gen(function* () {
        for (let round = 0; round < 60; round += 1) {
          if (yield* check) return;
          yield* settle;
        }
        return yield* Effect.die(`timed out waiting for ${label}`);
      });
    const readyTask: RunsContext["readyTask"] = (title, patch = {}) =>
      tasks.save({
        patch: { title, status: "todo", acceptance: ["it works"], projectId, ...patch },
      });
    const setSettings: RunsContext["setSettings"] = (settings) =>
      tasks
        .setSettings({
          projectId,
          settings: {
            access: "write",
            startModel: selection("claudeAgent"),
            delivery: "send",
            reviewer: null,
            focus: "bugs",
            reworkRounds: 0,
            ...settings,
          },
        })
        .pipe(Effect.asVoid);
    const send: RunsContext["send"] = (threadId, messageId, text) =>
      orchestrator
        .dispatch({
          type: "message.dispatch",
          commandId: CommandId.make(`test-send:${(sentMessages += 1)}`),
          threadId,
          messageId: MessageId.make(messageId),
          text,
          attachments: [],
          dispatchMode: { type: "start_immediately" },
          createdBy: "user",
          creationSource: "web",
        })
        .pipe(Effect.asVoid, Effect.orDie);
    return yield* body({
      harness,
      projectId,
      tasks,
      runs,
      orchestrator,
      settle,
      until,
      readyTask,
      setSettings,
      send,
    });
  }).pipe(Effect.provide(layerRuns(harness, options)));

/** The thread a task run runs as; fails when it has none. */
export const threadOf = (run: { readonly threadId: ThreadId | null }) =>
  run.threadId === null
    ? Effect.die(new Error("the run has no thread"))
    : Effect.succeed(run.threadId);
