// Every native session id a provider thread has had. A provider thread row holds only its current
// id and a fresh-session fallback overwrites it in place, so the projection records each new id
// here in the transaction that applies it. Rows hold ids and times only, never content or paths.
import type { OrchestrationV2ProviderThread } from "@houston-app/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { forkParked } from "../serverActivation.ts";

export type NativeSessionOrigin = "recorded" | "backfill_current" | "backfill_event";

export interface NativeSessionRecord {
  readonly providerThreadId: string;
  readonly threadId: string | null;
  /** The provider driver, such as `claudeAgent` or `codex`. */
  readonly provider: string;
  readonly nativeId: string;
  readonly firstSeenAt: string;
  readonly origin: NativeSessionOrigin;
}

export interface NativeSessionHistory {
  /** When recording began; sessions replaced before it are only known if the backfill saw them. */
  readonly recordedSince: string | null;
  readonly sessions: ReadonlyArray<NativeSessionRecord>;
}

// Sequences per backfill page, each its own write transaction. A page costs in proportion to its
// matching rows' payloads: 250 matching 4 KB rows took about 5 ms (warm cache; cold not measured).
const BACKFILL_PAGE_SEQUENCES = 250;

// A recorded session that starts this long after the thread's first run leaves room for a session
// Houston never saw.
const UNRECORDED_GAP_MS = 10 * 60 * 1000;

const nativeIdOf = (payload: string) =>
  `CASE WHEN json_valid(${payload}) THEN json_type(${payload}, '$.nativeThreadRef.nativeId') = 'text' ELSE 0 END`;

/** Houston migration: the tables, each provider thread's current id, and the event backfill's range. */
export const createNativeSessionHistory = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS houston_provider_native_sessions (
      provider_thread_id TEXT NOT NULL,
      thread_id TEXT,
      provider TEXT NOT NULL,
      native_id TEXT NOT NULL,
      first_seen_at TEXT NOT NULL,
      origin TEXT NOT NULL,
      PRIMARY KEY (provider_thread_id, native_id)
    )
  `;
  yield* sql`CREATE INDEX IF NOT EXISTS houston_provider_native_sessions_native_idx ON houston_provider_native_sessions(native_id)`;
  yield* sql`CREATE INDEX IF NOT EXISTS houston_provider_native_sessions_thread_idx ON houston_provider_native_sessions(thread_id)`;
  // The event backfill reads sequences in (backfill_cursor, backfill_through]; later events reach
  // the projection's writer. backfilled_at is set once it has read them all.
  yield* sql`
    CREATE TABLE IF NOT EXISTS houston_native_session_history (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      recorded_since TEXT NOT NULL,
      backfill_cursor INTEGER NOT NULL,
      backfill_through INTEGER NOT NULL,
      backfilled_at TEXT
    )
  `;
  const now = DateTime.formatIso(yield* DateTime.now);
  yield* sql`
    INSERT OR IGNORE INTO houston_native_session_history
      (id, recorded_since, backfill_cursor, backfill_through, backfilled_at)
    SELECT 1, ${now}, 0, COALESCE(MAX(sequence), 0), NULL FROM orchestration_events
  `;

  // Each provider thread's current id, one row per provider thread. Its first sighting is unknown,
  // so it starts at the row's last update until a retained event names it earlier.
  yield* sql.unsafe(`
    INSERT OR IGNORE INTO houston_provider_native_sessions
      (provider_thread_id, thread_id, provider, native_id, first_seen_at, origin)
    SELECT p.provider_thread_id, p.thread_id, COALESCE(p.driver, p.provider),
      json_extract(p.payload_json, '$.nativeThreadRef.nativeId'), p.updated_at, 'backfill_current'
    FROM orchestration_v2_projection_provider_threads AS p
    LEFT JOIN orchestration_v2_projection_threads AS t ON t.thread_id = p.thread_id
    WHERE t.deleted_at IS NULL AND ${nativeIdOf("p.payload_json")}
  `);
});

// One page of the event backfill, over sequences in (?, ?]: a rowid range scan whose nested CASE
// reads the version column (added last) and the payload only for provider-thread rows.
export const NATIVE_SESSION_BACKFILL_PAGE = `
  INSERT INTO houston_provider_native_sessions
    (provider_thread_id, thread_id, provider, native_id, first_seen_at, origin)
  SELECT seen.provider_thread_id, seen.thread_id, seen.provider, seen.native_id,
    MIN(seen.occurred_at), 'backfill_event'
  FROM (
    SELECT json_extract(e.payload_json, '$.id') AS provider_thread_id,
      json_extract(e.payload_json, '$.appThreadId') AS thread_id,
      json_extract(e.payload_json, '$.driver') AS provider,
      json_extract(e.payload_json, '$.nativeThreadRef.nativeId') AS native_id,
      e.occurred_at
    FROM orchestration_events AS e
    WHERE e.sequence > ? AND e.sequence <= ?
      AND CASE WHEN e.event_type = 'provider-thread.updated' AND e.aggregate_kind = 'thread'
        THEN CASE WHEN e.application_event_version = 2 AND json_valid(e.payload_json)
          THEN CASE WHEN json_type(e.payload_json, '$.nativeThreadRef.nativeId') = 'text'
              AND json_type(e.payload_json, '$.id') = 'text'
              AND json_type(e.payload_json, '$.driver') = 'text'
            THEN NOT EXISTS (
              SELECT 1 FROM orchestration_v2_projection_threads AS t
              WHERE t.thread_id = json_extract(e.payload_json, '$.appThreadId')
                AND t.deleted_at IS NOT NULL
            )
            ELSE 0 END
          ELSE 0 END
        ELSE 0 END
  ) AS seen
  WHERE true
  GROUP BY seen.provider_thread_id, seen.native_id
  ON CONFLICT (provider_thread_id, native_id)
  DO UPDATE SET first_seen_at = MIN(first_seen_at, excluded.first_seen_at)
