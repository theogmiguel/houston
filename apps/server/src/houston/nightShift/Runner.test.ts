// @effect-diagnostics nodeBuiltinImport:off - checks run folders and the project checkout on disk.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, describe, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  OrchestrationV2RpcSchemas,
  type ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import type { HoustonNightShiftError } from "@t3tools/contracts/houston/nightShift";
import type { ProviderReadiness } from "@t3tools/contracts/houston/providerReadiness";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import { TestClock } from "effect/testing";

import * as ServerConfig from "../../config.ts";
import * as Orchestrator from "../../orchestration-v2/Orchestrator.ts";
import * as ThreadLaunchService from "../../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../../orchestration-v2/ThreadManagementService.ts";
import {
  createProject,
  fireDue,
  kindOf,
  makeKit,
  makeRepository,
  messageOf,
  model,
  nightTask,
  NOW,
  runKit,
  Runner,
  seedNightShift,
  Service,
  settleOrchestrator,
  Store,
  type Kit,
} from "./nightShift.testkit.ts";
import * as Threads from "./Threads.ts";
import { makeRunsHarness, runWith } from "../tasks/taskRuns.testkit.ts";
import { layerBacklog, NightShiftBacklog, type UpNextTask } from "./Host.ts";
import { pickTasks } from "./rules.ts";

const GIB = 1024 ** 3;
const runner = Runner.HoustonNightShiftRunner;
const service = Service.HoustonNightShiftService;
const EVERY_NIGHT = { timeOfDay: "23:30", weekdays: [0, 1, 2, 3, 4, 5, 6] };

const setUp = Effect.fn("RunnerTest.setUp")(function* (
  name: string,
  schedule?: { readonly timeOfDay: string; readonly weekdays: ReadonlyArray<number> },
) {
  const fixture = makeRepository(name, { kind: "bare" });
  const projectId = yield* createProject(name, fixture.root);
  const task = yield* seedNightShift(projectId, {}, schedule);
  return { fixture, projectId, task };
});

const start = (projectId: ProjectId, durationMinutes = 120) =>
  Effect.flatMap(runner, (night) =>
    night.start({
      projectId,
      trigger: "manual",
      scheduledTaskId: null,
      durationMinutes,
      operation: "runNow",
    }),
  );

const getRun = (runId: number) =>
  Effect.flatMap(Store.HoustonNightShiftStore, (store) => store.getRun(runId)).pipe(
    Effect.map((run) => run!),
  );

const tick = Effect.flatMap(runner, (night) => night.tick);

const addCrew = (runId: number, threadId: string, parent: ThreadId, startedAt: string) =>
  Effect.flatMap(Store.HoustonNightShiftStore, (store) =>
    store.addCrew({
      runId,
      threadId: ThreadId.make(threadId),
      taskId: `task:${threadId}`,
      parentThreadId: parent,
      role: "implementation",
      providerInstanceId: "claudeAgent",
      requestedInstanceId: null,
      worktreePath: `/worktrees/${threadId}`,
      branch: `t3/${threadId}`,
      startedAt,
      endedAt: null,
    }),
  );

const busy = (kit: Kit, threadId: string) =>
  kit.state.states.set(threadId, { present: true, activeRun: true, lastRunStatus: "running" });
const idle = (kit: Kit, threadId: string, lastRunStatus = "completed") =>
  kit.state.states.set(threadId, { present: true, activeRun: false, lastRunStatus });

const notesOf = (kit: Kit, runId: number, kind: string) =>
  kit.state.notes.filter((note) =>
    note.messageId.startsWith(`message:night-shift:${runId}:${kind}:`),
  );

const stopOps = (kit: Kit) =>
  kit.state.ops.filter((op) => op.startsWith("cancel:") || op.startsWith("stop:"));

