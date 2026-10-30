// The Notion client and its reads against a loopback fake of api.notion.com.
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { FetchHttpClient } from "effect/http";
import * as Redacted from "effect/Redacted";

import * as NotionClient from "./NotionClient.ts";
import { storedSettings, type NotionCursor } from "./rules.ts";
import {
  NOTION_PROJECTS,
  NOTION_SOURCE,
  NOTION_USER,
  makeNotionFake,
  notionPage,
  notionSchema,
  notionServes,
  notionSettings,
  pageId,
  type NotionFake,
} from "./taskSources.testkit.ts";

const TOKEN = Redacted.make("ntn_client_test_token_77c2");
const NOW = "2026-10-20T00:00:00.000Z";
const START: NotionCursor = { lastEditedTime: "2026-10-01T00:00:00.000Z", continuation: null };

/** The failure message of a request expected to fail. */
const failureText = <A>(effect: Effect.Effect<A, string>) =>
  effect.pipe(Effect.match({ onFailure: (message) => message, onSuccess: () => "no failure" }));

const withClient = <A, E>(
  body: (fake: NotionFake) => Effect.Effect<A, E, NotionClient.NotionClient>,
) =>
  Effect.gen(function* () {
    const fake = yield* makeNotionFake;
    return yield* body(fake).pipe(Effect.provide(NotionClient.layerTest(fake.origin)));
  }).pipe(Effect.scoped);

describe("the query filters by edit time, assignee and active status", () => {
  it.effect("the query filters by edit time, assignee and active status", () =>
    withClient((fake) =>
      Effect.gen(function* () {
        notionServes(fake, () => [notionPage(1)]);
        const settings = storedSettings(notionSettings());
        const polled = yield* NotionClient.pollNotion(TOKEN, settings, START, NOW);
        assert.strictEqual(polled.records.length, 1);
        const query = fake.requests.find((request) => request.method === "POST");
        assert.strictEqual(query?.path, `/v1/data_sources/${NOTION_SOURCE}/query`);
        assert.isTrue(fake.requests.every((request) => request.notionVersion === "2026-03-11"));
        assert.deepEqual(query?.body, {
          filter: {
            and: [
              {
                timestamp: "last_edited_time",
                last_edited_time: { on_or_after: START.lastEditedTime },
              },
              { property: "a%2Fb", people: { contains: NOTION_USER } },
              {
                or: [
                  { property: "St%3Aa", status: { equals: "Ready" } },
                  { property: "St%3Aa", status: { equals: "Doing" } },
                ],
              },
            ],
          },
          sorts: [{ timestamp: "last_edited_time", direction: "ascending" }],
          page_size: 100,
        });
        // One active status is sent without the `or`.
        fake.requests.length = 0;
        yield* NotionClient.pollNotion(
          TOKEN,
          storedSettings(notionSettings({ notionActiveStatusValues: ["Ready"] })),
          START,
          NOW,
        );
        const single = fake.requests.find((request) => request.method === "POST")?.body as {
          filter: { and: Array<unknown> };
        };
        assert.deepEqual(single.filter.and[2], { property: "St%3Aa", status: { equals: "Ready" } });
      }),
    ),
  );
});

describe("a long result continues on the next poll", () => {
  it.effect("a long result continues on the next poll", () =>
    withClient((fake) =>
      Effect.gen(function* () {
        const settings = storedSettings(notionSettings());
        const pages = Array.from({ length: 6 }, (_, index) => notionPage(index + 1));
        notionServes(fake, () => pages, { pageSize: 1 });
        const first = yield* NotionClient.pollNotion(TOKEN, settings, START, NOW);
        assert.strictEqual(first.records.length, 5);
        assert.isFalse(first.complete);
        assert.strictEqual(first.cursor.lastEditedTime, START.lastEditedTime);
        assert.deepEqual(first.cursor.continuation, {
          since: START.lastEditedTime,
          startedAt: NOW,
          queryCursor: "5",
        });
        const second = yield* NotionClient.pollNotion(
          TOKEN,
          settings,
          first.cursor,
          "2026-10-21T00:00:00.000Z",
        );
        assert.deepEqual(
          second.records.map((record) => record.externalId),
          [pageId(6)],
        );
        assert.deepEqual(second.cursor, { lastEditedTime: NOW, continuation: null });

        const three = Array.from({ length: 3 }, (_, index) => notionPage(index + 1));
        notionServes(fake, () => three, { pageSize: 1 });
        const short = yield* NotionClient.pollNotion(TOKEN, settings, START, NOW);
        assert.isTrue(short.complete);
        assert.strictEqual(short.records.length, 3);
        assert.deepEqual(short.cursor, { lastEditedTime: NOW, continuation: null });
      }),
    ),
  );
});

