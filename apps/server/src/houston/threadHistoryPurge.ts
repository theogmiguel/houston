import { type ThreadId } from "@houston-app/contracts";
import * as NodeSqliteClient from "@houston-app/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { promptReferencesQuery } from "../orchestration-v2/ProjectionMaintenance.ts";

// Small pages keep each write lock short; a retried effect resumes where the last page ended.
const PAGE_SIZE = 500;
// Matches ProjectionMaintenance.promptReferencesQuery's page size.
const REFERENCE_PAGE_SIZE = 500;

// The rows that belong to a thread's conversation, keyed by a plain thread_id column.
const ROWID_THREAD_TABLES = [
  "orchestration_v2_projection_runs",
  "orchestration_v2_projection_run_attempts",
  "orchestration_v2_projection_nodes",
  "orchestration_v2_projection_plans",
  "orchestration_v2_projection_runtime_requests",
  "orchestration_v2_projection_turn_items",
  "orchestration_v2_projection_messages",
  "orchestration_v2_projection_provider_turns",
  "orchestration_v2_projection_provider_threads",
  "orchestration_v2_projection_provider_sessions",
  "orchestration_v2_projection_provider_session_bindings",
  "orchestration_v2_projection_subagents",
  "orchestration_v2_projection_checkpoint_scopes",
  "orchestration_v2_projection_checkpoints",
  "orchestration_v2_projection_context_handoffs",
  "orchestration_v2_turn_item_positions",
  // Provider events from before the application log; it has no reader left.
  "orchestration_v2_events",
  "mcp_app_model_context",
  "projection_thread_messages",
  "projection_thread_sessions",
  "projection_thread_pull_requests",
] as const;

const deleteRowidPage = (table: string, threadId: ThreadId) => {
  return Effect.flatMap(
    SqlClient.SqlClient,
    (sql) => sql<{ readonly rowid: number }>`
      DELETE FROM ${sql(table)}
      WHERE rowid IN (
        SELECT rowid FROM ${sql(table)} WHERE thread_id = ${threadId} LIMIT ${PAGE_SIZE}
      )
      RETURNING rowid
    `,
  );
};

// A transfer is part of its target's conversation: one a live thread received stays.
const deleteContextTransferPage = (threadId: ThreadId) =>
  Effect.flatMap(
    SqlClient.SqlClient,
    (sql) => sql<{ readonly rowid: number }>`
      DELETE FROM orchestration_v2_projection_context_transfers
      WHERE rowid IN (
        SELECT transfer.rowid FROM orchestration_v2_projection_context_transfers AS transfer
        WHERE transfer.target_thread_id = ${threadId}
          OR (
            transfer.source_thread_id = ${threadId}
            AND NOT EXISTS (
              SELECT 1 FROM orchestration_v2_projection_threads AS target
              WHERE target.thread_id = transfer.target_thread_id AND target.deleted_at IS NULL
            )
          )
        LIMIT ${PAGE_SIZE}
      )
      RETURNING rowid
    `,
  );

const readDeletedAt = (threadId: ThreadId) =>
  Effect.flatMap(
    SqlClient.SqlClient,
    (sql) =>
      sql<{ readonly deleted_at: string | null }>`
        SELECT deleted_at FROM orchestration_v2_projection_threads WHERE thread_id = ${threadId}
      `,
  ).pipe(Effect.map((rows) => rows[0]?.deleted_at ?? null));

const readEventBounds = (threadId: ThreadId) =>
  Effect.flatMap(
    SqlClient.SqlClient,
    (sql) =>
      sql<{ readonly head: number; readonly deleted_sequence: number | null }>`
        SELECT
          COALESCE((SELECT MAX(sequence) FROM orchestration_events), 0) AS head,
          (
            SELECT MIN(sequence) FROM orchestration_events
            WHERE aggregate_kind = 'thread'
              AND stream_id = ${threadId}
              AND event_type = 'thread.deleted'
          ) AS deleted_sequence
      `,
  ).pipe(Effect.map((rows) => rows[0]!));

