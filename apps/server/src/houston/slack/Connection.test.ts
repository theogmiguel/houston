// @effect-diagnostics nodeBuiltinImport:off - reads server.ts and the test files for the startup check.
// The Socket Mode connection against the loopback fake: acks, wss only, silence, blocked writes,
// backoff, the catch-up after each hello, and the tokens read per attempt and per tick.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as SqlClient from "effect/sql/SqlClient";
import { TestClock } from "effect/testing";

import * as ServerConfig from "../../config.ts";
import { makeMemory } from "../secrets/HoustonKeychain.ts";
import * as HoustonTaskService from "../tasks/TaskService.ts";
import { createProject } from "../tasks/tasks.testkit.ts";
import { slackKeychainService } from "./rules.ts";
import { HoustonSlackOutbox } from "./Outbox.ts";
import { HoustonSlackService } from "./Service.ts";
import { mentionEnvelope, mentionEvent } from "./slack.fake.ts";
import {
  APP_TOKEN,
  BOT_TOKEN,
  OWNER,
  advance,
  connectSlack,
  makeFakeRuns,
  realTurn,
  runSlack,
  until,
  untilAdvancing,
  untilConnected,
} from "./slack.testkit.ts";

const requestRows = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql<{
    readonly ts: string;
    readonly state: string;
    readonly task_id: number | null;
  }>`
    SELECT ts, state, task_id FROM houston_slack_requests ORDER BY ts
  `;
});

const info = Effect.flatMap(HoustonSlackService, (slack) => slack.get);

describe("socket mode acks each envelope and accepts only wss", () => {
  it.effect("socket mode acks each envelope and accepts only wss", () => {
    const log: Array<string> = [];
    return runSlack(
      (fake) =>
        Effect.gen(function* () {
          const projectId = yield* createProject("acks");
          fake.override = (call) => {
            if (call.method === "chat.getPermalink") log.push("intake");
            return null;
          };
          yield* connectSlack(projectId);
          yield* untilConnected;
          const opens = fake.callsOf("apps.connections.open");
          assert.lengthOf(opens, 1);
          assert.strictEqual(opens[0]?.token, APP_TOKEN);

          fake.sockets[0]?.send(mentionEnvelope("e1", mentionEvent("1700000000.000100", "fix it")));
          yield* until(
            "the ack",
            Effect.sync(() => fake.sockets[0]?.received.length === 1),
          );
          assert.deepEqual(fake.sockets[0]?.received[0], { envelope_id: "e1" });
          yield* until(
            "the intake",
            Effect.sync(() => log.includes("intake")),
          );
          assert.deepEqual(log.slice(0, 2), ["ack e1", "intake"]);

          // Slack asks for a refresh: a new connection after the backoff.
          fake.sockets[0]?.send({ type: "disconnect", reason: "refresh_requested" });
          yield* untilAdvancing(
            "the refreshed connection",
            Effect.sync(() => fake.sockets.length === 2 && fake.sockets[0]?.closed === true),
          );
          yield* untilConnected;

          fake.sockets[1]?.send({ type: "disconnect", reason: "link_disabled" });
          yield* untilAdvancing(
            "link_disabled",
            info.pipe(
              Effect.map((current) => current.error === "Socket Mode was turned off for the app"),
            ),
          );

          // A URL that is not wss is refused by scheme and never opened.
          for (const url of ["ws://evil.example/link", "https://wss-primary.slack.com/link"]) {
            const sockets = fake.sockets.length;
            const before = fake.callsOf("apps.connections.open").length;
            fake.override = (call) =>
              call.method === "apps.connections.open" ? { body: { ok: true, url } } : null;
            for (const socket of fake.sockets) socket.close();
            yield* untilAdvancing(
              `the refusal of ${url}`,
              info.pipe(
                Effect.map(
                  (current) =>
                    fake.callsOf("apps.connections.open").length > before &&
                    (current.error ?? "").includes(new URL(url).protocol),
                ),
              ),
            );
            assert.strictEqual(fake.sockets.length, sockets);
            assert.notStrictEqual((yield* info).connection, "connected");
          }
        }),
      {
        transport: (base) => ({
          open: (url) =>
            Effect.map(base.open(url), (session) => ({
              ...session,
              send: (text: string) =>
                session.send(text).pipe(
                  Effect.tap(() =>
                    Effect.sync(() => {
                      const parsed = JSON.parse(text) as { envelope_id?: string };
                      if (parsed.envelope_id !== undefined) log.push(`ack ${parsed.envelope_id}`);
                    }),
                  ),
                ),
            })),
        }),
      },
    );
  });
});