describe("night shift preflight and start", () => {
  it.effect("with the crew gate the server's default starts runs", () =>
    Effect.gen(function* () {
      // The AD-104 refusal left with the crew gate: the kit sets nothing to allow a start.
      const source = NodeFS.readFileSync(new URL("./Runner.ts", import.meta.url), "utf8");
      assert.notInclude(source, "start once the crew gate ships");
      assert.notInclude(source, "CrewGatePresent");
      assert.notProperty(Runner, "STARTS_REFUSED");
      const kit = yield* makeKit("gate-default");
      yield* runKit(
        kit,
        Effect.gen(function* () {
          const night = yield* service;
          const store = yield* Store.HoustonNightShiftStore;
          const { projectId } = yield* setUp("gate-default", EVERY_NIGHT);
          const started = yield* night.runNow({ projectId, durationMinutes: 60 });
          assert.equal((yield* getRun(started.runId)).phase, "running");
          assert.lengthOf(kit.state.launches, 1);
          yield* night.stop({ runId: started.runId });

          const fired = yield* fireDue((yield* nightTask(projectId))!);
          assert.notEqual(fired?.lastRunStatus, "failed", fired?.lastRunError ?? "");
          assert.lengthOf(yield* store.listRuns(projectId, 30), 2);
          assert.lengthOf(kit.state.launches, 2);
        }),
      );
    }),
  );

  it.effect("a blocking preflight refuses the run and starts nothing", () =>
    Effect.gen(function* () {
      const kit = yield* makeKit("blocked");
      kit.state.readings = { ...kit.state.readings, freeMemoryBytes: 5.9 * GIB };
      yield* runKit(
        kit,
        Effect.gen(function* () {
          const night = yield* service;
          const store = yield* Store.HoustonNightShiftStore;
          const { projectId } = yield* setUp("blocked", EVERY_NIGHT);

          const refused = (yield* Effect.flip(
            night.runNow({ projectId, durationMinutes: 60 }),
          )) as HoustonNightShiftError;
          assert.equal(refused.kind, "blocked");
          const memory = refused.items?.find((item) => item.id === "memory");
          assert.deepInclude(memory, { status: "block", limit: "6 GiB", actual: "5.9 GiB" });
          const runs = yield* store.listRuns(projectId, 30);
          assert.lengthOf(runs, 1);
          assert.equal(runs[0]!.phase, "refused");
          assert.deepEqual(runs[0]!.preflight, refused.items);
          assert.lengthOf(kit.state.launches, 0);
          assert.lengthOf(kit.state.spawns, 0);

          // A scheduled fire records the same refused run and the task's last error.
          const fired = yield* fireDue((yield* nightTask(projectId))!);
          assert.equal(fired?.lastRunStatus, "failed");
          assert.include(fired?.lastRunError ?? "", "1 preflight item blocks the start");
          assert.include(fired?.lastRunError ?? "", `first: ${memory!.label}`);
          const after = yield* store.listRuns(projectId, 30);
          assert.lengthOf(after, 2);
          assert.equal(after[0]!.trigger, "scheduled");
          assert.equal(after[0]!.phase, "refused");
          assert.isDefined(after[0]!.preflight.find((item) => item.id === "memory"));
          assert.lengthOf(kit.state.launches, 0);
          assert.lengthOf(kit.state.spawns, 0);
          assert.lengthOf(kit.harness.log.started, 0);
        }),
      );
    }),
  );

  it.effect("preflight sends nothing off the machine", () =>
    Effect.gen(function* () {
      const kit = yield* makeKit("offline");
      yield* runKit(
        kit,
        Effect.gen(function* () {
          const night = yield* service;
          const { projectId } = yield* setUp("offline");
          const answer = yield* night.preflight({ projectId, durationMinutes: 60 });
          assert.isAbove(answer.items.length, 0);

          kit.state.readings = { ...kit.state.readings, freeMemoryBytes: 1 * GIB };
          const refused = yield* Effect.flip(night.runNow({ projectId, durationMinutes: 60 }));
          assert.equal(kindOf(refused), "blocked");

          assert.notInclude(kit.state.gitCalls, "lsRemoteHeads");
          assert.lengthOf(kit.harness.log.started, 0, "no provider turn");
          assert.lengthOf(kit.state.launches, 0);
          assert.deepEqual(kit.state.httpRequests, [], "no GitHub or other HTTP request");
        }),
      );
    }),
  );

  it.effect("one live run per project and two per server", () =>
    Effect.gen(function* () {
      const kit = yield* makeKit("busy");
      yield* runKit(
        kit,
        Effect.gen(function* () {
          const night = yield* service;
          const store = yield* Store.HoustonNightShiftStore;
          const p = yield* setUp("busy-p");
          const q = yield* setUp("busy-q");
          const r = yield* setUp("busy-r");
          const runP = yield* start(p.projectId);
          const again = yield* Effect.flip(start(p.projectId));
          assert.equal(kindOf(again), "busy");
          assert.include(messageOf(again), `run ${runP.runId}`);

          const runQ = yield* start(q.projectId);
          const third = (yield* Effect.flip(start(r.projectId))) as HoustonNightShiftError;
          assert.equal(third.kind, "busy");
          assert.include(third.message, `run ${runP.runId}`);
          assert.include(third.message, `run ${runQ.runId}`);
          assert.include(third.message, "at most 2");
          assert.equal(third.limit, 2);
          assert.lengthOf(yield* store.listRuns(r.projectId, 30), 0);

          yield* (yield* runner).stop(runP.runId);
          yield* (yield* runner).stop(runQ.runId);
          const launchesBefore = kit.state.launches.length;
          const both = yield* Effect.all(
            [
              Effect.result(night.runNow({ projectId: r.projectId, durationMinutes: 60 })),
              Effect.result(night.runNow({ projectId: r.projectId, durationMinutes: 60 })),
            ],
            { concurrency: "unbounded" },
          );
          const failures = both.filter((result) => result._tag === "Failure");
          assert.lengthOf(failures, 1);
          assert.equal(kindOf(failures[0]!.failure), "busy");
          const live = (yield* store.liveRuns).filter((run) => run.projectId === r.projectId);
          assert.lengthOf(live, 1);
          assert.equal(kit.state.launches.length, launchesBefore + 1);
        }),
      );
    }),
  );

  it.effect("a start launches the orchestrator in its own worktree with the brief", () =>
    Effect.gen(function* () {
      const kit = yield* makeKit("launch");
      yield* runKit(
        kit,
        Effect.gen(function* () {
          const store = yield* Store.HoustonNightShiftStore;
          const config = yield* ServerConfig.ServerConfig;
          const { fixture, projectId } = yield* setUp("launch");
          const rootBefore = NodeFS.readdirSync(fixture.root).toSorted();
          let atLaunch: {
            brief: boolean;
            heads: boolean;
            spawns: number;
          } | null = null;
          kit.state.onLaunch = (input) => {
            const runId = Number(String(input.commandId).split(":")[1]);
            atLaunch = {
              brief: NodeFS.existsSync(
                NodePath.join(Store.runFolder(config.baseDir, runId), "brief.md"),
              ),
              heads: kit.state.gitCalls.includes("lsRemoteHeads"),
              spawns: kit.state.spawns.length,
            };
          };

          const started = yield* start(projectId);
          assert.deepEqual(atLaunch, { brief: true, heads: true, spawns: 1 });
          assert.lengthOf(kit.state.launches, 1);
          const launch = kit.state.launches[0]!;
          const brief = NodeFS.readFileSync(
            NodePath.join(Store.runFolder(config.baseDir, started.runId), "brief.md"),
            "utf8",
          );
          assert.equal(String(launch.commandId), `night-shift:${started.runId}:launch`);
          assert.equal(launch.runtimeMode, "full-access");
          assert.equal(launch.interactionMode, "default");
          assert.deepEqual(launch.workspaceStrategy, {
            type: "worktree",
            baseRef: fixture.head,
            branch: `houston/night/${started.runId}`,
          });
          assert.deepEqual(launch.modelSelection, model("claudeAgent"));
          assert.equal(
            String(launch.initialMessage?.messageId),
            `message:night-shift:${started.runId}:brief`,
          );
          assert.equal(launch.initialMessage?.text, brief);

          const run = yield* getRun(started.runId);
          const stored = (yield* store.settings(projectId))!;
          assert.equal(run.phase, "running");
          assert.equal(run.orchestratorThreadId, started.threadId);
          assert.equal(run.branch, `houston/night/${started.runId}`);
          assert.equal(run.worktreePath, `/worktrees/houston-night-${started.runId}`);
          assert.deepEqual(run.settings, stored.settings);
          assert.deepEqual(run.remoteHeads, { "refs/heads/main": fixture.head });
          assert.equal(run.keepAwake, "held");
          assert.equal(kit.state.spawns[0]!.command, "systemd-inhibit");
          const crew = yield* store.crew(started.runId);
          assert.lengthOf(crew, 1);
          assert.equal(crew[0]!.role, "orchestrator");
          assert.equal(crew[0]!.threadId, started.threadId);

          // Night shift wrote nothing into the user's checkout.
          assert.deepEqual(NodeFS.readdirSync(fixture.root).toSorted(), rootBefore);
          const status = NodeChildProcess.execFileSync("git", ["status", "--porcelain"], {
            cwd: fixture.root,
            encoding: "utf8",
          });
          assert.equal(status.trim(), "");
        }),
      );
    }),
  );

  it.effect("a failed launch is a refused run", () =>
    Effect.gen(function* () {
      const kit = yield* makeKit("launch-failed");
      kit.state.launchFailure = "the provider could not start a session";
      yield* runKit(
        kit,
        Effect.gen(function* () {
          const store = yield* Store.HoustonNightShiftStore;
          const { projectId } = yield* setUp("launch-failed");
          const failed = yield* Effect.flip(start(projectId));
          assert.include(messageOf(failed), "the provider could not start a session");
          const runs = yield* store.listRuns(projectId, 30);
          assert.lengthOf(runs, 1);
          assert.equal(runs[0]!.phase, "refused");
          assert.equal(runs[0]!.stopReason, "launchFailed");
          assert.include(runs[0]!.stopDetail ?? "", "the provider could not start a session");
          assert.equal(runs[0]!.keepAwake, "released");
          assert.lengthOf(kit.state.spawns, 1);
          assert.isTrue(kit.state.spawns[0]!.stdinClosed);
          assert.lengthOf(yield* store.liveRuns, 0);
        }),
      );
    }),
  );

  it.effect("a start that dies or is interrupted refuses the run and releases keep-awake", () =>
    Effect.gen(function* () {
      const kit = yield* makeKit("launch-defect");
      yield* runKit(
        kit,
        Effect.gen(function* () {
          const store = yield* Store.HoustonNightShiftStore;
          const first = yield* setUp("launch-defect-a");
          const second = yield* setUp("launch-defect-b");

          // A defect in the launch, not a typed failure.
          kit.state.onLaunch = () => {
            throw new Error("the launcher crashed");
          };
          const died = yield* Effect.exit(start(first.projectId));
          assert.equal(died._tag, "Failure");
          const dead = (yield* store.listRuns(first.projectId, 30))[0]!;
          assert.equal(dead.phase, "refused");
          assert.equal(dead.stopReason, "launchFailed");
          assert.include(dead.stopDetail ?? "", "the launcher crashed");
          assert.equal(dead.keepAwake, "released");
          assert.lengthOf(kit.state.spawns, 1);
          assert.isTrue(kit.state.spawns[0]!.stdinClosed);
          assert.lengthOf(yield* store.liveRuns, 0);

          // The start's fiber is interrupted while the launch is in flight (a client went away).
          let launched = () => undefined as void;
          const began = new Promise<void>((resolve) => {
            launched = resolve;
          });
          kit.state.onLaunch = () => launched();
          kit.state.launchHangs = true;
          const fiber = yield* Effect.forkChild(start(second.projectId));
          yield* Effect.promise(() => began);
          assert.lengthOf(kit.state.launches, 2, "the second launch began");
          yield* Fiber.interrupt(fiber);
          const cut = (yield* store.listRuns(second.projectId, 30))[0]!;
          assert.equal(cut.phase, "refused");
          assert.equal(cut.stopReason, "launchFailed");
          assert.include(cut.stopDetail ?? "", "interrupted");
          assert.equal(cut.keepAwake, "released");
          assert.lengthOf(kit.state.spawns, 2);
          assert.isTrue(kit.state.spawns[1]!.stdinClosed);
          assert.lengthOf(yield* store.liveRuns, 0);
        }),
      );
    }),
  );
});

