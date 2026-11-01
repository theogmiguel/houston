// @effect-diagnostics nodeBuiltinImport:off - reads a copy of Houston 1's SQLite file.
// The one-time import of Houston 1's Night shift. v1's database beside a hosted server's base dir
// is copied to a temporary directory and read there; v1 is never written. Settings arrive paused.
import * as NodeSqlite from "node:sqlite";

import {
  DEFAULT_MODEL_BY_PROVIDER,
  type ModelSelection,
  ProjectId,
  ProviderDriverKind,
  ScheduledTaskId,
  defaultInstanceIdForDriver,
} from "@t3tools/contracts";
import {
  HoustonNightShiftError,
  HoustonNightShiftSettings,
  NightImportCounts,
  type HoustonNightShiftImportResult,
  type HoustonNightShiftImportStatus,
  type NightFocusLevel,
} from "@t3tools/contracts/houston/nightShift";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerConfig from "../../config.ts";
import * as ProjectStore from "../../orchestration-v2/ProjectStore.ts";
import { HostedLaunch } from "../baseDir.ts";
import { v1PathMatches } from "../tasks/rules.ts";
import { defaultSettings } from "./rules.ts";
import { HoustonNightShiftStore, toJson } from "./Store.ts";

const OPERATION = "houston.nightShift.importV1.run";
const V1_DATABASE = "houston.db";
// SQLite keeps a WAL database's uncheckpointed pages and its index beside the file.
const V1_COMPANIONS = ["-wal", "-shm"] as const;
const IMPORTED_WHILE_RUNNING = "imported while running in v1";
const V1_LIVE_PHASES = new Set(["preflight", "running", "wrapping_up"]);
const V1_ENTRY_KINDS = new Set([
  "plan",
  "pr",
  "lesson",
  "decision",
  "deferred",
  "flaky",
  "studied",
]);

type SqlValue = string | number | null;
type Row = Readonly<Record<string, SqlValue>>;

interface V1Snapshot {
  readonly routines: ReadonlyArray<Row>;
  readonly runs: ReadonlyArray<Row>;
  readonly entries: ReadonlyArray<Row>;
}

/** v1's Night shift rows, read in one read transaction; null when the file has no Night shift. */
const readV1 = (path: string): V1Snapshot | null => {
  const db = new NodeSqlite.DatabaseSync(path, { readOnly: true });
  try {
    db.exec("BEGIN");
    try {
      const tables = new Set(
        (
          db
            .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
            .all() as ReadonlyArray<Row>
        ).map((row) => String(row.name)),
      );
      if (!tables.has("night_shift_settings") || !tables.has("routines")) return null;
      const all = (sql: string) => db.prepare(sql).all() as ReadonlyArray<Row>;
      return {
        routines: all(`SELECT s.routine_id, s.json, r.workspace_id FROM night_shift_settings s
          JOIN routines r ON r.id = s.routine_id ORDER BY s.routine_id`),
        runs: tables.has("night_runs") ? all("SELECT * FROM night_runs ORDER BY run_id") : [],
        entries: tables.has("night_entries") ? all("SELECT * FROM night_entries ORDER BY id") : [],
      };
    } finally {
      db.exec("COMMIT");
    }
  } finally {
    db.close();
  }
};

/** Houston 1 stored times as Unix milliseconds. */
const iso = (ms: SqlValue | undefined) =>
  ms === null || ms === undefined ? null : DateTime.formatIso(DateTime.makeUnsafe(Number(ms)));

const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));
const objectOf = (value: unknown): Record<string, any> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, any>)
    : {};
const isSettings = Schema.is(HoustonNightShiftSettings);
const encodeCounts = Schema.encodeSync(Schema.fromJsonString(NightImportCounts));
const decodeCounts = Schema.decodeUnknownSync(Schema.fromJsonString(NightImportCounts));

// v1 agent kinds a v2 driver runs; every other one is dropped with a note.
const V1_DRIVERS: Readonly<Record<string, string>> = {
  claude: "claudeAgent",
  codex: "codex",
  opencode: "opencode",
};
const V1_NAMES: Readonly<Record<string, string>> = {
  zcode: "ZCode",
  cursor: "Cursor",
  antigravity: "Antigravity",
  gemini: "Antigravity",
  grok: "Grok",
};

