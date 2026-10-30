// Connecting the Slack app, its tokens in the (memory) keychain, the settings and channel map,
// over one database with the loopback fake Slack.
import { assert, describe, it } from "@effect/vitest";
import { HoustonSlackError } from "@t3tools/contracts/houston/slack";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as SqlClient from "effect/sql/SqlClient";
import { TestClock } from "effect/testing";

import * as ServerConfig from "../../config.ts";
import { makeMemory } from "../secrets/HoustonKeychain.ts";
import { createProject, deleteProject } from "../tasks/tasks.testkit.ts";
import { slackKeychainService } from "./rules.ts";
import { HoustonSlackService } from "./Service.ts";
import { mentionEvent } from "./slack.fake.ts";
import {
  APP_TOKEN,
  BOT_TOKEN,
  OWNER,
  advance,
  connectSlack,
  runSlack,
  until,
  untilAdvancing,
  untilConnected,
} from "./slack.testkit.ts";

const refusal = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.flip(effect).pipe(
    Effect.map((error) => {
      assert.instanceOf(error, HoustonSlackError);
      return error as unknown as HoustonSlackError;
    }),
  );

const keyOf = (service: string, account: string) => `${service}\u0000${account}`;

const serviceName = Effect.map(ServerConfig.ServerConfig, (config) =>
  slackKeychainService(config.baseDir),
);

const settingsRow = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<Record<string, unknown>>`SELECT * FROM houston_slack_settings`;
  return rows[0];
});

const fingerprint = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return JSON.stringify(
    yield* Effect.all([
      sql`SELECT * FROM houston_slack_settings`,
      sql`SELECT * FROM houston_slack_channels ORDER BY channel_id`,
    ]),
  );
});

describe("slack info starts empty and returns current values", () => {
  it.effect("slack info starts empty and returns current values", () =>
    runSlack(() =>
      Effect.gen(function* () {
        const slack = yield* HoustonSlackService;
        const fresh = yield* slack.get;
        assert.deepEqual(
          {
            enabled: fresh.enabled,
            hasTokens: fresh.hasTokens,
            connection: fresh.connection,
            team: fresh.team,
            botUserId: fresh.botUserId,
            ownerUserId: fresh.ownerUserId,
            channels: fresh.channels,
            language: fresh.language,
            lastEventAt: fresh.lastEventAt,
            lastCatchupAt: fresh.lastCatchupAt,
            error: fresh.error,
            revision: fresh.revision,
          },
          {
            enabled: false,
            hasTokens: false,
            connection: "off",
            team: null,
            botUserId: null,
            ownerUserId: null,
            channels: [],
            language: "en",
            lastEventAt: null,
            lastCatchupAt: null,
            error: null,
            revision: 0,
          },
        );
        const projectId = yield* createProject("info");
        yield* slack.configure({
          ownerUserId: OWNER,
          channels: [
            { channelId: "C1", projectId },
            { channelId: "G2", projectId },
          ],
          language: "pt-BR",
        });
        yield* slack.connect({
          appToken: Redacted.make(APP_TOKEN),
          botToken: Redacted.make(BOT_TOKEN),
        });
        const info = yield* slack.get;
        assert.isTrue(info.enabled);
        assert.isTrue(info.hasTokens);
        assert.strictEqual(info.ownerUserId, OWNER);
        assert.deepEqual(info.channels, [
          { channelId: "C1", projectId },
          { channelId: "G2", projectId },
        ]);
        assert.strictEqual(info.language, "pt-BR");
        assert.strictEqual(info.team, "Acme");
        assert.strictEqual(info.botUserId, "UBOT");
        assert.isAtLeast(info.revision, 1);
      }),
    ),
  );
});

describe("connect stores both tokens in the keychain and checks them with auth.test", () => {
  it.effect("connect stores both tokens in the keychain and checks them with auth.test", () => {
    const keychain = makeMemory();
    return runSlack(
      (fake) =>
        Effect.gen(function* () {
          const slack = yield* HoustonSlackService;
          const service = yield* serviceName;
          assert.match(service, /^houston-v2-slack-connection-[0-9a-f]{16}$/);
          const info = yield* slack.connect({
            appToken: Redacted.make(" xapp-1-A "),
            botToken: Redacted.make("xoxb-1-b"),
          });
          assert.strictEqual(keychain.entries.get(keyOf(service, "app-token")), "xapp-1-A");
          assert.strictEqual(keychain.entries.get(keyOf(service, "bot-token")), "xoxb-1-b");
          assert.lengthOf(keychain.entries, 2);
          const authTests = fake.callsOf("auth.test");
          assert.lengthOf(authTests, 1);
          assert.strictEqual(authTests[0]?.token, "xoxb-1-b");
          assert.isTrue(info.enabled);
          assert.isTrue(info.hasTokens);
          const row = yield* settingsRow;
          assert.strictEqual(row?.team_id, "T1");
          assert.strictEqual(row?.team, "Acme");
          assert.strictEqual(row?.bot_user_id, "UBOT");
          assert.isString(row?.credential_set_at);
          assert.notInclude(JSON.stringify(row), "xoxb-1-b");

          // Neither token: enables with the stored ones.
          const sql = yield* SqlClient.SqlClient;
          yield* sql`UPDATE houston_slack_settings SET enabled = 0`;
          const again = yield* slack.connect({});
          assert.isTrue(again.enabled);
          assert.isTrue(again.hasTokens);

          // Neither token and none stored: credential_missing.
          keychain.entries.clear();
          const missing = yield* refusal(slack.connect({}));
          assert.strictEqual(missing.kind, "credential_missing");
          assert.strictEqual(missing.operation, "houston.slack.connect");
        }),
      { keychain },
    );
  });
});

