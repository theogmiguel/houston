/**
 * The Notion API client: HTTPS to api.notion.com only, no redirects, a bounded answer and one
 * bounded wait on a rate limit. The token is borrowed per call and sent only as the bearer.
 */
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { FetchHttpClient, HttpClient, HttpClientError, HttpClientRequest } from "effect/http";

export const NOTION_API_VERSION = "2026-03-11";
export const NOTION_MAX_RESPONSE_BYTES = 1_048_576;
export const NOTION_MAX_RETRY_AFTER_SECONDS = 30;
export const NOTION_ORIGIN = "https://api.notion.com";

type NotionMethod = "GET" | "POST" | "PATCH";

const REQUEST_TIMEOUT_MS = 30_000;
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);
const TRAILING_SLASHES = /\/+$/;

export class NotionApi extends Context.Service<
  NotionApi,
  {
    readonly request: (
      token: Redacted.Redacted<string>,
      method: NotionMethod,
      path: string,
      body?: unknown,
    ) => Effect.Effect<unknown, string>;
  }
>()("@houston-app/issue-tracker-notion/server/NotionApi") {}

/** The origin a client may use: api.notion.com over HTTPS, or loopback when a test allows it. */
export const checkOrigin = (origin: string, allowLoopback: boolean): string | null => {
  const url = URL.parse(origin);
  if (url === null) return `Notion API origin ${JSON.stringify(origin)} is not a URL`;
  if (url.protocol === "https:" && url.host === "api.notion.com") return null;
  if (allowLoopback && url.protocol === "http:" && LOOPBACK.has(url.hostname)) return null;
  return `the Notion API origin must be ${NOTION_ORIGIN}, not ${JSON.stringify(origin)}`;
};

const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));

export const make = Effect.fn("NotionApi.make")(function* (options: {
  readonly origin: string;
  readonly allowLoopback?: boolean;
}) {
  const http = yield* HttpClient.HttpClient;
  const refused = checkOrigin(options.origin, options.allowLoopback === true);
  const base = options.origin.replace(TRAILING_SLASHES, "");

  const read = Effect.fnUntraced(function* (
    stream: Stream.Stream<Uint8Array, HttpClientError.HttpClientError>,
  ) {
    const chunks: Array<Uint8Array> = [];
    let total = 0;
    let truncated = false;
    yield* Stream.runForEach(stream, (chunk) =>
      Effect.sync(() => {
        if (truncated) return;
        total += chunk.byteLength;
        if (total > NOTION_MAX_RESPONSE_BYTES) {
          truncated = true;
          return;
        }
        chunks.push(chunk);
      }),
    );
    const bytes = new Uint8Array(Math.min(total, NOTION_MAX_RESPONSE_BYTES));
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return { text: new TextDecoder().decode(bytes), truncated };
  });

  const once = Effect.fnUntraced(function* (
    token: Redacted.Redacted<string>,
    method: NotionMethod,
    path: string,
    body: unknown,
  ) {
    const plain = HttpClientRequest.make(method)(`${base}/${path}`).pipe(
      HttpClientRequest.bearerToken(Redacted.value(token)),
      HttpClientRequest.setHeader("notion-version", NOTION_API_VERSION),
    );
    const request = body === undefined ? plain : plain.pipe(HttpClientRequest.bodyJsonUnsafe(body));
    // Only messages written here leave: a transport error is named by its kind, never its URL.
    const response = yield* http.execute(request).pipe(
      Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
      Effect.provideService(HttpClient.TracerDisabledWhen, () => true),
      Effect.mapError((error) => `Notion request to ${path} failed: ${error.reason._tag}`),
    );
    if (response.status === 429) {
      return { status: 429, retryAfter: response.headers["retry-after"] ?? null, text: "" };
    }
    if (response.status >= 300 && response.status < 400) {
      return yield* Effect.fail(
        `Notion answered ${path} with a redirect (HTTP ${response.status}), which is not followed`,
      );
    }
    const collected = yield* read(response.stream).pipe(
      Effect.mapError(
        (error) => `Notion's answer to ${path} could not be read: ${error.reason._tag}`,
      ),
    );
    if (collected.truncated) {
      return yield* Effect.fail(
        `Notion's HTTP ${response.status} answer to ${path} exceeded the ${NOTION_MAX_RESPONSE_BYTES}-byte limit`,
      );
    }
    if (response.status < 200 || response.status >= 300) {
      return yield* Effect.fail(`Notion request to ${path} failed with HTTP ${response.status}`);
    }
    return { status: response.status, retryAfter: null, text: collected.text };
  });

  const request: NotionApi["Service"]["request"] = Effect.fn("NotionApi.request")(function* (
    token: Redacted.Redacted<string>,
    method: NotionMethod,
    path: string,
    body?: unknown,
  ): Effect.fn.Return<unknown, string> {
    if (refused !== null) return yield* Effect.fail(refused);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const answer = yield* once(token, method, path, body).pipe(
        Effect.timeoutOrElse({
          duration: Duration.millis(REQUEST_TIMEOUT_MS),
          orElse: () =>
            Effect.fail(
              `Notion request to ${path} had no answer within ${REQUEST_TIMEOUT_MS / 1000} seconds`,
            ),
        }),
      );
      if (answer.status !== 429) {
        return yield* decodeJson(answer.text).pipe(
          Effect.mapError(() => `Notion answered ${path} with invalid JSON`),
        );
      }
      if (attempt === 1) {
        return yield* Effect.fail(`Notion rate-limited ${path} again after one wait`);
      }
      const seconds = Number(answer.retryAfter ?? "1");
      const wait = Number.isFinite(seconds) && seconds >= 0 ? seconds : 1;
      if (wait > NOTION_MAX_RETRY_AFTER_SECONDS) {
        return yield* Effect.fail(
          `Notion rate limit asks for a ${wait}-second wait; the limit is ${NOTION_MAX_RETRY_AFTER_SECONDS} seconds`,
        );
      }
      yield* Effect.sleep(Duration.seconds(wait));
    }
    return yield* Effect.fail(`Notion rate-limited ${path}`);
  });

  return NotionApi.of({ request });
});

export const layer = Layer.effect(NotionApi, make({ origin: NOTION_ORIGIN })).pipe(
  Layer.provide(FetchHttpClient.layer),
);

/** A client of a loopback fake; tests only. */
export const layerTest = (origin: string) =>
  Layer.effect(NotionApi, make({ origin, allowLoopback: true })).pipe(
    Layer.provide(FetchHttpClient.layer),
  );
