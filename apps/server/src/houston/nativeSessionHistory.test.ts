// The projection records every native session id a provider thread has had, the migration and the
// background backfill record what the database still names, and a deleted thread leaves no rows.
import { assert, describe, it } from "@effect/vitest";
import {
  OrchestrationV2ProviderThread,
  ProviderDriverKind,
  ProviderThreadId,
  type OrchestrationV2DomainEvent,
} from "@houston-app/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { runHoustonMigrations } from "./migrations.ts";
import {
  backfillNativeSessionsFromEvents,
  hasUnrecordedEarlierSessions,
  NATIVE_SESSION_BACKFILL_PAGE,
  readNativeSessionHistory,
} from "./nativeSessionHistory.ts";
import { replayedTurnEvents } from "./shellReads.testkit.ts";

type ProviderThreadEvent = Extract<OrchestrationV2DomainEvent, { type: "provider-thread.updated" }>;
type ThreadCreatedEvent = Extract<OrchestrationV2DomainEvent, { type: "thread.created" }>;

const projectionLayer = () =>
  Layer.fresh(ProjectionStore.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory)));

const lastProviderThreadEvent = (events: ReadonlyArray<OrchestrationV2DomainEvent>) =>
  events.findLast(
    (event): event is ProviderThreadEvent => event.type === "provider-thread.updated",
  )!;

let eventCounter = 0;
// The provider thread as the next event would carry it, later than the last one.
const nextProviderThreadEvent = (
  previous: ProviderThreadEvent,
  change: Partial<OrchestrationV2ProviderThread>,
): ProviderThreadEvent => {
  const updatedAt = DateTime.add(previous.payload.updatedAt, { minutes: 5 });
  eventCounter += 1;
  return {
    ...previous,
    id: `${previous.id}:next-${eventCounter}` as ProviderThreadEvent["id"],
    occurredAt: updatedAt,
    payload: { ...previous.payload, updatedAt, ...change },
  };
};

const withNativeId = (event: ProviderThreadEvent, nativeId: string | null) =>
  nextProviderThreadEvent(event, {
    nativeThreadRef:
      nativeId === null
        ? null
        : {
            ...(event.payload.nativeThreadRef ?? { strength: "strong" as const }),
            driver: event.payload.driver,
            nativeId,
          },
  });

const sessionRows = Effect.gen(function* () {
  const history = yield* readNativeSessionHistory();
  return history.sessions.map((row) => [row.providerThreadId, row.nativeId, row.origin] as const);
});

