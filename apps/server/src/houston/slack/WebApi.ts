// The Slack Web API client: HTTPS to slack.com/api only, no redirects, bounded answers, a
// 30-second timeout and one bounded wait on a rate limit. The token is borrowed per call.
import { collectUint8StreamText } from "@t3tools/provider-core/server/collectStreamText";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";

import { isSlackFileUrl } from "./rules.ts";

export const SLACK_API_ORIGIN = "https://slack.com/api/";
const TIMEOUT_SECONDS = 30;
const MAX_RETRY_AFTER_SECONDS = 30;
// Slack's largest answers here are history pages of 200 messages.
const MAX_ANSWER_BYTES = 4 * 1024 * 1024;
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

/** A refused or failed call, named by its method and Slack's error code. Never a token. */
export class SlackApiError extends Data.TaggedError("SlackApiError")<{
  readonly method: string;
  readonly code: string;
  readonly message: string;
}> {}

export type SlackAnswer = Readonly<Record<string, unknown>>;

export class SlackWebApi extends Context.Service<
  SlackWebApi,
  {
    /** Whether loopback hosts stand in for Slack's: the test layer only. */
    readonly allowLoopback: boolean;
    readonly call: (
      token: Redacted.Redacted<string>,
      method: string,
      params: Readonly<Record<string, unknown>>,
    ) => Effect.Effect<SlackAnswer, SlackApiError>;
    /** Reads at most `maxBytes`; `truncated` when the file is longer. */
    readonly download: (
      token: Redacted.Redacted<string>,
      url: string,
      maxBytes: number,
    ) => Effect.Effect<{ readonly bytes: Uint8Array; readonly truncated: boolean }, SlackApiError>;
  }
>()("houston/houston/slack/WebApi/SlackWebApi") {}

/** Null when a client may use `origin`: Slack's API over HTTPS, or loopback when allowed. */
export const checkOrigin = (origin: string, allowLoopback: boolean): string | null => {
  const url = URL.parse(origin);
  if (url !== null && url.pathname === "/api/") {
    if (url.protocol === "https:" && url.host === "slack.com") return null;
    if (allowLoopback && url.protocol === "http:" && LOOPBACK.has(url.hostname)) return null;
  }
  return `the Slack Web API origin must be ${SLACK_API_ORIGIN}, not ${JSON.stringify(origin)}`;
};

const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));

const formOf = (params: Readonly<Record<string, unknown>>) => {
  const form = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    form.set(key, typeof value === "string" ? value : JSON.stringify(value));
  }
  return form.toString();
};

