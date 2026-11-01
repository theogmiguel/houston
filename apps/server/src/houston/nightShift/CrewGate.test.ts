// @effect-diagnostics nodeBuiltinImport:off - reads two upstream handlers for the gate call.
// The crew gate over the real Night shift store and upstream's OrchestratorMcpService; threads,
// readiness and the dispatch are doubles, so each test sees exactly what would have started.
import * as NodeFS from "node:fs";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  EnvironmentId,
  NodeId,
  OrchestratorMcpFailure,
  type OrchestrationV2ThreadProjection,
  type OrchestratorMcpDelegateTaskInput,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  type ServerProvider,
  ThreadId,
} from "@t3tools/contracts";
import type { HoustonNightShiftSettings } from "@t3tools/contracts/houston/nightShift";
import type { ProviderReadiness } from "@t3tools/contracts/houston/providerReadiness";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { McpSchema, McpServer } from "effect/ai";

import * as ServerConfig from "../../config.ts";
import * as McpHttpServer from "../../mcp/McpHttpServer.ts";
import type { McpInvocationScope } from "../../mcp/McpInvocationContext.ts";
import * as McpInvocationContext from "../../mcp/McpInvocationContext.ts";
import { liveThreadShell } from "../../mcp/McpToolAccess.testkit.ts";
import * as OrchestratorMcpService from "../../mcp/OrchestratorMcpService.ts";
import * as ProviderAdapterRegistry from "../../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ThreadLaunchService from "../../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../../orchestration-v2/ThreadManagementService.ts";
import * as RemoteDelegation from "../../peer/RemoteDelegation.ts";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import * as ProjectService from "../../project/ProjectService.ts";
import * as ProviderRegistry from "../../provider/ProviderRegistry.ts";
import * as ScheduledTaskService from "../../scheduledTasks/ScheduledTaskService.ts";
import * as SecretRequests from "../../secrets/SecretRequests.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as GitVcsDriver from "../../vcs/GitVcsDriver.ts";
import { HoustonMergeQueueProject } from "../mergeQueue/Project.ts";
import { HoustonMergeQueueService } from "../mergeQueue/Service.ts";
import { HoustonTaskRuns } from "../tasks/TaskRuns.ts";
import { HoustonTaskService } from "../tasks/TaskService.ts";
import * as CrewGate from "./CrewGate.ts";
import { NightShiftProviders } from "./Host.ts";
import { defaultSettings } from "./rules.ts";
import * as Store from "./Store.ts";
import { NightShiftThreads } from "./Threads.ts";

const NOW = "2026-10-30T22:00:00.000Z";
const projectId = ProjectId.make("project:night-crew");
const ORCHESTRATOR = ThreadId.make("night-orchestrator");
const OUTSIDER = ThreadId.make("outside-thread");

const selection = (instance: string) => ({
  instanceId: ProviderInstanceId.make(instance),
  model: "m",
});

const settingsWith = (
  patch: Partial<HoustonNightShiftSettings> = {},
): HoustonNightShiftSettings => ({
  ...defaultSettings({ orchestrator: selection("claudeAgent"), checks: [], startCommand: null }),
  workers: [selection("codex"), selection("claudeAgent")],
  ...patch,
});

interface Dispatched {
  readonly parentThreadId: string;
  readonly childThreadId: string;
  readonly taskId: string;
  readonly instanceId: string;
  readonly workspaceStrategy: unknown;
}

interface World {
  readonly dispatched: Array<Dispatched>;
  /** Calls that would create, schedule, link, execute or enqueue: what a refusal must not reach. */
  readonly calls: Array<string>;
  readonly subagents: Map<string, Array<unknown>>;
  /** Each thread that may call, with the instance its provider session runs. */
  readonly callers: Map<string, string>;
  readonly notes: Array<{ readonly messageId: string; readonly text: string }>;
  readonly taskStatuses: Map<string, string>;
  readonly workspaces: Map<string, { readonly worktreePath: string; readonly branch: string }>;
  readonly readiness: Map<string, ProviderReadiness>;
  /** A dispatch that never answers, so a test can interrupt a delegation mid-flight. */
  hang: boolean;
  /** Completed when a hanging dispatch has been reached. */
  hung: Deferred.Deferred<void> | null;
  /** Completing it lets a hanging dispatch answer; null hangs forever. */
  release: Deferred.Deferred<void> | null;
  /** A dispatch that fails, so a test sees the slot released on failure. */
  failDispatch: boolean;
  children: number;
}

const freshWorld = (): World => ({
  dispatched: [],
  calls: [],
  subagents: new Map(),
  callers: new Map([
    [ORCHESTRATOR, "claudeAgent"],
    [OUTSIDER, "claudeAgent"],
  ]),
  notes: [],
  taskStatuses: new Map(),
  workspaces: new Map([
    [ORCHESTRATOR, { worktreePath: "/worktrees/night-1", branch: "houston/night/1" }],
  ]),
  readiness: new Map(["codex", "claudeAgent", "opencode"].map((id) => [id, { state: "ready" }])),
  hang: false,
  hung: null,
  release: null,
  failDispatch: false,
  children: 0,
});

