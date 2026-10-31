// Polls every enabled task source every 20 seconds, and one project's at once on Sync now. The
// Notion token is read from the OS keychain for each poll; a failed poll keeps tasks and cursor.
import type { ProjectId } from "@t3tools/contracts";
import type {
  HoustonTaskSourceProvider,
  HoustonTaskSourceSyncResult,
} from "@t3tools/contracts/houston/taskSources";
import * as GitHubRest from "@t3tools/source-control-github/server/GitHubRest";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";

import { HoustonKeychain } from "../secrets/HoustonKeychain.ts";
import { nowIso } from "../tasks/TaskStore.ts";
import { EMPTY_GITHUB_CURSOR, pollGitHub } from "./GitHubSource.ts";
import { NotionClient, pollNotion, retrievePage } from "./NotionClient.ts";
import {
  NOTION_REFRESH_PER_POLL,
  POLL_INTERVAL_SECONDS,
  TOKEN_ACCOUNT,
  TOKEN_MISSING,
  TOKEN_UNAVAILABLE,
  errorText,
  type GithubCursor,
  type NotionCursor,
  type StoredSettings,
} from "./rules.ts";
import { HoustonTaskSourceStore, settingsFromRow, type SourceEvent } from "./SourceStore.ts";
import { HoustonTaskSourceSync } from "./Sync.ts";

export { TOKEN_MISSING, TOKEN_UNAVAILABLE } from "./rules.ts";

const Cursor = Schema.fromJsonString(Schema.Unknown);
const decodeCursor = Schema.decodeUnknownSync(Cursor);
const encodeCursor = Schema.encodeSync(Cursor);

export class HoustonTaskSourcePoller extends Context.Service<
  HoustonTaskSourcePoller,
  {
    /** Polls one source if it is enabled; the result is what `lastSyncAt` and `lastError` say. */
    readonly poll: (
      projectId: ProjectId,
      provider: HoustonTaskSourceProvider,
    ) => Effect.Effect<HoustonTaskSourceSyncResult | null>;
    /** Polls every enabled source once. */
    readonly pollAll: Effect.Effect<void>;
    /** How many poll loops this poller started; one per server. */
    readonly loopsStarted: Effect.Effect<number>;
  }
