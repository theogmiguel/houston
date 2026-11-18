// The write-back a task's hand-back owes its linked issue: a comment and, where the binding maps
// a URL property, the pull request the latest run recorded.
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import * as IssueService from "../../issue/IssueService.ts";
import * as Writeback from "./TaskIssueWriteback.ts";

interface Call {
  readonly method: "comment" | "setPullRequestUrl";
  readonly input: Record<string, unknown>;
}

const layerFor = (calls: Array<Call>) =>
  Writeback.layer.pipe(
    Layer.provideMerge(SqlitePersistence.layerMemory),
    Layer.provide(
      Layer.mock(IssueService.IssueService)({
        comment: (input) =>
          Effect.sync(() => {
            calls.push({ method: "comment", input: input as unknown as Record<string, unknown> });
          }),
        setPullRequestUrl: (input) =>
          Effect.sync(() => {
            calls.push({
              method: "setPullRequestUrl",
              input: input as unknown as Record<string, unknown>,
            });
          }),
      }),
    ),
    Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
  );

const seed = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    INSERT INTO houston_tasks (
      id, number, project_id, title, description, status, priority, revision, created_by,
      created_at, updated_at
    ) VALUES (1, 1, 'p1', 'Ship it', 'Local words', 'in_review', 0, 1, 'user', 'now', 'now')
  `;
  yield* sql`
    INSERT INTO houston_task_issues (
      task_id, project_id, tracker, host, scope, key, display_key, url, title, linked_at
    ) VALUES (
      1, 'p1', 'notion', 'notion.so', '0123456789abcdef0123456789abcdef', 'abc', 'abc',
      'https://www.notion.so/abc', 'Ship it', 'now'
    )
  `;
  yield* sql`
    INSERT INTO houston_task_runs (
      task_id, attempt, kind, state, provider, initial_revision, started_at, summary, pr_url
    ) VALUES (1, 1, 'implementation', 'handed_back', 'claude', 1, 'now', 'All green', 'https://github.com/acme/app/pull/7')
  `;
});

describe("task issue write-back", () => {
  it.effect("comments the hand-back and writes the mapped pull request URL", () => {
    const calls: Array<Call> = [];
    return Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* seed;
      yield* sql`
        INSERT INTO issue_tracker_bindings (project_id, tracker, scope, properties_json, updated_at)
        VALUES ('p1', 'notion', '0123456789abcdef0123456789abcdef',
          '{"title":"title","status":"status","prUrl":"pr"}', 'now')
      `;
      const writeback = yield* Writeback.TaskIssueWriteback;
      yield* writeback.recorded([
        { taskId: 1, actor: "user", action: "houston:handback", changes: {} },
      ]);
      assert.deepEqual(
        calls.map((call) => [call.method, call.input]),
        [
          [
            "comment",
            {
              projectId: "p1",
              tracker: "notion",
              host: "notion.so",
              scope: "0123456789abcdef0123456789abcdef",
              key: "abc",
              body: "Ship it: All green",
            },
          ],
          [
            "setPullRequestUrl",
            {
              projectId: "p1",
              tracker: "notion",
              host: "notion.so",
              scope: "0123456789abcdef0123456789abcdef",
              key: "abc",
              url: "https://github.com/acme/app/pull/7",
            },
          ],
        ],
      );
    }).pipe(Effect.provide(layerFor(calls)));
  });

  it.effect("comments without writing a pull request when the binding maps no URL property", () => {
    const calls: Array<Call> = [];
    return Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* seed;
      yield* sql`
        INSERT INTO issue_tracker_bindings (project_id, tracker, scope, properties_json, updated_at)
        VALUES ('p1', 'notion', '0123456789abcdef0123456789abcdef',
          '{"title":"title","status":"status"}', 'now')
      `;
      const writeback = yield* Writeback.TaskIssueWriteback;
      yield* writeback.recorded([
        { taskId: 1, actor: "user", action: "houston:handback", changes: {} },
      ]);
      assert.deepEqual(
        calls.map((call) => call.method),
        ["comment"],
      );
    }).pipe(Effect.provide(layerFor(calls)));
  });
});