describe("the projection records each native session id", () => {
  it.effect("the first session of a thread is recorded once", () =>
    Effect.gen(function* () {
      const events = yield* replayedTurnEvents;
      yield* Effect.gen(function* () {
        const projections = yield* ProjectionStore.ProjectionStoreV2;
        for (const event of events) yield* projections.apply(event);
        const current = lastProviderThreadEvent(events).payload;
        assert.isString(current.nativeThreadRef?.nativeId);
        const history = yield* readNativeSessionHistory();
        assert.isString(history.recordedSince);
        assert.deepEqual(
          history.sessions.map((row) => ({ ...row, firstSeenAt: typeof row.firstSeenAt })),
          [
            {
              providerThreadId: current.id,
              threadId: current.appThreadId,
              provider: "claudeAgent",
              nativeId: current.nativeThreadRef!.nativeId!,
              firstSeenAt: "string",
              origin: "recorded",
            },
          ],
        );
      }).pipe(Effect.provide(projectionLayer()));
    }),
  );

  it.effect("a fresh-session fallback keeps the replaced id beside the new one", () =>
    Effect.gen(function* () {
      const events = yield* replayedTurnEvents;
      yield* Effect.gen(function* () {
        const projections = yield* ProjectionStore.ProjectionStoreV2;
        for (const event of events) yield* projections.apply(event);
        const last = lastProviderThreadEvent(events);
        const replaced = last.payload.nativeThreadRef!.nativeId!;
        // The fallback overwrites the same provider thread's id in place.
        const fallback = withNativeId(last, "session:fresh");
        yield* projections.apply(fallback);
        assert.deepEqual(yield* sessionRows, [
          [last.payload.id, replaced, "recorded"],
          [last.payload.id, "session:fresh", "recorded"],
        ]);
        const history = yield* readNativeSessionHistory();
        assert.equal(
          history.sessions[1]!.firstSeenAt,
          DateTime.formatIso(fallback.payload.updatedAt),
        );
        const thread = yield* projections.getThread(last.threadId);
        assert.equal(thread.activeProviderThreadId, last.payload.id);
      }).pipe(Effect.provide(projectionLayer()));
    }),
  );

  it.effect("a cleared id writes nothing and its replacement is recorded once", () =>
    Effect.gen(function* () {
      const events = yield* replayedTurnEvents;
      yield* Effect.gen(function* () {
        const projections = yield* ProjectionStore.ProjectionStoreV2;
        for (const event of events) yield* projections.apply(event);
        const last = lastProviderThreadEvent(events);
        const before = yield* sessionRows;
        const cleared = withNativeId(last, null);
        yield* projections.apply(cleared);
        assert.deepEqual(yield* sessionRows, before);
        const replacement = withNativeId(cleared, "session:replacement");
        yield* projections.apply(replacement);
        // Later updates of the same session, such as a status change, add nothing.
        yield* projections.apply(nextProviderThreadEvent(replacement, { status: "idle" }));
        assert.deepEqual(yield* sessionRows, [
          ...before,
          [last.payload.id, "session:replacement", "recorded"],
        ]);
      }).pipe(Effect.provide(projectionLayer()));
    }),
  );

  it.effect("a provider switch records the new provider thread's session", () =>
    Effect.gen(function* () {
      const events = yield* replayedTurnEvents;
      yield* Effect.gen(function* () {
        const projections = yield* ProjectionStore.ProjectionStoreV2;
        for (const event of events) yield* projections.apply(event);
        const last = lastProviderThreadEvent(events);
        const codex = ProviderDriverKind.make("codex");
        const switched = nextProviderThreadEvent(last, {
          id: ProviderThreadId.make("provider-thread:switched"),
          driver: codex,
          nativeThreadRef: { driver: codex, nativeId: "codex-thread", strength: "strong" },
        });
        yield* projections.apply(switched);
        const history = yield* readNativeSessionHistory();
        assert.deepEqual(
          history.sessions.map((row) => [row.providerThreadId, row.provider, row.nativeId]),
          [
            [last.payload.id, "claudeAgent", last.payload.nativeThreadRef!.nativeId!],
            ["provider-thread:switched", "codex", "codex-thread"],
          ],
        );
      }).pipe(Effect.provide(projectionLayer()));
    }),
  );

  it.effect("deleting a thread deletes its rows, and later updates do not bring them back", () =>
    Effect.gen(function* () {
      const events = yield* replayedTurnEvents;
      yield* Effect.gen(function* () {
        const projections = yield* ProjectionStore.ProjectionStoreV2;
        for (const event of events) yield* projections.apply(event);
        const last = lastProviderThreadEvent(events);
        const created = events.find(
          (event): event is ThreadCreatedEvent => event.type === "thread.created",
        )!;
        // A row of another thread stays.
        yield* projections.apply(
          nextProviderThreadEvent(last, {
            id: ProviderThreadId.make("provider-thread:other"),
            appThreadId: null,
            nativeThreadRef: { driver: last.payload.driver, nativeId: "other", strength: "strong" },
          }),
        );
        const deletedAt = DateTime.add(last.payload.updatedAt, { minutes: 1 });
        yield* projections.apply({
          ...created,
          id: `${created.id}:deleted` as ThreadCreatedEvent["id"],
          type: "thread.deleted",
          occurredAt: deletedAt,
          payload: {
            ...(yield* projections.getThread(created.threadId)),
            deletedAt,
            updatedAt: deletedAt,
          },
        } as OrchestrationV2DomainEvent);
        yield* projections.apply(withNativeId(last, "session:after-delete"));
        assert.deepEqual(yield* sessionRows, [["provider-thread:other", "other", "recorded"]]);
      }).pipe(Effect.provide(projectionLayer()));
    }),
  );

  it.effect("a lookup by native id uses the index", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const plan = yield* sql<{ readonly detail: string }>`
        EXPLAIN QUERY PLAN
        SELECT provider_thread_id FROM houston_provider_native_sessions WHERE native_id = 'x'
      `;
      assert.match(
        plan.map((row) => row.detail).join(" | "),
        /SEARCH houston_provider_native_sessions USING (COVERING )?INDEX houston_provider_native_sessions_native_idx/,
      );
    }).pipe(Effect.provide(Layer.fresh(SqlitePersistence.layerMemory))),
  );
});

const encodeProviderThread = Schema.encodeSync(
  Schema.fromJsonString(OrchestrationV2ProviderThread),
);

