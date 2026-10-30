// Task runs as threads: Start launches a thread in a worktree through upstream's launcher, the
// run follows that thread's stored events, and planners and reviewers run read-only (AD-048).
import {
  ChatAttachment,
  CommandId,
  MessageId,
  OrchestratorMcpFailure,
  PROVIDER_DISPLAY_NAMES,
  type ModelSelection,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Run,
  type ProjectId,
  ThreadId,
  type ThreadPullRequestLink,
} from "@t3tools/contracts";
import {
  HOUSTON_TASK_LIMITS,
  HoustonTaskPlan,
  type HoustonTaskDetail,
  type HoustonTaskError,
  type HoustonTaskHandbackInput,
  type HoustonTaskPlanAnswerInput,
  type HoustonTaskPlanApproveInput,
  type HoustonTaskPlanStartInput,
  type HoustonTaskPlanSubmitInput,
  type HoustonTaskReviewFinding,
  type HoustonTaskReviewStartInput,
  type HoustonTaskReviewSubmitInput,
  type HoustonTaskRun,
  type HoustonTaskRunControlInput,
  type HoustonTaskRunState,
  type HoustonTaskSettings,
  type HoustonTaskStartInput,
  type HoustonTaskStartResult,
  houstonTaskKey,
} from "@t3tools/contracts/houston/tasks";
import { randomUuidV4 } from "@t3tools/provider-core/server/randomUuid";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";

import * as EventSink from "../../orchestration-v2/EventSink.ts";
import * as Orchestrator from "../../orchestration-v2/Orchestrator.ts";
import * as ProviderAdapterRegistry from "../../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ThreadLaunch from "../../orchestration-v2/ThreadLaunchService.ts";
import * as ProjectService from "../../project/ProjectService.ts";
import {
  HoustonReadOnlyThreads,
  hasReadOnlyRun,
  type HoustonTaskSubmitTool,
} from "../sideThreads.ts";
import {
  OPEN_RUN_STATES,
  buildBrief,
  checkAcceptance,
  checkDescription,
  checkFindings,
  conflictRefusal,
  formatFindings,
  limitRefusal,
  refuse,
  reviewTrigger,
  smallDiffReason,
  taskBranch,
  taskRunStateOf,
} from "./rules.ts";
import { fenceSlackRequest } from "../slack/rules.ts";
import * as TaskGit from "./TaskGit.ts";
import { HoustonTaskService, USER_ACTOR } from "./TaskService.ts";
import {
  HoustonTaskStore,
  PUSHED_ACTION,
  nowIso,
  parsePlan,
  toJsonText,
  toRun,
  toTask,
  type RunRow,
  type TaskRow,
} from "./TaskStore.ts";

/** The id of a run's brief message; one per run, so a retried launch cannot send it twice. */
export const briefMessageId = (runId: number) => MessageId.make(`task-run-${runId}`);

const RUN_ACTOR = "houston:run";
const REVIEW_ACTOR = "houston:review";
const LIVE_THREAD_RUN: ReadonlySet<OrchestrationV2Run["status"]> = new Set([
  "preparing",
  "queued",
  "starting",
  "running",
  "waiting",
]);

/** Whether a thread is recorded as a task's planner or reviewer. */
const readOnlyThreadsOf = (sql: SqlClient.SqlClient) => ({
  isReadOnly: Effect.fn("HoustonReadOnlyThreads.isReadOnly")(
    (threadId: ThreadId) =>
      sql<{ readonly one: number }>`
        SELECT 1 AS one FROM houston_task_planning WHERE thread_id = ${threadId}
        UNION ALL
        SELECT 1 AS one FROM houston_task_runs WHERE thread_id = ${threadId} AND kind = 'review'
        LIMIT 1
      `,
    Effect.map((rows) => rows.length > 0),
    // A thread whose record cannot be read is not given write access.
    Effect.orElseSucceed(() => true),
  ),
  submitToolOf: Effect.fn("HoustonReadOnlyThreads.submitToolOf")(
    (threadId: ThreadId) =>
      sql<{ readonly tool: HoustonTaskSubmitTool }>`
        SELECT 'houston_task_plan_submit' AS tool FROM houston_task_planning
        WHERE thread_id = ${threadId}
        UNION ALL
        SELECT 'houston_task_review_submit' AS tool FROM houston_task_runs
        WHERE thread_id = ${threadId} AND kind = 'review'
        LIMIT 1
      `,
    Effect.map((rows) => rows[0]?.tool),
    // A role that cannot be read is allowed no tool.
    Effect.orElseSucceed(() => undefined),
  ),
});

/** Planners and reviewers run read-only: the runtime policy and the MCP credential read it. */
export const layerReadOnlyThreads = Layer.effect(
  HoustonReadOnlyThreads,
  Effect.map(SqlClient.SqlClient, readOnlyThreadsOf),
);

export class HoustonTaskRuns extends Context.Service<
  HoustonTaskRuns,
  {
    readonly start: (
      input: HoustonTaskStartInput,
    ) => Effect.Effect<HoustonTaskStartResult, HoustonTaskError>;
    readonly runControl: (
      input: HoustonTaskRunControlInput,
    ) => Effect.Effect<HoustonTaskRun, HoustonTaskError>;
    readonly handback: (
      input: HoustonTaskHandbackInput,
      actor?: string,
    ) => Effect.Effect<HoustonTaskRun, HoustonTaskError>;
    readonly planStart: (
      input: HoustonTaskPlanStartInput,
    ) => Effect.Effect<HoustonTaskDetail, HoustonTaskError>;
    readonly planAnswer: (
      input: HoustonTaskPlanAnswerInput,
    ) => Effect.Effect<HoustonTaskDetail, HoustonTaskError>;
    readonly planApprove: (
      input: HoustonTaskPlanApproveInput,
    ) => Effect.Effect<HoustonTaskDetail, HoustonTaskError>;
    readonly reviewStart: (
      input: HoustonTaskReviewStartInput,
    ) => Effect.Effect<HoustonTaskDetail, HoustonTaskError>;
    /** From the recorded planner thread only. */
    readonly planSubmit: (
      caller: ThreadId,
      input: HoustonTaskPlanSubmitInput,
    ) => Effect.Effect<HoustonTaskDetail, HoustonTaskError>;
    /** From the recorded reviewer thread only. */
    readonly reviewSubmit: (
      caller: ThreadId,
      input: HoustonTaskReviewSubmitInput,
    ) => Effect.Effect<HoustonTaskDetail, HoustonTaskError>;
    /** The refusal of any agent write but its own submit from a planner or reviewer thread. */
    readonly agentWriteRefusal: (
      caller: ThreadId,
    ) => Effect.Effect<OrchestratorMcpFailure | undefined>;
    /** Applies every thread event stored since the last call. */
    readonly catchUp: Effect.Effect<void>;
  }
>()("houston/houston/tasks/TaskRuns/HoustonTaskRuns") {}

interface InitiativeRow {
  readonly id: number;
  readonly name: string;
  readonly tracker_description: string | null;
  readonly local_decisions: string;
  readonly revision: number;
}

interface PlanningRow {
  readonly thread_id: string;
  readonly task_id: number;
  readonly task_revision: number;
  readonly initiative_id: number | null;
  readonly initiative_revision: number | null;
  readonly state: "active" | "submitted" | "cancelled" | "exited";
}

const decodeDecisions = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Array(Schema.String)),
);
const encodePlan = Schema.encodeSync(Schema.fromJsonString(HoustonTaskPlan));
const decodeAttachments = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Array(ChatAttachment)),
);