describe("a refused token stores nothing", () => {
  it.effect("a refused token stores nothing", () => {
    const keychain = makeMemory();
    return runSlack(
      (fake) =>
        Effect.gen(function* () {
          const slack = yield* HoustonSlackService;
          const before = yield* fingerprint;
          const inputs = [
            { appToken: Redacted.make("xoxb-swapped-secret"), botToken: Redacted.make(BOT_TOKEN) },
            { appToken: Redacted.make(APP_TOKEN), botToken: Redacted.make("xapp-wrong") },
            { appToken: Redacted.make("   "), botToken: Redacted.make(BOT_TOKEN) },
            { appToken: Redacted.make(APP_TOKEN) },
            {
              appToken: Redacted.make(APP_TOKEN),
              botToken: Redacted.make(`xoxb-${"b".repeat(2_045)}`),
            },
          ];
          for (const input of inputs) {
            const refused = yield* refusal(slack.connect(input));
            assert.include(["invalid", "limit"], refused.kind);
            assert.notInclude(refused.message, "swapped-secret");
            assert.notInclude(refused.message, BOT_TOKEN);
          }
          assert.lengthOf(keychain.entries, 0);
          assert.isFalse(keychain.calls.some((call) => call.op === "set"));
          assert.lengthOf(fake.calls, 0);
          assert.strictEqual(yield* fingerprint, before);
          assert.isFalse((yield* slack.get).enabled);
        }),
      { keychain },
    );
  });
});

describe("a token slack refuses is removed again", () => {
  it.effect("a token slack refuses is removed again", () => {
    const keychain = makeMemory();
    return runSlack(
      (fake) =>
        Effect.gen(function* () {
          const slack = yield* HoustonSlackService;
          const service = yield* serviceName;
          const answers = [
            { body: { ok: false, error: "invalid_auth" }, code: "invalid_auth" },
            { status: 500, body: {}, code: "500" },
            { body: { ok: true, team_id: "T1", team: "Acme" }, code: "user_id" },
          ];
          for (const answer of answers) {
            fake.override = (call) => (call.method === "auth.test" ? answer : null);
            const refused = yield* refusal(
              slack.connect({
                appToken: Redacted.make(APP_TOKEN),
                botToken: Redacted.make(BOT_TOKEN),
              }),
            );
            assert.strictEqual(refused.kind, "remote", answer.code);
            assert.include(refused.message, "auth.test");
            assert.include(refused.message, answer.code);
            assert.notInclude(refused.message, BOT_TOKEN);
            assert.isFalse(keychain.entries.has(keyOf(service, "app-token")));
            assert.isFalse(keychain.entries.has(keyOf(service, "bot-token")));
            assert.isFalse((yield* slack.get).enabled);
          }
          assert.isTrue(keychain.calls.some((call) => call.op === "remove"));
          assert.lengthOf(fake.callsOf("apps.connections.open"), 0);
        }),
      { keychain },
    );
  });
});