>()("houston/houston/taskSources/Poller/HoustonTaskSourcePoller") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const store = yield* HoustonTaskSourceStore;
  const sync = yield* HoustonTaskSourceSync;
  const keychain = yield* HoustonKeychain;
  const github = yield* GitHubRest.GitHubRest;
  const notion = yield* NotionClient;
  // One poll at a time, so a tick and a Sync now never read the same source twice at once.
  const lock = yield* Semaphore.make(1);
  let loops = 0;

  const withGitHub = <A, E>(effect: Effect.Effect<A, E, GitHubRest.GitHubRest>) =>
    Effect.provideService(effect, GitHubRest.GitHubRest, github);
  const withNotion = <A, E>(effect: Effect.Effect<A, E, NotionClient>) =>
    Effect.provideService(effect, NotionClient, notion);

  const finish = Effect.fnUntraced(function* (input: {
    readonly projectId: string;
    readonly provider: HoustonTaskSourceProvider;
    readonly cursor: unknown;
    readonly refreshAfter: string | null;
    readonly error: string | null;
  }) {
    const now = yield* nowIso;
    const error = input.error === null ? null : errorText(input.error);
    const state: HoustonTaskSourceSyncResult = {
      provider: input.provider,
      lastSyncAt: now,
      error,
    };
    yield* store
      .write(
        Effect.gen(function* () {
          yield* sql`
          INSERT INTO houston_task_source_poll (
            project_id, provider, cursor_json, last_sync_at, last_error, refresh_after
          ) VALUES (
            ${input.projectId}, ${input.provider}, ${encodeCursor(input.cursor)}, ${now}, ${error},
            ${input.refreshAfter}
          )
          ON CONFLICT (project_id, provider) DO UPDATE SET cursor_json = excluded.cursor_json,
            last_sync_at = excluded.last_sync_at, last_error = excluded.last_error,
            refresh_after = excluded.refresh_after
        `;
          const event: SourceEvent = { projectId: input.projectId, event: { state } };
          return { result: undefined, touched: [], events: [event] };
        }),
      )
      .pipe(Effect.orDie);
    return state;
  });

  const applyAll = Effect.fnUntraced(function* (
    projectId: ProjectId,
    provider: HoustonTaskSourceProvider,
    records: ReadonlyArray<Parameters<typeof sync.apply>[2]>,
  ) {
    const skipped: Array<string> = [];
    for (const record of records) {
      const outcome = yield* sync.apply(projectId, provider, record);
      if (outcome.skipped !== null) skipped.push(outcome.skipped);
    }
    return skipped;
  });

  const skippedText = (skipped: ReadonlyArray<string>) =>
    skipped.length === 0 ? null : `skipped ${skipped.length} record(s): ${skipped.join("; ")}`;

  const pollGitHubSource = Effect.fnUntraced(function* (
    projectId: ProjectId,
    settings: StoredSettings,
    stored: unknown,
    refreshAfter: string | null,
  ) {
    const cursor = (stored ?? EMPTY_GITHUB_CURSOR) as GithubCursor;
    const result = yield* Effect.result(withGitHub(pollGitHub(settings, cursor)));
    if (result._tag === "Failure") {
      return yield* finish({
        projectId,
        provider: "github_issues",
        cursor,
        refreshAfter,
        error: result.failure,
      });
    }
    const skipped = yield* applyAll(projectId, "github_issues", result.success.records);
    return yield* finish({
      projectId,
      provider: "github_issues",
      cursor: result.success.cursor,
      refreshAfter,
      error: skippedText(skipped),
    });
  });

  /** Refreshes up to three linked pages the poll did not return; a failing page is skipped. */
  const refreshLinked = Effect.fnUntraced(function* (
    projectId: ProjectId,
    settings: StoredSettings,
    token: Parameters<typeof retrievePage>[0],
    schema: Parameters<typeof retrievePage>[2],
    seen: ReadonlySet<string>,
    after: string | null,
  ) {
    const ids = (yield* sql<{ readonly external_id: string }>`
      SELECT external_id FROM houston_task_source_links
      WHERE project_id = ${projectId} AND provider = 'notion' AND source = 'source'
        AND (${after} IS NULL OR external_id > ${after})
      ORDER BY external_id LIMIT ${NOTION_REFRESH_PER_POLL}
    `.pipe(Effect.orDie)).map((row) => row.external_id);
    const skipped: Array<string> = [];
    for (const id of ids) {
      if (seen.has(id)) continue;
      const read = yield* Effect.result(withNotion(retrievePage(token, settings, schema, id)));
      if (read._tag === "Failure") skipped.push(`linked page ${id}: ${read.failure}`);
      else if (typeof read.success === "string") skipped.push(read.success);
      else skipped.push(...(yield* applyAll(projectId, "notion", [read.success])));
    }
    return {
      skipped,
      next: ids.length < NOTION_REFRESH_PER_POLL ? null : (ids.at(-1) ?? null),
    };
  });

  const pollNotionSource = Effect.fnUntraced(function* (
    projectId: ProjectId,
    settings: StoredSettings,
    stored: unknown,
    refreshAfter: string | null,
  ) {
    const cursor = (stored ?? { lastEditedTime: null, continuation: null }) as NotionCursor;
    const fail = (error: string) =>
      finish({ projectId, provider: "notion", cursor, refreshAfter, error });
    const read = yield* Effect.result(
      keychain.get(store.tokenService(projectId, "notion"), TOKEN_ACCOUNT),
    );
    if (read._tag === "Failure") return yield* fail(TOKEN_UNAVAILABLE);
    if (Option.isNone(read.success)) return yield* fail(TOKEN_MISSING);
    const token = read.success.value;
    const now = yield* nowIso;
    const polled = yield* Effect.result(withNotion(pollNotion(token, settings, cursor, now)));
    if (polled._tag === "Failure") return yield* fail(polled.failure);
    const skipped = [...polled.success.skipped];
    skipped.push(...(yield* applyAll(projectId, "notion", polled.success.records)));
    let nextRefresh = refreshAfter;
    if (polled.success.complete) {
      const seen = new Set(polled.success.records.map((record) => record.externalId));
      const refreshed = yield* Effect.result(
        refreshLinked(projectId, settings, token, polled.success.schema, seen, refreshAfter),
      );
      if (refreshed._tag === "Failure") {
        skipped.push(`refreshing linked pages failed: ${refreshed.failure}`);
      } else {
        skipped.push(...refreshed.success.skipped);
        nextRefresh = refreshed.success.next;
      }
    }
    return yield* finish({
      projectId,
      provider: "notion",
      cursor: polled.success.cursor,
      refreshAfter: nextRefresh,
      error: skippedText(skipped),
    });
  });

  const pollUnlocked = Effect.fnUntraced(function* (
    projectId: ProjectId,
    provider: HoustonTaskSourceProvider,
  ) {
    const row = yield* store.settingsRow(projectId, provider);
    if (row === undefined || row.enabled === 0) return null;
    const settings = settingsFromRow(row);
    const poll = yield* store.pollRow(projectId, provider);
    const stored = poll === undefined ? null : decodeCursor(poll.cursor_json);
    const refreshAfter = poll?.refresh_after ?? null;
    return provider === "github_issues"
      ? yield* pollGitHubSource(projectId, settings, stored, refreshAfter)
      : yield* pollNotionSource(projectId, settings, stored, refreshAfter);
  });

  const poll: HoustonTaskSourcePoller["Service"]["poll"] = (projectId, provider) =>
    lock.withPermits(1)(pollUnlocked(projectId, provider));

  const pollAll = Effect.gen(function* () {
    for (const row of yield* store.enabledRows) {
      yield* poll(row.project_id as ProjectId, row.provider).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning(`Task source poll of ${row.project_id} ${row.provider} failed.`, cause),
        ),
      );
    }
  });

  loops += 1;
  yield* Effect.forever(
    pollAll.pipe(Effect.andThen(Effect.sleep(Duration.seconds(POLL_INTERVAL_SECONDS)))),
  ).pipe(Effect.forkScoped);

  return HoustonTaskSourcePoller.of({
    poll,
    pollAll,
    loopsStarted: Effect.sync(() => loops),
  });
});

export const layer = Layer.effect(HoustonTaskSourcePoller, make);
