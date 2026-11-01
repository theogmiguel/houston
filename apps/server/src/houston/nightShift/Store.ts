// @effect-diagnostics nodeBuiltinImport:off - one path join names the run folder for every caller.
// The Night shift tables. Every write publishes the project it touched after it commits, so
// subscribers see changes in commit order; a settled run's notice is published once.
import { ProjectId, ScheduledTaskId, ThreadId } from "@t3tools/contracts";
import {
  HoustonNightShiftError,
  HoustonNightShiftSettings,
  NightInterruption,
  PreflightItem,
  type NightCrewMember,
  type NightCrewRole,
  type NightEntryKind,
  type NightRun,
  type NightRunPhase,
  type NightRunTrigger,
  type NightStopReason,
} from "@t3tools/contracts/houston/nightShift";
import * as NodePath from "node:path";

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerConfig from "../../config.ts";

interface RunRow {
  readonly id: number;
  readonly project_id: string;
  readonly trigger: NightRunTrigger;
  readonly scheduled_task_id: string | null;
  readonly phase: NightRunPhase;
  readonly stop_reason: NightStopReason | null;
  readonly stop_detail: string | null;
  readonly orchestrator_thread_id: string | null;
  readonly worktree_path: string | null;
  readonly branch: string | null;
  readonly settings_json: string;
  readonly started_at: string;
  readonly wrap_up_at: string | null;
  readonly hard_stop_at: string | null;
  readonly wrap_up_sent: number;
  readonly nudged_at: string | null;
  readonly ended_at: string | null;
  readonly preflight_json: string;
  readonly limited_json: string;
  readonly remote_heads_json: string | null;
  readonly remote_changes_json: string | null;
  readonly cost_json: string | null;
  readonly interruptions_json: string;
  readonly summary: string | null;
  readonly report_path: string | null;
  readonly keep_awake: string | null;
  readonly notice_sent: number;
}

interface CrewRow {
  readonly run_id: number;
  readonly thread_id: string;
  readonly task_id: string | null;
  readonly parent_thread_id: string | null;
  readonly role: NightCrewRole;
  readonly provider_instance_id: string;
  readonly requested_instance_id: string | null;
  readonly worktree_path: string | null;
  readonly branch: string | null;
  readonly started_at: string;
  readonly ended_at: string | null;
}

export interface EntryRow {
  readonly id: number;
  readonly run_id: number;
  readonly kind: string;
  readonly title: string;
  readonly status: string | null;
  readonly pr_number: number | null;
  readonly choice: string | null;
}

/** A ledger entry with every column the toolkit, the brief and the report read. */
export interface LedgerEntry extends EntryRow {
  readonly project_id: string;
  readonly theme: string | null;
  readonly task_number: number | null;
  readonly head_sha: string | null;
  readonly branch: string | null;
  readonly body: string;
  readonly detail_json: string;
  readonly author_thread_id: string | null;
  readonly created_at: string;
  readonly decided_at: string | null;
  readonly visible: number;
  readonly qa_passed: number;
}

export interface NewEntry {
  readonly runId: number;
  readonly projectId: ProjectId;
  readonly kind: NightEntryKind;
  readonly title: string;
  readonly theme?: string | null;
  readonly status?: string | null;
  readonly prNumber?: number | null;
  readonly taskNumber?: number | null;
  readonly headSha?: string | null;
  readonly branch?: string | null;
  readonly visible?: boolean;
  readonly body?: string;
  readonly detail?: unknown;
  readonly authorThreadId?: ThreadId | null;
  readonly createdAt: string;
  /** An imported decision's answer. */
  readonly choice?: string | null;
  readonly decidedAt?: string | null;
}

/** What landing changes on a pull request entry; absent fields keep their value. */
export interface PullRequestPatch {
  readonly prNumber?: number;
  readonly headSha?: string;
  readonly branch?: string;
  readonly title?: string;
  readonly theme?: string;
  readonly body?: string;
  readonly status?: string | null;
  readonly visible?: boolean;
  readonly qaPassed?: boolean;
  readonly detail?: unknown;
}

export interface PushRow {
  readonly run_id: number;
  readonly branch: string;
  readonly old_sha: string | null;
  readonly new_sha: string;
  readonly pr_number: number | null;
  readonly at: string;
}

/** An instance limited for a run, from the readiness change until its reset passes. */
export interface NightLimit {
  readonly instanceId: string;
  readonly state: string;
  readonly resetsAt: string | null;
  readonly at: string;
  readonly clearedAt: string | null;
}

export interface StoredSettings {
  readonly settings: HoustonNightShiftSettings;
  readonly revision: number;
  readonly scheduledTaskId: ScheduledTaskId | null;
}

