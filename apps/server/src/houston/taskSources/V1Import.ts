// The one-time import of Houston 1's task source connections, after the Tasks import. Like it,
// v1's database is read from a temporary copy and never written. No keychain entry is read:
// sources arrive disabled, and a Notion source asks for its token again.
import * as NodeSqlite from "node:sqlite";

import {
  HoustonTaskSourceImportCounts,
  HoustonTaskSourceSnapshot,
  HoustonTaskSourceSyncState,
  type HoustonTaskSourceError,
  type HoustonTaskSourceImportResult,
  type HoustonTaskSourceImportStatus,
} from "@t3tools/contracts/houston/taskSources";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as HostProcess from "@t3tools/shared/HostProcess";
import * as ServerConfig from "../../config.ts";
import * as ProjectStore from "../../orchestration-v2/ProjectStore.ts";
import { HostedLaunch } from "../baseDir.ts";
import { v1PathMatches } from "../tasks/rules.ts";
import { nowIso } from "../tasks/TaskStore.ts";
import { refuse, storedSettings, type StoredSettings } from "./rules.ts";
import { HoustonTaskSourceStore, encodeSettings } from "./SourceStore.ts";

const OPERATION = "houston.taskSources.importV1.run";
const V1_DATABASE = "houston.db";
const V1_COMPANIONS = ["-wal", "-shm"] as const;
const PROVIDERS = new Set(["github_issues", "notion"]);

type SqlValue = string | number | null;
type Row = Readonly<Record<string, SqlValue>>;

interface V1Trackers {
  readonly settings: ReadonlyArray<Row>;
  readonly links: ReadonlyArray<Row>;
  readonly namespace: string | null;
  readonly outbox: number;
  readonly pollState: number;
  readonly refreshCursors: number;
}

const readV1 = (path: string): V1Trackers | null => {
  const db = new NodeSqlite.DatabaseSync(path, { readOnly: true });
  try {
    const tables = new Set(
      (
        db
          .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
          .all() as ReadonlyArray<Row>
      ).map((row) => String(row.name)),
    );
    if (!tables.has("task_tracker_settings")) return null;
    const all = (table: string, order: string) =>
      tables.has(table)
        ? (db.prepare(`SELECT * FROM ${table} ORDER BY ${order}`).all() as ReadonlyArray<Row>)
        : [];
    const count = (table: string) =>
      tables.has(table)
        ? Number((db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as Row).n)
        : 0;
    const identity = tables.has("task_tracker_database_identity")
      ? (db
          .prepare("SELECT namespace FROM task_tracker_database_identity WHERE singleton = 1")
          .get() as Row | undefined)
      : undefined;
    return {
      settings: all("task_tracker_settings", "workspace, provider"),
      links: all("task_external_links", "task_id, provider, external_id, source"),
      namespace: typeof identity?.namespace === "string" ? identity.namespace : null,
      outbox: count("task_tracker_outbox"),
      pollState: count("task_tracker_poll_state"),
      refreshCursors: count("task_tracker_refresh_cursor"),
    };
  } finally {
    db.close();
  }
};

const iso = (ms: SqlValue | undefined) =>
  typeof ms === "number" ? DateTime.formatIso(DateTime.makeUnsafe(ms)) : null;

// Houston 1 wrote its settings and snapshots in snake_case.
const V1SettingsJson = Schema.fromJsonString(
  Schema.Struct({
    github_repository: Schema.optional(Schema.NullOr(Schema.String)),
    github_label: Schema.optional(Schema.NullOr(Schema.String)),
    github_assigned_user: Schema.optional(Schema.NullOr(Schema.String)),
    notion_data_source_id: Schema.optional(Schema.NullOr(Schema.String)),
    notion_title_property_id: Schema.optional(Schema.NullOr(Schema.String)),
    notion_description_property_id: Schema.optional(Schema.NullOr(Schema.String)),
    notion_status_property_id: Schema.optional(Schema.NullOr(Schema.String)),
    notion_assignee_property_id: Schema.optional(Schema.NullOr(Schema.String)),
    notion_project_relation_property_id: Schema.optional(Schema.NullOr(Schema.String)),
    notion_assignee_user_id: Schema.optional(Schema.NullOr(Schema.String)),
    notion_active_status_values: Schema.optional(Schema.Array(Schema.String)),
    notion_projects_data_source_id: Schema.optional(Schema.NullOr(Schema.String)),
    notion_project_title_property_id: Schema.optional(Schema.NullOr(Schema.String)),
    notion_project_description_property_id: Schema.optional(Schema.NullOr(Schema.String)),
    notion_pr_url_property_id: Schema.optional(Schema.NullOr(Schema.String)),
    notion_status_mapping: Schema.optional(
      Schema.Struct({
        todo: Schema.optional(Schema.NullOr(Schema.String)),
        in_progress: Schema.optional(Schema.NullOr(Schema.String)),
        in_review: Schema.optional(Schema.NullOr(Schema.String)),
        done: Schema.optional(Schema.NullOr(Schema.String)),
        canceled: Schema.optional(Schema.NullOr(Schema.String)),
      }),
    ),
  }),
);
const decodeV1Settings = Schema.decodeUnknownSync(V1SettingsJson);

