// @effect-diagnostics nodeBuiltinImport:off - checks the stored attachment files.
// Filing a mention, its text and image bounds, the owner's acceptance and refusal, and the
// working cap, from Socket Mode envelopes of the loopback fake to the outbox's calls.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { assert, describe, it } from "@effect/vitest";
import type { HoustonSlackRequest } from "@t3tools/contracts/houston/slack";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerConfig from "../../config.ts";
import { HoustonTaskRuns } from "../tasks/TaskRuns.ts";
import * as HoustonTaskService from "../tasks/TaskService.ts";
import { createProject } from "../tasks/tasks.testkit.ts";
import { HoustonSlackOutbox } from "./Outbox.ts";
import { HoustonSlackReplies } from "./Replies.ts";
import { HoustonSlackService } from "./Service.ts";
import {
  FAKE_BOT,
  interactiveEnvelope,
  mentionEnvelope,
  mentionEvent,
  type SlackFake,
} from "./slack.fake.ts";
import {
  OWNER,
  connectSlack,
  makeFakeRuns,
  realTurn,
  runSlack,
  until,
  untilAdvancing,
  untilConnected,
  type FakeRuns,
} from "./slack.testkit.ts";

interface RequestRow {
  readonly id: number;
  readonly ts: string;
  readonly state: string;
  readonly task_id: number | null;
  readonly status_reaction: string | null;
  readonly permalink: string | null;
  readonly attachments_json: string | null;
}

const requestAt = (ts: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<RequestRow>`SELECT * FROM houston_slack_requests WHERE ts = ${ts}`;
    return rows[0];
  });

const taskCount = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const [row] = yield* sql<{ readonly n: number }>`SELECT COUNT(*) AS n FROM houston_tasks`;
  return row?.n ?? 0;
});

let envelopes = 0;
const deliver = (fake: SlackFake, envelope: Record<string, unknown>) =>
  Effect.sync(() => fake.sockets.at(-1)?.send(envelope));

const mention = (fake: SlackFake, ts: string, text: string, patch: Record<string, unknown> = {}) =>
  deliver(fake, mentionEnvelope(`e${(envelopes += 1)}`, mentionEvent(ts, text, patch)));

const eventEnvelope = (event: Record<string, unknown>) =>
  mentionEnvelope(`e${(envelopes += 1)}`, event);

const reaction = (fake: SlackFake, user: string, name: string, ts: string) =>
  deliver(
    fake,
    eventEnvelope({
      type: "reaction_added",
      user,
      reaction: name,
      item: { type: "message", channel: "C1", ts },
      event_ts: ts,
    }),
  );

const click = (fake: SlackFake, user: string, actionId: string, requestId: number) =>
  deliver(
    fake,
    interactiveEnvelope(`e${(envelopes += 1)}`, {
      type: "block_actions",
      user: { id: user },
      team: { id: "T1" },
      channel: { id: `D${user}` },
      trigger_id: `trigger-${envelopes}`,
      actions: [{ action_id: actionId, value: String(requestId), action_ts: `${envelopes}` }],
    }),
  );

const submitRefusal = (fake: SlackFake, user: string, requestId: number, reason: string) =>
  deliver(
    fake,
    interactiveEnvelope(`e${(envelopes += 1)}`, {
      type: "view_submission",
      user: { id: user },
      team: { id: "T1" },
      view: {
        callback_id: "houston_slack_refuse",
        private_metadata: String(requestId),
        state: { values: { reason: { reason: { type: "plain_text_input", value: reason } } } },
      },
    }),
  );

const flush = Effect.flatMap(HoustonSlackOutbox, (outbox) =>
  Effect.gen(function* () {
    for (let round = 0; round < 6; round += 1) yield* outbox.tick;
  }),
);

const tick = Effect.flatMap(HoustonSlackReplies, (replies) => replies.tick);