describe("a silent or blocked socket reconnects with backoff", () => {
  it.effect("a peer that answers pings is kept", () =>
    runSlack((fake) =>
      Effect.gen(function* () {
        const projectId = yield* createProject("kept");
        yield* connectSlack(projectId);
        yield* untilConnected;
        yield* advance(200);
        assert.lengthOf(fake.callsOf("apps.connections.open"), 1);
        assert.isFalse(fake.sockets[0]?.closed);
        assert.isAtLeast(fake.sockets[0]?.pings ?? 0, 6);
      }),
    ),
  );

  it.effect("a peer that says hello and then nothing is silent at 90 seconds", () =>
    runSlack((fake) =>
      Effect.gen(function* () {
        fake.socketMode.answerPings = false;
        const projectId = yield* createProject("silent");
        yield* connectSlack(projectId);
        yield* untilConnected;
        yield* advance(89);
        assert.isAtLeast(fake.sockets[0]?.pings ?? 0, 2);
        assert.lengthOf(fake.callsOf("apps.connections.open"), 1);
        yield* untilAdvancing(
          "the reconnect",
          Effect.sync(() => fake.callsOf("apps.connections.open").length === 2),
        );
        assert.isTrue(fake.sockets[0]?.closed);
      }),
    ),
  );

  it.effect("a write blocked 20 seconds ends the connection before the event is forwarded", () => {
    const blocking = { acks: false };
    return runSlack(
      (fake) =>
        Effect.gen(function* () {
          const projectId = yield* createProject("blocked");
          yield* connectSlack(projectId);
          yield* untilConnected;
          blocking.acks = true;
          fake.sockets[0]?.send(
            mentionEnvelope("e9", mentionEvent("1700000000.000900", "blocked")),
          );
          yield* advance(19);
          assert.lengthOf(fake.callsOf("apps.connections.open"), 1);
          yield* untilAdvancing(
            "the reconnect after a blocked ack",
            Effect.sync(() => fake.callsOf("apps.connections.open").length === 2),
          );
          assert.lengthOf(fake.callsOf("chat.getPermalink"), 0);
          assert.lengthOf(yield* requestRows, 0);
        }),
      {
        transport: (base) => ({
          open: (url) =>
            Effect.map(base.open(url), (session) => ({
              ...session,
              send: (text: string) =>
                blocking.acks && text.includes("envelope_id") ? Effect.never : session.send(text),
            })),
        }),
      },
    );
  });

  it.effect("reconnects wait 1, 2, 4 ... 60 seconds and reset after a hello", () =>
    runSlack((fake) =>
      Effect.gen(function* () {
        const projectId = yield* createProject("backoff");
        yield* connectSlack(projectId);
        yield* untilConnected;
        let second = 0;
        const attempts: Array<number> = [];
        let failing = true;
        fake.override = (call) => {
          if (call.method !== "apps.connections.open") return null;
          attempts.push(second);
          return failing ? { body: { ok: false, error: "internal_error" } } : null;
        };
        fake.sockets[0]?.close();
        yield* until(
          "the close",
          Effect.sync(() => fake.sockets[0]?.closed === true),
        );
        for (let step = 0; step < 250; step += 1) {
          second += 1;
          yield* TestClock.adjust("1 second");
          for (let turn = 0; turn < 3; turn += 1) yield* realTurn;
        }
        const gaps = attempts.slice(1).map((at, index) => at - (attempts[index] ?? 0));
        assert.strictEqual(attempts[0], 1);
        assert.deepEqual(gaps.slice(0, 7), [2, 4, 8, 16, 32, 60, 60]);
        failing = false;
        yield* untilAdvancing(
          "connected again",
          info.pipe(Effect.map((c) => c.connection === "connected")),
        );
        const helloAt = second;
        attempts.length = 0;
        fake.sockets.at(-1)?.close();
        yield* untilAdvancing(
          "the reconnect after hello",
          Effect.sync(() => attempts.length === 1),
        );
        assert.isAtMost((attempts[0] ?? 0) - helloAt, 2);
      }),
    ),
  );
});

