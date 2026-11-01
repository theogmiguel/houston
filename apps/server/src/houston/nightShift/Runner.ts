// A Night shift run from start to settle: preflight, the brief, keep-awake and the orchestrator's
// launch; then wrap-up, the idle rule, the orchestrator's end or limit, the hard stop and Stop; then
// the settle sequence and its one notice. A tick drives the clock-bound rules; on start it recovers.
import {
  CommandId,
  MessageId,
  type ProjectId,
  type ScheduledTaskId,
  type ThreadId,
} from "@t3tools/contracts";
import {
  HOUSTON_NIGHT_SHIFT_LIMITS as LIMITS,
  HoustonNightShiftError,
  type HoustonNightShiftPreflightResult,
  type HoustonNightShiftStopResult,
  type HoustonNightShiftWrapUpResult,
  type NightStopReason,
  type PreflightItem,
} from "@t3tools/contracts/houston/nightShift";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import * as ServerConfig from "../../config.ts";
import * as ProjectStore from "../../orchestration-v2/ProjectStore.ts";
import { composeBrief, ledgerDigest, type BriefPick, type DigestEntry } from "./brief.ts";
import { HoustonCrewGate } from "./CrewGate.ts";
import { NightShiftGit } from "./Git.ts";
import {
  NightShiftBacklog,
  NightShiftMachine,
  NightShiftMergeQueue,
  NightShiftProviders,
  NightShiftPullRequests,
} from "./Host.ts";
import { NightShiftKeepAwake } from "./KeepAwake.ts";
import { blockingItems, evaluatePreflight } from "./preflight.ts";
import {
  fallbackReport,
  headline,
  idleDecision,
  pickTasks,
  substituteInstance,
  threadHours,
  type InstanceState,
} from "./rules.ts";
import {
  HoustonNightShiftStore,
  liveRunText,
  runFolder,
  toJson,
  type LedgerEntry,
  type NewEntry,
  type NightLimit,
  type StoredRun,
} from "./Store.ts";
import { messageId, NightShiftThreads } from "./Threads.ts";
import { runTimes, type RunTimes } from "./window.ts";

/** How often the clock-bound rules are evaluated. */
const TICK = "15 seconds";
const LIMITED_STATES: ReadonlySet<string> = new Set(["outOfUsage", "signedOut", "rejected"]);

export type StartTrigger = "scheduled" | "catchUp" | "manual";

export interface StartInput {
  readonly projectId: ProjectId;
  readonly trigger: StartTrigger;
  readonly scheduledTaskId: ScheduledTaskId | null;
  /** Night shift's Run now; absent for a scheduled start or upstream's Run now. */
  readonly durationMinutes?: number | undefined;
  /** A catch-up run's missed start; the window is computed from it. */
  readonly windowStartMs?: number | undefined;
  readonly operation: string;
}

/** Each settle step, in order, for tests that check the sequence. */
export const SettleObserver = Context.Reference<(step: string, runId: number) => void>(
  "houston/houston/nightShift/Runner/SettleObserver",
  { defaultValue: () => () => undefined },
);

export class HoustonNightShiftRunner extends Context.Service<
  HoustonNightShiftRunner,
  {
    readonly preflight: (
      projectId: ProjectId,
      durationMinutes: number | undefined,
      operation: string,
    ) => Effect.Effect<HoustonNightShiftPreflightResult, HoustonNightShiftError>;
    readonly start: (
      input: StartInput,
    ) => Effect.Effect<
      { readonly runId: number; readonly threadId: ThreadId },
      HoustonNightShiftError
    >;
    readonly wrapUp: (
      runId: number,
    ) => Effect.Effect<HoustonNightShiftWrapUpResult, HoustonNightShiftError>;
    readonly stop: (
      runId: number,
    ) => Effect.Effect<HoustonNightShiftStopResult, HoustonNightShiftError>;
    /** The orchestrator published its report; the run settles once its active run ends. */
    readonly reportPublished: (
      runId: number,
      input: { readonly reportPath: string; readonly summary: string },
    ) => Effect.Effect<void>;
    /** Evaluates every live run against the clock and the orchestrator's state. */
    readonly tick: Effect.Effect<void>;
    /** What the server does on start: refuses, settles or resumes each live run. */
    readonly recover: Effect.Effect<void>;
  }
>()("houston/houston/nightShift/Runner/HoustonNightShiftRunner") {}

const refuse = (
  kind: HoustonNightShiftError["kind"],
  operation: string,
  message: string,
  extra: Partial<Pick<HoustonNightShiftError, "limit" | "actual" | "items">> = {},
): Effect.Effect<never, HoustonNightShiftError> =>
  Effect.fail(new HoustonNightShiftError({ kind, operation, message, ...extra }));

const iso = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));

const decodeDetail = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));

