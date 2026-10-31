// The houston.tasks.* operations: validation by rules.ts, one transaction per write through the
// store, and a subscription that never loses a write committed while its snapshot is read.
import {
  DEFAULT_MODEL_BY_PROVIDER,
  ModelSelection,
  type ProjectId,
  ProviderDriverKind,
  defaultInstanceIdForDriver,
} from "@t3tools/contracts";
import {
  HOUSTON_TASK_LIMITS,
  type HoustonTask,
  type HoustonTaskArchiveInput,
  type HoustonTaskCheckInput,
  type HoustonTaskCommentInput,
  type HoustonTaskCounts,
  type HoustonTaskDetail,
  type HoustonTaskDomain,
  type HoustonTaskDomainSaveInput,
  type HoustonTaskError,
  type HoustonTaskGetInput,
  type HoustonTaskInitiative,
  type HoustonTaskInitiativeArchiveInput,
  type HoustonTaskInitiativeSaveInput,
  type HoustonTaskInitiativesListInput,
  type HoustonTaskSaveInput,
  type HoustonTaskSettings,
  type HoustonTaskSettingsGetInput,
  type HoustonTaskSettingsSetInput,
  type HoustonTaskStreamEvent,
  type HoustonTaskSubscribeInput,
  type HoustonTaskSummary,
} from "@t3tools/contracts/houston/tasks";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";

import * as ProjectStore from "../../orchestration-v2/ProjectStore.ts";
import * as ProviderInstanceRegistry from "../../provider/ProviderInstanceRegistry.ts";
import {
  blockerCycle,
  checkAcceptance,
  checkComment,
  checkCommentCount,
  checkDescription,
  checkReworkRounds,
  checkTaskCount,
  checkTitle,
  conflictRefusal,
  limitRefusal,
  parentCycle,
  priorityFromValue,
  priorityValue,
  refuse,
} from "./rules.ts";
import { HoustonTaskStore, SnapshotReadHook, nowIso, toTask, type TaskRow } from "./TaskStore.ts";

/** The actor of every write a client makes through `/ws`. */
export const USER_ACTOR = "user";

const CLAUDE = ProviderDriverKind.make("claudeAgent");

/** The default Claude selection: the built-in Claude instance and its default model. */
export const DEFAULT_START_MODEL: ModelSelection = {
  instanceId: defaultInstanceIdForDriver(CLAUDE),
  model: DEFAULT_MODEL_BY_PROVIDER[CLAUDE] ?? "claude-opus-5-5",
};

const decodeSelection = Schema.decodeUnknownSync(Schema.fromJsonString(ModelSelection));
export const encodeSelection = Schema.encodeSync(Schema.fromJsonString(ModelSelection));
const LocalDecisions = Schema.fromJsonString(Schema.Array(Schema.String));
const decodeDecisions = Schema.decodeUnknownSync(LocalDecisions);
const encodeDecisions = Schema.encodeSync(LocalDecisions);

export class HoustonTaskService extends Context.Service<
  HoustonTaskService,
  {
    readonly subscribe: (
      input: HoustonTaskSubscribeInput,
    ) => Stream.Stream<HoustonTaskStreamEvent, HoustonTaskError>;
    readonly get: (
      input: HoustonTaskGetInput,
    ) => Effect.Effect<HoustonTaskDetail, HoustonTaskError>;
    readonly save: (
      input: HoustonTaskSaveInput,
      actor?: string,
    ) => Effect.Effect<HoustonTask, HoustonTaskError>;
    readonly comment: (
      input: HoustonTaskCommentInput,
      actor?: string,
    ) => Effect.Effect<HoustonTask, HoustonTaskError>;
    readonly check: (
      input: HoustonTaskCheckInput,
      actor?: string,
    ) => Effect.Effect<HoustonTask, HoustonTaskError>;
    readonly archive: (
      input: HoustonTaskArchiveInput,
      actor?: string,
    ) => Effect.Effect<HoustonTask, HoustonTaskError>;
    readonly listInitiatives: (
      input: HoustonTaskInitiativesListInput,
    ) => Effect.Effect<ReadonlyArray<HoustonTaskInitiative>, HoustonTaskError>;
    readonly saveInitiative: (
      input: HoustonTaskInitiativeSaveInput,
    ) => Effect.Effect<HoustonTaskInitiative, HoustonTaskError>;
    readonly archiveInitiative: (
      input: HoustonTaskInitiativeArchiveInput,
    ) => Effect.Effect<HoustonTaskInitiative, HoustonTaskError>;
    readonly saveDomain: (
      input: HoustonTaskDomainSaveInput,
      actor?: string,
    ) => Effect.Effect<HoustonTaskDomain, HoustonTaskError>;
    readonly getSettings: (
      input: HoustonTaskSettingsGetInput,
    ) => Effect.Effect<HoustonTaskSettings, HoustonTaskError>;
    readonly setSettings: (
      input: HoustonTaskSettingsSetInput,
    ) => Effect.Effect<HoustonTaskSettings, HoustonTaskError>;
  }
