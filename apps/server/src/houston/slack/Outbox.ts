// Sends what the intake owes Slack: at most 10 rows per 5-second tick in id order, each once per
// dedupe key, with the bot token read from the OS keychain per tick. Nothing while disabled.
import { HOUSTON_SLACK_LIMITS } from "@t3tools/contracts/houston/slack";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";

import { nowIso } from "../tasks/TaskStore.ts";
import { HoustonSlackStore } from "./Store.ts";
import { SlackApiError, SlackWebApi, type SlackAnswer } from "./WebApi.ts";

const TICK = Duration.seconds(5);
const BLOCKS_REFUSED = new Set(["invalid_blocks", "invalid_blocks_format"]);

export class HoustonSlackOutbox extends Context.Service<
  HoustonSlackOutbox,
  { readonly tick: Effect.Effect<void> }
>()("houston/houston/slack/Outbox/HoustonSlackOutbox") {}

interface OutboxRow {
  readonly id: number;
  readonly dedupe_key: string;
  readonly target: "thread" | "dm" | "update" | "react" | "ephemeral";
  readonly text: string;
  readonly blocks_json: string | null;
  readonly reaction: string | null;
  readonly remove_reaction: string | null;
  readonly message_ts: string | null;
  readonly update_of: string | null;
  readonly user_id: string | null;
  readonly posted_channel: string | null;
  readonly attempts: number;
  readonly request_channel: string | null;
  readonly request_ts: string | null;
}