/** A run with what only the server reads. */
export interface StoredRun extends NightRun {
  readonly settings: HoustonNightShiftSettings;
  readonly nudgedAt: string | null;
  readonly remoteHeads: Readonly<Record<string, string>> | null;
  /** `{changes}` or `{error}` once the settle audit ran. */
  readonly remoteChanges: unknown;
  readonly cost: unknown;
  readonly noticeSent: boolean;
  readonly limited: ReadonlyArray<NightLimit>;
}

export interface Notice {
  readonly projectId: ProjectId;
  readonly runId: number;
  readonly headline: string;
}

export const LIVE_PHASES: ReadonlyArray<NightRunPhase> = ["preflight", "running", "wrappingUp"];

const decodeSettings = Schema.decodeUnknownSync(Schema.fromJsonString(HoustonNightShiftSettings));
const decodeItems = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Array(PreflightItem)));
const decodeInterruptions = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Array(NightInterruption)),
);
const decodeHeads = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.String)),
);
const decodeLimited = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Array(
      Schema.Struct({
        instanceId: Schema.String,
        state: Schema.String,
        resetsAt: Schema.NullOr(Schema.String),
        at: Schema.String,
        clearedAt: Schema.NullOr(Schema.String),
      }),
    ),
  ),
);
export const toJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

const toRun = (row: RunRow): StoredRun => ({
  id: row.id,
  projectId: ProjectId.make(row.project_id),
  trigger: row.trigger,
  scheduledTaskId:
    row.scheduled_task_id === null ? null : ScheduledTaskId.make(row.scheduled_task_id),
  phase: row.phase,
  stopReason: row.stop_reason,
  stopDetail: row.stop_detail,
  orchestratorThreadId:
    row.orchestrator_thread_id === null ? null : ThreadId.make(row.orchestrator_thread_id),
  worktreePath: row.worktree_path,
  branch: row.branch,
  startedAt: row.started_at,
  wrapUpAt: row.wrap_up_at,
  hardStopAt: row.hard_stop_at,
  wrapUpSent: row.wrap_up_sent === 1,
  endedAt: row.ended_at,
  preflight: decodeItems(row.preflight_json),
  interruptions: decodeInterruptions(row.interruptions_json),
  summary: row.summary,
  reportPath: row.report_path,
  keepAwake: row.keep_awake,
  settings: decodeSettings(row.settings_json),
  nudgedAt: row.nudged_at,
  remoteHeads: row.remote_heads_json === null ? null : decodeHeads(row.remote_heads_json),
  remoteChanges: row.remote_changes_json === null ? null : decodeJson(row.remote_changes_json),
  cost: row.cost_json === null ? null : decodeJson(row.cost_json),
  noticeSent: row.notice_sent === 1,
  limited: decodeLimited(row.limited_json),
});

const toCrew = (row: CrewRow): NightCrewMember => ({
  runId: row.run_id,
  threadId: ThreadId.make(row.thread_id),
  taskId: row.task_id,
  parentThreadId: row.parent_thread_id === null ? null : ThreadId.make(row.parent_thread_id),
  role: row.role,
  providerInstanceId: row.provider_instance_id,
  requestedInstanceId: row.requested_instance_id,
  worktreePath: row.worktree_path,
  branch: row.branch,
  startedAt: row.started_at,
  endedAt: row.ended_at,
});

/** Names a live run for a `busy` refusal. */
export const liveRunText = (run: Pick<NightRun, "id" | "projectId" | "phase">) =>
  `run ${run.id} of project ${run.projectId} is ${run.phase}`;