>()("houston/houston/tasks/TaskService/HoustonTaskService") {}

interface InitiativeRow {
  readonly id: number;
  readonly project_id: string | null;
  readonly name: string;
  readonly external_url: string | null;
  readonly tracker_description: string | null;
  readonly local_decisions: string;
  readonly revision: number;
  readonly archived_at: string | null;
}

const toInitiative = (row: InitiativeRow): HoustonTaskInitiative => ({
  id: row.id,
  projectId: row.project_id as ProjectId | null,
  name: row.name,
  externalUrl: row.external_url,
  trackerDescription: row.tracker_description,
  localDecisions: decodeDecisions(row.local_decisions),
  revision: row.revision,
  archivedAt: row.archived_at,
});

interface SettingsRow {
  readonly access: HoustonTaskSettings["access"];
  readonly start_model: string;
  readonly delivery: HoustonTaskSettings["delivery"];
  readonly reviewer: string | null;
  readonly review_mode: HoustonTaskSettings["reviewMode"] | null;
  readonly focus: HoustonTaskSettings["focus"];
  readonly rework_rounds: number;
}

export const settingsFromRow = (row: SettingsRow | undefined): HoustonTaskSettings => {
  if (row === undefined) {
    return {
      access: "write",
      startModel: DEFAULT_START_MODEL,
      delivery: "send",
      reviewer: null,
      reviewMode: "manual",
      focus: "bugs",
      reworkRounds: 0,
    };
  }
  const reviewer = row.reviewer === null ? null : decodeSelection(row.reviewer);
  return {
    access: row.access,
    startModel: decodeSelection(row.start_model),
    delivery: row.delivery,
    reviewer,
    reviewMode: row.review_mode ?? (reviewer === null ? "manual" : "handback"),
    focus: row.focus,
    reworkRounds: row.rework_rounds,
  };
};

const countsOf = (summaries: ReadonlyArray<HoustonTaskSummary>): HoustonTaskCounts => {
  const counts = {
    yourTurn: 0,
    ready: 0,
    backlog: 0,
    todo: 0,
    inProgress: 0,
    inReview: 0,
    done: 0,
    canceled: 0,
  };
  for (const summary of summaries) {
    if (summary.archivedAt !== null) continue;
    if (summary.queue === "your_turn") counts.yourTurn += 1;
    if (summary.status === "todo" && summary.ready) counts.ready += 1;
    switch (summary.status) {
      case "backlog":
        counts.backlog += 1;
        break;
      case "todo":
        counts.todo += 1;
        break;
      case "in_progress":
        counts.inProgress += 1;
        break;
      case "in_review":
        counts.inReview += 1;
        break;
      case "done":
        counts.done += 1;
        break;
      case "canceled":
        counts.canceled += 1;
        break;
    }
  }
  return counts;
};

const inScope = (summary: HoustonTaskSummary, scope: HoustonTaskSubscribeInput["scope"]) =>
  scope === "all"
    ? true
    : scope === "unassigned"
      ? summary.projectId === null
      : summary.projectId === scope.projectId;

const failIf = (error: HoustonTaskError | undefined) =>
  error === undefined ? Effect.void : Effect.fail(error);