/** Files a mention and makes its task ready by giving it an acceptance item. */
const fileReady = (fake: SlackFake, ts: string, title: string) =>
  Effect.gen(function* () {
    const tasks = yield* HoustonTaskService.HoustonTaskService;
    yield* mention(fake, ts, title);
    yield* until(`${title} filed`, requestAt(ts).pipe(Effect.map((row) => row?.task_id != null)));
    const row = (yield* requestAt(ts)) as RequestRow;
    const detail = yield* tasks.get({ id: String(row.task_id) });
    yield* tasks.save({
      id: detail.task.key,
      expectedRevision: detail.task.revision,
      patch: { acceptance: ["it works"] },
    });
    return { ...row, key: detail.task.key };
  });

const connected = (fake: SlackFake, name: string, owner: string | null = OWNER) =>
  Effect.gen(function* () {
    const projectId = yield* createProject(name);
    yield* connectSlack(projectId, { owner });
    yield* untilConnected;
    return projectId;
  });

const historyOf = (taskId: number | null) =>
  Effect.flatMap(HoustonTaskService.HoustonTaskService, (tasks) =>
    tasks.get({ id: String(taskId) }),
  ).pipe(Effect.map((detail) => detail.history.map((entry) => entry.action)));

describe("a mention is filed pending once and the owner is told", () => {
  it.effect("a mention is filed pending once and the owner is told", () =>
    runSlack((fake) =>
      Effect.gen(function* () {
        const tasks = yield* HoustonTaskService.HoustonTaskService;
        const projectId = yield* connected(fake, "filed");
        const firstLine = `The login page ${"really ".repeat(12)}breaks`;
        const body = `${"word ".repeat(60)}TAIL281`;
        const ts = "1700000000.000100";
        const envelope = eventEnvelope(mentionEvent(ts, `${firstLine}\n${body}`));
        yield* deliver(fake, envelope);
        yield* until("filed", requestAt(ts).pipe(Effect.map((row) => row?.task_id != null)));
        const row = (yield* requestAt(ts)) as RequestRow;
        assert.strictEqual(row.state, "pending");
        const detail = yield* tasks.get({ id: String(row.task_id) });
        assert.strictEqual(detail.task.title, firstLine.slice(0, 72));
        assert.strictEqual(detail.task.description, `${firstLine}\n${body}`);
        assert.strictEqual(detail.task.createdBy, "slack:U2");
        assert.strictEqual(detail.task.projectId, projectId);
        assert.strictEqual(
          detail.task.refUrl,
          "https://acme.slack.com/archives/C1/p1700000000000100",
        );
        assert.deepEqual(
          detail.history.filter((entry) => entry.action === "houston:slack-filed").length,
          1,
        );
        yield* flush;
        const eyes = fake.callsOf("reactions.add");
        assert.deepEqual(
          eyes.map((call) => [call.body.channel, call.body.timestamp, call.body.name]),
          [["C1", ts, "eyes"]],
        );
        assert.deepEqual(
          fake.callsOf("conversations.open").map((call) => call.body.users),
          [OWNER],
        );
        const posts = fake.callsOf("chat.postMessage");
        assert.lengthOf(posts, 1);
        const dm = posts[0];
        assert.strictEqual(dm?.body.channel, `D${OWNER}`);
        assert.isUndefined(dm?.body.thread_ts);
        const text = `${dm?.body.text ?? ""} ${dm?.body.blocks ?? ""}`;
        assert.include(text, "<#C1>");
        assert.include(text, "<@U2>");
        assert.include(text, firstLine);
        assert.include(text, "starts right away");
        assert.notInclude(text, "TAIL281");
        const blocks = JSON.parse(dm?.body.blocks ?? "[]") as Array<{
          readonly type: string;
          readonly elements?: ReadonlyArray<{ readonly text: { readonly text: string } }>;
        }>;
        const buttons = blocks.flatMap((block) => block.elements ?? []).map((e) => e.text.text);
        assert.deepEqual(buttons, ["Accept", "Refuse", "View message"]);

        // Redelivered and replayed: nothing more.
        yield* deliver(fake, envelope);
        fake.history.set("C1", [{ ...mentionEvent(ts, `${firstLine}\n${body}`), type: "message" }]);
        fake.sockets.at(-1)?.close();
        yield* untilAdvancing(
          "the replay",
          Effect.flatMap(HoustonSlackService, (slack) => slack.get).pipe(
            Effect.map(
              (info) =>
                fake.callsOf("conversations.history").length >= 2 && info.lastCatchupAt !== null,
            ),
          ),
        );
        yield* Effect.flatMap(HoustonSlackService, (slack) => slack.get);
        yield* flush;
        assert.strictEqual(yield* taskCount, 1);
        const sql = yield* SqlClient.SqlClient;
        const [count] = yield* sql<{ readonly n: number }>`
          SELECT COUNT(*) AS n FROM houston_slack_requests
        `;
        assert.strictEqual(count?.n, 1);
        assert.lengthOf(fake.callsOf("chat.postMessage"), 1);
      }),
    ),
  );
});

