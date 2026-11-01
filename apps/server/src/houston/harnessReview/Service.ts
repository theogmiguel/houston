// houston.harness.*: the project's review schedule, its reviews and findings, decisions, the
// report, the overview and the seen cursor.
import type { ProjectId, ScheduledTask, ScheduledTaskId } from "@t3tools/contracts";
import {
  HOUSTON_HARNESS_LIMITS,
  HoustonHarnessError,
  type HoustonDefectDecideInput,
  type HoustonDefectDraftInput,
  type HoustonDefectFileInput,
  type HoustonDefectFileResult,
  type HoustonDefectIssueDraft,
  type HoustonHarnessCreateTaskInput,
  type HoustonHarnessCreateTaskResult,
  type HoustonHarnessDecideInput,
  type HoustonHarnessEmptyResult,
  type HoustonHarnessFinding,
  type HoustonHarnessImportResult,
  type HoustonHarnessImportStatus,
  type HoustonHarnessMarkSeenInput,
  type HoustonHarnessMarkSeenResult,
  type HoustonHarnessOverview,
  type HoustonHarnessOverviewEvent,
  type HoustonHarnessOverviewInput,
  type HoustonHarnessOverviewRow,
  type HoustonHarnessProjectInput,
  type HoustonHarnessReportInput,
  type HoustonHarnessReportResult,
  type HoustonHarnessRunNowResult,
  type HoustonHarnessSchedule,
  type HoustonHarnessSetupInput,
  type HoustonHarnessSnapshot,
  type HoustonHarnessVerdict,
} from "@t3tools/contracts/houston/harnessReview";
import { HOUSTON_TASK_LIMITS, type HoustonTaskError } from "@t3tools/contracts/houston/tasks";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";

import * as ProjectStore from "../../orchestration-v2/ProjectStore.ts";
import * as ScheduledTaskService from "../../scheduledTasks/ScheduledTaskService.ts";
import * as HoustonTaskService from "../tasks/TaskService.ts";
import * as HoustonTaskStore from "../tasks/TaskStore.ts";
import {
  type FixTaskLink,
  HARNESS_ACTOR,
  HoustonHarnessFixTasks,
  isLiveFix,
  layer as HoustonHarnessFixTasksLayer,
} from "./FixTasks.ts";
import * as HoustonDefects from "./defects/Defects.ts";
import * as HoustonDefectIssues from "./defects/Issues.ts";
import { HoustonHarnessRunner } from "./Runner.ts";
import { HoustonScheduledTaskRunner } from "./ScheduledTaskRunner.ts";
import {
  findingDecision,
  findingPhase,
  fixTaskText,
  isFindingKey,
  nextSeenReviewId,
  type StoredVerdict,
} from "./rules.ts";
import {
  busyMessage,
  HoustonHarnessStore,
  type StoredReview,
  type VerificationRow,
} from "./Store.ts";
import * as HoustonHarnessV1Import from "./V1Import.ts";

export const SET_UP_FIRST = "set up the harness review first";
const TASK_PROMPT =
  "Houston harness review of this project. Houston writes each run's instructions; edit the schedule, model or pause here.";

const SCHEDULES: Record<
  HoustonHarnessSchedule,
  { readonly schedule: ScheduledTask["schedule"]; readonly enabled: boolean }
> = {
  weekly: { schedule: { type: "fixed_time", timeOfDay: "09:00", weekdays: [0] }, enabled: true },
  daily: { schedule: { type: "fixed_time", timeOfDay: "09:00" }, enabled: true },
  manual: { schedule: { type: "fixed_time", timeOfDay: "09:00", weekdays: [0] }, enabled: false },
};

const refuse = (
  kind: HoustonHarnessError["kind"],
  operation: string,
  message: string,
): Effect.Effect<never, HoustonHarnessError> =>
  Effect.fail(new HoustonHarnessError({ kind, operation, message }));

