// Write-back to the tracker. Task transitions enqueue outbox rows inside their own transaction;
// the drain rebuilds each row from live state and sends it to GitHub or Notion every 20 seconds.
// @effect-diagnostics nodeBuiltinImport:off - draws the marker namespace from the CSPRNG.
import * as NodeCrypto from "node:crypto";

import type { HoustonTaskSourceProvider } from "@t3tools/contracts/houston/taskSources";
import * as GitHubRest from "@t3tools/source-control-github/server/GitHubRest";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";

import { HoustonKeychain } from "../secrets/HoustonKeychain.ts";
import { HoustonTaskTransitions, nowIso, type TaskTransition } from "../tasks/TaskStore.ts";
import { GitHubRequestTimeout, describeGitHubError } from "./GitHubSource.ts";
import { NotionClient, writeNotion } from "./NotionClient.ts";
import {
  GITHUB_MAX_PAGES,
  GITHUB_PAGE_SIZE,
  OUTBOX_BATCH,
  POLL_INTERVAL_SECONDS,
  SUPERSEDED,
  TOKEN_ACCOUNT,
  TOKEN_MISSING,
  TOKEN_UNAVAILABLE,
  WRITE_LIMITS,
  commentMarker,
  cutChars,
  endsWithMarker,
  errorText,
  githubPullRequestUrl,
  githubRecord,
  issueNumberOf,
  neutralise,
  parseRepository,
  quote,
  retryDelayMillis,
  statusComment,
  syncStateOf,
  writebackActions,
  type OutboxEntry,
  type StoredSettings,
  type WritebackTask,
  type WritebackTransition,
} from "./rules.ts";
import {
  HoustonTaskSourceStore,
  decodeSnapshot,
  encodeSnapshot,
  encodeSyncState,
  settingsFromRow,
  type SourceEvent,
} from "./SourceStore.ts";

type Json = Readonly<Record<string, unknown>>;
const JsonText = Schema.fromJsonString(Schema.Unknown);
const encodeJson = Schema.encodeSync(JsonText);
const decodeJson = Schema.decodeUnknownOption(JsonText);
const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown) => (typeof value === "string" ? value : null);

/** The history actions that are task transitions; any other with a status change is `updated`. */
const NAMED_TRANSITIONS: Readonly<Record<string, WritebackTransition>> = {
  created: "created",
  update: "updated",
  domain_update: "updated",
  "houston:handback": "handed_back",
  "houston:pr-merged": "merged",
  delivery_rollup: "delivery_rolled_up",
};

/** The transition a history row is, or null. A tracker's own edits and resolutions are not:
 * a resolution enqueues its status write-back itself. */
export const transitionOf = (
  entry: TaskTransition,
): { readonly transition: WritebackTransition; readonly statusChanged: boolean } | null => {
  if (entry.actor.startsWith("tracker:") || entry.action.startsWith("houston:source-")) {
    return null;
  }
  const statusChanged = "status" in entry.changes;
  const named = NAMED_TRANSITIONS[entry.action];
  if (named !== undefined) return { transition: named, statusChanged };
  return statusChanged ? { transition: "updated", statusChanged } : null;
};

interface TaskRowLite {
  readonly id: number;
  readonly project_id: string | null;
  readonly title: string;
  readonly description: string;
  readonly status: string;
  readonly revision: number;
  readonly parent_id: number | null;
}

interface OutboxRow {
  readonly id: number;
  readonly project_id: string;
  readonly task_id: number;
  readonly provider: HoustonTaskSourceProvider;
  readonly action: string;
  readonly revision: number;
  readonly payload_json: string;
  readonly attempts: number;
}

/** Reads tasks, links and runs as write-back sees them; every query runs in the caller's
 * transaction when there is one. */
