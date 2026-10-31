// The Tasks backlog's tables. Writes run one at a time in a transaction and publish the touched
// task ids after commit, so subscribers see changes in commit order.
import type { ProjectId } from "@t3tools/contracts";
import {
  HOUSTON_TASK_LIMITS,
  HoustonTaskPlan,
  HoustonTaskReviewFinding,
  houstonTaskKey,
  parseHoustonTaskRef,
  type HoustonTask,
  type HoustonTaskDetail,
  type HoustonTaskDomain,
  type HoustonTaskDomainKind,
  type HoustonTaskError,
  type HoustonTaskPriority,
  type HoustonTaskRun,
  type HoustonTaskRunState,
  type HoustonTaskScope,
  type HoustonTaskStatus,
  type HoustonTaskSummary,
} from "@t3tools/contracts/houston/tasks";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlError from "effect/sql/SqlError";

import {
  OPEN_RUN_STATES,
  blockerFinished,
  priorityFromValue,
  priorityValue,
  queueOf,
  readiness,
  refuse,
  rollupDelivery,
} from "./rules.ts";

/** Runs right after a snapshot's rows are read; tests hold it to commit a write mid-snapshot. */
export const SnapshotReadHook = Context.Reference<Effect.Effect<void>>(
  "houston/houston/tasks/SnapshotReadHook",
  { defaultValue: () => Effect.void },
);

export interface TaskRow {
  readonly id: number;
  readonly number: number;
  readonly project_id: string | null;
  readonly title: string;
  readonly description: string;
  readonly status: HoustonTaskStatus;
  readonly priority: number;
  readonly parent_id: number | null;
  readonly ref_url: string | null;
  readonly revision: number;
  readonly created_by: string;
  readonly created_at: string;
  readonly updated_at: string;
  readonly archived_at: string | null;
}

export interface RunRow {
  readonly id: number;
  readonly task_id: number;
  readonly attempt: number;
  readonly kind: HoustonTaskRun["kind"];
  readonly state: HoustonTaskRunState;
  readonly provider: string;
  readonly reviewer: string | null;
  readonly thread_id: string | null;
  readonly run_id: string | null;
  readonly worktree_path: string | null;
  readonly branch: string | null;
  readonly base_commit: string | null;
  readonly initial_revision: number;
  readonly summary: string | null;
  readonly reason: string | null;
  readonly started_at: string;
  readonly ended_at: string | null;
  readonly pr_url: string | null;
  readonly review_head_sha: string | null;
  readonly review_focus: string | null;
  readonly review_verdict: string | null;
  readonly review_findings: string | null;
  readonly review_skipped_reason: string | null;
}

export interface DomainRow {
  readonly task_id: number;
  readonly kind: HoustonTaskDomainKind;
  readonly initiative_id: number | null;
  readonly user_status_override: number;
  readonly plan_json: string | null;
  readonly planning_thread_id: string | null;
}

export interface NewTask {
  readonly projectId: string | null;
  readonly title: string;
  readonly description: string;
  readonly status: HoustonTaskStatus;
  readonly priority: HoustonTaskPriority;
  readonly parentId: number | null;
  readonly refUrl: string | null;
  readonly acceptance: ReadonlyArray<string>;
  readonly createdBy: string;
}

export const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));

/** A history row a write recorded. */
export interface TaskTransition {
  readonly taskId: number;
  readonly actor: string;
  readonly action: string;
  readonly changes: object;
}

/** Hears each write's history rows before the write commits, inside its transaction. */
export class HoustonTaskTransitions extends Context.Service<
  HoustonTaskTransitions,
  {
    readonly recorded: (transitions: ReadonlyArray<TaskTransition>) => Effect.Effect<void>;
  }
>()("houston/houston/tasks/TaskStore/HoustonTaskTransitions") {}

/** The history action that records a head pushed to a run thread's pull request. */
export const PUSHED_ACTION = "houston:pushed";