`;

// Records earlier ids still named by retained events, a page per transaction, from its cursor.
// An id replaced before the event log was pruned is named nowhere and cannot be found.
export const backfillNativeSessionsFromEvents = Effect.fn(
  "houston.nativeSessionHistory.backfillFromEvents",
)(function* (
  options: {
    readonly betweenPages?: Effect.Effect<void>;
    readonly pageSequences?: number;
  } = {},
) {
  const sql = yield* SqlClient.SqlClient;
  const pageSequences = options.pageSequences ?? BACKFILL_PAGE_SEQUENCES;
  let pages = 0;
  for (;;) {
    const state = (yield* sql<{
      readonly cursor: number;
      readonly through: number;
      readonly done: string | null;
    }>`
      SELECT backfill_cursor AS cursor, backfill_through AS through, backfilled_at AS done
      FROM houston_native_session_history WHERE id = 1
    `)[0];
    if (state === undefined || state.done !== null) return pages;
    // Pruning leaves long gaps in the sequence; each page starts at the next stored event.
    const next = (yield* sql<{ readonly next: number | null }>`
      SELECT MIN(sequence) AS next FROM orchestration_events WHERE sequence > ${state.cursor}
    `)[0]?.next;
    const from = next === null || next === undefined ? state.through : next - 1;
    const through = Math.min(from + pageSequences, state.through);
    const doneAt = through >= state.through ? DateTime.formatIso(yield* DateTime.now) : null;
    yield* sql.withTransaction(
      Effect.gen(function* () {
        if (from < through) yield* sql.unsafe(NATIVE_SESSION_BACKFILL_PAGE, [from, through]);
        yield* sql`
          UPDATE houston_native_session_history
          SET backfill_cursor = ${through}, backfilled_at = ${doneAt}
          WHERE id = 1
        `;
      }),
    );
    pages += 1;
    if (doneAt !== null) return pages;
    yield* options.betweenPages ?? Effect.void;
  }
});

/** Runs the event backfill once the server is up, at about a tenth of one core. */
export const startNativeSessionBackfill = forkParked(
  Effect.gen(function* () {
    let sliceStarted = yield* Clock.monotonicTimeNanos;
    const betweenPages = Effect.gen(function* () {
      const elapsed = (yield* Clock.monotonicTimeNanos) - sliceStarted;
      if (elapsed < 25_000_000n) return;
      yield* Effect.sleep((Number(elapsed) / 1_000_000) * 9);
      sliceStarted = yield* Clock.monotonicTimeNanos;
    });
    const pages = yield* backfillNativeSessionsFromEvents({ betweenPages });
    if (pages > 0) yield* Effect.logInfo("Native session history backfilled", { pages });
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("Backfilling native session history failed", { cause }),
    ),
  ),
);

/** Records a provider thread's native id the first time it appears. A cleared id writes nothing. */
export const recordNativeSession = Effect.fnUntraced(function* (
  sql: SqlClient.SqlClient,
  providerThread: Pick<OrchestrationV2ProviderThread, "id" | "appThreadId" | "driver"> & {
    readonly nativeThreadRef: { readonly nativeId: string | null } | null;
  },
  seenAt: string,
) {
  const nativeId = providerThread.nativeThreadRef?.nativeId ?? null;
  if (nativeId === null) return;
  // A deleted thread's stopping sessions still emit updates; they must not bring its rows back.
  yield* sql`
    INSERT INTO houston_provider_native_sessions
      (provider_thread_id, thread_id, provider, native_id, first_seen_at, origin)
    SELECT ${providerThread.id}, ${providerThread.appThreadId}, ${providerThread.driver},
      ${nativeId}, ${seenAt}, 'recorded'
    WHERE NOT EXISTS (
      SELECT 1 FROM orchestration_v2_projection_threads
      WHERE thread_id = ${providerThread.appThreadId} AND deleted_at IS NOT NULL
    )
    ON CONFLICT (provider_thread_id, native_id) DO NOTHING
  `;
});

/** Deletes a thread's session history, in the transaction that applies its deletion. */
export const forgetThreadNativeSessions = (sql: SqlClient.SqlClient, threadId: string) =>
  sql`DELETE FROM houston_provider_native_sessions WHERE thread_id = ${threadId}`;

/** Every recorded session, oldest first, and when recording began. */
export const readNativeSessionHistory = Effect.fn("readNativeSessionHistory")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const since = yield* sql<{ readonly recorded_since: string }>`
    SELECT recorded_since FROM houston_native_session_history WHERE id = 1
  `;
  const sessions = yield* sql<{
    readonly provider_thread_id: string;
    readonly thread_id: string | null;
    readonly provider: string;
    readonly native_id: string;
    readonly first_seen_at: string;
    readonly origin: NativeSessionOrigin;
  }>`
    SELECT provider_thread_id, thread_id, provider, native_id, first_seen_at, origin
    FROM houston_provider_native_sessions
    ORDER BY first_seen_at, provider_thread_id, native_id
  `;
  return {
    recordedSince: since[0]?.recorded_since ?? null,
    sessions: sessions.map((row) => ({
      providerThreadId: row.provider_thread_id,
      threadId: row.thread_id,
      provider: row.provider,
      nativeId: row.native_id,
      firstSeenAt: row.first_seen_at,
      origin: row.origin,
    })),
  } satisfies NativeSessionHistory;
});

// True when a thread's first run predates recording and its first recorded request, if any, is
// more than ten minutes after that run.
export const hasUnrecordedEarlierSessions = (input: {
  readonly firstRunStartedAtMs: number;
  readonly recordedSinceMs: number;
  readonly earliestRecordedRequestAtMs: number | null;
}): boolean =>
  input.firstRunStartedAtMs < input.recordedSinceMs &&
  (input.earliestRecordedRequestAtMs === null ||
    input.earliestRecordedRequestAtMs - input.firstRunStartedAtMs > UNRECORDED_GAP_MS);
