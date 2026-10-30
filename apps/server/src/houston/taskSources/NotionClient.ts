// The Notion API client: HTTPS to api.notion.com only, no redirects, bounded responses and one
// bounded wait on a rate limit. The token is borrowed per call and sent only as the bearer.
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";
import { collectUint8StreamText } from "@t3tools/provider-core/server/collectStreamText";

import {
  NOTION_API_VERSION,
  NOTION_MAX_PAGES,
  NOTION_MAX_RESPONSE_BYTES,
  NOTION_MAX_RETRY_AFTER_SECONDS,
  checkNotionSchema,
  notionPollEnd,
  notionPollStart,
  notionProject,
  notionQueryBody,
  notionRecord,
  notionRelatedIds,
  type NotionCursor,
  type NotionTaskSchema,
  type RemoteRecord,
  type StoredSettings,
} from "./rules.ts";

export const NOTION_ORIGIN = "https://api.notion.com";
const REQUEST_TIMEOUT_MS = 30_000;
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

export class NotionClient extends Context.Service<
  NotionClient,
  {
    readonly request: (
      token: Redacted.Redacted<string>,
      method: "GET" | "POST",
      path: string,
      body?: unknown,
    ) => Effect.Effect<unknown, string>;
  }
>()("houston/houston/taskSources/NotionClient") {}

/** The origin a client may use: api.notion.com over HTTPS, or loopback when a test allows it. */
export const checkOrigin = (origin: string, allowLoopback: boolean): string | null => {
  const url = URL.parse(origin);
  if (url === null) return `Notion API origin ${JSON.stringify(origin)} is not a URL`;
  if (url.protocol === "https:" && url.host === "api.notion.com") return null;
  if (allowLoopback && url.protocol === "http:" && LOOPBACK.has(url.hostname)) return null;
  return `the Notion API origin must be ${NOTION_ORIGIN}, not ${JSON.stringify(origin)}`;
};

const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));

export const make = Effect.fn("HoustonTaskSources.makeNotionClient")(function* (options: {
  readonly origin: string;
  readonly allowLoopback?: boolean;
}) {
  const http = yield* HttpClient.HttpClient;
  const refused = checkOrigin(options.origin, options.allowLoopback === true);
  const base = options.origin.replace(/\/+$/, "");

  const once = Effect.fnUntraced(function* (
    token: Redacted.Redacted<string>,
    method: "GET" | "POST",
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
    const collected = yield* collectUint8StreamText({
      stream: response.stream,
      maxBytes: NOTION_MAX_RESPONSE_BYTES,
    }).pipe(
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

  const request: NotionClient["Service"]["request"] = Effect.fn("NotionClient.request")(function* (
    token: Redacted.Redacted<string>,
    method: "GET" | "POST",
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

  return NotionClient.of({ request });
});

export const layer = Layer.effect(NotionClient, make({ origin: NOTION_ORIGIN })).pipe(
  Layer.provide(FetchHttpClient.layer),
);

/** A client of a loopback fake; tests only. */
export const layerTest = (origin: string) =>
  Layer.effect(NotionClient, make({ origin, allowLoopback: true })).pipe(
    Layer.provide(FetchHttpClient.layer),
  );

// Reads.

const isObject = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const fetchSchemas = Effect.fn("HoustonTaskSources.fetchNotionSchemas")(function* (
  token: Redacted.Redacted<string>,
  settings: StoredSettings,
) {
  const client = yield* NotionClient;
  const task = yield* client.request(
    token,
    "GET",
    `v1/data_sources/${settings.notionDataSourceId}`,
  );
  const projects =
    settings.notionProjectsDataSourceId === null
      ? null
      : yield* client.request(
          token,
          "GET",
          `v1/data_sources/${settings.notionProjectsDataSourceId}`,
        );
  return { task, projects };
});

/** The settings checked against the live schemas, or the refusal message. */
export const liveSchema = Effect.fn("HoustonTaskSources.liveNotionSchema")(function* (
  token: Redacted.Redacted<string>,
  settings: StoredSettings,
) {
  const schemas = yield* fetchSchemas(token, settings);
  const checked = checkNotionSchema("Notion poll", settings, schemas.task, schemas.projects);
  if ("statusType" in checked) return checked;
  return yield* Effect.fail(checked.message);
});

/** A page's record with its related project, or why the record is skipped. */
const hydrate = Effect.fnUntraced(function* (
  token: Redacted.Redacted<string>,
  page: unknown,
  settings: StoredSettings,
  schema: NotionTaskSchema,
) {
  const client = yield* NotionClient;
  const record = notionRecord(page, settings, schema);
  if (typeof record === "string") return record;
  const relation = settings.notionProjectRelationPropertyId;
  if (relation === null || settings.notionProjectsDataSourceId === null) return record;
  const related = notionRelatedIds(page, relation)[0];
  if (related === undefined) return record;
  const projectPage = yield* client.request(token, "GET", `v1/pages/${related}`);
  const project = notionProject(projectPage, settings);
  if (typeof project === "string") return `${record.externalId}: ${project}`;
  return { ...record, project } satisfies RemoteRecord;
});

export interface NotionPoll {
  readonly records: ReadonlyArray<RemoteRecord>;
  readonly skipped: ReadonlyArray<string>;
  readonly cursor: NotionCursor;
  readonly complete: boolean;
  readonly schema: NotionTaskSchema;
}

/** One bounded batch of the configured query; the checkpoint moves only when it ran out. */
export const pollNotion = Effect.fn("HoustonTaskSources.pollNotion")(function* (
  token: Redacted.Redacted<string>,
  settings: StoredSettings,
  cursor: NotionCursor,
  now: string,
) {
  const client = yield* NotionClient;
  const schema = yield* liveSchema(token, settings);
  const start = notionPollStart(cursor, now);
  const records: Array<RemoteRecord> = [];
  const skipped: Array<string> = [];
  let next: string | null = start.queryCursor;
  for (let page = 0; page < NOTION_MAX_PAGES; page += 1) {
    const result = yield* client.request(
      token,
      "POST",
      `v1/data_sources/${settings.notionDataSourceId}/query`,
      notionQueryBody(settings, schema, start.since, next),
    );
    if (!isObject(result) || result.object !== "list" || !Array.isArray(result.results)) {
      return yield* Effect.fail("the Notion data source query did not answer a result list");
    }
    for (const entry of result.results) {
      const record = yield* hydrate(token, entry, settings, schema);
      if (typeof record === "string") skipped.push(record);
      else records.push(record);
    }
    if (result.has_more !== true) {
      next = null;
      break;
    }
    if (typeof result.next_cursor !== "string") {
      return yield* Effect.fail("Notion indicated another page without a next cursor");
    }
    next = result.next_cursor;
  }
  return {
    records,
    skipped,
    cursor: notionPollEnd(cursor, start, next),
    complete: next === null,
    schema,
  } satisfies NotionPoll;
});

/** One linked page, read whatever the query filter says. */
export const retrievePage = Effect.fn("HoustonTaskSources.retrieveNotionPage")(function* (
  token: Redacted.Redacted<string>,
  settings: StoredSettings,
  schema: NotionTaskSchema,
  pageId: string,
) {
  const client = yield* NotionClient;
  const page = yield* client.request(token, "GET", `v1/pages/${pageId}`);
  return yield* hydrate(token, page, settings, schema);
});