describe("the session history backfills what the database still names", () => {
  // Composed fixture: the projection holds the replayed thread after a fallback to a fresh session,
  // and the event log still holds the event that named the replaced id, as within the retained day.
  // The history tables and migration row are then removed, as on a database from an earlier build.
  const earlierBuild = Effect.gen(function* () {
    const events = yield* replayedTurnEvents;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const sql = yield* SqlClient.SqlClient;
    for (const event of events) yield* projections.apply(event);
    const last = lastProviderThreadEvent(events);
    yield* projections.apply(withNativeId(last, "session:current"));
    let row = 0;
    const insertEvent = (input: {
      readonly eventType: string;
      readonly payload: string;
      readonly occurredAt?: string;
      readonly aggregateKind?: string;
      readonly version?: number;
    }) => {
      row += 1;
      return sql`
        INSERT INTO orchestration_events (event_id, aggregate_kind, stream_id, stream_version,
          event_type, occurred_at, actor_kind, payload_json, metadata_json, application_event_version)
        VALUES (${`fixture:${row}`}, ${input.aggregateKind ?? "thread"}, ${last.threadId},
          ${1000 + row}, ${input.eventType}, ${input.occurredAt ?? "2026-01-01T00:00:00.000Z"},
          'provider', ${input.payload}, '{}', ${input.version ?? 2})
      `;
    };
    // Rows of other kinds, each payload far larger than a page, naming ids that are not sessions.
    const decoy = (eventType: string, aggregateKind = "thread", version = 2) =>
      insertEvent({
        eventType,
        aggregateKind,
        version,
        payload: JSON.stringify({
          id: "provider-thread:decoy",
          driver: "codex",
          nativeThreadRef: { nativeId: `not-a-session:${eventType}:${aggregateKind}:${version}` },
          text: "x".repeat(64 * 1024),
        }),
      });
    yield* decoy("turn-item.updated");
    const earliest = DateTime.add(last.occurredAt, { minutes: -30 });
    yield* insertEvent({
      eventType: "provider-thread.updated",
      payload: encodeProviderThread(last.payload),
      occurredAt: DateTime.formatIso(earliest),
    });
    yield* decoy("run.updated");
    yield* decoy("provider-thread.updated", "project");
    yield* decoy("provider-thread.updated", "thread", 1);
    // The same id again later: the backfill keeps the earliest sighting.
    yield* insertEvent({
      eventType: "provider-thread.updated",
      payload: encodeProviderThread(last.payload),
      occurredAt: DateTime.formatIso(last.occurredAt),
    });
    yield* insertEvent({ eventType: "provider-thread.updated", payload: "not json" });
    yield* decoy("turn-item.updated");
    yield* sql`DROP TABLE houston_provider_native_sessions`;
    yield* sql`DROP TABLE houston_native_session_history`;
    yield* sql`DELETE FROM houston_sql_migrations WHERE migration_id = 29`;
    return {
      last,
      earliest: DateTime.formatIso(earliest),
      replaced: last.payload.nativeThreadRef!.nativeId!,
    };
  });

  const backfillState = Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return (yield* sql<{
      readonly cursor: number;
      readonly through: number;
      readonly done: string | null;
    }>`
      SELECT backfill_cursor AS cursor, backfill_through AS through, backfilled_at AS done
      FROM houston_native_session_history
    `)[0]!;
  });

  it.effect("the migration records current ids and the backfill adds replaced ids, once", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const { last, earliest, replaced } = yield* earlierBuild;
      assert.deepEqual(yield* runHoustonMigrations(), [[29, "ProviderNativeSessions"]]);
      // The migration itself reads no events.
      assert.deepEqual(yield* sessionRows, [
        [last.payload.id, "session:current", "backfill_current"],
      ]);
      assert.isNull((yield* backfillState).done);

      assert.equal(yield* backfillNativeSessionsFromEvents(), 1);
      assert.sameDeepMembers(
        [...(yield* sessionRows)],
        [
          [last.payload.id, replaced, "backfill_event"],
          [last.payload.id, "session:current", "backfill_current"],
        ],
      );
      const history = yield* readNativeSessionHistory();
      assert.equal(
        history.sessions.find((row) => row.nativeId === replaced)!.firstSeenAt,
        earliest,
      );
      const state = yield* backfillState;
      assert.isString(state.done);
      assert.equal(state.cursor, state.through);
      assert.equal(yield* backfillNativeSessionsFromEvents(), 0);

      // Neither the migration nor the backfill changes anything when run again.
      const snapshot =
        yield* sql`SELECT * FROM houston_provider_native_sessions ORDER BY native_id`;
      yield* sql`DELETE FROM houston_sql_migrations WHERE migration_id = 29`;
      assert.deepEqual(yield* runHoustonMigrations(), [[29, "ProviderNativeSessions"]]);
      yield* sql`UPDATE houston_native_session_history SET backfill_cursor = 0, backfilled_at = NULL`;
      yield* backfillNativeSessionsFromEvents();
      assert.deepEqual(
        yield* sql`SELECT * FROM houston_provider_native_sessions ORDER BY native_id`,
        snapshot,
      );
      assert.equal((yield* readNativeSessionHistory()).recordedSince, history.recordedSince);
      assert.deepEqual(yield* runHoustonMigrations(), []);
    }).pipe(Effect.provide(projectionLayer())),
  );

  it.effect("a backfill stopped between pages resumes from its cursor", () =>
    Effect.gen(function* () {
      const { last, replaced } = yield* earlierBuild;
      yield* runHoustonMigrations();
      let paused = 0;
      const stopAfterThreePages = Effect.suspend(() =>
        ++paused === 3 ? Effect.die("stopped") : Effect.void,
      );
      const stopped = yield* Effect.exit(
        backfillNativeSessionsFromEvents({ pageSequences: 1, betweenPages: stopAfterThreePages }),
      );
      assert.isTrue(Exit.isFailure(stopped));
      const state = yield* backfillState;
      assert.isNull(state.done);
      assert.isAbove(state.cursor, 0);
      assert.isBelow(state.cursor, state.through);

      yield* backfillNativeSessionsFromEvents({ pageSequences: 1 });
      assert.isString((yield* backfillState).done);
      assert.sameDeepMembers(
        [...(yield* sessionRows)],
        [
          [last.payload.id, replaced, "backfill_event"],
          [last.payload.id, "session:current", "backfill_current"],
        ],
      );
    }).pipe(Effect.provide(projectionLayer())),
  );

  // Asserted by plan only: SQLite exposes no count of the payload pages a statement reads.
  it.effect("a page is a rowid range scan, never an index or a full scan", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const plan = yield* sql.unsafe<{ readonly detail: string }>(
        `EXPLAIN QUERY PLAN ${NATIVE_SESSION_BACKFILL_PAGE}`,
        [0, 1000],
      );
      const details = plan.map((row) => row.detail);
      assert.include(details, "SEARCH e USING INTEGER PRIMARY KEY (rowid>? AND rowid<?)");
      assert.isFalse(
        details.some((detail) => /^SCAN e\b/.test(detail)),
        details.join(" | "),
      );
    }).pipe(Effect.provide(Layer.fresh(SqlitePersistence.layerMemory))),
  );

  it.effect("a deleted thread is not backfilled", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const { last } = yield* earlierBuild;
      yield* sql`UPDATE orchestration_v2_projection_threads SET deleted_at = '2026-01-02T00:00:00.000Z'
        WHERE thread_id = ${last.threadId}`;
      yield* runHoustonMigrations();
      yield* backfillNativeSessionsFromEvents();
      assert.deepEqual(yield* sessionRows, []);
    }).pipe(Effect.provide(projectionLayer())),
  );

  it.effect("applies on a database that recorded a later Houston id first", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* earlierBuild;
      // Composed fixture: a later id merged and ran before this one did.
      yield* sql`INSERT INTO houston_sql_migrations (migration_id, name) VALUES (30, 'LaterMigration')`;
      yield* sql`DELETE FROM houston_sql_migrations WHERE migration_id = 28`;
      yield* sql`DROP TABLE houston_pending_device_approvals`;
      assert.deepEqual(yield* runHoustonMigrations(), [
        [28, "PendingDeviceApprovals"],
        [29, "ProviderNativeSessions"],
      ]);
      yield* backfillNativeSessionsFromEvents();
      assert.lengthOf(yield* sessionRows, 2);
    }).pipe(Effect.provide(projectionLayer())),
  );
});

describe("a thread is marked as having sessions Houston did not record", () => {
  const minute = 60 * 1000;
  const recordedSinceMs = 100 * minute;
  const firstRunStartedAtMs = 50 * minute;

  it("at the ten-minute boundary", () => {
    const mark = (earliestRecordedRequestAtMs: number | null) =>
      hasUnrecordedEarlierSessions({
        firstRunStartedAtMs,
        recordedSinceMs,
        earliestRecordedRequestAtMs,
      });
    assert.isFalse(mark(firstRunStartedAtMs + 10 * minute));
    assert.isTrue(mark(firstRunStartedAtMs + 10 * minute + 1));
    assert.isTrue(mark(null));
  });

  it("never when the first run started after recording began", () => {
    assert.isFalse(
      hasUnrecordedEarlierSessions({
        firstRunStartedAtMs: recordedSinceMs,
        recordedSinceMs,
        earliestRecordedRequestAtMs: recordedSinceMs + 60 * minute,
      }),
    );
  });
});