export const make = Effect.fn("HoustonSlack.makeWebApi")(function* (options: {
  readonly origin: string;
  readonly allowLoopback?: boolean;
}) {
  const http = yield* HttpClient.HttpClient;
  const allowLoopback = options.allowLoopback === true;
  const refused = checkOrigin(options.origin, allowLoopback);
  const fail = (method: string, code: string, message: string) =>
    Effect.fail(new SlackApiError({ method, code, message }));

  // Only messages written here leave: a transport error is named by its kind, never its URL.
  const execute = (method: string, request: HttpClientRequest.HttpClientRequest) =>
    http.execute(request).pipe(
      Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
      Effect.provideService(HttpClient.TracerDisabledWhen, () => true),
      Effect.mapError(
        (error) =>
          new SlackApiError({
            method,
            code: "transport",
            message: `Slack request ${method} failed: ${error.reason._tag}`,
          }),
      ),
    );

  const once = Effect.fnUntraced(function* (
    token: Redacted.Redacted<string>,
    method: string,
    params: Readonly<Record<string, unknown>>,
  ) {
    const request = HttpClientRequest.post(`${options.origin}${method}`).pipe(
      HttpClientRequest.bearerToken(Redacted.value(token)),
      HttpClientRequest.bodyText(formOf(params), "application/x-www-form-urlencoded"),
    );
    const response = yield* execute(method, request);
    if (response.status === 429) {
      return { status: 429, retryAfter: response.headers["retry-after"] ?? null, text: "" };
    }
    const collected = yield* collectUint8StreamText({
      stream: response.stream,
      maxBytes: MAX_ANSWER_BYTES,
    }).pipe(
      Effect.mapError(
        (error) =>
          new SlackApiError({
            method,
            code: "transport",
            message: `Slack's answer to ${method} could not be read: ${error.reason._tag}`,
          }),
      ),
    );
    if (response.status < 200 || response.status >= 300) {
      return yield* fail(
        method,
        `http_${response.status}`,
        `Slack answered ${method} with HTTP ${response.status}`,
      );
    }
    if (collected.truncated) {
      return yield* fail(
        method,
        "too_large",
        `Slack's answer to ${method} exceeded ${MAX_ANSWER_BYTES} bytes`,
      );
    }
    return { status: response.status, retryAfter: null, text: collected.text };
  });

  const call: SlackWebApi["Service"]["call"] = Effect.fn("SlackWebApi.call")(function* (
    token: Redacted.Redacted<string>,
    method: string,
    params: Readonly<Record<string, unknown>>,
  ): Effect.fn.Return<SlackAnswer, SlackApiError> {
    if (refused !== null) return yield* fail(method, "origin", refused);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const answer = yield* once(token, method, params).pipe(
        Effect.timeoutOrElse({
          duration: Duration.seconds(TIMEOUT_SECONDS),
          orElse: () =>
            fail(
              method,
              "timeout",
              `Slack request ${method} had no answer within ${TIMEOUT_SECONDS} seconds`,
            ),
        }),
      );
      if (answer.status !== 429) {
        const body = yield* decodeJson(answer.text).pipe(
          Effect.mapError(
            () =>
              new SlackApiError({
                method,
                code: "invalid_json",
                message: `Slack answered ${method} with invalid JSON`,
              }),
          ),
        );
        if (typeof body !== "object" || body === null || Array.isArray(body)) {
          return yield* fail(method, "invalid_json", `Slack answered ${method} without an object`);
        }
        const record = body as SlackAnswer;
        if (record.ok !== true) {
          const code = typeof record.error === "string" ? record.error : "unknown_error";
          return yield* fail(method, code, `Slack refused ${method}: ${code}`);
        }
        return record;
      }
      if (attempt === 1) {
        return yield* fail(
          method,
          "ratelimited",
          `Slack rate-limited ${method} again after one wait`,
        );
      }
      const seconds = Number(answer.retryAfter ?? "1");
      const wait = Number.isFinite(seconds) && seconds >= 0 ? seconds : 1;
      if (wait > MAX_RETRY_AFTER_SECONDS) {
        return yield* fail(
          method,
          "ratelimited",
          `Slack rate-limited ${method} for ${wait} seconds; the limit is ${MAX_RETRY_AFTER_SECONDS} seconds`,
        );
      }
      yield* Effect.sleep(Duration.seconds(wait));
    }
    return yield* fail(method, "ratelimited", `Slack rate-limited ${method}`);
  });

  const download: SlackWebApi["Service"]["download"] = Effect.fn("SlackWebApi.download")(
    function* (token, url, maxBytes) {
      const method = "file download";
      if (!isSlackFileUrl(url, allowLoopback)) {
        return yield* fail(method, "not_slack_host", "the file is not on a Slack file host");
      }
      const response = yield* execute(
        method,
        HttpClientRequest.get(url).pipe(HttpClientRequest.bearerToken(Redacted.value(token))),
      ).pipe(
        Effect.timeoutOrElse({
          duration: Duration.seconds(TIMEOUT_SECONDS),
          orElse: () =>
            fail(method, "timeout", `the download had no answer within ${TIMEOUT_SECONDS} seconds`),
        }),
      );
      if (response.status < 200 || response.status >= 300) {
        return yield* fail(
          method,
          `http_${response.status}`,
          `Slack answered the download with HTTP ${response.status}`,
        );
      }
      let total = 0;
      const chunks = yield* response.stream.pipe(
        Stream.takeUntil((chunk) => {
          total += chunk.byteLength;
          return total > maxBytes;
        }),
        Stream.runCollect,
        Effect.timeoutOrElse({
          duration: Duration.seconds(TIMEOUT_SECONDS),
          orElse: () =>
            fail(method, "timeout", `the download took longer than ${TIMEOUT_SECONDS} seconds`),
        }),
        Effect.mapError((error) =>
          error instanceof SlackApiError
            ? error
            : new SlackApiError({
                method,
                code: "transport",
                message: `the download failed: ${error.reason._tag}`,
              }),
        ),
      );
      const all = Buffer.concat(Array.from(chunks));
      return all.byteLength > maxBytes
        ? { bytes: new Uint8Array(all.subarray(0, maxBytes)), truncated: true }
        : { bytes: new Uint8Array(all), truncated: false };
    },
  );

  return SlackWebApi.of({ allowLoopback, call, download });
});

export const layer = Layer.effect(SlackWebApi, make({ origin: SLACK_API_ORIGIN })).pipe(
  Layer.provide(FetchHttpClient.layer),
);

/** A client of a loopback fake (`origin` without the path); tests only. */
export const layerTest = (origin: string) =>
  Layer.effect(SlackWebApi, make({ origin: `${origin}/api/`, allowLoopback: true })).pipe(
    Layer.provide(FetchHttpClient.layer),
  );