export class HoustonNightShiftStore extends Context.Service<
  HoustonNightShiftStore,
  {
    readonly settings: (projectId: ProjectId) => Effect.Effect<StoredSettings | undefined>;
    readonly projectOfTask: (taskId: ScheduledTaskId) => Effect.Effect<ProjectId | undefined>;
    readonly createSettings: (input: {
      readonly projectId: ProjectId;
      readonly settings: HoustonNightShiftSettings;
      readonly scheduledTaskId: ScheduledTaskId;
      readonly at: string;
    }) => Effect.Effect<void>;
    /** Writes when `expectedRevision` is current; otherwise answers the current revision. */
    readonly updateSettings: (input: {
      readonly projectId: ProjectId;
      readonly settings: HoustonNightShiftSettings;
      readonly expectedRevision: number;
      readonly at: string;
    }) => Effect.Effect<{ readonly written: boolean; readonly revision: number }>;
    /** Every project with settings, and its mapped task. */
    readonly allSettings: Effect.Effect<
      ReadonlyArray<{ readonly projectId: ProjectId; readonly stored: StoredSettings }>
    >;
    /** Opens a `preflight` run; `busy` names the project's live run when one exists. */
    readonly openRun: (input: {
      readonly projectId: ProjectId;
      readonly trigger: NightRunTrigger;
      readonly scheduledTaskId: ScheduledTaskId | null;
      readonly settings: HoustonNightShiftSettings;
      readonly startedAt: string;
      readonly wrapUpAt: string;
      readonly hardStopAt: string;
      readonly operation: string;
    }) => Effect.Effect<StoredRun, HoustonNightShiftError>;
    readonly getRun: (id: number) => Effect.Effect<StoredRun | undefined>;
    readonly runByThread: (threadId: ThreadId) => Effect.Effect<StoredRun | undefined>;
    /** Newest first. */
    readonly listRuns: (
      projectId: ProjectId,
      limit: number,
    ) => Effect.Effect<ReadonlyArray<StoredRun>>;
    readonly liveRuns: Effect.Effect<ReadonlyArray<StoredRun>>;
    readonly setPreflight: (id: number, items: ReadonlyArray<PreflightItem>) => Effect.Effect<void>;
    readonly refuse: (
      id: number,
      input: {
        readonly stopReason: NightStopReason | null;
        readonly detail: string;
        readonly endedAt: string;
      },
    ) => Effect.Effect<void>;
    readonly markRunning: (
      id: number,
      input: {
        readonly threadId: ThreadId;
        readonly worktreePath: string | null;
        readonly branch: string;
        readonly remoteHeads: Readonly<Record<string, string>> | null;
      },
    ) => Effect.Effect<void>;
    readonly setKeepAwake: (id: number, state: string) => Effect.Effect<void>;
    /** Moves a running run to `wrappingUp`; false when it was not running. */
    readonly markWrappingUp: (id: number, wrapUpAt: string) => Effect.Effect<boolean>;
    readonly setNudged: (id: number, at: string) => Effect.Effect<void>;
    readonly addInterruption: (id: number, interruption: NightInterruption) => Effect.Effect<void>;
    readonly setReport: (
      id: number,
      input: { readonly reportPath: string; readonly summary: string | null },
    ) => Effect.Effect<void>;
    readonly setRemoteChanges: (id: number, json: string) => Effect.Effect<void>;
    readonly setCost: (id: number, json: string) => Effect.Effect<void>;
    /** Settles a live run; false when it had already ended. */
    readonly settle: (
      id: number,
      input: {
        readonly stopReason: NightStopReason;
        readonly detail: string | null;
        readonly endedAt: string;
      },
    ) => Effect.Effect<boolean>;
    /** Marks the notice sent; false when it already was, so it is published once. */
    readonly claimNotice: (id: number) => Effect.Effect<boolean>;
    readonly addCrew: (member: NightCrewMember) => Effect.Effect<void>;
    readonly crew: (runId: number) => Effect.Effect<ReadonlyArray<NightCrewMember>>;
    readonly endCrew: (runId: number, threadId: ThreadId, at: string) => Effect.Effect<void>;
    readonly entries: (runId: number) => Effect.Effect<ReadonlyArray<EntryRow>>;
    /** The live run whose crew `threadId` is in, with its row; undefined outside every live run. */
    readonly liveCrewOf: (
      threadId: ThreadId,
    ) => Effect.Effect<{ readonly run: StoredRun; readonly member: NightCrewMember } | undefined>;
    readonly setLimited: (id: number, limited: ReadonlyArray<NightLimit>) => Effect.Effect<void>;
    readonly addEntry: (entry: NewEntry) => Effect.Effect<LedgerEntry>;
    /** Adds the entry only while its run is under both bounds, checked in the insert itself;
     * otherwise answers the run's entry and decision counts. */
    readonly addEntryWithin: (
      entry: NewEntry,
      bounds: { readonly entries: number; readonly decisions: number },
    ) => Effect.Effect<
      { readonly entry: LedgerEntry } | { readonly entries: number; readonly decisions: number }
    >;
    readonly getEntry: (id: number) => Effect.Effect<LedgerEntry | undefined>;
    readonly runEntries: (runId: number) => Effect.Effect<ReadonlyArray<LedgerEntry>>;
    /** Every entry of the project's runs other than `exceptRunId`, newest first. */
    readonly projectEntries: (
      projectId: ProjectId,
      exceptRunId: number,
    ) => Effect.Effect<ReadonlyArray<LedgerEntry>>;
    readonly setEntryStatus: (id: number, status: string) => Effect.Effect<void>;
    readonly updatePullRequest: (id: number, patch: PullRequestPatch) => Effect.Effect<void>;
    /** Stores the answer when the decision has none; false when it was answered already. */
    readonly decide: (id: number, choice: string, at: string) => Effect.Effect<boolean>;
    readonly addPush: (push: {
      readonly runId: number;
      readonly branch: string;
      readonly oldSha: string | null;
      readonly newSha: string;
      readonly prNumber: number | null;
      readonly at: string;
    }) => Effect.Effect<void>;
    readonly pushes: (runId: number) => Effect.Effect<ReadonlyArray<PushRow>>;
    /** The newest commit Houston pushed to `branch` for any run of the project, or null. */
    readonly lastPush: (projectId: ProjectId, branch: string) => Effect.Effect<string | null>;
    /** Replaces a run's settings copy. */
    readonly setRunSettings: (
      id: number,
      settings: HoustonNightShiftSettings,
    ) => Effect.Effect<void>;
    readonly runStarts: (projectId: ProjectId) => Effect.Effect<ReadonlyArray<string>>;
    readonly projects: Effect.Effect<ReadonlyArray<ProjectId>>;
    /** Deletes the project's settings, runs, crew, entries and pushes; answers the run ids. */
    readonly projectRemoved: (projectId: ProjectId) => Effect.Effect<ReadonlyArray<number>>;
    readonly changes: PubSub.PubSub<ProjectId>;
    readonly notices: PubSub.PubSub<Notice>;
  }
