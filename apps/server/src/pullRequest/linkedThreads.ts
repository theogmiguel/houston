import {
  normalizeThreadPullRequestKey,
  threadPullRequestKeysEqual,
} from "../sourceControl/threadPullRequests.ts";
import {
  ProjectId,
  PullRequestLinkedThreadsResult,
  PullRequestOperationError,
  ThreadPullRequestLink,
  type ThreadPullRequestKey,
} from "@houston-app/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as NodeSqliteClient from "@houston-app/shared/nodeSqliteClient";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

const decodeLinkedThreads = Schema.decodeUnknownEffect(PullRequestLinkedThreadsResult);

export const listLinkedPullRequestThreads = Effect.fn("listLinkedPullRequestThreads")(
  function* (input: ThreadPullRequestKey) {
    const key = normalizeThreadPullRequestKey(input);
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{
      id: string;
      projectId: string;
      title: string;
      archivedAt: string | null;
      host: string;
      repository: string;
      number: number;
      url: string;
    }>`
      SELECT t.thread_id AS id, t.project_id AS "projectId", t.title,
        t.archived_at AS "archivedAt", json_extract(link.value, '$.host') AS host,
        json_extract(link.value, '$.repository') AS repository,
        json_extract(link.value, '$.number') AS number,
        json_extract(link.value, '$.url') AS url,
        t.updated_at AS "updatedAt"
      FROM orchestration_v2_projection_threads AS t
      JOIN json_each(t.payload_json, '$.pullRequests') AS link
      WHERE json_extract(link.value, '$.number') = ${key.number}
        AND json_extract(link.value, '$.source') != 'stack-dismissed'
        AND t.deleted_at IS NULL
        AND json_extract(t.payload_json, '$.lineage.sideChat') IS NOT 1
      ORDER BY "updatedAt" DESC, id ASC
    `.pipe(NodeSqliteClient.readOnly);
    const threads = rows
      .filter((row) => threadPullRequestKeysEqual(row, key))
      .map(({ id, projectId, title, archivedAt }) => ({ id, projectId, title, archivedAt }));
    return yield* decodeLinkedThreads({ threads });
  },
  Effect.mapError(
    (cause) =>
      new PullRequestOperationError({
        operation: "linkedThreads",
        detail: "Could not load linked threads.",
        cause,
      }),
  ),
);

const decodeLink = Schema.decodeUnknownOption(Schema.fromJsonString(ThreadPullRequestLink));

/** Every link a thread holds, archived threads included, for listing linked pull requests. */
export const listThreadPullRequestLinks = Effect.fn("listThreadPullRequestLinks")(
  function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{ projectId: string; link: string }>`
      SELECT t.project_id AS "projectId", link.value AS link
      FROM orchestration_v2_projection_threads AS t
      JOIN json_each(
        CASE WHEN json_valid(t.payload_json) THEN t.payload_json ELSE '{}' END,
        '$.pullRequests'
      ) AS link
      WHERE t.deleted_at IS NULL
        AND json_extract(link.value, '$.source') != 'stack-dismissed'
        AND json_extract(t.payload_json, '$.lineage.sideChat') IS NOT 1
    `.pipe(NodeSqliteClient.readOnly);
    return rows.flatMap((row) =>
      Option.match(decodeLink(row.link), {
        onNone: () => [],
        onSome: (link) => [{ projectId: ProjectId.make(row.projectId), link }],
      }),
    );
  },
  Effect.mapError(
    (cause) =>
      new PullRequestOperationError({
        operation: "list",
        detail: "Could not read the pull requests linked to threads.",
        cause,
      }),
  ),
);