const selectionOf = (agent: unknown): ModelSelection | null => {
  const provider = objectOf(agent).provider;
  const driver = typeof provider === "string" ? V1_DRIVERS[provider] : undefined;
  if (driver === undefined) return null;
  const kind = ProviderDriverKind.make(driver);
  const model = objectOf(agent).model;
  return {
    instanceId: defaultInstanceIdForDriver(kind),
    model:
      typeof model === "string" && model.length > 0
        ? model
        : (DEFAULT_MODEL_BY_PROVIDER[kind] ?? "default"),
  };
};

const providerName = (agent: unknown) => {
  const provider = String(objectOf(agent).provider ?? "unknown");
  return V1_NAMES[provider] ?? provider;
};

const clock = (value: unknown, fallback: string) => {
  const { hour, minute } = objectOf(value);
  return typeof hour === "number" && typeof minute === "number"
    ? `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`
    : fallback;
};

const LEVELS = new Set(["off", "low", "normal", "high"]);
const level = (value: unknown, fallback: NightFocusLevel): NightFocusLevel =>
  typeof value === "string" && LEVELS.has(value) ? (value as NightFocusLevel) : fallback;

/** A v1 `{"v":2}` document as v2's `{v: 3}` settings, paused, with its start and nights and notes. */
export const convertV1Settings = (json: string, label: string) => {
  const notes: Array<string> = [];
  const doc = objectOf(Option.getOrUndefined(decodeJson(json)));
  const fallback = selectionOf({ provider: "claude" })!;
  let orchestrator = selectionOf(doc.orchestrator);
  if (orchestrator === null) {
    notes.push(
      `${label}: the orchestrator ${providerName(doc.orchestrator)} is not a v2 orchestrator; it takes the default Claude instance`,
    );
    orchestrator = fallback;
  }
  const workers: Array<ModelSelection> = [];
  for (const agent of Array.isArray(doc.workers) ? doc.workers : []) {
    const selection = selectionOf(agent);
    if (selection === null) {
      notes.push(`${label}: ${providerName(agent)} is not a v2 provider; dropped`);
    } else workers.push(selection);
  }
  if (workers.length === 0) workers.push(orchestrator);
  const reviewer = doc.reviewer == null ? null : selectionOf(doc.reviewer);
  if (doc.reviewer != null && reviewer === null) {
    notes.push(
      `${label}: the reviewer ${providerName(doc.reviewer)} is not a v2 provider; dropped`,
    );
  }
  const competitors: Array<{ repo: string }> = [];
  for (const competitor of Array.isArray(doc.competitors) ? doc.competitors : []) {
    const item = objectOf(competitor);
    if (item.kind === "repo" && typeof item.repo === "string")
      competitors.push({ repo: item.repo });
    else
      notes.push(
        `${label}: the app competitor ${String(item.name ?? "unnamed")} is not supported in v2; dropped`,
      );
  }
  const window = objectOf(doc.window);
  const focus = objectOf(doc.focus);
  const appQa = objectOf(doc.app_qa);
  const prSize = objectOf(doc.pr_size);
  const text = (value: unknown) =>
    typeof value === "string" && value.trim() !== "" ? value : null;
  const base = defaultSettings({ orchestrator, checks: [], startCommand: null });
  const settings = {
    ...base,
    enabled: false,
    window: { wrapUp: clock(window.wrap_up, "06:45"), hardStop: clock(window.hard_stop, "07:30") },
    focus: {
      reliability: level(focus.reliability, base.focus.reliability),
      performance: level(focus.performance, base.focus.performance),
      uiPolish: level(focus.ui_polish, base.focus.uiPolish),
      competitorGaps: level(focus.competitor_gaps, base.focus.competitorGaps),
      docsAccuracy: level(focus.docs_accuracy, base.focus.docsAccuracy),
      testGaps: level(focus.test_gaps, base.focus.testGaps),
    },
    direction: typeof doc.direction === "string" ? doc.direction : "",
    competitors,
    workers: workers.slice(0, 4),
    liveWorkers: typeof doc.live_workers === "number" ? doc.live_workers : base.liveWorkers,
    reviewer,
    output: doc.output === "merge_queue" ? ("mergeQueue" as const) : ("prs" as const),
    prSize:
      prSize.kind === "one"
        ? ({ kind: "one" } as const)
        : ({
            kind: "related",
            maxChanges: typeof prSize.max_changes === "number" ? prSize.max_changes : 5,
          } as const),
    screenshots: doc.screenshots !== false,
    appQa: {
      enabled: appQa.enabled === true,
      startCommand: text(appQa.start_command),
      source: text(appQa.source),
      address: text(appQa.address),
      smokeFlows: Array.isArray(appQa.smoke_flows)
        ? appQa.smoke_flows.filter((flow: unknown): flow is string => typeof flow === "string")
        : [],
    },
    holdForQa: doc.hold_for_qa !== false,
    checks: (Array.isArray(doc.checks) ? doc.checks : [])
      .map(objectOf)
      .filter((check) => typeof check.command === "string")
      .map((check) => ({
        command: check.command as string,
        source: typeof check.source === "string" ? check.source : "added by you",
      })),
    verification: doc.verification === "standard" ? ("standard" as const) : ("light" as const),
  };
  // v1 counts Sunday as 1; v2's weekdays count it as 0.
  const nights = (Array.isArray(window.nights) ? window.nights : [])
    .filter(
      (night: unknown): night is number => typeof night === "number" && night >= 1 && night <= 7,
    )
    .map((night: number) => night - 1);
  return {
    settings: isSettings(settings) ? settings : { ...base, enabled: false },
    schedule: {
      timeOfDay: clock(window.start, "23:30"),
      weekdays: nights as ReadonlyArray<number>,
    },
    notes,
  };
};