const scopeOf = (world: World, threadId: ThreadId): McpInvocationScope => ({
  environmentId: EnvironmentId.make("environment:night-crew"),
  requestNamespace: `provider-session:${threadId}`,
  thread: {
    threadId,
    providerSessionId: `provider-session:${threadId}`,
    providerInstanceId: ProviderInstanceId.make(world.callers.get(threadId) ?? "claudeAgent"),
  },
  client: undefined,
  capabilities: new Set(["orchestration", "worktree", "pull-requests"]),
  issuedAt: 1,
});

const projectionOf = (world: World, threadId: string): OrchestrationV2ThreadProjection => {
  const instance = ProviderInstanceId.make(world.callers.get(threadId) ?? "claudeAgent");
  const modelSelection = { instanceId: instance, model: "m" };
  return {
    thread: {
      id: threadId,
      projectId,
      title: threadId,
      createdBy: "agent",
      creationSource: "mcp",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      worktreePath: world.workspaces.get(threadId)?.worktreePath ?? null,
    },
    runs: [
      {
        id: RunId.make(`run:${threadId}`),
        ordinal: 1,
        status: "running",
        rootNodeId: NodeId.make(`node:${threadId}`),
        providerInstanceId: instance,
        modelSelection,
      },
    ],
    contextTransfers: [],
    messages: [],
    providerThreads: [],
    runtimeRequests: [],
    turnItems: [],
    nodes: [],
    subagents: world.subagents.get(threadId) ?? [],
  } as unknown as OrchestrationV2ThreadProjection;
};

const providerSnapshot = (instance: string, driver: string): ServerProvider => ({
  instanceId: ProviderInstanceId.make(instance),
  driver: ProviderDriverKind.make(driver),
  enabled: true,
  installed: true,
  version: "test",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: NOW,
  models: [{ slug: "m", name: "m", isCustom: false, capabilities: null }],
  slashCommands: [],
  skills: [],
});

const PROVIDERS = [
  providerSnapshot("codex", "codex"),
  providerSnapshot("claudeAgent", "claudeAgent"),
  providerSnapshot("opencode", "opencode"),
];

const layerThreadManagement = (world: World) =>
  Layer.mock(ThreadManagementService.ThreadManagementService)({
    hasReceipt: () => Effect.succeed(false),
    isProviderInstanceEnabledForProject: () => Effect.succeed(true),
    assertProviderInstanceEnabled: () => Effect.void,
    getThreadShell: (threadId) => {
      const instance = ProviderInstanceId.make(world.callers.get(threadId) ?? "claudeAgent");
      return Effect.succeed({
        ...liveThreadShell(threadId),
        projectId,
        providerInstanceId: instance,
        modelSelection: { instanceId: instance, model: "m" },
      });
    },
    getThreadRecords: (threadId) => Effect.succeed(projectionOf(world, threadId)),
    dispatch: (command) =>
      Effect.suspend(() => {
        if (command.type !== "delegated_task.request") {
          world.calls.push(command.type);
          return Effect.die(`the test answers no ${command.type}`);
        }
        if (world.failDispatch) return Effect.die("the dispatch failed");
        world.children += 1;
        const childThreadId = `night-child-${world.children}`;
        const taskId = `task-${world.children}`;
        const instanceId = command.modelSelection.instanceId;
        world.dispatched.push({
          parentThreadId: command.parentThreadId,
          childThreadId,
          taskId,
          instanceId,
          workspaceStrategy: command.workspaceStrategy,
        });
        const answer = Effect.sync(() => {
          world.callers.set(childThreadId, instanceId);
          if (command.workspaceStrategy !== undefined) {
            world.workspaces.set(childThreadId, {
              worktreePath: `/worktrees/${childThreadId}`,
              branch: `t3/${childThreadId}`,
            });
          }
          const task = {
            id: NodeId.make(taskId),
            threadId: command.parentThreadId,
            runId: RunId.make(`run:${command.parentThreadId}`),
            parentNodeId: NodeId.make(`node:${command.parentThreadId}`),
            origin: "app_owned",
            createdBy: "agent",
            driver: ProviderDriverKind.make(
              instanceId === "claudeAgent" ? "claudeAgent" : instanceId,
            ),
            providerInstanceId: instanceId,
            providerThreadId: null,
            childThreadId: ThreadId.make(childThreadId),
            nativeTaskRef: null,
            prompt: command.task,
            title: null,
            model: "m",
            status: "running",
            result: null,
            startedAt: null,
            completedAt: null,
          };
          world.subagents.set(command.parentThreadId, [
            ...(world.subagents.get(command.parentThreadId) ?? []),
            task,
          ]);
          return {
            sequence: 1,
            storedEvents: [
              { sequence: 1, commandId: null, event: { type: "subagent.updated", payload: task } },
            ],
          } as never;
        });
        if (world.hang) {
          // The command is accepted; its answer waits until the test releases it.
          const release = world.release;
          return (world.hung === null ? Effect.void : Deferred.succeed(world.hung, undefined)).pipe(
            Effect.andThen(release === null ? Effect.never : Deferred.await(release)),
            Effect.andThen(answer),
          );
        }
        return answer;
      }),
  });

