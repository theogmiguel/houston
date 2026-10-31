// The harness review tables. Every write publishes the project it touched after it commits, so
// subscribers see changes in commit order.
import { ProjectId, ScheduledTaskId, ThreadId } from "@t3tools/contracts";
import {
  HoustonHarnessError,
  type HoustonHarnessDecisionState,
  type HoustonHarnessReview,
  type HoustonHarnessReviewStatus,
  type HoustonHarnessTrigger,
} from "@t3tools/contracts/houston/harnessReview";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { runDirOf, type FindingWrite, type VerificationWrite } from "./rules.ts";

interface ReviewRow {
  readonly id: number;
  readonly project_id: string;
  readonly trigger: HoustonHarnessTrigger;
  readonly scheduled_task_id: string | null;
  readonly thread_id: string | null;
  readonly run_id: string | null;
  readonly provider_instance_id: string | null;
  readonly status: HoustonHarnessReviewStatus;
  readonly run_dir: string;
  readonly started_at: string;
  readonly ended_at: string | null;
  readonly window_since: string | null;
  readonly window_until: string | null;
  readonly threads: number | null;
  readonly prompts: number | null;
  readonly cost_usd: number | null;
  readonly finding_count: number | null;
  readonly corrections: number;
  readonly summary: string | null;
  readonly error: string | null;
}

export interface StoredReview extends HoustonHarnessReview {
  /** The last run whose end the reactor settled. */
  readonly runId: string | null;
}

export interface FindingRow {
  readonly review_id: number;
  readonly review_ended_at: string;
  readonly key: string;
  readonly title: string;
  readonly category: string;
  readonly confidence: string;
  readonly sessions_json: string;
  readonly count: number;
  readonly quotes_json: string;
  readonly recommendation_kind: string;
  readonly target: string;
  readonly recommendation: string;
  readonly apply_prompt: string;
}

export interface DecisionRow {
  readonly key: string;
  readonly state: HoustonHarnessDecisionState;
  readonly decided_at: string;
  readonly decided_by: string;
}

export interface SettingsRow {
  readonly scheduledTaskId: ScheduledTaskId | null;
  readonly seenReviewId: number;
}

export interface PublishInput {
  readonly endedAt: string;
  readonly windowSince: string | null;
  readonly windowUntil: string | null;
  readonly threads: number | null;
  readonly prompts: number | null;
  readonly costUsd: number | null;
  readonly summary: string;
  readonly findings: ReadonlyArray<FindingWrite>;
  readonly verifications: ReadonlyArray<VerificationWrite>;
}

const toReview = (row: ReviewRow): StoredReview => ({
  id: row.id,
  projectId: ProjectId.make(row.project_id),
  trigger: row.trigger,
  status: row.status,
  scheduledTaskId:
    row.scheduled_task_id === null ? null : ScheduledTaskId.make(row.scheduled_task_id),
  threadId: row.thread_id === null ? null : ThreadId.make(row.thread_id),
  providerInstanceId: row.provider_instance_id,
  runDir: row.run_dir,
  startedAt: row.started_at,
  endedAt: row.ended_at,
  windowSince: row.window_since,
  windowUntil: row.window_until,
  threads: row.threads,
  prompts: row.prompts,
  costUsd: row.cost_usd,
  findingCount: row.finding_count,
  corrections: row.corrections,
  summary: row.summary,
  error: row.error,
  runId: row.run_id,
});

export const busyMessage = (review: Pick<HoustonHarnessReview, "id" | "status" | "threadId">) =>
  `review ${review.id} of this project is ${review.status}${
    review.threadId === null ? "" : ` in thread ${review.threadId}`
  }; wait for it to end`;