describe("a request over the text limit is marked and the owner is told why", () => {
  it.effect("a request over the text limit is marked and the owner is told why", () =>
    runSlack((fake) =>
      Effect.gen(function* () {
        yield* connected(fake, "bounds");
        const long = "a".repeat(8_193);
        yield* mention(fake, "1700000000.000100", long);
        yield* deliver(
          fake,
          eventEnvelope({ ...mentionEvent("1700000000.000200", ""), text: `<@${FAKE_BOT}>` }),
        );
        for (const ts of ["1700000000.000100", "1700000000.000200"]) {
          yield* until(`${ts} marked`, requestAt(ts).pipe(Effect.map((row) => row !== undefined)));
          const row = (yield* requestAt(ts)) as RequestRow;
          assert.strictEqual(row.state, "refused");
          assert.isNull(row.task_id);
          assert.strictEqual(row.status_reaction, "warning");
        }
        assert.strictEqual(yield* taskCount, 0);
        yield* flush;
        const threads = fake.callsOf("chat.postMessage").filter((call) => call.body.thread_ts);
        assert.deepEqual(threads.map((call) => call.body.thread_ts).sort(), [
          "1700000000.000100",
          "1700000000.000200",
        ]);
        for (const call of threads) assert.include(call.body.text ?? "", "Reply right here");
        const dms = fake.callsOf("chat.postMessage").filter((call) => !call.body.thread_ts);
        assert.lengthOf(dms, 2);
        const reasons = dms.map((call) => call.body.text ?? "").join("\n");
        assert.include(reasons, "8193 bytes");
        assert.include(reasons, "8192");
        assert.include(reasons, "no request text");
        assert.deepEqual(
          fake.callsOf("reactions.add").map((call) => call.body.name),
          ["warning", "warning"],
        );

        // The requester's next reply in the thread is the request.
        yield* deliver(
          fake,
          eventEnvelope({
            type: "message",
            channel: "C1",
            user: "U2",
            team: "T1",
            ts: "1700000000.000300",
            thread_ts: "1700000000.000200",
            text: "Make the export button work",
          }),
        );
        yield* until(
          "the reply filed",
          requestAt("1700000000.000200").pipe(Effect.map((row) => row?.task_id != null)),
        );
        assert.strictEqual((yield* requestAt("1700000000.000200"))?.state, "pending");
        // 8,192 bytes is filed.
        yield* mention(fake, "1700000000.000400", "b".repeat(8_192));
        yield* until(
          "the bound filed",
          requestAt("1700000000.000400").pipe(Effect.map((row) => row?.task_id != null)),
        );
        assert.strictEqual(yield* taskCount, 2);
      }),
    ),
  );
});

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 4, 5, 6]);
const WEBP = new TextEncoder().encode("RIFF\u0000\u0000\u0000\u0000WEBPVP8 data");
const GIF = new TextEncoder().encode("GIF89a-data");
const SVG = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"></svg>');

