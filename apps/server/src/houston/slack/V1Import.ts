// The one-time import of a Houston 1 Slack intake (AD-067), after the Tasks import: from a
// temporary copy of v1's database, in one transaction, disabled and without tokens. It never
// opens a v1 keychain entry; the user reconnects once.
import * as NodeSqlite from "node:sqlite";

import {
  HoustonSlackImportCounts,
  type HoustonSlackError,
  type HoustonSlackImportResult,
  type HoustonSlackImportStatus,
} from "@t3tools/contracts/houston/slack";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import type * as SqlError from "effect/sql/SqlError";

import * as ServerConfig from "../../config.ts";
import * as ProjectService from "../../project/ProjectService.ts";
import { HostedLaunch } from "../baseDir.ts";
import { nowIso } from "../tasks/TaskStore.ts";
import { v1PathMatches } from "../tasks/rules.ts";
import { refuse, slackTs, type StatusReaction } from "./rules.ts";
import { HoustonSlackStore } from "./Store.ts";

const OPERATION = "houston.slack.importV1.run";
const V1_DATABASE = "houston.db";
// SQLite keeps a WAL database's uncheckpointed pages and its index beside the file.
const V1_COMPANIONS = ["-wal", "-shm"] as const;
const CURSOR_PREFIX = "slack_cursor:";

type SqlValue = string | number | null;
type Row = Readonly<Record<string, SqlValue>>;

/** v1's request states; `queued` arrives as `pending`, so nothing starts without a new ✅. */
const STATES: Readonly<Record<string, "pending" | "started" | "refused">> = {
  pending: "pending",
  queued: "pending",
  started: "started",
  refused: "refused",
};
const REACTIONS: ReadonlySet<StatusReaction> = new Set([
  "eyes",
  "gear",
  "question",
  "checkered_flag",
  "rocket",
  "no_entry_sign",
  "warning",
]);

interface V1Slack {
  readonly settings: ReadonlyMap<string, string>;
  readonly events: ReadonlyArray<Row>;
  readonly questions: number;
  readonly results: number;
  readonly adjustments: number;
  readonly outbox: number;
}

const V1Channels = Schema.fromJsonString(
  Schema.Array(Schema.Struct({ channel_id: Schema.String, workspace: Schema.String })),
);
const decodeChannels = Schema.decodeUnknownOption(V1Channels);
const encodeCounts = Schema.encodeSync(Schema.fromJsonString(HoustonSlackImportCounts));
const decodeCounts = Schema.decodeUnknownSync(Schema.fromJsonString(HoustonSlackImportCounts));

/** Every v1 Slack row the import reads, in one read transaction; v1 is never written. */
const readV1 = (path: string): V1Slack => {
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
      const count = (table: string) =>
        tables.has(table)
          ? Number((db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as Row).n)
          : 0;
      const settings = tables.has("settings")
        ? (db
            .prepare("SELECT key, value FROM settings WHERE key LIKE 'slack_%' ORDER BY key")
            .all() as ReadonlyArray<Row>)
        : [];
      return {
        settings: new Map(settings.map((row) => [String(row.key), String(row.value)])),
        events: tables.has("intake_events")
          ? (db
              .prepare("SELECT * FROM intake_events WHERE source = 'slack' ORDER BY id")
              .all() as ReadonlyArray<Row>)
          : [],
        questions: count("intake_questions"),
        results: count("intake_results"),
        adjustments: count("intake_adjustments"),
        outbox: count("intake_outbox"),
      };
    } finally {
      db.exec("COMMIT");
    }
  } finally {
    db.close();
  }
};

const channelsOf = (v1: V1Slack) => {
  const raw = v1.settings.get("slack_channels");
  return raw === undefined ? Option.some([]) : decodeChannels(raw);
};

const hasSlack = (v1: V1Slack) =>
  v1.events.length > 0 ||
  ["slack_owner", "slack_channels", "slack_language"].some((key) => v1.settings.has(key));

const iso = (ms: SqlValue | undefined) =>
  ms === null || ms === undefined ? null : DateTime.formatIso(DateTime.makeUnsafe(Number(ms)));

/** SQLite's own message: the innermost cause, which each wrapping error replaces with its own. */
const causeMessage = (error: Error) => {
  let inner = error;
  while (inner.cause instanceof Error) inner = inner.cause;
  return inner.message;
};

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;

export class HoustonSlackV1Import extends Context.Service<
  HoustonSlackV1Import,
  {
    readonly status: Effect.Effect<HoustonSlackImportStatus>;
    readonly run: Effect.Effect<HoustonSlackImportResult, HoustonSlackError>;
  }
