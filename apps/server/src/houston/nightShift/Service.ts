// houston.nightShift.*: a project's Night shift settings and schedule, its runs, preflight, Run now,
// wrap-up and Stop, and the overview with one notice per settled run.
import {
  DEFAULT_MODEL_BY_PROVIDER,
  type ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ScheduledTaskId,
} from "@t3tools/contracts";
import {
  HOUSTON_NIGHT_SHIFT_LIMITS as LIMITS,
  HoustonNightShiftError,
  type HoustonNightShiftEmptyResult,
  type HoustonNightShiftOverviewEvent,
  type HoustonNightShiftOverviewInput,
  type HoustonNightShiftPreflightInput,
  type HoustonNightShiftPreflightResult,
  type HoustonNightShiftProjectInput,
  type HoustonNightShiftRunInput,
  type HoustonNightShiftRunNowInput,
  type HoustonNightShiftRunNowResult,
  type HoustonNightShiftSettings,
  type HoustonNightShiftSnapshot,
  type HoustonNightShiftStopResult,
  type HoustonNightShiftUpdateInput,
  type HoustonNightShiftWrapUpResult,
  type NightRun,
  type NightShiftOverviewRow,
} from "@t3tools/contracts/houston/nightShift";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";

import * as ProjectStore from "../../orchestration-v2/ProjectStore.ts";
import * as ScheduledTaskService from "../../scheduledTasks/ScheduledTaskService.ts";
import { detect } from "./detect.ts";
import { NightShiftGit } from "./Git.ts";
import { NightShiftMachine, NightShiftMergeQueue, NightShiftProviders } from "./Host.ts";
import { defaultSettings, headline, ORCHESTRATOR_DRIVERS, validateSettings } from "./rules.ts";
import { HoustonNightShiftRunner } from "./Runner.ts";
import { HoustonNightShiftClaim } from "./ScheduledTaskRunner.ts";
import { HoustonNightShiftStore, liveRunText, LIVE_PHASES, type StoredRun } from "./Store.ts";

export const TASK_PROMPT =
  "Houston Night shift of this project. Houston writes each run's brief; edit the start time, nights or pause here.";
const DEFAULT_START = "23:30";
const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));

const refuse = (
  kind: HoustonNightShiftError["kind"],
  operation: string,
  message: string,
  extra: Partial<Pick<HoustonNightShiftError, "limit" | "actual" | "items">> = {},
): Effect.Effect<never, HoustonNightShiftError> =>
  Effect.fail(new HoustonNightShiftError({ kind, operation, message, ...extra }));

const publicRun = (run: StoredRun): NightRun => ({
  id: run.id,
  projectId: run.projectId,
  trigger: run.trigger,
  scheduledTaskId: run.scheduledTaskId,
  phase: run.phase,
  stopReason: run.stopReason,
  stopDetail: run.stopDetail,
  orchestratorThreadId: run.orchestratorThreadId,
  worktreePath: run.worktreePath,
  branch: run.branch,
  startedAt: run.startedAt,
  wrapUpAt: run.wrapUpAt,
  hardStopAt: run.hardStopAt,
  wrapUpSent: run.wrapUpSent,
  endedAt: run.endedAt,
  preflight: run.preflight,
  interruptions: run.interruptions,
  summary: run.summary,
  reportPath: run.reportPath,
  keepAwake: run.keepAwake,
});

const isLive = (run: StoredRun) => LIVE_PHASES.includes(run.phase);

export class HoustonNightShiftService extends Context.Service<
  HoustonNightShiftService,
  {
    readonly get: (
      input: HoustonNightShiftProjectInput,
    ) => Effect.Effect<HoustonNightShiftSnapshot, HoustonNightShiftError>;
    readonly subscribe: (
      input: HoustonNightShiftProjectInput,
    ) => Stream.Stream<HoustonNightShiftSnapshot, HoustonNightShiftError>;
    readonly subscribeOverview: (
      input: HoustonNightShiftOverviewInput,
    ) => Stream.Stream<HoustonNightShiftOverviewEvent>;
    readonly create: (
      input: HoustonNightShiftProjectInput,
    ) => Effect.Effect<HoustonNightShiftSnapshot, HoustonNightShiftError>;
    readonly update: (
      input: HoustonNightShiftUpdateInput,
    ) => Effect.Effect<HoustonNightShiftSnapshot, HoustonNightShiftError>;
    readonly delete: (
      input: HoustonNightShiftProjectInput,
    ) => Effect.Effect<HoustonNightShiftEmptyResult, HoustonNightShiftError>;
    readonly preflight: (
      input: HoustonNightShiftPreflightInput,
    ) => Effect.Effect<HoustonNightShiftPreflightResult, HoustonNightShiftError>;
    readonly runNow: (
      input: HoustonNightShiftRunNowInput,
    ) => Effect.Effect<HoustonNightShiftRunNowResult, HoustonNightShiftError>;
    readonly wrapUp: (
      input: HoustonNightShiftRunInput,
    ) => Effect.Effect<HoustonNightShiftWrapUpResult, HoustonNightShiftError>;
    readonly stop: (
      input: HoustonNightShiftRunInput,
    ) => Effect.Effect<HoustonNightShiftStopResult, HoustonNightShiftError>;
  }