>()("houston/houston/nightShift/Store/HoustonNightShiftStore") {}

/** `<baseDir>/houston/night-shift/<run id>`: the run's brief and report, outside every checkout. */
export const runFolder = (baseDir: string, runId: number) =>
  NodePath.join(baseDir, "houston", "night-shift", String(runId));

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const fs = yield* FileSystem.FileSystem;
  const config = yield* ServerConfig.ServerConfig;
  const changes = yield* PubSub.unbounded<ProjectId>();
  const notices = yield* PubSub.unbounded<Notice>();
  const touched = (projectId: string) => PubSub.publish(changes, ProjectId.make(projectId));

  const getRun = (id: number) =>
    sql<RunRow>`SELECT * FROM houston_night_runs WHERE id = ${id}`.pipe(
      Effect.map((rows) => (rows[0] === undefined ? undefined : toRun(rows[0]))),
      Effect.orDie,
    );

  /** Runs `body`, then announces the run's project. */
  const writeRun = Effect.fn("HoustonNightShiftStore.writeRun")(function* <A, E>(
    id: number,
    body: Effect.Effect<A, E>,
  ) {
    const result = yield* body.pipe(Effect.orDie);
    const run = yield* getRun(id);
    if (run !== undefined) yield* touched(run.projectId);
    return result;
  });

  const liveOf = (projectId: string) =>
    sql<RunRow>`SELECT * FROM houston_night_runs
      WHERE project_id = ${projectId} AND phase IN ('preflight', 'running', 'wrappingUp')`.pipe(
      Effect.map((rows) => (rows[0] === undefined ? undefined : toRun(rows[0]))),
      Effect.orDie,
    );

  const settings: HoustonNightShiftStore["Service"]["settings"] = (projectId) =>
    sql<{ settings_json: string; revision: number; scheduled_task_id: string | null }>`
      SELECT settings_json, revision, scheduled_task_id FROM houston_night_shift_settings
      WHERE project_id = ${projectId}`.pipe(
      Effect.map((rows) =>
        rows[0] === undefined
          ? undefined
          : {
              settings: decodeSettings(rows[0].settings_json),
              revision: rows[0].revision,
              scheduledTaskId:
                rows[0].scheduled_task_id === null
                  ? null
                  : ScheduledTaskId.make(rows[0].scheduled_task_id),
            },
      ),
      Effect.orDie,
    );

  const changedRows = (rows: ReadonlyArray<unknown>) => rows.length > 0;

  return HoustonNightShiftStore.of({
    settings,
    projectOfTask: Effect.fn("HoustonNightShiftStore.projectOfTask")((taskId) =>
      sql<{ project_id: string }>`SELECT project_id FROM houston_night_shift_settings
        WHERE scheduled_task_id = ${taskId}`.pipe(
        Effect.map((rows) =>
          rows[0] === undefined ? undefined : ProjectId.make(rows[0].project_id),
        ),
        Effect.orDie,
      ),
    ),
    createSettings: Effect.fn("HoustonNightShiftStore.createSettings")((input) =>
      sql`INSERT INTO houston_night_shift_settings
          (project_id, scheduled_task_id, settings_json, revision, updated_at)
        VALUES (${input.projectId}, ${input.scheduledTaskId}, ${toJson(input.settings)}, 1, ${input.at})
        ON CONFLICT (project_id) DO UPDATE SET scheduled_task_id = excluded.scheduled_task_id,
          settings_json = excluded.settings_json, revision = houston_night_shift_settings.revision + 1,
          updated_at = excluded.updated_at`.pipe(
        Effect.orDie,
        Effect.andThen(touched(input.projectId)),
      ),
    ),
    updateSettings: Effect.fn("HoustonNightShiftStore.updateSettings")(function* (input) {
      const rows = yield* sql<{ revision: number }>`
        UPDATE houston_night_shift_settings
        SET settings_json = ${toJson(input.settings)}, revision = revision + 1,
          updated_at = ${input.at}
        WHERE project_id = ${input.projectId} AND revision = ${input.expectedRevision}
        RETURNING revision`.pipe(Effect.orDie);
      if (rows[0] !== undefined) {
        yield* touched(input.projectId);
        return { written: true, revision: rows[0].revision };
      }
      const current = yield* settings(input.projectId);
      return { written: false, revision: current?.revision ?? 0 };
    }),
    allSettings: sql<{
      project_id: string;
      settings_json: string;
      revision: number;
      scheduled_task_id: string | null;
    }>`SELECT * FROM houston_night_shift_settings ORDER BY project_id`.pipe(
      Effect.map((rows) =>
        rows.map((row) => ({
          projectId: ProjectId.make(row.project_id),
          stored: {
            settings: decodeSettings(row.settings_json),
            revision: row.revision,
            scheduledTaskId:
              row.scheduled_task_id === null ? null : ScheduledTaskId.make(row.scheduled_task_id),
          },
        })),
      ),
      Effect.orDie,
    ),
    openRun: Effect.fn("HoustonNightShiftStore.openRun")(function* (input) {
      const inserted = yield* sql<{ id: number }>`
        INSERT INTO houston_night_runs (project_id, trigger, scheduled_task_id, phase,
          settings_json, started_at, wrap_up_at, hard_stop_at)
        VALUES (${input.projectId}, ${input.trigger}, ${input.scheduledTaskId}, 'preflight',
          ${toJson(input.settings)}, ${input.startedAt}, ${input.wrapUpAt}, ${input.hardStopAt})
        RETURNING id`.pipe(Effect.result);
      if (inserted._tag === "Failure") {
        const live = yield* liveOf(input.projectId);
        if (live === undefined) return yield* Effect.die(inserted.failure);
        return yield* new HoustonNightShiftError({
          kind: "busy",
          operation: input.operation,
          message: `${liveRunText(live)}; one Night shift run per project is live at a time`,
          limit: 1,
          actual: 1,
        });
      }
      yield* touched(input.projectId);
      return (yield* getRun(inserted.success[0]!.id))!;
    }),
    getRun,
    runByThread: Effect.fn("HoustonNightShiftStore.runByThread")((threadId) =>
      sql<RunRow>`SELECT * FROM houston_night_runs WHERE orchestrator_thread_id = ${threadId}
        ORDER BY id DESC LIMIT 1`.pipe(
        Effect.map((rows) => (rows[0] === undefined ? undefined : toRun(rows[0]))),
        Effect.orDie,
      ),
    ),
    listRuns: Effect.fn("HoustonNightShiftStore.listRuns")((projectId, limit) =>
      sql<RunRow>`SELECT * FROM houston_night_runs WHERE project_id = ${projectId}
        ORDER BY id DESC LIMIT ${limit}`.pipe(
        Effect.map((rows) => rows.map(toRun)),
        Effect.orDie,
      ),
    ),
    liveRuns: sql<RunRow>`SELECT * FROM houston_night_runs
      WHERE phase IN ('preflight', 'running', 'wrappingUp') ORDER BY id`.pipe(
      Effect.map((rows) => rows.map(toRun)),
      Effect.orDie,
    ),
    setPreflight: Effect.fn("HoustonNightShiftStore.setPreflight")((id, items) =>
      writeRun(
        id,
        sql`UPDATE houston_night_runs SET preflight_json = ${toJson(items)} WHERE id = ${id}`,
      ),
    ),
    refuse: Effect.fn("HoustonNightShiftStore.refuse")((id, input) =>
      writeRun(
        id,
        sql`UPDATE houston_night_runs SET phase = 'refused', stop_reason = ${input.stopReason},
          stop_detail = ${input.detail}, ended_at = ${input.endedAt}
          WHERE id = ${id} AND phase IN ('preflight', 'running', 'wrappingUp')`,
      ),
    ),
    markRunning: Effect.fn("HoustonNightShiftStore.markRunning")((id, input) =>
      writeRun(
        id,
        sql`UPDATE houston_night_runs SET phase = 'running',
          orchestrator_thread_id = ${input.threadId}, worktree_path = ${input.worktreePath},
          branch = ${input.branch},
          remote_heads_json = ${input.remoteHeads === null ? null : toJson(input.remoteHeads)}
          WHERE id = ${id} AND phase = 'preflight'`,
      ),
    ),
    setKeepAwake: Effect.fn("HoustonNightShiftStore.setKeepAwake")((id, state) =>
      writeRun(id, sql`UPDATE houston_night_runs SET keep_awake = ${state} WHERE id = ${id}`),
    ),
    markWrappingUp: Effect.fn("HoustonNightShiftStore.markWrappingUp")((id, wrapUpAt) =>
      writeRun(
        id,
        sql<{ id: number }>`UPDATE houston_night_runs SET phase = 'wrappingUp', wrap_up_sent = 1,
          wrap_up_at = ${wrapUpAt} WHERE id = ${id} AND phase = 'running' RETURNING id`,
      ).pipe(Effect.map(changedRows)),
    ),
    setNudged: Effect.fn("HoustonNightShiftStore.setNudged")((id, at) =>
      writeRun(id, sql`UPDATE houston_night_runs SET nudged_at = ${at} WHERE id = ${id}`),
    ),
    addInterruption: Effect.fn("HoustonNightShiftStore.addInterruption")(
      function* (id, interruption) {
        const run = yield* getRun(id);
        if (run === undefined) return;
        const next = [...run.interruptions, interruption];
        yield* writeRun(
          id,
          sql`UPDATE houston_night_runs SET interruptions_json = ${toJson(next)} WHERE id = ${id}`,
        );
      },
    ),
    setReport: Effect.fn("HoustonNightShiftStore.setReport")((id, input) =>
      writeRun(
        id,
        sql`UPDATE houston_night_runs SET report_path = ${input.reportPath},
          summary = COALESCE(${input.summary}, summary) WHERE id = ${id}`,
      ),
    ),
    setRemoteChanges: Effect.fn("HoustonNightShiftStore.setRemoteChanges")((id, json) =>
      writeRun(
        id,
        sql`UPDATE houston_night_runs SET remote_changes_json = ${json} WHERE id = ${id}`,
      ),
    ),
    setCost: Effect.fn("HoustonNightShiftStore.setCost")((id, json) =>
      writeRun(id, sql`UPDATE houston_night_runs SET cost_json = ${json} WHERE id = ${id}`),
    ),
    settle: Effect.fn("HoustonNightShiftStore.settle")((id, input) =>
      writeRun(
        id,
        sql<{ id: number }>`UPDATE houston_night_runs SET phase = 'settled',
          stop_reason = ${input.stopReason}, stop_detail = ${input.detail},
          ended_at = ${input.endedAt}
          WHERE id = ${id} AND phase IN ('running', 'wrappingUp') RETURNING id`,
      ).pipe(Effect.map(changedRows)),
    ),
    claimNotice: Effect.fn("HoustonNightShiftStore.claimNotice")((id) =>
      sql<{ id: number }>`UPDATE houston_night_runs SET notice_sent = 1
        WHERE id = ${id} AND notice_sent = 0 RETURNING id`.pipe(
        Effect.map(changedRows),
        Effect.orDie,
      ),
    ),
    addCrew: Effect.fn("HoustonNightShiftStore.addCrew")((member) =>
      writeRun(
        member.runId,
        sql`INSERT INTO houston_night_crew (run_id, thread_id, task_id, parent_thread_id, role,
            provider_instance_id, requested_instance_id, worktree_path, branch, started_at, ended_at)
          VALUES (${member.runId}, ${member.threadId}, ${member.taskId}, ${member.parentThreadId},
            ${member.role}, ${member.providerInstanceId}, ${member.requestedInstanceId},
            ${member.worktreePath}, ${member.branch}, ${member.startedAt}, ${member.endedAt})
          ON CONFLICT (run_id, thread_id) DO NOTHING`,
      ),
    ),
    crew: Effect.fn("HoustonNightShiftStore.crew")((runId) =>
      sql<CrewRow>`SELECT * FROM houston_night_crew WHERE run_id = ${runId}
        ORDER BY started_at, thread_id`.pipe(
        Effect.map((rows) => rows.map(toCrew)),
        Effect.orDie,
      ),
    ),
    endCrew: Effect.fn("HoustonNightShiftStore.endCrew")((runId, threadId, at) =>
      writeRun(
        runId,
        sql`UPDATE houston_night_crew SET ended_at = ${at}
          WHERE run_id = ${runId} AND thread_id = ${threadId} AND ended_at IS NULL`,
      ),
    ),
    liveCrewOf: Effect.fn("HoustonNightShiftStore.liveCrewOf")(function* (threadId) {
      const rows = yield* sql<CrewRow>`SELECT c.* FROM houston_night_crew c
        JOIN houston_night_runs r ON r.id = c.run_id
        WHERE c.thread_id = ${threadId} AND r.phase IN ('running', 'wrappingUp')
        ORDER BY c.run_id DESC LIMIT 1`.pipe(Effect.orDie);
      const row = rows[0];
      if (row === undefined) return undefined;
      const run = yield* getRun(row.run_id);
      return run === undefined ? undefined : { run, member: toCrew(row) };
    }),
    setLimited: Effect.fn("HoustonNightShiftStore.setLimited")((id, limited) =>
      writeRun(
        id,
        sql`UPDATE houston_night_runs SET limited_json = ${toJson(limited)} WHERE id = ${id}`,
      ),
    ),
    addEntry: Effect.fn("HoustonNightShiftStore.addEntry")(function* (entry) {
      const inserted = yield* sql<LedgerEntry>`INSERT INTO houston_night_entries
          (run_id, project_id, kind, title, theme, status, pr_number, task_number, head_sha,
            branch, visible, body, detail_json, author_thread_id, created_at, choice, decided_at)
        VALUES (${entry.runId}, ${entry.projectId}, ${entry.kind}, ${entry.title},
          ${entry.theme ?? null}, ${entry.status ?? null}, ${entry.prNumber ?? null},
          ${entry.taskNumber ?? null}, ${entry.headSha ?? null}, ${entry.branch ?? null},
          ${entry.visible === true ? 1 : 0}, ${entry.body ?? ""}, ${toJson(entry.detail ?? {})},
          ${entry.authorThreadId ?? null}, ${entry.createdAt}, ${entry.choice ?? null},
          ${entry.decidedAt ?? null})
        RETURNING *`.pipe(Effect.orDie);
      yield* touched(entry.projectId);
      return inserted[0]!;
    }),
    addEntryWithin: Effect.fn("HoustonNightShiftStore.addEntryWithin")(function* (entry, bounds) {
      const decisionBound = entry.kind === "decision" ? bounds.decisions : Number.MAX_SAFE_INTEGER;
      const inserted = yield* sql<LedgerEntry>`INSERT INTO houston_night_entries
          (run_id, project_id, kind, title, theme, status, pr_number, task_number, body,
            detail_json, author_thread_id, created_at)
        SELECT ${entry.runId}, ${entry.projectId}, ${entry.kind}, ${entry.title},
          ${entry.theme ?? null}, ${entry.status ?? null}, ${entry.prNumber ?? null},
          ${entry.taskNumber ?? null}, ${entry.body ?? ""}, ${toJson(entry.detail ?? {})},
          ${entry.authorThreadId ?? null}, ${entry.createdAt}
        WHERE (SELECT COUNT(*) FROM houston_night_entries WHERE run_id = ${entry.runId})
            < ${bounds.entries}
          AND (SELECT COUNT(*) FROM houston_night_entries
            WHERE run_id = ${entry.runId} AND kind = 'decision') < ${decisionBound}
        RETURNING *`.pipe(Effect.orDie);
      if (inserted[0] !== undefined) {
        yield* touched(entry.projectId);
        return { entry: inserted[0] };
      }
      const [counts] = yield* sql<{ entries: number; decisions: number }>`SELECT
          COUNT(*) AS entries,
          COALESCE(SUM(CASE WHEN kind = 'decision' THEN 1 ELSE 0 END), 0) AS decisions
        FROM houston_night_entries WHERE run_id = ${entry.runId}`.pipe(Effect.orDie);
      return { entries: counts?.entries ?? 0, decisions: counts?.decisions ?? 0 };
    }),
    getEntry: Effect.fn("HoustonNightShiftStore.getEntry")((id) =>
      sql<LedgerEntry>`SELECT * FROM houston_night_entries WHERE id = ${id}`.pipe(
        Effect.map((rows) => rows[0]),
        Effect.orDie,
      ),
    ),
    runEntries: Effect.fn("HoustonNightShiftStore.runEntries")((runId) =>
      sql<LedgerEntry>`SELECT * FROM houston_night_entries WHERE run_id = ${runId}
        ORDER BY id`.pipe(Effect.orDie),
    ),
    projectEntries: Effect.fn("HoustonNightShiftStore.projectEntries")((projectId, exceptRunId) =>
      sql<LedgerEntry>`SELECT * FROM houston_night_entries
        WHERE project_id = ${projectId} AND run_id <> ${exceptRunId}
        ORDER BY id DESC`.pipe(Effect.orDie),
    ),
    setEntryStatus: Effect.fn("HoustonNightShiftStore.setEntryStatus")(function* (id, status) {
      const rows = yield* sql<{ project_id: string }>`UPDATE houston_night_entries
        SET status = ${status} WHERE id = ${id} RETURNING project_id`.pipe(Effect.orDie);
      if (rows[0] !== undefined) yield* touched(rows[0].project_id);
    }),
    updatePullRequest: Effect.fn("HoustonNightShiftStore.updatePullRequest")(function* (id, patch) {
      const current = yield* sql<LedgerEntry>`SELECT * FROM houston_night_entries
        WHERE id = ${id}`.pipe(Effect.orDie);
      const row = current[0];
      if (row === undefined) return;
      const flag = (value: boolean | undefined, kept: number) =>
        value === undefined ? kept : value ? 1 : 0;
      yield* sql`UPDATE houston_night_entries SET
          pr_number = ${patch.prNumber ?? row.pr_number},
          head_sha = ${patch.headSha ?? row.head_sha},
          branch = ${patch.branch ?? row.branch},
          title = ${patch.title ?? row.title},
          theme = ${patch.theme ?? row.theme},
          body = ${patch.body ?? row.body},
          status = ${patch.status === undefined ? row.status : patch.status},
          visible = ${flag(patch.visible, row.visible)},
          qa_passed = ${flag(patch.qaPassed, row.qa_passed)},
          detail_json = ${patch.detail === undefined ? row.detail_json : toJson(patch.detail)}
        WHERE id = ${id}`.pipe(Effect.orDie);
      yield* touched(row.project_id);
    }),
    decide: Effect.fn("HoustonNightShiftStore.decide")(function* (id, choice, at) {
      const rows = yield* sql<{ project_id: string }>`UPDATE houston_night_entries
        SET choice = ${choice}, decided_at = ${at}, status = 'answered'
        WHERE id = ${id} AND kind = 'decision' AND choice IS NULL
        RETURNING project_id`.pipe(Effect.orDie);
      if (rows[0] === undefined) return false;
      yield* touched(rows[0].project_id);
      return true;
    }),
    addPush: Effect.fn("HoustonNightShiftStore.addPush")((push) =>
      writeRun(
        push.runId,
        sql`INSERT INTO houston_night_pushes (run_id, branch, old_sha, new_sha, pr_number, at)
          VALUES (${push.runId}, ${push.branch}, ${push.oldSha}, ${push.newSha}, ${push.prNumber},
            ${push.at})
          ON CONFLICT (run_id, branch, new_sha) DO UPDATE SET pr_number = excluded.pr_number`,
      ),
    ),
    pushes: Effect.fn("HoustonNightShiftStore.pushes")((runId) =>
      sql<PushRow>`SELECT * FROM houston_night_pushes WHERE run_id = ${runId}
        ORDER BY at, rowid`.pipe(Effect.orDie),
    ),
    lastPush: Effect.fn("HoustonNightShiftStore.lastPush")((projectId, branch) =>
      sql<{ new_sha: string }>`SELECT p.new_sha FROM houston_night_pushes p
        JOIN houston_night_runs r ON r.id = p.run_id
        WHERE r.project_id = ${projectId} AND p.branch = ${branch}
        ORDER BY p.at DESC, p.rowid DESC LIMIT 1`.pipe(
        Effect.map((rows) => rows[0]?.new_sha ?? null),
        Effect.orDie,
      ),
    ),
    setRunSettings: Effect.fn("HoustonNightShiftStore.setRunSettings")((id, next) =>
      writeRun(
        id,
        sql`UPDATE houston_night_runs SET settings_json = ${toJson(next)} WHERE id = ${id}`,
      ),
    ),
    entries: Effect.fn("HoustonNightShiftStore.entries")((runId) =>
      sql<EntryRow>`SELECT id, run_id, kind, title, status, pr_number, choice
        FROM houston_night_entries WHERE run_id = ${runId} ORDER BY id`.pipe(Effect.orDie),
    ),
    runStarts: Effect.fn("HoustonNightShiftStore.runStarts")((projectId) =>
      sql<{ started_at: string }>`SELECT started_at FROM houston_night_runs
        WHERE project_id = ${projectId}`.pipe(
        Effect.map((rows) => rows.map((row) => row.started_at)),
        Effect.orDie,
      ),
    ),
    projects: sql<{ project_id: string }>`
      SELECT project_id FROM houston_night_shift_settings
      UNION SELECT project_id FROM houston_night_runs ORDER BY project_id`.pipe(
      Effect.map((rows) => rows.map((row) => ProjectId.make(row.project_id))),
      Effect.orDie,
    ),
    projectRemoved: Effect.fn("HoustonNightShiftStore.projectRemoved")(function* (projectId) {
      const runs = yield* sql
        .withTransaction(
          Effect.gen(function* () {
            const ids = (yield* sql<{ id: number }>`
              SELECT id FROM houston_night_runs WHERE project_id = ${projectId}`).map(
              (row) => row.id,
            );
            if (ids.length > 0) {
              yield* sql`DELETE FROM houston_night_crew WHERE run_id IN ${sql.in(ids)}`;
              yield* sql`DELETE FROM houston_night_pushes WHERE run_id IN ${sql.in(ids)}`;
            }
            yield* sql`DELETE FROM houston_night_entries WHERE project_id = ${projectId}`;
            yield* sql`DELETE FROM houston_night_runs WHERE project_id = ${projectId}`;
            yield* sql`DELETE FROM houston_night_shift_settings WHERE project_id = ${projectId}`;
            return ids;
          }),
        )
        .pipe(Effect.orDie);
      for (const id of runs) {
        yield* fs
          .remove(runFolder(config.baseDir, id), { recursive: true, force: true })
          .pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("Could not remove a Night shift run folder", { id, cause }),
            ),
          );
      }
      yield* touched(projectId);
      return runs;
    }),
    changes,
    notices,
  });
});

export const layer = Layer.effect(HoustonNightShiftStore, make);
