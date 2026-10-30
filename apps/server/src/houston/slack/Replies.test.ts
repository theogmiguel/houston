// What each request is owed when its task changes in Houston, derived on each tick.
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import * as HoustonTaskService from "../tasks/TaskService.ts";
import { createProject } from "../tasks/tasks.testkit.ts";
import { HoustonSlackOutbox } from "./Outbox.ts";
import { HoustonSlackReplies } from "./Replies.ts";
import { mentionEnvelope, mentionEvent } from "./slack.fake.ts";
import { OWNER, connectSlack, runSlack, until, untilConnected } from "./slack.testkit.ts";

describe("a task closed before it starts closes its request", () => {
  it.effect("a task closed before it starts closes its request", () =>
    runSlack((fake) =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const tasks = yield* HoustonTaskService.HoustonTaskService;
        const outbox = yield* HoustonSlackOutbox;
        const replies = yield* HoustonSlackReplies;
        const projectId = yield* createProject("closed");
        yield* connectSlack(projectId);
        yield* untilConnected;
        const stamps = ["1700000000.000100", "1700000000.000200", "1700000000.000300"];
        for (const [index, ts] of stamps.entries()) {
          fake.sockets
            .at(-1)
            ?.send(mentionEnvelope(`e${index}`, mentionEvent(ts, `Request ${index}`)));
        }
        const rows = () =>
          sql<{
            readonly ts: string;
            readonly state: string;
            readonly task_id: number | null;
            readonly status_reaction: string | null;
          }>`
            SELECT ts, state, task_id, status_reaction FROM houston_slack_requests ORDER BY ts
          `;
        yield* until(
          "three filed",
          rows().pipe(
            Effect.map((all) => all.length === 3 && all.every((row) => row.task_id !== null)),
          ),
        );
        yield* outbox.tick;
        const dms = fake.callsOf("chat.postMessage").filter((call) => !call.body.thread_ts);
        assert.lengthOf(dms, 3);

        const filed = yield* rows();
        const detail = (index: number) => tasks.get({ id: String(filed[index]?.task_id) });
        const canceled = yield* detail(0);
        yield* tasks.save({
          id: canceled.task.key,
          expectedRevision: canceled.task.revision,
          patch: { status: "canceled" },
        });
        const done = yield* detail(1);
        yield* tasks.save({
          id: done.task.key,
          expectedRevision: done.task.revision,
          patch: { status: "done" },
        });
        const archived = yield* detail(2);
        yield* tasks.archive({
          id: archived.task.key,
          archived: true,
          expectedRevision: archived.task.revision,
        });
        yield* replies.tick;
        const after = yield* rows();
        assert.deepEqual(
          after.map((row) => [row.state, row.status_reaction]),
          [
            ["refused", "no_entry_sign"],
            ["refused", "no_entry_sign"],
            ["refused", "no_entry_sign"],
          ],
        );
        yield* outbox.tick;
        yield* outbox.tick;
        const updates = fake.callsOf("chat.update");
        assert.lengthOf(updates, 3);
        const postedTs = new Set([1, 2, 3].map((n) => `1800000000.${String(n).padStart(6, "0")}`));
        for (const update of updates) {
          assert.strictEqual(update.body.channel, `D${OWNER}`);
          assert.isTrue(postedTs.has(update.body.ts ?? ""), update.body.ts);
          assert.notInclude(update.body.blocks ?? "", '"actions"');
          assert.notInclude(update.body.blocks ?? "", "houston_slack_accept");
        }
        assert.lengthOf(
          fake.callsOf("reactions.add").filter((call) => call.body.name === "no_entry_sign"),
          3,
        );
        // A second tick owes nothing more.
        yield* replies.tick;
        yield* outbox.tick;
        assert.lengthOf(fake.callsOf("chat.update"), 3);
      }),
    ),
  );
});