const digestEntry = (entry: LedgerEntry): DigestEntry => {
  const detail = decodeDetail(entry.detail_json);
  const competitor =
    Option.isSome(detail) &&
    detail.value !== null &&
    typeof detail.value === "object" &&
    typeof (detail.value as { competitor?: unknown }).competitor === "string"
      ? (detail.value as { competitor: string }).competitor
      : undefined;
  return {
    id: entry.id,
    runId: entry.run_id,
    kind: entry.kind,
    title: entry.title,
    status: entry.status,
    prNumber: entry.pr_number,
    body: entry.body,
    choice: entry.choice,
    competitor,
  };
};

export const wrapUpText = (hardStopAt: string) =>
  `Wrap-up: start nothing new, finish or park what is open, and publish the report with houston_night_report before ${hardStopAt}.`;
export const idleText =
  "Night shift: nothing has run for 10 minutes. Continue with the plan, or publish the report with houston_night_report; the run ends in 10 more idle minutes.";
export const restartText = (at: string) =>
  `Night shift: Houston restarted at ${at}. Read your delegated tasks with task_status before starting more.`;

const make = Effect.gen(function* () {
  const store = yield* HoustonNightShiftStore;
  const threads = yield* NightShiftThreads;
  const git = yield* NightShiftGit;
  const machine = yield* NightShiftMachine;
  const providers = yield* NightShiftProviders;
  const mergeQueue = yield* NightShiftMergeQueue;
  const keepAwake = yield* NightShiftKeepAwake;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const config = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const observe = yield* SettleObserver;
  const gate = yield* HoustonCrewGate;
  const backlog = yield* NightShiftBacklog;
  const pullRequests = yield* NightShiftPullRequests;

  const startLock = yield* Semaphore.make(1);
  const settling = yield* Ref.make<ReadonlySet<number>>(new Set());
  const idleSince = yield* Ref.make<ReadonlyMap<number, number>>(new Map());

  const projectOf = (operation: string, projectId: ProjectId) =>
    projects.get(projectId).pipe(
      Effect.orDie,
      Effect.flatMap((row) =>
        Option.isSome(row) && row.value.deletedAt === null
          ? Effect.succeed(row.value)
          : refuse("not_found", operation, `project ${projectId} does not exist`),
      ),
    );

  const settingsOf = Effect.fn("HoustonNightShiftRunner.settingsOf")(function* (
    operation: string,
    projectId: ProjectId,
  ) {
    const stored = yield* store.settings(projectId);
    if (stored === undefined) {
      return yield* refuse(
        "not_found",
        operation,
        `project ${projectId} has no Night shift; set it up first`,
      );
    }
    return stored;
  });

  const timesFor = Effect.fn("HoustonNightShiftRunner.timesFor")(function* (input: {
    readonly trigger: StartTrigger | "preview";
    readonly startMs: number;
    readonly durationMinutes: number | undefined;
    readonly wrapUp: string;
    readonly hardStop: string;
  }) {
    const timeZone = yield* machine.timeZone;
    const times: RunTimes =
      input.durationMinutes !== undefined
        ? runTimes({
            kind: "runNow",
            startMs: input.startMs,
            durationMinutes: input.durationMinutes,
          })
        : runTimes({
            kind: input.trigger === "manual" ? "upstreamRunNow" : input.trigger,
            startMs: input.startMs,
            wrapUp: input.wrapUp,
            hardStop: input.hardStop,
            timeZone,
          });
    return { times, timeZone };
  });

  const readingsFor = Effect.fn("HoustonNightShiftRunner.readingsFor")(function* (
    projectId: ProjectId,
    root: string,
    settings: StoredRun["settings"],
    window: { readonly startMs: number; readonly hardStopMs: number; readonly timeZone: string },
  ) {
    const readings = yield* machine.readings(root);
    const listed = yield* providers.list;
    return evaluatePreflight({
      settings,
      readiness: new Map(listed.map((provider) => [provider.instanceId, provider.readiness])),
      onBattery: readings.onBattery,
      freeMemoryBytes: readings.freeMemoryBytes,
      freeDiskBytes: readings.freeDiskBytes,
      mergeQueueVerification: yield* mergeQueue.verificationCommand(projectId),
      platform: readings.platform,
      inhibitAvailable: readings.inhibitAvailable,
      restartPending: readings.restartPending,
      activeHours: readings.activeHours,
      window,
    });
  });

  const preflight: HoustonNightShiftRunner["Service"]["preflight"] = Effect.fn(
    "HoustonNightShiftRunner.preflight",
  )(function* (projectId, durationMinutes, operation) {
    const project = yield* projectOf(operation, projectId);
    const stored = yield* settingsOf(operation, projectId);
    const nowMs = yield* Clock.currentTimeMillis;
    const { times, timeZone } = yield* timesFor({
      trigger: durationMinutes === undefined ? "preview" : "manual",
      startMs: nowMs,
      durationMinutes,
      wrapUp: stored.settings.window.wrapUp,
      hardStop: stored.settings.window.hardStop,
    });
    if (!times.ok) return yield* refuse("invalid", operation, times.message);
    const items = yield* readingsFor(projectId, project.workspaceRoot, stored.settings, {
      startMs: nowMs,
      hardStopMs: times.hardStopAtMs,
      timeZone,
    });
    return {
      items,
      startAt: iso(nowMs),
      wrapUpAt: iso(times.wrapUpAtMs),
      hardStopAt: iso(times.hardStopAtMs),
    };
  });

  const notify = (run: StoredRun, kind: string, key: string, text: string) =>
    run.orchestratorThreadId === null
      ? Effect.void
      : threads
          .notify({
            threadId: run.orchestratorThreadId,
            messageId: messageId(run.id, kind, key),
            text,
          })
          .pipe(
            Effect.catch((error) =>
              Effect.logWarning("Night shift could not message its orchestrator", {
                runId: run.id,
                kind,
                error,
              }),
            ),
          );

  /** Earlier entries after one read of each fateless pull request; merged and closed are stored. */
  const fates = Effect.fn("HoustonNightShiftRunner.fates")(function* (
    run: StoredRun,
    root: string,
  ) {
    const earlier = yield* store.projectEntries(run.projectId, run.id);
    const read: LedgerEntry[] = [];
    for (const entry of earlier) {
      if (
        entry.kind !== "pr" ||
        entry.pr_number === null ||
        entry.status === "merged" ||
        entry.status === "closed"
      ) {
        read.push(entry);
        continue;
      }
      const state = yield* pullRequests
        .state(run.projectId, root, entry.pr_number)
        .pipe(Effect.option);
      if (Option.isSome(state) && state.value !== "open") {
        yield* store.setEntryStatus(entry.id, state.value);
      }
      read.push({ ...entry, status: Option.isSome(state) ? state.value : null });
    }
    return read;
  });

  /** The run's backlog picks, with the `pick` entries to record once the run is running. */
  const pick = Effect.fn("HoustonNightShiftRunner.pick")(function* (run: StoredRun) {
    const picks: BriefPick[] = [];
    const entries: NewEntry[] = [];
    if (!run.settings.backlog.enabled) return { picks, entries };
    const tasks = yield* backlog.tasks(run.projectId);
    const earlierPicks = new Map<number, boolean>();
    for (const entry of yield* store.projectEntries(run.projectId, run.id)) {
      if (entry.kind !== "pick" || entry.task_number === null) continue;
      if (earlierPicks.get(entry.task_number) === false) continue;
      const task = tasks.find((candidate) => candidate.number === entry.task_number);
      earlierPicks.set(
        entry.task_number,
        task === undefined ? false : yield* backlog.doneSince(task.key, entry.created_at),
      );
    }
    const numbers = pickTasks({
      projectId: run.projectId,
      max: run.settings.backlog.max,
      backlog: tasks,
      earlierPicks,
    });
    for (const number of numbers) {
      const task = tasks.find((candidate) => candidate.number === number)!;
      picks.push({ number, title: task.title, text: yield* backlog.text(task.key) });
      entries.push({
        runId: run.id,
        projectId: run.projectId,
        kind: "pick",
        title: `${task.key}: ${task.title}`,
        taskNumber: number,
        detail: { key: task.key },
        createdAt: run.startedAt,
      });
    }
    return { picks, entries };
  });

  /** Starts the orchestrator of an opened run; a failed launch refuses the run. */
  const launch = Effect.fn("HoustonNightShiftRunner.launch")(function* (
    run: StoredRun,
    root: string,
    items: ReadonlyArray<PreflightItem>,
    operation: string,
  ) {
    const folder = runFolder(config.baseDir, run.id);
    const branch = `houston/night/${run.id}`;
    const failed = Effect.fn("HoustonNightShiftRunner.launchFailed")(function* (detail: string) {
      const endedAt = iso(yield* Clock.currentTimeMillis);
      yield* keepAwake.release(run.id);
      yield* store.setKeepAwake(run.id, "released");
      yield* store.refuse(run.id, { stopReason: "launchFailed", detail, endedAt });
      return yield* refuse(
        "invalid",
        operation,
        `the orchestrator could not be launched: ${detail}`,
      );
    });

    const base = yield* git.defaultBranch(root).pipe(Effect.result);
    if (base._tag === "Failure") return yield* failed(base.failure);
    const earlier = yield* fates(run, root);
    const { picks, entries: pickEntries } = yield* pick(run);
    const brief = composeBrief({
      runId: run.id,
      settings: run.settings,
      startAt: run.startedAt,
      wrapUpAt: run.wrapUpAt!,
      hardStopAt: run.hardStopAt!,
      branch,
      picks,
      digest: ledgerDigest(earlier.map(digestEntry)),
    });
    const written = yield* fs
      .makeDirectory(folder, { recursive: true })
      .pipe(
        Effect.andThen(fs.writeFileString(path.join(folder, "brief.md"), brief.text)),
        Effect.result,
      );
    if (written._tag === "Failure") {
      return yield* failed(`writing the brief into ${folder} failed: ${written.failure.message}`);
    }
    // The audit at settle compares against these; a failed read leaves it unable to run.
    const heads = yield* git.lsRemoteHeads(root).pipe(Effect.option);
    const held = yield* keepAwake.take(run.id);
    yield* store.setKeepAwake(run.id, held);
    if (held !== "held") {
      yield* store.setPreflight(run.id, [
        ...items.filter((item) => item.id !== "inhibit_unavailable"),
        {
          id: "inhibit_unavailable",
          status: "warn",
          label: "Keep awake",
          detail: `${held.replace(/^unavailable: /, "")}; the machine may sleep during the run`,
        },
      ]);
    }
    const launched = yield* threads
      .launch({
        commandId: CommandId.make(`night-shift:${run.id}:launch`),
        projectId: run.projectId,
        title: `Night shift · ${run.startedAt.slice(0, 10)}`,
        modelSelection: run.settings.orchestrator,
        runtimeMode: "full-access",
        interactionMode: "default",
        workspaceStrategy: { type: "worktree", baseRef: base.success.sha, branch },
        initialMessage: {
          messageId: MessageId.make(`message:night-shift:${run.id}:brief`),
          text: brief.text,
          attachments: [],
        },
        createdBy: "system",
        creationSource: "server",
      })
      .pipe(Effect.result);
    if (launched._tag === "Failure") return yield* failed(launched.failure);
    const threadId = launched.success.threadId;
    yield* store.markRunning(run.id, {
      threadId,
      worktreePath: launched.success.worktreePath,
      branch: launched.success.branch ?? branch,
      remoteHeads: Option.isSome(heads) ? heads.value : null,
    });
    yield* store.addCrew({
      runId: run.id,
      threadId,
      taskId: null,
      parentThreadId: null,
      role: "orchestrator",
      providerInstanceId: run.settings.orchestrator.instanceId,
      requestedInstanceId: null,
      worktreePath: launched.success.worktreePath,
      branch: launched.success.branch ?? branch,
      startedAt: run.startedAt,
      endedAt: null,
    });
    // Recorded only now: a refused start's picks would keep its tasks from every later run.
    for (const entry of pickEntries) yield* store.addEntry(entry);
    return { runId: run.id, threadId };
  });

  /** A start that ended without settling its run: refuses it if still in preflight. */
  const abandon = Effect.fn("HoustonNightShiftRunner.abandon")(
    function* (runId: number, cause: Cause.Cause<unknown>) {
      const current = yield* store.getRun(runId);
      if (current?.phase !== "preflight") return;
      const detail = Cause.hasInterruptsOnly(cause)
        ? "the start was interrupted before the orchestrator was running"
        : `the start died: ${Cause.pretty(cause)}`;
      yield* keepAwake.release(runId);
      yield* store.setKeepAwake(runId, "released");
      yield* store.refuse(runId, {
        stopReason: "launchFailed",
        detail,
        endedAt: iso(yield* Clock.currentTimeMillis),
      });
    },
    (effect, runId) =>
      effect.pipe(
        Effect.catchCause((failure) =>
          Effect.logWarning("Night shift could not refuse an abandoned start", { runId, failure }),
        ),
      ),
  );

  const openRun = (
    input: StartInput,
    settings: StoredRun["settings"],
    nowMs: number,
    times: { readonly wrapUpAtMs: number; readonly hardStopAtMs: number },
  ) =>
    startLock.withPermits(1)(
      Effect.gen(function* () {
        const live = yield* store.liveRuns;
        const own = live.find((candidate) => candidate.projectId === input.projectId);
        if (own !== undefined) {
          return yield* refuse(
            "busy",
            input.operation,
            `${liveRunText(own)}; one Night shift run per project is live at a time`,
            { limit: 1, actual: 1 },
          );
        }
        if (live.length >= LIMITS.liveRunsPerServer) {
          return yield* refuse(
            "busy",
            input.operation,
            `${live.map(liveRunText).join("; ")}; at most ${LIMITS.liveRunsPerServer} Night shift runs are live at a time`,
            { limit: LIMITS.liveRunsPerServer, actual: live.length },
          );
        }
        return yield* store.openRun({
          projectId: input.projectId,
          trigger: input.trigger,
          scheduledTaskId: input.scheduledTaskId,
          settings,
          startedAt: iso(nowMs),
          wrapUpAt: iso(times.wrapUpAtMs),
          hardStopAt: iso(times.hardStopAtMs),
          operation: input.operation,
        });
      }),
    );

  const prepareAndLaunch = Effect.fn("HoustonNightShiftRunner.prepareAndLaunch")(function* (
    run: StoredRun,
    root: string,
    input: StartInput,
    nowMs: number,
    times: { readonly hardStopAtMs: number },
    timeZone: string,
  ) {
    const items = yield* readingsFor(input.projectId, root, run.settings, {
      startMs: nowMs,
      hardStopMs: times.hardStopAtMs,
      timeZone,
    });
    yield* store.setPreflight(run.id, items);
    const blocking = blockingItems(items);
    if (blocking.length > 0) {
      const first = blocking[0]!;
      const message = `${blocking.length} preflight ${blocking.length === 1 ? "item blocks" : "items block"} the start; first: ${first.label}: ${first.detail}`;
      yield* store.refuse(run.id, {
        stopReason: null,
        detail: message,
        endedAt: iso(yield* Clock.currentTimeMillis),
      });
      return yield* refuse("blocked", input.operation, message, { items });
    }
    return yield* launch(run, root, items, input.operation);
  });

  const start: HoustonNightShiftRunner["Service"]["start"] = Effect.fn(
    "HoustonNightShiftRunner.start",
  )(function* (input) {
    const project = yield* projectOf(input.operation, input.projectId);
    const stored = yield* settingsOf(input.operation, input.projectId);
    const nowMs = yield* Clock.currentTimeMillis;
    const startMs = input.windowStartMs ?? nowMs;
    const { times, timeZone } = yield* timesFor({
      trigger: input.trigger,
      startMs,
      durationMinutes: input.durationMinutes,
      wrapUp: stored.settings.window.wrapUp,
      hardStop: stored.settings.window.hardStop,
    });
    if (!times.ok) return yield* refuse("invalid", input.operation, times.message);

    // From the run's row on, every exit settles it: a defect or an interruption (a client that
    // went away) refuses a run still in preflight and releases keep-awake.
    return yield* Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const run = yield* openRun(input, stored.settings, nowMs, times);
        return yield* restore(
          prepareAndLaunch(run, project.workspaceRoot, input, nowMs, times, timeZone),
        ).pipe(
          Effect.onExit((exit) =>
            Exit.isSuccess(exit) ? Effect.void : abandon(run.id, exit.cause),
          ),
        );
      }),
    );
  });

  /** Runs one settle step, logging a failure without stopping the sequence. */
  const step = <E>(name: string, runId: number, effect: Effect.Effect<unknown, E>) =>
    Effect.sync(() => observe(name, runId)).pipe(
      Effect.andThen(effect),
      Effect.catchCause((cause) =>
        Effect.logWarning("A Night shift settle step failed", { runId, step: name, cause }),
      ),
      Effect.asVoid,
    );

  const stopCrew = Effect.fn("HoustonNightShiftRunner.stopCrew")(function* (run: StoredRun) {
    const crew = yield* store.crew(run.id);
    const members = crew.filter(
      (member) => member.role !== "orchestrator" && member.endedAt === null,
    );
    for (const member of members) {
      yield* threads
        .cancelCrew(
          member.threadId,
          CommandId.make(`night-shift:${run.id}:cancel:${member.threadId}`),
        )
        .pipe(
          Effect.tap(() => Effect.sync(() => observe(`cancel:${member.threadId}`, run.id))),
          Effect.catch((error) =>
            Effect.logWarning("Night shift could not cancel a crew task", {
              runId: run.id,
              threadId: member.threadId,
              error,
            }),
          ),
        );
    }
    for (let waited = 0; waited < LIMITS.crewStopSeconds; waited += 1) {
      const states = yield* Effect.forEach(members, (member) => threads.state(member.threadId));
      if (states.every((state) => !state.activeRun)) break;
      yield* Effect.sleep("1 second");
    }
    const endedAt = iso(yield* Clock.currentTimeMillis);
    for (const member of members) yield* store.endCrew(run.id, member.threadId, endedAt);
    if (run.orchestratorThreadId !== null) {
      yield* threads
        .stop(run.orchestratorThreadId, CommandId.make(`night-shift:${run.id}:stop`))
        .pipe(
          Effect.tap(() => Effect.sync(() => observe(`stop:${run.orchestratorThreadId}`, run.id))),
          Effect.catch((error) =>
            Effect.logWarning("Night shift could not stop its orchestrator", {
              runId: run.id,
              error,
            }),
          ),
        );
      yield* store.endCrew(run.id, run.orchestratorThreadId, endedAt);
    }
  });

  const remoteChanges = Effect.fn("HoustonNightShiftRunner.remoteChanges")(function* (
    run: StoredRun,
  ) {
    const project = yield* projects.get(run.projectId).pipe(Effect.orDie);
    if (Option.isNone(project) || run.remoteHeads === null) {
      return yield* store.setRemoteChanges(
        run.id,
        toJson({
          error: "the remote heads were not recorded at the start; the audit could not run",
        }),
      );
    }
    const after = yield* git.lsRemoteHeads(project.value.workspaceRoot).pipe(Effect.result);
    if (after._tag === "Failure") {
      return yield* store.setRemoteChanges(run.id, toJson({ error: after.failure }));
    }
    const before = run.remoteHeads;
    const refs = [...new Set([...Object.keys(before), ...Object.keys(after.success)])].toSorted();
    const changes = refs
      .filter((ref) => before[ref] !== after.success[ref])
      .map((ref) => ({ ref, oldSha: before[ref] ?? null, newSha: after.success[ref] ?? null }));
    yield* store.setRemoteChanges(run.id, toJson({ changes }));
  });

  const settle = Effect.fn("HoustonNightShiftRunner.settle")(function* (
    runId: number,
    reason: NightStopReason,
    detail: string | null,
  ) {
    const claimed = yield* Ref.modify(settling, (current) =>
      current.has(runId) ? [false, current] : [true, new Set(current).add(runId)],
    );
    if (!claimed) return false;
    return yield* Effect.gen(function* () {
      const run = yield* store.getRun(runId);
      if (run === undefined || (run.phase !== "running" && run.phase !== "wrappingUp"))
        return false;
      yield* step("crew", runId, stopCrew(run));
      yield* step("remoteChanges", runId, remoteChanges(run));
      yield* step(
        "cost",
        runId,
        Effect.gen(function* () {
          const nowMs = yield* Clock.currentTimeMillis;
          const crew = yield* store.crew(runId);
          const cost = threadHours(
            crew.map((member) => ({
              threadId: member.threadId,
              providerInstanceId: member.providerInstanceId,
              startedAtMs: Date.parse(member.startedAt),
              endedAtMs: member.endedAt === null ? null : Date.parse(member.endedAt),
            })),
            nowMs,
          );
          yield* store.setCost(runId, toJson(cost));
        }),
      );
      const endedAt = iso(yield* Clock.currentTimeMillis);
      yield* step(
        "report",
        runId,
        Effect.gen(function* () {
          if ((yield* store.getRun(runId))?.reportPath != null) return;
          const folder = runFolder(config.baseDir, runId);
          const file = path.join(folder, "report.md");
          const entries = yield* store.entries(runId);
          yield* fs.makeDirectory(folder, { recursive: true });
          yield* fs.writeFileString(
            file,
            fallbackReport({
              runId,
              stopReason: reason,
              stopDetail: detail,
              endedAt,
              entries: entries.map((entry) => ({
                kind: entry.kind,
                title: entry.title,
                status: entry.status,
                prNumber: entry.pr_number,
              })),
            }),
          );
          yield* store.setReport(runId, { reportPath: file, summary: null });
        }),
      );
      yield* step(
        "keepAwake",
        runId,
        keepAwake.release(runId).pipe(Effect.andThen(store.setKeepAwake(runId, "released"))),
      );
      yield* step("settled", runId, store.settle(runId, { stopReason: reason, detail, endedAt }));
      yield* Ref.update(idleSince, (current) => {
        const next = new Map(current);
        next.delete(runId);
        return next;
      });
      yield* step("notice", runId, publishNotice(runId));
      return true;
    }).pipe(
      Effect.ensuring(
        Ref.update(settling, (current) => {
          const next = new Set(current);
          next.delete(runId);
          return next;
        }),
      ),
    );
  });

  const publishNotice = Effect.fn("HoustonNightShiftRunner.publishNotice")(function* (
    runId: number,
  ) {
    const run = yield* store.getRun(runId);
    if (run === undefined || !(yield* store.claimNotice(runId))) return;
    const entries = yield* store.entries(runId);
    yield* PubSub.publish(store.notices, {
      projectId: run.projectId,
      runId,
      headline: headline(
        entries.filter((entry) => entry.kind === "pr").length,
        entries.filter((entry) => entry.kind === "decision" && entry.choice === null).length,
      ),
    });
    yield* PubSub.publish(store.changes, run.projectId);
  });

  const sendWrapUp = Effect.fn("HoustonNightShiftRunner.sendWrapUp")(function* (
    run: StoredRun,
    wrapUpAt: string,
  ) {
    if (!(yield* store.markWrappingUp(run.id, wrapUpAt))) return false;
    yield* notify(run, "wrap-up", "", wrapUpText(run.hardStopAt ?? ""));
    return true;
  });

  const wrapUp: HoustonNightShiftRunner["Service"]["wrapUp"] = Effect.fn(
    "HoustonNightShiftRunner.wrapUp",
  )(function* (runId) {
    const run = yield* store.getRun(runId);
    if (run === undefined)
      return yield* refuse("not_found", "wrapUp", `run ${runId} does not exist`);
    if (run.phase !== "running") {
      return yield* refuse(
        "invalid",
        "wrapUp",
        run.phase === "wrappingUp"
          ? `run ${runId} is already wrapping up since ${run.wrapUpAt}`
          : `run ${runId} is ${run.phase}; only a running run wraps up`,
      );
    }
    const wrapUpAt = iso(yield* Clock.currentTimeMillis);
    if (!(yield* sendWrapUp(run, wrapUpAt))) {
      return yield* refuse("invalid", "wrapUp", `run ${runId} is no longer running`);
    }
    return { wrapUpAt };
  });

  const stop: HoustonNightShiftRunner["Service"]["stop"] = Effect.fn(
    "HoustonNightShiftRunner.stop",
  )(function* (runId) {
    const run = yield* store.getRun(runId);
    if (run === undefined) return yield* refuse("not_found", "stop", `run ${runId} does not exist`);
    if (run.phase !== "running" && run.phase !== "wrappingUp") {
      return yield* refuse(
        "invalid",
        "stop",
        `run ${runId} is ${run.phase}${run.endedAt === null ? "" : ` since ${run.endedAt}`}; only a live run stops`,
      );
    }
    yield* settle(runId, "stopped", null);
    const after = yield* store.getRun(runId);
    if (after?.endedAt == null || after.stopReason === null) {
      return yield* refuse("invalid", "stop", `run ${runId} is still settling`);
    }
    return { endedAt: after.endedAt, stopReason: after.stopReason };
  });

  const limitOf = Effect.fn("HoustonNightShiftRunner.limitOf")(function* (instanceId: string) {
    const listed = yield* providers.list;
    const readiness = listed.find((provider) => provider.instanceId === instanceId)?.readiness;
    if (readiness === undefined || !LIMITED_STATES.has(readiness.state)) return null;
    const reset =
      readiness.state === "outOfUsage" && readiness.resetsAt !== null
        ? `, resets at ${readiness.resetsAt}`
        : "";
    return `${instanceId} is ${readiness.state}${reset}: ${"message" in readiness ? readiness.message : ""}`;
  });

  /** Limits a crew instance that became unusable, with one message; clears it after its reset. */
  const limits = Effect.fn("HoustonNightShiftRunner.limits")(function* (
    run: StoredRun,
    nowMs: number,
  ) {
    const listed = yield* providers.list;
    const crew = yield* store.crew(run.id);
    const chain = run.settings.workers.map((worker) => worker.instanceId as string);
    const instances = [
      ...new Set([...chain, ...crew.map((member) => member.providerInstanceId)]),
    ].filter((id) => id !== run.settings.orchestrator.instanceId);
    const at = iso(nowMs);
    const limited: NightLimit[] = [...run.limited];
    let changed = false;
    for (const instanceId of instances) {
      const readiness = listed.find((provider) => provider.instanceId === instanceId)?.readiness;
      const active = limited.find(
        (limit) => limit.instanceId === instanceId && limit.clearedAt === null,
      );
      if (readiness !== undefined && LIMITED_STATES.has(readiness.state)) {
        if (active !== undefined) continue;
        const resetsAt = readiness.state === "outOfUsage" ? (readiness.resetsAt ?? null) : null;
        limited.push({ instanceId, state: readiness.state, resetsAt, at, clearedAt: null });
        changed = true;
        const states = new Map<string, InstanceState>(
          listed.map((provider) => [
            provider.instanceId,
            {
              instanceId: provider.instanceId,
              state: provider.readiness?.state ?? "unknown",
              limited: limited.some(
                (limit) => limit.instanceId === provider.instanceId && limit.clearedAt === null,
              ),
            },
          ]),
        );
        const next = substituteInstance({ requested: instanceId, chain, states });
        const reset = resetsAt === null ? "" : `, resets at ${resetsAt}`;
        yield* notify(
          run,
          "limit",
          instanceId,
          `Night shift: ${instanceId} is ${readiness.state}${reset}. ${
            "instanceId" in next
              ? `Delegations to it run on ${next.instanceId} until it is ready again.`
              : "No other worker instance is ready, so delegations are refused until one is."
          }`,
        );
      } else if (
        active !== undefined &&
        readiness?.state === "ready" &&
        (active.resetsAt === null || nowMs >= Date.parse(active.resetsAt))
      ) {
        limited[limited.indexOf(active)] = { ...active, clearedAt: at };
        changed = true;
      }
    }
    if (changed) yield* store.setLimited(run.id, limited);
  });

  const evaluate = Effect.fn("HoustonNightShiftRunner.evaluate")(function* (run: StoredRun) {
    if (run.phase !== "running" && run.phase !== "wrappingUp") return;
    const nowMs = yield* Clock.currentTimeMillis;
    if (run.hardStopAt !== null && nowMs >= Date.parse(run.hardStopAt)) {
      return yield* settle(run.id, "hardStop", null);
    }
    if (run.orchestratorThreadId === null) return;
    const state = yield* threads.state(run.orchestratorThreadId);
    if (!state.present) {
      return yield* settle(run.id, "orchestratorEnded", "the orchestrator's thread was deleted");
    }
    const limited = yield* limitOf(run.settings.orchestrator.instanceId);
    if (limited !== null) return yield* settle(run.id, "orchestratorLimited", limited);
    const reported = run.reportPath !== null;
    if (reported && !state.activeRun) return yield* settle(run.id, "report", null);
    if (!reported && !state.activeRun && state.lastRunStatus === "failed") {
      return yield* settle(run.id, "orchestratorEnded", "its run ended failed");
    }
    if (run.phase === "running" && run.wrapUpAt !== null && nowMs >= Date.parse(run.wrapUpAt)) {
      yield* sendWrapUp(run, run.wrapUpAt);
    }
    yield* gate.refresh(run.id);
    yield* limits(run, nowMs);

    const liveCrew = (yield* store.crew(run.id)).filter(
      (member) => member.role !== "orchestrator" && member.endedAt === null,
    );
    const idle = !state.activeRun && liveCrew.length === 0 && !reported;
    const since = idle
      ? yield* Ref.modify(idleSince, (current) => {
          const known = current.get(run.id);
          return known !== undefined
            ? [known, current]
            : [nowMs, new Map(current).set(run.id, nowMs)];
        })
      : yield* Ref.update(idleSince, (current) => {
          const next = new Map(current);
          next.delete(run.id);
          return next;
        }).pipe(Effect.as(null));
    const decision = idleDecision({
      idleSinceMs: since,
      nudgedAtMs: run.nudgedAt === null ? null : Date.parse(run.nudgedAt),
      nowMs,
    });
    if (decision === "nudge") {
      yield* store.setNudged(run.id, iso(nowMs));
      yield* notify(run, "idle", "", idleText);
    } else if (decision === "settle") {
      yield* settle(run.id, "idle", `idle since ${iso(since!)} after the nudge at ${run.nudgedAt}`);
    }
  });

  const evaluateLogged = (run: StoredRun) =>
    evaluate(run).pipe(
      Effect.asVoid,
      Effect.catchCause((cause) =>
        Effect.logWarning("Night shift could not evaluate a run", { runId: run.id, cause }),
      ),
    );

  const tick: HoustonNightShiftRunner["Service"]["tick"] = Effect.gen(function* () {
    for (const run of yield* store.liveRuns) yield* evaluateLogged(run);
  });

  // An orchestrator that is already idle settles at once instead of at the next tick.
  const reportPublished: HoustonNightShiftRunner["Service"]["reportPublished"] = (runId, input) =>
    store.setReport(runId, input).pipe(
      Effect.andThen(store.getRun(runId)),
      Effect.flatMap((run) => (run === undefined ? Effect.void : evaluateLogged(run))),
    );

  const recover: HoustonNightShiftRunner["Service"]["recover"] = Effect.gen(function* () {
    const nowMs = yield* Clock.currentTimeMillis;
    const at = iso(nowMs);
    for (const run of yield* store.liveRuns) {
      if (run.phase === "preflight") {
        yield* store.refuse(run.id, {
          stopReason: null,
          detail: "the server stopped during preflight",
          endedAt: at,
        });
        continue;
      }
      if (run.hardStopAt !== null && nowMs >= Date.parse(run.hardStopAt)) {
        yield* settle(
          run.id,
          "serverRestart",
          `the hard stop ${run.hardStopAt} passed while the server was stopped`,
        );
        continue;
      }
      const present =
        run.orchestratorThreadId !== null &&
        (yield* threads.state(run.orchestratorThreadId)).present;
      if (!present) {
        yield* settle(run.id, "serverRestart", "the orchestrator's thread is gone");
        continue;
      }
      yield* store.setKeepAwake(run.id, yield* keepAwake.take(run.id));
      if (!run.interruptions.some((interruption) => interruption.at === at)) {
        yield* store.addInterruption(run.id, { at, detail: "the server restarted" });
      }
      yield* notify(run, "restart", at, restartText(at));
    }
    for (const projectId of yield* store.projects) {
      for (const run of yield* store.listRuns(projectId, LIMITS.runsPerSnapshot)) {
        if (run.phase === "settled" && !run.noticeSent) yield* publishNotice(run.id);
      }
    }
  });

  return HoustonNightShiftRunner.of({
    preflight,
    start,
    wrapUp,
    stop,
    reportPublished,
    tick,
    recover,
  });
});

/** The runner; its layer recovers live runs, then evaluates them every 15 seconds. */
export const layer = Layer.effect(
  HoustonNightShiftRunner,
  Effect.gen(function* () {
    const runner = yield* make;
    yield* runner.recover.pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Night shift could not recover its runs", { cause }),
      ),
    );
    yield* runner.tick.pipe(Effect.andThen(Effect.sleep(TICK)), Effect.forever, Effect.forkScoped);
    return runner;
  }),
);

/** The runner without its recovery and tick, for tests that drive them. */
export const layerManual = Layer.effect(HoustonNightShiftRunner, make);
