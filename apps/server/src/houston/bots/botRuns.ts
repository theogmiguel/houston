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
  readonly revision_n: number;
  /** The pinned revision's text with the bot's job; null once the bot is deleted. */
  readonly instructions: string | null;
  readonly job: string | null;
}

export const botRunPolicyOfThread = (sql: SqlClient.SqlClient, threadId: string) =>
  sql<BotRunPolicyRow>`
    SELECT r.id, r.bot_name, r.kind, r.policy_json, r.revision_n, v.text AS instructions, b.job
    FROM houston_bot_runs r
    LEFT JOIN houston_bots b ON b.id = r.bot_id AND b.deleted_at IS NULL
    LEFT JOIN houston_bot_revisions v ON v.bot_id = b.id AND v.n = r.revision_n
    WHERE r.thread_id = ${threadId} LIMIT 1
  `.pipe(Effect.map((rows) => rows[0]));