const runningAfterUserStatus = (row: TaskRow) => row.status === "todo" || row.status === "backlog";

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const store = yield* HoustonTaskStore;
  const tasks = yield* HoustonTaskService;
  const projects = yield* ProjectService.ProjectService;
  const launcher = yield* ThreadLaunch.ThreadLaunchService;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const eventSink = yield* EventSink.EventSinkV2;
  const adapters = yield* ProviderAdapterRegistry.ProviderAdapterRegistryV2;
  const readOnlyThreads = readOnlyThreadsOf(sql);
  const fs = yield* FileSystem.FileSystem;

  const newThreadId = (prefix: string) =>
    Effect.map(randomUuidV4, (uuid) => ThreadId.make(`${prefix}-${uuid}`));

  const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.orDie(effect);
  const keyOf = (row: TaskRow) => houstonTaskKey(row.number);

  const runById = (id: number) =>
    run(sql<RunRow>`SELECT * FROM houston_task_runs WHERE id = ${id}`).pipe(
      Effect.map((rows) => rows[0]),
    );

  const taskOf = (taskId: number) =>
    store.taskById(taskId).pipe(
      Effect.filterOrElse(
        (row): row is TaskRow => row !== undefined,
        () => Effect.die(`task ${taskId} vanished`),
      ),
    );

  const detailOf = (taskId: number) => Effect.flatMap(taskOf(taskId), store.detail);

  const workspaceRoot = (operation: string, projectId: string) =>
    projects.getById(projectId as ProjectId).pipe(
      Effect.orDie,
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(refuse("invalid", operation, `project ${projectId} does not exist`)),
          onSome: (project) => Effect.succeed(project.workspaceRoot),
        }),
      ),
    );

  const settingsOf = (operation: string, projectId: string) =>
    tasks
      .getSettings({ projectId: projectId as ProjectId })
      .pipe(Effect.mapError((error) => refuse(error.kind, operation, error.message)));

  /** Refused by name unless the model's adapter declares a read-only run. */
  const requireReadOnlyRun = (operation: string, selection: ModelSelection, role: string) =>
    adapters.get(selection.instanceId).pipe(
      Effect.flatMap((adapter) =>
        adapter.getCapabilities().pipe(Effect.map((capabilities) => ({ adapter, capabilities }))),
      ),
      Effect.mapError(() =>
        refuse("invalid", operation, `provider instance ${selection.instanceId} is not configured`),
      ),
      Effect.flatMap(({ adapter, capabilities }) =>
        hasReadOnlyRun(capabilities)
          ? Effect.void
          : Effect.fail(
              refuse(
                "unsupported",
                operation,
                `${PROVIDER_DISPLAY_NAMES[adapter.driver] ?? adapter.driver} (${selection.instanceId}) cannot run read-only (capability read_only_run), so it cannot ${role}`,
              ),
            ),
      ),
    );

  const initiativeOf = (taskId: number) =>
    run(sql<InitiativeRow>`
      SELECT i.id, i.name, i.tracker_description, i.local_decisions, i.revision
      FROM houston_task_domain d JOIN houston_task_initiatives i ON i.id = d.initiative_id
      WHERE d.task_id = ${taskId}
    `).pipe(Effect.map((rows) => rows[0]));

  /** The Slack request a task was filed from, if any. */
  const slackRequestOf = (row: TaskRow) =>
    row.created_by.startsWith("slack:")
      ? run(sql<{
          readonly author: string;
          readonly channel_id: string;
          readonly attachments_json: string | null;
        }>`
          SELECT author, channel_id, attachments_json FROM houston_slack_requests
          WHERE task_id = ${row.id} ORDER BY id LIMIT 1
        `).pipe(Effect.map((rows) => Option.fromNullishOr(rows[0])))
      : Effect.succeedNone;

  /** A Slack request's images, attached to its run's brief message. */
  const slackImagesOf = (row: TaskRow) =>
    Effect.map(slackRequestOf(row), (request): ReadonlyArray<ChatAttachment> =>
      Option.isNone(request) || request.value.attachments_json === null
        ? []
        : Option.getOrElse(decodeAttachments(request.value.attachments_json), () => []),
    );

  const briefFor = Effect.fn("HoustonTaskRuns.briefFor")(function* (
    row: TaskRow,
    findings?: ReadonlyArray<HoustonTaskReviewFinding>,
  ) {
    const detail = yield* store.detail(row);
    const initiative = yield* initiativeOf(row.id);
    // A requester's words from Slack reach the agent only attributed and fenced.
    const slack = yield* slackRequestOf(row);
    return buildBrief({
      key: keyOf(row),
      title: row.title,
      description: Option.isNone(slack)
        ? row.description
        : fenceSlackRequest({
            author: slack.value.author,
            channel: slack.value.channel_id,
            text: row.description,
          }),
      acceptance: detail.acceptance.map((item) => item.text),
      links: row.ref_url === null ? [] : [row.ref_url],
      initiative:
        initiative === undefined
          ? null
          : {
              name: initiative.name,
              trackerDescription: initiative.tracker_description,
              localDecisions: decodeDecisions(initiative.local_decisions),
            },
      ...(findings === undefined ? {} : { findings }),
    });
  });

  const checkBrief = (operation: string, brief: string) => {
    const bytes = Buffer.byteLength(brief, "utf8");
    return bytes > HOUSTON_TASK_LIMITS.briefBytes
      ? Effect.fail(
          limitRefusal(operation, HOUSTON_TASK_LIMITS.briefBytes, bytes, "bytes in the brief"),
        )
      : Effect.void;
  };

  const liveImplementation = (taskId: number) =>
    run(sql<RunRow>`
      SELECT * FROM houston_task_runs
      WHERE task_id = ${taskId} AND kind = 'implementation'
        AND state IN ${sql.in([...OPEN_RUN_STATES])}
      ORDER BY id DESC
    `);

  const refuseBusy = (operation: string, row: TaskRow, live: ReadonlyArray<RunRow>) =>
    live.length >= HOUSTON_TASK_LIMITS.liveImplementationRuns
      ? Effect.fail(
          refuse(
            "busy",
            operation,
            `${keyOf(row)} already has ${live.length} live run(s) (limit ${HOUSTON_TASK_LIMITS.liveImplementationRuns}), held by thread ${live[0]?.thread_id ?? "none"}`,
            { limit: HOUSTON_TASK_LIMITS.liveImplementationRuns, actual: live.length },
          ),
        )
      : Effect.void;

  const nextAttempt = (taskId: number, kind: HoustonTaskRun["kind"]) =>
    run(sql<{ readonly n: number | null }>`
      SELECT MAX(attempt) AS n FROM houston_task_runs WHERE task_id = ${taskId} AND kind = ${kind}
    `).pipe(Effect.map((rows) => (rows[0]?.n ?? 0) + 1));

  const insertRun = (input: {
    readonly taskId: number;
    readonly attempt: number;
    readonly kind: HoustonTaskRun["kind"];
    readonly state: HoustonTaskRunState;
    readonly provider: string;
    readonly reviewer: string | null;
    readonly threadId: string | null;
    readonly worktreePath: string | null;
    readonly branch: string | null;
    readonly baseCommit: string | null;
    readonly initialRevision: number;
    readonly reviewHeadSha?: string;
    readonly reviewFocus?: string;
  }) =>
    Effect.flatMap(nowIso, (now) =>
      run(sql<RunRow>`
        INSERT INTO houston_task_runs (
          task_id, attempt, kind, state, provider, reviewer, thread_id, worktree_path, branch,
          base_commit, initial_revision, started_at, review_head_sha, review_focus
        ) VALUES (
          ${input.taskId}, ${input.attempt}, ${input.kind}, ${input.state}, ${input.provider},
          ${input.reviewer}, ${input.threadId}, ${input.worktreePath}, ${input.branch},
          ${input.baseCommit}, ${input.initialRevision}, ${now}, ${input.reviewHeadSha ?? null},
          ${input.reviewFocus ?? null}
        ) RETURNING *
      `),
    ).pipe(Effect.map((rows) => rows[0] as RunRow));

  const setRunState = (
    runId: number,
    state: HoustonTaskRunState,
    reason: string | null,
    extra: { readonly summary?: string } = {},
  ) =>
    Effect.flatMap(nowIso, (now) =>
      run(sql<RunRow>`
        UPDATE houston_task_runs SET state = ${state}, reason = ${reason},
          ended_at = ${OPEN_RUN_STATES.has(state) ? null : now},
          summary = COALESCE(${extra.summary ?? null}, summary)
        WHERE id = ${runId} RETURNING *
      `),
    ).pipe(Effect.map((rows) => rows[0] as RunRow));

  /** Moves the task's status as `actor`, with one history row; returns the touched ids. */
  const moveTask = Effect.fn("HoustonTaskRuns.moveTask")(function* (
    row: TaskRow,
    status: TaskRow["status"],
    actor: string,
    action: string,
    extra: object = {},
  ) {
    const now = yield* nowIso;
    yield* run(sql`
      UPDATE houston_tasks SET status = ${status}, revision = revision + 1, updated_at = ${now}
      WHERE id = ${row.id}
    `);
    yield* store.recordHistory(row.id, actor, action, {
      status: { old: row.status, new: status },
      ...extra,
    });
    const rolled = yield* store.rollup(row.id);
    return [row.id, ...(rolled === undefined ? [] : [rolled])];
  });

  const addComment = (taskId: number, body: string, author: string) =>
    Effect.flatMap(nowIso, (now) =>
      run(sql`
        INSERT INTO houston_task_comments (task_id, body, author, created_at)
        VALUES (${taskId}, ${body.slice(0, HOUSTON_TASK_LIMITS.commentBytes)}, ${author}, ${now})
      `),
    );

  const launchFailure =
    (operation: string, row: TaskRow) => (error: { readonly message: string }) =>
      refuse(
        "invalid",
        operation,
        `the thread for ${keyOf(row)} could not launch: ${error.message}`,
      );

  /** Launches a run's thread; on failure the run is recorded failed with the launcher's reason. */
  const launchRun = Effect.fn("HoustonTaskRuns.launchRun")(function* (
    operation: string,
    row: TaskRow,
    runRow: RunRow,
    input: {
      readonly title: string;
      readonly modelSelection: ModelSelection;
      readonly workspaceStrategy: ThreadLaunch.ThreadLaunchWorkspaceStrategy;
      readonly message: string | null;
      readonly attachments?: ReadonlyArray<ChatAttachment>;
    },
  ) {
    const launched = yield* launcher
      .launch({
        commandId: CommandId.make(`houston-task-run:${runRow.id}`),
        threadId: runRow.thread_id as ThreadId,
        projectId: row.project_id as ProjectId,
        title: input.title,
        modelSelection: input.modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        workspaceStrategy: input.workspaceStrategy,
        ...(input.message === null
          ? {}
          : {
              initialMessage: {
                messageId: briefMessageId(runRow.id),
                text: input.message,
                attachments: input.attachments ?? [],
              },
            }),
        createdBy: "user",
        creationSource: "server",
      })
      .pipe(
        Effect.tapError((error) =>
          store.write(
            setRunState(runRow.id, "failed", error.message).pipe(
              Effect.map(() => ({ result: undefined, touched: [row.id] })),
            ),
          ),
        ),
        Effect.mapError(launchFailure(operation, row)),
      );
    const threadRun = launched.projection.runs.at(-1);
    if (threadRun !== undefined) {
      yield* store.write(
        run(
          sql`UPDATE houston_task_runs SET run_id = ${threadRun.id} WHERE id = ${runRow.id}`,
        ).pipe(Effect.as({ result: undefined, touched: [row.id] })),
      );
    }
    return (yield* runById(runRow.id)) as RunRow;
  });

  const start: HoustonTaskRuns["Service"]["start"] = Effect.fn("HoustonTaskRuns.start")(
    function* (input) {
      const operation = "houston.tasks.start";
      let row = yield* store.resolve(operation, input.id);
      yield* refuseBusy(operation, row, yield* liveImplementation(row.id));
      const brief = yield* briefFor(row);
      yield* checkBrief(operation, brief);
      if (row.project_id === null) {
        if (input.projectId === undefined) {
          return yield* refuse(
            "invalid",
            operation,
            `${keyOf(row)} has no project; a project is required to start it`,
          );
        }
        yield* tasks
          .save({
            id: keyOf(row),
            expectedRevision: row.revision,
            patch: { projectId: input.projectId },
          })
          .pipe(Effect.mapError((error) => refuse(error.kind, operation, error.message)));
        row = yield* taskOf(row.id);
      } else if (input.projectId !== undefined && input.projectId !== row.project_id) {
        return yield* refuse(
          "invalid",
          operation,
          `${keyOf(row)} belongs to project ${row.project_id}, not ${input.projectId}`,
        );
      }
      const projectId = row.project_id as string;
      const readiness = (yield* store.domain(row)).readiness;
      if (!readiness.ready && input.overrideReadiness !== true) {
        return yield* refuse(
          "unready",
          operation,
          `${keyOf(row)} is not ready: ${readiness.reasons.join("; ")}`,
        );
      }
      const settings = yield* settingsOf(operation, projectId);
      const root = yield* workspaceRoot(operation, projectId);
      const baseRef = input.baseRef ?? (yield* TaskGit.currentBranch(root)) ?? "HEAD";
      const baseCommit = yield* TaskGit.resolveCommit(root, baseRef);
      if (baseCommit === null) {
        return yield* refuse(
          "invalid",
          operation,
          `base ref "${baseRef}" does not name a commit in ${root}`,
        );
      }
      const modelSelection = input.modelSelection ?? settings.startModel;
      const send = settings.delivery === "send";
      const branch = taskBranch(row.number, row.title);
      const recorded = yield* store.write(
        Effect.gen(function* () {
          const current = yield* taskOf(row.id);
          yield* refuseBusy(operation, current, yield* liveImplementation(current.id));
          const touched =
            send && current.status !== "in_progress"
              ? yield* moveTask(current, "in_progress", USER_ACTOR, "houston:start", { branch })
              : (yield* store.recordHistory(current.id, USER_ACTOR, "houston:start", { branch }),
                [current.id]);
          const after = yield* taskOf(current.id);
          const runRow = yield* insertRun({
            taskId: current.id,
            attempt: yield* nextAttempt(current.id, "implementation"),
            kind: "implementation",
            state: send ? "preparing" : "waiting_for_input",
            provider: modelSelection.instanceId,
            reviewer: settings.reviewer?.instanceId ?? null,
            threadId: yield* newThreadId("task"),
            worktreePath: null,
            branch,
            baseCommit,
            initialRevision: after.revision,
          });
          return { result: runRow, touched };
        }),
      );
      const launched = yield* launchRun(operation, row, recorded, {
        title: `${keyOf(row)} ${row.title}`,
        modelSelection,
        workspaceStrategy: { type: "worktree", baseRef, branch },
        message: send ? brief : null,
        attachments: yield* slackImagesOf(row),
      });
      return { run: toRun(launched), ...(send ? {} : { brief }) };
    },
  );

  const newestFailedFindings = (taskId: number) =>
    run(sql<{ readonly review_findings: string | null }>`
      SELECT review_findings FROM houston_task_runs
      WHERE task_id = ${taskId} AND kind = 'review' AND review_verdict = 'fail'
      ORDER BY id DESC LIMIT 1
    `).pipe(
      Effect.map((rows) => {
        const raw = rows[0]?.review_findings;
        return raw === undefined || raw === null
          ? []
          : (JSON.parse(raw) as ReadonlyArray<HoustonTaskReviewFinding>);
      }),
    );

  /** Attempt N+1 of `previous` in its worktree, recreated if it was removed. */
  const nextAttemptOf = Effect.fn("HoustonTaskRuns.nextAttemptOf")(function* (
    operation: string,
    previous: RunRow,
    options: { readonly withFindings: boolean; readonly actor: string; readonly action: string },
  ) {
    const row = yield* taskOf(previous.task_id);
    if (OPEN_RUN_STATES.has(previous.state)) {
      return yield* refuse("invalid", operation, `run ${previous.id} is still ${previous.state}`);
    }
    if (
      previous.kind !== "implementation" ||
      previous.worktree_path === null ||
      previous.branch === null
    ) {
      return yield* refuse(
        "invalid",
        operation,
        `run ${previous.id} has no worktree to continue in`,
      );
    }
    if (row.project_id === null) {
      return yield* refuse("invalid", operation, `${keyOf(row)} has no project`);
    }
    yield* refuseBusy(operation, row, yield* liveImplementation(row.id));
    const brief = yield* briefFor(
      row,
      options.withFindings ? yield* newestFailedFindings(row.id) : undefined,
    );
    yield* checkBrief(operation, brief);
    const settings = yield* settingsOf(operation, row.project_id);
    const root = yield* workspaceRoot(operation, row.project_id);
    const attempt = yield* nextAttempt(row.id, "implementation");
    let branch = previous.branch;
    let baseCommit = previous.base_commit;
    if (!(yield* fs.exists(previous.worktree_path).pipe(Effect.orElseSucceed(() => false)))) {
      const base = (yield* TaskGit.currentBranch(root)) ?? "HEAD";
      branch = yield* TaskGit.recreateWorktree({
        repo: root,
        path: previous.worktree_path,
        branch: previous.branch,
        base,
        freshBranch: `${previous.branch}-${attempt}`,
      }).pipe(
        Effect.mapError((error) =>
          refuse(
            "invalid",
            operation,
            `the worktree of run ${previous.id} could not be recreated: ${error.message}`,
          ),
        ),
      );
      if (branch !== previous.branch) baseCommit = yield* TaskGit.resolveCommit(root, base);
    }
    const recorded = yield* store.write(
      Effect.gen(function* () {
        const current = yield* taskOf(row.id);
        const touched =
          current.status !== "in_progress"
            ? yield* moveTask(current, "in_progress", options.actor, options.action, {
                run: previous.id,
              })
            : (yield* store.recordHistory(current.id, options.actor, options.action, {
                run: previous.id,
              }),
              [current.id]);
        const after = yield* taskOf(current.id);
        const runRow = yield* insertRun({
          taskId: current.id,
          attempt,
          kind: "implementation",
          state: "preparing",
          provider: previous.provider,
          reviewer: settings.reviewer?.instanceId ?? null,
          threadId: yield* newThreadId("task"),
          worktreePath: previous.worktree_path,
          branch,
          baseCommit,
          initialRevision: after.revision,
        });
        return { result: runRow, touched };
      }),
    );
    const modelSelection =
      previous.provider === settings.startModel.instanceId
        ? settings.startModel
        : { ...settings.startModel, instanceId: previous.provider as ModelSelection["instanceId"] };
    return yield* launchRun(operation, row, recorded, {
      title: `${keyOf(row)} ${row.title} (attempt ${attempt})`,
      modelSelection,
      workspaceStrategy: {
        type: "existing_worktree",
        worktreePath: previous.worktree_path,
        branch,
      },
      message: brief,
    });
  });

  const runControl: HoustonTaskRuns["Service"]["runControl"] = Effect.fn(
    "HoustonTaskRuns.runControl",
  )(function* (input) {
    const operation = "houston.tasks.runControl";
    const previous = yield* runById(input.runId);
    if (previous === undefined) {
      return yield* refuse("not_found", operation, `no task run ${input.runId}`);
    }
    if (input.action === "stop") {
      if (!OPEN_RUN_STATES.has(previous.state)) {
        return yield* refuse(
          "invalid",
          operation,
          `run ${previous.id} is ${previous.state}, not live`,
        );
      }
      // Cancelled first, so the thread's stopped run is not read as an interruption.
      const stopped = yield* store.write(
        setRunState(previous.id, "cancelled", "stopped").pipe(
          Effect.map((result) => ({ result, touched: [previous.task_id] })),
        ),
      );
      if (previous.thread_id !== null) {
        yield* orchestrator
          .dispatch({
            type: "thread.stop",
            commandId: CommandId.make(`houston-task-run:${previous.id}:stop`),
            threadId: previous.thread_id as ThreadId,
            reason: "Houston task run stopped",
          })
          .pipe(Effect.ignore);
      }
      return toRun(stopped);
    }
    const next = yield* nextAttemptOf(operation, previous, {
      withFindings: input.action === "retry",
      actor: USER_ACTOR,
      action: `houston:${input.action}`,
    });
    return toRun(next);
  });

  const handback: HoustonTaskRuns["Service"]["handback"] = Effect.fn("HoustonTaskRuns.handback")(
    function* (input, actor = USER_ACTOR) {
      const operation = "houston.tasks.handback";
      const row = yield* store.resolve(operation, input.id);
      if (input.summary.trim().length === 0) {
        return yield* refuse("invalid", operation, "a handback needs a summary");
      }
      const [open] = yield* liveImplementation(row.id);
      if (open === undefined) {
        return yield* refuse("invalid", operation, `${keyOf(row)} has no live run to hand back`);
      }
      const handed = yield* store.write(
        Effect.gen(function* () {
          const current = yield* taskOf(row.id);
          const drift =
            current.revision > open.initial_revision
              ? `\n\nWarning: ${keyOf(current)} changed since this run started (revision ${open.initial_revision} to ${current.revision}); check the work against the current task.`
              : "";
          const result = yield* setRunState(open.id, "handed_back", null, {
            summary: input.summary,
          });
          yield* addComment(row.id, `${input.summary}${drift}`, actor);
          const touched = yield* moveTask(current, "in_review", actor, "houston:handback", {
            run: open.id,
          });
          return { result, touched };
        }),
      );
      if (row.project_id !== null) {
        const settings = yield* settingsOf(operation, row.project_id);
        if (
          settings.reviewer !== null &&
          reviewTrigger({
            mode: settings.reviewMode,
            event: { type: "handback" },
            reviewOpen: false,
            reviewedHeads: [],
          })
        ) {
          yield* startReview(operation, handed, { automatic: true, settings }).pipe(
            Effect.catch((error) =>
              noteOnce(
                row.id,
                `handback:${open.id}`,
                `Automatic review not started: ${error.message}`,
              ),
            ),
          );
        }
      }
      return toRun((yield* runById(open.id)) as RunRow);
    },
  );

  /** A comment written once per key, so a repeated trigger does not repeat the note. */
  const noteOnce = (taskId: number, key: string, body: string) =>
    store.write(
      Effect.gen(function* () {
        const [seen] = yield* run(sql<{ readonly one: number }>`
          SELECT 1 AS one FROM houston_task_history
          WHERE task_id = ${taskId} AND action = 'houston:review-note' AND changes = ${toJsonText({ key })}
        `);
        if (seen !== undefined) return { result: undefined, touched: [] };
        yield* addComment(taskId, body, REVIEW_ACTOR);
        yield* store.recordHistory(taskId, REVIEW_ACTOR, "houston:review-note", { key });
        return { result: undefined, touched: [taskId] };
      }),
    );

  const startReview = Effect.fn("HoustonTaskRuns.startReview")(function* (
    operation: string,
    implementation: RunRow,
    options: {
      readonly automatic: boolean;
      readonly settings: HoustonTaskSettings;
      readonly model?: ModelSelection;
      readonly pushedHead?: string;
    },
  ) {
    const row = yield* taskOf(implementation.task_id);
    const reviewer = options.model ?? options.settings.reviewer;
    if (reviewer === null) {
      return yield* refuse(
        "invalid",
        operation,
        `no reviewer is set for ${keyOf(row)}'s project; name a model or set Settings ▸ Tasks ▸ Reviewer`,
      );
    }
    yield* requireReadOnlyRun(operation, reviewer, "review a task");
    const worktree = implementation.worktree_path;
    if (worktree === null || row.project_id === null) {
      return yield* refuse(
        "invalid",
        operation,
        `run ${implementation.id} has no worktree to review`,
      );
    }
    const root = yield* workspaceRoot(operation, row.project_id);
    const head =
      options.pushedHead === undefined
        ? yield* TaskGit.resolveCommit(worktree, "HEAD")
        : yield* TaskGit.resolveCommit(root, options.pushedHead);
    if (head === null) {
      return yield* refuse(
        "invalid",
        operation,
        `the head ${options.pushedHead ?? "HEAD"} is not in the local repository at ${root}; fetch it before the review can start`,
      );
    }
    const [attempts] = yield* run(sql<{ readonly n: number }>`
      SELECT COUNT(*) AS n FROM houston_task_runs
      WHERE task_id = ${row.id} AND kind = 'review' AND review_head_sha = ${head}
    `);
    const used = attempts?.n ?? 0;
    if (used >= HOUSTON_TASK_LIMITS.reviewAttemptsPerHead) {
      return yield* refuse(
        "limit",
        operation,
        `${keyOf(row)} already has ${used} review attempt(s) for head ${head}; the limit is ${HOUSTON_TASK_LIMITS.reviewAttemptsPerHead} per head`,
        { limit: HOUSTON_TASK_LIMITS.reviewAttemptsPerHead, actual: used + 1 },
      );
    }
    const base = implementation.base_commit;
    const skipped =
      options.automatic && base !== null
        ? smallDiffReason(yield* TaskGit.diffSize(root, base, head).pipe(Effect.orDie))
        : null;
    const attempt = yield* nextAttempt(row.id, "review");
    if (skipped !== null) {
      yield* store.write(
        Effect.gen(function* () {
          const review = yield* insertRun({
            taskId: row.id,
            attempt,
            kind: "review",
            state: "handed_back",
            provider: reviewer.instanceId,
            reviewer: reviewer.instanceId,
            threadId: null,
            worktreePath: null,
            branch: implementation.branch,
            baseCommit: base,
            initialRevision: row.revision,
            reviewHeadSha: head,
            reviewFocus: options.settings.focus,
          });
          const now = yield* nowIso;
          yield* run(sql`
            UPDATE houston_task_runs SET review_verdict = 'skipped', review_findings = '[]',
              review_skipped_reason = ${skipped}, summary = ${`Review skipped: ${skipped}`},
              ended_at = ${now}
            WHERE id = ${review.id}
          `);
          yield* addComment(row.id, `Review skipped: ${skipped}`, REVIEW_ACTOR);
          return { result: undefined, touched: [row.id] };
        }),
      );
      return yield* detailOf(row.id);
    }
    const reuse =
      options.pushedHead === undefined &&
      (yield* TaskGit.isClean(worktree).pipe(Effect.orElseSucceed(() => false)));
    const threadId = yield* newThreadId("task-review");
    const recorded = yield* store.write(
      Effect.gen(function* () {
        const review = yield* insertRun({
          taskId: row.id,
          attempt,
          kind: "review",
          state: "preparing",
          provider: reviewer.instanceId,
          reviewer: reviewer.instanceId,
          threadId,
          worktreePath: reuse ? worktree : `${worktree}-review-${attempt}`,
          branch: implementation.branch,
          baseCommit: base,
          initialRevision: row.revision,
          reviewHeadSha: head,
          reviewFocus: options.settings.focus,
        });
        yield* store.recordHistory(row.id, REVIEW_ACTOR, "houston:review-start", {
          run: review.id,
          headSha: head,
        });
        return { result: review, touched: [row.id] };
      }),
    );
    const reviewTree = recorded.worktree_path as string;
    if (!reuse) {
      yield* TaskGit.addDetachedWorktree(root, reviewTree, head).pipe(
        Effect.tapError((error) =>
          store.write(
            setRunState(recorded.id, "failed", error.message).pipe(
              Effect.as({ result: undefined, touched: [row.id] }),
            ),
          ),
        ),
        Effect.mapError((error) =>
          refuse("invalid", operation, `the review tree could not be created: ${error.message}`),
        ),
      );
    }
    const prompt = [
      `Review Houston task ${keyOf(row)}, the changes from ${base ?? "the base"} to ${head} (focus: ${options.settings.focus}). Do not change any files.`,
      `When done, call houston_task_review_submit with runId ${recorded.id}, a verdict of pass or fail, and findings (path, line, severity, category, message).`,
      yield* briefFor(row),
    ].join("\n\n");
    yield* launchRun(operation, row, recorded, {
      title: `Review ${keyOf(row)} ${row.title}`,
      modelSelection: reviewer,
      workspaceStrategy: {
        type: "existing_worktree",
        worktreePath: reviewTree,
        ...(reuse && implementation.branch !== null ? { branch: implementation.branch } : {}),
      },
      message: prompt,
    });
    return yield* detailOf(row.id);
  });

  const reviewStart: HoustonTaskRuns["Service"]["reviewStart"] = Effect.fn(
    "HoustonTaskRuns.reviewStart",
  )(function* (input) {
    const operation = "houston.tasks.review.start";
    const implementation = yield* runById(input.runId);
    if (implementation === undefined || implementation.kind !== "implementation") {
      return yield* refuse("not_found", operation, `no implementation run ${input.runId}`);
    }
    const row = yield* taskOf(implementation.task_id);
    if (row.project_id === null) {
      return yield* refuse("invalid", operation, `${keyOf(row)} has no project`);
    }
    return yield* startReview(operation, implementation, {
      automatic: false,
      settings: yield* settingsOf(operation, row.project_id),
      ...(input.modelSelection === undefined ? {} : { model: input.modelSelection }),
    });
  });

  /** Rework rounds already taken since a person last started, resumed or retried the task. */
  const reworkRoundsTaken = (taskId: number) =>
    run(sql<{ readonly n: number }>`
      SELECT COUNT(*) AS n FROM houston_task_history
      WHERE task_id = ${taskId} AND action = 'houston:rework' AND id > COALESCE((
        SELECT MAX(id) FROM houston_task_history
        WHERE task_id = ${taskId} AND actor = ${USER_ACTOR}
          AND action IN ('houston:start', 'houston:resume', 'houston:retry')
      ), 0)
    `).pipe(Effect.map((rows) => rows[0]?.n ?? 0));

  const reviewSubmit: HoustonTaskRuns["Service"]["reviewSubmit"] = Effect.fn(
    "HoustonTaskRuns.reviewSubmit",
  )(function* (caller, input) {
    const operation = "houston_task_review_submit";
    const review = yield* runById(input.runId);
    if (
      review === undefined ||
      review.kind !== "review" ||
      review.thread_id !== caller ||
      review.review_verdict !== null
    ) {
      return yield* refuse(
        "invalid",
        operation,
        `no recorded review session for run ${input.runId} in thread ${caller}`,
      );
    }
    const checked = checkFindings(operation, input.findings);
    if (!Array.isArray(checked)) return yield* checked as HoustonTaskError;
    const findings = checked as ReadonlyArray<HoustonTaskReviewFinding>;
    const reviewer = `agent:${caller}`;
    const implementation = yield* store.write(
      Effect.gen(function* () {
        const now = yield* nowIso;
        yield* run(sql`
          UPDATE houston_task_runs SET review_verdict = ${input.verdict},
            review_findings = ${toJsonText(findings)}, state = 'handed_back', ended_at = ${now},
            summary = ${`Review ${input.verdict}: ${findings.length} finding(s)`}
          WHERE id = ${review.id}
        `);
        const [reviewed] = yield* run(sql<RunRow>`
          SELECT * FROM houston_task_runs
          WHERE task_id = ${review.task_id} AND kind = 'implementation' AND id < ${review.id}
          ORDER BY id DESC LIMIT 1
        `);
        if (input.verdict === "fail") {
          yield* addComment(
            review.task_id,
            `Review failed at ${review.review_head_sha ?? "an unknown head"}:\n${formatFindings(findings)}`,
            reviewer,
          );
          if (reviewed !== undefined && reviewed.state === "handed_back") {
            yield* setRunState(reviewed.id, "needs_review", "the review failed");
          }
        }
        yield* store.recordHistory(review.task_id, reviewer, "houston:review-submit", {
          run: review.id,
          verdict: input.verdict,
          findings: findings.length,
        });
        return { result: reviewed, touched: [review.task_id] };
      }),
    );
    // A submit after the reviewer's turn ended frees the tree now; otherwise when the turn ends.
    yield* releaseReviewTree((yield* runById(review.id)) as RunRow);
    const row = yield* taskOf(review.task_id);
    if (input.verdict === "fail" && implementation !== undefined && row.project_id !== null) {
      const settings = yield* settingsOf(operation, row.project_id);
      const taken = yield* reworkRoundsTaken(row.id);
      if (settings.reworkRounds > 0 && taken < settings.reworkRounds) {
        yield* nextAttemptOf(operation, (yield* runById(implementation.id)) as RunRow, {
          withFindings: true,
          actor: REVIEW_ACTOR,
          action: "houston:rework",
        }).pipe(
          Effect.catch((error) =>
            noteOnce(
              row.id,
              `rework:${review.id}`,
              `Automatic rework not started: ${error.message}`,
            ),
          ),
        );
      } else if (settings.reworkRounds === 0 && implementation.thread_id !== null) {
        // Information only: queued behind nothing, it waits for the user and changes no branch.
        yield* orchestrator
          .dispatch({
            type: "message.dispatch",
            commandId: CommandId.make(`houston-task-review:${review.id}:findings`),
            threadId: implementation.thread_id as ThreadId,
            messageId: MessageId.make(`task-review-${review.id}`),
            text: `Review findings for ${keyOf(row)} (information only; no rework was started):\n${formatFindings(findings)}`,
            attachments: [],
            dispatchMode: { type: "queue_after_active" },
            createdBy: "user",
            creationSource: "server",
          })
          .pipe(Effect.ignore);
      }
    }
    return yield* detailOf(review.task_id);
  });

  const planningRow = (threadId: string) =>
    run(sql<PlanningRow>`SELECT * FROM houston_task_planning WHERE thread_id = ${threadId}`).pipe(
      Effect.map((rows) => rows[0]),
    );

  const planStart: HoustonTaskRuns["Service"]["planStart"] = Effect.fn("HoustonTaskRuns.planStart")(
    function* (input) {
      const operation = "houston.tasks.plan.start";
      const row = yield* store.resolve(operation, input.id);
      if (row.revision !== input.expectedRevision) {
        return yield* conflictRefusal(operation, keyOf(row), input.expectedRevision, row.revision);
      }
      if (row.project_id === null) {
        return yield* refuse(
          "invalid",
          operation,
          `${keyOf(row)} has no project; a project is required to plan it`,
        );
      }
      yield* requireReadOnlyRun(operation, input.modelSelection, "plan a task");
      const domain = yield* store.domainRow(row.id);
      if (domain === undefined) {
        return yield* refuse(
          "invalid",
          operation,
          `${keyOf(row)} has no kind; set delivery or slice with houston.tasks.domain.save before planning`,
        );
      }
      if (domain.planning_thread_id !== null) {
        return yield* refuse(
          "busy",
          operation,
          `${keyOf(row)} already has an open planning session in thread ${domain.planning_thread_id}`,
        );
      }
      const initiative = yield* initiativeOf(row.id);
      const threadId = yield* newThreadId("task-plan");
      // Recorded before launch, so its first turn already resolves read-only.
      yield* store.write(
        Effect.gen(function* () {
          const now = yield* nowIso;
          yield* run(sql`
          INSERT INTO houston_task_planning (
            thread_id, task_id, task_revision, initiative_id, initiative_revision, state, created_at
          ) VALUES (
            ${threadId}, ${row.id}, ${row.revision}, ${initiative?.id ?? null},
            ${initiative?.revision ?? null}, 'active', ${now}
          )
        `);
          yield* run(sql`
          UPDATE houston_task_domain SET planning_thread_id = ${threadId},
            planning_task_revision = ${row.revision}, planning_initiative_id = ${initiative?.id ?? null},
            planning_initiative_revision = ${initiative?.revision ?? null}
          WHERE task_id = ${row.id}
        `);
          yield* store.recordHistory(row.id, USER_ACTOR, "houston:plan-start", {
            thread: threadId,
          });
          return { result: undefined, touched: [row.id] };
        }),
      );
      const prompt = [
        `Plan Houston task ${keyOf(row)}. Read the code you need; do not change any files.`,
        `When done, call houston_task_plan_submit with id "${keyOf(row)}" and a proposal: description, acceptance (a list of checkable items), pointers (files or docs), outOfScope and questions (only those the user must answer).`,
        yield* briefFor(row),
      ].join("\n\n");
      yield* launcher
        .launch({
          commandId: CommandId.make(`houston-task-plan:${threadId}`),
          threadId,
          projectId: row.project_id as ProjectId,
          title: `Plan ${keyOf(row)} ${row.title}`,
          modelSelection: input.modelSelection,
          runtimeMode: "approval-required",
          interactionMode: "default",
          workspaceStrategy: { type: "root" },
          initialMessage: { text: prompt, attachments: [] },
          createdBy: "user",
          creationSource: "server",
        })
        .pipe(
          Effect.tapError(() => settlePlanning(threadId, "cancelled")),
          Effect.mapError(launchFailure(operation, row)),
        );
      return yield* detailOf(row.id);
    },
  );

  const settlePlanning = (threadId: string, state: "submitted" | "cancelled" | "exited") =>
    store.write(
      Effect.gen(function* () {
        const planning = yield* planningRow(threadId);
        if (planning === undefined || planning.state !== "active") {
          return { result: undefined, touched: [] };
        }
        yield* run(
          sql`UPDATE houston_task_planning SET state = ${state} WHERE thread_id = ${threadId}`,
        );
        yield* run(sql`
          UPDATE houston_task_domain SET planning_thread_id = NULL
          WHERE task_id = ${planning.task_id} AND planning_thread_id = ${threadId}
        `);
        return { result: undefined, touched: [planning.task_id] };
      }),
    );

  const writePlan = (
    taskId: number,
    plan: HoustonTaskPlan,
    extra: { readonly approvedTaskRevision?: number } = {},
  ) =>
    run(sql`
      UPDATE houston_task_domain SET plan_json = ${encodePlan(plan)}, plan_revision = ${plan.revision},
        approved_task_revision = ${extra.approvedTaskRevision ?? null}
      WHERE task_id = ${taskId}
    `);

  const planSubmit: HoustonTaskRuns["Service"]["planSubmit"] = Effect.fn(
    "HoustonTaskRuns.planSubmit",
  )(function* (caller, input) {
    const operation = "houston_task_plan_submit";
    const row = yield* store.resolve(operation, input.id);
    const domain = yield* store.domainRow(row.id);
    const planning = yield* planningRow(caller);
    if (
      domain === undefined ||
      domain.planning_thread_id !== caller ||
      planning === undefined ||
      planning.task_id !== row.id ||
      planning.state !== "active"
    ) {
      return yield* refuse(
        "invalid",
        operation,
        `no recorded planning session for ${keyOf(row)} in thread ${caller}`,
      );
    }
    const description = input.proposal.description;
    const descriptionRefusal = checkDescription(operation, description);
    if (descriptionRefusal !== undefined) return yield* descriptionRefusal;
    const acceptance = checkAcceptance(operation, input.proposal.acceptance);
    if (!Array.isArray(acceptance)) return yield* acceptance as HoustonTaskError;
    yield* store.write(
      Effect.gen(function* () {
        const previous = parsePlan(domain.plan_json);
        const plan: HoustonTaskPlan = {
          revision: (previous?.revision ?? 0) + 1,
          proposal: { ...input.proposal, acceptance: acceptance as ReadonlyArray<string> },
          answers: [],
          approvedRevision: null,
        };
        yield* writePlan(row.id, plan);
        yield* run(sql`
          UPDATE houston_task_domain SET plan_initiative_id = ${planning.initiative_id},
            plan_initiative_revision = ${planning.initiative_revision}, planning_thread_id = NULL
          WHERE task_id = ${row.id}
        `);
        yield* run(
          sql`UPDATE houston_task_planning SET state = 'submitted' WHERE thread_id = ${caller}`,
        );
        yield* store.recordHistory(row.id, `agent:${caller}`, "houston:plan-submit", {
          planRevision: plan.revision,
        });
        return { result: undefined, touched: [row.id] };
      }),
    );
    return yield* detailOf(row.id);
  });

  const planAnswer: HoustonTaskRuns["Service"]["planAnswer"] = Effect.fn(
    "HoustonTaskRuns.planAnswer",
  )(function* (input) {
    const operation = "houston.tasks.plan.answer";
    const row = yield* store.resolve(operation, input.id);
    if (row.revision !== input.expectedRevision) {
      return yield* conflictRefusal(operation, keyOf(row), input.expectedRevision, row.revision);
    }
    const domain = yield* store.domainRow(row.id);
    const plan = parsePlan(domain?.plan_json ?? null);
    if (plan === null || !plan.proposal.questions.includes(input.question)) {
      return yield* refuse(
        "invalid",
        operation,
        `${keyOf(row)}'s plan asks no question "${input.question}"`,
      );
    }
    yield* store.write(
      Effect.gen(function* () {
        yield* writePlan(row.id, {
          ...plan,
          answers: [
            ...plan.answers.filter((answer) => answer.question !== input.question),
            { question: input.question, answer: input.answer },
          ],
        });
        yield* store.recordHistory(row.id, USER_ACTOR, "houston:plan-answer", {
          question: input.question,
        });
        return { result: undefined, touched: [row.id] };
      }),
    );
    return yield* detailOf(row.id);
  });

  const planApprove: HoustonTaskRuns["Service"]["planApprove"] = Effect.fn(
    "HoustonTaskRuns.planApprove",
  )(function* (input) {
    const operation = "houston.tasks.plan.approve";
    const row = yield* store.resolve(operation, input.id);
    const key = keyOf(row);
    if (row.revision !== input.expectedRevision) {
      return yield* conflictRefusal(operation, key, input.expectedRevision, row.revision);
    }
    const domain = yield* store.domainRow(row.id);
    const plan = parsePlan(domain?.plan_json ?? null);
    if (plan === null || plan.revision !== input.planRevision) {
      return yield* conflictRefusal(
        operation,
        `${key}'s plan`,
        input.planRevision,
        plan?.revision ?? 0,
      );
    }
    const [read] = yield* run(sql<PlanningRow>`
      SELECT * FROM houston_task_planning WHERE task_id = ${row.id} AND state = 'submitted'
      ORDER BY created_at DESC, rowid DESC LIMIT 1
    `);
    if (read !== undefined && read.task_revision !== row.revision) {
      return yield* conflictRefusal(
        operation,
        `${key} (as its planner read it)`,
        read.task_revision,
        row.revision,
      );
    }
    const bound = yield* run(sql<{
      readonly plan_initiative_id: number | null;
      readonly plan_initiative_revision: number | null;
    }>`
      SELECT plan_initiative_id, plan_initiative_revision FROM houston_task_domain WHERE task_id = ${row.id}
    `).pipe(Effect.map((rows) => rows[0]));
    if (bound?.plan_initiative_id != null) {
      const [initiative] = yield* run(sql<{ readonly revision: number }>`
        SELECT revision FROM houston_task_initiatives WHERE id = ${bound.plan_initiative_id}
      `);
      if (initiative?.revision !== bound.plan_initiative_revision) {
        return yield* conflictRefusal(
          operation,
          `initiative ${bound.plan_initiative_id} (as the planner read it)`,
          bound.plan_initiative_revision ?? 0,
          initiative?.revision ?? 0,
        );
      }
    }
    const unanswered = plan.proposal.questions.filter(
      (question) =>
        !plan.answers.some(
          (answer) => answer.question === question && answer.answer.trim().length > 0,
        ),
    );
    if (unanswered.length > 0) {
      return yield* refuse(
        "invalid",
        operation,
        `${key}'s plan has ${unanswered.length} unanswered question(s)`,
      );
    }
    const saved = yield* tasks
      .save({
        id: key,
        expectedRevision: row.revision,
        patch: { description: plan.proposal.description, acceptance: plan.proposal.acceptance },
      })
      .pipe(Effect.mapError((error) => refuse(error.kind, operation, error.message)));
    yield* store.write(
      Effect.gen(function* () {
        yield* writePlan(
          row.id,
          { ...plan, approvedRevision: plan.revision },
          { approvedTaskRevision: saved.revision },
        );
        yield* store.recordHistory(row.id, USER_ACTOR, "houston:plan-approve", {
          planRevision: plan.revision,
        });
        return { result: undefined, touched: [row.id] };
      }),
    );
    return yield* detailOf(row.id);
  });

  const agentWriteRefusal: HoustonTaskRuns["Service"]["agentWriteRefusal"] = (caller) =>
    readOnlyThreads.isReadOnly(caller).pipe(
      Effect.map((readOnly) =>
        readOnly
          ? new OrchestratorMcpFailure({
              code: "capability_denied",
              message: `thread ${caller} plans or reviews a task and is read-only; it may only submit its plan or verdict`,
            })
          : undefined,
      ),
    );

  // Following threads.

  const runsOfThread = (threadId: string) =>
    run(
      sql<RunRow>`SELECT * FROM houston_task_runs WHERE thread_id = ${threadId} ORDER BY id DESC`,
    );

  const userSetStatusSinceStart = (taskId: number) =>
    run(sql<{ readonly one: number }>`
      SELECT 1 AS one FROM houston_task_history
      WHERE task_id = ${taskId} AND actor = ${USER_ACTOR} AND action = 'update'
        AND changes LIKE '%"status"%'
        AND id > COALESCE((
          SELECT MAX(id) FROM houston_task_history
          WHERE task_id = ${taskId} AND action IN ('houston:start', 'houston:resume', 'houston:retry', 'houston:rework')
        ), 0)
      LIMIT 1
    `).pipe(Effect.map((rows) => rows.length > 0));

  const followRun = Effect.fn("HoustonTaskRuns.followRun")(function* (
    threadId: string,
    threadRun: OrchestrationV2Run,
  ) {
    const [taskRun] = yield* runsOfThread(threadId);
    if (taskRun === undefined) return;
    const next = taskRunStateOf(threadRun.status);
    const revives = taskRun.state === "interrupted" && OPEN_RUN_STATES.has(next);
    if (!OPEN_RUN_STATES.has(taskRun.state) && !revives) return;
    yield* store.write(
      Effect.gen(function* () {
        const touched: Array<number> = [taskRun.task_id];
        if (taskRun.run_id !== threadRun.id) {
          yield* run(
            sql`UPDATE houston_task_runs SET run_id = ${threadRun.id} WHERE id = ${taskRun.id}`,
          );
        }
        if (next !== taskRun.state) {
          yield* setRunState(
            taskRun.id,
            next,
            next === "failed"
              ? "the thread's run failed"
              : next === "interrupted"
                ? "the thread's run was interrupted"
                : null,
          );
        }
        const row = yield* taskOf(taskRun.task_id);
        if (
          next === "running" &&
          taskRun.kind === "implementation" &&
          runningAfterUserStatus(row) &&
          !(yield* userSetStatusSinceStart(row.id))
        ) {
          touched.push(
            ...(yield* moveTask(row, "in_progress", RUN_ACTOR, "houston:run-working", {
              run: taskRun.id,
            })),
          );
        }
        return { result: undefined, touched };
      }),
    );
  });

  /** Removes a review's own tree once the review has ended and its thread no longer runs in it;
   * a review that reused the implementer's clean worktree leaves that worktree alone. */
  const releaseReviewTree = Effect.fn("HoustonTaskRuns.releaseReviewTree")(function* (
    review: RunRow,
  ) {
    const tree = review.worktree_path;
    if (review.kind !== "review" || OPEN_RUN_STATES.has(review.state)) return;
    if (tree === null || !tree.endsWith(`-review-${review.attempt}`)) return;
    if (review.thread_id !== null) {
      const projection = yield* orchestrator
        .getThreadProjection(review.thread_id as ThreadId)
        .pipe(Effect.option);
      const latest = Option.isSome(projection) ? projection.value.runs.at(-1) : undefined;
      if (latest !== undefined && LIVE_THREAD_RUN.has(latest.status)) return;
    }
    const row = yield* taskOf(review.task_id);
    if (row.project_id === null) return;
    const root = yield* workspaceRoot("houston.tasks.review", row.project_id).pipe(Effect.option);
    if (Option.isNone(root)) return;
    yield* TaskGit.removeWorktree(root.value, tree).pipe(
      Effect.catch((error) =>
        Effect.logWarning("Houston could not remove a review tree", { tree, cause: error.message }),
      ),
    );
  });

  const releaseEndedReviews = (threadId: string) =>
    runsOfThread(threadId).pipe(
      Effect.flatMap((rows) => Effect.forEach(rows, releaseReviewTree, { discard: true })),
    );

  const loseThread = Effect.fn("HoustonTaskRuns.loseThread")(function* (
    threadId: string,
    reason: string,
  ) {
    yield* settlePlanning(threadId, "cancelled");
    const open = (yield* runsOfThread(threadId)).filter((row) => OPEN_RUN_STATES.has(row.state));
    if (open.length > 0) {
      yield* store.write(
        Effect.gen(function* () {
          for (const row of open) yield* setRunState(row.id, "interrupted", reason);
          return { result: undefined, touched: open.map((row) => row.task_id) };
        }),
      );
    }
    yield* releaseEndedReviews(threadId);
  });

  const recordWorkspace = (threadId: string, worktreePath: string | null, branch: string | null) =>
    worktreePath === null
      ? Effect.void
      : store.write(
          Effect.gen(function* () {
            const updated = yield* run(sql<{ readonly task_id: number }>`
              UPDATE houston_task_runs SET worktree_path = ${worktreePath},
                branch = COALESCE(${branch}, branch)
              WHERE thread_id = ${threadId} AND worktree_path IS NULL RETURNING task_id
            `);
            return { result: undefined, touched: updated.map((row) => row.task_id) };
          }),
        );

  /** An open linked pull request is watched, so every pushed head reaches the review trigger; a
   * watch the user ended is not restarted, and one that cannot start is noted on the task. */
  const watchLinkedPullRequest = Effect.fn("HoustonTaskRuns.watchLinkedPullRequest")(function* (
    implementation: RunRow,
    threadId: string,
    link: ThreadPullRequestLink,
  ) {
    if (
      link.watch !== undefined ||
      link.endedWatch !== undefined ||
      link.snapshot?.state === "merged" ||
      link.snapshot?.state === "closed"
    ) {
      return;
    }
    yield* orchestrator
      .dispatch({
        type: "thread.pull-request.watch",
        commandId: CommandId.make(`houston-task-watch:${implementation.id}:${link.url}`),
        threadId: threadId as ThreadId,
        host: link.host,
        repository: link.repository,
        number: link.number,
        watching: true,
      })
      .pipe(
        Effect.asVoid,
        Effect.catch((error) =>
          noteOnce(
            implementation.task_id,
            `watch:${link.url}`,
            `Pull request ${link.url} is not watched, so pushes to it start no every_push review: ${error.message}`,
          ),
        ),
      );
  });

  const watchLinkedPullRequests = Effect.fn("HoustonTaskRuns.watchLinkedPullRequests")(function* (
    threadId: string,
    links: ReadonlyArray<ThreadPullRequestLink>,
  ) {
    const [implementation] = (yield* runsOfThread(threadId)).filter(
      (row) => row.kind === "implementation",
    );
    if (implementation === undefined) return;
    for (const link of links) yield* watchLinkedPullRequest(implementation, threadId, link);
  });

  const followPullRequest = Effect.fn("HoustonTaskRuns.followPullRequest")(function* (
    threadId: string,
    link: Extract<
      OrchestrationV2DomainEvent,
      { readonly type: "thread.pull-request-link-updated" }
    >["payload"],
  ) {
    const [implementation] = (yield* runsOfThread(threadId)).filter(
      (row) => row.kind === "implementation",
    );
    if (implementation === undefined) return;
    const row = yield* taskOf(implementation.task_id);
    yield* store.write(
      Effect.gen(function* () {
        const touched: Array<number> = [];
        if (implementation.pr_url !== link.url) {
          yield* run(
            sql`UPDATE houston_task_runs SET pr_url = ${link.url} WHERE id = ${implementation.id}`,
          );
          touched.push(row.id);
        }
        if (link.snapshot?.state === "merged" && row.status === "in_review") {
          touched.push(
            ...(yield* moveTask(row, "done", "houston:pr", "houston:pr-merged", {
              pullRequest: link.url,
            })),
          );
        }
        return { result: undefined, touched };
      }),
    );
    yield* watchLinkedPullRequest(implementation, threadId, link);
    const head = link.watch?.headSha ?? null;
    if (head === null) return;
    const [last] = yield* run(sql<{ readonly changes: string }>`
      SELECT changes FROM houston_task_history WHERE task_id = ${row.id} AND action = ${PUSHED_ACTION}
      ORDER BY id DESC LIMIT 1
    `);
    if (last !== undefined && last.changes === toJsonText({ headSha: head })) return;
    yield* store.write(
      store
        .recordHistory(row.id, "houston:pr", PUSHED_ACTION, { headSha: head })
        .pipe(Effect.as({ result: undefined, touched: [row.id] })),
    );
    if (row.project_id === null) return;
    const settings = yield* settingsOf("houston.tasks.review", row.project_id).pipe(Effect.orDie);
    const reviews = yield* run(sql<{
      readonly review_head_sha: string | null;
      readonly state: HoustonTaskRunState;
    }>`
      SELECT review_head_sha, state FROM houston_task_runs WHERE task_id = ${row.id} AND kind = 'review'
    `);
    if (
      settings.reviewer === null ||
      !reviewTrigger({
        mode: settings.reviewMode,
        event: { type: "push", headSha: head },
        reviewOpen: reviews.some((review) => OPEN_RUN_STATES.has(review.state)),
        reviewedHeads: reviews.flatMap((review) =>
          review.review_head_sha === null ? [] : [review.review_head_sha],
        ),
      })
    ) {
      return;
    }
    yield* startReview("houston.tasks.review", implementation, {
      automatic: true,
      settings,
      pushedHead: head,
    }).pipe(
      Effect.catch((error) =>
        noteOnce(
          row.id,
          `push:${head}:${error.kind}`,
          `Review of pushed head ${head} not started: ${error.message}`,
        ),
      ),
    );
  });

  const apply = (event: OrchestrationV2DomainEvent): Effect.Effect<void> => {
    switch (event.type) {
      case "run.created":
      case "run.updated":
        return followRun(event.threadId, event.payload).pipe(
          Effect.andThen(releaseEndedReviews(event.threadId)),
        );
      case "thread.deleted":
        return loseThread(event.threadId, "thread deleted");
      case "thread.archived":
        return loseThread(event.threadId, "thread archived");
      case "thread.created":
      case "thread.metadata-updated":
        return recordWorkspace(event.threadId, event.payload.worktreePath, event.payload.branch);
      case "thread.pull-request-link-updated":
        return followPullRequest(event.threadId, event.payload);
      case "thread.pull-request-synced":
        return watchLinkedPullRequests(event.threadId, event.payload.pullRequests ?? []);
      default:
        return Effect.void;
    }
  };

  // The last applied event survives a restart, so events stored but not applied before a crash
  // are replayed; the first boot starts at the latest event.
  const [storedCursor] = yield* run(
    sql<{ readonly sequence: number }>`SELECT sequence FROM houston_task_runs_cursor WHERE id = 1`,
  );
  let cursor = storedCursor?.sequence ?? (yield* eventSink.latestSequence().pipe(Effect.orDie));
  const saveCursor = (sequence: number) =>
    run(sql`
      INSERT INTO houston_task_runs_cursor (id, sequence) VALUES (1, ${sequence})
      ON CONFLICT (id) DO UPDATE SET sequence = excluded.sequence
    `);
  if (storedCursor === undefined) yield* saveCursor(cursor);
  const catchUpLock = yield* Semaphore.make(1);
  const catchUp: HoustonTaskRuns["Service"]["catchUp"] = catchUpLock.withPermits(1)(
    Effect.gen(function* () {
      const latest = yield* eventSink.latestSequence().pipe(Effect.orDie);
      if (latest <= cursor) return;
      const events = yield* eventSink.stream({ afterSequence: cursor }).pipe(
        Stream.takeUntil((stored) => stored.sequence >= latest),
        Stream.runCollect,
        Effect.orDie,
      );
      for (const stored of events) {
        yield* apply(stored.event).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("Houston task runs could not follow a thread event", {
              sequence: stored.sequence,
              type: stored.event.type,
              cause,
            }),
          ),
        );
        cursor = stored.sequence;
        yield* saveCursor(cursor);
      }
    }),
  );

  // Startup: a run the agent was working on whose thread run is no longer live was interrupted by
  // the restart; open planning sessions end, so planning can start again.
  const recover = Effect.gen(function* () {
    const working = yield* run(sql<RunRow>`
      SELECT * FROM houston_task_runs
      WHERE state IN ('preparing', 'running', 'validating') AND thread_id IS NOT NULL
    `);
    for (const row of working) {
      const projection = yield* orchestrator
        .getThreadProjection(row.thread_id as ThreadId)
        .pipe(Effect.option);
      const latest = Option.isSome(projection) ? projection.value.runs.at(-1) : undefined;
      if (latest !== undefined && LIVE_THREAD_RUN.has(latest.status)) continue;
      // A thread prepared for a prefilled brief has no run yet.
      if (row.state === "preparing" && Option.isSome(projection) && latest === undefined) continue;
      yield* store.write(
        setRunState(
          row.id,
          latest?.status === "completed" ? "waiting_for_input" : "interrupted",
          latest?.status === "completed" ? null : "server restarted",
        ).pipe(Effect.as({ result: undefined, touched: [row.task_id] })),
      );
    }
    const planning = yield* run(sql<PlanningRow>`
      SELECT * FROM houston_task_planning WHERE state = 'active'
    `);
    for (const row of planning) yield* settlePlanning(row.thread_id, "exited");
  });
  yield* recover;
  // Then replay what was stored but not applied: a thread deleted in that gap closes its run.
  yield* catchUp;

  yield* orchestrator.streamDomainEvents.pipe(
    Stream.runForEach(() => catchUp),
    Effect.catchCause((cause) =>
      Effect.logWarning("Houston task runs stopped following threads", { cause }),
    ),
    Effect.forkScoped,
  );

  return HoustonTaskRuns.of({
    start,
    runControl,
    handback,
    planStart,
    planAnswer,
    planApprove,
    reviewStart,
    planSubmit,
    reviewSubmit,
    agentWriteRefusal,
    catchUp,
  });
});

export const layer = Layer.effect(HoustonTaskRuns, make);