export const toTask = (row: TaskRow): HoustonTask => ({
  id: row.id,
  number: row.number,
  key: houstonTaskKey(row.number),
  projectId: row.project_id as ProjectId | null,
  title: row.title,
  description: row.description,
  status: row.status,
  priority: priorityFromValue(row.priority) ?? "none",
  parentId: row.parent_id,
  refUrl: row.ref_url,
  revision: row.revision,
  createdBy: row.created_by,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  archivedAt: row.archived_at,
});

/** History changes and other free-form JSON columns. */
export const toJsonText = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const decodeFindings = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Array(HoustonTaskReviewFinding)),
);
const decodePlan = Schema.decodeUnknownOption(Schema.fromJsonString(HoustonTaskPlan));

const parseFindings = (raw: string | null): ReadonlyArray<HoustonTaskReviewFinding> =>
  raw === null ? [] : Option.getOrElse(decodeFindings(raw), () => []);

/** `pushedHead` is the newest head pushed for the task; a verdict on another head is outdated. */
export const toRun = (row: RunRow, pushedHead: string | null = null): HoustonTaskRun => ({
  id: row.id,
  taskId: row.task_id,
  attempt: row.attempt,
  kind: row.kind,
  state: row.state,
  provider: row.provider,
  reviewer: row.reviewer,
  threadId: row.thread_id as HoustonTaskRun["threadId"],
  runId: row.run_id as HoustonTaskRun["runId"],
  worktreePath: row.worktree_path,
  branch: row.branch,
  baseCommit: row.base_commit,
  initialRevision: row.initial_revision,
  summary: row.summary,
  reason: row.reason,
  startedAt: row.started_at,
  endedAt: row.ended_at,
  prUrl: row.pr_url,
  review:
    row.review_head_sha !== null && row.review_verdict !== null
      ? {
          headSha: row.review_head_sha,
          verdict: row.review_verdict as "pass" | "fail" | "skipped",
          focus: (row.review_focus ?? "bugs") as "bugs" | "security" | "performance" | "full",
          findings: parseFindings(row.review_findings),
          skippedReason: row.review_skipped_reason,
          outdated: pushedHead !== null && pushedHead !== row.review_head_sha,
        }
      : null,
});

export const parsePlan = (raw: string | null): HoustonTaskPlan | null =>
  raw === null ? null : Option.getOrNull(decodePlan(raw));

const unansweredQuestions = (plan: HoustonTaskPlan | null) =>
  plan === null
    ? 0
    : plan.proposal.questions.filter(
        (question) =>
          !plan.answers.some(
            (answer) => answer.question === question && answer.answer.trim().length > 0,
          ),
      ).length;

interface DerivedInputs {
  readonly acceptance: ReadonlyMap<number, ReadonlyArray<{ text: string; checked: boolean }>>;
  readonly blockers: ReadonlyMap<
    number,
    ReadonlyArray<{ id: number; status: HoustonTaskStatus | null; archived: boolean }>
  >;
  readonly domains: ReadonlyMap<
    number,
    DomainRow & {
      readonly initiative_project_id: string | null;
      readonly initiative_archived_at: string | null;
      readonly initiative_exists: number | null;
    }
  >;
  readonly openRuns: ReadonlyMap<number, RunRow>;
  readonly trackerConflicts: ReadonlySet<number>;
}

const groupBy = <A, K>(rows: ReadonlyArray<A>, key: (row: A) => K) => {
  const map = new Map<K, Array<A>>();
  for (const row of rows) {
    const list = map.get(key(row));
    if (list === undefined) map.set(key(row), [row]);
    else list.push(row);
  }
  return map;
};

const readinessOf = (task: TaskRow, inputs: DerivedInputs, planningOpen: boolean) => {
  const domain = inputs.domains.get(task.id);
  return readiness({
    hasProject: task.project_id !== null,
    acceptance: (inputs.acceptance.get(task.id) ?? []).map((item) => item.text),
    unansweredQuestions: unansweredQuestions(parsePlan(domain?.plan_json ?? null)),
    unfinishedBlockers: (inputs.blockers.get(task.id) ?? [])
      .filter(
        (blocker) =>
          blocker.status !== null &&
          !blockerFinished({ status: blocker.status, archived: blocker.archived }),
      )
      .map((blocker) => blocker.id),
    domain:
      domain === undefined
        ? null
        : {
            kind: domain.kind,
            initiative:
              domain.initiative_id === null || domain.initiative_exists === null
                ? null
                : {
                    archived: domain.initiative_archived_at !== null,
                    sameProject: domain.initiative_project_id === task.project_id,
                  },
          },
    planningOpen,
    trackerConflict: inputs.trackerConflicts.has(task.id),
  });
};

