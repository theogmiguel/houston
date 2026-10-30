// The one-time import of a Houston 1 backlog. v1's database beside a hosted `<channel dir>/v2`
// base dir is opened read-only and read in one transaction; the copy lands in one transaction.
import * as NodeSqlite from "node:sqlite";

import {
  DEFAULT_MODEL_BY_PROVIDER,
  type ModelSelection,
  ProviderDriverKind,
  defaultInstanceIdForDriver,
} from "@t3tools/contracts";
import {
  HOUSTON_TASK_LIMITS,
  HoustonTaskImportCounts,
  HoustonTaskPlan,
  HoustonTaskStatus,
  type HoustonTaskError,
  type HoustonTaskImportResult,
  type HoustonTaskImportStatus,
} from "@t3tools/contracts/houston/tasks";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as HostProcess from "@t3tools/shared/HostProcess";
import * as ServerConfig from "../../config.ts";
import * as ProjectStore from "../../orchestration-v2/ProjectStore.ts";
import { isOpenRun, priorityFromValue, priorityValue, refuse, v1PathMatches } from "./rules.ts";
import { encodeSelection } from "./TaskService.ts";
import { HoustonTaskStore, nowIso } from "./TaskStore.ts";

const OPERATION = "houston.tasks.importV1.run";
const V1_DATABASE = "houston.db";
const HOSTED_BASE_DIR = "v2";
const IMPORTED_REASON = "imported from Houston 1";

const RUN_STATES = new Set([
  "preparing",
  "running",
  "waiting_for_input",
  "validating",
  "handed_back",
  "needs_review",
  "failed",
  "cancelled",
  "interrupted",
]);
const isStatus = Schema.is(HoustonTaskStatus);

type SqlValue = string | number | null;
type Row = Readonly<Record<string, SqlValue>>;

interface V1Snapshot {
  readonly nextNumber: number | null;
  readonly tasks: ReadonlyArray<Row>;
  readonly acceptance: ReadonlyArray<Row>;
  readonly comments: ReadonlyArray<Row>;
  readonly history: ReadonlyArray<Row>;
  readonly blocks: ReadonlyArray<Row>;
  readonly runs: ReadonlyArray<Row>;
  readonly projects: ReadonlyArray<Row>;
  readonly domains: ReadonlyArray<Row>;
  readonly settings: ReadonlyArray<Row>;
}

const SETTING_PREFIXES = [
  "tasks_access:",
  "tasks_start_agent:",
  "tasks_prompt_delivery:",
  "tasks_default_reviewer:",
  "tasks_rework_rounds:",
  "tasks_review_mode:",
  "tasks_review_focus:",
] as const;
type SettingPrefix = (typeof SETTING_PREFIXES)[number];

/** Every v1 row the import copies, read in one read transaction; v1 is never written. */
const readV1 = (path: string): V1Snapshot => {
  const db = new NodeSqlite.DatabaseSync(path, { readOnly: true });
  try {
    db.exec("BEGIN");
    try {
      const check = db.prepare("PRAGMA quick_check").all() as ReadonlyArray<Row>;
      const verdict = check.map((row) => String(Object.values(row)[0])).join("; ");
      if (verdict !== "ok") throw new Error(`database disk image is malformed: ${verdict}`);
      const tables = new Set(
        (
          db
            .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
            .all() as ReadonlyArray<Row>
        ).map((row) => String(row.name)),
      );
      const all = (table: string, order: string) =>
        tables.has(table)
          ? (db.prepare(`SELECT * FROM ${table} ORDER BY ${order}`).all() as ReadonlyArray<Row>)
          : [];
      const counter = tables.has("backlog_task_counters")
        ? (db.prepare("SELECT MAX(next_number) AS next FROM backlog_task_counters").get() as
            | Row
            | undefined)
        : undefined;
      return {
        nextNumber: typeof counter?.next === "number" ? counter.next : null,
        tasks: all("backlog_tasks", "id"),
        acceptance: all("backlog_task_acceptance", "task_id, position, id"),
        comments: all("backlog_task_comments", "id"),
        history: all("backlog_task_history", "id"),
        blocks: all("backlog_task_blocks", "task_id, blocked_by_id"),
        runs: all("backlog_task_runs", "id"),
        projects: all("backlog_projects", "id"),
        domains: all("backlog_task_domain", "task_id"),
        settings: tables.has("settings")
          ? (db
              .prepare("SELECT key, value FROM settings WHERE key LIKE 'tasks_%' ORDER BY key")
              .all() as ReadonlyArray<Row>)
          : [],
      };
    } finally {
      db.exec("COMMIT");
    }
  } finally {
    db.close();
  }
};