const makeReads = (sql: SqlClient.SqlClient) => {
  const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.orDie(effect);
  const task = Effect.fnUntraced(function* (id: number) {
    const [row] = yield* run(sql<TaskRowLite>`
      SELECT id, project_id, title, description, status, revision, parent_id
      FROM houston_tasks WHERE id = ${id}
    `);
    if (row === undefined) return undefined;
    const [domain] = yield* run(sql<{
      readonly kind: "delivery" | "slice";
      readonly initiative_id: number | null;
      readonly user_status_override: number;
    }>`
      SELECT kind, initiative_id, user_status_override FROM houston_task_domain
      WHERE task_id = ${id}
    `);
    const links = yield* run(sql<{
      readonly provider: HoustonTaskSourceProvider;
      readonly source: "source" | "pull_request";
      readonly external_id: string;
      readonly url: string;
    }>`
      SELECT provider, source, external_id, url FROM houston_task_source_links
      WHERE task_id = ${id} ORDER BY provider, external_id, source
    `);
    return {
      row,
      task: {
        id: row.id,
        projectId: row.project_id,
        title: row.title,
        description: row.description,
        status: row.status,
        revision: row.revision,
        domain:
          domain === undefined
            ? null
            : {
                kind: domain.kind,
                initiativeId: domain.initiative_id,
                userStatusOverride: domain.user_status_override !== 0,
              },
        links: links.map((link) => ({
          provider: link.provider,
          source: link.source,
          externalId: link.external_id,
          url: link.url,
        })),
      } satisfies WritebackTask,
    };
  });
  const slices = (id: number) =>
    run(sql<{ readonly total: number; readonly done: number | null }>`
      SELECT COUNT(*) AS total, SUM(CASE WHEN t.status = 'done' THEN 1 ELSE 0 END) AS done
      FROM houston_tasks t JOIN houston_task_domain d ON d.task_id = t.id AND d.kind = 'slice'
      WHERE t.parent_id = ${id}
    `).pipe(Effect.map(([row]) => ({ total: row?.total ?? 0, done: row?.done ?? 0 })));
  const latestRun = (id: number) =>
    run(sql<{ readonly summary: string | null; readonly pr_url: string | null }>`
      SELECT
        (SELECT summary FROM houston_task_runs WHERE task_id = ${id} AND summary IS NOT NULL
          ORDER BY id DESC LIMIT 1) AS summary,
        (SELECT pr_url FROM houston_task_runs WHERE task_id = ${id} AND pr_url IS NOT NULL
          ORDER BY id DESC LIMIT 1) AS pr_url
    `).pipe(Effect.map(([row]) => ({ summary: row?.summary ?? null, prUrl: row?.pr_url ?? null })));
  const enabled = (projectId: string) =>
    run(sql<{ readonly provider: HoustonTaskSourceProvider }>`
      SELECT provider FROM houston_task_source_settings
      WHERE project_id = ${projectId} AND enabled = 1 ORDER BY provider
    `).pipe(Effect.map((rows) => rows.map((row) => row.provider)));
  return { task, slices, latestRun, enabled };
};

/** The marker namespace and key, each 32 random hex digits written once; the namespace is
 * Houston 1's after an import. */
const makeIdentity = (sql: SqlClient.SqlClient) => {
  const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.orDie(effect);
  const read = run(sql<{ readonly namespace: string; readonly marker_key: string | null }>`
    SELECT namespace, marker_key FROM houston_task_source_identity WHERE id = 1
  `).pipe(Effect.map(([row]) => row));
  const namespace = Effect.gen(function* () {
    const row = yield* read;
    if (row !== undefined) return row.namespace;
    const fresh = NodeCrypto.randomBytes(16).toString("hex");
    yield* run(sql`
      INSERT INTO houston_task_source_identity (id, namespace) VALUES (1, ${fresh})
      ON CONFLICT (id) DO NOTHING
    `);
    return (yield* read)?.namespace ?? fresh;
  });
  const markerKey = Effect.gen(function* () {
    yield* namespace;
    const row = yield* read;
    if (typeof row?.marker_key === "string") return row.marker_key;
    const fresh = NodeCrypto.randomBytes(16).toString("hex");
    yield* run(sql`
      UPDATE houston_task_source_identity SET marker_key = ${fresh}
      WHERE id = 1 AND marker_key IS NULL
    `);
    return (yield* read)?.marker_key ?? fresh;
  });
  return { namespace, markerKey };
};