describe("images are bounded, sniffed and fetched only from slack hosts", () => {
  it.effect("images are bounded, sniffed and fetched only from slack hosts", () =>
    runSlack((fake) =>
      Effect.gen(function* () {
        const config = yield* ServerConfig.ServerConfig;
        yield* connected(fake, "images");
        const big = new Uint8Array(10 * 1024 * 1024 + 1);
        big.set(PNG);
        const serve = (name: string, body: Uint8Array) => {
          fake.files.set(`/files/${name}`, { body });
          return {
            id: `F${name}`,
            name,
            mimetype: "image/png",
            url_private_download: `${fake.origin}/files/${name}`,
          };
        };
        const files = [
          serve("a.png", PNG),
          serve("b.jpg", JPEG),
          serve("drawing.png", SVG),
          {
            id: "Fevil",
            name: "evil.png",
            mimetype: "image/png",
            url_private_download: "https://files.slack.com.evil.example/files/evil.png",
          },
          serve("big.png", big),
          serve("c.webp", WEBP),
          serve("d.gif", GIF),
          serve("extra.png", PNG),
        ];
        const ts = "1700000000.000100";
        yield* mention(fake, ts, "see the screenshots", { files, subtype: "file_share" });
        yield* until("filed", requestAt(ts).pipe(Effect.map((row) => row?.task_id != null)));
        const row = (yield* requestAt(ts)) as RequestRow;
        const stored = JSON.parse(row.attachments_json ?? "[]") as ReadonlyArray<{
          readonly type: string;
          readonly id: string;
          readonly name: string;
          readonly mimeType: string;
          readonly sizeBytes: number;
        }>;
        assert.deepEqual(
          stored.map((entry) => [entry.name, entry.mimeType]),
          [
            ["a.png", "image/png"],
            ["b.jpg", "image/jpeg"],
            ["c.webp", "image/webp"],
            ["d.gif", "image/gif"],
          ],
        );
        for (const entry of stored) {
          assert.strictEqual(entry.type, "image");
          const onDisk = NodeFS.readdirSync(config.attachmentsDir).filter((file) =>
            file.startsWith(entry.id),
          );
          assert.lengthOf(onDisk, 1, entry.name);
          assert.strictEqual(
            NodeFS.statSync(NodePath.join(config.attachmentsDir, onDisk[0] ?? "")).size,
            entry.sizeBytes,
          );
        }
        assert.deepEqual(fake.fileRequests, [
          "/files/a.png",
          "/files/b.jpg",
          "/files/drawing.png",
          "/files/big.png",
          "/files/c.webp",
          "/files/d.gif",
        ]);
        yield* flush;
        const dm = fake.callsOf("chat.postMessage").find((call) => !call.body.thread_ts);
        const text = `${dm?.body.text ?? ""} ${dm?.body.blocks ?? ""}`;
        assert.include(text, "drawing.png");
        assert.include(text, "evil.png");
        assert.include(text, "big.png");
        assert.include(text, "extra.png");
        assert.notInclude(text, "a.png ");
      }),
    ),
  );
});

describe("a refused filing marks the request and tells the owner", () => {
  it.effect("a refused filing marks the request and tells the owner", () =>
    runSlack((fake) =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* connected(fake, "refused-filing");
        // A mapping left to a project removed without its deletion hook.
        yield* sql`
          INSERT INTO houston_slack_channels (channel_id, project_id, cursor_ts, mapped_at)
          VALUES ('C7', 'project-gone', '0.000000', '2026-10-30T00:00:00.000Z')
        `;
        const ts = "1700000000.000100";
        yield* mention(fake, ts, "fix it", { channel: "C7" });
        yield* until("refused", requestAt(ts).pipe(Effect.map((row) => row?.state === "refused")));
        const row = (yield* requestAt(ts)) as RequestRow;
        assert.isNull(row.task_id);
        assert.strictEqual(row.status_reaction, "warning");
        yield* flush;
        const dm = fake.callsOf("chat.postMessage").find((call) => !call.body.thread_ts);
        assert.include(dm?.body.text ?? "", "project-gone");
        assert.deepEqual(
          fake.callsOf("reactions.add").map((call) => [call.body.channel, call.body.name]),
          [["C7", "warning"]],
        );
      }),
    ),
  );
});