export type UpsertNightTask = (input: {
  readonly title: string;
  readonly projectId: ProjectId;
  readonly settings: HoustonNightShiftSettings;
  readonly schedule: { readonly timeOfDay: string; readonly weekdays: ReadonlyArray<number> };
  readonly baseRef: string;
  readonly operation: string;
}) => Effect.Effect<{ readonly task: { readonly id: ScheduledTaskId } }, HoustonNightShiftError>;

const fail = (kind: HoustonNightShiftError["kind"], message: string) =>
  Effect.fail(new HoustonNightShiftError({ kind, operation: OPERATION, message }));

/** The import's reads and writes; `upsertTask` saves a paused scheduled task as `create` does. */
export const makeV1Import = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const sql = yield* SqlClient.SqlClient;
  const store = yield* HoustonNightShiftStore;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const hosted = yield* HostedLaunch;
  const platform = Option.getOrElse(
    yield* Effect.serviceOption(HostProcess.Platform),
    () => process.platform,
  );
  const sourcePath = path.join(path.dirname(config.baseDir), V1_DATABASE);

  const source = Effect.gen(function* () {
    if (!hosted) return null;
    return (yield* fs.exists(sourcePath).pipe(Effect.orElseSucceed(() => false)))
      ? sourcePath
      : null;
  });

  /** Runs `read` on a temporary copy of v1's file and its companions. */
  const fromCopy = <A>(file: string, read: (copy: string) => A) =>
    Effect.scoped(
      Effect.gen(function* () {
        const dir = yield* fs.makeTempDirectoryScoped({ prefix: "houston-v1-night-" });
        const copy = path.join(dir, V1_DATABASE);
        yield* fs.copyFile(file, copy);
        for (const suffix of V1_COMPANIONS) {
          if (yield* fs.exists(`${file}${suffix}`))
            yield* fs.copyFile(`${file}${suffix}`, `${copy}${suffix}`);
        }
        return yield* Effect.try(() => read(copy));
      }),
    );

  const importRow = sql<{ readonly imported_at: string; readonly counts_json: string }>`
    SELECT imported_at, counts_json FROM houston_night_import WHERE id = 1`.pipe(
    Effect.map((rows) => rows[0]),
    Effect.orDie,
  );

  /** Why v2 cannot take an import: the projects it already holds Night shift rows for. */
  const v2Holds = Effect.gen(function* () {
    const held = yield* store.projects;
    return held.length === 0
      ? null
      : `v2 already holds Night shift settings or runs for ${held.join(", ")}; the import needs none`;
  });

  const liveRoots = Effect.map(projects.list().pipe(Effect.orDie), (rows) =>
    rows.filter((project) => project.deletedAt === null),
  );
  const projectOf = (
    roots: ReadonlyArray<{ readonly projectId: ProjectId; readonly workspaceRoot: string }>,
    workspace: SqlValue | undefined,
  ) =>
    typeof workspace !== "string"
      ? null
      : (roots.find((project) => v1PathMatches(workspace, project.workspaceRoot, platform))
          ?.projectId ?? null);

  const status: Effect.Effect<HoustonNightShiftImportStatus> = Effect.gen(function* () {
    const previous = yield* importRow;
    if (previous !== undefined) {
      return {
        state: "imported",
        at: previous.imported_at,
        counts: decodeCounts(previous.counts_json),
      };
    }
    const found = yield* source;
    const v1 =
      found === null ? null : yield* fromCopy(found, readV1).pipe(Effect.orElseSucceed(() => null));
    if (found === null || v1 === null) return { state: "unavailable" };
    const blocked = yield* v2Holds;
    if (blocked !== null) return { state: "blocked", reason: blocked };
    const roots = yield* liveRoots;
    const workspaces = v1.routines.map((routine) => ({
      path: String(routine.workspace_id),
      projectId: projectOf(roots, routine.workspace_id),
      runs: v1.runs.filter((run) => run.routine_id === routine.routine_id).length,
    }));
    return { state: "available", source: found, workspaces, runs: v1.runs.length };
  });

  const run = (
    upsertTask: UpsertNightTask,
  ): Effect.Effect<HoustonNightShiftImportResult, HoustonNightShiftError> =>
    Effect.gen(function* () {
      const previous = yield* importRow;
      if (previous !== undefined) {
        return yield* fail(
          "conflict",
          `Houston 1's Night shift was already imported at ${previous.imported_at}`,
        );
      }
      const found = yield* source;
      if (found === null) {
        return yield* fail(
          "not_found",
          hosted
            ? `no Houston 1 database at ${sourcePath}`
            : `the server is not hosted, so no Houston 1 ${V1_DATABASE} sits beside its base dir ${config.baseDir}`,
        );
      }
      const blocked = yield* v2Holds;
      if (blocked !== null) return yield* fail("conflict", blocked);
      const v1 = yield* fromCopy(found, readV1).pipe(
        Effect.catch((error) =>
          fail("not_found", `could not read the Houston 1 database at ${found}: ${String(error)}`),
        ),
      );
      if (v1 === null) return yield* fail("not_found", `${found} holds no Night shift`);
      const roots = yield* liveRoots;
      const now = DateTime.formatIso(yield* DateTime.now);
      const notes: Array<string> = [];
      const imported: Array<{
        readonly projectId: ProjectId;
        readonly title: string;
        readonly settings: HoustonNightShiftSettings;
        readonly schedule: { readonly timeOfDay: string; readonly weekdays: ReadonlyArray<number> };
      }> = [];
      const counts = { settings: 0, runs: 0, entries: 0 };

      yield* sql
        .withTransaction(
          Effect.gen(function* () {
            for (const routine of v1.routines) {
              const workspace = String(routine.workspace_id);
              const projectId = projectOf(roots, routine.workspace_id);
              if (projectId === null) {
                notes.push(`${workspace} is not a v2 project; its Night shift was not imported`);
                continue;
              }
              const converted = convertV1Settings(String(routine.json), workspace);
              notes.push(...converted.notes);
              yield* sql`INSERT INTO houston_night_shift_settings
                  (project_id, scheduled_task_id, settings_json, revision, updated_at)
                VALUES (${projectId}, NULL, ${toJson(converted.settings)}, 1, ${now})`;
              counts.settings += 1;
              const project = roots.find((root) => root.projectId === projectId)!;
              imported.push({
                projectId,
                title: project.title,
                settings: converted.settings,
                schedule: converted.schedule,
              });
              for (const old of v1.runs.filter((item) => item.routine_id === routine.routine_id)) {
                const interruptions = (() => {
                  const listed = Option.getOrUndefined(
                    decodeJson(String(old.interruptions_json ?? "[]")),
                  );
                  return (Array.isArray(listed) ? listed : []).map((item) => ({
                    at: iso(objectOf(item).at_ms) ?? now,
                    detail: String(objectOf(item).detail ?? ""),
                  }));
                })();
                if (V1_LIVE_PHASES.has(String(old.phase))) {
                  interruptions.push({ at: now, detail: IMPORTED_WHILE_RUNNING });
                }
                const [inserted] = yield* sql<{
                  readonly id: number;
                }>`INSERT INTO houston_night_runs
                    (project_id, trigger, phase, stop_reason, stop_detail, settings_json, started_at,
                     wrap_up_at, hard_stop_at, wrap_up_sent, ended_at, interruptions_json, summary,
                     notice_sent)
                  VALUES (${projectId}, 'imported', 'settled', 'imported',
                    ${old.stop_reason === null ? null : `v1: ${String(old.stop_reason)}`},
                    ${toJson(converted.settings)}, ${iso(old.started_at_ms) ?? now},
                    ${iso(old.wrap_up_at_ms)}, ${iso(old.hard_stop_at_ms)}, 1,
                    ${iso(old.ended_at_ms) ?? now}, ${toJson(interruptions)}, ${old.summary ?? null}, 1)
                  RETURNING id`;
                counts.runs += 1;
                for (const entry of v1.entries.filter((item) => item.run_id === old.run_id)) {
                  if (!V1_ENTRY_KINDS.has(String(entry.kind))) continue;
                  const detail = objectOf(
                    Option.getOrUndefined(decodeJson(String(entry.detail_json ?? "{}"))),
                  );
                  yield* sql`INSERT INTO houston_night_entries
                      (run_id, project_id, kind, title, theme, status, pr_number, visible, qa_passed,
                       body, detail_json, created_at, decided_at, choice)
                    VALUES (${inserted!.id}, ${projectId}, ${String(entry.kind)}, ${String(entry.title)},
                      ${entry.theme ?? null}, ${entry.status ?? null}, ${entry.pr_number ?? null},
                      ${Number(entry.visible ?? 0) === 1 ? 1 : 0}, ${Number(entry.qa_passed ?? 0) === 1 ? 1 : 0},
                      ${String(entry.body ?? "")}, ${toJson(detail)}, ${iso(entry.created_at_ms) ?? now},
                      ${iso(entry.decided_at_ms)}, ${entry.choice ?? null})`;
                  counts.entries += 1;
                }
              }
            }
            yield* sql`INSERT INTO houston_night_import (id, imported_at, counts_json)
              VALUES (1, ${now}, ${encodeCounts(counts)})`;
          }),
        )
        .pipe(
          Effect.catch((error) =>
            fail(
              "conflict",
              `the import could not be written and nothing was kept: ${String(error)}`,
            ),
          ),
        );

      // Each paused scheduled task, after the rows commit; a refusal leaves `create` to make one.
      for (const item of imported) {
        const saved = yield* upsertTask({
          title: `Night shift · ${item.title}`,
          projectId: item.projectId,
          settings: item.settings,
          schedule: item.schedule,
          baseRef: "HEAD",
          operation: OPERATION,
        }).pipe(Effect.result);
        if (saved._tag === "Failure") {
          notes.push(`${item.title}: ${saved.failure.message}; set it up again to schedule it`);
          continue;
        }
        yield* sql`UPDATE houston_night_shift_settings SET scheduled_task_id = ${saved.success.task.id}
          WHERE project_id = ${item.projectId}`.pipe(Effect.orDie);
        yield* PubSub.publish(store.changes, ProjectId.make(item.projectId));
      }
      return { imported: counts, notes };
    });

  return { status, run };
});
