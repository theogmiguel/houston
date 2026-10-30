// @effect-diagnostics nodeBuiltinImport:off - names the database file of a restart.
// The outbox against the loopback fake: one status reaction at a time, bounded batches, the
// plain-text fallback, dropping after five refusals, and what a restart resends.
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as SqlClient from "effect/sql/SqlClient";

import { makeMemory } from "../secrets/HoustonKeychain.ts";
import { createProject } from "../tasks/tasks.testkit.ts";
import { HoustonSlackOutbox } from "./Outbox.ts";
import { HoustonSlackService } from "./Service.ts";
import { makeSlackFake } from "./slack.fake.ts";
import {
  advance,
  connectSlack,
  layerSlackTest,
  realTurn,
  runSlack,
  until,
  untilConnected,
} from "./slack.testkit.ts";
import { HoustonSlackStore } from "./Store.ts";

const insertRequest = (projectId: string, ts = "1700000000.000100") =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const [row] = yield* sql<{ readonly id: number }>`
      INSERT INTO houston_slack_requests (channel_id, ts, author, project_id, state, created_at)
      VALUES ('C1', ${ts}, 'U2', ${projectId}, 'pending', '2026-10-30T00:00:00.000Z')
      RETURNING id
    `;
    return row?.id ?? 0;
  });

describe("a status change swaps one reaction for another", () => {
  it.effect("a status change swaps one reaction for another", () =>
    runSlack((fake) =>
      Effect.gen(function* () {
        const store = yield* HoustonSlackStore;
        const outbox = yield* HoustonSlackOutbox;
        const sql = yield* SqlClient.SqlClient;
        const projectId = yield* createProject("reactions");
        yield* connectSlack(projectId);
        yield* untilConnected;
        const id = yield* insertRequest(projectId);
        yield* store.react(id, "eyes");
        yield* outbox.tick;
        yield* store.react(id, "gear");
        yield* store.react(id, "gear");
        yield* outbox.tick;
        assert.deepEqual(
          fake.calls
            .filter((call) => call.method.startsWith("reactions."))
            .map(
              (call) =>
                `${call.method} ${call.body.name} ${call.body.channel} ${call.body.timestamp}`,
            ),
          [
            "reactions.add eyes C1 1700000000.000100",
            "reactions.remove eyes C1 1700000000.000100",
            "reactions.add gear C1 1700000000.000100",
          ],
        );
        // already_reacted and no_reaction count as sent.
        fake.override = (call) =>
          call.method === "reactions.add"
            ? { body: { ok: false, error: "already_reacted" } }
            : call.method === "reactions.remove"
              ? { body: { ok: false, error: "no_reaction" } }
              : null;
        yield* store.react(id, "warning");
        yield* outbox.tick;
        yield* outbox.tick;
        const unsent = yield* sql<{ readonly n: number }>`
          SELECT COUNT(*) AS n FROM houston_slack_outbox WHERE sent_at IS NULL
        `;
        assert.strictEqual(unsent[0]?.n, 0);
        assert.lengthOf(
          fake.calls.filter((call) => call.method === "reactions.add"),
          3,
        );
        const [request] = yield* sql<{ readonly status_reaction: string }>`
          SELECT status_reaction FROM houston_slack_requests WHERE id = ${id}
        `;
        assert.strictEqual(request?.status_reaction, "warning");
      }),
    ),
  );
});

describe("the outbox sends in bounded batches, falls back to text and survives a restart", () => {
  it.effect("the outbox sends in bounded batches, falls back to text and survives a restart", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "houston-slack-outbox-" });
      const fake = yield* makeSlackFake;
      const keychain = makeMemory();
      const layer = () =>
        layerSlackTest({
          slackOrigin: fake.origin,
          databaseFile: NodePath.join(dir, "state.sqlite"),
          baseDir: dir,
          keychain,
        });
      const postedTexts = () => fake.callsOf("chat.postMessage").map((call) => call.body.text);

      yield* Effect.gen(function* () {
        const store = yield* HoustonSlackStore;
        const projectId = yield* createProject("batches", "/work/batches");
        yield* connectSlack(projectId);
        yield* untilConnected;
        const id = yield* insertRequest(projectId);
        for (let index = 1; index <= 25; index += 1) {
          yield* store.enqueue({
            requestId: id,
            dedupeKey: `row-${index}`,
            target: "thread",
            text: `row ${index}`,
            messageTs: "1700000000.000100",
          });
        }
        // An existing dedupe key adds no row.
        yield* store.enqueue({
          requestId: id,
          dedupeKey: "row-1",
          target: "thread",
          text: "row 1 again",
          messageTs: "1700000000.000100",
        });
        const sql = yield* SqlClient.SqlClient;
        const [count] = yield* sql<{
          readonly n: number;
        }>`SELECT COUNT(*) AS n FROM houston_slack_outbox`;
        assert.strictEqual(count?.n, 25);

        yield* advance(5);
        yield* until(
          "the first batch",
          Effect.sync(() => postedTexts().length >= 10),
        );
        for (let turn = 0; turn < 20; turn += 1) yield* realTurn;
        assert.deepEqual(
          postedTexts(),
          Array.from({ length: 10 }, (_, index) => `row ${index + 1}`),
        );
        yield* advance(5);
        yield* until(
          "the second batch",
          Effect.sync(() => postedTexts().length >= 20),
        );
        for (let turn = 0; turn < 20; turn += 1) yield* realTurn;
        assert.lengthOf(postedTexts(), 20);
      }).pipe(Effect.provide(layer()));

      // After a restart over the same file: the five unsent rows, and nothing sent before.
      yield* Effect.gen(function* () {
        const outbox = yield* HoustonSlackOutbox;
        const store = yield* HoustonSlackStore;
        const slack = yield* HoustonSlackService;
        yield* outbox.tick;
        assert.deepEqual(
          postedTexts(),
          Array.from({ length: 25 }, (_, index) => `row ${index + 1}`),
        );

        // Refused blocks: sent again as plain text with the same text.
        fake.refuseBlocks = true;
        yield* store.enqueue({
          requestId: 1,
          dedupeKey: "blocks",
          target: "thread",
          text: "with blocks",
          blocks: [{ type: "section", text: { type: "mrkdwn", text: "with blocks" } }],
          messageTs: "1700000000.000100",
        });
        yield* outbox.tick;
        const fallback = fake
          .callsOf("chat.postMessage")
          .filter((call) => call.body.text === "with blocks");
        assert.lengthOf(fallback, 2);
        assert.isString(fallback[0]?.body.blocks);
        assert.isUndefined(fallback[1]?.body.blocks);
        fake.refuseBlocks = false;

        // Refused five times: dropped and named.
        fake.override = (call) =>
          call.body.text === "doomed" ? { body: { ok: false, error: "channel_not_found" } } : null;
        yield* store.enqueue({
          requestId: 1,
          dedupeKey: "doomed-row",
          target: "thread",
          text: "doomed",
          messageTs: "1700000000.000100",
        });
        for (let attempt = 0; attempt < 7; attempt += 1) yield* outbox.tick;
        assert.lengthOf(
          fake.callsOf("chat.postMessage").filter((call) => call.body.text === "doomed"),
          5,
        );
        const error = (yield* slack.get).error ?? "";
        assert.include(error, "doomed-row");
        assert.include(error, "channel_not_found");
      }).pipe(Effect.provide(layer()));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