const publicReview = ({ runId: _runId, ...review }: StoredReview) => review;

const VERDICTS: Record<StoredVerdict, HoustonHarnessVerdict> = {
  gone: "gone",
  still_present: "stillPresent",
  inconclusive: "inconclusive",
};

/** A Tasks refusal as the harness reports it: its limit stays a limit, anything else is invalid. */
const fromTaskError = (operation: string, error: HoustonTaskError) =>
  new HoustonHarnessError({
    kind: error.kind === "limit" ? "limit" : error.kind === "not_found" ? "not_found" : "invalid",
    operation,
    message: error.message,
    ...(error.limit === undefined ? {} : { limit: error.limit }),
    ...(error.actual === undefined ? {} : { actual: error.actual }),
  });

const textList = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Array(Schema.String)));

export class HoustonHarnessService extends Context.Service<
  HoustonHarnessService,
  {
    readonly get: (
      input: HoustonHarnessProjectInput,
    ) => Effect.Effect<HoustonHarnessSnapshot, HoustonHarnessError>;
    readonly subscribe: (
      input: HoustonHarnessProjectInput,
    ) => Stream.Stream<HoustonHarnessSnapshot, HoustonHarnessError>;
    readonly overview: (
      input: HoustonHarnessOverviewInput,
    ) => Effect.Effect<HoustonHarnessOverview>;
    readonly subscribeOverview: (
      input: HoustonHarnessOverviewInput,
    ) => Stream.Stream<HoustonHarnessOverviewEvent>;
    readonly setup: (
      input: HoustonHarnessSetupInput,
    ) => Effect.Effect<HoustonHarnessSnapshot, HoustonHarnessError>;
    readonly runNow: (
      input: HoustonHarnessProjectInput,
    ) => Effect.Effect<HoustonHarnessRunNowResult, HoustonHarnessError>;
    readonly report: (
      input: HoustonHarnessReportInput,
    ) => Effect.Effect<HoustonHarnessReportResult, HoustonHarnessError>;
    readonly decide: (
      input: HoustonHarnessDecideInput,
    ) => Effect.Effect<HoustonHarnessEmptyResult, HoustonHarnessError>;
    readonly markSeen: (
      input: HoustonHarnessMarkSeenInput,
    ) => Effect.Effect<HoustonHarnessMarkSeenResult, HoustonHarnessError>;
    readonly createTask: (
      input: HoustonHarnessCreateTaskInput,
    ) => Effect.Effect<HoustonHarnessCreateTaskResult, HoustonHarnessError>;
    readonly defectsDecide: (
      input: HoustonDefectDecideInput,
    ) => Effect.Effect<HoustonHarnessEmptyResult, HoustonHarnessError>;
    readonly defectsDraft: (
      input: HoustonDefectDraftInput,
    ) => Effect.Effect<HoustonDefectIssueDraft, HoustonHarnessError>;
    readonly defectsFile: (
      input: HoustonDefectFileInput,
    ) => Effect.Effect<HoustonDefectFileResult, HoustonHarnessError>;
    readonly importV1Status: Effect.Effect<HoustonHarnessImportStatus>;
    readonly importV1Run: Effect.Effect<HoustonHarnessImportResult, HoustonHarnessError>;
  }
>()("houston/houston/harnessReview/Service/HoustonHarnessService") {}

