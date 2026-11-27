// Bot runs over the real orchestrator, launcher and effect worker of the task runs' harness, with
// its provider doubles: no CLI and no network. Commands the follower dispatches are recorded.
import {
  GitCommandError,
  type OrchestrationV2ServerCommand,
  type ProjectId,
  ProviderInstanceId,
  type ServerSettings as ServerSettingsValue,
  type ThreadId,
} from "@houston-app/contracts";
import type { HoustonBot } from "@houston-app/contracts/houston/bots";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";

import * as EffectOutbox from "../../orchestration-v2/EffectOutbox.ts";
import * as EffectWorker from "../../orchestration-v2/EffectWorker.ts";
import * as Orchestrator from "../../orchestration-v2/Orchestrator.ts";
import * as ThreadLaunch from "../../orchestration-v2/ThreadLaunchService.ts";
import * as ProviderInstanceRegistry from "../../provider/ProviderInstanceRegistry.ts";
import * as ManagedProjectFolders from "../../project/ManagedProjectFolders.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as GitVcsDriver from "../../vcs/GitVcsDriver.ts";
import * as TaskRunsKit from "../tasks/taskRuns.testkit.ts";
import { createProject } from "../tasks/tasks.testkit.ts";
import { botInput, LAPTOP, setSwitch } from "./bots.testkit.ts";
import * as BotThreads from "./botThreads.ts";
import { makeLaunch } from "./Launch.ts";
import * as Runs from "./Runs.ts";
import * as Store from "./Store.ts";

export const CLAUDE_ACCOUNT = ProviderInstanceId.make("claudeAgent");

export const makeBotHarness = (name: string) =>
  TaskRunsKit.makeRunsHarness(`bots-${name}`, [TaskRunsKit.CLAUDE, TaskRunsKit.CODEX]);
export type BotHarness = TaskRunsKit.RunsHarness;

const layerAccounts = Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({
  getInstance: (instanceId) =>
    Effect.succeed(
      instanceId === "claudeAgent" || instanceId === "codex"
        ? ({ instanceId, driverKind: instanceId } as never)
        : undefined,
    ),
});

/** Every command the follower sends, in order. */
export const dispatched: Array<OrchestrationV2ServerCommand> = [];

/** Every launch the ask hands the launcher, in order. */
export const launched: Array<ThreadLaunch.ThreadLaunchInput> = [];

/** Counts what the follower looks up, so a test can prove an ordinary thread costs nothing. */
export interface BotObserve {
  readonly onShell?: (threadId: ThreadId) => void;
  readonly onPolicy?: (threadId: ThreadId) => void;
}

const layerRecordedOrchestrator = (observe: BotObserve | undefined) =>
  Layer.effect(
    Orchestrator.OrchestratorV2,
    Effect.map(Orchestrator.OrchestratorV2, (orchestrator) => ({
      ...orchestrator,
      dispatch: (command: OrchestrationV2ServerCommand) => {
        dispatched.push(command);
        return orchestrator.dispatch(command);
      },
      getThreadShell: (threadId: ThreadId) =>
        Effect.tap(orchestrator.getThreadShell(threadId), () =>
          Effect.sync(() => observe?.onShell?.(threadId)),
        ),
    })),
  );

const layerRecordedLauncher = Layer.effect(
  ThreadLaunch.ThreadLaunchService,
  Effect.map(ThreadLaunch.ThreadLaunchService, (service) => ({
    ...service,
    launch: (input: ThreadLaunch.ThreadLaunchInput) => {
      launched.push(input);
      return service.launch(input);
    },
  })),
);

// The workspace choice's Git facts, read from the harness's real temporary repositories.
const gitFailure = (operation: string, cwd: string) =>
  new GitCommandError({ operation, command: "git", cwd, detail: "test double" });

