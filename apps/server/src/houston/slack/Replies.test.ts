// What each request is owed when its task changes in Houston, derived on each tick.
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import * as HoustonTaskService from "../tasks/TaskService.ts";
import { createProject } from "../tasks/tasks.testkit.ts";
import { HoustonSlackOutbox } from "./Outbox.ts";
import { HoustonSlackReplies } from "./Replies.ts";
import { mentionEnvelope, mentionEvent } from "./slack.fake.ts";
import { HoustonSlackConversation } from "./Conversation.ts";
import {
  OWNER,
  connectSlack,
  connectedProject,
  flushOutbox,
  ownerDms,
  postedText,
  runSlack,
  setTaskStatus,
  startedRequest,
  storedRequest,
  threadPosts,
  tickReplies,
  until,
  untilConnected,
} from "./slack.testkit.ts";

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

// Hand-back, closing and attention (S6).

const READY = {
  outcome: "ready" as const,
  subject: "Export works",
  changes: "The report exports CSV.",
  steps: ["Open Reports and click Export"],
};

describe("a refusal at triage tells the thread why and marks the request", () => {
  it.effect("a refusal at triage tells the thread why and marks the request", () =>
    runSlack((fake) =>
      Effect.gen(function* () {
        const conversation = yield* HoustonSlackConversation;
        yield* connectedProject("triage");
        const ts = "1700000000.000100";
        const request = yield* startedRequest(fake, ts, "Export the report");
        yield* conversation.handback(request.threadId, {
          outcome: "refused",
          subject: "No export endpoint",
          changes: "The reports API has no export endpoint <@U9>.",
        });
        yield* tickReplies;
        yield* flushOutbox;
        const posts = threadPosts(fake, ts);
        assert.lengthOf(posts, 1);
        assert.include(postedText(posts[0]), "Not going ahead");
        assert.include(postedText(posts[0]), "The reports API has no export endpoint &lt;@U9&gt;.");
        assert.notInclude(postedText(posts[0]), "Ready, waiting for review");
        assert.strictEqual((yield* storedRequest(ts))?.status_reaction, "no_entry_sign");
        assert.include(
          fake.callsOf("reactions.add").map((call) => call.body.name),
          "no_entry_sign",
        );

        // Closing the task later posts no note.
        yield* setTaskStatus(request.taskId, "canceled");
        yield* tickReplies;
        yield* flushOutbox;
        yield* tickReplies;
        yield* flushOutbox;
        assert.lengthOf(threadPosts(fake, ts), 1);
        assert.strictEqual((yield* storedRequest(ts))?.state, "closed");
        assert.strictEqual((yield* storedRequest(ts))?.status_reaction, "no_entry_sign");
      }),
    ),
  );
});

describe("closing a handed-back task posts its note once", () => {
  it.effect("closing a handed-back task posts its note once", () =>
    runSlack((fake) =>
      Effect.gen(function* () {
        const conversation = yield* HoustonSlackConversation;
        yield* connectedProject("closing");
        const live = yield* startedRequest(fake, "1700000000.000100", "Export the report");
        const dropped = yield* startedRequest(fake, "1700000000.000200", "Rename the file");
        yield* conversation.handback(live.threadId, {
          ...READY,
          liveNote: "The export is live in Reports.",
          droppedNote: "The export will not ship.",
        });
        yield* conversation.handback(dropped.threadId, {
          ...READY,
          subject: "Rename works",
          liveNote: "The new name is live.",
          droppedNote: "The file keeps its name.",
        });
        yield* tickReplies;
        yield* flushOutbox;
        const before = (ts: string) => threadPosts(fake, ts).length;
        const liveBefore = before("1700000000.000100");
        const droppedBefore = before("1700000000.000200");

        yield* setTaskStatus(live.taskId, "done");
        yield* setTaskStatus(dropped.taskId, "canceled");
        for (let round = 0; round < 2; round += 1) {
          yield* tickReplies;
          yield* flushOutbox;
        }
        const liveNotes = threadPosts(fake, "1700000000.000100").slice(liveBefore);
        assert.lengthOf(liveNotes, 1);
        assert.include(postedText(liveNotes[0]), "The export is live in Reports.");
        assert.include(postedText(liveNotes[0]), "mention");
        assert.notInclude(postedText(liveNotes[0]), "The export will not ship.");
        const droppedNotes = threadPosts(fake, "1700000000.000200").slice(droppedBefore);
        assert.lengthOf(droppedNotes, 1);
        assert.include(postedText(droppedNotes[0]), "The file keeps its name.");
        assert.notInclude(postedText(droppedNotes[0]), "The new name is live.");
        assert.strictEqual((yield* storedRequest("1700000000.000100"))?.status_reaction, "rocket");
        assert.strictEqual(
          (yield* storedRequest("1700000000.000200"))?.status_reaction,
          "no_entry_sign",
        );
        assert.deepEqual(
          [
            (yield* storedRequest("1700000000.000100"))?.state,
            (yield* storedRequest("1700000000.000200"))?.state,
          ],
          ["closed", "closed"],
        );
      }),
    ),
  );
});

describe("a stopped, failed or waiting run marks the request for attention", () => {
  it.effect("a stopped, failed or waiting run marks the request for attention", () =>
    runSlack((fake) =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* connectedProject("attention");
        const stopped = yield* startedRequest(fake, "1700000000.000100", "Export the report");
        const failed = yield* startedRequest(fake, "1700000000.000200", "Rename the file");
        yield* flushOutbox;
        const dmsBefore = ownerDms(fake).length;
        // The stopped run frees its slot, so a third request starts under the cap of two.
        yield* sql`
          UPDATE houston_task_runs SET state = 'cancelled', reason = 'stopped'
          WHERE id = ${stopped.runId}
        `;
        const waiting = yield* startedRequest(fake, "1700000000.000300", "Fix the header");
        yield* sql`
          UPDATE houston_task_runs SET state = 'failed', reason = 'the provider exited'
          WHERE id = ${failed.runId}
        `;
        yield* sql`UPDATE houston_task_runs SET state = 'waiting_for_input' WHERE id = ${waiting.runId}`;
        for (let round = 0; round < 2; round += 1) {
          yield* tickReplies;
          yield* flushOutbox;
        }
        for (const ts of ["1700000000.000100", "1700000000.000200", "1700000000.000300"]) {
          assert.strictEqual((yield* storedRequest(ts))?.status_reaction, "warning", ts);
        }
        // The third request's own filing message is not an attention message.
        const dms = ownerDms(fake)
          .slice(dmsBefore)
          .map(postedText)
          .filter((text) => text.includes("Attention"));
        assert.lengthOf(dms, 3);
        assert.isTrue(dms.some((text) => text.includes("stopped")), "the stopped run is named");
        assert.isTrue(
          dms.some((text) => text.includes("failed") && text.includes("the provider exited")),
          "the failed run is named with its reason",
        );
        assert.isTrue(
          dms.some((text) => text.includes("waiting for a confirmation")),
          "the waiting run is named",
        );
      }),
    ),
  );
});