const layerNightPorts = (world: World) =>
  Layer.mergeAll(
    Layer.succeed(
      NightShiftProviders,
      NightShiftProviders.of({
        list: Effect.sync(() =>
          PROVIDERS.map((provider) => ({
            instanceId: provider.instanceId,
            driver: provider.driver,
            readiness: world.readiness.get(provider.instanceId),
          })),
        ),
      }),
    ),
    Layer.mock(NightShiftThreads)({
      notify: (input) =>
        Effect.sync(() => {
          if (world.notes.some((note) => note.messageId === input.messageId)) return;
          world.notes.push({ messageId: input.messageId, text: input.text });
        }),
      taskStatus: (parent, task) =>
        Effect.sync(() => world.taskStatuses.get(`${parent}|${task}`) ?? null),
      workspace: (threadId) =>
        Effect.sync(() => {
          const known = world.workspaces.get(threadId);
          return { worktreePath: known?.worktreePath ?? null, branch: known?.branch ?? null };
        }),
    }),
  );

const layerStore = Store.layer.pipe(
  Layer.provideMerge(SqlitePersistence.layerMemory),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "houston-night-crew-" })),
  Layer.provideMerge(NodeServices.layer),
);

const layerGate = (world: World) =>
  CrewGate.layer.pipe(Layer.provideMerge(layerNightPorts(world)), Layer.provideMerge(layerStore));

const layerService = (world: World) =>
  OrchestratorMcpService.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        layerThreadManagement(world),
        Layer.mock(ProviderRegistry.ProviderRegistry)({
          getProviders: Effect.succeed(PROVIDERS),
          refreshInstance: () => Effect.succeed(PROVIDERS),
        }),
        Layer.succeed(
          ProviderAdapterRegistry.ProviderAdapterRegistryV2,
          ProviderAdapterRegistry.ProviderAdapterRegistryV2.of({
            list: () => Effect.succeed(PROVIDERS.map((provider) => provider.instanceId)),
            get: (instanceId) =>
              Effect.succeed({
                instanceId,
              } as unknown as ProviderAdapter.ProviderAdapterV2["Service"]),
          }),
        ),
        Layer.mock(GitVcsDriver.GitVcsDriver)({
          resolveCommit: () => Effect.succeed({ commitSha: "a".repeat(40) } as never),
        }),
        Layer.mock(ThreadLaunchService.ThreadLaunchService)({ prepareRun: () => Effect.void }),
        Layer.mock(ProjectService.ProjectService)({
          getById: () =>
            Effect.succeed(
              Option.some({
                id: projectId,
                title: "night crew",
                workspaceRoot: "/repo",
                defaultModelSelection: null,
              }) as never,
            ),
        }),
        Layer.mock(SecretRequests.SecretRequests)({}),
        Layer.mock(RemoteDelegation.RemoteDelegation)({}),
        Layer.mock(ScheduledTaskService.ScheduledTaskService)({
          upsert: () =>
            Effect.sync(() => world.calls.push("upsert")).pipe(
              Effect.andThen(Effect.die("no upsert")),
            ),
          delete: () =>
            Effect.sync(() => world.calls.push("delete")).pipe(
              Effect.andThen(Effect.die("no delete")),
            ),
        }),
        ServerSettings.layerTest(),
        NodeServices.layer,
      ),
    ),
    Layer.provideMerge(layerGate(world)),
  );

/** A live run whose orchestrator is ORCHESTRATOR, with `settings`. */
const seedRun = (settings: HoustonNightShiftSettings) =>
  Effect.gen(function* () {
    const store = yield* Store.HoustonNightShiftStore;
    const run = yield* store.openRun({
      projectId,
      trigger: "manual",
      scheduledTaskId: null,
      settings,
      startedAt: NOW,
      wrapUpAt: "2026-10-31T06:45:00.000Z",
      hardStopAt: "2026-10-31T07:30:00.000Z",
      operation: "test",
    });
    yield* store.markRunning(run.id, {
      threadId: ORCHESTRATOR,
      worktreePath: "/worktrees/night-1",
      branch: "houston/night/1",
      remoteHeads: null,
    });
    yield* store.addCrew({
      runId: run.id,
      threadId: ORCHESTRATOR,
      taskId: null,
      parentThreadId: null,
      role: "orchestrator",
      providerInstanceId: "claudeAgent",
      requestedInstanceId: null,
      worktreePath: "/worktrees/night-1",
      branch: "houston/night/1",
      startedAt: NOW,
      endedAt: null,
    });
    return run.id;
  });

const delegate = (
  world: World,
  caller: ThreadId,
  input: Partial<OrchestratorMcpDelegateTaskInput>,
) =>
  Effect.flatMap(OrchestratorMcpService.OrchestratorMcpService, (service) =>
    service.delegateTask(scopeOf(world, caller), {
      task: "Do the work.",
      mode: "async",
      ...input,
    }),
  );

const refusedWith = <A, E, R>(effect: Effect.Effect<A, E, R>, ...parts: ReadonlyArray<string>) =>
  Effect.map(Effect.flip(effect), (error) => {
    const message = String((error as { readonly message?: string }).message ?? error);
    assert.include(message, "Night shift: ", message);
    for (const part of parts) assert.include(message, part, message);
    return message;
  });

