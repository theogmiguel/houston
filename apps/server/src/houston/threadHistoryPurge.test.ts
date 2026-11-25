import { assert, it } from "@effect/vitest";
import { NodeId, ProviderDriverKind, ProviderInstanceId, ThreadId } from "@houston-app/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as EventStore from "../orchestration-v2/EventStore.ts";
import { purgeThreadHistory } from "./threadHistoryPurge.ts";

const database = SqlitePersistence.layerMemory;
const eventStoreProvided = EventStore.layer.pipe(Layer.provideMerge(database));
const layerTest = Layer.mergeAll(database, eventStoreProvided);

const deletedThread = ThreadId.make("thread:purge:deleted");
const liveThread = ThreadId.make("thread:purge:live");
const providerInstanceId = ProviderInstanceId.make("codex");
const providerDriver = ProviderDriverKind.make("codex");
const at = DateTime.makeUnsafe("2026-09-01T00:00:00.000Z");
const atIso = DateTime.formatIso(at);

const subagentPayload = (id: string, threadId: ThreadId, prompt: string) => ({
  id: NodeId.make(id),
  threadId,
  runId: null,
  parentNodeId: NodeId.make("node:purge:parent"),
  origin: "provider_native",
  createdBy: "agent",
  driver: providerDriver,
  providerInstanceId,
  providerThreadId: null,
  childThreadId: null,
  nativeTaskRef: {
    driver: providerDriver,
    nativeId: "purge-review",
    strength: "strong",
  },
  prompt,
  progress: "Reviewing",
  title: "Review",
  model: null,
  status: "running",
  result: null,
  startedAt: at,
  completedAt: null,
  updatedAt: at,
});

const insertThread = (threadId: ThreadId, deletedAt: string | null) =>
  Effect.flatMap(
    SqlClient.SqlClient,
    (sql) => sql`
      INSERT INTO orchestration_v2_projection_threads (
        thread_id, project_id, title, default_provider, provider_instance_id, runtime_mode,
        interaction_mode, active_provider_thread_id, created_at, updated_at, archived_at,
        deleted_at, payload_json
      )
      VALUES (
        ${threadId}, 'project:purge', ${threadId}, 'codex', 'codex', 'full-access',
        'default', NULL, ${atIso}, ${atIso}, NULL, ${deletedAt}, '{}'
      )
    `,
  );

const insertEvent = (input: {
  readonly eventId: string;
  readonly threadId: ThreadId;
  readonly eventType: string;
  readonly payload: unknown;
}) =>
  Effect.flatMap(
    SqlClient.SqlClient,
    (sql) => sql<{ readonly sequence: number }>`
      INSERT INTO orchestration_events (
        event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at,
        actor_kind, payload_json, metadata_json, application_event_version
      )
      VALUES (
        ${input.eventId}, 'thread', ${input.threadId},
        COALESCE(
          (SELECT MAX(stream_version) + 1 FROM orchestration_events WHERE stream_id = ${input.threadId}),
          0
        ),
        ${input.eventType}, ${atIso}, 'server', ${JSON.stringify(input.payload)}, '{}', 2
      )
      RETURNING sequence
    `,
  ).pipe(Effect.map((rows) => rows[0]!.sequence));