>()("houston/houston/slack/V1Import/HoustonSlackV1Import") {}

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const sql = yield* SqlClient.SqlClient;
  const store = yield* HoustonSlackStore;
  const projects = yield* ProjectService.ProjectService;
  const platform = yield* HostProcess.Platform;
  const hosted = yield* HostedLaunch;
  const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.orDie(effect);

  const sourcePath = path.join(path.dirname(config.baseDir), V1_DATABASE);
  const source = Effect.gen(function* () {
    if (!hosted) return null;
    const exists = yield* fs.exists(sourcePath).pipe(Effect.orElseSucceed(() => false));
    return exists ? sourcePath : null;
  });

  /** Runs `read` on a temporary copy of v1's file and its companions, taken once. */
  const fromCopy = <A>(file: string, read: (copy: string) => A) =>
    Effect.scoped(
      Effect.gen(function* () {
        const dir = yield* fs.makeTempDirectoryScoped({ prefix: "houston-v1-slack-copy-" });
        const copy = path.join(dir, V1_DATABASE);
        yield* fs.copyFile(file, copy);
        for (const suffix of V1_COMPANIONS) {
          if (yield* fs.exists(`${file}${suffix}`)) {
            yield* fs.copyFile(`${file}${suffix}`, `${copy}${suffix}`);
          }
        }
        return yield* Effect.try(() => read(copy));
      }),
    );

  const importRow = run(sql<{ readonly imported_at: string; readonly counts_json: string }>`
    SELECT imported_at, counts_json FROM houston_slack_import WHERE id = 1
  `).pipe(Effect.map((rows) => rows[0]));

  const tasksImported = run(sql<{ readonly one: number }>`
    SELECT 1 AS one FROM houston_task_import WHERE id = 1
  `).pipe(Effect.map((rows) => rows.length > 0));

  /** Slack rows v2 already holds, named for a refusal; null when there are none. */
  const v2Rows = Effect.gen(function* () {
    const [counts] = yield* run(sql<{ readonly channels: number; readonly requests: number }>`
      SELECT (SELECT COUNT(*) FROM houston_slack_channels) AS channels,
        (SELECT COUNT(*) FROM houston_slack_requests) AS requests
    `);
    const channels = counts?.channels ?? 0;
    const requests = counts?.requests ?? 0;
    return channels === 0 && requests === 0
      ? null
      : `v2 already holds ${plural(channels, "Slack channel")} and ${plural(requests, "Slack request")}; the import needs an intake without either`;
  });

  const TASKS_FIRST =
    "Houston 1's tasks are not imported yet; run the Tasks import (houston.tasks.importV1.run) first, so each request finds its task";

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
    const v1 =
      found === null ? null : yield* fromCopy(found, readV1).pipe(Effect.orElseSucceed(() => null));
    if (found === null || v1 === null || !hasSlack(v1)) return { state: "unavailable" as const };
    if (!(yield* tasksImported)) return { state: "blocked" as const, reason: TASKS_FIRST };
    const present = yield* v2Rows;
    if (present !== null) return { state: "blocked" as const, reason: present };
    const channels = channelsOf(v1);
    return {
      state: "available" as const,
      source: found,
      channels: channels._tag === "Some" ? channels.value.length : 0,
      requests: v1.events.length,
    };
  });

  const copy = Effect.fn("HoustonSlackV1Import.copy")(function* (file: string, v1: V1Slack) {
    const now = yield* nowIso;
    const cursor = slackTs(DateTime.toEpochMillis(DateTime.makeUnsafe(now)));
    // Live projects only, as the Tasks import matches them.
    const roots = yield* projects.listShells().pipe(Effect.orDie);
    const projectOf = (workspace: string): string | null =>
      roots.find((project) => v1PathMatches(workspace, project.workspaceRoot, platform))?.id ??
      null;
    const unsupported = (message: string) => refuse("unsupported", OPERATION, message);
    /** A row SQLite refuses is named by its table and v1 row. */
    const row =
      (table: string, key: SqlValue | undefined) =>
      <A>(effect: Effect.Effect<A, SqlError.SqlError>) =>
        effect.pipe(
          Effect.mapError((error) =>
            unsupported(
              `${table} row ${String(key)} from the Houston 1 database at ${file} could not be copied: ${causeMessage(error)}`,
            ),
          ),
        );
    const notes: Array<string> = [];

    const owner = v1.settings.get("slack_owner")?.trim() || null;
    const rawLanguage = v1.settings.get("slack_language");
    if (rawLanguage !== undefined && rawLanguage !== "en" && rawLanguage !== "pt_br") {
      notes.push(`language ${rawLanguage} is not known here; chose English`);
    }
    const language = rawLanguage === "pt_br" ? "pt-BR" : "en";
    yield* row(
      "houston_slack_settings",
      1,
    )(sql`
      INSERT INTO houston_slack_settings (id, enabled, owner_user_id, language, revision, updated_at)
      VALUES (1, 0, ${owner}, ${language}, 1, ${now})
      ON CONFLICT (id) DO UPDATE SET enabled = 0, owner_user_id = excluded.owner_user_id,
        language = excluded.language, revision = revision + 1, updated_at = excluded.updated_at
    `);

    const mapped = new Map<string, string>();
    const channels = channelsOf(v1);
    if (channels._tag === "None") {
      notes.push("the channel map could not be read; no channel was imported");
    }
    for (const channel of channels._tag === "Some" ? channels.value : []) {
      const projectId = projectOf(channel.workspace);
      if (projectId === null) {
        notes.push(
          `channel ${channel.channel_id}: workspace ${channel.workspace} matches no project; not imported`,
        );
        continue;
      }
      mapped.set(channel.channel_id, projectId);
      yield* row(
        "houston_slack_channels",
        channel.channel_id,
      )(sql`
        INSERT INTO houston_slack_channels (channel_id, project_id, cursor_ts, mapped_at)
        VALUES (${channel.channel_id}, ${projectId}, ${cursor}, ${now})
      `);
    }
    const cursors = [...v1.settings.keys()].filter((key) => key.startsWith(CURSOR_PREFIX)).length;
    if (cursors > 0) {
      notes.push(
        `${plural(cursors, "cursor")} (${CURSOR_PREFIX}) dropped; each channel's catch-up starts at the import`,
      );
    }

    const requests: Array<number> = [];
    for (const event of v1.events) {
      const label = `request ${String(event.channel)} ${String(event.ts)}`;
      const [task] =
        event.task_id === null
          ? []
          : yield* run(sql<{ readonly id: number; readonly project_id: string | null }>`
              SELECT id, project_id FROM houston_tasks WHERE id = ${event.task_id}
            `);
      if (task === undefined) {
        notes.push(`${label}: its task ${String(event.task_id)} is not in v2; not imported`);
        continue;
      }
      const state = STATES[String(event.state)];
      if (state === undefined) {
        return yield* unsupported(
          `intake_events row ${String(event.id)} has state ${String(event.state)}, which this version does not know`,
        );
      }
      const projectId =
        mapped.get(String(event.channel)) ?? projectOf(String(event.workspace)) ?? task.project_id;
      if (projectId === null) {
        notes.push(`${label}: workspace ${String(event.workspace)} matches no project; not imported`);
        continue;
      }
      const reaction = REACTIONS.has(String(event.status_reaction) as StatusReaction)
        ? String(event.status_reaction)
        : null;
      const [inserted] = yield* row(
        "houston_slack_requests",
        event.id,
      )(sql<{ readonly id: number }>`
        INSERT INTO houston_slack_requests (
          channel_id, ts, author, project_id, task_id, state, status_reaction, permalink,
          queued_at, created_at
        ) VALUES (
          ${event.channel}, ${event.ts}, ${event.author}, ${projectId}, ${task.id}, ${state},
          ${reaction}, ${event.permalink}, NULL, ${iso(event.created_at) ?? now}
        ) RETURNING id
      `);
      if (inserted !== undefined) requests.push(inserted.id);
    }

    for (const [count, noun, table] of [
      [v1.questions, "question", "intake_questions"],
      [v1.results, "result", "intake_results"],
      [v1.adjustments, "adjustment", "intake_adjustments"],
      [v1.outbox, "outbox row", "intake_outbox"],
    ] as const) {
      if (count > 0) notes.push(`${plural(count, noun)} (${table}) dropped`);
    }
    const counts: HoustonSlackImportCounts = {
      settings: owner !== null || rawLanguage !== undefined ? 1 : 0,
      channels: mapped.size,
      requests: requests.length,
    };
    yield* row(
      "houston_slack_import",
      1,
    )(sql`
      INSERT INTO houston_slack_import (id, imported_at, counts_json)
      VALUES (1, ${now}, ${encodeCounts(counts)})
    `);
    return { result: { imported: counts, notes }, requests, info: true };
  });

  const runImport = store.write(
    Effect.gen(function* () {
      const previous = yield* importRow;
      if (previous !== undefined) {
        return yield* refuse(
          "invalid",
          OPERATION,
          `Houston 1's Slack intake was already imported at ${previous.imported_at}`,
        );
      }
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
      if (!(yield* tasksImported)) return yield* refuse("invalid", OPERATION, TASKS_FIRST);
      const present = yield* v2Rows;
      if (present !== null) return yield* refuse("invalid", OPERATION, present);
      const v1 = yield* fromCopy(found, readV1).pipe(
        Effect.mapError((error) =>
          refuse(
            "unsupported",
            OPERATION,
            `could not read the Houston 1 database at ${found}: ${causeMessage(error)}`,
          ),
        ),
      );
      return yield* copy(found, v1);
    }),
  );

  return HoustonSlackV1Import.of({ status, run: runImport });
});

export const layer = Layer.effect(HoustonSlackV1Import, make);