const V1Project = Schema.Struct({
  external_id: Schema.String,
  url: Schema.String,
  title: Schema.String,
  description: Schema.String,
  unverified: Schema.Boolean,
});
const V1SnapshotJson = Schema.fromJsonString(
  Schema.Struct({
    base: Schema.Record(Schema.String, Schema.String),
    local: Schema.Record(Schema.String, Schema.String),
    remote: Schema.Record(Schema.String, Schema.String),
    conflicts: Schema.Array(
      Schema.Struct({
        field: Schema.String,
        base: Schema.String,
        local: Schema.String,
        remote: Schema.String,
      }),
    ),
    revision: Schema.Number,
    project_external_id: Schema.optional(Schema.NullOr(Schema.String)),
    project: Schema.optional(Schema.NullOr(V1Project)),
  }),
);
const decodeV1Snapshot = Schema.decodeUnknownSync(V1SnapshotJson);
const encodeSnapshot = Schema.encodeSync(Schema.fromJsonString(HoustonTaskSourceSnapshot));
const decodeSyncState = Schema.decodeUnknownSync(Schema.fromJsonString(HoustonTaskSourceSyncState));
const encodeSyncState = Schema.encodeSync(Schema.fromJsonString(HoustonTaskSourceSyncState));
const encodeCounts = Schema.encodeSync(Schema.fromJsonString(HoustonTaskSourceImportCounts));
const decodeCounts = Schema.decodeUnknownSync(Schema.fromJsonString(HoustonTaskSourceImportCounts));

const convertSettings = (raw: string): StoredSettings => {
  const v1 = decodeV1Settings(raw);
  const mapping = v1.notion_status_mapping;
  return storedSettings({
    enabled: false,
    githubRepository: v1.github_repository ?? null,
    githubLabel: v1.github_label ?? null,
    githubAssignedUser: v1.github_assigned_user ?? null,
    notionDataSourceId: v1.notion_data_source_id ?? null,
    notionTitlePropertyId: v1.notion_title_property_id ?? null,
    notionDescriptionPropertyId: v1.notion_description_property_id ?? null,
    notionStatusPropertyId: v1.notion_status_property_id ?? null,
    notionAssigneePropertyId: v1.notion_assignee_property_id ?? null,
    notionProjectRelationPropertyId: v1.notion_project_relation_property_id ?? null,
    notionAssigneeUserId: v1.notion_assignee_user_id ?? null,
    notionActiveStatusValues: v1.notion_active_status_values ?? [],
    notionProjectsDataSourceId: v1.notion_projects_data_source_id ?? null,
    notionProjectTitlePropertyId: v1.notion_project_title_property_id ?? null,
    notionProjectDescriptionPropertyId: v1.notion_project_description_property_id ?? null,
    notionPrUrlPropertyId: v1.notion_pr_url_property_id ?? null,
    notionStatusMapping: {
      todo: mapping?.todo ?? null,
      inProgress: mapping?.in_progress ?? null,
      inReview: mapping?.in_review ?? null,
      done: mapping?.done ?? null,
      canceled: mapping?.canceled ?? null,
    },
  });
};

const convertSnapshot = (raw: string) => {
  const v1 = decodeV1Snapshot(raw);
  return encodeSnapshot({
    base: v1.base,
    local: v1.local,
    remote: v1.remote,
    conflicts: v1.conflicts,
    revision: Math.max(1, Math.trunc(v1.revision)),
    projectExternalId: v1.project_external_id ?? null,
    project:
      v1.project === undefined || v1.project === null
        ? null
        : {
            externalId: v1.project.external_id,
            url: v1.project.url,
            title: v1.project.title,
            description: v1.project.description,
            unverified: v1.project.unverified,
          },
  });
};

/** v1 stored a sync state as a JSON object or, from its column default, a bare word. */
const convertSyncState = (raw: SqlValue | undefined) =>
  encodeSyncState(
    typeof raw === "string" && !raw.trimStart().startsWith("{")
      ? decodeSyncState(JSON.stringify({ state: raw }))
      : decodeSyncState(raw),
  );

const causeMessage = (error: unknown) => {
  let inner = error;
  while (inner instanceof Error && inner.cause instanceof Error) inner = inner.cause;
  return inner instanceof Error ? inner.message : String(inner);
};