export class HoustonHarnessStore extends Context.Service<
  HoustonHarnessStore,
  {
    /** Opens a `preparing` review; `busy` names the review already preparing or running. */
    readonly openReview: (input: {
      readonly projectId: ProjectId;
      readonly trigger: HoustonHarnessTrigger;
      readonly scheduledTaskId: ScheduledTaskId | null;
      readonly providerInstanceId: string | null;
      readonly startedAt: string;
    }) => Effect.Effect<StoredReview, HoustonHarnessError>;
    readonly markRunning: (
      id: number,
      input: {
        readonly threadId: ThreadId;
        readonly windowSince: string;
        readonly windowUntil: string;
        readonly threads: number;
        readonly prompts: number;
      },
    ) => Effect.Effect<void>;
    /** Records that the reactor settled `runId` and asked for a correction. */
    readonly recordCorrection: (id: number, runId: string) => Effect.Effect<void>;
    readonly publish: (id: number, input: PublishInput) => Effect.Effect<void>;
    readonly fail: (
      id: number,
      input: { readonly endedAt: string; readonly error: string },
    ) => Effect.Effect<void>;
    readonly getReview: (id: number) => Effect.Effect<StoredReview | undefined>;
    readonly reviewByThread: (threadId: string) => Effect.Effect<StoredReview | undefined>;
    /** Newest first. */
    readonly listReviews: (
      projectId: ProjectId,
      limit: number,
    ) => Effect.Effect<ReadonlyArray<StoredReview>>;
    readonly activeReviews: Effect.Effect<ReadonlyArray<StoredReview>>;
    /** Run directories of the project's reviews older than its newest `keep`. */
    readonly runDirsBeyond: (
      projectId: ProjectId,
      keep: number,
    ) => Effect.Effect<ReadonlyArray<string>>;
    readonly windows: (projectId: ProjectId) => Effect.Effect<
      ReadonlyArray<{
        readonly status: HoustonHarnessReviewStatus;
        readonly windowUntil: string | null;
      }>
    >;
    readonly latestPublishedReviewId: (projectId: ProjectId) => Effect.Effect<number>;
    /** Every finding of the project's published reviews, with the review's end. */
    readonly findingRows: (projectId: ProjectId) => Effect.Effect<ReadonlyArray<FindingRow>>;
    readonly decisions: (projectId: ProjectId) => Effect.Effect<ReadonlyArray<DecisionRow>>;
    readonly decide: (input: {
      readonly projectId: ProjectId;
      readonly key: string;
      readonly state: HoustonHarnessDecisionState;
      readonly by: string;
    }) => Effect.Effect<void>;
    readonly settings: (projectId: ProjectId) => Effect.Effect<SettingsRow | undefined>;
    readonly projectOfTask: (taskId: ScheduledTaskId) => Effect.Effect<ProjectId | undefined>;
    readonly setScheduledTask: (
      projectId: ProjectId,
      taskId: ScheduledTaskId | null,
    ) => Effect.Effect<void>;
    readonly setSeen: (projectId: ProjectId, reviewId: number) => Effect.Effect<void>;
    /** Projects with a review, settings or a defect. */
    readonly projects: Effect.Effect<ReadonlyArray<ProjectId>>;
    readonly projectRemoved: (projectId: ProjectId) => Effect.Effect<void>;
    readonly changes: PubSub.PubSub<ProjectId>;
  }
>()("houston/houston/harnessReview/Store/HoustonHarnessStore") {}