const crewOf = (runId: number) =>
  Effect.flatMap(Store.HoustonNightShiftStore, (store) => store.crew(runId));

const worker = (overrides: Partial<OrchestratorMcpDelegateTaskInput> = {}) => ({
  role: "implementation" as const,
  isolation: "worktree" as const,
  ...overrides,
});

describe("the crew gate", () => {
  it.effect("the crew is recorded when a delegation returns", () => {
    const world = freshWorld();
    return Effect.gen(function* () {
      const runId = yield* seedRun(settingsWith());
      const child = yield* delegate(
        world,
        ORCHESTRATOR,
        worker({ target: { providerInstanceId: ProviderInstanceId.make("codex") } }),
      );
      const general = yield* delegate(world, ORCHESTRATOR, { isolation: "worktree" });
      // A worker's own delegation is a grandchild of the run, recorded in the same run.
      const grandchild = yield* delegate(world, child.childThreadId!, worker());

      const crew = yield* crewOf(runId);
      const row = (threadId: string | null) => crew.find((member) => member.threadId === threadId)!;
      assert.deepInclude(row(child.childThreadId), {
        runId,
        taskId: String(child.taskId),
        parentThreadId: ORCHESTRATOR,
        role: "implementation",
        providerInstanceId: "codex",
        requestedInstanceId: "codex",
        worktreePath: `/worktrees/${child.childThreadId}`,
        branch: `t3/${child.childThreadId}`,
        endedAt: null,
      });
      assert.equal(row(general.childThreadId).role, "general");
      assert.equal(row(general.childThreadId).requestedInstanceId, "claudeAgent", "inherited");
      assert.equal(row(grandchild.childThreadId).parentThreadId, child.childThreadId);
      assert.equal(row(grandchild.childThreadId).runId, runId);
      assert.lengthOf(crew, 4, "the orchestrator and three delegated threads");

      // A delegated task's terminal status ends its member.
      world.taskStatuses.set(`${ORCHESTRATOR}|${child.taskId}`, "completed");
      yield* (yield* CrewGate.HoustonCrewGate).refresh(runId);
      const after = yield* crewOf(runId);
      assert.isNotNull(after.find((member) => member.threadId === child.childThreadId)!.endedAt);
      assert.isNull(after.find((member) => member.threadId === general.childThreadId)!.endedAt);

      // Each of the four terminal statuses ends its member and frees its slot (4 live workers).
      yield* delegate(world, ORCHESTRATOR, worker());
      let last = yield* delegate(world, ORCHESTRATOR, worker());
      for (const status of ["completed", "failed", "cancelled", "interrupted"]) {
        yield* refusedWith(delegate(world, ORCHESTRATOR, worker()), "4 of 4 live workers");
        world.taskStatuses.set(`${ORCHESTRATOR}|${last.taskId}`, status);
        yield* (yield* CrewGate.HoustonCrewGate).refresh(runId);
        const ended = (yield* crewOf(runId)).find(
          (member) => member.threadId === last.childThreadId,
        )!;
        assert.isNotNull(ended.endedAt, `a ${status} task ends its member`);
        last = yield* delegate(world, ORCHESTRATOR, worker());
        assert.isNotNull(last.childThreadId, `a ${status} task frees its slot`);
      }
    }).pipe(Effect.provide(layerService(world)));
  });

  it.effect("live workers and the review and test slots are capped", () => {
    const world = freshWorld();
    return Effect.gen(function* () {
      const runId = yield* seedRun(settingsWith({ liveWorkers: 4 }));
      const workers = [];
      for (let index = 0; index < 4; index += 1) {
        workers.push(yield* delegate(world, ORCHESTRATOR, worker()));
      }
      const before = world.dispatched.length;
      yield* refusedWith(delegate(world, ORCHESTRATOR, worker()), "4 of 4 live workers");
      yield* refusedWith(
        delegate(world, ORCHESTRATOR, { role: "research", isolation: "shared" }),
        "4 of 4 live workers",
      );
      assert.equal(world.dispatched.length, before, "no child started");

      // Review and test have slots of their own.
      yield* delegate(world, ORCHESTRATOR, { role: "review", isolation: "shared" });
      yield* refusedWith(
        delegate(world, ORCHESTRATOR, { role: "review", isolation: "shared" }),
        "1 of 1 live review",
      );
      yield* delegate(world, ORCHESTRATOR, { role: "test", isolation: "worktree" });
      assert.equal(world.dispatched.length, before + 2);

      // Once a worker's task ends, a new one is accepted.
      world.taskStatuses.set(`${ORCHESTRATOR}|${workers[0]!.taskId}`, "failed");
      yield* delegate(world, ORCHESTRATOR, worker());
      const live = (yield* crewOf(runId)).filter(
        (member) => member.role === "implementation" && member.endedAt === null,
      );
      assert.lengthOf(live, 4);

      // The caps hold while the run wraps up.
      assert.isTrue(yield* (yield* Store.HoustonNightShiftStore).markWrappingUp(runId, NOW));
      const started = world.dispatched.length;
      yield* refusedWith(delegate(world, ORCHESTRATOR, worker()), "4 of 4 live workers");
      assert.equal(world.dispatched.length, started, "no child started while wrapping up");
    }).pipe(Effect.provide(layerService(world)));
  });

  it.effect("a held slot is released on every exit, interruption included", () => {
    const world = freshWorld();
    return Effect.gen(function* () {
      const runId = yield* seedRun(settingsWith({ liveWorkers: 1 }));
      // Two delegations at once for the last slot: exactly one starts a child.
      const both = yield* Effect.forEach(
        [1, 2],
        () => Effect.result(delegate(world, ORCHESTRATOR, worker())),
        { concurrency: "unbounded" },
      );
      assert.equal(both.filter((result) => result._tag === "Success").length, 1);
      assert.lengthOf(world.dispatched, 1);
      world.taskStatuses.set(`${ORCHESTRATOR}|${world.dispatched[0]!.taskId}`, "completed");

      // A delegation in flight holds the slot, so a third is refused while it waits.
      world.hang = true;
      world.hung = yield* Deferred.make<void>();
      world.release = yield* Deferred.make<void>();
      const hung = yield* delegate(world, ORCHESTRATOR, worker()).pipe(Effect.forkChild);
      yield* Deferred.await(world.hung);
      world.hang = false;
      yield* refusedWith(delegate(world, ORCHESTRATOR, worker()), "1 of 1 live workers");

      // Interrupted once its dispatch is accepted, the child is still recorded: it is gated,
      // counted and stopped with the run.
      const interrupting = yield* Fiber.interrupt(hung).pipe(Effect.forkChild);
      // Let the interrupt reach the delegation before its dispatch answers.
      for (let turn = 0; turn < 10; turn += 1) yield* Effect.yieldNow;
      yield* Deferred.succeed(world.release, undefined);
      yield* Fiber.join(interrupting);
      const child = world.dispatched.at(-1)!;
      const member = (yield* crewOf(runId)).find(
        (candidate) => candidate.threadId === child.childThreadId,
      );
      assert.isDefined(member, "the interrupted delegation's child is in the crew");
      assert.isNull(member!.endedAt);
      yield* refusedWith(delegate(world, ORCHESTRATOR, worker()), "1 of 1 live workers");
      world.taskStatuses.set(`${ORCHESTRATOR}|${child.taskId}`, "completed");

      // A delegation that fails frees the slot.
      world.failDispatch = true;
      assert.equal((yield* Effect.exit(delegate(world, ORCHESTRATOR, worker())))._tag, "Failure");
      world.failDispatch = false;
      const accepted = yield* delegate(world, ORCHESTRATOR, worker());
      assert.isNotNull(accepted.childThreadId);
    }).pipe(Effect.provide(layerService(world)));
  });

  it.effect("building roles need their own worktree", () => {
    const world = freshWorld();
    return Effect.gen(function* () {
      yield* seedRun(settingsWith({ liveWorkers: 12 }));
      for (const role of ["implementation", "design", "test", "general"] as const) {
        for (const isolation of ["shared", undefined] as const) {
          yield* refusedWith(
            delegate(world, ORCHESTRATOR, {
              role,
              ...(isolation === undefined ? {} : { isolation }),
            }),
            role,
            "worktree",
          );
        }
      }
      assert.lengthOf(world.dispatched, 0);
      // Research and review may share the caller's worktree: no checkout of their own.
      yield* delegate(world, ORCHESTRATOR, { role: "research", isolation: "shared" });
      yield* delegate(world, ORCHESTRATOR, { role: "review", isolation: "shared" });
      assert.lengthOf(world.dispatched, 2);
      for (const dispatched of world.dispatched) assert.isUndefined(dispatched.workspaceStrategy);
      // Any delegation to a linked environment is refused.
      yield* refusedWith(
        delegate(world, ORCHESTRATOR, {
          role: "research",
          target: { environmentId: EnvironmentId.make("environment:laptop") },
        }),
        "a Night shift run stays on this machine",
      );
      assert.lengthOf(world.dispatched, 2);
    }).pipe(Effect.provide(layerService(world)));
  });

  it.effect("a crew thread starts work only through delegate_task", () => {
    const world = freshWorld();
    return Effect.gen(function* () {
      const runId = yield* seedRun(settingsWith());
      const gate = yield* CrewGate.HoustonCrewGate;
      const operations = [
        ["create_threads", CrewGate.STARTS_ONLY_THROUGH_DELEGATION],
        ["t3_thread_launch", CrewGate.STARTS_ONLY_THROUGH_DELEGATION],
        ["schedule_task", CrewGate.STARTS_ONLY_THROUGH_DELEGATION],
        ["delete_scheduled_task", CrewGate.STARTS_ONLY_THROUGH_DELEGATION],
        ["t3_environment_link", CrewGate.STARTS_ONLY_THROUGH_DELEGATION],
        ["houston_task_execute", CrewGate.STARTS_ONLY_THROUGH_DELEGATION],
        ["houston_merge_queue_enqueue", CrewGate.NIGHT_SHIFT_ENQUEUES],
        ["houston_merge_queue_dequeue", CrewGate.NIGHT_SHIFT_ENQUEUES],
      ] as const;
      assert.equal(
        CrewGate.STARTS_ONLY_THROUGH_DELEGATION,
        "a Night shift run starts work only through delegate_task",
      );
      assert.equal(CrewGate.NIGHT_SHIFT_ENQUEUES, "Night shift enqueues its pull requests itself");
      for (const [operation, sentence] of operations) {
        const refusal = yield* Effect.flip(gate.admit({ callerThreadId: ORCHESTRATOR, operation }));
        assert.include(refusal, operation);
        assert.include(refusal, sentence);
        // Outside every live run the gate admits the same call unchanged.
        const outside = yield* gate.admit({ callerThreadId: OUTSIDER, operation });
        assert.isUndefined(outside.target);
      }
      // A run in its last 45 minutes still gates its crew.
      assert.isTrue(yield* (yield* Store.HoustonNightShiftStore).markWrappingUp(runId, NOW));
      for (const [operation, sentence] of operations) {
        const refusal = yield* Effect.flip(gate.admit({ callerThreadId: ORCHESTRATOR, operation }));
        assert.include(refusal, sentence, `${operation} while wrapping up`);
      }

      // Upstream's own handlers: refused before anything is created, scheduled or deleted.
      const service = yield* OrchestratorMcpService.OrchestratorMcpService;
      const crew = scopeOf(world, ORCHESTRATOR);
      const outsider = scopeOf(world, OUTSIDER);
      const upstream = [
        [
          "create_threads",
          (scope: McpInvocationScope) =>
            service.createThreads(scope, { threads: [{ title: "t", message: "m" }] } as never),
        ],
        [
          "schedule_task",
          (scope: McpInvocationScope) =>
            service.scheduleTask(scope, {
              prompt: "p",
              schedule: { type: "interval", minutes: 60 },
            } as never),
        ],
        [
          "schedule_task",
          (scope: McpInvocationScope) =>
            service.updateScheduledTask(scope, { scheduledTaskId: "task-1" } as never),
        ],
        [
          "delete_scheduled_task",
          (scope: McpInvocationScope) =>
            service.deleteScheduledTask(scope, { scheduledTaskId: "task-1" } as never),
        ],
      ] as const;
      for (const [operation, call] of upstream) {
        const before = world.calls.length;
        yield* refusedWith(
          call(crew) as Effect.Effect<void, OrchestratorMcpFailure>,
          operation,
          CrewGate.STARTS_ONLY_THROUGH_DELEGATION,
        );
        assert.equal(world.calls.length, before, `${operation} from the crew reached nothing`);
        // The outsider's call passes the gate into upstream's handler, which this double stops.
        const reached = yield* Effect.exit(
          call(outsider) as Effect.Effect<void, OrchestratorMcpFailure>,
        );
        if (reached._tag === "Failure")
          assert.notInclude(Cause.pretty(reached.cause), "Night shift");
      }
      assert.include(
        world.calls,
        "thread.create",
        "the outsider's create_threads reached dispatch",
      );
      assert.include(
        world.calls,
        "upsert",
        "the outsider's schedule_task reached upstream's upsert",
      );

      // The two upstream handlers outside the service ask the gate before any other work.
      for (const [file, operation] of [
        ["../../mcp/toolkits/project/handlers.ts", "t3_thread_launch"],
        ["../../mcp/toolkits/orchestrator/handlers.ts", "t3_environment_link"],
      ] as const) {
        const source = NodeFS.readFileSync(new URL(file, import.meta.url), "utf8");
        const handler = source.slice(source.indexOf(`${operation}: McpToolAccess`));
        const gateCall = handler.indexOf(`admitOperation(scope, "${operation}")`);
        assert.isAbove(gateCall, 0, operation);
        const firstWork = Math.min(
          ...["readCaller()", "requests.request("]
            .map((needle) => handler.indexOf(needle))
            .filter((index) => index >= 0),
        );
        assert.isBelow(gateCall, firstWork, `${operation} asks the gate first`);
      }
    }).pipe(Effect.provide(layerService(world)));
  });

  it.effect("houston's task and merge queue tools refuse a crew thread", () => {
    const world = freshWorld();
    const layer = Layer.mergeAll(
      McpHttpServer.layerHoustonTaskToolkit,
      McpHttpServer.layerHoustonMergeQueueToolkit,
    ).pipe(
      Layer.provideMerge(McpServer.McpServer.layer),
      Layer.provide(
        Layer.mergeAll(
          layerThreadManagement(world),
          Layer.mock(HoustonTaskRuns)({
            agentWriteRefusal: () => Effect.void as never,
            execute: () =>
              Effect.sync(() => world.calls.push("houston_task_execute")).pipe(
                Effect.andThen(Effect.die("no execute")),
              ),
          }),
          Layer.mock(HoustonTaskService)({
            getSettings: () => Effect.succeed({ access: "write" } as never),
            get: () => Effect.succeed({ task: { projectId, key: "HOU-7" } } as never),
          }),
          Layer.mock(HoustonMergeQueueService)({
            enqueue: () =>
              Effect.sync(() => world.calls.push("houston_merge_queue_enqueue")).pipe(
                Effect.andThen(Effect.die("no enqueue")),
              ),
            dequeue: () =>
              Effect.sync(() => world.calls.push("houston_merge_queue_dequeue")).pipe(
                Effect.andThen(Effect.die("no dequeue")),
              ),
          }),
          Layer.mock(HoustonMergeQueueProject)({}),
          NodeServices.layer,
        ),
      ),
      Layer.provideMerge(layerGate(world)),
    );
    const client = McpSchema.McpServerClient.of({
      clientId: 1,
      clientCapabilities: {},
      clientInfo: { name: "night-crew", version: "1.0.0" },
      protocolVersion: "2025-06-18",
      initializePayload: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "night-crew", version: "1.0.0" },
      },
      getClient: Effect.die("unused"),
    });
    const call = (threadId: ThreadId, name: string, args: Record<string, unknown>) =>
      Effect.gen(function* () {
        const server = yield* McpServer.McpServer;
        const result = (yield* server.callTool({ name, arguments: args }).pipe(
          Effect.provideService(
            McpInvocationContext.McpInvocationContext,
            scopeOf(world, threadId),
          ),
          Effect.provideService(McpSchema.McpServerClient, client),
          Effect.catchCause(() => Effect.succeed({ isError: true, content: [] })),
        )) as McpSchema.CallToolResult;
        return (result.content ?? [])
          .map((part) => (part.type === "text" ? part.text : ""))
          .join("\n");
      });
    return Effect.gen(function* () {
      yield* seedRun(settingsWith());
      const tools = [
        ["houston_task_execute", { id: "HOU-7" }, CrewGate.STARTS_ONLY_THROUGH_DELEGATION],
        ["houston_merge_queue_enqueue", { pullRequest: 12 }, CrewGate.NIGHT_SHIFT_ENQUEUES],
        ["houston_merge_queue_dequeue", { pullRequest: 12 }, CrewGate.NIGHT_SHIFT_ENQUEUES],
      ] as const;
      for (const [name, args, sentence] of tools) {
        const text = yield* call(ORCHESTRATOR, name, args);
        assert.include(text, "Night shift: ", name);
        assert.include(text, sentence, name);
      }
      assert.deepEqual(world.calls, [], "nothing executed, enqueued or dequeued");
      // The same calls from a thread outside every live run reach Houston's handlers.
      for (const [name, args] of tools) {
        const text = yield* call(OUTSIDER, name, args);
        assert.notInclude(text, "Night shift", name);
      }
      assert.deepEqual(
        world.calls,
        tools.map(([name]) => name),
      );
    }).pipe(Effect.provide(layer));
  });

  it.effect("a limited worker instance is replaced by the next ready one", () => {
    const world = freshWorld();
    return Effect.gen(function* () {
      const store = yield* Store.HoustonNightShiftStore;
      const runId = yield* seedRun(
        settingsWith({ workers: [selection("codex"), selection("claudeAgent")], liveWorkers: 8 }),
      );
      world.readiness.set("codex", {
        state: "outOfUsage",
        resetsAt: "2026-10-31T01:00:00.000Z",
        message: "Codex usage limit",
        at: NOW,
      });
      const explicit = yield* delegate(
        world,
        ORCHESTRATOR,
        worker({ target: { providerInstanceId: ProviderInstanceId.make("codex"), model: "m" } }),
      );
      assert.equal(explicit.providerInstanceId, "claudeAgent");

      // A worker on Codex delegating without a target inherits Codex, which is substituted too.
      world.callers.set("codex-worker", "codex");
      yield* store.addCrew({
        runId,
        threadId: ThreadId.make("codex-worker"),
        taskId: "task-codex",
        parentThreadId: ORCHESTRATOR,
        role: "research",
        providerInstanceId: "codex",
        requestedInstanceId: "codex",
        worktreePath: null,
        branch: null,
        startedAt: NOW,
        endedAt: null,
      });
      const inherited = yield* delegate(world, ThreadId.make("codex-worker"), worker());
      assert.equal(inherited.providerInstanceId, "claudeAgent");
      assert.deepEqual(
        world.dispatched.map((dispatched) => dispatched.instanceId),
        ["claudeAgent", "claudeAgent"],
      );
      const crew = yield* crewOf(runId);
      for (const child of [explicit, inherited]) {
        const row = crew.find((member) => member.threadId === child.childThreadId)!;
        assert.equal(row.providerInstanceId, "claudeAgent");
        assert.equal(row.requestedInstanceId, "codex");
      }
      const substituted = world.notes.filter((note) =>
        note.messageId.startsWith(`message:night-shift:${runId}:substituted:`),
      );
      assert.lengthOf(substituted, 1, "one message per instance");
      assert.equal(substituted[0]!.messageId, `message:night-shift:${runId}:substituted:codex`);
      assert.include(substituted[0]!.text, "codex");
      assert.include(substituted[0]!.text, "claudeAgent");

      // Both limited: refused naming both instances and their states, and no child starts.
      world.readiness.set("claudeAgent", {
        state: "signedOut",
        source: "turn",
        message: "Sign in",
      });
      const before = world.dispatched.length;
      yield* refusedWith(
        delegate(
          world,
          ORCHESTRATOR,
          worker({ target: { providerInstanceId: ProviderInstanceId.make("codex") } }),
        ),
        "codex is outOfUsage",
        "claudeAgent is signedOut",
      );
      assert.equal(world.dispatched.length, before);

      // The run's own limit record: an open limit substitutes even when readiness reads ready.
      world.readiness.set("codex", { state: "ready" });
      world.readiness.set("claudeAgent", { state: "ready" });
      const limit = {
        instanceId: "codex",
        state: "outOfUsage",
        resetsAt: "2026-10-31T01:00:00.000Z",
        at: NOW,
        clearedAt: null,
      };
      yield* store.setLimited(runId, [limit]);
      const open = yield* delegate(
        world,
        ORCHESTRATOR,
        worker({ target: { providerInstanceId: ProviderInstanceId.make("codex") } }),
      );
      assert.equal(open.providerInstanceId, "claudeAgent", "an open limit substitutes");

      // Once reset clears the limit, the next delegation runs where it asked, with no new message.
      yield* store.setLimited(runId, [{ ...limit, clearedAt: "2026-10-31T01:00:00.000Z" }]);
      const cleared = yield* delegate(
        world,
        ORCHESTRATOR,
        worker({ target: { providerInstanceId: ProviderInstanceId.make("codex") } }),
      );
      assert.equal(cleared.providerInstanceId, "codex", "a cleared limit no longer substitutes");
      assert.equal(world.dispatched.at(-1)!.instanceId, "codex");
      assert.lengthOf(
        world.notes.filter((note) =>
          note.messageId.startsWith(`message:night-shift:${runId}:substituted:`),
        ),
        1,
        "no new substituted message",
      );
    }).pipe(Effect.provide(layerService(world)));
  });

  it.effect("a delegation to an instance outside the workers chain is refused by name", () => {
    const world = freshWorld();
    return Effect.gen(function* () {
      const runId = yield* seedRun(
        settingsWith({ workers: [selection("codex"), selection("claudeAgent")] }),
      );
      // opencode is ready and unlimited, but the user did not list it as a worker.
      yield* refusedWith(
        delegate(
          world,
          ORCHESTRATOR,
          worker({ target: { providerInstanceId: ProviderInstanceId.make("opencode") } }),
        ),
        "opencode",
        "workers chain",
        "codex, claudeAgent",
      );
      yield* refusedWith(
        delegate(
          world,
          ORCHESTRATOR,
          worker({ target: { driverKind: ProviderDriverKind.make("opencode") } }),
        ),
        "opencode",
        "workers chain",
      );
      // A thread on an instance outside the chain cannot inherit it for its delegation either.
      world.callers.set("opencode-worker", "opencode");
      yield* (yield* Store.HoustonNightShiftStore).addCrew({
        runId,
        threadId: ThreadId.make("opencode-worker"),
        taskId: "task-opencode",
        parentThreadId: ORCHESTRATOR,
        role: "research",
        providerInstanceId: "opencode",
        requestedInstanceId: "opencode",
        worktreePath: null,
        branch: null,
        startedAt: NOW,
        endedAt: null,
      });
      yield* refusedWith(
        delegate(world, ThreadId.make("opencode-worker"), worker()),
        "opencode",
        "workers chain",
      );
      assert.lengthOf(world.dispatched, 0, "no child started");
      assert.lengthOf(
        (yield* crewOf(runId)).filter((member) => member.role !== "orchestrator"),
        1,
        "only the seeded member",
      );
      // A chain instance is still admitted.
      const codex = yield* delegate(
        world,
        ORCHESTRATOR,
        worker({ target: { providerInstanceId: ProviderInstanceId.make("codex") } }),
      );
      assert.equal(codex.providerInstanceId, "codex");
    }).pipe(Effect.provide(layerService(world)));
  });

  it.effect("a settled run no longer gates its threads", () => {
    const world = freshWorld();
    return Effect.gen(function* () {
      const store = yield* Store.HoustonNightShiftStore;
      const runId = yield* seedRun(settingsWith());
      yield* refusedWith(
        delegate(world, ORCHESTRATOR, { role: "implementation", isolation: "shared" }),
        "worktree",
      );
      yield* store.settle(runId, { stopReason: "stopped", detail: null, endedAt: NOW });
      // The former orchestrator's calls reach upstream's handlers as any thread's.
      const shared = yield* delegate(world, ORCHESTRATOR, {
        role: "implementation",
        isolation: "shared",
      });
      assert.isNotNull(shared.childThreadId);
      assert.isUndefined(world.dispatched.at(-1)!.workspaceStrategy);
      const service = yield* OrchestratorMcpService.OrchestratorMcpService;
      const created = yield* Effect.exit(
        service.createThreads(scopeOf(world, ORCHESTRATOR), {
          threads: [{ title: "t", message: "m" }],
        } as never),
      );
      if (created._tag === "Failure") assert.notInclude(Cause.pretty(created.cause), "Night shift");
      assert.include(world.calls, "thread.create", "create_threads reached upstream's dispatch");
      assert.lengthOf(
        (yield* crewOf(runId)).filter((member) => member.role !== "orchestrator"),
        0,
      );
    }).pipe(Effect.provide(layerService(world)));
  });
});