describe("only the owner's check mark, accept or start starts the request", () => {
  it.effect("only the owner's check mark, accept or start starts the request", () => {
    const runs: FakeRuns = makeFakeRuns();
    return runSlack(
      (fake) =>
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const projectId = yield* connected(fake, "gestures");
          const houstonRuns = yield* HoustonTaskRuns;
          const slack = yield* HoustonSlackService;
          const replies = yield* HoustonSlackReplies;
          // Each start's run is handed back at once, so the cap never queues one.
          const release = sql`UPDATE houston_task_runs SET state = 'handed_back'`;
          const gestures: ReadonlyArray<{
            readonly label: string;
            readonly starts: boolean;
            readonly act: (row: RequestRow & { readonly key: string }) => Effect.Effect<unknown>;
          }> = [
            {
              label: "owner check mark",
              starts: true,
              act: (row) => reaction(fake, OWNER, "white_check_mark", row.ts),
            },
            {
              label: "owner accept",
              starts: true,
              act: (row) => click(fake, OWNER, "houston_slack_accept", row.id),
            },
            {
              label: "start in houston",
              starts: true,
              act: (row) =>
                houstonRuns.start({ id: row.key }).pipe(Effect.andThen(replies.tick), Effect.orDie),
            },
            {
              label: "someone's check mark",
              starts: false,
              act: (row) => reaction(fake, "U2", "white_check_mark", row.ts),
            },
            {
              label: "someone's accept",
              starts: false,
              act: (row) => click(fake, "U2", "houston_slack_accept", row.id),
            },
            {
              label: "owner eyes",
              starts: false,
              act: (row) => reaction(fake, OWNER, "eyes", row.ts),
            },
            {
              label: "no owner",
              starts: false,
              act: (row) =>
                slack
                  .configure({ ownerUserId: null, channels: [{ channelId: "C1", projectId }] })
                  .pipe(
                    Effect.andThen(reaction(fake, OWNER, "white_check_mark", row.ts)),
                    Effect.orDie,
                  ),
            },
          ];
          let index = 0;
          for (const gesture of gestures) {
            index += 1;
            const ts = `1700000000.00${String(index).padStart(4, "0")}`;
            const row = yield* fileReady(fake, ts, `Request ${index}`);
            const starts = runs.starts.length;
            yield* gesture.act(row);
            if (gesture.starts) {
              yield* until(
                gesture.label,
                requestAt(ts).pipe(Effect.map((current) => current?.state === "started")),
              );
              const current = (yield* requestAt(ts)) as RequestRow;
              assert.strictEqual(current.status_reaction, "gear", gesture.label);
              assert.strictEqual(runs.starts.length, starts + 1, gesture.label);
              assert.strictEqual(runs.starts.at(-1), row.key, gesture.label);
              const actions = yield* historyOf(row.task_id);
              assert.lengthOf(
                actions.filter((action) => action === "houston:slack-accepted"),
                1,
                gesture.label,
              );
              yield* release;
            } else {
              yield* Effect.flatMap(HoustonSlackService, (s) => s.get);
              for (let turn = 0; turn < 20; turn += 1) yield* realTurn;
              yield* tick;
              assert.strictEqual((yield* requestAt(ts))?.state, "pending", gesture.label);
              assert.strictEqual(runs.starts.length, starts, gesture.label);
            }
          }
          yield* flush;
          const ephemerals = fake.callsOf("chat.postEphemeral");
          assert.lengthOf(ephemerals, 1);
          assert.strictEqual(ephemerals[0]?.body.user, "U2");
          assert.include(ephemerals[0]?.body.text ?? "", "only the owner can accept");
          assert.isAtLeast(
            fake.callsOf("reactions.add").filter((call) => call.body.name === "gear").length,
            3,
          );
        }),
      { runs },
    );
  });
});