describe("the notion client is bounded to its origin, size and wait", () => {
  it.live("the notion client is bounded to its origin, size and wait", () =>
    withClient((fake) =>
      Effect.gen(function* () {
        const client = yield* NotionClient.NotionClient;
        // Another origin is refused before any request, loopback only where a test allows it.
        for (const [origin, loopback] of [
          ["http://api.notion.com", false],
          ["https://api.notion.com.evil.example", false],
          ["https://evil.example", false],
          [fake.origin, false],
        ] as const) {
          assert.isNotNull(NotionClient.checkOrigin(origin, loopback), origin);
        }
        assert.isNull(NotionClient.checkOrigin("https://api.notion.com", false));
        assert.isNull(NotionClient.checkOrigin(fake.origin, true));
        const strict = yield* NotionClient.make({ origin: fake.origin, allowLoopback: false }).pipe(
          Effect.provide(FetchHttpClient.layer),
        );
        const refused = yield* failureText(strict.request(TOKEN, "GET", "v1/users/me"));
        assert.include(refused, "https://api.notion.com");
        assert.deepEqual(fake.requests, []);

        let calls = 0;
        fake.respond = (request) => {
          calls += 1;
          switch (request.path) {
            case "/redirect":
              return { status: 302, headers: { location: "https://evil.example/steal" } };
            case "/big":
              return { raw: `"${"x".repeat(1_048_576 - 1)}"` };
            case "/wait-2":
              return calls === 1
                ? { status: 429, headers: { "retry-after": "2" } }
                : { body: { ok: true } };
            case "/wait-31":
              return { status: 429, headers: { "retry-after": "31" } };
            case "/twice":
              return { status: 429, headers: { "retry-after": "0" } };
            default:
              return { status: 404, body: {} };
          }
        };
        const redirect = yield* failureText(client.request(TOKEN, "GET", "redirect"));
        assert.include(redirect, "302");
        assert.include(redirect, "not followed");
        assert.strictEqual(calls, 1);

        const big = yield* failureText(client.request(TOKEN, "GET", "big"));
        assert.include(big, "1048576-byte limit");

        calls = 0;
        assert.deepEqual(yield* client.request(TOKEN, "GET", "wait-2"), { ok: true });
        assert.strictEqual(calls, 2);

        const long = yield* failureText(client.request(TOKEN, "GET", "wait-31"));
        assert.include(long, "31");
        assert.include(long, "30");

        calls = 0;
        const twice = yield* failureText(client.request(TOKEN, "GET", "twice"));
        assert.include(twice, "again");
        assert.strictEqual(calls, 2);
        for (const message of [redirect, big, long, twice]) {
          assert.notInclude(message, Redacted.value(TOKEN));
        }
      }),
    ),
  );
});

describe("a related page of another data source is skipped", () => {
  it.effect("a related page of another data source is skipped", () =>
    withClient((fake) =>
      Effect.gen(function* () {
        const settings = storedSettings(
          notionSettings({
            notionProjectsDataSourceId: NOTION_PROJECTS,
            notionProjectRelationPropertyId: "rel",
            notionProjectTitlePropertyId: "ptitle",
          }),
        );
        const related = (n: number, source: string) => ({
          object: "page",
          id: pageId(n),
          url: `https://www.notion.so/project-${n}`,
          parent: { type: "data_source_id", data_source_id: source },
          properties: {
            Name: { id: "ptitle", type: "title", title: [{ plain_text: `Project ${n}` }] },
          },
        });
        const withRelation = (n: number, target: number) => {
          const page = notionPage(n);
          return {
            ...page,
            properties: {
              ...page.properties,
              Project: { id: "rel", type: "relation", relation: [{ id: pageId(target) }] },
            },
          };
        };
        const pages = [withRelation(1, 101), withRelation(2, 102), notionPage(3)];
        notionServes(fake, () => pages as never, {
          extra: (request) => {
            if (request.path === `/v1/data_sources/${NOTION_SOURCE}`) {
              return {
                body: notionSchema(NOTION_SOURCE, {
                  Project: {
                    id: "rel",
                    name: "Project",
                    type: "relation",
                    relation: { data_source_id: NOTION_PROJECTS },
                  },
                }),
              };
            }
            if (request.path === `/v1/data_sources/${NOTION_PROJECTS}`) {
              return {
                body: notionSchema(NOTION_PROJECTS, {
                  Name: { id: "ptitle", name: "Name", type: "title", title: {} },
                }),
              };
            }
            if (request.path === `/v1/pages/${pageId(101)}`)
              return { body: related(101, NOTION_PROJECTS) };
            if (request.path === `/v1/pages/${pageId(102)}`)
              return { body: related(102, NOTION_SOURCE) };
            return null;
          },
        });
        const polled = yield* NotionClient.pollNotion(TOKEN, settings, START, NOW);
        assert.deepEqual(
          polled.records.map((record) => [record.externalId, record.project?.externalId ?? null]),
          [
            [pageId(1), `notion:${NOTION_PROJECTS}:${pageId(101)}`],
            [pageId(3), null],
          ],
        );
        assert.lengthOf(polled.skipped, 1);
        assert.include(polled.skipped[0], pageId(2));
        assert.include(polled.skipped[0], pageId(102));
      }),
    ),
  );
});