// One row in every table the purge owns, so a table left out of the purge shows its row.
const seedThreadContent = (threadId: ThreadId, suffix: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const id = (name: string) => `${name}:${suffix}`;
    yield* sql`
      INSERT INTO orchestration_v2_projection_runs (
        run_id, thread_id, ordinal, provider, provider_thread_id, status, requested_at,
        completed_at, payload_json
      )
      VALUES (${id("run")}, ${threadId}, 1, 'codex', ${id("provider-thread")}, 'completed',
        ${atIso}, ${atIso}, '{}')
    `;
    yield* sql`
      INSERT INTO orchestration_v2_projection_run_attempts (
        attempt_id, thread_id, run_id, attempt_ordinal, root_node_id, provider,
        provider_thread_id, provider_turn_id, status, payload_json
      )
      VALUES (${id("attempt")}, ${threadId}, ${id("run")}, 1, ${id("node")}, 'codex',
        ${id("provider-thread")}, NULL, 'completed', '{}')
    `;
    yield* sql`
      INSERT INTO orchestration_v2_projection_nodes (
        node_id, thread_id, run_id, parent_node_id, root_node_id, kind, status,
        provider_thread_id, provider_turn_id, runtime_request_id, checkpoint_scope_id,
        started_at, completed_at, payload_json
      )
      VALUES (${id("node")}, ${threadId}, ${id("run")}, NULL, ${id("node")}, 'root_turn',
        'completed', ${id("provider-thread")}, NULL, NULL, NULL, ${atIso}, ${atIso}, '{}')
    `;
    yield* sql`
      INSERT INTO orchestration_v2_projection_plans (
        plan_id, thread_id, run_id, node_id, kind, status, payload_json
      )
      VALUES (${id("plan")}, ${threadId}, ${id("run")}, ${id("node")}, 'implementation',
        'completed', '{}')
    `;
    yield* sql`
      INSERT INTO orchestration_v2_projection_runtime_requests (
        runtime_request_id, thread_id, node_id, provider_turn_id, kind, status, created_at,
        resolved_at, payload_json
      )
      VALUES (${id("request")}, ${threadId}, ${id("node")}, NULL, 'user_input', 'resolved',
        ${atIso}, ${atIso}, '{}')
    `;
    yield* sql`
      INSERT INTO orchestration_v2_projection_turn_items (
        turn_item_id, thread_id, run_id, node_id, provider_thread_id, provider_turn_id,
        parent_item_id, ordinal, type, status, updated_at, payload_json
      )
      VALUES (${id("turn-item")}, ${threadId}, ${id("run")}, ${id("node")}, NULL, NULL,
        NULL, 10, 'user_message', 'completed', ${atIso}, '{}')
    `;
    yield* sql`
      INSERT INTO orchestration_v2_projection_messages (
        message_id, thread_id, run_id, node_id, role, streaming, created_at, updated_at,
        payload_json
      )
      VALUES (${id("user-message")}, ${threadId}, ${id("run")}, ${id("node")}, 'user', 0,
        ${atIso}, ${atIso}, ${JSON.stringify({ text: "purge needle question", createdBy: "user" })})
    `;
    yield* sql`
      INSERT INTO orchestration_v2_projection_messages (
        message_id, thread_id, run_id, node_id, role, streaming, created_at, updated_at,
        payload_json
      )
      VALUES (${id("message")}, ${threadId}, ${id("run")}, ${id("node")}, 'assistant', 0,
        ${atIso}, ${atIso}, ${JSON.stringify({ text: "purge needle answer" })})
    `;
    yield* sql`
      INSERT INTO orchestration_v2_projection_provider_turns (
        provider_turn_id, thread_id, provider_thread_id, node_id, run_attempt_id, ordinal,
        status, started_at, completed_at, payload_json
      )
      VALUES (${id("provider-turn")}, ${threadId}, ${id("provider-thread")}, ${id("node")},
        ${id("attempt")}, 1, 'completed', ${atIso}, ${atIso}, '{}')
    `;
    yield* sql`
      INSERT INTO orchestration_v2_projection_provider_threads (
        provider_thread_id, thread_id, owner_node_id, provider, provider_session_id, status,
        first_run_ordinal, last_run_ordinal, updated_at, payload_json, driver,
        provider_instance_id
      )
      VALUES (${id("provider-thread")}, ${threadId}, ${id("node")}, 'codex',
        ${id("provider-session")}, 'idle', 1, 1, ${atIso}, '{}', 'codex', 'codex')
    `;
    yield* sql`
      INSERT INTO orchestration_v2_projection_provider_sessions (
        provider_session_id, thread_id, provider, status, model, updated_at, payload_json,
        driver, provider_instance_id
      )
      VALUES (${id("provider-session")}, ${threadId}, 'codex', 'stopped', NULL, ${atIso},
        '{}', 'codex', 'codex')
    `;
    yield* sql`
      INSERT INTO orchestration_v2_projection_provider_session_bindings (
        provider_session_id, thread_id
      )
      VALUES (${id("provider-session")}, ${threadId})
    `;
    yield* sql`
      INSERT INTO orchestration_v2_projection_subagents (
        subagent_id, thread_id, run_id, parent_node_id, provider, provider_thread_id,
        child_thread_id, origin, status, started_at, completed_at, updated_at, payload_json,
        driver, provider_instance_id
      )
      VALUES (${id("subagent")}, ${threadId}, ${id("run")}, ${id("node")}, 'codex', NULL,
        NULL, 'provider_native', 'completed', ${atIso}, ${atIso}, ${atIso}, '{}', 'codex',
        'codex')
    `;
    yield* sql`
      INSERT INTO orchestration_v2_projection_checkpoint_scopes (
        scope_id, thread_id, run_id, node_id, parent_scope_id, provider_thread_id, kind,
        ordinal_within_parent, advances_app_run_count, created_at, payload_json
      )
      VALUES (${id("scope")}, ${threadId}, ${id("run")}, ${id("node")}, NULL,
        ${id("provider-thread")}, 'root', 0, 1, ${atIso}, '{}')
    `;
    yield* sql`
      INSERT INTO orchestration_v2_projection_checkpoints (
        checkpoint_id, thread_id, scope_id, run_id, node_id, parent_checkpoint_id,
        ordinal_within_scope, app_run_ordinal, status, captured_at, payload_json
      )
      VALUES (${id("checkpoint")}, ${threadId}, ${id("scope")}, ${id("run")}, ${id("node")},
        NULL, 0, 1, 'ready', ${atIso}, '{}')
    `;
    yield* sql`
      INSERT INTO orchestration_v2_projection_context_handoffs (
        context_handoff_id, thread_id, target_run_id, to_provider_thread_id, strategy, status,
        updated_at, payload_json
      )
      VALUES (${id("handoff")}, ${threadId}, ${id("run")}, ${id("provider-thread")},
        'summary', 'completed', ${atIso}, '{}')
    `;
    if (threadId === deletedThread) {
      yield* sql`
        INSERT INTO orchestration_v2_projection_context_transfers (
          context_transfer_id, source_thread_id, target_thread_id, target_run_id, type,
          status, updated_at, payload_json
        )
        VALUES (${id("transfer")}, ${threadId}, ${liveThread}, NULL, 'subagent_result',
          'completed', ${atIso}, '{}')
      `;
      yield* sql`
        INSERT INTO orchestration_v2_projection_context_transfers (
          context_transfer_id, source_thread_id, target_thread_id, target_run_id, type,
          status, updated_at, payload_json
        )
        VALUES (${id("own-transfer")}, ${threadId}, ${threadId}, NULL, 'handoff', 'completed',
          ${atIso}, '{}')
      `;
    } else {
      yield* sql`
        INSERT INTO orchestration_v2_projection_context_transfers (
          context_transfer_id, source_thread_id, target_thread_id, target_run_id, type,
          status, updated_at, payload_json
        )
        VALUES (${id("transfer")}, ${threadId}, ${threadId}, NULL, 'handoff', 'completed',
          ${atIso}, '{}')
      `;
    }
    yield* sql`
      INSERT INTO orchestration_v2_turn_item_positions (thread_id, turn_item_id, ordinal)
      VALUES (${threadId}, ${id("turn-item")}, 10)
    `;
    yield* sql`
      INSERT INTO orchestration_v2_events (
        event_id, thread_id, event_type, occurred_at, payload_json
      )
      VALUES (${id("legacy-provider-event")}, ${threadId}, 'turn.completed', ${atIso}, '{}')
    `;
    yield* sql`
      INSERT INTO mcp_app_model_context (thread_id, item_id, server, tool, text, updated_at)
      VALUES (${threadId}, ${id("mcp-item")}, 'server', 'tool', 'context', ${atIso})
    `;
    yield* sql`
      INSERT INTO projection_thread_messages (
        message_id, thread_id, turn_id, role, text, is_streaming, created_at, updated_at
      )
      VALUES (${id("legacy-message")}, ${threadId}, NULL, 'user', 'legacy', 0, ${atIso}, ${atIso})
    `;
    yield* sql`
      INSERT INTO projection_thread_sessions (
        thread_id, status, provider_name, provider_session_id, provider_thread_id,
        active_turn_id, last_error, updated_at
      )
      VALUES (${threadId}, 'idle', 'codex', ${id("legacy-session")}, NULL, NULL, NULL, ${atIso})
    `;
    yield* sql`
      INSERT INTO projection_thread_pull_requests (
        thread_id, host, repository, number, url, source, linked_at, snapshot_json, stack_json
      )
      VALUES (${threadId}, 'github.com', 'owner/repo', 1, 'https://example.test/pr/1', 'manual',
        ${atIso}, NULL, NULL)
    `;
  });