const nowIso = DateTime.now.pipe(Effect.map((now) => DateTime.formatIso(now)));
const toJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const changes = yield* PubSub.unbounded<ProjectId>();
  const touched = (projectId: string) => PubSub.publish(changes, ProjectId.make(projectId));

  const getReview = (id: number) =>
    sql<ReviewRow>`SELECT * FROM houston_harness_reviews WHERE id = ${id}`.pipe(
      Effect.map((rows) => (rows[0] === undefined ? undefined : toReview(rows[0]))),
      Effect.orDie,
    );

  const activeOf = (projectId: string) =>
    sql<ReviewRow>`SELECT * FROM houston_harness_reviews
      WHERE project_id = ${projectId} AND status IN ('preparing', 'running')`.pipe(
      Effect.map((rows) => (rows[0] === undefined ? undefined : toReview(rows[0]))),
      Effect.orDie,
    );

  /** Runs `body`, then announces the review's project. */
  const writeReview = Effect.fn("HoustonHarnessStore.writeReview")(function* <A, E>(
    id: number,
    body: Effect.Effect<A, E>,
  ) {
    yield* body.pipe(Effect.orDie);
    const review = yield* getReview(id);
    if (review !== undefined) yield* touched(review.projectId);
  });

  const openReview: HoustonHarnessStore["Service"]["openReview"] = Effect.fn(
    "HoustonHarnessStore.openReview",
  )(function* (input) {
    const inserted = yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const rows = yield* sql<{ id: number }>`
            INSERT INTO houston_harness_reviews
              (project_id, trigger, scheduled_task_id, provider_instance_id, status, run_dir, started_at)
            VALUES (${input.projectId}, ${input.trigger}, ${input.scheduledTaskId},
              ${input.providerInstanceId}, 'preparing', '', ${input.startedAt})
            RETURNING id
          `;
          const id = rows[0]!.id;
          const [suffix] = yield* sql<{
            suffix: string;
          }>`SELECT lower(hex(randomblob(4))) AS suffix`;
          yield* sql`UPDATE houston_harness_reviews SET run_dir = ${runDirOf(id, suffix!.suffix)}
            WHERE id = ${id}`;
          return id;
        }),
      )
      .pipe(Effect.result);
    if (inserted._tag === "Failure") {
      const active = yield* activeOf(input.projectId);
      if (active === undefined) return yield* Effect.die(inserted.failure);
      return yield* new HoustonHarnessError({
        kind: "busy",
        operation: "runNow",
        message: busyMessage(active),
      });
    }
    yield* touched(input.projectId);
    return (yield* getReview(inserted.success))!;
  });

  const markRunning: HoustonHarnessStore["Service"]["markRunning"] = (id, input) =>
    writeReview(
      id,
      sql`UPDATE houston_harness_reviews
        SET status = 'running', thread_id = ${input.threadId}, window_since = ${input.windowSince},
          window_until = ${input.windowUntil}, threads = ${input.threads}, prompts = ${input.prompts}
        WHERE id = ${id} AND status = 'preparing'`,
    );

  const recordCorrection: HoustonHarnessStore["Service"]["recordCorrection"] = (id, runId) =>
    writeReview(
      id,
      sql`UPDATE houston_harness_reviews SET corrections = corrections + 1, run_id = ${runId}
        WHERE id = ${id}`,
    );

  const publish: HoustonHarnessStore["Service"]["publish"] = (id, input) =>
    writeReview(
      id,
      sql.withTransaction(
        Effect.gen(function* () {
          // Only a running review publishes: a failed, preparing or published one keeps its state.
          const [current] = yield* sql<{ status: string }>`
            SELECT status FROM houston_harness_reviews WHERE id = ${id}`;
          if (current?.status !== "running") return;
          for (const finding of input.findings) {
            yield* sql`
              INSERT INTO houston_harness_findings (review_id, key, title, category, confidence,
                sessions_json, count, quotes_json, recommendation_kind, target, recommendation, apply_prompt)
              VALUES (${id}, ${finding.key}, ${finding.title}, ${finding.category}, ${finding.confidence},
                ${toJson(finding.sessions)}, ${finding.count}, ${toJson(finding.quotes)},
                ${finding.recommendationKind}, ${finding.target}, ${finding.recommendation},
                ${finding.applyPrompt})
            `;
          }
          for (const verification of input.verifications) {
            yield* sql`
              INSERT INTO houston_harness_verifications
                (review_id, key, task_id, verdict, sessions_after, evidence_json)
              VALUES (${id}, ${verification.key}, ${verification.taskId}, ${verification.verdict},
                ${verification.sessionsAfter}, ${toJson(verification.evidence)})
            `;
          }
          yield* sql`
            UPDATE houston_harness_reviews
            SET status = 'published', ended_at = ${input.endedAt},
              window_since = COALESCE(${input.windowSince}, window_since),
              window_until = COALESCE(${input.windowUntil}, window_until),
              threads = COALESCE(${input.threads}, threads), prompts = COALESCE(${input.prompts}, prompts),
              cost_usd = ${input.costUsd}, finding_count = ${input.findings.length},
              summary = ${input.summary}, error = NULL
            WHERE id = ${id} AND status = 'running'
          `;
        }),
      ),
    );

  const fail: HoustonHarnessStore["Service"]["fail"] = (id, input) =>
    writeReview(
      id,
      sql`UPDATE houston_harness_reviews
        SET status = 'failed', ended_at = ${input.endedAt}, error = ${input.error}
        WHERE id = ${id} AND status IN ('preparing', 'running')`,
    );

  const reviewByThread: HoustonHarnessStore["Service"]["reviewByThread"] = (threadId) =>
    sql<ReviewRow>`SELECT * FROM houston_harness_reviews WHERE thread_id = ${threadId}`.pipe(
      Effect.map((rows) => (rows[0] === undefined ? undefined : toReview(rows[0]))),
      Effect.orDie,
    );

  const listReviews: HoustonHarnessStore["Service"]["listReviews"] = (projectId, limit) =>
    sql<ReviewRow>`SELECT * FROM houston_harness_reviews WHERE project_id = ${projectId}
      ORDER BY id DESC LIMIT ${limit}`.pipe(
      Effect.map((rows) => rows.map(toReview)),
      Effect.orDie,
    );

  const activeReviews = sql<ReviewRow>`SELECT * FROM houston_harness_reviews
    WHERE status IN ('preparing', 'running') ORDER BY id`.pipe(
    Effect.map((rows) => rows.map(toReview)),
    Effect.orDie,
  );

  const runDirsBeyond: HoustonHarnessStore["Service"]["runDirsBeyond"] = (projectId, keep) =>
    sql<{ run_dir: string }>`SELECT run_dir FROM houston_harness_reviews
      WHERE project_id = ${projectId} ORDER BY id DESC LIMIT -1 OFFSET ${keep}`.pipe(
      Effect.map((rows) => rows.map((row) => row.run_dir)),
      Effect.orDie,
    );

  const windows: HoustonHarnessStore["Service"]["windows"] = (projectId) =>
    sql<{ status: HoustonHarnessReviewStatus; window_until: string | null }>`
      SELECT status, window_until FROM houston_harness_reviews WHERE project_id = ${projectId}
    `.pipe(
      Effect.map((rows) =>
        rows.map((row) => ({ status: row.status, windowUntil: row.window_until })),
      ),
      Effect.orDie,
    );

  const latestPublishedReviewId: HoustonHarnessStore["Service"]["latestPublishedReviewId"] = (
    projectId,
  ) =>
    sql<{ id: number | null }>`SELECT MAX(id) AS id FROM houston_harness_reviews
      WHERE project_id = ${projectId} AND status = 'published'`.pipe(
      Effect.map((rows) => rows[0]?.id ?? 0),
      Effect.orDie,
    );

  const findingRows: HoustonHarnessStore["Service"]["findingRows"] = (projectId) =>
    sql<FindingRow>`
      SELECT f.*, r.ended_at AS review_ended_at
      FROM houston_harness_findings f
      JOIN houston_harness_reviews r ON r.id = f.review_id
      WHERE r.project_id = ${projectId} AND r.status = 'published'
      ORDER BY f.review_id DESC, f.rowid ASC
    `.pipe(Effect.orDie);

  const decisions: HoustonHarnessStore["Service"]["decisions"] = (projectId) =>
    sql<DecisionRow>`SELECT key, state, decided_at, decided_by FROM houston_harness_decisions
      WHERE project_id = ${projectId}`.pipe(Effect.orDie);

  const decide: HoustonHarnessStore["Service"]["decide"] = Effect.fn("HoustonHarnessStore.decide")(
    function* (input) {
      const at = yield* nowIso;
      yield* sql`
        INSERT INTO houston_harness_decisions (project_id, key, state, decided_at, decided_by)
        VALUES (${input.projectId}, ${input.key}, ${input.state}, ${at}, ${input.by})
        ON CONFLICT (project_id, key) DO UPDATE SET
          state = excluded.state, decided_at = excluded.decided_at, decided_by = excluded.decided_by
      `.pipe(Effect.orDie);
      yield* touched(input.projectId);
    },
  );

  const settings: HoustonHarnessStore["Service"]["settings"] = (projectId) =>
    sql<{ scheduled_task_id: string | null; seen_review_id: number }>`
      SELECT scheduled_task_id, seen_review_id FROM houston_harness_settings
      WHERE project_id = ${projectId}
    `.pipe(
      Effect.map((rows) =>
        rows[0] === undefined
          ? undefined
          : {
              scheduledTaskId:
                rows[0].scheduled_task_id === null
                  ? null
                  : ScheduledTaskId.make(rows[0].scheduled_task_id),
              seenReviewId: rows[0].seen_review_id,
            },
      ),
      Effect.orDie,
    );

  const projectOfTask: HoustonHarnessStore["Service"]["projectOfTask"] = (taskId) =>
    sql<{ project_id: string }>`SELECT project_id FROM houston_harness_settings
      WHERE scheduled_task_id = ${taskId}`.pipe(
      Effect.map((rows) =>
        rows[0] === undefined ? undefined : ProjectId.make(rows[0].project_id),
      ),
      Effect.orDie,
    );

  const setScheduledTask: HoustonHarnessStore["Service"]["setScheduledTask"] = Effect.fn(
    "HoustonHarnessStore.setScheduledTask",
  )(function* (projectId, taskId) {
    const at = yield* nowIso;
    yield* sql`
      INSERT INTO houston_harness_settings (project_id, scheduled_task_id, updated_at)
      VALUES (${projectId}, ${taskId}, ${at})
      ON CONFLICT (project_id) DO UPDATE SET
        scheduled_task_id = excluded.scheduled_task_id, updated_at = excluded.updated_at
    `.pipe(Effect.orDie);
    yield* touched(projectId);
  });

  const setSeen: HoustonHarnessStore["Service"]["setSeen"] = Effect.fn(
    "HoustonHarnessStore.setSeen",
  )(function* (projectId, reviewId) {
    const at = yield* nowIso;
    yield* sql`
      INSERT INTO houston_harness_settings (project_id, seen_review_id, updated_at)
      VALUES (${projectId}, ${reviewId}, ${at})
      ON CONFLICT (project_id) DO UPDATE SET
        seen_review_id = MAX(seen_review_id, excluded.seen_review_id), updated_at = excluded.updated_at
    `.pipe(Effect.orDie);
    yield* touched(projectId);
  });

  const projects = sql<{ project_id: string }>`
    SELECT project_id FROM houston_harness_reviews
    UNION SELECT project_id FROM houston_harness_settings
    UNION SELECT project_id FROM houston_defects
    ORDER BY project_id
  `.pipe(
    Effect.map((rows) => rows.map((row) => ProjectId.make(row.project_id))),
    Effect.orDie,
  );

  const projectRemoved: HoustonHarnessStore["Service"]["projectRemoved"] = Effect.fn(
    "HoustonHarnessStore.projectRemoved",
  )(function* (projectId) {
    yield* sql
      .withTransaction(
        Effect.gen(function* () {
          yield* sql`DELETE FROM houston_harness_findings WHERE review_id IN
            (SELECT id FROM houston_harness_reviews WHERE project_id = ${projectId})`;
          yield* sql`DELETE FROM houston_harness_verifications WHERE review_id IN
            (SELECT id FROM houston_harness_reviews WHERE project_id = ${projectId})`;
          yield* sql`DELETE FROM houston_harness_reviews WHERE project_id = ${projectId}`;
          yield* sql`DELETE FROM houston_harness_settings WHERE project_id = ${projectId}`;
          yield* sql`DELETE FROM houston_harness_decisions WHERE project_id = ${projectId}`;
          yield* sql`DELETE FROM houston_harness_finding_tasks WHERE project_id = ${projectId}`;
          yield* sql`DELETE FROM houston_defects WHERE project_id = ${projectId}`;
        }),
      )
      .pipe(Effect.orDie);
    yield* touched(projectId);
  });

  return HoustonHarnessStore.of({
    openReview,
    markRunning,
    recordCorrection,
    publish,
    fail,
    getReview,
    reviewByThread,
    listReviews,
    activeReviews,
    runDirsBeyond,
    windows,
    latestPublishedReviewId,
    findingRows,
    decisions,
    decide,
    settings,
    projectOfTask,
    setScheduledTask,
    setSeen,
    projects,
    projectRemoved,
    changes,
  });
});

export const layer = Layer.effect(HoustonHarnessStore, make);