describe("an unreachable keychain is refused by name", () => {
  it.effect("an unreachable keychain is refused by name", () => {
    const keychain = makeMemory();
    return runSlack(
      (fake) =>
        Effect.gen(function* () {
          const slack = yield* HoustonSlackService;
          const projectId = yield* createProject("keychain");
          keychain.failWith = "the Secret Service is not running";
          yield* slack.configure({
            ownerUserId: OWNER,
            channels: [{ channelId: "C1", projectId }],
          });
          const refused = yield* refusal(
            slack.connect({
              appToken: Redacted.make(APP_TOKEN),
              botToken: Redacted.make(BOT_TOKEN),
            }),
          );
          assert.strictEqual(refused.kind, "keychain_unavailable");
          assert.include(refused.message, "the Secret Service is not running");
          assert.lengthOf(keychain.entries, 0);
          assert.isFalse((yield* slack.get).hasTokens);
          assert.lengthOf(fake.calls, 0);

          // An intake enabled before the keychain went away stays retrying and sends nothing.
          keychain.failWith = null;
          yield* connectSlack(projectId);
          yield* untilConnected;
          yield* until(
            "the catch-up",
            slack.get.pipe(Effect.map((info) => info.lastCatchupAt !== null)),
          );
          keychain.failWith = "the Secret Service is not running";
          const sent = fake.calls.length;
          for (const socket of fake.sockets) socket.close();
          yield* untilAdvancing(
            "retrying without tokens",
            slack.get.pipe(
              Effect.map(
                (info) =>
                  info.connection === "retrying" &&
                  info.error === "Slack tokens are not available from the OS keychain",
              ),
            ),
          );
          yield* advance(70);
          const info = yield* slack.get;
          assert.strictEqual(info.connection, "retrying");
          assert.isFalse(info.hasTokens);
          assert.strictEqual(fake.calls.length, sent);
        }),
      { keychain },
    );
  });
});

describe("one token without the other is an error, not absence", () => {
  it.effect("one token without the other is an error, not absence", () => {
    const keychain = makeMemory();
    return runSlack(
      (fake) =>
        Effect.gen(function* () {
          const slack = yield* HoustonSlackService;
          const projectId = yield* createProject("half");
          const service = yield* serviceName;
          yield* connectSlack(projectId);
          yield* untilConnected;
          const opens = fake.callsOf("apps.connections.open").length;

          keychain.entries.delete(keyOf(service, "app-token"));
          const noApp = yield* slack.get;
          assert.isFalse(noApp.hasTokens);
          assert.include(noApp.error ?? "", "app-level token");
          assert.include(noApp.error ?? "", "connect again with both");
          for (const socket of fake.sockets) socket.close();
          yield* advance(70);
          assert.strictEqual(fake.callsOf("apps.connections.open").length, opens);

          keychain.entries.set(keyOf(service, "app-token"), APP_TOKEN);
          keychain.entries.delete(keyOf(service, "bot-token"));
          const noBot = yield* slack.get;
          assert.isFalse(noBot.hasTokens);
          assert.include(noBot.error ?? "", "bot token");
          assert.include(noBot.error ?? "", "connect again with both");
        }),
      { keychain },
    );
  });
});

describe("disconnect closes the socket and removes both tokens", () => {
  it.effect("disconnect closes the socket and removes both tokens", () => {
    const keychain = makeMemory();
    return runSlack(
      (fake) =>
        Effect.gen(function* () {
          const slack = yield* HoustonSlackService;
          const sql = yield* SqlClient.SqlClient;
          const projectId = yield* createProject("disconnect");
          yield* connectSlack(projectId);
          yield* untilConnected;
          const info = yield* slack.disconnect;
          assert.isFalse(info.enabled);
          assert.strictEqual(info.connection, "off");
          assert.isFalse(info.hasTokens);
          yield* until(
            "the socket closed",
            Effect.sync(() => fake.sockets.every((socket) => socket.closed)),
          );
          assert.lengthOf(keychain.entries, 0);
          assert.isNull((yield* settingsRow)?.credential_set_at);
          // Absent entries succeed.
          assert.isFalse((yield* slack.disconnect).enabled);
          // Something owed to Slack while disabled stays unsent.
          yield* sql`
            INSERT INTO houston_slack_outbox (request_id, dedupe_key, target, text, created_at)
            VALUES (1, 'disabled-probe', 'dm', 'probe', '2026-10-30T00:00:00.000Z')
          `;
          const sent = fake.calls.length;
          const reads = keychain.calls.length;
          yield* advance(60);
          assert.strictEqual(fake.calls.length, sent);
          assert.strictEqual(keychain.calls.length, reads);
          assert.lengthOf(
            fake.sockets.filter((socket) => !socket.closed),
            0,
          );
        }),
      { keychain },
    );
  });
});