const answerString = (answer: SlackAnswer, key: string) =>
  typeof answer[key] === "string" ? (answer[key] as string) : null;

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const store = yield* HoustonSlackStore;
  const web = yield* SlackWebApi;
  const lock = yield* Semaphore.make(1);
  const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.orDie(effect);

  /** Posts with blocks; when Slack refuses them, the same text without. */
  const post = (
    token: Redacted.Redacted<string>,
    method: string,
    params: Readonly<Record<string, unknown>>,
    blocks: string | null,
  ) =>
    blocks === null
      ? web.call(token, method, params)
      : web.call(token, method, { ...params, blocks }).pipe(
          Effect.catchIf(
            (error) => BLOCKS_REFUSED.has(error.code),
            () => web.call(token, method, params),
          ),
        );

  /** A reaction answer Slack calls an error but that leaves the reaction as wanted. */
  const settled = (code: string) => (effect: Effect.Effect<SlackAnswer, SlackApiError>) =>
    effect.pipe(
      Effect.catchIf(
        (error) => error.code === code,
        () => Effect.succeed<SlackAnswer>({ ok: true }),
      ),
    );

  const send = Effect.fn("HoustonSlackOutbox.send")(function* (
    token: Redacted.Redacted<string>,
    row: OutboxRow,
    dmChannels: Map<string, string>,
  ): Effect.fn.Return<
    { readonly channel: string | null; readonly ts: string | null },
    SlackApiError
  > {
    const channel = row.request_channel ?? "";
    switch (row.target) {
      case "react": {
        const timestamp = row.message_ts ?? row.request_ts ?? "";
        if (row.remove_reaction !== null) {
          yield* web
            .call(token, "reactions.remove", { channel, timestamp, name: row.remove_reaction })
            .pipe(settled("no_reaction"));
        }
        yield* web
          .call(token, "reactions.add", { channel, timestamp, name: row.reaction ?? "" })
          .pipe(settled("already_reacted"));
        return { channel, ts: timestamp };
      }
      case "thread": {
        const answer = yield* post(
          token,
          "chat.postMessage",
          { channel, thread_ts: row.message_ts ?? row.request_ts ?? "", text: row.text },
          row.blocks_json,
        );
        return { channel: answerString(answer, "channel"), ts: answerString(answer, "ts") };
      }
      case "dm": {
        const user = row.user_id ?? "";
        let dm = dmChannels.get(user);
        if (dm === undefined) {
          const opened = yield* web.call(token, "conversations.open", { users: user });
          const id =
            typeof opened.channel === "object" && opened.channel !== null
              ? (opened.channel as { readonly id?: unknown }).id
              : undefined;
          if (typeof id !== "string") {
            return yield* new SlackApiError({
              method: "conversations.open",
              code: "no_channel",
              message: "Slack opened no direct message channel",
            });
          }
          dm = id;
          dmChannels.set(user, dm);
        }
        const answer = yield* post(
          token,
          "chat.postMessage",
          { channel: dm, text: row.text },
          row.blocks_json,
        );
        return { channel: answerString(answer, "channel") ?? dm, ts: answerString(answer, "ts") };
      }
      case "update": {
        const [target] = yield* run(sql<{
          readonly posted_channel: string | null;
          readonly posted_ts: string | null;
        }>`
          SELECT posted_channel, posted_ts FROM houston_slack_outbox WHERE dedupe_key = ${row.update_of}
        `);
        const answer = yield* post(
          token,
          "chat.update",
          { channel: target?.posted_channel ?? "", ts: target?.posted_ts ?? "", text: row.text },
          row.blocks_json,
        );
        return { channel: answerString(answer, "channel"), ts: answerString(answer, "ts") };
      }
      case "ephemeral": {
        yield* web.call(token, "chat.postEphemeral", {
          channel: row.posted_channel ?? channel,
          user: row.user_id ?? "",
          text: row.text,
        });
        return { channel: row.posted_channel, ts: null };
      }
    }
  });

  const tickOnce = Effect.gen(function* () {
    const settings = yield* store.settings;
    if (settings?.enabled !== 1) return;
    const token = yield* store.readBotToken;
    if (token === null) return;
    // An edit waits until the message it edits is posted.
    const rows = yield* run(sql<OutboxRow>`
      SELECT o.*, r.channel_id AS request_channel, r.ts AS request_ts
      FROM houston_slack_outbox o LEFT JOIN houston_slack_requests r ON r.id = o.request_id
      WHERE o.sent_at IS NULL AND o.attempts < ${HOUSTON_SLACK_LIMITS.outboxAttempts}
        AND (o.target != 'update' OR EXISTS (
          SELECT 1 FROM houston_slack_outbox t
          WHERE t.dedupe_key = o.update_of AND t.posted_ts IS NOT NULL
        ))
      ORDER BY o.id LIMIT ${HOUSTON_SLACK_LIMITS.outboxBatch}
    `);
    const dmChannels = new Map<string, string>();
    for (const row of rows) {
      const result = yield* Effect.result(send(token, row, dmChannels));
      const now = yield* nowIso;
      if (result._tag === "Success") {
        yield* run(sql`
          UPDATE houston_slack_outbox SET sent_at = ${now}, attempts = attempts + 1,
            posted_channel = COALESCE(${result.success.channel}, posted_channel),
            posted_ts = ${result.success.ts}, last_error = NULL
          WHERE id = ${row.id}
        `);
        continue;
      }
      const attempts = row.attempts + 1;
      yield* run(sql`
        UPDATE houston_slack_outbox SET attempts = ${attempts},
          last_error = ${result.failure.message} WHERE id = ${row.id}
      `);
      if (attempts >= HOUSTON_SLACK_LIMITS.outboxAttempts) {
        const error = `a Slack message was dropped after ${attempts} attempts: ${row.dedupe_key} (${result.failure.code})`;
        yield* Effect.logWarning(error);
        yield* store.setStatus({ error });
      }
    }
  });

  const tick = lock
    .withPermits(1)(tickOnce)
    .pipe(Effect.catchCause((cause) => Effect.logWarning("Slack outbox tick failed.", cause)));

  yield* tick.pipe(Effect.repeat(Schedule.spaced(TICK)), Effect.forkScoped);

  return HoustonSlackOutbox.of({ tick });
});

export const layer = Layer.effect(HoustonSlackOutbox, make);