describe("a reconnect replays what was missed within 24 hours", () => {
  it.effect("a reconnect replays what was missed within 24 hours", () => {
    const runs = makeFakeRuns();
    return runSlack(
      (fake) =>
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const tasks = yield* HoustonTaskService.HoustonTaskService;
          const slack = yield* HoustonSlackService;
          const projectId = yield* createProject("catchup");
          const t0 = 1_800_000_000;
          const now = t0 + 30 * 3600;
          yield* slack.configure({
            ownerUserId: OWNER,
            channels: [{ channelId: "C1", projectId }],
          });
          // The channel was mapped 30 hours ago.
          yield* sql`UPDATE houston_slack_channels SET cursor_ts = ${`${t0}.000000`}`;
          const ready = yield* tasks.save(
            {
              patch: {
                title: "Filed earlier",
                acceptance: ["it works"],
                projectId,
                status: "todo",
              },
            },
            "slack:U2",
          );
          const filedTs = `${now - 3600}.000000`;
          yield* sql`
            INSERT INTO houston_slack_requests (channel_id, ts, author, project_id, task_id, state, status_reaction, created_at)
            VALUES ('C1', ${filedTs}, 'U2', ${projectId}, ${ready.id}, 'pending', 'eyes', '2026-10-30T00:00:00.000Z')
          `;
          const filler = Array.from({ length: 205 }, (_, index) => ({
            type: "message",
            user: "U3",
            team: "T1",
            ts: `${now - 7200 + index + 1}.000000`,
            text: `chatter ${index}`,
          }));
          fake.history.set("C1", [
            { ...mentionEvent(`${now - 7200}.000000`, "two hours ago"), type: "message" },
            {
              ...mentionEvent(`${now - 25 * 3600}.000000`, "a day and an hour ago"),
              type: "message",
            },
            {
              ...mentionEvent(filedTs, "filed earlier"),
              type: "message",
              reactions: [{ name: "white_check_mark", users: [OWNER], count: 1 }],
            },
            ...filler,
          ]);
          yield* slack.connect({
            appToken: Redacted.make(APP_TOKEN),
            botToken: Redacted.make(BOT_TOKEN),
          });
          yield* untilConnected;
          yield* until(
            "the catch-up",
            info.pipe(Effect.map((current) => current.lastCatchupAt !== null)),
          );

          const history = fake.callsOf("conversations.history");
          assert.isAtLeast(history.length, 2);
          assert.strictEqual(history[0]?.body.channel, "C1");
          assert.strictEqual(history[0]?.body.oldest, `${now - 24 * 3600}.000000`);
          assert.strictEqual(history[0]?.body.limit, "200");
          assert.strictEqual(history[1]?.body.cursor, "200");
          assert.strictEqual(history[0]?.token, BOT_TOKEN);

          const rows = yield* requestRows;
          assert.deepEqual(
            rows.map((row) => [row.ts, row.state]),
            [
              [`${now - 7200}.000000`, "pending"],
              [filedTs, "started"],
            ],
          );
          assert.deepEqual(runs.starts, [ready.key]);
          const [channel] = yield* sql<{ readonly cursor_ts: string }>`
            SELECT cursor_ts FROM houston_slack_channels WHERE channel_id = 'C1'
          `;
          // The newest message read is the filed request, an hour old.
          assert.strictEqual(channel?.cursor_ts, filedTs);
          assert.isString((yield* info).lastCatchupAt);

          // The same history again files and accepts nothing more.
          const first = (yield* info).lastCatchupAt;
          yield* TestClock.adjust("1 second");
          fake.sockets[0]?.close();
          yield* untilAdvancing(
            "the second catch-up",
            info.pipe(Effect.map((current) => current.lastCatchupAt !== first)),
          );
          assert.lengthOf(yield* requestRows, 2);
          assert.deepEqual(runs.starts, [ready.key]);
        }),
      { runs, startAtMs: (1_800_000_000 + 30 * 3600) * 1000 },
    );
  });
});