describe("configure refuses by name and checks the revision", () => {
  it.effect("configure refuses by name and checks the revision", () =>
    runSlack(() =>
      Effect.gen(function* () {
        const slack = yield* HoustonSlackService;
        const projectId = yield* createProject("configure");
        const stored = yield* slack.configure({
          ownerUserId: "U123",
          channels: [
            { channelId: "C1", projectId },
            { channelId: "G2", projectId },
          ],
        });
        assert.strictEqual(stored.ownerUserId, "U123");
        assert.strictEqual(stored.revision, 1);
        const before = yield* fingerprint;
        const many = Array.from({ length: 17 }, (_, index) => ({
          channelId: `C${index + 10}`,
          projectId,
        }));
        const cases: ReadonlyArray<
          readonly [Parameters<typeof slack.configure>[0], string, string]
        > = [
          [{ ownerUserId: "X1", channels: [] }, "invalid", "X1"],
          [{ ownerUserId: "u12", channels: [] }, "invalid", "u12"],
          [{ channels: [{ channelId: "c123", projectId }] }, "invalid", "c123"],
          [
            {
              channels: [
                { channelId: "C1", projectId },
                { channelId: "C1", projectId },
              ],
            },
            "invalid",
            "C1",
          ],
          [{ channels: many }, "limit", "16"],
          [
            { channels: [{ channelId: "C1", projectId: "project-missing" as typeof projectId }] },
            "not_found",
            "project-missing",
          ],
          [{ expectedRevision: 0, channels: [] }, "conflict", "1"],
        ];
        for (const [input, kind, named] of cases) {
          const refused = yield* refusal(slack.configure(input));
          assert.strictEqual(refused.kind, kind, JSON.stringify(input).slice(0, 80));
          assert.include(refused.message, named);
          assert.strictEqual(yield* fingerprint, before);
        }
        const limited = yield* refusal(slack.configure({ channels: many }));
        assert.strictEqual(limited.limit, 16);
        assert.strictEqual(limited.actual, 17);
        const stale = yield* refusal(slack.configure({ expectedRevision: 0, channels: [] }));
        assert.strictEqual(stale.expected, 0);
        assert.strictEqual(stale.actual, 1);
        const sixteen = yield* slack.configure({
          expectedRevision: 1,
          channels: many.slice(0, 16),
        });
        assert.lengthOf(sixteen.channels, 16);
        assert.strictEqual(sixteen.revision, 2);
      }),
    ),
  );
});

describe("deleting a project unmaps its channels", () => {
  it.effect("deleting a project unmaps its channels", () =>
    runSlack(() =>
      Effect.gen(function* () {
        const slack = yield* HoustonSlackService;
        const sql = yield* SqlClient.SqlClient;
        const gone = yield* createProject("gone");
        const kept = yield* createProject("kept");
        yield* slack.configure({
          channels: [
            { channelId: "C1", projectId: gone },
            { channelId: "C2", projectId: kept },
          ],
        });
        yield* sql`
          INSERT INTO houston_slack_requests (channel_id, ts, author, project_id, task_id, state, created_at)
          VALUES ('C1', '1700000000.000100', 'U2', ${gone}, 7, 'pending', '2026-10-30T00:00:00.000Z')
        `;
        yield* deleteProject(gone);
        const info = yield* slack.get;
        assert.deepEqual(info.channels, [{ channelId: "C2", projectId: kept }]);
        const requests = yield* sql<{ readonly task_id: number }>`
          SELECT task_id FROM houston_slack_requests
        `;
        assert.deepEqual(
          requests.map((row) => row.task_id),
          [7],
        );
      }),
    ),
  );
});

describe("a newly mapped channel starts from the moment it is mapped", () => {
  it.effect("a newly mapped channel starts from the moment it is mapped", () =>
    runSlack(
      (fake) =>
        Effect.gen(function* () {
          const slack = yield* HoustonSlackService;
          const sql = yield* SqlClient.SqlClient;
          const first = yield* createProject("cursor");
          const second = yield* createProject("cursor-two");
          yield* slack.configure({
            ownerUserId: OWNER,
            channels: [{ channelId: "C1", projectId: first }],
          });
          const cursor = () =>
            sql<{ readonly cursor_ts: string }>`
            SELECT cursor_ts FROM houston_slack_channels WHERE channel_id = 'C1'
          `.pipe(Effect.map((rows) => rows[0]?.cursor_ts));
          assert.strictEqual(yield* cursor(), "1800000000.000000");
          fake.history.set("C1", [
            { ...mentionEvent("1799999999.000000", "before mapping"), type: "message" },
            { ...mentionEvent("1800000001.000000", "after mapping"), type: "message" },
          ]);
          yield* TestClock.adjust("2 seconds");
          yield* slack.connect({
            appToken: Redacted.make(APP_TOKEN),
            botToken: Redacted.make(BOT_TOKEN),
          });
          yield* untilConnected;
          yield* until(
            "the catch-up",
            slack.get.pipe(Effect.map((info) => info.lastCatchupAt !== null)),
          );
          const filed = yield* sql<{ readonly ts: string }>`
          SELECT ts FROM houston_slack_requests ORDER BY ts
        `;
          assert.deepEqual(
            filed.map((row) => row.ts),
            ["1800000001.000000"],
          );
          const moved = yield* cursor();
          assert.strictEqual(moved, "1800000001.000000");
          yield* TestClock.adjust("98 seconds");
          yield* slack.configure({ channels: [{ channelId: "C1", projectId: second }] });
          assert.strictEqual(yield* cursor(), moved);
        }),
      { startAtMs: 1_800_000_000_000 },
    ),
  );
});
