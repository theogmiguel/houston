// The one-time import of Houston 1's Notion tracker: its settings become a project's tracker
// binding and its page links become issue-backed task links. v1's database is read from a
// temporary copy and never written. No v1 credential is read: the tracker asks for its token.
import * as NodeSqlite from "node:sqlite";

import { IssueTrackerConnectionError, IssueTrackerKind } from "@houston-app/contracts";
import type { IssueImportResult, IssueImportStatus } from "@houston-app/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as HostProcess from "@houston-app/shared/HostProcess";
import * as ServerConfig from "../config.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import { HostedLaunch } from "../houston/baseDir.ts";
import { v1PathMatches } from "../houston/tasks/rules.ts";
import { nowIso } from "../houston/tasks/TaskStore.ts";

const V1_DATABASE = "houston.db";
const V1_COMPANIONS = ["-wal", "-shm"] as const;

type SqlValue = string | number | null;
type Row = Readonly<Record<string, SqlValue>>;

const ISSUE_COUNTS = Schema.Struct({
  links: Schema.Number,
  skipped: Schema.Number,
});
const encodeCounts = Schema.encodeSync(Schema.fromJsonString(ISSUE_COUNTS));
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeCounts = Schema.decodeUnknownSync(Schema.fromJsonString(ISSUE_COUNTS));