const valueOr = <A>(value: A | HoustonTaskError) =>
  value instanceof Error ? Effect.fail(value as HoustonTaskError) : Effect.succeed(value);

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const store = yield* HoustonTaskStore;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const instances = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;

  // SQL failures are defects; refusals are the only expected failures.
  const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.orDie(effect);

  const projectExists = (projectId: ProjectId) =>
    projects.get(projectId).pipe(Effect.map(Option.isSome), Effect.orDie);

  const requireProject = (operation: string, projectId: ProjectId) =>
    Effect.flatMap(projectExists(projectId), (exists) =>
      exists
        ? Effect.void
        : Effect.fail(refuse("invalid", operation, `project ${projectId} does not exist`)),
    );

  const blockedByThis = (taskId: number) =>
    run(sql<{ readonly task_id: number }>`
      SELECT task_id FROM houston_task_blocks WHERE blocked_by_id = ${taskId}
    `).pipe(Effect.map((rows) => rows.map((row) => row.task_id)));

  const parentOf = (id: number) =>
    run(sql<{ readonly parent_id: number | null }>`
      SELECT parent_id FROM houston_tasks WHERE id = ${id}
    `).pipe(Effect.map((rows) => (rows[0] === undefined ? undefined : rows[0].parent_id)));

  /** Reads the stored parent chain from `parentId`, then lets the rule judge it. */
  const checkParent = Effect.fn("HoustonTaskService.checkParent")(function* (
    operation: string,
    taskId: number | null,
    parentId: number,
  ) {
    const chain = new Map<number, number | null>();
    let current: number | null = parentId;
    while (current !== null && !chain.has(current)) {
      const parent: number | null | undefined = yield* parentOf(current);
      if (parent === undefined) break;
      chain.set(current, parent);
      if (current === taskId) break;
      current = parent;
    }
    const verdict = parentCycle(taskId, parentId, (id) => chain.get(id));
    if (verdict === "missing") {
      return yield* refuse("not_found", operation, `parent task ${parentId} does not exist`);
    }
    if (verdict === "cycle") {
      return yield* refuse(
        "cycle",
        operation,
        `task ${parentId} is the task itself or one of its descendants (a parent cycle)`,
      );
    }
  });

  // A write touches the task, its parent, the tasks it blocks and a delivery it rolled up.
  const touchedBy = Effect.fn("HoustonTaskService.touchedBy")(function* (
    task: TaskRow,
    extra: ReadonlyArray<number | null | undefined> = [],
  ) {
    const rolled = yield* store.rollup(task.id);
    return [
      task.id,
      ...(task.parent_id === null ? [] : [task.parent_id]),
      ...(yield* blockedByThis(task.id)),
      ...[rolled, ...extra].filter((id): id is number => typeof id === "number"),
    ];
  });

  const bump = Effect.fn("HoustonTaskService.bump")(function* (taskId: number) {
    const now = yield* nowIso;
    const [row] = yield* run(sql<TaskRow>`
      UPDATE houston_tasks SET revision = revision + 1, updated_at = ${now}
      WHERE id = ${taskId} RETURNING *
    `);
    return row as TaskRow;
  });

  const subscribe: HoustonTaskService["Service"]["subscribe"] = (input) =>
    Stream.unwrap(
      Effect.gen(function* () {
        const scope = input.scope;
        if (typeof scope === "object") {
          yield* requireProject("houston.tasks.subscribe", scope.projectId);
        }
        // Subscribing before the read buffers every write that commits during it.
        const subscription = yield* PubSub.subscribe(store.changes);
        const snapshot = yield* store.summaries({ scope });
        yield* yield* SnapshotReadHook;
        const sent = new Set(snapshot.summaries.map((summary) => summary.id));
        const first: HoustonTaskStreamEvent = {
          snapshot: {
            tasks: snapshot.summaries,
            counts: countsOf(snapshot.summaries),
            truncated: snapshot.truncated,
          },
        };
        const eventsFor = (ids: ReadonlyArray<number>) =>
          store.summaries({ ids }).pipe(
            Effect.map(({ summaries }) => {
              const found = new Map(summaries.map((summary) => [summary.id, summary]));
              const events: Array<HoustonTaskStreamEvent> = [];
              for (const id of ids) {
                const summary = found.get(id);
                if (summary !== undefined && inScope(summary, scope)) {
                  sent.add(id);
                  events.push({ changed: summary });
                } else if (sent.delete(id)) {
                  events.push({ removed: { id } });
                }
              }
              return events;
            }),
          );
        return Stream.concat(
          Stream.make(first),
          Stream.fromSubscription(subscription).pipe(
            Stream.mapEffect(eventsFor),
            Stream.flatMap((events) => Stream.fromIterable(events)),
          ),
        );
      }),
    );

  const get: HoustonTaskService["Service"]["get"] = (input) =>
    Effect.flatMap(store.resolve("houston.tasks.get", input.id), store.detail);

  const createTask = Effect.fn("HoustonTaskService.createTask")(function* (
    input: HoustonTaskSaveInput,
    actor: string,
  ) {
    const operation = "houston.tasks.save";
    const patch = input.patch;
    const projectId = patch.projectId !== undefined ? patch.projectId : (input.projectId ?? null);
    if (projectId !== null) yield* requireProject(operation, projectId);
    if (patch.title === undefined) {
      return yield* refuse("invalid", operation, "a new task needs a title");
    }
    const title = yield* valueOr(checkTitle(operation, patch.title));
    const description = patch.description ?? "";
    yield* failIf(checkDescription(operation, description));
    const acceptance = yield* valueOr(checkAcceptance(operation, patch.acceptance ?? []));
    const parentId = patch.parentId ?? null;
    if (parentId !== null) yield* checkParent(operation, null, parentId);
    yield* failIf(checkTaskCount(operation, yield* store.taskCount));
    const created = yield* store.createTask({
      projectId,
      title,
      description,
      status: patch.status ?? "backlog",
      priority: patch.priority ?? "none",
      parentId,
      refUrl: patch.refUrl ?? null,
      acceptance,
      createdBy: actor,
    });
    return { result: toTask(created), touched: yield* touchedBy(created) };
  });

  const updateTask = Effect.fn("HoustonTaskService.updateTask")(function* (
    input: HoustonTaskSaveInput & { readonly id: string },
    actor: string,
  ) {
    const operation = "houston.tasks.save";
    const row = yield* store.resolve(operation, input.id);
    const key = toTask(row).key;
    if (input.expectedRevision === undefined) {
      return yield* refuse("invalid", operation, `expectedRevision is required to update ${key}`);
    }
    if (row.revision !== input.expectedRevision) {
      return yield* conflictRefusal(operation, key, input.expectedRevision, row.revision);
    }
    const patch = input.patch;
    const changes: Record<string, { old: unknown; new: unknown }> = {};
    const note = (field: string, before: unknown, after: unknown) => {
      if (before !== after) changes[field] = { old: before, new: after };
    };
    const title =
      patch.title === undefined ? row.title : yield* valueOr(checkTitle(operation, patch.title));
    const description = patch.description ?? row.description;
    yield* failIf(checkDescription(operation, description));
    const projectId = patch.projectId === undefined ? row.project_id : patch.projectId;
    if (projectId !== null && projectId !== row.project_id) {
      yield* requireProject(operation, projectId as ProjectId);
    }
    const parentId = patch.parentId === undefined ? row.parent_id : patch.parentId;
    if (parentId !== null && parentId !== row.parent_id) {
      yield* checkParent(operation, row.id, parentId);
    }
    const acceptance =
      patch.acceptance === undefined
        ? undefined
        : yield* valueOr(checkAcceptance(operation, patch.acceptance));
    const status = patch.status ?? row.status;
    const priority = patch.priority ?? priorityFromValue(row.priority) ?? "none";
    const refUrl = patch.refUrl === undefined ? row.ref_url : patch.refUrl;
    note("title", row.title, title);
    note("description", row.description, description);
    note("status", row.status, status);
    note("priority", priorityFromValue(row.priority) ?? "none", priority);
    note("projectId", row.project_id, projectId);
    note("parentId", row.parent_id, parentId);
    note("refUrl", row.ref_url, refUrl);
    if (acceptance !== undefined) {
      const [before] = yield* run(sql<{ readonly n: number }>`
          SELECT COUNT(*) AS n FROM houston_task_acceptance WHERE task_id = ${row.id}
        `);
      changes.acceptance = { old: before?.n ?? 0, new: acceptance.length };
      yield* run(sql`DELETE FROM houston_task_acceptance WHERE task_id = ${row.id}`);
      for (const [position, text] of acceptance.entries()) {
        yield* run(sql`
            INSERT INTO houston_task_acceptance (task_id, position, text)
            VALUES (${row.id}, ${position}, ${text})
          `);
      }
    }
    const now = yield* nowIso;
    const [updated] = yield* run(sql<TaskRow>`
        UPDATE houston_tasks SET title = ${title}, description = ${description},
          status = ${status}, priority = ${priorityValue(priority)}, project_id = ${projectId},
          parent_id = ${parentId}, ref_url = ${refUrl}, revision = revision + 1,
          updated_at = ${now}
        WHERE id = ${row.id} RETURNING *
      `);
    // An edit invalidates an approved plan; a user's status choice stops the delivery rollup.
    yield* run(sql`
        UPDATE houston_task_domain SET approved_task_revision = NULL,
          user_status_override = CASE WHEN ${actor === USER_ACTOR && "status" in changes ? 1 : 0} = 1
            THEN 1 ELSE user_status_override END
        WHERE task_id = ${row.id}
      `);
    yield* store.recordHistory(row.id, actor, "update", changes);
    const task = updated as TaskRow;
    return { result: toTask(task), touched: yield* touchedBy(task, [row.parent_id]) };
  });

  const save: HoustonTaskService["Service"]["save"] = (input, actor = USER_ACTOR) =>
    store.write(
      input.id === undefined
        ? createTask(input, actor)
        : updateTask({ ...input, id: input.id }, actor),
    );

  const comment: HoustonTaskService["Service"]["comment"] = (input, actor = USER_ACTOR) =>
    store.write(
      Effect.gen(function* () {
        const operation = "houston.tasks.comment";
        const row = yield* store.resolve(operation, input.id);
        yield* failIf(checkComment(operation, input.body));
        const [count] = yield* run(sql<{ readonly n: number }>`
          SELECT COUNT(*) AS n FROM houston_task_comments WHERE task_id = ${row.id}
        `);
        yield* failIf(checkCommentCount(operation, count?.n ?? 0));
        const now = yield* nowIso;
        const [inserted] = yield* run(sql<{ readonly id: number }>`
          INSERT INTO houston_task_comments (task_id, body, author, created_at)
          VALUES (${row.id}, ${input.body}, ${actor}, ${now}) RETURNING id
        `);
        const task = yield* bump(row.id);
        yield* store.recordHistory(row.id, actor, "comment", { comment: inserted?.id ?? null });
        return { result: toTask(task), touched: [row.id] };
      }),
    );

  const check: HoustonTaskService["Service"]["check"] = (input, actor = USER_ACTOR) =>
    store.write(
      Effect.gen(function* () {
        const operation = "houston.tasks.check";
        const row = yield* store.resolve(operation, input.id);
        const [item] = yield* run(sql<{ readonly text: string }>`
          SELECT text FROM houston_task_acceptance WHERE id = ${input.item} AND task_id = ${row.id}
        `);
        if (item === undefined) {
          return yield* refuse(
            "not_found",
            operation,
            `${toTask(row).key} has no acceptance item ${input.item}`,
          );
        }
        const now = yield* nowIso;
        yield* run(sql`
          UPDATE houston_task_acceptance
          SET checked_at = ${input.checked ? now : null}, checked_by = ${input.checked ? actor : null}
          WHERE id = ${input.item}
        `);
        const task = yield* bump(row.id);
        yield* store.recordHistory(row.id, actor, input.checked ? "check" : "uncheck", {
          item: input.item,
          text: item.text,
        });
        return { result: toTask(task), touched: [row.id] };
      }),
    );

  const archive: HoustonTaskService["Service"]["archive"] = (input, actor = USER_ACTOR) =>
    store.write(
      Effect.gen(function* () {
        const operation = "houston.tasks.archive";
        const row = yield* store.resolve(operation, input.id);
        if (row.revision !== input.expectedRevision) {
          return yield* conflictRefusal(
            operation,
            toTask(row).key,
            input.expectedRevision,
            row.revision,
          );
        }
        const now = yield* nowIso;
        const [updated] = yield* run(sql<TaskRow>`
          UPDATE houston_tasks SET archived_at = ${input.archived ? now : null},
            revision = revision + 1, updated_at = ${now}
          WHERE id = ${row.id} RETURNING *
        `);
        yield* store.recordHistory(row.id, actor, input.archived ? "archive" : "restore", {});
        const task = updated as TaskRow;
        return { result: toTask(task), touched: yield* touchedBy(task) };
      }),
    );

  const initiativeById = (id: number) =>
    run(sql<InitiativeRow>`SELECT * FROM houston_task_initiatives WHERE id = ${id}`).pipe(
      Effect.map((rows) => rows[0]),
    );

  const tasksOfInitiative = (id: number) =>
    run(sql<{ readonly task_id: number }>`
      SELECT task_id FROM houston_task_domain WHERE initiative_id = ${id}
    `).pipe(Effect.map((rows) => rows.map((row) => row.task_id)));

  const listInitiatives: HoustonTaskService["Service"]["listInitiatives"] = Effect.fn(
    "HoustonTaskService.listInitiatives",
  )(function* (input) {
    yield* requireProject("houston.tasks.initiatives.list", input.projectId);
    const rows = yield* run(sql<InitiativeRow>`
      SELECT * FROM houston_task_initiatives WHERE project_id = ${input.projectId} ORDER BY id
    `);
    return rows.map(toInitiative);
  });

  const saveInitiative: HoustonTaskService["Service"]["saveInitiative"] = (input) =>
    store.write(
      Effect.gen(function* () {
        const operation = "houston.tasks.initiatives.save";
        yield* requireProject(operation, input.projectId);
        const name = input.name.trim();
        if (name.length === 0) {
          return yield* refuse("invalid", operation, "an initiative name cannot be empty");
        }
        if ([...name].length > HOUSTON_TASK_LIMITS.titleChars) {
          return yield* limitRefusal(
            operation,
            HOUSTON_TASK_LIMITS.titleChars,
            [...name].length,
            "characters in the initiative name",
          );
        }
        const previous = input.id === undefined ? undefined : yield* initiativeById(input.id);
        if (input.id !== undefined) {
          if (previous === undefined || previous.project_id !== input.projectId) {
            return yield* refuse(
              "not_found",
              operation,
              `no initiative ${input.id} in project ${input.projectId}`,
            );
          }
          if (input.expectedRevision === undefined) {
            return yield* refuse(
              "invalid",
              operation,
              `expectedRevision is required to update initiative ${input.id}`,
            );
          }
          if (previous.revision !== input.expectedRevision) {
            return yield* conflictRefusal(
              operation,
              `initiative ${input.id}`,
              input.expectedRevision,
              previous.revision,
            );
          }
          if (previous.archived_at !== null) {
            return yield* refuse("invalid", operation, `initiative ${input.id} is archived`);
          }
        }
        const externalUrl =
          input.externalUrl === undefined ? (previous?.external_url ?? null) : input.externalUrl;
        const trackerDescription =
          input.trackerDescription === undefined
            ? (previous?.tracker_description ?? null)
            : input.trackerDescription;
        const decisions = encodeDecisions(
          input.localDecisions ??
            (previous === undefined ? [] : decodeDecisions(previous.local_decisions)),
        );
        for (const [label, value] of [
          ["the external URL", externalUrl],
          ["the tracker description", trackerDescription],
          ["the local decisions", decisions],
        ] as const) {
          const bytes = Buffer.byteLength(value ?? "", "utf8");
          if (bytes > HOUSTON_TASK_LIMITS.descriptionBytes) {
            return yield* limitRefusal(
              operation,
              HOUSTON_TASK_LIMITS.descriptionBytes,
              bytes,
              `bytes in ${label}`,
            );
          }
        }
        const now = yield* nowIso;
        const [saved] =
          previous === undefined
            ? yield* run(sql<InitiativeRow>`
                INSERT INTO houston_task_initiatives (
                  project_id, name, external_url, tracker_description, local_decisions, revision,
                  updated_at
                ) VALUES (
                  ${input.projectId}, ${name}, ${externalUrl}, ${trackerDescription},
                  ${decisions}, 1, ${now}
                ) RETURNING *
              `)
            : yield* run(sql<InitiativeRow>`
                UPDATE houston_task_initiatives SET name = ${name}, external_url = ${externalUrl},
                  tracker_description = ${trackerDescription}, local_decisions = ${decisions},
                  revision = revision + 1, updated_at = ${now}
                WHERE id = ${previous.id} RETURNING *
              `);
        const initiative = saved as InitiativeRow;
        return {
          result: toInitiative(initiative),
          touched: yield* tasksOfInitiative(initiative.id),
        };
      }),
    );

  const archiveInitiative: HoustonTaskService["Service"]["archiveInitiative"] = (input) =>
    store.write(
      Effect.gen(function* () {
        const operation = "houston.tasks.initiatives.archive";
        const previous = yield* initiativeById(input.id);
        if (previous === undefined) {
          return yield* refuse("not_found", operation, `no initiative ${input.id}`);
        }
        if (
          previous.revision !== input.expectedRevision ||
          (previous.archived_at !== null) === input.archived
        ) {
          return yield* conflictRefusal(
            operation,
            `initiative ${input.id} (archived: ${previous.archived_at !== null})`,
            input.expectedRevision,
            previous.revision,
          );
        }
        const now = yield* nowIso;
        const [saved] = yield* run(sql<InitiativeRow>`
          UPDATE houston_task_initiatives SET archived_at = ${input.archived ? now : null},
            revision = revision + 1, updated_at = ${now}
          WHERE id = ${input.id} RETURNING *
        `);
        return {
          result: toInitiative(saved as InitiativeRow),
          touched: yield* tasksOfInitiative(input.id),
        };
      }),
    );

  const blockersOf = (id: number) =>
    run(sql<{ readonly blocked_by_id: number }>`
      SELECT blocked_by_id FROM houston_task_blocks WHERE task_id = ${id}
    `).pipe(Effect.map((rows) => rows.map((row) => row.blocked_by_id)));

  const saveDomain: HoustonTaskService["Service"]["saveDomain"] = (input, actor = USER_ACTOR) =>
    store
      .write(
        Effect.gen(function* () {
          const operation = "houston.tasks.domain.save";
          const row = yield* store.resolve(operation, input.id);
          const key = toTask(row).key;
          if (row.revision !== input.expectedRevision) {
            return yield* conflictRefusal(operation, key, input.expectedRevision, row.revision);
          }
          const existing = yield* store.domainRow(row.id);
          const changes: Record<string, unknown> = {};
          if (input.blockedBy !== undefined) {
            const blockedBy = [...new Set(input.blockedBy)];
            for (const id of blockedBy) {
              if (id !== row.id && (yield* store.taskById(id)) === undefined) {
                return yield* refuse("not_found", operation, `blocker task ${id} does not exist`);
              }
            }
            // Every stored blocker list is read up front, so the walk below stays synchronous.
            const stored = new Map<number, ReadonlyArray<number>>();
            const pending = [...blockedBy];
            while (pending.length > 0) {
              const next = pending.pop() as number;
              if (stored.has(next)) continue;
              const blockers = yield* blockersOf(next);
              stored.set(next, blockers);
              pending.push(...blockers);
            }
            if (blockerCycle(row.id, blockedBy, (id) => stored.get(id) ?? [])) {
              return yield* refuse(
                "cycle",
                operation,
                `blocking ${key} by ${blockedBy.join(", ")} would make a blocker cycle`,
              );
            }
            yield* run(sql`DELETE FROM houston_task_blocks WHERE task_id = ${row.id}`);
            for (const id of blockedBy) {
              yield* run(sql`
              INSERT INTO houston_task_blocks (task_id, blocked_by_id) VALUES (${row.id}, ${id})
            `);
            }
            changes.blockedBy = blockedBy;
          }
          if (input.kind !== undefined || input.initiativeId !== undefined) {
            const kind = input.kind ?? existing?.kind;
            if (kind === undefined) {
              return yield* refuse(
                "invalid",
                operation,
                `${key} has no kind yet; name delivery or slice`,
              );
            }
            const initiativeId =
              input.initiativeId === undefined
                ? (existing?.initiative_id ?? null)
                : input.initiativeId;
            if (kind === "slice") {
              const parent =
                row.parent_id === null ? undefined : yield* store.domainRow(row.parent_id);
              if (parent?.kind !== "delivery") {
                return yield* refuse(
                  "invalid",
                  operation,
                  `a slice's parent must be a delivery; ${key} has parent ${row.parent_id ?? "none"}`,
                );
              }
            }
            if (initiativeId !== null) {
              const initiative = yield* initiativeById(initiativeId);
              if (
                initiative === undefined ||
                initiative.archived_at !== null ||
                initiative.project_id !== row.project_id
              ) {
                return yield* refuse(
                  "invalid",
                  operation,
                  `initiative ${initiativeId} must exist, be active and belong to ${key}'s project`,
                );
              }
            }
            // As Houston 1: a delivery past backlog, or one whose status the user set, keeps it.
            yield* run(sql`
            INSERT INTO houston_task_domain (task_id, kind, initiative_id, user_status_override)
            VALUES (
              ${row.id}, ${kind}, ${initiativeId},
              CASE WHEN ${row.status} != 'backlog' OR EXISTS (
                SELECT 1 FROM houston_task_history WHERE task_id = ${row.id} AND actor = 'user'
                  AND changes LIKE '%"status"%'
              ) THEN 1 ELSE 0 END
            )
            ON CONFLICT (task_id) DO UPDATE SET kind = excluded.kind,
              initiative_id = excluded.initiative_id, approved_task_revision = NULL
          `);
            changes.kind = kind;
            changes.initiativeId = initiativeId;
          }
          const task = yield* bump(row.id);
          yield* store.recordHistory(row.id, actor, "domain_update", changes);
          return { result: task, touched: yield* touchedBy(task) };
        }),
      )
      .pipe(Effect.flatMap(store.domain));

  const settingsRow = (projectId: ProjectId) =>
    run(sql<SettingsRow>`
      SELECT * FROM houston_task_settings WHERE project_id = ${projectId}
    `).pipe(Effect.map((rows) => rows[0]));

  const getSettings: HoustonTaskService["Service"]["getSettings"] = Effect.fn(
    "HoustonTaskService.getSettings",
  )(function* (input) {
    yield* requireProject("houston.tasks.settings.get", input.projectId);
    return settingsFromRow(yield* settingsRow(input.projectId));
  });

  const setSettings: HoustonTaskService["Service"]["setSettings"] = Effect.fn(
    "HoustonTaskService.setSettings",
  )(function* (input) {
    const operation = "houston.tasks.settings.set";
    yield* requireProject(operation, input.projectId);
    const settings = input.settings;
    yield* failIf(checkReworkRounds(operation, settings.reworkRounds));
    for (const [role, selection] of [
      ["start model", settings.startModel],
      ["reviewer", settings.reviewer],
    ] as const) {
      if (selection === null) continue;
      if ((yield* instances.getInstance(selection.instanceId)) === undefined) {
        return yield* refuse(
          "invalid",
          operation,
          `the ${role}'s provider instance ${selection.instanceId} is not configured`,
        );
      }
    }
    const now = yield* nowIso;
    yield* run(sql`
        INSERT INTO houston_task_settings (
          project_id, access, start_model, delivery, reviewer, review_mode, focus, rework_rounds,
          updated_at
        ) VALUES (
          ${input.projectId}, ${settings.access}, ${encodeSelection(settings.startModel)},
          ${settings.delivery},
          ${settings.reviewer === null ? null : encodeSelection(settings.reviewer)},
          ${settings.reviewMode ?? null}, ${settings.focus}, ${settings.reworkRounds}, ${now}
        )
        ON CONFLICT (project_id) DO UPDATE SET access = excluded.access,
          start_model = excluded.start_model, delivery = excluded.delivery,
          reviewer = excluded.reviewer, review_mode = excluded.review_mode,
          focus = excluded.focus, rework_rounds = excluded.rework_rounds,
          updated_at = excluded.updated_at
      `);
    return settingsFromRow(yield* settingsRow(input.projectId));
  });

  return HoustonTaskService.of({
    subscribe,
    get,
    save,
    comment,
    check,
    archive,
    listInitiatives,
    saveInitiative,
    archiveInitiative,
    saveDomain,
    getSettings,
    setSettings,
  });
});

export const layer = Layer.effect(HoustonTaskService, make);