const layerWorkspaceGit = Layer.mock(GitVcsDriver.GitVcsDriver)({
  statusDetails: (cwd) =>
    Effect.sync(() => {
      try {
        TaskRunsKit.git(cwd, "rev-parse", "--is-inside-work-tree");
        return { isRepo: true } as never;
      } catch {
        return { isRepo: false } as never;
      }
    }),
  resolvePrimaryRemoteName: (cwd) =>
    Effect.try(() => {
      const remotes = TaskRunsKit.git(cwd, "remote")
        .split("\n")
        .filter((name) => name.length > 0);
      const remote = remotes.includes("origin") ? "origin" : remotes[0];
      if (remote === undefined) throw new Error("no remote is configured");
      return remote;
    }).pipe(Effect.mapError(() => gitFailure("resolvePrimaryRemoteName", cwd))),
  resolveDefaultBranchName: (cwd, remoteName) =>
    Effect.sync(() => {
      try {
        const ref = TaskRunsKit.git(cwd, "symbolic-ref", `refs/remotes/${remoteName}/HEAD`);
        const prefix = `refs/remotes/${remoteName}/`;
        return ref.startsWith(prefix) ? ref.slice(prefix.length) : null;
      } catch {
        return null;
      }
    }),
  resolveCommit: (input) =>
    Effect.try(() => {
      TaskRunsKit.git(input.cwd, "rev-parse", "--verify", "--quiet", `${input.revision}^{commit}`);
      return {} as never;
    }).pipe(Effect.mapError(() => gitFailure("resolveCommit", input.cwd))),
  resolveBranchName: (cwd, refName) =>
    Effect.sync(() => {
      try {
        const ref = TaskRunsKit.git(cwd, "rev-parse", "--symbolic-full-name", "--verify", refName);
        return ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : null;
      } catch {
        return null;
      }
    }),
});

const layerWorkspaceFolders = (harness: BotHarness) =>
  Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
    namedProjectsRoot: `${harness.root}/projects`,
    isScratchProject: () => Effect.succeed(false),
    folderForThread: () => Effect.succeedNone,
  });

const layerObservedBotThreads = (observe: BotObserve | undefined) =>
  Layer.effect(
    BotThreads.HoustonBotThreads,
    Effect.map(BotThreads.HoustonBotThreads, (threads) => ({
      ...threads,
      policyOf: (thread) =>
        Effect.tap(threads.policyOf(thread), () =>
          Effect.sync(() => observe?.onPolicy?.(thread.id)),
        ),
    })),
  ).pipe(Layer.provide(BotThreads.layer));

// The harness's settings publish no changes; the follower must see the switch move, as in the server.
// The switch is as a restarted server finds it stored, before the follower recovers.
const layerPublishedSettings = (on: boolean) =>
  Layer.effect(
    ServerSettings.ServerSettingsService,
    Effect.gen(function* () {
      const settings = yield* ServerSettings.ServerSettingsService;
      if (on) yield* Effect.orDie(settings.updateSettings({ botsEnabled: true }));
      const changes = yield* PubSub.unbounded<ServerSettingsValue>();
      return {
        ...settings,
        updateSettings: (patch) =>
          Effect.tap(settings.updateSettings(patch), (next) => PubSub.publish(changes, next)),
        streamChanges: Stream.fromPubSub(changes),
        subscribeChanges: Effect.map(PubSub.subscribe(changes), Stream.fromSubscription),
      } satisfies ServerSettings.ServerSettingsService["Service"];
    }),
  );

export interface BotHarnessOptions extends TaskRunsKit.RunsOptions {
  readonly on?: boolean;
  readonly observe?: BotObserve;
  /** Replaces the real store, for a test that needs a stale read. */
  readonly store?: Layer.Layer<Store.HoustonBotStore>;
}