describe("an owner's check mark keeps an unready request pending and reports readiness", () => {
  it.effect("an owner's check mark keeps an unready request pending and reports readiness", () => {
    const runs = makeFakeRuns();
    return runSlack(
      (fake) =>
        Effect.gen(function* () {
          yield* connected(fake, "unready");
          const ts = "1700000000.000100";
          yield* mention(fake, ts, "make it faster");
          yield* until("filed", requestAt(ts).pipe(Effect.map((row) => row?.task_id != null)));
          yield* reaction(fake, OWNER, "white_check_mark", ts);
          yield* until(
            "the warning",
            requestAt(ts).pipe(Effect.map((row) => row?.status_reaction === "warning")),
          );
          assert.strictEqual((yield* requestAt(ts))?.state, "pending");
          assert.lengthOf(runs.starts, 0);
          yield* flush;
          const dms = fake.callsOf("chat.postMessage").filter((call) => !call.body.thread_ts);
          assert.lengthOf(dms, 2);
          assert.include(dms[1]?.body.text ?? "", "acceptance item");
          assert.deepEqual(
            fake.callsOf("reactions.add").map((call) => call.body.name),
            ["eyes", "warning"],
          );
          assert.deepEqual(
            fake.callsOf("reactions.remove").map((call) => call.body.name),
            ["eyes"],
          );
        }),
      { runs },
    );
  });
});

describe("accepted requests past the working cap wait in a queue", () => {
  it.effect("accepted requests past the working cap wait in a queue", () => {
    const runs = makeFakeRuns();
    return runSlack(
      (fake) =>
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const slack = yield* HoustonSlackService;
          yield* connected(fake, "cap");
          const rows: Array<RequestRow & { readonly key: string }> = [];
          for (let index = 1; index <= 5; index += 1) {
            rows.push(yield* fileReady(fake, `1700000000.00000${index}`, `Request ${index}`));
          }
          const stateOf = (index: number) =>
            requestAt(rows[index]?.ts ?? "").pipe(Effect.map((row) => row?.state));
          const accept = (index: number, state: string) =>
            Effect.gen(function* () {
              yield* reaction(fake, OWNER, "white_check_mark", rows[index]?.ts ?? "");
              yield* until(
                `request ${index + 1} ${state}`,
                stateOf(index).pipe(Effect.map((s) => s === state)),
              );
            });
          yield* accept(0, "started");
          yield* accept(1, "started");
          yield* accept(2, "queued");
          const listed = (yield* slack.requests({})) as ReadonlyArray<HoustonSlackRequest>;
          assert.strictEqual(
            listed.find((entry) => entry.taskId === rows[2]?.task_id)?.queuePosition,
            1,
          );
          yield* flush;
          const queuedDm = fake
            .callsOf("chat.postMessage")
            .filter((call) => !call.body.thread_ts)
            .map((call) => call.body.text ?? "")
            .find((text) => text.includes("queued"));
          assert.include(queuedDm ?? "", "position 1");

          // The first run asks a question: its slot frees and the queued request starts.
          const [firstRun] = yield* sql<{ readonly id: number }>`
            SELECT id FROM houston_task_runs WHERE task_id = ${rows[0]?.task_id ?? 0}
          `;
          yield* sql`
            INSERT INTO houston_slack_questions (request_id, task_run_id, thread_id, form_json, created_at)
            VALUES (${rows[0]?.id ?? 0}, ${firstRun?.id ?? 0}, 'task-1', '{}', '2026-10-30T00:00:00.000Z')
          `;
          yield* tick;
          yield* until(
            "the queued one started",
            stateOf(2).pipe(Effect.map((s) => s === "started")),
          );
          assert.strictEqual(runs.starts.length, 3);

          // Two more queue in acceptance order and start oldest first as slots free.
          yield* accept(3, "queued");
          yield* accept(4, "queued");
          const positions = ((yield* slack.requests({})) as ReadonlyArray<HoustonSlackRequest>)
            .filter((entry) => entry.state === "queued")
            .map((entry) => [entry.taskId, entry.queuePosition]);
          assert.deepEqual(positions, [
            [rows[3]?.task_id, 1],
            [rows[4]?.task_id, 2],
          ]);
          // A run handed back frees its slot.
          yield* sql`
            UPDATE houston_task_runs SET state = 'handed_back' WHERE task_id = ${rows[1]?.task_id ?? 0}
          `;
          yield* tick;
          yield* until("the fourth started", stateOf(3).pipe(Effect.map((s) => s === "started")));
          assert.strictEqual(yield* stateOf(4), "queued");
          yield* sql`
            UPDATE houston_task_runs SET state = 'handed_back' WHERE task_id = ${rows[2]?.task_id ?? 0}
          `;
          yield* tick;
          yield* until("the fifth started", stateOf(4).pipe(Effect.map((s) => s === "started")));
          assert.deepEqual(
            runs.starts,
            [0, 1, 2, 3, 4].map((index) => rows[index]?.key),
          );
        }),
      { runs },
    );
  });
});