describe("night shift run life", () => {
  it.effect("wrap-up is sent once", () =>
    Effect.gen(function* () {
      const kit = yield* makeKit("wrap-up");
      yield* runKit(
        kit,
        Effect.gen(function* () {
          const night = yield* runner;
          const first = yield* setUp("wrap-up-a");
          const second = yield* setUp("wrap-up-b");
          const a = yield* start(first.projectId, 120);
          // Run now 120: wrap-up 75 minutes after the start.
          yield* TestClock.adjust("74 minutes");
          yield* tick;
          assert.equal((yield* getRun(a.runId)).phase, "running");
          assert.lengthOf(notesOf(kit, a.runId, "wrap-up"), 0);
          yield* TestClock.adjust("2 minutes");
          yield* tick;
          const wrapping = yield* getRun(a.runId);
          assert.equal(wrapping.phase, "wrappingUp");
          const sent = notesOf(kit, a.runId, "wrap-up");
          assert.lengthOf(sent, 1);
          assert.equal(sent[0]!.messageId, `message:night-shift:${a.runId}:wrap-up:`);
          assert.equal(sent[0]!.threadId, a.threadId);
          assert.equal(sent[0]!.text, Runner.wrapUpText(wrapping.hardStopAt!));
          assert.include(sent[0]!.text, "Wrap-up: start nothing new");

          yield* TestClock.adjust("1 minute");
          yield* tick;
          const late = yield* Effect.flip(night.wrapUp(a.runId));
          assert.equal(kindOf(late), "invalid");
          assert.lengthOf(notesOf(kit, a.runId, "wrap-up"), 1);

          // Wrap up now, before the wrap-up time: at once, and once.
          const b = yield* start(second.projectId, 120);
          const now = yield* night.wrapUp(b.runId);
          assert.equal((yield* getRun(b.runId)).phase, "wrappingUp");
          assert.equal((yield* getRun(b.runId)).wrapUpAt, now.wrapUpAt);
          assert.lengthOf(notesOf(kit, b.runId, "wrap-up"), 1);
          const twice = yield* Effect.flip(night.wrapUp(b.runId));
          assert.equal(kindOf(twice), "invalid");
          yield* TestClock.adjust("80 minutes");
          yield* tick;
          assert.lengthOf(notesOf(kit, b.runId, "wrap-up"), 1);
        }),
      );
    }),
  );

  it.effect("hard stop and stop cancel the crew then the orchestrator", () =>
    Effect.gen(function* () {
      const kit = yield* makeKit("hard-stop");
      yield* runKit(
        kit,
        Effect.gen(function* () {
          const night = yield* runner;
          const store = yield* Store.HoustonNightShiftStore;
          const first = yield* setUp("hard-stop-a");
          const second = yield* setUp("hard-stop-b");
          const a = yield* start(first.projectId, 60);
          const runA = yield* getRun(a.runId);
          yield* addCrew(a.runId, "worker-1", a.threadId, runA.startedAt);
          yield* addCrew(a.runId, "worker-2", a.threadId, runA.startedAt);
          yield* addCrew(a.runId, "grandchild", ThreadId.make("worker-1"), runA.startedAt);
          for (const thread of ["worker-1", "worker-2", "grandchild"]) busy(kit, thread);

          yield* TestClock.adjust("61 minutes");
          yield* tick;
          const settled = yield* getRun(a.runId);
          assert.equal(settled.phase, "settled");
          assert.equal(settled.stopReason, "hardStop");
          // Every crew cancel comes before the orchestrator's stop.
          const ops = stopOps(kit);
          assert.sameMembers(ops.slice(0, 3), [
            "cancel:worker-1",
            "cancel:worker-2",
            "cancel:grandchild",
          ]);
          assert.deepEqual(ops.slice(3), [`stop:${a.threadId}`]);
          for (const thread of ["worker-1", "worker-2", "grandchild", a.threadId]) {
            assert.isFalse(kit.state.states.get(thread)!.activeRun, thread);
          }
          assert.isTrue((yield* store.crew(a.runId)).every((member) => member.endedAt !== null));

          kit.state.ops.length = 0;
          const b = yield* start(second.projectId, 60);
          yield* addCrew(b.runId, "worker-3", b.threadId, (yield* getRun(b.runId)).startedAt);
          busy(kit, "worker-3");
          const stopped = yield* night.stop(b.runId);
          assert.equal(stopped.stopReason, "stopped");
          assert.deepEqual(stopOps(kit), ["cancel:worker-3", `stop:${b.threadId}`]);
          assert.isFalse(kit.state.states.get("worker-3")!.activeRun);
          const again = yield* Effect.flip(night.stop(b.runId));
          assert.equal(kindOf(again), "invalid");

          // The stop waits for every crew member, not the first that ends: "slow" ends 5 s
          // after its cancel, and the orchestrator is stopped only after that.
          const stopWithClock = Effect.fn("RunnerTest.stopWithClock")(function* (
            runId: number,
            seconds: number,
          ) {
            const fiber = yield* Effect.forkChild(night.stop(runId));
            const stopAt: Array<number> = [];
            for (let second = 0; second < seconds; second += 1) {
              yield* TestClock.adjust("1 second");
              if (stopOps(kit).some((op) => op.startsWith("stop:")) && stopAt.length === 0) {
                stopAt.push(second);
              }
            }
            yield* Fiber.join(fiber);
            return stopAt[0];
          });
          kit.state.ops.length = 0;
          const third = yield* setUp("hard-stop-c");
          const c = yield* start(third.projectId, 60);
          const startedC = (yield* getRun(c.runId)).startedAt;
          for (const thread of ["fast", "slow"]) {
            yield* addCrew(c.runId, thread, c.threadId, startedC);
            busy(kit, thread);
          }
          kit.state.cancelDelays.set("slow", 5);
          yield* stopWithClock(c.runId, 10);
          const order = kit.state.ops.filter((op) => /^(cancel|ended|stop):/.test(op));
          assert.include(order, "ended:slow");
          assert.isBelow(order.indexOf("ended:slow"), order.indexOf(`stop:${c.threadId}`));

          // A member that never ends holds the stop for 60 s, then the orchestrator is stopped.
          kit.state.ops.length = 0;
          const fourth = yield* setUp("hard-stop-d");
          const d = yield* start(fourth.projectId, 60);
          yield* addCrew(d.runId, "stuck", d.threadId, (yield* getRun(d.runId)).startedAt);
          busy(kit, "stuck");
          kit.state.cancelDelays.set("stuck", Number.POSITIVE_INFINITY);
          const stoppedAfter = yield* stopWithClock(d.runId, 70);
          assert.isDefined(stoppedAfter);
          assert.isAtLeast(stoppedAfter!, 58);
          assert.isAtMost(stoppedAfter!, 61);
          assert.equal((yield* getRun(d.runId)).stopReason, "stopped");
        }),
      );
    }),
  );

  it.effect("a run settles on the report and its run's end only", () =>
    Effect.gen(function* () {
      const kit = yield* makeKit("report-settle");
      yield* runKit(
        kit,
        Effect.gen(function* () {
          const night = yield* runner;
          const config = yield* ServerConfig.ServerConfig;
          const first = yield* setUp("report-a");
          const second = yield* setUp("report-b");
          const a = yield* start(first.projectId);
          // The orchestrator's run ends before any report: the Night shift run stays.
          idle(kit, a.threadId);
          yield* tick;
          assert.equal((yield* getRun(a.runId)).phase, "running");

          busy(kit, a.threadId);
          const folder = Store.runFolder(config.baseDir, a.runId);
          NodeFS.writeFileSync(NodePath.join(folder, "report.md"), "# report\n");
          yield* night.reportPublished(a.runId, {
            reportPath: NodePath.join(folder, "report.md"),
            summary: "done",
          });
          yield* tick;
          assert.equal((yield* getRun(a.runId)).phase, "running", "its run is still active");
          idle(kit, a.threadId);
          yield* tick;
          const settled = yield* getRun(a.runId);
          assert.equal(settled.phase, "settled");
          assert.equal(settled.stopReason, "report");

          // A report published while the orchestrator is idle settles at once.
          const b = yield* start(second.projectId);
          idle(kit, b.threadId);
          const folderB = Store.runFolder(config.baseDir, b.runId);
          NodeFS.writeFileSync(NodePath.join(folderB, "report.md"), "# report\n");
          yield* night.reportPublished(b.runId, {
            reportPath: NodePath.join(folderB, "report.md"),
            summary: "done",
          });
          const settledB = yield* getRun(b.runId);
          assert.equal(settledB.phase, "settled");
          assert.equal(settledB.stopReason, "report");
        }),
      );
    }),
  );

  it.effect("an idle orchestrator is nudged then settled", () =>
    Effect.gen(function* () {
      const kit = yield* makeKit("idle");
      yield* runKit(
        kit,
        Effect.gen(function* () {
          const first = yield* setUp("idle-a");
          const second = yield* setUp("idle-b");
          const a = yield* start(first.projectId);
          idle(kit, a.threadId);
          yield* tick;
          yield* TestClock.adjust("9 minutes");
          yield* tick;
          assert.lengthOf(notesOf(kit, a.runId, "idle"), 0);
          yield* TestClock.adjust("1 minute");
          yield* tick;
          const nudged = notesOf(kit, a.runId, "idle");
          assert.lengthOf(nudged, 1);
          assert.equal(nudged[0]!.messageId, `message:night-shift:${a.runId}:idle:`);
          assert.equal(nudged[0]!.text, Runner.idleText);

          // A child wakes it at 15; it is idle again from 16.
          yield* TestClock.adjust("5 minutes");
          busy(kit, a.threadId);
          yield* tick;
          yield* TestClock.adjust("1 minute");
          idle(kit, a.threadId);
          yield* tick;
          yield* TestClock.adjust("9 minutes");
          yield* tick;
          assert.equal((yield* getRun(a.runId)).phase, "running", "25 minutes");
          yield* TestClock.adjust("1 minute");
          yield* tick;
          const settled = yield* getRun(a.runId);
          assert.equal(settled.phase, "settled", "26 minutes");
          assert.equal(settled.stopReason, "idle");
          assert.lengthOf(notesOf(kit, a.runId, "idle"), 1);

          // A live crew member keeps the idle clock at zero.
          const b = yield* start(second.projectId);
          idle(kit, b.threadId);
          yield* addCrew(b.runId, "worker", b.threadId, (yield* getRun(b.runId)).startedAt);
          busy(kit, "worker");
          for (let minute = 0; minute < 30; minute += 5) {
            yield* tick;
            yield* TestClock.adjust("5 minutes");
          }
          yield* tick;
          assert.equal((yield* getRun(b.runId)).phase, "running");
          assert.lengthOf(notesOf(kit, b.runId, "idle"), 0);
        }),
      );
    }),
  );

  it.effect("a lost or limited orchestrator settles the run", () =>
    Effect.gen(function* () {
      const kit = yield* makeKit("lost");
      yield* runKit(
        kit,
        Effect.gen(function* () {
          const first = yield* setUp("lost-a");
          const second = yield* setUp("lost-b");
          const third = yield* setUp("lost-c");

          const a = yield* start(first.projectId);
          yield* addCrew(a.runId, "worker-a", a.threadId, (yield* getRun(a.runId)).startedAt);
          busy(kit, "worker-a");
          kit.state.states.set(a.threadId, {
            present: false,
            activeRun: false,
            lastRunStatus: null,
          });
          yield* tick;
          const deleted = yield* getRun(a.runId);
          assert.equal(deleted.stopReason, "orchestratorEnded");
          assert.include(deleted.stopDetail ?? "", "deleted");
          assert.include(kit.state.ops, "cancel:worker-a");

          const b = yield* start(second.projectId);
          idle(kit, b.threadId, "failed");
          yield* tick;
          const failed = yield* getRun(b.runId);
          assert.equal(failed.stopReason, "orchestratorEnded");
          assert.include(failed.stopDetail ?? "", "failed");

          const c = yield* start(third.projectId);
          kit.state.providers = kit.state.providers.map((provider) =>
            provider.instanceId === "claudeAgent"
              ? {
                  ...provider,
                  readiness: {
                    state: "outOfUsage",
                    resetsAt: "2026-10-31T04:00:00.000Z",
                    message: "Usage limit reached",
                    at: NOW,
                  },
                }
              : provider,
          );
          yield* tick;
          const limited = yield* getRun(c.runId);
          assert.equal(limited.stopReason, "orchestratorLimited");
          assert.include(limited.stopDetail ?? "", "outOfUsage");
          assert.include(limited.stopDetail ?? "", "2026-10-31T04:00:00.000Z");

          // A signed-out or rejected orchestrator settles the run the same way.
          const withClaude = (readiness: ProviderReadiness) => {
            kit.state.providers = kit.state.providers.map((provider) =>
              provider.instanceId === "claudeAgent" ? { ...provider, readiness } : provider,
            );
          };
          const cases: ReadonlyArray<readonly [string, ProviderReadiness]> = [
            ["signedOut", { state: "signedOut", source: "turn", message: "Sign in again" }],
            [
              "rejected",
              { state: "rejected", code: "invalid_api_key", message: "Key refused", at: NOW },
            ],
          ];
          for (const [state, readiness] of cases) {
            withClaude({ state: "ready" });
            const project = yield* setUp(`lost-${state}`);
            const run = yield* start(project.projectId);
            withClaude(readiness);
            yield* tick;
            const settled = yield* getRun(run.runId);
            assert.equal(settled.phase, "settled", state);
            assert.equal(settled.stopReason, "orchestratorLimited", state);
            assert.include(settled.stopDetail ?? "", state);
          }
        }),
      );
    }),
  );

  it.effect("settle runs its steps in order and notices once", () =>
    Effect.gen(function* () {
      const kit = yield* makeKit("settle");
      yield* runKit(
        kit,
        Effect.gen(function* () {
          const night = yield* runner;
          const store = yield* Store.HoustonNightShiftStore;
          const config = yield* ServerConfig.ServerConfig;
          const notices = yield* PubSub.subscribe(store.notices);
          const first = yield* setUp("settle-a");
          const second = yield* setUp("settle-b");

          const a = yield* start(first.projectId);
          yield* addCrew(a.runId, "worker", a.threadId, (yield* getRun(a.runId)).startedAt);
          busy(kit, "worker");
          kit.state.settleSteps.length = 0;
          yield* night.stop(a.runId);
          assert.deepEqual(kit.state.settleSteps, [
            "crew",
            "cancel:worker",
            `stop:${a.threadId}`,
            "remoteChanges",
            "cost",
            "report",
            "keepAwake",
            "settled",
            "notice",
          ]);
          const settled = yield* getRun(a.runId);
          assert.equal(settled.phase, "settled");
          assert.isNotNull(settled.endedAt);
          assert.isTrue(settled.noticeSent);
          assert.isTrue(kit.state.spawns[0]!.stdinClosed);
          const fallback = NodeFS.readFileSync(
            NodePath.join(Store.runFolder(config.baseDir, a.runId), "report.md"),
            "utf8",
          );
          assert.include(fallback, "The orchestrator published no report");
          assert.include(fallback, "it was stopped");
          const sent = yield* PubSub.takeUpTo(notices, 10);
          assert.lengthOf(sent, 1);
          assert.deepEqual(sent[0], {
            projectId: first.projectId,
            runId: a.runId,
            headline: "0 pull requests, 0 open decisions",
          });

          // A published report is kept.
          const b = yield* start(second.projectId);
          const report = NodePath.join(Store.runFolder(config.baseDir, b.runId), "report.md");
          NodeFS.writeFileSync(report, "# the orchestrator's report\n");
          yield* night.reportPublished(b.runId, { reportPath: report, summary: "done" });
          yield* night.stop(b.runId);
          assert.equal(NodeFS.readFileSync(report, "utf8"), "# the orchestrator's report\n");
          assert.lengthOf(yield* PubSub.takeUpTo(notices, 10), 1);

          // A restart after settle sends no second notice.
          yield* night.recover;
          assert.lengthOf(yield* PubSub.takeUpTo(notices, 10), 0);
        }),
      );
    }),
  );

  it.effect("a restart resumes or settles each live run", () =>
    Effect.gen(function* () {
      const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "night-restart-"));
      const kit = yield* makeKit("restart", {
        databaseFile: NodePath.join(directory, "state.sqlite"),
        serverRunner: true,
      });
      const ids = { live: 0, preflight: 0, past: 0, thread: "" };
      yield* runKit(
        kit,
        Effect.gen(function* () {
          const store = yield* Store.HoustonNightShiftStore;
          const p = yield* setUp("restart-p");
          const q = yield* setUp("restart-q");
          const live = yield* start(p.projectId, 120);
          yield* (yield* runner).wrapUp(live.runId);
          const opened = yield* store.openRun({
            projectId: q.projectId,
            trigger: "manual",
            scheduledTaskId: null,
            settings: (yield* store.settings(q.projectId))!.settings,
            startedAt: NOW,
            wrapUpAt: "2026-10-30T22:45:00.000Z",
            hardStopAt: "2026-10-30T23:30:00.000Z",
            operation: "runNow",
          });
          ids.live = live.runId;
          ids.thread = live.threadId;
          ids.preflight = opened.id;
        }),
      );
      assert.lengthOf(kit.state.spawns, 1);
      assert.isTrue(kit.state.spawns[0]!.stdinClosed, "the server's exit closed the pipe");

      // The server comes back 10 minutes later.
      const restartAt = Date.parse(NOW) + 10 * 60_000;
      const restartIso = DateTime.formatIso(DateTime.makeUnsafe(restartAt));
      const restart = runKit(
        kit,
        Effect.gen(function* () {
          return {
            live: yield* getRun(ids.live),
            preflight: yield* getRun(ids.preflight),
          };
        }),
        restartAt,
      );
      const once = yield* restart;
      assert.equal(once.preflight.phase, "refused");
      assert.equal(once.preflight.stopDetail, "the server stopped during preflight");
      assert.equal(once.live.phase, "wrappingUp");
      assert.lengthOf(once.live.interruptions, 1);
      assert.equal(once.live.interruptions[0]!.at, restartIso);
      assert.lengthOf(kit.state.spawns, 2, "keep-awake taken again");
      const restarts = notesOf(kit, ids.live, "restart");
      assert.lengthOf(restarts, 1);
      assert.equal(restarts[0]!.messageId, `message:night-shift:${ids.live}:restart:${restartIso}`);
      assert.equal(restarts[0]!.text, Runner.restartText(restartIso));

      // A second restart at the same time adds no message and no interruption.
      const twice = yield* restart;
      assert.lengthOf(twice.live.interruptions, 1);
      assert.lengthOf(notesOf(kit, ids.live, "restart"), 1);

      // Its orchestrator thread is gone at the next restart: settled.
      kit.state.states.delete(ids.thread);
      yield* runKit(
        kit,
        Effect.gen(function* () {
          const gone = yield* getRun(ids.live);
          assert.equal(gone.phase, "settled");
          assert.equal(gone.stopReason, "serverRestart");
          assert.include(gone.stopDetail ?? "", "gone");
          const r = yield* setUp("restart-r");
          ids.past = (yield* start(r.projectId, 60)).runId;
        }),
        restartAt,
      );

      // The server stays down past that run's hard stop.
      yield* runKit(
        kit,
        Effect.gen(function* () {
          const past = yield* getRun(ids.past);
          assert.equal(past.phase, "settled");
          assert.equal(past.stopReason, "serverRestart");
          assert.include(past.stopDetail ?? "", "hard stop");
        }),
        restartAt + 2 * 60 * 60_000,
      );
    }),
  );
});