export const toSummary = (task: TaskRow, inputs: DerivedInputs): HoustonTaskSummary => {
  const domain = inputs.domains.get(task.id);
  const ready = readinessOf(task, inputs, domain?.planning_thread_id != null).ready;
  const acceptance = inputs.acceptance.get(task.id) ?? [];
  const openRun = inputs.openRuns.get(task.id);
  const { description: _description, ...rest } = toTask(task);
  return {
    ...rest,
    acceptanceChecked: acceptance.filter((item) => item.checked).length,
    acceptanceTotal: acceptance.length,
    queue: queueOf({
      status: task.status,
      archived: task.archived_at !== null,
      ready,
      runState: openRun?.state ?? null,
    }),
    ready,
    openRun: openRun === undefined ? null : toRun(openRun),
  };
};

export class HoustonTaskStore extends Context.Service<
  HoustonTaskStore,
  {
    /** Resolves `HOU-<n>` in any case or a decimal id; `not_found` names the input. */
    readonly resolve: (operation: string, ref: string) => Effect.Effect<TaskRow, HoustonTaskError>;
    readonly taskById: (id: number) => Effect.Effect<TaskRow | undefined>;
    readonly taskCount: Effect.Effect<number>;
    readonly createTask: (input: NewTask) => Effect.Effect<TaskRow>;
    /** History rows are attributed to `actor`; `changes` is stored as JSON. */
    readonly recordHistory: (
      taskId: number,
      actor: string,
      action: string,
      changes: object,
    ) => Effect.Effect<void>;
    /** Runs `body` alone in one transaction, then publishes the task ids it returns. */
    readonly write: <A, E, R>(
      body: Effect.Effect<{ readonly result: A; readonly touched: ReadonlyArray<number> }, E, R>,
    ) => Effect.Effect<A, E, R>;
    readonly changes: PubSub.PubSub<ReadonlyArray<number>>;
    readonly summaries: (
      filter: { readonly scope: HoustonTaskScope } | { readonly ids: ReadonlyArray<number> },
    ) => Effect.Effect<{
      readonly summaries: ReadonlyArray<HoustonTaskSummary>;
      readonly truncated: boolean;
    }>;
    readonly domain: (task: TaskRow) => Effect.Effect<HoustonTaskDomain>;
    readonly detail: (task: TaskRow) => Effect.Effect<HoustonTaskDetail>;
    readonly domainRow: (taskId: number) => Effect.Effect<DomainRow | undefined>;
    /** Delivery status rollup after a write to `taskId`; returns the delivery it moved, if any. */
    readonly rollup: (taskId: number) => Effect.Effect<number | undefined>;
    /** Unassigns a deleted project's tasks and interrupts their open runs. */
    readonly projectRemoved: (projectId: ProjectId) => Effect.Effect<void>;
  }
