// What each open request is owed when its task or run changes in Houston: derived from the rows
// every 5 seconds and on each Tasks change, then queued in the outbox under a dedupe key.
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Schedule from "effect/Schedule";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";

import { HoustonTaskStore } from "../tasks/TaskStore.ts";
import { HoustonSlackIntake } from "./Intake.ts";
import { HoustonSlackStore, type RequestRow } from "./Store.ts";
import { slackText } from "./text.ts";

const TICK = Duration.seconds(5);

export class HoustonSlackReplies extends Context.Service<
  HoustonSlackReplies,
  { readonly tick: Effect.Effect<void> }
>()("houston/houston/slack/Replies/HoustonSlackReplies") {}

interface OwedRow extends RequestRow {
  readonly status: string | null;
  readonly archived_at: string | null;
  readonly runs: number;
}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const store = yield* HoustonSlackStore;
  const intake = yield* HoustonSlackIntake;
  const taskStore = yield* HoustonTaskStore;
  const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.orDie(effect);

  const derive = Effect.gen(function* () {
    const settings = yield* store.settings;
    const text = slackText(settings?.language ?? "en");
    const rows = yield* run(sql<OwedRow>`
      SELECT r.*, t.status AS status, t.archived_at AS archived_at,
        (SELECT COUNT(*) FROM houston_task_runs
          WHERE task_id = r.task_id AND kind = 'implementation') AS runs
      FROM houston_slack_requests r JOIN houston_tasks t ON t.id = r.task_id
      WHERE r.state IN ('pending', 'queued', 'started')
      ORDER BY r.id
    `);
    for (const row of rows) {
      const closed = row.status === "canceled" || row.status === "done" || row.archived_at !== null;
      if (row.state === "pending" || row.state === "queued") {
        if (closed) {
          // Closed in Houston before it started: refused, and the owner's buttons go away.
          yield* store.write(
            Effect.gen(function* () {
              yield* run(sql`
                UPDATE houston_slack_requests SET state = 'refused', queued_at = NULL
                WHERE id = ${row.id}
              `);
              yield* store.react(row.id, "no_entry_sign");
              const body = `${text.newRequest(row.channel_id, row.author)}\n${text.closedInHouston}`;
              yield* store.enqueue({
                requestId: row.id,
                dedupeKey: `dm-closed:${row.id}`,
                target: "update",
                text: body,
                blocks: [{ type: "section", text: { type: "mrkdwn", text: body } }],
                updateOf: `dm:${row.id}`,
              });
              return { result: undefined, requests: [row.id] };
            }),
          );
        } else if (row.runs > 0) {
          // Started from Houston: Start is the owner's acceptance.
          yield* store.write(
            Effect.gen(function* () {
              yield* run(sql`
                UPDATE houston_slack_requests SET state = 'started', queued_at = NULL
                WHERE id = ${row.id}
              `);
              if (row.state === "pending" && row.task_id !== null) {
                yield* taskStore.recordHistory(row.task_id, "user", "houston:slack-accepted", {
                  from: "houston",
                });
              }
              yield* store.react(row.id, "gear");
              return {
                result: undefined,
                touched: row.task_id === null ? [] : [row.task_id],
                requests: [row.id],
              };
            }),
          );
        }
      } else if (row.status === "done" || row.status === "canceled") {
        yield* store.write(
          Effect.gen(function* () {
            yield* run(
              sql`UPDATE houston_slack_requests SET state = 'closed' WHERE id = ${row.id}`,
            );
            yield* store.react(row.id, row.status === "done" ? "rocket" : "no_entry_sign");
            return { result: undefined, requests: [row.id] };
          }),
        );
      }
    }
    yield* intake.startQueued;
  });

  const tick = intake
    .withLock(derive)
    .pipe(Effect.catchCause((cause) => Effect.logWarning("Slack replies tick failed.", cause)));

  yield* tick.pipe(Effect.repeat(Schedule.spaced(TICK)), Effect.forkScoped);
  const changes = yield* PubSub.subscribe(taskStore.changes);
  yield* Stream.fromSubscription(changes).pipe(
    Stream.runForEach(() => tick),
    Effect.forkScoped,
  );

  return HoustonSlackReplies.of({ tick });
});

export const layer = Layer.effect(HoustonSlackReplies, make);