describe("each attempt and tick reads the current tokens", () => {
  it.effect("each attempt and tick reads the current tokens", () => {
    const keychain = makeMemory();
    return runSlack(
      (fake) =>
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const slack = yield* HoustonSlackService;
          const outbox = yield* HoustonSlackOutbox;
          const config = yield* ServerConfig.ServerConfig;
          const service = slackKeychainService(config.baseDir);
          const projectId = yield* createProject("tokens");
          yield* connectSlack(projectId);
          yield* untilConnected;
          const reads = () =>
            keychain.calls.filter((call) => call.op === "get" && call.service === service).length;

          yield* slack.connect({
            appToken: Redacted.make("xapp-1-A0NEW-replaced"),
            botToken: Redacted.make("xoxb-replaced-bot"),
          });
          yield* until(
            "the attempt with the new app token",
            Effect.sync(
              () => fake.callsOf("apps.connections.open").at(-1)?.token === "xapp-1-A0NEW-replaced",
            ),
          );
          yield* sql`
            INSERT INTO houston_slack_requests (channel_id, ts, author, project_id, state, created_at)
            VALUES ('C1', '1700000000.000100', 'U2', ${projectId}, 'pending', '2026-10-30T00:00:00.000Z')
          `;
          yield* sql`
            INSERT INTO houston_slack_outbox (request_id, dedupe_key, target, text, message_ts, created_at)
            VALUES (1, 'probe', 'thread', 'hello', '1700000000.000100', '2026-10-30T00:00:00.000Z')
          `;
          const before = reads();
          yield* outbox.tick;
          assert.strictEqual(reads() - before, 1);
          const posted = fake.callsOf("chat.postMessage").at(-1);
          assert.strictEqual(posted?.token, "xoxb-replaced-bot");
          assert.strictEqual(posted?.body.thread_ts, "1700000000.000100");

          yield* slack.disconnect;
          const after = reads();
          yield* outbox.tick;
          yield* advance(30);
          assert.strictEqual(reads(), after);
        }),
      { keychain },
    );
  });
});

describe("the server and the harness start one slack loop", () => {
  it.effect("the server and the harness start one slack loop", () =>
    runSlack((fake) =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const projectId = yield* createProject("loops");
        yield* connectSlack(projectId);
        yield* untilConnected;
        yield* advance(3);
        assert.lengthOf(fake.callsOf("apps.connections.open"), 1);
        assert.lengthOf(fake.sockets, 1);
        yield* sql`
          INSERT INTO houston_slack_requests (channel_id, ts, author, project_id, state, created_at)
          VALUES ('C1', '1700000000.000100', 'U2', ${projectId}, 'pending', '2026-10-30T00:00:00.000Z')
        `;
        for (let index = 0; index < 15; index += 1) {
          yield* sql`
            INSERT INTO houston_slack_outbox (request_id, dedupe_key, target, text, message_ts, created_at)
            VALUES (1, ${`loop-${index}`}, 'thread', ${`row ${index}`}, '1700000000.000100', '2026-10-30T00:00:00.000Z')
          `;
        }
        yield* advance(5);
        yield* until(
          "one batch",
          Effect.sync(() => fake.callsOf("chat.postMessage").length >= 10),
        );
        yield* realTurn;
        assert.lengthOf(fake.callsOf("chat.postMessage"), 10);

        // The server's assembly uses the live client and keychain; no test uses the live client.
        const root = NodePath.resolve(import.meta.dirname, "../..");
        const server = NodeFS.readFileSync(NodePath.join(root, "server.ts"), "utf8");
        assert.strictEqual(server.split("layerSlack(").length - 1, 1);
        assert.include(server, "SlackWebApi.layer,");
        // HoustonKeychain.test.ts proves server.ts is the only assembly of the live keychain.
        assert.include(server, "Layer.provideMerge(HoustonSlackStore.layer)");
        const tests = NodeFS.readdirSync(root, { recursive: true, withFileTypes: true })
          .filter((entry) => entry.isFile() && entry.name.endsWith(".test.ts"))
          .map((entry) => NodePath.join(entry.parentPath, entry.name));
        for (const file of tests) {
          if (NodePath.resolve(file) === NodePath.resolve(import.meta.filename)) continue;
          const text = NodeFS.readFileSync(file, "utf8");
          assert.notMatch(text, /SlackWebApi\.layer\b(?!Test)/, file);
          assert.notMatch(text, /WebApi\.ts";[\s\S]*\blayer as /, file);
        }
      }),
    ),
  );
});