describe("houston's messages to the orchestrator", () => {
  it.effect("houston's messages to the orchestrator are queued once per key", () =>
    Effect.gen(function* () {
      // Each kind of door 9 builds its documented id.
      assert.equal(Threads.messageId(7, "wrap-up"), "message:night-shift:7:wrap-up:");
      assert.equal(Threads.messageId(7, "limit", "codex"), "message:night-shift:7:limit:codex");
      assert.equal(
        Threads.messageId(7, "restart", "2026-10-31T02:10:00.000Z"),
        "message:night-shift:7:restart:2026-10-31T02:10:00.000Z",
      );
      assert.equal(Threads.messageId(7, "idle"), "message:night-shift:7:idle:");
      assert.equal(
        Threads.messageId(7, "ci", "abc123:lint"),
        "message:night-shift:7:ci:abc123:lint",
      );
      assert.equal(
        Threads.messageId(7, "substituted", "codex"),
        "message:night-shift:7:substituted:codex",
      );

      // A client cannot send the command: it is not a client command.
      const fromClient = Schema.decodeUnknownExit(OrchestrationV2RpcSchemas.dispatchCommand.input)({
        type: "houston.night-shift.notify",
        commandId: "command:client-notify",
        threadId: "thread:client",
        messageId: "message:night-shift:1:wrap-up:",
        text: "Wrap-up",
      });
      assert.equal(fromClient._tag, "Failure");

      const kit = yield* makeKit("notify");
      yield* runKit(
        kit,
        Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const fixture = makeRepository("notify", { kind: "bare" });
          const projectId = yield* createProject("notify", fixture.root);
          const threadId = ThreadId.make("thread:night-orchestrator");
          yield* orchestrator.dispatch({
            type: "thread.create",
            commandId: CommandId.make("command:night-notify:create"),
            threadId,
            projectId,
            title: "Night shift",
            modelSelection: model("claudeAgent"),
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: fixture.root,
            createdBy: "system",
            creationSource: "server",
          });
          // The orchestrator is busy, so Houston's message waits in the queue.
          kit.harness.script.hold.add("message:night-notify:first");
          yield* orchestrator.dispatch({
            type: "message.dispatch",
            commandId: CommandId.make("command:night-notify:first"),
            threadId,
            messageId: MessageId.make("message:night-notify:first"),
            text: "the brief",
            attachments: [],
            dispatchMode: { type: "start_immediately" },
            createdBy: "system",
            creationSource: "server",
          });
          yield* settleOrchestrator;

          const threads = yield* Effect.provide(
            Effect.service(Threads.NightShiftThreads),
            Threads.layer.pipe(
              Layer.provide(
                Layer.mergeAll(
                  Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
                  Layer.mock(ThreadManagementService.ThreadManagementService)({
                    dispatch: orchestrator.dispatch,
                    getThreadRecords: orchestrator.getThreadRecords,
                  }),
                ),
              ),
            ),
          );
          const messageId = Threads.messageId(1, "wrap-up");
          yield* threads.notify({ threadId, messageId, text: "Wrap-up: once" });
          yield* threads.notify({ threadId, messageId, text: "Wrap-up: once" });
          yield* settleOrchestrator;

          const projection = yield* orchestrator.getThreadProjection(threadId);
          const queued = projection.messages.filter((message) => message.id === messageId);
          assert.lengthOf(queued, 1);
          assert.equal(queued[0]!.role, "user");
          assert.equal(queued[0]!.text, "Wrap-up: once");
          assert.equal(queued[0]!.delivery?.intent, "queue");
        }),
      );
    }),
  );
});

