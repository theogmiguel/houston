import { assert, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as TestClock from "effect/testing/TestClock";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import { describe } from "vite-plus/test";

import * as OpenCode2Client from "./OpenCode2Client.ts";

const INFO_BODY = '{"version":"2.0.18","pid":4242,"urls":[],"paths":{"tmp":"/tmp"}}';

const authorizationFor = (password: string | Redacted.Redacted) => {
  const seen: Array<string | undefined> = [];
  const layerCapturing = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.sync(() => {
        seen.push(request.headers.authorization);
        return HttpClientResponse.fromWeb(
          request,
          new Response(INFO_BODY, { headers: { "content-type": "application/json" } }),
        );
      }),
    ),
  );
  return Effect.gen(function* () {
    const opencode = yield* OpenCode2Client.OpenCode2Client;
    const { client } = yield* opencode.connect({ baseUrl: "http://127.0.0.1:4096", password });
    yield* client.server.info();
    return seen[0];
  }).pipe(Effect.provide(OpenCode2Client.layer.pipe(Layer.provide(layerCapturing))));
};

const utf8Basic = (password: string) =>
  `Basic ${Buffer.from(`opencode:${password}`, "utf8").toString("base64")}`;

describe("OpenCode2Client authorization", () => {
  // OpenCode requires UTF-8 Basic auth; btoa rejects or misencodes non-ASCII.
  it.effect("encodes non-ASCII passwords as UTF-8", () =>
    Effect.gen(function* () {
      assert.strictEqual(yield* authorizationFor("pässwörd"), utf8Basic("pässwörd"));
      assert.strictEqual(yield* authorizationFor("pass€word"), utf8Basic("pass€word"));
      assert.strictEqual(yield* authorizationFor(Redacted.make("pässwörd")), utf8Basic("pässwörd"));
    }),
  );
});

describe("OpenCode2Client event subscription", () => {
  it.effect("times out and cancels a subscription with no response headers", () =>
    Effect.gen(function* () {
      const cancelled = yield* Deferred.make<void>();
      const transport = Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) => {
          assert.strictEqual(request.url, "http://127.0.0.1:4096/api/event");
          return Effect.never.pipe(Effect.ensuring(Deferred.succeed(cancelled, undefined)));
        }),
      );
      const opencode = yield* OpenCode2Client.OpenCode2Client.pipe(
        Effect.provide(OpenCode2Client.layer.pipe(Layer.provide(transport))),
      );
      const { events } = yield* opencode.connect({
        baseUrl: "http://127.0.0.1:4096",
        password: "test-password",
      });
      const opening = yield* events.pipe(Effect.flip, Effect.forkScoped);

      yield* TestClock.adjust("10 seconds");
      assert.isTrue(yield* Deferred.isDone(cancelled));
      const error = yield* Fiber.join(opening);
      assert.strictEqual(error._tag, "TimeoutError");
      assert.isTrue(Cause.isTimeoutError(error));
    }).pipe(Effect.scoped),
  );
});