describe("the owner refuses with a reason that reaches the thread as written", () => {
  it.effect("the owner refuses with a reason that reaches the thread as written", () =>
    runSlack((fake) =>
      Effect.gen(function* () {
        const tasks = yield* HoustonTaskService.HoustonTaskService;
        yield* connected(fake, "refuse");
        const first = yield* fileReady(fake, "1700000000.000100", "First");
        const second = yield* fileReady(fake, "1700000000.000200", "Second");

        yield* click(fake, OWNER, "houston_slack_refuse", first.id);
        yield* until(
          "the dialog",
          Effect.sync(() => fake.callsOf("views.open").length === 1),
        );
        const opened = fake.callsOf("views.open")[0];
        assert.isString(opened?.body.trigger_id);
        const view = JSON.parse(opened?.body.view ?? "{}") as Record<string, unknown>;
        assert.strictEqual(view.callback_id, "houston_slack_refuse");
        assert.strictEqual(view.private_metadata, String(first.id));
        assert.include(JSON.stringify(view), '"max_length":2000');

        // Over the dialog's bound: nothing changes.
        yield* submitRefusal(fake, OWNER, first.id, "x".repeat(2_001));
        for (let turn = 0; turn < 20; turn += 1) yield* realTurn;
        assert.strictEqual((yield* requestAt(first.ts))?.state, "pending");

        yield* submitRefusal(fake, OWNER, first.id, "Not this quarter <@U9>");
        yield* until(
          "refused",
          requestAt(first.ts).pipe(Effect.map((row) => row?.state === "refused")),
        );
        assert.strictEqual((yield* tasks.get({ id: first.key })).task.status, "canceled");
        assert.strictEqual((yield* requestAt(first.ts))?.status_reaction, "no_entry_sign");

        yield* submitRefusal(fake, OWNER, second.id, "");
        yield* until(
          "refused",
          requestAt(second.ts).pipe(Effect.map((row) => row?.state === "refused")),
        );
        yield* flush;
        const threads = fake.callsOf("chat.postMessage").filter((call) => call.body.thread_ts);
        assert.lengthOf(threads, 1);
        assert.strictEqual(threads[0]?.body.thread_ts, first.ts);
        const text = `${threads[0]?.body.text ?? ""} ${threads[0]?.body.blocks ?? ""}`;
        assert.include(text, "Not going ahead");
        assert.include(text, `<@${OWNER}>`);
        assert.include(text, "Not this quarter &lt;@U9&gt;");
        assert.notInclude(text, "<@U9>");
        assert.deepEqual(
          fake
            .callsOf("reactions.add")
            .filter((call) => call.body.name === "no_entry_sign")
            .map((call) => call.body.timestamp),
          [first.ts, second.ts],
        );
      }),
    ),
  );
});