>()("houston/houston/nightShift/Service/HoustonNightShiftService") {}

const make = Effect.gen(function* () {
  const store = yield* HoustonNightShiftStore;
  const runner = yield* HoustonNightShiftRunner;
  const claim = yield* HoustonNightShiftClaim;
  const scheduled = yield* ScheduledTaskService.ScheduledTaskService;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const git = yield* NightShiftGit;
  const machine = yield* NightShiftMachine;
  const providers = yield* NightShiftProviders;
  const mergeQueue = yield* NightShiftMergeQueue;

  const projectOf = (operation: string, projectId: ProjectId) =>
    projects.get(projectId).pipe(
      Effect.orDie,
      Effect.flatMap((row) =>
        Option.isSome(row) && row.value.deletedAt === null
          ? Effect.succeed(row.value)
          : refuse("not_found", operation, `project ${projectId} does not exist`),
      ),
    );

  const findTask = (taskId: ScheduledTaskId | null | undefined) =>
    scheduled.list().pipe(
      Effect.orDie,
      Effect.map(({ tasks }) =>
        taskId === null || taskId === undefined
          ? undefined
          : tasks.find((task) => task.id === taskId),
      ),
    );

  // Detection asks PATH synchronously: the first pass lists the programs, the second answers them.
  const detected = Effect.fn("HoustonNightShiftService.detected")(function* (root: string) {
    const known = new Map<string, boolean>();
    const programs = new Set<string>();
    detect(root, (program) => {
      programs.add(program);
      return false;
    });
    for (const program of programs) known.set(program, yield* machine.onPath(program));
    return detect(root, (program) => known.get(program) ?? false);
  });

  const snapshot = Effect.fn("HoustonNightShiftService.snapshot")(function* (
    projectId: ProjectId,
    root: string,
  ) {
    const stored = yield* store.settings(projectId);
    const task = yield* findTask(stored?.scheduledTaskId);
    const runs = yield* store.listRuns(projectId, LIMITS.runsPerSnapshot);
    const live = runs.find(isLive);
    const found = yield* detected(root);
    return {
      projectId,
      settings: stored?.settings ?? null,
      revision: stored?.revision ?? 0,
      schedule:
        task === undefined || task.schedule.type !== "fixed_time"
          ? task === undefined
            ? null
            : {
                scheduledTaskId: task.id,
                enabled: task.enabled,
                timeOfDay: "",
                weekdays: [],
                nextRunAt: task.nextRunAt,
                lastRunStatus: task.lastRunStatus,
                lastRunError: task.lastRunError,
              }
          : {
              scheduledTaskId: task.id,
              enabled: task.enabled,
              timeOfDay: task.schedule.timeOfDay,
              weekdays: [...(task.schedule.weekdays ?? [])],
              nextRunAt: task.nextRunAt,
              lastRunStatus: task.lastRunStatus,
              lastRunError: task.lastRunError,
            },
      detected: { checks: [...found.checks], startCommand: found.startCommand },
      liveRun: live === undefined ? null : publicRun(live),
      crew: live === undefined ? [] : [...(yield* store.crew(live.id))],
      runs: runs.map(publicRun),
      crewCap: (stored?.settings.liveWorkers ?? 0) + 2,
    } satisfies HoustonNightShiftSnapshot;
  });

  const get: HoustonNightShiftService["Service"]["get"] = Effect.fn("HoustonNightShiftService.get")(
    function* (input) {
      const project = yield* projectOf("get", input.projectId);
      return yield* snapshot(input.projectId, project.workspaceRoot);
    },
  );

  const subscribe: HoustonNightShiftService["Service"]["subscribe"] = (input) =>
    Stream.unwrap(
      Effect.gen(function* () {
        const project = yield* projectOf("subscribe", input.projectId);
        // Subscribe before reading to buffer concurrent changes.
        const subscription = yield* PubSub.subscribe(store.changes);
        return Stream.concat(
          Stream.fromEffect(snapshot(input.projectId, project.workspaceRoot)),
          Stream.fromSubscription(subscription).pipe(
            Stream.filter((projectId) => projectId === input.projectId),
            Stream.mapEffect(() => snapshot(input.projectId, project.workspaceRoot)),
          ),
        );
      }),
    );

  const overviewRows = Effect.gen(function* () {
    const rows: NightShiftOverviewRow[] = [];
    const { tasks } = yield* scheduled.list().pipe(Effect.orDie);
    for (const projectId of yield* store.projects) {
      const stored = yield* store.settings(projectId);
      const task = tasks.find((candidate) => candidate.id === stored?.scheduledTaskId);
      const runs = yield* store.listRuns(projectId, LIMITS.runsPerSnapshot);
      const last = runs.find((run) => run.phase === "settled" && run.endedAt !== null);
      const entries = last === undefined ? [] : yield* store.entries(last.id);
      rows.push({
        projectId,
        enabled: task?.enabled ?? false,
        nextRunAt: task?.nextRunAt ?? null,
        live: runs.some(isLive),
        lastRun:
          last === undefined
            ? null
            : {
                runId: last.id,
                headline: headline(
                  entries.filter((entry) => entry.kind === "pr").length,
                  entries.filter((entry) => entry.kind === "decision" && entry.choice === null)
                    .length,
                ),
                endedAt: last.endedAt!,
              },
      });
    }
    return rows;
  });

  const subscribeOverview: HoustonNightShiftService["Service"]["subscribeOverview"] = () =>
    Stream.unwrap(
      Effect.gen(function* () {
        const changes = yield* PubSub.subscribe(store.changes);
        const notices = yield* PubSub.subscribe(store.notices);
        const overview = overviewRows.pipe(
          Effect.map((rows): HoustonNightShiftOverviewEvent => ({ type: "overview", rows })),
        );
        return Stream.concat(
          Stream.fromEffect(overview),
          Stream.merge(
            Stream.fromSubscription(changes).pipe(Stream.mapEffect(() => overview)),
            Stream.fromSubscription(notices).pipe(
              Stream.map(
                (notice): HoustonNightShiftOverviewEvent => ({
                  type: "notice",
                  projectId: notice.projectId,
                  runId: notice.runId,
                  headline: notice.headline,
                }),
              ),
            ),
          ),
        );
      }),
    );

  const firstOrchestrator = Effect.gen(function* () {
    const listed = yield* providers.list;
    const usable = listed.filter((provider) => ORCHESTRATOR_DRIVERS.has(provider.driver));
    const order = ["claudeAgent", "codex", "opencode"];
    const ranked = usable.toSorted(
      (left, right) => order.indexOf(left.driver) - order.indexOf(right.driver),
    );
    return ranked.find((provider) => provider.readiness?.state === "ready") ?? ranked[0];
  });

  const upsertTask = (input: {
    readonly id?: ScheduledTaskId;
    readonly title: string;
    readonly projectId: ProjectId;
    readonly settings: HoustonNightShiftSettings;
    readonly schedule: { readonly timeOfDay: string; readonly weekdays: ReadonlyArray<number> };
    readonly baseRef: string;
    readonly operation: string;
  }) =>
    scheduled
      .upsert({
        ...(input.id === undefined ? {} : { id: input.id, requireExisting: true }),
        title: input.title,
        prompt: TASK_PROMPT,
        enabled: input.schedule.weekdays.length > 0 && input.settings.enabled,
        schedule: {
          type: "fixed_time",
          timeOfDay: input.schedule.timeOfDay,
          weekdays: [...input.schedule.weekdays],
        } as never,
        projectId: input.projectId,
        workspaceStrategy: { type: "worktree", baseRef: input.baseRef },
        modelSelection: input.settings.orchestrator,
        runtimeMode: "full-access",
        interactionMode: "default",
        createdBy: "user",
        creationSource: "web",
      })
      .pipe(
        Effect.mapError(
          (error) =>
            new HoustonNightShiftError({
              kind: "invalid",
              operation: input.operation,
              message: `the scheduled task could not be saved: ${error.message}`,
            }),
        ),
      );

  const create: HoustonNightShiftService["Service"]["create"] = Effect.fn(
    "HoustonNightShiftService.create",
  )(function* (input) {
    const project = yield* projectOf("create", input.projectId);
    const stored = yield* store.settings(input.projectId);
    const existing = yield* findTask(stored?.scheduledTaskId);
    if (existing !== undefined) {
      return yield* refuse(
        "conflict",
        "create",
        `this project's Night shift is already set up as scheduled task ${existing.id}; change it in its settings or in Scheduled tasks`,
      );
    }
    const origin = yield* git.origin(project.workspaceRoot);
    if (origin.kind === "notRepository") {
      return yield* refuse(
        "unsupported",
        "create",
        `${project.workspaceRoot} is not a git repository; Night shift lands its work as pull requests`,
      );
    }
    if (origin.kind === "noOrigin") {
      return yield* refuse(
        "unsupported",
        "create",
        `${project.workspaceRoot} has no origin remote; Night shift opens pull requests on github.com`,
      );
    }
    if (origin.host !== "github.com") {
      return yield* refuse(
        "unsupported",
        "create",
        `the origin of ${project.workspaceRoot} is on ${origin.host || origin.url}, not github.com; Night shift opens pull requests on github.com`,
      );
    }
    const orchestrator = yield* firstOrchestrator;
    if (orchestrator === undefined) {
      return yield* refuse(
        "unsupported",
        "create",
        "no Claude, Codex or OpenCode provider instance is configured to run the orchestrator",
      );
    }
    const found = yield* detected(project.workspaceRoot);
    const settings = defaultSettings({
      orchestrator: {
        instanceId: ProviderInstanceId.make(orchestrator.instanceId),
        model: DEFAULT_MODEL_BY_PROVIDER[ProviderDriverKind.make(orchestrator.driver)] ?? "default",
      },
      checks: found.checks,
      startCommand: found.startCommand,
    });
    const base = yield* git.defaultBranch(project.workspaceRoot).pipe(Effect.option);
    const created = yield* upsertTask({
      title: `Night shift · ${project.title}`,
      projectId: input.projectId,
      settings,
      schedule: { timeOfDay: DEFAULT_START, weekdays: [] },
      baseRef: Option.isSome(base) ? base.value.branch : "HEAD",
      operation: "create",
    });
    yield* store.createSettings({
      projectId: input.projectId,
      settings,
      scheduledTaskId: created.task.id,
      at: yield* nowIso,
    });
    return yield* snapshot(input.projectId, project.workspaceRoot);
  });

  const update: HoustonNightShiftService["Service"]["update"] = Effect.fn(
    "HoustonNightShiftService.update",
  )(function* (input) {
    const project = yield* projectOf("update", input.projectId);
    const stored = yield* store.settings(input.projectId);
    if (stored === undefined) {
      return yield* refuse("not_found", "update", `project ${input.projectId} has no Night shift; set it up first`);
    }
    if (stored.revision !== input.expectedRevision) {
      return yield* refuse(
        "conflict",
        "update",
        `the settings changed: revision ${stored.revision} is stored, this edit is based on revision ${input.expectedRevision}`,
        { limit: stored.revision, actual: input.expectedRevision },
      );
    }
    const task = yield* findTask(stored.scheduledTaskId);
    if (task === undefined) {
      return yield* refuse("not_found", "update", `project ${input.projectId}'s Night shift task was deleted; set it up again`);
    }
    const schedule =
      task.schedule.type === "fixed_time"
        ? { timeOfDay: task.schedule.timeOfDay, weekdays: task.schedule.weekdays ?? [] }
        : { timeOfDay: DEFAULT_START, weekdays: [] };
    const listed = yield* providers.list;
    const refusal = validateSettings(input.settings, {
      start: schedule.timeOfDay,
      drivers: new Map(listed.map((provider) => [provider.instanceId, provider.driver])),
      mergeQueueVerification: yield* mergeQueue.verificationCommand(input.projectId),
    });
    if (refusal !== null) {
      return yield* refuse(refusal.kind, "update", refusal.message, {
        ...(refusal.limit === undefined ? {} : { limit: refusal.limit }),
        ...(refusal.actual === undefined ? {} : { actual: refusal.actual }),
      });
    }
    const written = yield* store.updateSettings({
      projectId: input.projectId,
      settings: input.settings,
      expectedRevision: input.expectedRevision,
      at: yield* nowIso,
    });
    if (!written.written) {
      return yield* refuse(
        "conflict",
        "update",
        `the settings changed: revision ${written.revision} is stored, this edit is based on revision ${input.expectedRevision}`,
        { limit: written.revision, actual: input.expectedRevision },
      );
    }
    yield* upsertTask({
      id: task.id,
      title: task.title,
      projectId: input.projectId,
      settings: input.settings,
      schedule,
      baseRef:
        task.workspaceStrategy.type === "worktree" ? task.workspaceStrategy.baseRef : "HEAD",
      operation: "update",
    });
    return yield* snapshot(input.projectId, project.workspaceRoot);
  });

  const remove: HoustonNightShiftService["Service"]["delete"] = Effect.fn(
    "HoustonNightShiftService.delete",
  )(function* (input) {
    yield* projectOf("delete", input.projectId);
    const stored = yield* store.settings(input.projectId);
    if (stored === undefined) {
      return yield* refuse("not_found", "delete", `project ${input.projectId} has no Night shift`);
    }
    const live = (yield* store.liveRuns).find((run) => run.projectId === input.projectId);
    if (live !== undefined) {
      return yield* refuse("busy", "delete", `${liveRunText(live)}; stop it before deleting Night shift`);
    }
    if (stored.scheduledTaskId !== null && (yield* findTask(stored.scheduledTaskId)) !== undefined) {
      yield* scheduled.delete({ id: stored.scheduledTaskId }).pipe(
        Effect.mapError(
          (error) =>
            new HoustonNightShiftError({
              kind: "invalid",
              operation: "delete",
              message: `the scheduled task ${stored.scheduledTaskId} could not be deleted: ${error.message}`,
            }),
        ),
      );
    }
    yield* store.projectRemoved(input.projectId);
    return {};
  });

  const preflight: HoustonNightShiftService["Service"]["preflight"] = (input) =>
    runner.preflight(input.projectId, input.durationMinutes, "preflight");

  const runNow: HoustonNightShiftService["Service"]["runNow"] = Effect.fn(
    "HoustonNightShiftService.runNow",
  )(function* (input) {
    yield* projectOf("runNow", input.projectId);
    const stored = yield* store.settings(input.projectId);
    const task = yield* findTask(stored?.scheduledTaskId);
    if (stored === undefined || task === undefined) {
      return yield* refuse(
        "not_found",
        "runNow",
        stored === undefined
          ? `project ${input.projectId} has no Night shift; set it up first`
          : `project ${input.projectId}'s Night shift task was deleted; set it up again`,
      );
    }
    if (
      input.durationMinutes < LIMITS.runNowMinMinutes ||
      input.durationMinutes > LIMITS.runNowMaxMinutes
    ) {
      return yield* refuse(
        "invalid",
        "runNow",
        `a Run now lasts ${LIMITS.runNowMinMinutes}-${LIMITS.runNowMaxMinutes} minutes; got ${input.durationMinutes}`,
        { actual: input.durationMinutes },
      );
    }
    yield* claim.holdDuration(task.id, input.durationMinutes);
    const ran = yield* scheduled.runNow({ id: task.id }).pipe(Effect.result);
    const refusal = yield* claim.lastRefusal(task.id);
    if (ran._tag === "Success" && ran.success.threadId !== null) {
      const run = yield* store.runByThread(ran.success.threadId);
      if (run !== undefined) return { runId: run.id, threadId: ran.success.threadId };
    }
    if (refusal !== undefined) return yield* refusal;
    const live = (yield* store.liveRuns).find((run) => run.projectId === input.projectId);
    return yield* refuse(
      "busy",
      "runNow",
      live === undefined
        ? `the Night shift task ${task.id} is already starting`
        : `${liveRunText(live)}; one Night shift run per project is live at a time`,
    );
  });

  return HoustonNightShiftService.of({
    get,
    subscribe,
    subscribeOverview,
    create,
    update,
    delete: remove,
    preflight,
    runNow,
    wrapUp: Effect.fn("HoustonNightShiftService.wrapUp")((input) => runner.wrapUp(input.runId)),
    stop: Effect.fn("HoustonNightShiftService.stop")((input) => runner.stop(input.runId)),
  });
});

export const layer = Layer.effect(HoustonNightShiftService, make);