export class HoustonTaskSourceOutbox extends Context.Service<
  HoustonTaskSourceOutbox,
  {
    /** The marker namespace: Houston 1's after an import, else 32 random hex digits written once. */
    readonly namespace: Effect.Effect<string>;
    /** The key write-back markers are keyed with: 32 random hex digits written once. */
    readonly markerKey: Effect.Effect<string>;
    /** Enqueues the write-back rows of a write's transitions. */
    readonly recorded: (transitions: ReadonlyArray<TaskTransition>) => Effect.Effect<void>;
    /** Enqueues the status write-back of a task's live status, again if it was already sent. */
    readonly statusResolved: (
      taskId: number,
      provider: HoustonTaskSourceProvider,
    ) => Effect.Effect<void>;
  }
>()("houston/houston/taskSources/Outbox/HoustonTaskSourceOutbox") {}

const PULL_REQUEST_ACTIONS = ["pr_reference", "pull_request_url"];

const makeOutbox = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const reads = makeReads(sql);
  const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.orDie(effect);
  const { namespace, markerKey } = makeIdentity(sql);

  /** One row per task, provider, action and revision; `revive` sends a sent row again. */
  const enqueue = Effect.fnUntraced(function* (
    projectId: string,
    entry: OutboxEntry,
    revive: "always" | "superseded" | "never",
  ) {
    if (PULL_REQUEST_ACTIONS.includes(entry.action)) {
      // A pull request is reported once per task, whichever transition saw it first.
      const url = text(entry.payload.url);
      const [known] = yield* run(sql<{ readonly n: number }>`
        SELECT COUNT(*) AS n FROM houston_task_source_outbox
        WHERE task_id = ${entry.taskId} AND provider = ${entry.provider}
          AND action = ${entry.action} AND json_extract(payload_json, '$.url') = ${url}
          AND (receipt_json IS NULL OR json_extract(receipt_json, '$.superseded') IS NULL)
      `);
      if ((known?.n ?? 0) > 0) return;
    }
    const now = yield* nowIso;
    const payload = encodeJson(entry.payload);
    if (revive === "never") {
      yield* run(sql`
        INSERT INTO houston_task_source_outbox (
          project_id, task_id, provider, action, revision, payload_json, next_attempt_at
        ) VALUES (
          ${projectId}, ${entry.taskId}, ${entry.provider}, ${entry.action}, ${entry.revision},
          ${payload}, ${now}
        ) ON CONFLICT (task_id, provider, action, revision) DO NOTHING
      `);
      return;
    }
    yield* run(sql`
      INSERT INTO houston_task_source_outbox (
        project_id, task_id, provider, action, revision, payload_json, next_attempt_at
      ) VALUES (
        ${projectId}, ${entry.taskId}, ${entry.provider}, ${entry.action}, ${entry.revision},
        ${payload}, ${now}
      ) ON CONFLICT (task_id, provider, action, revision) DO UPDATE SET
        project_id = excluded.project_id, payload_json = excluded.payload_json, attempts = 0,
        next_attempt_at = excluded.next_attempt_at, last_error = NULL, receipt_json = NULL
      WHERE ${revive === "always" ? 1 : 0} = 1
        OR json_extract(houston_task_source_outbox.receipt_json, '$.superseded') = 1
    `);
  });

  /** The rows a transition of `taskId` enqueues, as `writebackActions` decides them. */
  const entriesOf = Effect.fnUntraced(function* (
    taskId: number,
    transition: string,
    statusChanged: boolean,
    only: ReadonlyArray<HoustonTaskSourceProvider> | null,
  ) {
    const loaded = yield* reads.task(taskId);
    if (loaded === undefined || loaded.row.project_id === null) return null;
    const projectId = loaded.row.project_id;
    const enabled = (yield* reads.enabled(projectId)).filter(
      (provider) => only === null || only.includes(provider),
    );
    if (enabled.length === 0 || loaded.task.domain === null) return null;
    const parent =
      loaded.row.parent_id === null ? undefined : yield* reads.task(loaded.row.parent_id);
    const latest = yield* reads.latestRun(taskId);
    const entries = writebackActions({
      transition,
      task: loaded.task,
      delivery: parent?.task ?? null,
      enabled,
      statusChanged,
      slices: yield* reads.slices(taskId),
      summary: latest.summary,
      prUrl: latest.prUrl,
      namespace: yield* namespace,
      markerKey: yield* markerKey,
    });
    return { projectId, entries };
  });

  const recorded: HoustonTaskSourceOutbox["Service"]["recorded"] = Effect.fn(
    "HoustonTaskSourceOutbox.recorded",
  )(function* (transitions) {
    for (const entry of transitions) {
      const transition = transitionOf(entry);
      if (transition === null) continue;
      const found = yield* entriesOf(
        entry.taskId,
        transition.transition,
        transition.statusChanged,
        null,
      );
      if (found === null) continue;
      if (typeof found.entries === "string") {
        yield* Effect.logWarning(`Task source write-back skipped: ${found.entries}`);
        continue;
      }
      for (const row of found.entries) {
        yield* enqueue(
          found.projectId,
          row,
          row.action === "delivery_close" ? "superseded" : "never",
        );
      }
    }
  });

  const statusResolved: HoustonTaskSourceOutbox["Service"]["statusResolved"] = Effect.fn(
    "HoustonTaskSourceOutbox.statusResolved",
  )(function* (taskId, provider) {
    const found = yield* entriesOf(taskId, "updated", true, [provider]);
    if (found === null || typeof found.entries === "string") return;
    for (const row of found.entries) {
      if (row.action === "status") yield* enqueue(found.projectId, row, "always");
    }
  });

  return HoustonTaskSourceOutbox.of({ namespace, markerKey, recorded, statusResolved });
});

