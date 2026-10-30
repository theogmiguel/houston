// The Slack Web API client against the loopback fake: its origin, bearer, timeout and 429 rules.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Redacted from "effect/Redacted";
import { FetchHttpClient } from "effect/http";
import { TestClock } from "effect/testing";

import { makeSlackFake } from "./slack.fake.ts";
import { until } from "./slack.testkit.ts";
import { SLACK_API_ORIGIN, checkOrigin, make } from "./WebApi.ts";

const TOKEN = Redacted.make("xoxb-web-api-test-token-31c");

describe("the slack web api client is bounded to its origin, time and wait", () => {
  it.effect("the slack web api client is bounded to its origin, time and wait", () =>
    Effect.gen(function* () {
      assert.strictEqual(SLACK_API_ORIGIN, "https://slack.com/api/");
      assert.isNull(checkOrigin("https://slack.com/api/", false));
      for (const origin of [
        "http://slack.com/api/",
        "https://slack.com.evil.example/api/",
        "https://files.slack.com/api/",
        "https://slack.com/other/",
        "http://127.0.0.1:9/api/",
      ]) {
        assert.isString(checkOrigin(origin, false), origin);
      }
      assert.isNull(checkOrigin("http://127.0.0.1:9/api/", true));

      const fake = yield* makeSlackFake;
      // A client of the fake that may not use loopback refuses before sending anything.
      const refusing = yield* make({ origin: `${fake.origin}/api/`, allowLoopback: false });
      const refused = yield* Effect.flip(refusing.call(TOKEN, "auth.test", {}));
      assert.include(refused.message, fake.origin);
      assert.lengthOf(fake.calls, 0);

      const client = yield* make({ origin: `${fake.origin}/api/`, allowLoopback: true });
      const ok = yield* client.call(TOKEN, "auth.test", {});
      assert.strictEqual(ok.team_id, "T1");
      assert.strictEqual(fake.calls[0]?.method, "auth.test");
      assert.strictEqual(fake.calls[0]?.token, Redacted.value(TOKEN));

      fake.override = (call) =>
        call.method === "conversations.info"
          ? { body: { ok: false, error: "channel_not_found" } }
          : null;
      const notFound = yield* Effect.flip(
        client.call(TOKEN, "conversations.info", { channel: "C9" }),
      );
      assert.strictEqual(notFound.method, "conversations.info");
      assert.strictEqual(notFound.code, "channel_not_found");
      assert.include(notFound.message, "conversations.info");
      assert.include(notFound.message, "channel_not_found");
      assert.notInclude(notFound.message, Redacted.value(TOKEN));

      // One wait of Retry-After: 2, then success.
      let limited = 0;
      fake.override = (call) =>
        call.method === "chat.postMessage" && (limited += 1) === 1
          ? {
              status: 429,
              headers: { "retry-after": "2" },
              body: { ok: false, error: "ratelimited" },
            }
          : null;
      const waiting = yield* client
        .call(TOKEN, "chat.postMessage", { channel: "C1", text: "hi" })
        .pipe(Effect.forkChild);
      yield* until(
        "the first attempt",
        Effect.sync(() => limited === 1),
      );
      yield* TestClock.adjust("1 second");
      assert.strictEqual(limited, 1);
      yield* TestClock.adjust("1 second");
      const posted = yield* Fiber.join(waiting);
      assert.isTrue(posted.ok === true);
      assert.strictEqual(limited, 2);

      // A wait over 30 seconds is refused naming both.
      fake.override = () => ({ status: 429, headers: { "retry-after": "31" }, body: {} });
      const long = yield* Effect.flip(client.call(TOKEN, "chat.postMessage", { channel: "C1" }));
      assert.include(long.message, "31");
      assert.include(long.message, "30");

      // A second 429 after one wait fails.
      fake.override = () => ({ status: 429, headers: { "retry-after": "1" }, body: {} });
      const before = fake.calls.length;
      const twice = yield* client
        .call(TOKEN, "chat.postMessage", { channel: "C1" })
        .pipe(Effect.flip, Effect.forkChild);
      yield* until(
        "the first 429",
        Effect.sync(() => fake.calls.length === before + 1),
      );
      yield* TestClock.adjust("1 second");
      const again = yield* Fiber.join(twice);
      assert.strictEqual(fake.calls.length, before + 2);
      assert.include(again.message, "chat.postMessage");

      // A stalled answer times out at 30 seconds, naming the method.
      fake.override = () => ({ stall: true });
      const stalled = yield* client
        .call(TOKEN, "reactions.add", { channel: "C1" })
        .pipe(Effect.flip, Effect.forkChild);
      yield* until(
        "the stalled call",
        Effect.sync(() => fake.calls.at(-1)?.method === "reactions.add"),
      );
      yield* TestClock.adjust("29 seconds");
      assert.isUndefined(stalled.pollUnsafe());
      yield* TestClock.adjust("1 second");
      const timeout = yield* Fiber.join(stalled);
      assert.include(timeout.message, "reactions.add");
      assert.include(timeout.message, "30");
    }).pipe(
      Effect.provide(FetchHttpClient.layer),
      Effect.scoped,
      Effect.provide(NodeServices.layer),
    ),
  );
});