const NOTION_ID =
  /^(?:[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
const notionId = (value: string) => value.replaceAll("-", "").toLowerCase();
const isNotionId = (value: string) => NOTION_ID.test(value.trim());

interface V1Trackers {
  readonly settings: ReadonlyArray<Row>;
  readonly links: ReadonlyArray<Row>;
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
    return {
      settings: all("task_tracker_settings", "workspace, provider"),
      links: all("task_external_links", "task_id, provider, external_id, source"),
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
    notion_data_source_id: Schema.optional(Schema.NullOr(Schema.String)),
    notion_title_property_id: Schema.optional(Schema.NullOr(Schema.String)),
    notion_description_property_id: Schema.optional(Schema.NullOr(Schema.String)),
    notion_status_property_id: Schema.optional(Schema.NullOr(Schema.String)),
    notion_assignee_property_id: Schema.optional(Schema.NullOr(Schema.String)),
    notion_pr_url_property_id: Schema.optional(Schema.NullOr(Schema.String)),
  }),
);
const decodeV1Settings = Schema.decodeUnknownSync(V1SettingsJson);

const V1SnapshotJson = Schema.fromJsonString(
  Schema.Struct({
    base: Schema.Record(Schema.String, Schema.String),
    local: Schema.Record(Schema.String, Schema.String),
    remote: Schema.Record(Schema.String, Schema.String),
  }),
);
const decodeV1Snapshot = Schema.decodeUnknownSync(V1SnapshotJson);

/** The binding a v1 settings row becomes, or null when it names no Notion data source. */
const convertSettings = (
  raw: SqlValue | undefined,
): {
  readonly dataSourceId: string;
  readonly properties: Readonly<Record<string, string>>;
} | null => {
  let v1: ReturnType<typeof decodeV1Settings>;
  try {
    v1 = decodeV1Settings(String(raw ?? "{}"));
  } catch {
    return null;
  }
  const dataSourceId = v1.notion_data_source_id?.trim();
  if (dataSourceId === undefined || dataSourceId.length === 0 || !isNotionId(dataSourceId)) {
    return null;
  }
  const properties: Record<string, string> = {};
  for (const [key, value] of [
    ["title", v1.notion_title_property_id],
    ["status", v1.notion_status_property_id],
    ["body", v1.notion_description_property_id],
    ["assignee", v1.notion_assignee_property_id],
    ["prUrl", v1.notion_pr_url_property_id],
  ] as const) {
    if (typeof value === "string" && value.trim().length > 0) properties[key] = value;
  }
  return Object.keys(properties).length === 0
    ? null
    : { dataSourceId: notionId(dataSourceId), properties };
};

const pageUrl = (id: string, raw: SqlValue | undefined): string => {
  try {
    const url = new URL(String(raw ?? ""));
    const host = url.hostname.toLowerCase();
    if (
      url.protocol === "https:" &&
      (host === "notion.so" || host.endsWith(".notion.so") || host.endsWith(".notion.site"))
    ) {
      return url.toString();
    }
  } catch {
    // A missing URL still has a canonical page address.
  }
  return `https://www.notion.so/${notionId(id)}`;
};

const snapshotTitle = (raw: SqlValue | undefined, fallback: string): string => {
  try {
    const snapshot = decodeV1Snapshot(String(raw ?? "{}"));
    return (snapshot.remote.title ?? snapshot.base.title ?? fallback).trim();
  } catch {
    return fallback.trim();
  }
};

const causeMessage = (error: unknown) => {
  let inner = error;
  while (inner instanceof Error && inner.cause instanceof Error) inner = inner.cause;
  return inner instanceof Error ? inner.message : String(inner);
};

const refusal = (detail: string, cause?: unknown) =>
  new IssueTrackerConnectionError({
    tracker: IssueTrackerKind.make("notion"),
    reason: "failed",
    detail,
    ...(cause === undefined ? {} : { cause }),
  });

export class HoustonIssueV1Import extends Context.Service<
  HoustonIssueV1Import,
  {
    readonly status: Effect.Effect<IssueImportStatus>;
    readonly run: Effect.Effect<IssueImportResult, IssueTrackerConnectionError>;
  }
>()("@houston-app/cli/issue/V1Import/HoustonIssueV1Import") {}

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const sql = yield* SqlClient.SqlClient;
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
        const dir = yield* fs.makeTempDirectoryScoped({ prefix: "houston-v1-issues-" });
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
    SELECT imported_at, counts_json FROM houston_issue_import WHERE id = 1
  `.pipe(
    Effect.map((rows) => rows[0]),
    Effect.orDie,
  );

  /** Why the import cannot run now, or null. */
  const blocked = Effect.gen(function* () {
    const [tasks] = yield* sql`SELECT 1 FROM houston_task_import WHERE id = 1`.pipe(Effect.orDie);
    return tasks === undefined
      ? "the Houston 1 tasks import has not run; import tasks first"
      : null;
  });

  const status: HoustonIssueV1Import["Service"]["status"] = Effect.gen(function* () {
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
      links: v1.links.filter(
        (row) => row.provider === "notion" && (row.source ?? "source") === "source",
      ).length,
    };
  });

  const run: HoustonIssueV1Import["Service"]["run"] = Effect.gen(function* () {
    const previous = yield* importRow;
    if (previous !== undefined) {
      return yield* refusal(`Houston 1 issues were already imported at ${previous.imported_at}`);
    }
    const reason = yield* blocked;
    if (reason !== null) return yield* refusal(reason);
    const found = yield* source;
    if (found === null) {
      return yield* refusal(
        hosted
          ? `no Houston 1 database at ${sourcePath}`
          : `the server is not hosted, so no Houston 1 database sits beside its base dir ${config.baseDir}`,
      );
    }
    const v1 = yield* fromCopy(found).pipe(
      Effect.mapError((error) =>
        refusal(`could not read the Houston 1 database at ${found}: ${causeMessage(error)}`),
      ),
    );
    if (v1 === null) {
      return yield* refusal(`the Houston 1 database at ${found} has no task source settings`);
    }
    const now = yield* nowIso;
    const notes: Array<string> = [];
    const roots = (yield* projects.list().pipe(Effect.orDie)).filter(
      (project) => project.deletedAt === null,
    );
    const projectOf = (workspace: SqlValue | undefined) =>
      typeof workspace !== "string"
        ? null
        : (roots.find((project) => v1PathMatches(workspace, project.workspaceRoot, platform))
            ?.projectId ?? null);

    // A workspace's settings name the data source its links scope by.
    const dataSources = new Map<string, string>();
    let bindings = 0;
    let unmatched = 0;
    for (const row of v1.settings) {
      if (row.provider !== "notion") continue;
      const projectId = projectOf(row.workspace);
      const converted = convertSettings(row.settings);
      if (projectId === null || converted === null) {
        unmatched += 1;
        continue;
      }
      dataSources.set(String(row.workspace), converted.dataSourceId);
      yield* sql`
        INSERT INTO issue_tracker_bindings (project_id, tracker, scope, properties_json, updated_at)
        VALUES (
          ${projectId}, 'notion', ${converted.dataSourceId},
          ${encodeJson(converted.properties)}, ${now}
        )
        ON CONFLICT (project_id) DO NOTHING
      `.pipe(Effect.orDie);
      bindings += 1;
    }

    let links = 0;
    let skipped = 0;
    for (const row of v1.links) {
      if (row.provider !== "notion" || (row.source ?? "source") !== "source") continue;
      const externalId = String(row.external_id ?? "").trim();
      const [task] = yield* sql<{
        readonly id: number;
        readonly project_id: string | null;
        readonly title: string;
      }>`
        SELECT id, project_id, title FROM houston_tasks WHERE id = ${Number(row.task_id)}
      `.pipe(Effect.orDie);
      if (task === undefined || task.project_id === null || !isNotionId(externalId)) {
        skipped += 1;
        continue;
      }
      const scope =
        dataSources.get(String(row.workspace ?? "")) ??
        (yield* sql<{ readonly scope: string }>`
          SELECT scope FROM issue_tracker_bindings
          WHERE project_id = ${task.project_id} AND tracker = 'notion'
        `.pipe(
          Effect.orDie,
          Effect.map((rows) => rows[0]?.scope ?? null),
        ));
      if (scope === null || scope === undefined) {
        skipped += 1;
        continue;
      }
      const key = notionId(externalId);
      const title = snapshotTitle(row.snapshot, task.title);
      if (title.length === 0) {
        skipped += 1;
        continue;
      }
      const [own] = yield* sql<{ readonly task_id: number }>`
        SELECT task_id FROM houston_task_issues WHERE task_id = ${task.id}
      `.pipe(Effect.orDie);
      const [holder] = yield* sql<{
        readonly task_id: number;
        readonly archived_at: string | null;
      }>`
        SELECT i.task_id, t.archived_at FROM houston_task_issues i
        JOIN houston_tasks t ON t.id = i.task_id
        WHERE lower(i.tracker) = 'notion'
          AND lower(replace(i.scope, '-', '')) = ${notionId(scope)}
          AND lower(replace(i.key, '-', '')) = ${key}
        ORDER BY t.archived_at IS NOT NULL, i.task_id LIMIT 1
      `.pipe(Effect.orDie);
      if (own !== undefined || (holder !== undefined && holder.archived_at === null)) {
        skipped += 1;
        continue;
      }
      yield* sql`
        INSERT INTO houston_task_issues (
          task_id, project_id, tracker, host, scope, key, display_key, url, title, linked_at
        ) VALUES (
          ${task.id}, ${task.project_id}, 'notion', 'notion.so', ${notionId(scope)}, ${key},
          ${key.slice(0, 8)}, ${pageUrl(externalId, row.url)}, ${title},
          ${iso(row.synced_at_ms) ?? now}
        )
      `.pipe(Effect.orDie);
      links += 1;
    }

    if (unmatched > 0) {
      notes.push(`${unmatched} Notion setting(s) of Houston 1 workspaces matched no project`);
    }
    if (v1.outbox > 0) notes.push(`${v1.outbox} pending write-back row(s) were dropped`);
    if (v1.pollState > 0) notes.push(`${v1.pollState} poll cursor(s) were dropped`);
    if (v1.refreshCursors > 0) notes.push(`${v1.refreshCursors} refresh cursor(s) were dropped`);
    if (bindings > 0)
      notes.push(`${bindings} Notion binding(s) were created; add the token in Settings`);
    if (skipped > 0) notes.push(`${skipped} link(s) named no importable Notion page`);
    const counts = { links, skipped };
    yield* sql`
      INSERT INTO houston_issue_import (id, imported_at, counts_json)
      VALUES (1, ${now}, ${encodeCounts(counts)})
    `.pipe(Effect.orDie);
    return { imported: counts, notes } satisfies IssueImportResult;
  });

  return HoustonIssueV1Import.of({ status, run });
});

export const layer = Layer.effect(HoustonIssueV1Import, make);