const rowidThreadTables = [
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
  "orchestration_v2_events",
  "mcp_app_model_context",
  "projection_thread_messages",
  "projection_thread_sessions",
  "projection_thread_pull_requests",
] as const;

const countForThread = (table: (typeof rowidThreadTables)[number], threadId: ThreadId) =>
  Effect.flatMap(
    SqlClient.SqlClient,
    (sql) =>
      sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM ${sql(table)} WHERE thread_id = ${threadId}
      `,
  ).pipe(Effect.map((rows) => rows[0]!.count));

const countDerived = (
  table: "houston_thread_shell" | "houston_user_messages" | "houston_turn_item_counts",
  threadId: ThreadId,
) =>
  Effect.flatMap(
    SqlClient.SqlClient,
    (sql) =>
      sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM ${sql(table)} WHERE thread_id = ${threadId}
      `,
  ).pipe(Effect.map((rows) => rows[0]!.count));

const countTransfersTouching = (threadId: ThreadId) =>
  Effect.flatMap(
    SqlClient.SqlClient,
    (sql) =>
      sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM orchestration_v2_projection_context_transfers
        WHERE source_thread_id = ${threadId} OR target_thread_id = ${threadId}
      `,
  ).pipe(Effect.map((rows) => rows[0]!.count));

const searchHits = () =>
  Effect.flatMap(
    SqlClient.SqlClient,
    (sql) =>
      sql<{ readonly thread_id: string }>`
        SELECT DISTINCT messages.thread_id AS thread_id
        FROM orchestration_v2_message_search AS search
        JOIN orchestration_v2_projection_messages AS messages ON messages.rowid = search.rowid
        WHERE orchestration_v2_message_search MATCH '"needle"'
        ORDER BY messages.thread_id
      `,
  ).pipe(Effect.map((rows) => rows.map((row) => row.thread_id)));

const remainingEvents = (threadId: ThreadId) =>
  Effect.flatMap(
    SqlClient.SqlClient,
    (sql) =>
      sql<{ readonly event_id: string }>`
        SELECT event_id FROM orchestration_events
        WHERE aggregate_kind = 'thread' AND stream_id = ${threadId}
        ORDER BY sequence
      `,
  ).pipe(Effect.map((rows) => rows.map((row) => row.event_id)));

it.effect("deleting a thread removes its content and keeps its tombstone", () =>
  Effect.gen(function* () {
    yield* insertThread(deletedThread, atIso);
    yield* insertThread(liveThread, null);
    yield* seedThreadContent(deletedThread, "deleted");
    yield* seedThreadContent(liveThread, "live");
    yield* insertEvent({
      eventId: "event:purge:deleted:created",
      threadId: deletedThread,
      eventType: "thread.created",
      payload: {},
    });
    const anchorSequence = yield* insertEvent({
      eventId: "event:purge:deleted:anchor",
      threadId: deletedThread,
      eventType: "subagent.updated",
      payload: subagentPayload("subagent:purge", deletedThread, "Inspect the project"),
    });
    yield* insertEvent({
      eventId: "event:purge:deleted:message",
      threadId: deletedThread,
      eventType: "message.updated",
      payload: {},
    });
    yield* insertEvent({
      eventId: "event:purge:deleted:deleted",
      threadId: deletedThread,
      eventType: "thread.deleted",
      payload: {},
    });
    yield* insertEvent({
      eventId: "event:purge:deleted:after",
      threadId: deletedThread,
      eventType: "message.updated",
      payload: {},
    });
    yield* insertEvent({
      eventId: "event:purge:live:created",
      threadId: liveThread,
      eventType: "thread.created",
      payload: {},
    });
    yield* insertEvent({
      eventId: "event:purge:live:borrow",
      threadId: liveThread,
      eventType: "subagent.updated",
      payload: {
        ...subagentPayload("subagent:purge", liveThread, ""),
        promptSequence: anchorSequence,
      },
    });

    assert.deepEqual(yield* searchHits(), [deletedThread, liveThread].sort());
    const liveCounts = new Map<string, number>();
    for (const table of rowidThreadTables) {
      liveCounts.set(table, yield* countForThread(table, liveThread));
    }
    const liveDerivedCounts = new Map<string, number>();
    for (const table of [
      "houston_thread_shell",
      "houston_user_messages",
      "houston_turn_item_counts",
    ] as const) {
      liveDerivedCounts.set(table, yield* countDerived(table, liveThread));
    }

    yield* purgeThreadHistory(deletedThread);

    const tombstone = yield* SqlClient.SqlClient.pipe(
      Effect.flatMap(
        (sql) =>
          sql<{ readonly deleted_at: string | null }>`
          SELECT deleted_at FROM orchestration_v2_projection_threads WHERE thread_id = ${deletedThread}
        `,
      ),
    );
    assert.deepEqual(tombstone, [{ deleted_at: atIso }]);
    for (const table of rowidThreadTables) {
      assert.equal(yield* countForThread(table, deletedThread), 0, table);
      assert.equal(yield* countForThread(table, liveThread), liveCounts.get(table), table);
    }
    for (const table of [
      "houston_thread_shell",
      "houston_user_messages",
      "houston_turn_item_counts",
    ] as const) {
      assert.equal(yield* countDerived(table, deletedThread), 0, table);
      assert.equal(yield* countDerived(table, liveThread), liveDerivedCounts.get(table), table);
    }
    // The live thread still shows what the deleted thread handed it.
    assert.equal(yield* countTransfersTouching(deletedThread), 1);
    assert.equal(yield* countTransfersTouching(liveThread), 2);

    assert.deepEqual(yield* remainingEvents(deletedThread), [
      // thread.created stays: the legacy importer reads it to know the thread exists.
      "event:purge:deleted:created",
      "event:purge:deleted:anchor",
      "event:purge:deleted:deleted",
      "event:purge:deleted:after",
    ]);
    assert.deepEqual(yield* remainingEvents(liveThread), [
      "event:purge:live:created",
      "event:purge:live:borrow",
    ]);
    assert.deepEqual(yield* searchHits(), [liveThread]);

    // The live thread still reads the prompt its event borrows from the deleted thread.
    const eventStore = yield* EventStore.EventStoreV2;
    const stored = yield* eventStore
      .read({ threadId: liveThread, eventType: "subagent.updated" })
      .pipe(Stream.runCollect);
    const borrowed = Array.from(stored).find(
      (row) =>
        row.event.type === "subagent.updated" && row.event.payload.prompt === "Inspect the project",
    );
    assert.isDefined(borrowed);

    // The outbox may retry an effect that already ran.
    yield* purgeThreadHistory(deletedThread);
    assert.deepEqual(yield* remainingEvents(deletedThread), [
      "event:purge:deleted:created",
      "event:purge:deleted:anchor",
      "event:purge:deleted:deleted",
      "event:purge:deleted:after",
    ]);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("does nothing for a thread that is not deleted", () =>
  Effect.gen(function* () {
    yield* insertThread(liveThread, null);
    yield* seedThreadContent(liveThread, "live");
    yield* purgeThreadHistory(liveThread);
    for (const table of rowidThreadTables) {
      assert.isAbove(yield* countForThread(table, liveThread), 0, table);
    }
  }).pipe(Effect.provide(layerTest)),
);
