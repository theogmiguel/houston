// houston.harness.*: the project's review schedule, its reviews and findings, decisions, the
// report, the overview and the seen cursor.
import type { ProjectId, ScheduledTask, ScheduledTaskId } from "@t3tools/contracts";
import {
  HOUSTON_HARNESS_LIMITS,
  HoustonHarnessError,
  type HoustonHarnessDecideInput,
  type HoustonHarnessEmptyResult,
  type HoustonHarnessFinding,
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
} from "@t3tools/contracts/houston/harnessReview";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as ProjectStore from "../../orchestration-v2/ProjectStore.ts";
import * as ScheduledTaskService from "../../scheduledTasks/ScheduledTaskService.ts";
import { HoustonHarnessRunner } from "./Runner.ts";
import { HoustonScheduledTaskRunner } from "./ScheduledTaskRunner.ts";
import { findingDecision, findingPhase, nextSeenReviewId } from "./rules.ts";
import { busyMessage, HoustonHarnessStore, type StoredReview } from "./Store.ts";

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
      const { phase, quotes: shown } = findingPhase({
        state: read.state,
        reviewId: row.review_id,
        latestPublishedReviewId: latest,
        quotes,
        verification: null,
        task: null,
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
        task: null,
        verification: null,
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
      defects: [],
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
      const settings = yield* store.settings(projectId);
      const seenReviewId = settings?.seenReviewId ?? 0;
      const count = (phase: HoustonHarnessFinding["phase"]) =>
        findings.filter((finding) => finding.phase === phase).length;
      const attention = findings.filter(
        (finding) =>
          (finding.phase === "open" ||
            finding.phase === "notSeen" ||
            finding.phase === "awaitingVerification") &&
          finding.lastSeenReviewId > seenReviewId,
      ).length;
      if (findings.length === 0 && latest === 0) continue;
      rows.push({
        projectId,
        open: count("open"),
        fixing: count("fixing"),
        awaitingVerification: count("awaitingVerification"),
        notSeen: count("notSeen"),
        resolved: count("resolved"),
        dismissed: count("dismissed"),
        suspectedDefects: 0,
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
        return Stream.concat(
          Stream.fromEffect(overview(input)),
          Stream.fromSubscription(subscription).pipe(Stream.mapEffect(() => overview(input))),
        );
      }),
    ).pipe(
      Stream.map((value): HoustonHarnessOverviewEvent => ({ type: "overview", overview: value })),
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

  return HoustonHarnessService.of({
    get,
    subscribe,
    overview,
    subscribeOverview,
    setup,
    runNow,
    report,
    decide,
    markSeen,
  });
});

export const layer = Layer.effect(HoustonHarnessService, make);