const make = Effect.gen(function* () {
  const store = yield* HoustonHarnessStore;
  const runner = yield* HoustonHarnessRunner;
  const scheduled = yield* ScheduledTaskService.ScheduledTaskService;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const claim = yield* Effect.serviceOption(HoustonScheduledTaskRunner);
  const fixTasks = yield* HoustonHarnessFixTasks;
  const tasks = yield* HoustonTaskService.HoustonTaskService;
  const taskStore = yield* HoustonTaskStore.HoustonTaskStore;
  const sql = yield* SqlClient.SqlClient;
  const defects = yield* HoustonDefects.HoustonDefects;
  const issues = yield* HoustonDefectIssues.HoustonDefectIssues;
  const v1Import = yield* HoustonHarnessV1Import.HoustonHarnessV1Import;

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

  /** Every finding of the project, one per key from the newest review that raised it. */
  const findingsOf = Effect.fn("HoustonHarnessService.findingsOf")(function* (
    projectId: ProjectId,
  ) {
    const rows = yield* store.findingRows(projectId);
    const decisions = new Map((yield* store.decisions(projectId)).map((row) => [row.key, row]));
    const latest = yield* store.latestPublishedReviewId(projectId);
    // Newest first, so the first per key is the finding's current task and verdict.
    const links = new Map<string, FixTaskLink>();
    for (const link of yield* fixTasks.linkStates(projectId)) {
      if (!links.has(link.key)) links.set(link.key, link);
    }
    const verifications = new Map<string, VerificationRow>();
    for (const row of yield* store.verificationRows(projectId)) {
      if (!verifications.has(row.key)) verifications.set(row.key, row);
    }
    const seen = new Set<string>();
    const findings: HoustonHarnessFinding[] = [];
    for (const row of rows) {
      if (seen.has(row.key)) continue;
      seen.add(row.key);
      const decision = decisions.get(row.key);
      const read = findingDecision(
        decision === undefined ? null : { state: decision.state, decidedAt: decision.decided_at },
        row.review_ended_at,
      );
      const quotes = textList(row.quotes_json);
      const stored = links.get(row.key);
      // The phase reads an archived task that has not landed as canceled; the task shows as stored.
      const link =
        stored?.archived === true && stored.status !== "done"
          ? { ...stored, status: "canceled" as const }
          : stored;
      const verification = verifications.get(row.key);
      const evidence = verification === undefined ? [] : textList(verification.evidence_json);
      const { phase, quotes: shown } = findingPhase({
        state: read.state,
        reviewId: row.review_id,
        latestPublishedReviewId: latest,
        quotes,
        verification:
          verification === undefined
            ? null
            : {
                reviewId: verification.review_id,
                verdict: verification.verdict,
                reviewEndedAt: verification.review_ended_at,
                evidence,
              },
        task: link === undefined ? null : { status: link.status, createdAt: link.linkedAt },
      });
      findings.push({
        key: row.key,
        reviewId: row.review_id,
        title: row.title,
        category: row.category,
        confidence: row.confidence,
        sessions: textList(row.sessions_json),
        count: row.count,
        quotes: shown,
        recommendationKind: row.recommendation_kind,
        target: row.target,
        recommendation: row.recommendation,
        applyPrompt: row.apply_prompt,
        state: read.state,
        decidedAt: read.decidedAt,
        recurred: read.recurred,
        phase,
        lastSeenReviewId: Math.max(latest, row.review_id),
        task:
          stored === undefined
            ? null
            : {
                taskId: stored.taskId,
                key: stored.taskKey,
                status: stored.status,
                landedAt: stored.landedAt,
              },
        verification:
          verification === undefined
            ? null
            : {
                reviewId: verification.review_id,
                taskId: verification.task_id,
                verdict: VERDICTS[verification.verdict],
                sessionsAfter: verification.sessions_after,
                evidence,
              },
      });
    }
    return findings;
  });

  const snapshot = Effect.fn("HoustonHarnessService.snapshot")(function* (projectId: ProjectId) {
    const settings = yield* store.settings(projectId);
    const task = yield* findTask(settings?.scheduledTaskId);
    const reviews = yield* store.listReviews(projectId, HOUSTON_HARNESS_LIMITS.reviewsPerSnapshot);
    const running = reviews.find(
      (review) => review.status === "preparing" || review.status === "running",
    );
    return {
      projectId,
      schedule:
        task === undefined
          ? null
          : {
              scheduledTaskId: task.id,
              title: task.title,
              enabled: task.enabled,
              schedule: task.schedule,
              modelSelection: task.modelSelection,
              nextRunAt: task.nextRunAt,
              lastRunStatus: task.lastRunStatus,
              lastRunError: task.lastRunError,
            },
      reviews: reviews.map(publicReview),
      runningReviewId: running?.id ?? null,
      findings: yield* findingsOf(projectId),
      defects: yield* defects.list(projectId),
      seenReviewId: settings?.seenReviewId ?? 0,
    } satisfies HoustonHarnessSnapshot;
  });

  const get: HoustonHarnessService["Service"]["get"] = Effect.fn("HoustonHarnessService.get")(
    function* (input) {
      yield* projectOf("get", input.projectId);
      return yield* snapshot(input.projectId);
    },
  );

  const subscribe: HoustonHarnessService["Service"]["subscribe"] = (input) =>
    Stream.unwrap(
      Effect.gen(function* () {
        yield* projectOf("subscribe", input.projectId);
        // Subscribe before reading to buffer concurrent changes.
        const subscription = yield* PubSub.subscribe(store.changes);
        return Stream.concat(
          Stream.fromEffect(snapshot(input.projectId)),
          Stream.fromSubscription(subscription).pipe(
            Stream.filter((projectId) => projectId === input.projectId),
            Stream.mapEffect(() => snapshot(input.projectId)),
          ),
        );
      }),
    );

  const overview: HoustonHarnessService["Service"]["overview"] = Effect.fn(
    "HoustonHarnessService.overview",
  )(function* () {
    const rows: HoustonHarnessOverviewRow[] = [];
    const suggested: Array<{ projectId: ProjectId; finding: HoustonHarnessFinding }> = [];
    for (const projectId of yield* store.projects) {
      const findings = yield* findingsOf(projectId);
      const latest = yield* store.latestPublishedReviewId(projectId);
      const projectDefects = yield* defects.list(projectId);
      const undecided = projectDefects.filter((defect) => defect.state === "open").length;
      const settings = yield* store.settings(projectId);
      const seenReviewId = settings?.seenReviewId ?? 0;
      const count = (phase: HoustonHarnessFinding["phase"]) =>
        findings.filter((finding) => finding.phase === phase).length;
      const attention =
        findings.filter(
          (finding) =>
            (finding.phase === "open" ||
              finding.phase === "notSeen" ||
              finding.phase === "awaitingVerification") &&
            finding.lastSeenReviewId > seenReviewId,
        ).length + undecided;
      if (findings.length === 0 && latest === 0 && projectDefects.length === 0) continue;
      rows.push({
        projectId,
        open: count("open"),
        fixing: count("fixing"),
        awaitingVerification: count("awaitingVerification"),
        notSeen: count("notSeen"),
        resolved: count("resolved"),
        dismissed: count("dismissed"),
        suspectedDefects: undecided,
        latestPublishedReviewId: latest === 0 ? null : latest,
        seenReviewId,
        attention,
      });
      for (const finding of findings) {
        if (finding.phase === "open" && finding.task === null) {
          suggested.push({ projectId, finding });
        }
      }
    }
    return {
      rows,
      suggested: suggested
        .map((entry, index) => ({ entry, index }))
        .toSorted(
          (left, right) =>
            right.entry.finding.reviewId - left.entry.finding.reviewId || left.index - right.index,
        )
        .slice(0, HOUSTON_HARNESS_LIMITS.suggested)
        .map(({ entry }) => entry),
    } satisfies HoustonHarnessOverview;
  });

  const subscribeOverview: HoustonHarnessService["Service"]["subscribeOverview"] = (input) =>
    Stream.unwrap(
      Effect.gen(function* () {
        const subscription = yield* PubSub.subscribe(store.changes);
        const notices = yield* PubSub.subscribe(store.notices);
        const overviews = Stream.concat(
          Stream.fromEffect(overview(input)),
          Stream.fromSubscription(subscription).pipe(Stream.mapEffect(() => overview(input))),
        ).pipe(
          Stream.map((value): HoustonHarnessOverviewEvent => ({
            type: "overview",
            overview: value,
          })),
        );
        return Stream.merge(
          overviews,
          Stream.fromSubscription(notices).pipe(
            Stream.map((notice): HoustonHarnessOverviewEvent => ({
              type: "defectNotice",
              ...notice,
            })),
          ),
        );
      }),
    );

  const setup: HoustonHarnessService["Service"]["setup"] = Effect.fn("HoustonHarnessService.setup")(
    function* (input) {
      const project = yield* projectOf("setup", input.projectId);
      yield* runner.ensureReadOnly("setup", input.modelSelection);
      const settings = yield* store.settings(input.projectId);
      const existing = yield* findTask(settings?.scheduledTaskId);
      if (existing !== undefined) {
        return yield* refuse(
          "conflict",
          "setup",
          `this project's review is already set up as scheduled task ${existing.id}; change it in Scheduled tasks`,
        );
      }
      const choice = SCHEDULES[input.schedule];
      const created = yield* scheduled
        .upsert({
          title: `Harness review · ${project.title}`,
          prompt: TASK_PROMPT,
          enabled: choice.enabled,
          schedule: choice.schedule as never,
          projectId: input.projectId,
          workspaceStrategy: { type: "root" },
          modelSelection: input.modelSelection,
          runtimeMode: "approval-required",
          interactionMode: "default",
          createdBy: "user",
          creationSource: "web",
        })
        .pipe(
          Effect.mapError(
            (error) =>
              new HoustonHarnessError({
                kind: "invalid",
                operation: "setup",
                message: `the scheduled task could not be created: ${error.message}`,
              }),
          ),
        );
      yield* store.setScheduledTask(input.projectId, created.task.id);
      return yield* snapshot(input.projectId);
    },
  );

  const runNow: HoustonHarnessService["Service"]["runNow"] = Effect.fn(
    "HoustonHarnessService.runNow",
  )(function* (input) {
    yield* projectOf("runNow", input.projectId);
    const settings = yield* store.settings(input.projectId);
    const task = yield* findTask(settings?.scheduledTaskId);
    if (task === undefined) return yield* refuse("not_found", "runNow", SET_UP_FIRST);
    yield* runner.ensureReadOnly("runNow", task.modelSelection);
    const running = (yield* store.listReviews(input.projectId, 1)).find(
      (review) => review.status === "preparing" || review.status === "running",
    );
    if (running !== undefined) return yield* refuse("busy", "runNow", busyMessage(running));
    const ran = yield* scheduled.runNow({ id: task.id }).pipe(Effect.result);
    const busyNow = Effect.gen(function* () {
      const active = (yield* store.listReviews(input.projectId, 1)).find(
        (review) => review.status === "preparing" || review.status === "running",
      );
      return yield* refuse(
        "busy",
        "runNow",
        active === undefined ? "a review of this project is starting" : busyMessage(active),
      );
    });
    if (ran._tag === "Failure") return yield* busyNow;
    if (ran.success.threadId === null) {
      const refusal = Option.isSome(claim) ? yield* claim.value.lastRefusal(task.id) : undefined;
      if (refusal !== undefined) return yield* refusal;
      const after = yield* findTask(task.id);
      return yield* refuse(
        "invalid",
        "runNow",
        after?.lastRunError ?? "the review could not be started",
      );
    }
    const review = yield* store.reviewByThread(ran.success.threadId);
    if (review === undefined) return yield* busyNow;
    return { reviewId: review.id, threadId: ran.success.threadId };
  });

  const report: HoustonHarnessService["Service"]["report"] = Effect.fn(
    "HoustonHarnessService.report",
  )(function* (input) {
    const review = yield* store.getReview(input.reviewId);
    if (review === undefined) {
      return yield* refuse("not_found", "report", `review ${input.reviewId} does not exist`);
    }
    const project = yield* projectOf("report", review.projectId);
    // An imported review can keep v1's "" or an absolute path outside the project.
    const runDir = review.runDir;
    if (runDir === "" || path.isAbsolute(runDir) || runDir.split(/[\\/]/).includes("..")) {
      return yield* refuse(
        "not_found",
        "report",
        `review ${review.id} has no run directory under its project (run_dir "${runDir}"; expected a relative path inside it)`,
      );
    }
    const file = path.join(project.workspaceRoot, ...review.runDir.split("/"), "report.md");
    const bytes = yield* fs
      .readFile(file)
      .pipe(
        Effect.catchCause(() =>
          refuse("not_found", "report", `review ${review.id} has no report at ${file}`),
        ),
      );
    const limit = HOUSTON_HARNESS_LIMITS.reportBytes;
    const truncated = bytes.byteLength > limit;
    const shown = truncated ? bytes.subarray(0, limit) : bytes;
    return { markdown: new TextDecoder().decode(shown), truncated };
  });

  const decide: HoustonHarnessService["Service"]["decide"] = Effect.fn(
    "HoustonHarnessService.decide",
  )(function* (input) {
    yield* projectOf("decide", input.projectId);
    const findings = yield* store.findingRows(input.projectId);
    if (!findings.some((finding) => finding.key === input.key)) {
      return yield* refuse(
        "not_found",
        "decide",
        `no finding of project ${input.projectId} has the key "${input.key}"`,
      );
    }
    yield* store.decide({
      projectId: input.projectId,
      key: input.key,
      state: input.state,
      by: "user",
    });
    return {};
  });

  const markSeen: HoustonHarnessService["Service"]["markSeen"] = Effect.fn(
    "HoustonHarnessService.markSeen",
  )(function* (input) {
    yield* projectOf("markSeen", input.projectId);
    const current = (yield* store.settings(input.projectId))?.seenReviewId ?? 0;
    const latest = yield* store.latestPublishedReviewId(input.projectId);
    const next = nextSeenReviewId(current, input.reviewId, latest);
    if (next !== current) yield* store.setSeen(input.projectId, next);
    return { seenReviewId: next };
  });

  // One fix task at a time, so two concurrent requests for one finding cannot both pass `busy`.
  const createLock = yield* Semaphore.make(1);

  const createTask: HoustonHarnessService["Service"]["createTask"] = Effect.fn(
    "HoustonHarnessService.createTask",
  )(function* (input) {
    const operation = "createTask";
    yield* projectOf(operation, input.projectId);
    if (!isFindingKey(input.key)) {
      return yield* refuse(
        "invalid",
        operation,
        `the finding key "${input.key}" is not lowercase kebab-case of at most ${HOUSTON_HARNESS_LIMITS.keyChars} characters`,
      );
    }
    return yield* createLock.withPermits(1)(
      Effect.gen(function* () {
        const finding = (yield* store.findingRows(input.projectId)).find(
          (row) => row.key === input.key,
        );
        if (finding === undefined) {
          return yield* refuse(
            "invalid",
            operation,
            `no published review of project ${input.projectId} raised the finding "${input.key}"`,
          );
        }
        const linked = (yield* fixTasks.linkStates(input.projectId)).filter(
          (link) => link.key === input.key,
        );
        const open = linked.find(isLiveFix);
        if (open !== undefined) {
          return yield* refuse(
            "busy",
            operation,
            `finding ${input.key} already has the open fix task ${open.taskKey} (${open.status}); finish or cancel it first`,
          );
        }
        const settings = yield* tasks
          .getSettings({ projectId: input.projectId })
          .pipe(Effect.mapError((error) => fromTaskError(operation, error)));
        if (settings.access === "off") {
          return yield* refuse(
            "access_off",
            operation,
            "Tasks access for this project is off; turn it on in Settings ▸ Tasks to create a fix task",
          );
        }
        if (settings.access === "read") {
          return yield* refuse(
            "read_only",
            operation,
            "Tasks access for this project is read-only; allow writes in Settings ▸ Tasks to create a fix task",
          );
        }
        const linkAndReturn = (taskId: number) =>
          store
            .linkTask({
              projectId: input.projectId,
              key: input.key,
              taskId,
              reviewId: finding.review_id,
            })
            .pipe(
              Effect.andThen(taskStore.summaries({ ids: [taskId] })),
              Effect.map(({ summaries }) => ({ task: summaries[0]! })),
            );
        // A server stopped between an earlier call's save and link left its task unlinked.
        const prefix = `Finding: ${input.key}\nReview: #`;
        const [orphan] = yield* sql<{ id: number }>`
          SELECT t.id FROM houston_tasks t
          WHERE t.project_id = ${input.projectId} AND t.created_by = ${HARNESS_ACTOR}
            AND t.archived_at IS NULL AND t.status NOT IN ('done', 'canceled')
            AND substr(t.description, 1, ${prefix.length}) = ${prefix}
            AND NOT EXISTS (SELECT 1 FROM houston_harness_finding_tasks l WHERE l.task_id = t.id)
          ORDER BY t.id DESC LIMIT 1
        `.pipe(Effect.orDie);
        if (orphan !== undefined) return yield* linkAndReturn(orphan.id);
        const [count] = yield* sql<{ n: number }>`SELECT COUNT(*) AS n FROM houston_tasks`.pipe(
          Effect.orDie,
        );
        const held = count?.n ?? 0;
        if (held >= HOUSTON_TASK_LIMITS.tasks) {
          const limit = HOUSTON_TASK_LIMITS.tasks;
          return yield* new HoustonHarnessError({
            kind: "limit",
            operation,
            message: `the Tasks backlog holds ${held.toLocaleString("en-US")} tasks, archived included, and its limit is ${limit.toLocaleString("en-US")}; remove tasks before creating a fix task`,
            limit,
            actual: held,
          });
        }
        const text = fixTaskText({
          key: input.key,
          reviewId: finding.review_id,
          title: finding.title,
          recommendation: finding.recommendation,
          target: finding.target,
          applyPrompt: input.applyPrompt ?? finding.apply_prompt,
          previousTask: linked[0]?.taskKey ?? null,
        });
        if (!text.ok) {
          return yield* new HoustonHarnessError({
            kind: "invalid",
            operation,
            message: text.message,
            limit: text.limit,
            actual: text.actual,
          });
        }
        // A client that disconnects mid-request interrupts it; the task must not stay unlinked.
        return yield* tasks
          .save(
            {
              projectId: input.projectId,
              patch: {
                title: text.value.title,
                description: text.value.description,
                acceptance: [text.value.acceptance],
                status: "todo",
              },
            },
            HARNESS_ACTOR,
          )
          .pipe(
            Effect.mapError((error) => fromTaskError(operation, error)),
            Effect.flatMap((task) => linkAndReturn(task.id)),
            Effect.uninterruptible,
          );
      }),
    );
  });

  const defectsDecide: HoustonHarnessService["Service"]["defectsDecide"] = (input) =>
    defects.decide(input).pipe(Effect.as({}));

  return HoustonHarnessService.of({
    defectsDecide,
    defectsDraft: issues.draft,
    defectsFile: issues.file,
    importV1Status: v1Import.status,
    importV1Run: v1Import.run,
    get,
    subscribe,
    overview,
    subscribeOverview,
    setup,
    runNow,
    report,
    decide,
    markSeen,
    createTask,
  });
});

export const layer = Layer.effect(HoustonHarnessService, make).pipe(
  Layer.provideMerge(HoustonHarnessFixTasksLayer),
  Layer.provideMerge(Layer.merge(HoustonDefectIssues.layer, HoustonHarnessV1Import.layer)),
  Layer.provideMerge(HoustonDefects.layer),
);