/** The outbox, and the port the Tasks store hands its transitions to. */
export const layer = Layer.effect(
  HoustonTaskTransitions,
  Effect.map(Effect.service(HoustonTaskSourceOutbox), (outbox) =>
    HoustonTaskTransitions.of({ recorded: outbox.recorded }),
  ),
).pipe(Layer.provideMerge(Layer.effect(HoustonTaskSourceOutbox, makeOutbox)));

// The drain.

interface Receipt {
  readonly externalId: string | null;
  readonly url: string | null;
  /** A created issue as a poll would read it: the base of its new link. */
  readonly remote?: {
    readonly fields: Readonly<Record<string, string>>;
    readonly rev: string | null;
  };
}

export class HoustonTaskSourceOutboxDrain extends Context.Service<
  HoustonTaskSourceOutboxDrain,
  {
    /** Sends up to `limit` due rows in id order; returns how many it handled. */
    readonly drainUpTo: (limit: number) => Effect.Effect<number>;
    /** One cycle: up to 25 due rows. */
    readonly drain: Effect.Effect<number>;
  }
>()("houston/houston/taskSources/Outbox/HoustonTaskSourceOutboxDrain") {}

const makeDrain = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const store = yield* HoustonTaskSourceStore;
  const keychain = yield* HoustonKeychain;
  const github = yield* GitHubRest.GitHubRest;
  const notion = yield* NotionClient;
  const reads = makeReads(sql);
  const identity = makeIdentity(sql);
  const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.orDie(effect);
  const lock = yield* Semaphore.make(1);

  const linksEvent = (projectId: string, taskId: number) =>
    store
      .linksOf(taskId)
      .pipe(
        Effect.map((links): SourceEvent => ({ projectId, event: { links: { taskId, links } } })),
      );

  /** The task whose source link a row writes to. */
  const targetOf = (row: OutboxRow, payload: Json) =>
    typeof payload.deliveryTaskId === "number" ? payload.deliveryTaskId : row.task_id;

  /** Sets the target's source link to `error`, or back from it; returns whether it changed. */
  const markLink = Effect.fnUntraced(function* (
    taskId: number,
    provider: HoustonTaskSourceProvider,
    error: string | null,
  ) {
    const [link] = yield* run(sql<{
      readonly external_id: string;
      readonly snapshot_json: string;
      readonly sync_state_json: string;
    }>`
      SELECT external_id, snapshot_json, sync_state_json FROM houston_task_source_links
      WHERE task_id = ${taskId} AND provider = ${provider} AND source = 'source'
    `);
    if (link === undefined) return false;
    const state = encodeSyncState(
      error === null
        ? syncStateOf(decodeSnapshot(link.snapshot_json))
        : { state: "error", message: error },
    );
    if (state === link.sync_state_json) return false;
    yield* run(sql`
      UPDATE houston_task_source_links SET sync_state_json = ${state}
      WHERE task_id = ${taskId} AND provider = ${provider} AND external_id = ${link.external_id}
        AND source = 'source'
    `);
    return true;
  });

  const failed = (row: OutboxRow, target: number, message: string) => {
    const error = errorText(message);
    return Effect.logWarning(
      `Task source write-back ${row.action} of task ${row.task_id} to ${row.provider} failed: ${error}`,
    ).pipe(
      Effect.andThen(
        store.write(
          Effect.gen(function* () {
            const next = DateTime.formatIso(
              DateTime.add(yield* DateTime.now, { milliseconds: retryDelayMillis(row.attempts) }),
            );
            yield* run(sql`
              UPDATE houston_task_source_outbox SET attempts = attempts + 1,
                last_error = ${error}, next_attempt_at = ${next}
              WHERE id = ${row.id} AND receipt_json IS NULL
            `);
            const changed = yield* markLink(target, row.provider, error);
            return {
              result: undefined,
              touched: [],
              events: changed ? [yield* linksEvent(row.project_id, target)] : [],
            };
          }),
        ),
      ),
    );
  };

  const superseded = (row: OutboxRow) =>
    run(sql`
      UPDATE houston_task_source_outbox SET receipt_json = ${encodeJson(SUPERSEDED)},
        last_error = NULL
      WHERE id = ${row.id} AND receipt_json IS NULL
    `);

  /** Records a sent row: a created issue or a pull request becomes a link. */
  const sent = (row: OutboxRow, target: number, live: Json, receipt: Receipt) =>
    store.write(
      Effect.gen(function* () {
        const now = yield* nowIso;
        const touched: Array<number> = [];
        if (row.action === "create" && receipt.externalId !== null) {
          const [other] = yield* run(sql<{ readonly task_id: number }>`
            SELECT task_id FROM houston_task_source_links
            WHERE project_id = ${row.project_id} AND provider = ${row.provider}
              AND external_id = ${receipt.externalId} AND source = 'source'
          `);
          if (other !== undefined && other.task_id !== target) {
            return {
              result: `issue ${receipt.externalId} is already linked to task ${other.task_id}`,
              touched: [],
              events: [],
            };
          }
          if (other === undefined) {
            const local = {
              title: text(live.title) ?? "",
              description: text(live.description) ?? "",
              status: text(live.status) ?? "",
            };
            // GitHub's copy (the body carries the marker) is the base, so a later poll that
            // finds it unchanged records no conflict against the task.
            const remote = receipt.remote?.fields ?? local;
            const snapshot = {
              base: { ...remote },
              local,
              remote: { ...remote },
              conflicts: [],
              revision: 1,
              projectExternalId: null,
              project: null,
            };
            yield* run(sql`
              INSERT INTO houston_task_source_links (
                task_id, project_id, provider, external_id, source, url, remote_rev, fetched_at,
                synced_at, snapshot_json, sync_state_json
              ) VALUES (
                ${target}, ${row.project_id}, ${row.provider}, ${receipt.externalId}, 'source',
                ${receipt.url ?? receipt.externalId}, ${receipt.remote?.rev ?? null}, ${now},
                ${now}, ${encodeSnapshot(snapshot)}, ${encodeSyncState(syncStateOf(snapshot))}
              )
            `);
          }
          touched.push(target);
        }
        if (PULL_REQUEST_ACTIONS.includes(row.action)) {
          const url = text(live.url) as string;
          const empty = {
            base: {},
            local: {},
            remote: {},
            conflicts: [],
            revision: 1,
            projectExternalId: null,
            project: null,
          };
          yield* run(sql`
            INSERT INTO houston_task_source_links (
              task_id, project_id, provider, external_id, source, url, fetched_at, synced_at,
              snapshot_json, sync_state_json
            ) VALUES (
              ${row.task_id}, ${row.project_id}, ${row.provider}, ${url}, 'pull_request', ${url},
              ${now}, ${now}, ${encodeSnapshot(empty)}, ${encodeSyncState({ state: "current" })}
            ) ON CONFLICT (task_id, provider, external_id, source) DO UPDATE SET
              fetched_at = excluded.fetched_at, synced_at = excluded.synced_at
          `);
          touched.push(row.task_id);
        }
        if (yield* markLink(target, row.provider, null)) touched.push(target);
        yield* run(sql`
          UPDATE houston_task_source_outbox SET receipt_json = ${encodeJson({
            externalId: receipt.externalId,
            url: receipt.url,
          })},
            last_error = NULL
          WHERE id = ${row.id} AND receipt_json IS NULL
        `);
        const events: Array<SourceEvent> = [];
        for (const id of new Set(touched)) events.push(yield* linksEvent(row.project_id, id));
        return { result: null, touched: [...new Set(touched)], events };
      }),
    );

  /** The row's payload rebuilt from live state; null when live state no longer asks for it. */
  const livePayload = Effect.fnUntraced(function* (
    row: OutboxRow,
    payload: Json,
    settings: StoredSettings,
  ): Effect.fn.Return<Json | null | string> {
    const task = yield* reads.task(row.task_id);
    if (task === undefined || task.row.project_id !== row.project_id) return null;
    const target =
      targetOf(row, payload) === row.task_id ? task : yield* reads.task(targetOf(row, payload));
    if (target === undefined || target.row.project_id !== row.project_id) return null;
    const source = target.task.links.find(
      (link) => link.provider === row.provider && link.source === "source",
    );
    if (row.action === "create") {
      return source !== undefined
        ? null
        : {
            ...payload,
            title: target.row.title,
            description: target.row.description,
            status: target.row.status,
          };
    }
    if (source === undefined) return null;
    let located: Json = { externalId: source.externalId };
    if (row.provider === "github_issues") {
      const repository = settings.githubRepository ?? "";
      const issueNumber = issueNumberOf(source.externalId, repository);
      if (issueNumber === null) {
        return `the source link ${quote(source.externalId)} is not an issue of ${quote(repository)}`;
      }
      located = { issueNumber };
    }
    switch (row.action) {
      case "status":
        return {
          ...payload,
          ...located,
          status: target.row.status,
          revision: target.row.revision,
        };
      case "summary_comment":
      case "handback_summary": {
        const latest = yield* reads.latestRun(row.task_id);
        return {
          ...payload,
          ...located,
          ...(latest.summary === null ? {} : { summary: `${task.row.title}: ${latest.summary}` }),
        };
      }
      case "pr_reference":
      case "pull_request_url": {
        const latest = yield* reads.latestRun(row.task_id);
        const url = latest.prUrl ?? text(payload.url);
        if (url === null) return null;
        const linked = task.task.links.some(
          (link) =>
            link.provider === row.provider &&
            link.source === "pull_request" &&
            link.externalId === url,
        );
        return linked ? null : { ...payload, ...located, url };
      }
      case "delivery_close": {
        if (target.row.status !== "done" || target.task.domain?.kind !== "delivery") return null;
        const slices = yield* reads.slices(target.row.id);
        const allDone = slices.total > 0 && slices.done === slices.total;
        return allDone || target.task.domain.userStatusOverride ? { ...payload, ...located } : null;
      }
      default:
        return `unknown write-back action ${quote(row.action)}`;
    }
  });

  // GitHub writes.

  const githubRest = Effect.fnUntraced(function* (
    operation: string,
    input: Omit<GitHubRest.GitHubRestInput, "host" | "operation" | "timeout">,
  ) {
    const timeout = yield* GitHubRequestTimeout;
    const response = yield* github
      .rest({ host: "github.com", operation: "houstonTaskSourcesWrite", timeout, ...input })
      .pipe(Effect.mapError((error) => describeGitHubError(operation, error, timeout)));
    if (response.truncated)
      return yield* Effect.fail(`${operation} answered more than the response bound`);
    return response;
  });

  const githubList = Effect.fnUntraced(function* (operation: string, path: string, page: number) {
    const response = yield* githubRest(`${operation} page ${page}`, {
      path: `${path}${path.includes("?") ? "&" : "?"}per_page=${GITHUB_PAGE_SIZE}&page=${page}`,
    });
    const parsed = Option.getOrNull(decodeJson(response.body));
    if (!Array.isArray(parsed)) return yield* Effect.fail(`${operation} did not answer a list`);
    return parsed as ReadonlyArray<unknown>;
  });

  /** The login the credential acts as, read once a marked item needs it. */
  const viewerLogin = Effect.fnUntraced(function* () {
    const response = yield* githubRest("GitHub authenticated user lookup", { path: "user" });
    const user = Option.getOrNull(decodeJson(response.body));
    const login = isObject(user) ? text(user.login) : null;
    if (login === null)
      return yield* Effect.fail("GitHub answered the user lookup without a login");
    return login.toLowerCase();
  });

  /** The first listed item that ends with `marker` and that the credential's account wrote, read
   * page by page up to the bound. A marker quoted in copied text, or written by someone else, is
   * not Houston's. */
  const findMarked = Effect.fnUntraced(function* (
    operation: string,
    path: string,
    marker: string,
    issuesOnly: boolean,
  ) {
    let login: string | null = null;
    for (let page = 1; page <= GITHUB_MAX_PAGES; page += 1) {
      const items = yield* githubList(operation, path, page);
      for (const item of items) {
        if (
          !isObject(item) ||
          (issuesOnly && item.pull_request !== undefined && item.pull_request !== null) ||
          !endsWithMarker(text(item.body) ?? "", marker)
        ) {
          continue;
        }
        login ??= yield* viewerLogin();
        const author = isObject(item.user) ? text(item.user.login) : null;
        if (author?.toLowerCase() === login) return item;
      }
      if (items.length < GITHUB_PAGE_SIZE) return null;
    }
    return yield* Effect.fail(`${operation} exceeded the ${GITHUB_MAX_PAGES}-page bound`);
  });

  const issueReceipt = (repository: string, issue: Json): Receipt | string => {
    const record = githubRecord(issue, repository);
    if (record === null) return "GitHub answered an issue without a number or URL";
    return {
      externalId: record.externalId,
      url: record.url,
      remote: { fields: record.fields, rev: record.remoteRev },
    };
  };

  const writeGitHub = Effect.fnUntraced(function* (
    settings: StoredSettings,
    row: OutboxRow,
    payload: Json,
  ): Effect.fn.Return<Receipt, string> {
    const action = row.action;
    const repository = parseRepository(settings.githubRepository ?? "");
    if (repository === null) {
      return yield* Effect.fail(
        `GitHub repository ${quote(settings.githubRepository ?? "")} is not owner/name`,
      );
    }
    if (action === "create") {
      const marker = text(payload.marker) ?? "";
      const found = yield* findMarked(
        `GitHub delivery issue lookup in ${repository}`,
        `repos/${repository}/issues?state=all`,
        marker,
        true,
      );
      const issue =
        found ??
        Option.getOrNull(
          decodeJson(
            (yield* githubRest(`GitHub delivery issue create in ${repository}`, {
              method: "POST",
              path: `repos/${repository}/issues`,
              body: {
                title: cutChars(text(payload.title) ?? "", WRITE_LIMITS.issueTitleChars),
                body: `${neutralise(
                  cutChars(text(payload.description) ?? "", WRITE_LIMITS.issueBodyChars),
                )}\n\n${marker}`,
              },
            })).body,
          ),
        );
      const receipt = isObject(issue)
        ? issueReceipt(repository, issue)
        : "GitHub answered the issue create without an issue";
      return typeof receipt === "string" ? yield* Effect.fail(receipt) : receipt;
    }
    const number = typeof payload.issueNumber === "number" ? payload.issueNumber : null;
    if (number === null) return yield* Effect.fail("the write-back row names no issue");
    const issue = {
      externalId: `${repository}#${number}`,
      url: `https://github.com/${repository}/issues/${number}`,
    };
    if (action === "delivery_close") {
      yield* githubRest(`GitHub delivery issue close of ${repository}#${number}`, {
        method: "PATCH",
        path: `repos/${repository}/issues/${number}`,
        body: { state: "closed" },
      });
      return issue;
    }
    // The row's id names the transition, so a retry finds its first post whatever changed since.
    const marker = commentMarker(
      yield* identity.markerKey,
      text(payload.taskIdentity) ?? "",
      row.id,
      action,
    );
    let body: string;
    switch (action) {
      case "status":
        body = statusComment(text(payload.status) ?? "", text(payload.summary) ?? "", marker);
        break;
      case "summary_comment":
        body = `${neutralise(cutChars(text(payload.summary) ?? "", WRITE_LIMITS.summaryChars))}\n${marker}`;
        break;
      case "pr_reference": {
        const url = githubPullRequestUrl(text(payload.url) ?? "", repository);
        if (url === null) {
          return yield* Effect.fail(
            `pull request reference ${quote(text(payload.url) ?? "")} must be an https://github.com/${repository}/pull/<number> URL`,
          );
        }
        body = `Pull request: ${url}\n${marker}`;
        break;
      }
      default:
        return yield* Effect.fail(`unsupported GitHub Issues write action ${quote(action)}`);
    }
    const comments = `repos/${repository}/issues/${number}/comments`;
    const posted = yield* findMarked(
      `GitHub comment lookup on ${repository}#${number}`,
      comments,
      marker,
      false,
    );
    if (posted === null) {
      yield* githubRest(`GitHub comment on ${repository}#${number}`, {
        method: "POST",
        path: comments,
        body: { body },
      });
    }
    return issue;
  });

  const withNotion = <A, E>(effect: Effect.Effect<A, E, NotionClient>) =>
    Effect.provideService(effect, NotionClient, notion);

  const send = Effect.fnUntraced(function* (row: OutboxRow) {
    const settingsRow = yield* store.settingsRow(row.project_id, row.provider);
    const payload = Option.getOrNull(decodeJson(row.payload_json));
    const target = isObject(payload) ? targetOf(row, payload) : row.task_id;
    if (settingsRow === undefined) {
      return yield* failed(row, target, "tracker configuration was removed");
    }
    if (settingsRow.enabled === 0) return yield* failed(row, target, "tracker is disabled");
    if (!isObject(payload)) return yield* failed(row, target, "the write-back row is not JSON");
    const settings = settingsFromRow(settingsRow);
    const live = yield* livePayload(row, payload, settings);
    if (live === null) return yield* superseded(row);
    if (typeof live === "string") return yield* failed(row, target, live);
    let receipt: Receipt;
    if (row.provider === "github_issues") {
      const written = yield* Effect.result(writeGitHub(settings, row, live));
      if (written._tag === "Failure") return yield* failed(row, target, written.failure);
      receipt = written.success;
    } else {
      const read = yield* Effect.result(
        keychain.get(store.tokenService(row.project_id, "notion"), TOKEN_ACCOUNT),
      );
      if (read._tag === "Failure") return yield* failed(row, target, TOKEN_UNAVAILABLE);
      if (Option.isNone(read.success)) return yield* failed(row, target, TOKEN_MISSING);
      const written = yield* Effect.result(
        withNotion(
          writeNotion(read.success.value, settings, row.action, {
            externalId: text(live.externalId) ?? "",
            status: text(live.status),
            url: text(live.url),
            summary: text(live.summary),
          }),
        ),
      );
      if (written._tag === "Failure") return yield* failed(row, target, written.failure);
      receipt = written.success;
    }
    const refused = yield* sent(row, target, live, receipt);
    if (refused !== null) yield* failed(row, target, refused);
  });

  const drainUpTo: HoustonTaskSourceOutboxDrain["Service"]["drainUpTo"] = (limit) =>
    lock.withPermits(1)(
      Effect.gen(function* () {
        const now = yield* nowIso;
        const rows = yield* run(sql<OutboxRow>`
          SELECT id, project_id, task_id, provider, action, revision, payload_json, attempts
          FROM houston_task_source_outbox
          WHERE receipt_json IS NULL AND next_attempt_at <= ${now}
          ORDER BY id LIMIT ${limit}
        `);
        for (const row of rows) {
          yield* send(row).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning(`Task source write-back row ${row.id} failed.`, cause),
            ),
          );
        }
        return rows.length;
      }),
    );

  const drain = drainUpTo(OUTBOX_BATCH);

  yield* Effect.forever(
    Effect.sleep(Duration.seconds(POLL_INTERVAL_SECONDS)).pipe(
      Effect.andThen(drain),
      Effect.catchCause((cause) =>
        Effect.logWarning("Task source write-back drain failed.", cause),
      ),
    ),
  ).pipe(Effect.forkScoped);

  return HoustonTaskSourceOutboxDrain.of({ drainUpTo, drain });
});

export const layerDrain = Layer.effect(HoustonTaskSourceOutboxDrain, makeDrain);
