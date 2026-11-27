// The bot runs table: one row per bot run, kept after its bot is deleted.
import { HoustonBotRunPolicy, type HoustonBotRunKind } from "@houston-app/contracts/houston/bots";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

export const PolicyJson = Schema.fromJsonString(HoustonBotRunPolicy);
const encodePolicy = Schema.encodeSync(PolicyJson);

export type BotRunOrigin = "owner" | "card" | "routine" | "test";

export interface BotRunInsert {
  readonly id: string;
  readonly requestId?: string;
  readonly botId: string;
  readonly botName: string;
  readonly kind: HoustonBotRunKind;
  readonly origin: BotRunOrigin;
  readonly routineId?: string;
  readonly projectId: string;
  /** Reserved before the thread exists, so the thread's first turn already finds its rules. */
  readonly threadId: string;
  readonly revisionN: number;
  readonly revisionSha256: string;
  readonly template: string;
  readonly policy: HoustonBotRunPolicy;
  readonly dueAt?: string;
  readonly startedAt: string;
  /** Tests only: a stored policy as a later or broken build might have written it. */
  readonly policyJson?: string;
}

export const insertBotRun = Effect.fn("HoustonBotRuns.insert")(function* (run: BotRunInsert) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    INSERT INTO houston_bot_runs (
      id, request_id, bot_id, bot_name, kind, origin, routine_id, project_id, thread_id,
      revision_n, revision_sha256, template, policy_json, state, due_at, started_at
    ) VALUES (
      ${run.id}, ${run.requestId ?? null}, ${run.botId}, ${run.botName}, ${run.kind},
      ${run.origin}, ${run.routineId ?? null}, ${run.projectId}, ${run.threadId}, ${run.revisionN},
      ${run.revisionSha256}, ${run.template}, ${run.policyJson ?? encodePolicy(run.policy)},
      'running', ${run.dueAt ?? null}, ${run.startedAt}
    )
  `;
});

export interface BotRunPolicyRow {
  readonly id: string;
  readonly bot_name: string;
  readonly kind: string;
  readonly policy_json: string;
}

export const botRunPolicyOfThread = (sql: SqlClient.SqlClient, threadId: string) =>
  sql<BotRunPolicyRow>`
    SELECT id, bot_name, kind, policy_json FROM houston_bot_runs WHERE thread_id = ${threadId} LIMIT 1
  `.pipe(Effect.map((rows) => rows[0]));