/**
 * Removes one deleted thread's conversation from the database. The thread row stays as the
 * tombstone. Every step is idempotent, and pages commit separately so an interrupted purge can
 * run again. Events at or after `thread.deleted` stay, as do older anchors another stream
 * borrows through `promptSequence`.
 */
export const purgeThreadHistory = Effect.fn("ThreadHistoryPurge.purgeThreadHistory")(function* (
  threadId: ThreadId,
  betweenPages: Effect.Effect<void> = Effect.void,
) {
  const sql = yield* SqlClient.SqlClient;
  // A thread that is not soft-deleted, or was never stored, has no history to purge.
  if ((yield* readDeletedAt(threadId)) === null) return;

  const { head, deleted_sequence: deletedSequenceValue } = yield* readEventBounds(threadId);
  const deletedSequence = deletedSequenceValue ?? head + 1;

  const referenced = new Set<number>();
  const collectReferences = Effect.fn("ThreadHistoryPurge.collectReferences")(function* (input: {
    readonly afterSequence: number;
    readonly throughSequence: number;
    readonly onlyStreamId?: string;
    readonly excludingStreamId?: string;
  }) {
    let cursor = input.afterSequence;
    while (cursor <= input.throughSequence) {
      const rows = yield* promptReferencesQuery(sql, {
        afterSequence: cursor,
        throughSequence: input.throughSequence,
        ...(input.onlyStreamId === undefined ? {} : { onlyStreamId: input.onlyStreamId }),
        ...(input.excludingStreamId === undefined
          ? {}
          : { excludingStreamId: input.excludingStreamId }),
      }).pipe(NodeSqliteClient.readOnly);
      for (const row of rows) referenced.add(row.prompt_sequence);
      yield* betweenPages;
      if (rows.length < REFERENCE_PAGE_SIZE) break;
      cursor = rows.at(-1)?.sequence ?? input.throughSequence;
    }
  });

  // Other streams keep whatever they borrow, deleted or not; a still-live thread must still read
  // its prompt. The deleted thread's own kept events borrow too.
  yield* collectReferences({
    afterSequence: 0,
    throughSequence: head,
    excludingStreamId: threadId,
  });
  if (deletedSequence > 0) {
    yield* collectReferences({
      afterSequence: deletedSequence - 1,
      throughSequence: head,
      onlyStreamId: threadId,
    });
  }

  for (const table of ROWID_THREAD_TABLES) {
    while (true) {
      const deleted = yield* sql.withTransaction(deleteRowidPage(table, threadId));
      if (deleted.length > 0) yield* Effect.yieldNow;
      yield* betweenPages;
      if (deleted.length < PAGE_SIZE) break;
    }
  }
  while (true) {
    const deleted = yield* sql.withTransaction(deleteContextTransferPage(threadId));
    if (deleted.length > 0) yield* Effect.yieldNow;
    yield* betweenPages;
    if (deleted.length < PAGE_SIZE) break;
  }

  // These read models are WITHOUT ROWID, so pages select their own keys.
  yield* sql`DELETE FROM houston_thread_shell WHERE thread_id = ${threadId}`;
  yield* betweenPages;
  while (true) {
    const deleted = yield* sql.withTransaction(
      Effect.flatMap(
        SqlClient.SqlClient,
        (client) => client<{ readonly message_id: string }>`
          DELETE FROM houston_user_messages
          WHERE message_id IN (
            SELECT message_id FROM houston_user_messages
            WHERE thread_id = ${threadId}
            LIMIT ${PAGE_SIZE}
          )
          RETURNING message_id
        `,
      ),
    );
    if (deleted.length > 0) yield* Effect.yieldNow;
    yield* betweenPages;
    if (deleted.length < PAGE_SIZE) break;
  }
  while (true) {
    const deleted = yield* sql.withTransaction(
      Effect.flatMap(
        SqlClient.SqlClient,
        (client) => client<{ readonly run_id: string }>`
          DELETE FROM houston_turn_item_counts
          WHERE thread_id = ${threadId}
            AND run_id IN (
              SELECT run_id FROM houston_turn_item_counts
              WHERE thread_id = ${threadId}
              LIMIT ${PAGE_SIZE}
            )
          RETURNING run_id
        `,
      ),
    );
    if (deleted.length > 0) yield* Effect.yieldNow;
    yield* betweenPages;
    if (deleted.length < PAGE_SIZE) break;
  }

  let referencesThrough = head;
  let cursor = 0;
  while (cursor < deletedSequence) {
    const rows = yield* sql<{ readonly sequence: number }>`
      SELECT sequence FROM orchestration_events
      WHERE aggregate_kind = 'thread'
        AND stream_id = ${threadId}
        AND sequence > ${cursor}
        AND sequence < ${deletedSequence}
        -- Keep what ProjectionMaintenance.pruneEventStore keeps, for the same readers.
        AND application_event_version = 2
        AND event_type != 'thread.created'
        AND NOT (
          event_type = 'run.updated' AND json_extract(payload_json, '$.status') = 'running'
        )
        AND sequence != (
          SELECT MAX(newer.sequence) FROM orchestration_events AS newer
          WHERE newer.aggregate_kind = 'thread' AND newer.stream_id = ${threadId}
        )
      ORDER BY sequence ASC
      LIMIT ${PAGE_SIZE}
    `.pipe(NodeSqliteClient.readOnly);
    // Never hold a transaction or the reader lock across a yield or a rest.
    yield* Effect.yieldNow;
    if (rows.length > 0) {
      yield* sql.withTransaction(
        Effect.gen(function* () {
          const appendedHead = (yield* sql<{ readonly sequence: number }>`
            SELECT COALESCE(MAX(sequence), 0) AS sequence FROM orchestration_events
          `)[0]!.sequence;
          // Rows appended since the scan may borrow an anchor this purge would delete.
          let appendedCursor = referencesThrough;
          while (appendedCursor < appendedHead) {
            const appended = yield* promptReferencesQuery(sql, {
              afterSequence: appendedCursor,
              throughSequence: appendedHead,
            }).pipe(NodeSqliteClient.readOnly);
            for (const row of appended) referenced.add(row.prompt_sequence);
            if (appended.length < REFERENCE_PAGE_SIZE) break;
            appendedCursor = appended.at(-1)?.sequence ?? appendedHead;
          }
          referencesThrough = appendedHead;
          const obsolete = rows
            .map((row) => row.sequence)
            .filter((sequence) => !referenced.has(sequence));
          if (obsolete.length > 0) {
            yield* sql`DELETE FROM orchestration_events WHERE sequence IN ${sql.in(obsolete)}`;
          }
        }),
      );
      yield* Effect.yieldNow;
    }
    // Rest after every page, including the last, so the next loop starts a fresh slice.
    yield* betweenPages;
    if (rows.length < PAGE_SIZE) break;
    cursor = rows.at(-1)?.sequence ?? cursor;
  }
});

/** Purges every thread a previous build soft-deleted. */
export const purgeDeletedThreadHistories = Effect.fn(
  "ThreadHistoryPurge.purgeDeletedThreadHistories",
)(function* (betweenPages: Effect.Effect<void> = Effect.void) {
  const sql = yield* SqlClient.SqlClient;
  const threads = yield* sql<{ readonly thread_id: ThreadId }>`
    SELECT thread_id FROM orchestration_v2_projection_threads WHERE deleted_at IS NOT NULL
  `.pipe(NodeSqliteClient.readOnly);
  for (const row of threads) {
    yield* purgeThreadHistory(row.thread_id, betweenPages);
  }
});