const withProviders = (kit: Kit, states: Record<string, ProviderReadiness>) => {
  kit.state.providers = kit.state.providers.map((provider) =>
    provider.instanceId in states
      ? { ...provider, readiness: states[provider.instanceId]! }
      : provider,
  );
};

const runBrief = (runId: number) =>
  Effect.map(ServerConfig.ServerConfig, (config) =>
    NodeFS.readFileSync(NodePath.join(Store.runFolder(config.baseDir, runId), "brief.md"), "utf8"),
  );

const upNext = (
  projectId: ProjectId,
  number: number,
  queue = "up_next",
): UpNextTask & { readonly text: string } => ({
  number,
  key: `HOU-${number}`,
  title: `Task ${number}`,
  projectId,
  queue,
  text: `The text of HOU-${number}.`,
});

describe("night shift crew limits, picks and the ledger at start", () => {
  it.effect("readiness limits mark instances for the run and clear at reset", () =>
    Effect.gen(function* () {
      const kit = yield* makeKit("limits");
      kit.state.providers.push({
        instanceId: "claude-work",
        driver: "claudeAgent",
        readiness: { state: "ready" },
      });
      yield* runKit(
        kit,
        Effect.gen(function* () {
          const fixture = makeRepository("limits", { kind: "bare" });
          const projectId = yield* createProject("limits", fixture.root);
          yield* seedNightShift(projectId, {
            orchestrator: model("codex"),
            workers: [
              model("claudeAgent"),
              model("opencode"),
              model("claude-work"),
              model("antigravity"),
            ],
          });
          const started = yield* start(projectId);
          const resetsAt = "2026-10-30T23:00:00.000Z";
          withProviders(kit, {
            claudeAgent: { state: "outOfUsage", resetsAt, message: "Claude usage limit", at: NOW },
          });
          yield* tick;
          withProviders(kit, {
            opencode: { state: "outOfUsage", resetsAt: null, message: "OpenCode usage", at: NOW },
            "claude-work": { state: "signedOut", source: "turn", message: "Sign in again" },
            antigravity: {
              state: "rejected",
              code: "invalid_api_key",
              message: "Key refused",
              at: NOW,
            },
          });
          yield* tick;
          yield* tick;
          const limited = (yield* getRun(started.runId)).limited;
          assert.deepEqual(
            limited.map((limit) => [
              limit.instanceId,
              limit.state,
              limit.resetsAt,
              limit.clearedAt,
            ]),
            [
              ["claudeAgent", "outOfUsage", resetsAt, null],
              ["opencode", "outOfUsage", null, null],
              ["claude-work", "signedOut", null, null],
              ["antigravity", "rejected", null, null],
            ],
          );
          for (const limit of limited) assert.equal(limit.at, NOW);
          const limitNotes = notesOf(kit, started.runId, "limit");
          assert.deepEqual(
            limitNotes.map((note) => note.messageId),
            ["claudeAgent", "opencode", "claude-work", "antigravity"].map(
              (id) => `message:night-shift:${started.runId}:limit:${id}`,
            ),
          );
          // Claude names the next ready instance; once every worker is limited, none is ready.
          assert.include(limitNotes[0]!.text, "claudeAgent is outOfUsage");
          assert.include(limitNotes[0]!.text, resetsAt);
          assert.include(limitNotes[0]!.text, "opencode");
          assert.include(limitNotes[3]!.text, "No other worker instance is ready");
          assert.equal(
            (yield* getRun(started.runId)).phase,
            "running",
            "a worker limit settles nothing",
          );

          // Ready again before the reset: still limited. After the reset: unlimited, recorded.
          withProviders(kit, { claudeAgent: { state: "ready" } });
          yield* tick;
          assert.isNull((yield* getRun(started.runId)).limited[0]!.clearedAt);
          yield* TestClock.setTime(Date.parse(resetsAt) + 1_000);
          yield* tick;
          const cleared = (yield* getRun(started.runId)).limited[0]!;
          assert.equal(cleared.instanceId, "claudeAgent");
          assert.equal(cleared.clearedAt, "2026-10-30T23:00:01.000Z");
          assert.lengthOf(notesOf(kit, started.runId, "limit"), 4, "a clear sends no message");

          // Readiness is read as published: no quota request and no probe process.
          assert.deepEqual(kit.state.httpRequests, []);
          assert.deepEqual(
            kit.state.spawns.map((spawn) => spawn.command),
            ["systemd-inhibit"],
          );
        }),
      );
    }),
  );

  it.effect("picks reach the brief and the ledger", () =>
    Effect.gen(function* () {
      const kit = yield* makeKit("picks");
      yield* runKit(
        kit,
        Effect.gen(function* () {
          const store = yield* Store.HoustonNightShiftStore;
          const night = yield* runner;
          const fixture = makeRepository("picks", { kind: "bare" });
          const projectId = yield* createProject("picks", fixture.root);
          yield* seedNightShift(projectId, { backlog: { enabled: true, max: 3 } });
          kit.state.backlog = [
            upNext(projectId, 7),
            upNext(projectId, 9),
            upNext(projectId, 12),
            upNext(projectId, 13),
            upNext(projectId, 14, "none"),
          ];
          const first = yield* start(projectId);
          const picks = (yield* store.runEntries(first.runId)).filter(
            (entry) => entry.kind === "pick",
          );
          assert.deepEqual(
            picks.map((entry) => entry.task_number),
            [7, 9, 12],
          );
          const brief = yield* runBrief(first.runId);
          for (const number of [7, 9, 12]) {
            assert.include(brief, `HOU-${number}: Task ${number}`);
            assert.include(brief, `The text of HOU-${number}.`);
          }
          assert.notInclude(brief, "HOU-13");
          assert.notInclude(brief, "HOU-14");
          assert.include(brief, "houston_task_claim");
          assert.include(brief, "houston_task_handback");
          yield* night.stop(first.runId);

          // Picked last run and not done since: skipped; done since: picked again.
          kit.state.doneSince.add("HOU-9");
          const second = yield* start(projectId);
          assert.deepEqual(
            (yield* store.runEntries(second.runId))
              .filter((entry) => entry.kind === "pick")
              .map((entry) => entry.task_number),
            [9, 13],
          );
          yield* night.stop(second.runId);

          // Picks off: no pick entry, and the brief names no task.
          const other = makeRepository("picks-off", { kind: "bare" });
          const offProject = yield* createProject("picks-off", other.root);
          yield* seedNightShift(offProject);
          kit.state.backlog = [upNext(offProject, 21)];
          const off = yield* start(offProject);
          assert.lengthOf(
            (yield* store.runEntries(off.runId)).filter((entry) => entry.kind === "pick"),
            0,
          );
          const offBrief = yield* runBrief(off.runId);
          assert.notInclude(offBrief, "HOU-21");
          assert.include(offBrief, "No backlog tasks are picked for this run.");
        }),
      );
    }),
  );

  it.effect("earlier pull requests get their fate at the next start", () =>
    Effect.gen(function* () {
      const kit = yield* makeKit("fates");
      yield* runKit(
        kit,
        Effect.gen(function* () {
          const store = yield* Store.HoustonNightShiftStore;
          const night = yield* runner;
          const { projectId } = yield* setUp("fates");
          const first = yield* start(projectId);
          const pullRequest = (number: number, status: string | null = null) =>
            store.addEntry({
              runId: first.runId,
              projectId,
              kind: "pr",
              title: `Change ${number}`,
              prNumber: number,
              status,
              createdAt: NOW,
            });
          const merged = yield* pullRequest(1);
          const closed = yield* pullRequest(2);
          const open = yield* pullRequest(3);
          const unreadable = yield* pullRequest(4);
          const known = yield* pullRequest(5, "merged");
          yield* night.stop(first.runId);
          kit.state.pullRequestStates.set(1, "merged");
          kit.state.pullRequestStates.set(2, "closed");
          kit.state.pullRequestStates.set(3, "open");

          const second = yield* start(projectId);
          assert.deepEqual(kit.state.pullRequestReads.toSorted(), [1, 2, 3, 4], "each read once");
          const statusOf = (id: number) =>
            Effect.map(store.getEntry(id), (entry) => entry?.status ?? null);
          assert.equal(yield* statusOf(merged.id), "merged");
          assert.equal(yield* statusOf(closed.id), "closed");
          assert.isNull(yield* statusOf(open.id), "open is no fate yet");
          assert.isNull(yield* statusOf(unreadable.id));
          assert.equal(yield* statusOf(known.id), "merged");
          const brief = yield* runBrief(second.runId);
          assert.include(brief, "pull request #1 (merged): Change 1");
          assert.include(brief, "pull request #2 (closed): Change 2");
          assert.include(brief, "pull request #3 (open): Change 3");
          assert.include(brief, "pull request #4 (fate unknown): Change 4");
          assert.include(brief, "pull request #5 (merged): Change 5");
        }),
      );
    }),
  );

  it.effect("a picked task is claimed by its worker and told about its pull request", () =>
    Effect.gen(function* () {
      // The comment half moves to PR 3 with landing; this proves the claim half.
      const harness = yield* makeRunsHarness("night-claim");
      yield* runWith(harness, (context) =>
        Effect.gen(function* () {
          yield* context.setSettings({ access: "write" });
          const task = yield* context.readyTask("Retry the upload");
          const backlog = yield* NightShiftBacklog;
          const listed = yield* backlog.tasks(context.projectId);
          const picked = pickTasks({
            projectId: context.projectId,
            max: 3,
            backlog: listed,
            earlierPicks: new Map(),
          });
          assert.deepEqual(picked, [task.number]);

          // The worker Night shift delegated claims the picked task under its own thread.
          const worker = ThreadId.make("night-worker:7");
          const claimed = yield* context.runs.claim(
            {
              threadId: worker,
              projectId: context.projectId,
              actor: `agent:${worker} (Night shift worker)`,
              provider: "claudeAgent",
            },
            { id: task.key },
          );
          assert.equal(claimed.threadId, worker);
          const detail = yield* context.tasks.get({ id: task.key });
          assert.equal(detail.task.status, "in_progress");
          assert.equal(detail.runs[0]?.threadId, worker);
        }).pipe(Effect.provide(layerBacklog)),
      );
    }),
  );
});