export class HoustonTaskSourceV1Import extends Context.Service<
  HoustonTaskSourceV1Import,
  {
    readonly status: Effect.Effect<HoustonTaskSourceImportStatus>;
    readonly run: Effect.Effect<HoustonTaskSourceImportResult, HoustonTaskSourceError>;
  }
>()("houston/houston/taskSources/V1Import/HoustonTaskSourceV1Import") {}

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const sql = yield* SqlClient.SqlClient;
  const store = yield* HoustonTaskSourceStore;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const platform = yield* HostProcess.Platform;
  const hosted = yield* HostedLaunch;

  const sourcePath = path.join(path.dirname(config.baseDir), V1_DATABASE);
  const source = Effect.gen(function* () {
    if (!hosted) return null;
    const exists = yield* fs.exists(sourcePath).pipe(Effect.orElseSucceed(() => false));
    return exists ? sourcePath : null;
  });

  const fromCopy = (file: string) =>
    Effect.scoped(
      Effect.gen(function* () {
        const dir = yield* fs.makeTempDirectoryScoped({ prefix: "houston-v1-sources-" });
        const copy = path.join(dir, V1_DATABASE);
        yield* fs.copyFile(file, copy);
        for (const suffix of V1_COMPANIONS) {
          if (yield* fs.exists(`${file}${suffix}`)) {
            yield* fs.copyFile(`${file}${suffix}`, `${copy}${suffix}`);
          }
        }
        return yield* Effect.try(() => readV1(copy));
      }),
    );

  const importRow = sql<{ readonly imported_at: string; readonly counts_json: string }>`
    SELECT imported_at, counts_json FROM houston_task_source_import WHERE id = 1
  `.pipe(
    Effect.map((rows) => rows[0]),
    Effect.orDie,
  );

  /** Why the import cannot run now, or null. */
  const blocked = Effect.gen(function* () {
    const [tasks] = yield* sql`SELECT 1 FROM houston_task_import WHERE id = 1`.pipe(Effect.orDie);
    if (tasks === undefined) {
      return "the Houston 1 tasks import has not run; import tasks first";
    }
    const [counts] = yield* sql<{ readonly settings: number; readonly links: number }>`
      SELECT (SELECT COUNT(*) FROM houston_task_source_settings) AS settings,
        (SELECT COUNT(*) FROM houston_task_source_links) AS links
    `.pipe(Effect.orDie);
    if ((counts?.settings ?? 0) > 0 || (counts?.links ?? 0) > 0) {
      return `v2 already holds ${counts?.settings ?? 0} task source setting(s) and ${counts?.links ?? 0} link(s)`;
    }
    return null;
  });

  const status: HoustonTaskSourceV1Import["Service"]["status"] = Effect.gen(function* () {
    const previous = yield* importRow;
    if (previous !== undefined) {
      return {
        state: "imported" as const,
        at: previous.imported_at,
        counts: decodeCounts(previous.counts_json),
      };
    }
    const found = yield* source;
    const v1 =
      found === null ? null : yield* fromCopy(found).pipe(Effect.orElseSucceed(() => null));
    if (found === null || v1 === null) return { state: "unavailable" as const };
    const reason = yield* blocked;
    if (reason !== null) return { state: "blocked" as const, reason };
    return {
      state: "available" as const,
      source: found,
      settings: v1.settings.filter((row) => PROVIDERS.has(String(row.provider))).length,
      links: v1.links.filter((row) => PROVIDERS.has(String(row.provider))).length,
    };
  });

  const run: HoustonTaskSourceV1Import["Service"]["run"] = store.write(
    Effect.gen(function* () {
      const previous = yield* importRow;
      if (previous !== undefined) {
        return yield* refuse(
          "invalid",
          OPERATION,
          `Houston 1 task sources were already imported at ${previous.imported_at}`,
        );
      }
      const reason = yield* blocked;
      if (reason !== null) return yield* refuse("invalid", OPERATION, reason);
      const found = yield* source;
      if (found === null) {
        return yield* refuse(
          "unsupported",
          OPERATION,
          hosted
            ? `no Houston 1 database at ${sourcePath}`
            : `the server is not hosted, so no Houston 1 database sits beside its base dir ${config.baseDir}`,
        );
      }
      const v1 = yield* fromCopy(found).pipe(
        Effect.mapError((error) =>
          refuse(
            "unsupported",
            OPERATION,
            `could not read the Houston 1 database at ${found}: ${causeMessage(error)}`,
          ),
        ),
      );
      if (v1 === null) {
        return yield* refuse(
          "unsupported",
          OPERATION,
          `the Houston 1 database at ${found} has no task sources`,
        );
      }
      const now = yield* nowIso;
      const notes: Array<string> = [];
      const failed = (table: string, key: string) => (error: unknown) =>
        refuse(
          "unsupported",
          OPERATION,
          `${table} row ${key} of the Houston 1 database at ${found} could not be copied: ${causeMessage(error)}`,
        );
      const roots = (yield* projects.list().pipe(Effect.orDie)).filter(
        (project) => project.deletedAt === null,
      );
      const projectOf = (workspace: SqlValue | undefined) =>
        typeof workspace !== "string"
          ? null
          : (roots.find((project) => v1PathMatches(workspace, project.workspaceRoot, platform))
              ?.projectId ?? null);

      let settings = 0;
      let unmatched = 0;
      let slack = 0;
      for (const row of v1.settings) {
        const key = `${String(row.workspace)} ${String(row.provider)}`;
        if (!PROVIDERS.has(String(row.provider))) {
          slack += 1;
          continue;
        }
        const projectId = projectOf(row.workspace);
        if (projectId === null) {
          unmatched += 1;
          continue;
        }
        const converted = yield* Effect.try({
          try: () => convertSettings(String(row.settings)),
          catch: failed("task_tracker_settings", key),
        });
        yield* sql`
          INSERT INTO houston_task_source_settings (
            project_id, provider, enabled, settings_json, revision, updated_at
          ) VALUES (${projectId}, ${row.provider}, 0, ${encodeSettings(converted)}, 1, ${now})
        `.pipe(Effect.mapError(failed("task_tracker_settings", key)));
        settings += 1;
      }

      const v2Tasks = new Map(
        (yield* sql<{ readonly id: number; readonly project_id: string | null }>`
          SELECT id, project_id FROM houston_tasks
        `.pipe(Effect.orDie)).map((task) => [task.id, task.project_id]),
      );
      let links = 0;
      let slackLinks = 0;
      let orphaned = 0;
      const touched = new Set<number>();
      for (const row of v1.links) {
        const key = `${String(row.task_id)} ${String(row.provider)} ${String(row.external_id)}`;
        if (!PROVIDERS.has(String(row.provider))) {
          slackLinks += 1;
          continue;
        }
        const projectId = v2Tasks.get(Number(row.task_id));
        if (projectId === undefined || projectId === null) {
          orphaned += 1;
          continue;
        }
        const snapshot = yield* Effect.try({
          try: () => convertSnapshot(String(row.snapshot)),
          catch: failed("task_external_links", key),
        });
        const state = yield* Effect.try({
          try: () => convertSyncState(row.sync_state),
          catch: failed("task_external_links", key),
        });
        yield* sql`
          INSERT INTO houston_task_source_links (
            task_id, project_id, provider, external_id, source, url, remote_rev, body_hash,
            fetched_at, synced_at, snapshot_json, sync_state_json
          ) VALUES (
            ${row.task_id}, ${projectId}, ${row.provider}, ${row.external_id}, ${row.source},
            ${row.url}, ${row.remote_rev}, ${row.body_hash}, ${iso(row.fetched_at_ms)},
            ${iso(row.synced_at_ms)}, ${snapshot}, ${state}
          )
        `.pipe(Effect.mapError(failed("task_external_links", key)));
        touched.add(Number(row.task_id));
        links += 1;
      }
      if (v1.namespace !== null) {
        yield* sql`
          INSERT INTO houston_task_source_identity (id, namespace) VALUES (1, ${v1.namespace})
          ON CONFLICT (id) DO NOTHING
        `.pipe(Effect.mapError(failed("task_tracker_database_identity", "1")));
      }
      for (const [count, what] of [
        [
          unmatched,
          "task source setting(s) of Houston 1 workspaces that match no project were dropped",
        ],
        [slack, "Slack task source setting(s) were dropped"],
        [slackLinks, "Slack link(s) were dropped"],
        [orphaned, "link(s) whose task was not imported or has no project were dropped"],
        [v1.outbox, "pending write-back row(s) were dropped"],
        [v1.pollState, "poll cursor(s) were dropped; the first poll reads everything again"],
        [v1.refreshCursors, "refresh cursor(s) were dropped"],
      ] as const) {
        if (count > 0) notes.push(`${count} ${what}`);
      }
      if (settings > 0) {
        notes.push(`${settings} source(s) arrive disabled; a Notion source needs its token again`);
      }
      const counts = { settings, links };
      yield* sql`
        INSERT INTO houston_task_source_import (id, imported_at, counts_json)
        VALUES (1, ${now}, ${encodeCounts(counts)})
      `.pipe(Effect.orDie);
      return {
        result: { imported: counts, notes } satisfies HoustonTaskSourceImportResult,
        touched: [...touched],
        events: [],
      };
    }),
  );

  return HoustonTaskSourceV1Import.of({ status, run });
});

export const layer = Layer.effect(HoustonTaskSourceV1Import, make);