/** The v1 task count, or null when the file is not a v1 database with a backlog. */
const probeV1 = (path: string): number | null => {
  try {
    const db = new NodeSqlite.DatabaseSync(path, { readOnly: true });
    try {
      const table = db
        .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'backlog_tasks'")
        .get();
      if (table === undefined) return null;
      const row = db.prepare("SELECT COUNT(*) AS n FROM backlog_tasks").get() as Row;
      return Number(row.n);
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
};

/** Houston 1 stored times as Unix milliseconds. */
const iso = (ms: SqlValue | undefined) =>
  ms === null || ms === undefined ? null : DateTime.formatIso(DateTime.makeUnsafe(Number(ms)));

// Houston 1 stored its plan in snake_case.
const V1Plan = Schema.fromJsonString(
  Schema.Struct({
    revision: Schema.Number,
    proposal: Schema.Struct({
      description: Schema.String,
      acceptance: Schema.Array(Schema.String),
      pointers: Schema.Array(Schema.String),
      out_of_scope: Schema.Array(Schema.String),
      questions: Schema.Array(Schema.String),
    }),
    answers: Schema.Array(Schema.Struct({ question: Schema.String, answer: Schema.String })),
    approved_revision: Schema.optional(Schema.NullOr(Schema.Number)),
  }),
);
const decodeV1Plan = Schema.decodeUnknownOption(V1Plan);
const encodePlan = Schema.encodeUnknownOption(Schema.fromJsonString(HoustonTaskPlan));
const encodeCounts = Schema.encodeSync(Schema.fromJsonString(HoustonTaskImportCounts));
const decodeCounts = Schema.decodeUnknownSync(Schema.fromJsonString(HoustonTaskImportCounts));

/** An unreadable plan is dropped, as Houston 1 ignored one. */
const convertPlan = (raw: SqlValue | undefined) =>
  Option.getOrNull(
    Option.flatMap(decodeV1Plan(raw), (plan) =>
      encodePlan({
        revision: plan.revision,
        proposal: {
          description: plan.proposal.description,
          acceptance: plan.proposal.acceptance,
          pointers: plan.proposal.pointers,
          outOfScope: plan.proposal.out_of_scope,
          questions: plan.proposal.questions,
        },
        answers: plan.answers,
        approvedRevision: plan.approved_revision ?? null,
      }),
    ),
  );

// Houston 1 agent names that a v2 driver runs; other agents keep the default.
const V1_AGENT_DRIVERS: Readonly<Record<string, string>> = {
  claude: "claudeAgent",
  codex: "codex",
  opencode: "opencode",
};

const v1Agent = (agent: string | undefined): ModelSelection | undefined => {
  const driver = agent === undefined ? undefined : V1_AGENT_DRIVERS[agent];
  if (driver === undefined) return undefined;
  const kind = ProviderDriverKind.make(driver);
  const model = DEFAULT_MODEL_BY_PROVIDER[kind];
  return model === undefined ? undefined : { instanceId: defaultInstanceIdForDriver(kind), model };
};

const pick = <A extends string>(raw: string | undefined, allowed: ReadonlyArray<A>) =>
  allowed.find((value) => value === raw);

export class HoustonTaskV1Import extends Context.Service<
  HoustonTaskV1Import,
  {
    readonly status: Effect.Effect<HoustonTaskImportStatus>;
    readonly run: Effect.Effect<HoustonTaskImportResult, HoustonTaskError>;
  }
>()("t3/houston/tasks/V1Import/HoustonTaskV1Import") {}

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const sql = yield* SqlClient.SqlClient;
  const store = yield* HoustonTaskStore;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const platform = yield* HostProcess.Platform;

  const hosted = path.basename(config.baseDir) === HOSTED_BASE_DIR;
  const sourcePath = path.join(path.dirname(config.baseDir), V1_DATABASE);
  const source = Effect.gen(function* () {
    if (!hosted) return null;
    const exists = yield* fs.exists(sourcePath).pipe(Effect.orElseSucceed(() => false));
    return exists ? sourcePath : null;
  });

  const importRow = sql<{ readonly imported_at: string; readonly counts_json: string }>`
    SELECT imported_at, counts_json FROM houston_task_import WHERE id = 1
  `.pipe(
    Effect.map((rows) => rows[0]),
    Effect.orDie,
  );

  const backlogEmpty = Effect.gen(function* () {
    const count = yield* store.taskCount;
    const [counter] = yield* sql<{ readonly next_number: number }>`
      SELECT next_number FROM houston_task_counter WHERE id = 1
    `.pipe(Effect.orDie);
    return { count, empty: count === 0 && (counter?.next_number ?? 1) === 1 };
  });

  const status = Effect.gen(function* () {
    const previous = yield* importRow;
    if (previous !== undefined) {
      return {
        state: "imported" as const,
        at: previous.imported_at,
        counts: decodeCounts(previous.counts_json),
      };
    }
    const found = yield* source;
    const taskCount = found === null ? null : probeV1(found);
    if (found === null || taskCount === null) return { state: "unavailable" as const };
    const v2 = yield* backlogEmpty;
    if (!v2.empty) return { state: "blocked" as const, taskCount: v2.count };
    return { state: "available" as const, source: found, taskCount };
  });

  const copy = Effect.fn("HoustonTaskV1Import.copy")(
    function* (file: string, v1: V1Snapshot) {
      const now = yield* nowIso;
      const roots = (yield* projects.list().pipe(Effect.orDie)).filter(
        (project) => project.deletedAt === null,
      );
      const projectOf = (workspace: SqlValue | undefined) =>
        typeof workspace !== "string"
          ? null
          : (roots.find((project) => v1PathMatches(workspace, project.workspaceRoot, platform))
              ?.projectId ?? null);
      const unsupported = (message: string) => refuse("unsupported", OPERATION, message);

      const ids: Array<number> = [];
      let highest = 0;
      for (const task of v1.tasks) {
        const key = `HOU-${task.number}`;
        if (typeof task.status !== "string" || !isStatus(task.status)) {
          return yield* unsupported(
            `${key} has status ${String(task.status)}, which this version does not know`,
          );
        }
        const priority = priorityFromValue(Number(task.priority));
        if (priority === undefined) {
          return yield* unsupported(`${key} has priority ${task.priority} (expected 0 to 4)`);
        }
        highest = Math.max(highest, Number(task.number));
        ids.push(Number(task.id));
        yield* sql`
          INSERT INTO houston_tasks (
            id, number, project_id, title, description, status, priority, parent_id, ref_url,
            revision, created_by, created_at, updated_at, archived_at
          ) VALUES (
            ${task.id}, ${task.number}, ${projectOf(task.workspace)}, ${task.title},
            ${task.description}, ${task.status}, ${priorityValue(priority)}, ${task.parent_id},
            ${task.ref_url}, ${task.revision}, ${task.created_by}, ${iso(task.created_at)},
            ${iso(task.updated_at)}, ${iso(task.archived_at)}
          )
        `;
      }
      for (const item of v1.acceptance) {
        yield* sql`
          INSERT INTO houston_task_acceptance (task_id, position, text, checked_at, checked_by)
          VALUES (${item.task_id}, ${item.position}, ${item.text}, ${iso(item.checked_at)},
            ${item.checked_by})
        `;
      }
      for (const comment of v1.comments) {
        yield* sql`
          INSERT INTO houston_task_comments (task_id, body, author, created_at)
          VALUES (${comment.task_id}, ${comment.body}, ${comment.author},
            ${iso(comment.created_at)})
        `;
      }
      for (const entry of v1.history) {
        yield* sql`
          INSERT INTO houston_task_history (task_id, actor, action, changes, created_at)
          VALUES (${entry.task_id}, ${entry.actor}, ${entry.action}, ${entry.changes},
            ${iso(entry.created_at)})
        `;
      }
      for (const block of v1.blocks) {
        yield* sql`
          INSERT INTO houston_task_blocks (task_id, blocked_by_id)
          VALUES (${block.task_id}, ${block.blocked_by_id})
        `;
      }
      for (const run of v1.runs) {
        const state = String(run.state);
        if (!RUN_STATES.has(state) || (run.kind !== "implementation" && run.kind !== "review")) {
          return yield* unsupported(`run ${run.id} has kind ${run.kind} and state ${state}`);
        }
        // A v1 run is a pane, which this version cannot resume.
        const open = isOpenRun(state as Parameters<typeof isOpenRun>[0]);
        yield* sql`
          INSERT INTO houston_task_runs (
            id, task_id, attempt, kind, state, provider, reviewer, worktree_path, branch,
            base_commit, initial_revision, summary, reason, started_at, ended_at, pr_url,
            review_head_sha, review_focus, review_verdict, review_findings, review_skipped_reason
          ) VALUES (
            ${run.id}, ${run.task_id}, ${run.attempt}, ${run.kind},
            ${open ? "interrupted" : state}, ${run.provider}, ${run.reviewer},
            ${run.worktree_path}, ${run.branch}, ${run.base_commit}, ${run.initial_revision},
            ${run.summary}, ${open ? IMPORTED_REASON : run.reason}, ${iso(run.started_at)},
            ${open ? (iso(run.ended_at) ?? now) : iso(run.ended_at)}, ${run.pr_url},
            ${run.review_head_sha}, ${run.review_focus}, ${run.review_verdict},
            ${run.review_findings}, ${run.review_skipped_reason}
          )
        `;
      }
      for (const project of v1.projects) {
        yield* sql`
          INSERT INTO houston_task_initiatives (
            id, project_id, name, external_url, project_external_id, tracker_description,
            local_decisions, revision, updated_at, archived_at
          ) VALUES (
            ${project.id}, ${projectOf(project.workspace)}, ${project.name},
            ${project.external_url}, ${project.project_external_id},
            ${project.tracker_description}, ${project.local_decisions}, ${project.revision},
            ${iso(project.updated_at)}, ${iso(project.archived_at)}
          )
        `;
      }
      for (const domain of v1.domains) {
        yield* sql`
          INSERT INTO houston_task_domain (
            task_id, kind, initiative_id, user_status_override, plan_json, plan_revision,
            approved_task_revision, plan_context_bound, plan_initiative_id,
            plan_initiative_revision
          ) VALUES (
            ${domain.task_id}, ${domain.kind}, ${domain.project_id},
            ${domain.user_status_override}, ${convertPlan(domain.plan_json)},
            ${domain.plan_revision}, ${domain.approved_task_revision},
            ${domain.plan_context_bound ?? 0}, ${domain.plan_project_id ?? null},
            ${domain.plan_project_revision ?? null}
          )
        `;
      }

      const byProject = new Map<string, Partial<Record<SettingPrefix, string>>>();
      for (const setting of v1.settings) {
        const key = String(setting.key);
        const prefix = SETTING_PREFIXES.find((candidate) => key.startsWith(candidate));
        if (prefix === undefined) continue;
        const projectId = projectOf(key.slice(prefix.length));
        if (projectId === null) continue;
        byProject.set(projectId, { ...byProject.get(projectId), [prefix]: String(setting.value) });
      }
      for (const [projectId, values] of byProject) {
        const rounds = Number(values["tasks_rework_rounds:"]);
        const reviewer = values["tasks_default_reviewer:"];
        const startModel =
          v1Agent(values["tasks_start_agent:"]) ?? (v1Agent("claude") as ModelSelection);
        const reviewerModel = reviewer === "none" ? undefined : v1Agent(reviewer);
        yield* sql`
          INSERT INTO houston_task_settings (
            project_id, access, start_model, delivery, reviewer, review_mode, focus,
            rework_rounds, updated_at
          ) VALUES (
            ${projectId},
            ${pick(values["tasks_access:"], ["off", "read", "write"]) ?? "write"},
            ${encodeSelection(startModel)},
            ${pick(values["tasks_prompt_delivery:"], ["send", "prefill"]) ?? "send"},
            ${reviewerModel === undefined ? null : encodeSelection(reviewerModel)},
            ${pick(values["tasks_review_mode:"], ["manual", "handback", "every_push"]) ?? null},
            ${pick(values["tasks_review_focus:"], ["bugs", "security", "performance", "full"]) ?? "bugs"},
            ${
              Number.isInteger(rounds) && rounds >= 0 && rounds <= HOUSTON_TASK_LIMITS.reworkRounds
                ? rounds
                : 0
            },
            ${now}
          )
        `;
      }

      for (const task of v1.tasks) {
        yield* store.recordHistory(Number(task.id), "houston:imported", "houston:imported", {
          source: file,
          key: `HOU-${task.number}`,
          workspace: task.workspace,
          projectId: projectOf(task.workspace),
        });
      }
      const next = Math.max(v1.nextNumber ?? 1, highest + 1);
      yield* sql`UPDATE houston_task_counter SET next_number = ${next} WHERE id = 1`;
      const counts: HoustonTaskImportCounts = {
        tasks: v1.tasks.length,
        acceptance: v1.acceptance.length,
        comments: v1.comments.length,
        history: v1.history.length,
        blockers: v1.blocks.length,
        domains: v1.domains.length,
        initiatives: v1.projects.length,
        runs: v1.runs.length,
        settings: byProject.size,
      };
      yield* sql`
        INSERT INTO houston_task_import (id, source, imported_at, counts_json)
        VALUES (1, ${file}, ${now}, ${encodeCounts(counts)})
      `;
      return { result: { imported: counts }, touched: ids };
    },
    (effect, file) =>
      effect.pipe(
        Effect.catchTags({
          SqlError: (error) =>
            Effect.fail(
              refuse(
                "unsupported",
                OPERATION,
                `a row of the Houston 1 database at ${file} could not be copied: ${error.message}`,
              ),
            ),
        }),
      ),
  );

  const run = store.write(
    Effect.gen(function* () {
      const previous = yield* importRow;
      if (previous !== undefined) {
        return yield* refuse(
          "invalid",
          OPERATION,
          `Houston 1 tasks were already imported at ${previous.imported_at}`,
        );
      }
      const v2 = yield* backlogEmpty;
      if (!v2.empty) {
        return yield* refuse(
          "invalid",
          OPERATION,
          `the backlog already holds ${v2.count} task(s); the import needs an empty backlog`,
        );
      }
      const found = yield* source;
      if (found === null) {
        return yield* refuse(
          "unsupported",
          OPERATION,
          hosted
            ? `no Houston 1 database at ${sourcePath}`
            : `the base dir ${config.baseDir} is not a hosted <channel dir>/v2, so no Houston 1 database sits beside it`,
        );
      }
      const v1 = yield* Effect.try({
        try: () => readV1(found),
        catch: (cause) =>
          refuse(
            "unsupported",
            OPERATION,
            `could not read the Houston 1 database at ${found}: ${
              cause instanceof Error ? cause.message : String(cause)
            }`,
          ),
      });
      if (v1.tasks.length > HOUSTON_TASK_LIMITS.tasks) {
        return yield* refuse(
          "limit",
          OPERATION,
          `${v1.tasks.length} tasks is over the limit of ${HOUSTON_TASK_LIMITS.tasks} tasks`,
          { limit: HOUSTON_TASK_LIMITS.tasks, actual: v1.tasks.length },
        );
      }
      return yield* copy(found, v1);
    }),
  );

  return HoustonTaskV1Import.of({ status, run });
});

export const layer = Layer.effect(HoustonTaskV1Import, make);