>()("houston/houston/tasks/TaskStore/HoustonTaskStore") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const lock = yield* Semaphore.make(1);
  const changes = yield* PubSub.unbounded<ReadonlyArray<number>>();
  const transitions = yield* Effect.serviceOption(HoustonTaskTransitions);
  // The history rows of the write in progress; writes run one at a time.
  let recorded: Array<TaskTransition> = [];

  const taskById = (id: number) =>
    sql<TaskRow>`SELECT * FROM houston_tasks WHERE id = ${id}`.pipe(
      Effect.map((rows) => rows[0]),
      Effect.orDie,
    );

  const resolve = Effect.fn("HoustonTaskStore.resolve")(function* (operation: string, ref: string) {
    const parsed = parseHoustonTaskRef(ref.trim());
    if (parsed === null) {
      return yield* refuse(
        "invalid",
        operation,
        `task id "${ref}" is not HOU-<number> or a task id, for example HOU-1`,
      );
    }
    const rows =
      parsed.kind === "number"
        ? yield* sql<TaskRow>`SELECT * FROM houston_tasks WHERE number = ${parsed.number}`.pipe(
            Effect.orDie,
          )
        : yield* sql<TaskRow>`SELECT * FROM houston_tasks WHERE id = ${parsed.id}`.pipe(
            Effect.orDie,
          );
    const row = rows[0];
    if (row === undefined) {
      return yield* refuse("not_found", operation, `no task ${ref}`);
    }
    return row;
  });

  const recordHistory = Effect.fn("HoustonTaskStore.recordHistory")(function* (
    taskId: number,
    actor: string,
    action: string,
    changesJson: object,
  ) {
    const now = yield* nowIso;
    yield* sql`
      INSERT INTO houston_task_history (task_id, actor, action, changes, created_at)
      VALUES (${taskId}, ${actor}, ${action}, ${toJsonText(changesJson)}, ${now})
    `;
    recorded.push({ taskId, actor, action, changes: changesJson });
  }, Effect.orDie);

  const createTask = Effect.fn("HoustonTaskStore.createTask")(function* (input: NewTask) {
    const now = yield* nowIso;
    const [counter] = yield* sql<{ readonly next_number: number }>`
        UPDATE houston_task_counter SET next_number = next_number + 1 WHERE id = 1
        RETURNING next_number - 1 AS next_number
      `;
    const number = counter?.next_number ?? 1;
    const [row] = yield* sql<TaskRow>`
        INSERT INTO houston_tasks (
          number, project_id, title, description, status, priority, parent_id, ref_url,
          revision, created_by, created_at, updated_at
        ) VALUES (
          ${number}, ${input.projectId}, ${input.title}, ${input.description}, ${input.status},
          ${priorityValue(input.priority)}, ${input.parentId}, ${input.refUrl}, 1,
          ${input.createdBy}, ${now}, ${now}
        )
        RETURNING *
      `;
    const created = row as TaskRow;
    for (const [position, text] of input.acceptance.entries()) {
      yield* sql`
          INSERT INTO houston_task_acceptance (task_id, position, text)
          VALUES (${created.id}, ${position}, ${text})
        `;
    }
    yield* recordHistory(created.id, input.createdBy, "created", {});
    return created;
  }, Effect.orDie);

  // The transitions are heard after the body, so they see the write's final rows.
  const heard = Effect.suspend(() => {
    const entries = recorded;
    recorded = [];
    return entries.length === 0 || Option.isNone(transitions)
      ? Effect.void
      : transitions.value.recorded(entries);
  });

  const write: HoustonTaskStore["Service"]["write"] = (body) =>
    lock.withPermits(1)(
      sql
        .withTransaction(
          Effect.suspend(() => {
            recorded = [];
            return body;
          }).pipe(Effect.tap(() => heard)),
        )
        .pipe(
          Effect.catchIf(SqlError.isSqlError, (error) => Effect.die(error)),
          Effect.tap(({ touched }) =>
            touched.length === 0 ? Effect.void : PubSub.publish(changes, [...new Set(touched)]),
          ),
          Effect.map(({ result }) => result),
        ),
    ) as never;

  const loadInputs = Effect.fn("HoustonTaskStore.loadInputs")(function* (
    ids: ReadonlyArray<number> | null,
  ) {
    const only = (column: string) =>
      ids === null ? sql`1 = 1` : sql`${sql(column)} IN ${sql.in(ids)}`;
    const acceptance = yield* sql<{
      readonly task_id: number;
      readonly text: string;
      readonly checked_at: string | null;
    }>`
        SELECT task_id, text, checked_at FROM houston_task_acceptance
        WHERE ${only("task_id")} ORDER BY task_id, position, id
      `;
    const blockers = yield* sql<{
      readonly task_id: number;
      readonly blocked_by_id: number;
      readonly status: HoustonTaskStatus | null;
      readonly archived_at: string | null;
    }>`
        SELECT b.task_id, b.blocked_by_id, t.status, t.archived_at
        FROM houston_task_blocks b LEFT JOIN houston_tasks t ON t.id = b.blocked_by_id
        WHERE ${only("b.task_id")} ORDER BY b.task_id, b.blocked_by_id
      `;
    const domains = yield* sql<
      DomainRow & {
        readonly initiative_project_id: string | null;
        readonly initiative_archived_at: string | null;
        readonly initiative_exists: number | null;
      }
    >`
        SELECT d.task_id, d.kind, d.initiative_id, d.user_status_override, d.plan_json,
          d.planning_thread_id, i.project_id AS initiative_project_id,
          i.archived_at AS initiative_archived_at, i.id AS initiative_exists
        FROM houston_task_domain d LEFT JOIN houston_task_initiatives i ON i.id = d.initiative_id
        WHERE ${only("d.task_id")}
      `;
    const runs = yield* sql<RunRow>`
        SELECT * FROM houston_task_runs
        WHERE state IN ${sql.in([...OPEN_RUN_STATES])} AND ${only("task_id")}
        ORDER BY id
      `;
    // A task source link with a recorded conflict keeps its task unready until it is resolved.
    const conflicted = yield* sql<{ readonly task_id: number }>`
        SELECT DISTINCT task_id FROM houston_task_source_links
        WHERE json_array_length(snapshot_json, '$.conflicts') > 0 AND ${only("task_id")}
      `;
    return {
      acceptance: new Map(
        [...groupBy(acceptance, (row) => row.task_id)].map(([id, rows]) => [
          id,
          rows.map((row) => ({ text: row.text, checked: row.checked_at !== null })),
        ]),
      ),
      blockers: new Map(
        [...groupBy(blockers, (row) => row.task_id)].map(([id, rows]) => [
          id,
          rows.map((row) => ({
            id: row.blocked_by_id,
            status: row.status,
            archived: row.archived_at !== null,
          })),
        ]),
      ),
      domains: new Map(domains.map((row) => [row.task_id, row])),
      // Oldest first, so the newest open run per task wins.
      openRuns: new Map(runs.map((row) => [row.task_id, row])),
      trackerConflicts: new Set(conflicted.map((row) => row.task_id)),
    } satisfies DerivedInputs;
  }, Effect.orDie);

  const summaries: HoustonTaskStore["Service"]["summaries"] = Effect.fn(
    "HoustonTaskStore.summaries",
  )(function* (filter) {
    const limit = HOUSTON_TASK_LIMITS.tasks;
    const rows =
      "ids" in filter
        ? filter.ids.length === 0
          ? []
          : yield* sql<TaskRow>`SELECT * FROM houston_tasks WHERE id IN ${sql.in(filter.ids)}`
        : filter.scope === "all"
          ? yield* sql<TaskRow>`SELECT * FROM houston_tasks ORDER BY number DESC LIMIT ${limit + 1}`
          : filter.scope === "unassigned"
            ? yield* sql<TaskRow>`
                  SELECT * FROM houston_tasks WHERE project_id IS NULL
                  ORDER BY number DESC LIMIT ${limit + 1}
                `
            : yield* sql<TaskRow>`
                  SELECT * FROM houston_tasks WHERE project_id = ${filter.scope.projectId}
                  ORDER BY number DESC LIMIT ${limit + 1}
                `;
    const kept = rows.slice(0, limit);
    const inputs = yield* loadInputs(
      "scope" in filter && filter.scope === "all" ? null : kept.map((row) => row.id),
    );
    return {
      summaries: kept.map((row) => toSummary(row, inputs)),
      truncated: rows.length > limit,
    };
  }, Effect.orDie);

  const domainRow = (taskId: number) =>
    sql<DomainRow>`SELECT * FROM houston_task_domain WHERE task_id = ${taskId}`.pipe(
      Effect.map((rows) => rows[0]),
      Effect.orDie,
    );

  const domain = Effect.fn("HoustonTaskStore.domain")(function* (task: TaskRow) {
    const inputs = yield* loadInputs([task.id]);
    const row = inputs.domains.get(task.id);
    const parent = task.parent_id === null ? undefined : yield* domainRow(task.parent_id);
    const children =
      row?.kind === "delivery"
        ? yield* sql<{ readonly status: HoustonTaskStatus }>`
              SELECT t.status FROM houston_tasks t
              JOIN houston_task_domain d ON d.task_id = t.id AND d.kind = 'slice'
              WHERE t.parent_id = ${task.id}
            `
        : [];
    return {
      taskId: task.id,
      kind: row?.kind ?? null,
      initiativeId: row?.initiative_id ?? null,
      deliveryId:
        (row === undefined || row.kind === "slice") && parent?.kind === "delivery"
          ? task.parent_id
          : null,
      blockedBy: (inputs.blockers.get(task.id) ?? []).map((blocker) => blocker.id),
      sliceTotal: children.length,
      sliceDone: children.filter((child) => child.status === "done").length,
      readiness: readinessOf(task, inputs, row?.planning_thread_id != null),
      plan: parsePlan(row?.plan_json ?? null),
    } satisfies HoustonTaskDomain;
  }, Effect.orDie);

  // Task runs record each new head pushed to a run thread's pull request as a history row.
  const latestPushedHead = (taskId: number) =>
    sql<{ readonly changes: string }>`
      SELECT changes FROM houston_task_history
      WHERE task_id = ${taskId} AND action = ${PUSHED_ACTION} ORDER BY id DESC LIMIT 1
    `.pipe(
      Effect.map((rows) => {
        const raw = rows[0]?.changes;
        if (raw === undefined) return null;
        const head = (JSON.parse(raw) as { readonly headSha?: unknown }).headSha;
        return typeof head === "string" ? head : null;
      }),
      Effect.orDie,
    );

  const detail = Effect.fn("HoustonTaskStore.detail")(function* (task: TaskRow) {
    const acceptance = yield* sql<{
      readonly id: number;
      readonly position: number;
      readonly text: string;
      readonly checked_at: string | null;
      readonly checked_by: string | null;
    }>`
        SELECT id, position, text, checked_at, checked_by FROM houston_task_acceptance
        WHERE task_id = ${task.id} ORDER BY position, id
      `;
    const comments = yield* sql<{
      readonly id: number;
      readonly body: string;
      readonly author: string;
      readonly created_at: string;
    }>`
        SELECT id, body, author, created_at FROM houston_task_comments
        WHERE task_id = ${task.id} ORDER BY id LIMIT ${HOUSTON_TASK_LIMITS.commentsPerTask}
      `;
    const history = yield* sql<{
      readonly id: number;
      readonly actor: string;
      readonly action: string;
      readonly changes: string;
      readonly created_at: string;
    }>`
        SELECT id, actor, action, changes, created_at FROM houston_task_history
        WHERE task_id = ${task.id} ORDER BY id DESC LIMIT ${HOUSTON_TASK_LIMITS.historyPage}
      `;
    const runs = yield* sql<RunRow>`
        SELECT * FROM houston_task_runs WHERE task_id = ${task.id}
        ORDER BY id DESC LIMIT ${HOUSTON_TASK_LIMITS.runsPage}
      `;
    const pushedHead = yield* latestPushedHead(task.id);
    const [planning] = yield* sql<{
      readonly thread_id: string;
      readonly state: "active" | "submitted" | "cancelled" | "exited";
      readonly task_revision: number;
      readonly initiative_revision: number | null;
    }>`
        SELECT thread_id, state, task_revision, initiative_revision FROM houston_task_planning
        WHERE task_id = ${task.id} ORDER BY created_at DESC, rowid DESC LIMIT 1
      `;
    return {
      task: toTask(task),
      acceptance: acceptance.map((item) => ({
        id: item.id,
        position: item.position,
        text: item.text,
        checkedAt: item.checked_at,
        checkedBy: item.checked_by,
      })),
      comments: comments.map((comment) => ({
        id: comment.id,
        body: comment.body,
        author: comment.author,
        createdAt: comment.created_at,
      })),
      history: history.map((entry) => ({
        id: entry.id,
        actor: entry.actor,
        action: entry.action,
        changes: entry.changes,
        createdAt: entry.created_at,
      })),
      runs: runs.map((run) => toRun(run, pushedHead)),
      domain: yield* domain(task),
      planning:
        planning === undefined
          ? null
          : {
              threadId: planning.thread_id as HoustonTaskRun["threadId"] & string,
              state: planning.state,
              taskRevision: planning.task_revision,
              initiativeRevision: planning.initiative_revision,
            },
    } as HoustonTaskDetail;
  }, Effect.orDie);

  const rollup = Effect.fn("HoustonTaskStore.rollup")(function* (taskId: number) {
    const task = yield* taskById(taskId);
    if (task === undefined) return undefined;
    const own = yield* domainRow(taskId);
    if (own === undefined) return undefined;
    const deliveryId = own.kind === "delivery" ? taskId : task.parent_id;
    if (deliveryId === null) return undefined;
    const delivery = yield* taskById(deliveryId);
    const deliveryDomain = yield* domainRow(deliveryId);
    if (delivery === undefined || deliveryDomain?.kind !== "delivery") return undefined;
    const children = yield* sql<{
      readonly kind: HoustonTaskDomainKind | null;
      readonly status: HoustonTaskStatus;
    }>`
        SELECT d.kind, t.status FROM houston_tasks t
        LEFT JOIN houston_task_domain d ON d.task_id = t.id
        WHERE t.parent_id = ${deliveryId}
      `;
    const next = rollupDelivery({
      current: delivery.status,
      userStatusOverride: deliveryDomain.user_status_override !== 0,
      children,
    });
    if (next === null) return undefined;
    const now = yield* nowIso;
    yield* sql`
        UPDATE houston_tasks SET status = ${next}, revision = revision + 1, updated_at = ${now}
        WHERE id = ${deliveryId}
      `;
    yield* recordHistory(deliveryId, "houston:delivery-rollup", "delivery_rollup", {
      status: { old: delivery.status, new: next },
      sliceProgress: {
        done: children.filter((child) => child.kind === "slice" && child.status === "done").length,
        total: children.filter((child) => child.kind === "slice").length,
      },
    });
    return deliveryId;
  }, Effect.orDie);

  const projectRemoved = (projectId: ProjectId) =>
    write(
      Effect.gen(function* () {
        const now = yield* nowIso;
        const tasks = yield* sql<{ readonly id: number }>`
          SELECT id FROM houston_tasks WHERE project_id = ${projectId}
        `;
        const ids = tasks.map((task) => task.id);
        if (ids.length === 0) return { result: undefined, touched: [] };
        yield* sql`
          UPDATE houston_task_runs SET state = 'interrupted', reason = 'project removed',
            ended_at = ${now}
          WHERE task_id IN ${sql.in(ids)} AND state IN ${sql.in([...OPEN_RUN_STATES])}
        `;
        for (const id of ids) {
          yield* recordHistory(id, "houston:project-removed", "houston:project-removed", {
            projectId: { old: projectId, new: null },
          });
        }
        yield* sql`
          UPDATE houston_tasks SET project_id = NULL, revision = revision + 1, updated_at = ${now}
          WHERE id IN ${sql.in(ids)}
        `;
        yield* sql`DELETE FROM houston_task_settings WHERE project_id = ${projectId}`;
        return { result: undefined, touched: ids };
      }),
    ).pipe(Effect.orDie);

  return HoustonTaskStore.of({
    resolve,
    taskById,
    taskCount: sql<{ readonly n: number }>`SELECT COUNT(*) AS n FROM houston_tasks`.pipe(
      Effect.map((rows) => rows[0]?.n ?? 0),
      Effect.orDie,
    ),
    createTask,
    recordHistory,
    write,
    changes,
    summaries,
    domain,
    detail,
    domainRow,
    rollup,
    projectRemoved,
  });
});

export const layer = Layer.effect(HoustonTaskStore, make);