const layerBotRuns = (harness: BotHarness, options: BotHarnessOptions) => {
  const base = Layer.merge(
    TaskRunsKit.layerRuns(harness, options),
    Layer.merge(layerWorkspaceGit, layerWorkspaceFolders(harness)),
  );
  const runs = Runs.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        layerAccounts,
        layerRecordedOrchestrator(options.observe),
        EffectOutbox.layer,
        layerRecordedLauncher,
      ),
    ),
    Layer.provideMerge(options.store ?? Store.layer),
    Layer.provide(layerObservedBotThreads(options.observe)),
    Layer.provideMerge(layerPublishedSettings(options.on !== false)),
    Layer.provideMerge(base),
  );
  return runs;
};

const yieldToRuntime = Effect.yieldNow.pipe(
  Effect.andThen(Effect.promise(() => new Promise<void>((resolve) => setImmediate(resolve)))),
);

export interface BotContext {
  readonly harness: BotHarness;
  readonly projectId: ProjectId;
  readonly runs: Runs.HoustonBotRuns["Service"];
  readonly store: Store.HoustonBotStore["Service"];
  readonly orchestrator: Orchestrator.OrchestratorV2["Service"];
  /** Drains the effect worker, moves the clock and lets the follower read the threads. */
  readonly settle: Effect.Effect<void>;
  readonly until: <E, R>(
    label: string,
    check: Effect.Effect<boolean, E, R>,
  ) => Effect.Effect<void, E, R>;
  /** A bot on the Claude double, switched on, whose default project is the harness's. */
  readonly makeBot: (overrides?: Parameters<typeof botInput>[0]) => Effect.Effect<HoustonBot>;
  readonly launch: Effect.Success<typeof makeLaunch>;
}

export const runBots = <A, E, R>(
  harness: BotHarness,
  body: (context: BotContext) => Effect.Effect<A, E, R>,
  options: BotHarnessOptions & {
    readonly projectId?: ProjectId;
    /** Replaces the launcher for a test of a launch that fails. */
    readonly launcher?: Layer.Layer<ThreadLaunch.ThreadLaunchService>;
  } = {},
) =>
  Effect.gen(function* () {
    if (options.on !== false) yield* setSwitch(true);
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
    const runs = yield* Runs.HoustonBotRuns;
    const store = yield* Store.HoustonBotStore;
    const launch = yield* makeLaunch.pipe(
      Effect.provide(
        options.launcher === undefined
          ? layerAccounts
          : Layer.merge(layerAccounts, options.launcher),
      ),
    );
    const projectId =
      options.projectId ?? (yield* createProject(`bots-${harness.name}`, harness.repo));
    const settle = Effect.gen(function* () {
      for (let round = 0; round < 4; round += 1) {
        for (let turn = 0; turn < 5; turn += 1) yield* yieldToRuntime;
        yield* worker.drain();
        yield* orchestrator.resumeQueuedRuns;
        yield* worker.drain();
        yield* TestClock.adjust("1 second");
        yield* runs.catchUp;
      }
    }).pipe(Effect.orDie);
    const until: BotContext["until"] = <E, R>(label: string, check: Effect.Effect<boolean, E, R>) =>
      Effect.gen(function* () {
        for (let round = 0; round < 60; round += 1) {
          if (yield* check) return;
          yield* settle;
        }
        return yield* Effect.die(`timed out waiting for ${label}`);
      });
    const makeBot: BotContext["makeBot"] = (overrides = {}) =>
      Effect.gen(function* () {
        const saved = yield* store.save(
          botInput({
            defaultProjectId: projectId,
            modelSelection: { instanceId: CLAUDE_ACCOUNT, model: "test-model" },
            ...overrides,
          }),
          LAPTOP,
        );
        return yield* store.setEnabled({ botId: saved.id, enabled: true });
      }).pipe(Effect.orDie);
    return yield* body({
      harness,
      projectId,
      runs,
      store,
      orchestrator,
      settle,
      until,
      makeBot,
      launch,
    });
  }).pipe(Effect.provide(layerBotRuns(harness, options)));
