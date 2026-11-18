// The Notion tracker against a loopback fake of api.notion.com, never the real service.
// @effect-diagnostics nodeBuiltinImport:off - serves the loopback fake.
import * as NodeHttp from "node:http";

import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as IssueTrackerHost from "@houston-app/source-control-core/server/IssueTrackerHost";
import type { StandaloneIssueTrackerApi } from "@houston-app/source-control-core/server/IssueTracker";

import * as NotionApi from "./NotionApi.ts";
import * as NotionIssueTracker from "./NotionIssueTracker.ts";

interface FakeRequest {
  readonly method: string;
  readonly path: string;
  readonly authorization: string | undefined;
  readonly notionVersion: string | undefined;
  readonly body: unknown;
}

interface FakeAnswer {
  readonly status?: number;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: unknown;
  readonly raw?: string;
}

interface Fake {
  origin: string;
  readonly requests: Array<FakeRequest>;
  respond: (request: FakeRequest) => FakeAnswer;
}

const fakeServer = Effect.acquireRelease(
  Effect.callback<{ readonly fake: Fake; readonly server: NodeHttp.Server }>((resume) => {
    const fake: Fake = {
      origin: "",
      requests: [],
      respond: () => ({ status: 404, body: {} }),
    };
    const server = NodeHttp.createServer((request, response) => {
      const chunks: Array<Buffer> = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        const entry: FakeRequest = {
          method: request.method ?? "GET",
          path: request.url ?? "/",
          authorization: request.headers.authorization,
          notionVersion: request.headers["notion-version"] as string | undefined,
          body: text.length === 0 ? undefined : (JSON.parse(text) as unknown),
        };
        fake.requests.push(entry);
        const answer = fake.respond(entry);
        response.writeHead(answer.status ?? 200, {
          "content-type": "application/json",
          ...answer.headers,
        });
        response.end(answer.raw ?? JSON.stringify(answer.body ?? {}));
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      fake.origin =
        typeof address === "object" && address !== null ? `http://127.0.0.1:${address.port}` : "";
      resume(Effect.succeed({ fake, server }));
    });
  }),
  ({ server }) =>
    Effect.callback<void>((resume) => {
      server.closeAllConnections();
      server.close(() => resume(Effect.void));
    }),
).pipe(Effect.map(({ fake }) => fake));

const SOURCE = "0123456789abcdef0123456789abcdef";
const OTHER = "fedcba9876543210fedcba9876543210";
const TOKEN = "ntn_test_token_24f1";
const USER = "11111111-2222-3333-4444-555555555555";
const BINDING = {
  title: "title",
  status: "status",
  body: "desc",
  assignee: "assignee",
  labels: "labels",
  prUrl: "pr",
} as const;

const pageId = (n: number) => {
  const hex = n.toString(16).padStart(32, "0");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

const schema = (id: string, patch: Record<string, unknown> = {}) => ({
  object: "data_source",
  id,
  properties: {
    Name: { id: "title", name: "Name", type: "title", title: {} },
    Description: { id: "desc", name: "Description", type: "rich_text", rich_text: {} },
    Status: {
      id: "status",
      name: "Status",
      type: "status",
      status: {
        options: [
          { id: "opt-todo", name: "To do", color: "red" },
          { id: "opt-doing", name: "Doing", color: "blue" },
          { id: "opt-done", name: "Done", color: "green" },
        ],
        groups: [
          { id: "group-todo", name: "To-do", option_ids: ["opt-todo"] },
          { id: "group-doing", name: "In progress", option_ids: ["opt-doing"] },
          { id: "group-done", name: "Complete", option_ids: ["opt-done"] },
        ],
      },
    },
    Assignee: { id: "assignee", name: "Assignee", type: "people", people: {} },
    Labels: {
      id: "labels",
      name: "Labels",
      type: "multi_select",
      multi_select: { options: [{ name: "bug", color: "red" }] },
    },
    PR: { id: "pr", name: "PR", type: "url", url: {} },
    ...patch,
  },
});

const page = (n: number, patch: Record<string, unknown> = {}) => ({
  object: "page",
  id: pageId(n),
  url: `https://www.notion.so/Page-${n}-${pageId(n).replaceAll("-", "")}`,
  created_time: "2026-10-01T00:00:00.000Z",
  last_edited_time: "2026-10-02T00:00:00.000Z",
  parent: { type: "data_source_id", data_source_id: SOURCE },
  properties: {
    Name: { id: "title", type: "title", title: [{ plain_text: `Page ${n}` }] },
    Description: { id: "desc", type: "rich_text", rich_text: [{ plain_text: `About ${n}` }] },
    Status: { id: "status", type: "status", status: { id: "opt-todo", name: "To do" } },
    Assignee: {
      id: "assignee",
      type: "people",
      people: [{ id: USER, name: "Ada", avatar_url: null }],
    },
    Labels: { id: "labels", type: "multi_select", multi_select: [{ name: "bug", color: "red" }] },
    PR: { id: "pr", type: "url", url: null },
  },
  ...patch,
});

const comments = (values: ReadonlyArray<unknown>) => ({
  object: "list",
  results: values,
  has_more: false,
  next_cursor: null,
});

const block = (id: string, type: string, value: Record<string, unknown>, hasChildren = false) => ({
  object: "block",
  id,
  type,
  has_children: hasChildren,
  [type]: value,
});

/** Answers the schema, query, page, comments and block reads the tracker makes. */
const serve = (fake: Fake) => {
  fake.respond = (request) => {
    if (request.method === "GET" && request.path === "/v1/users/me") {
      return { body: { object: "user", id: USER, name: "Houston" } };
    }
    if (request.method === "POST" && request.path === "/v1/search") {
      return {
        body: {
          object: "list",
          results: [{ object: "data_source", id: SOURCE, title: [{ plain_text: "Tasks" }] }],
        },
      };
    }
    if (request.method === "GET" && request.path === `/v1/data_sources/${SOURCE}`) {
      return { body: schema(SOURCE) };
    }
    if (request.method === "POST" && request.path === `/v1/data_sources/${SOURCE}/query`) {
      return {
        body: {
          object: "list",
          results: [page(1), page(2)],
          has_more: false,
          next_cursor: null,
        },
      };
    }
    if (request.method === "GET" && request.path === `/v1/pages/${pageId(1)}`) {
      return { body: page(1) };
    }
    if (request.method === "GET" && request.path === `/v1/pages/${pageId(2)}`) {
      return { body: page(2) };
    }
    if (
      request.method === "PATCH" &&
      (request.path === `/v1/pages/${pageId(1)}` || request.path === `/v1/pages/${pageId(2)}`)
    ) {
      return {
        body: request.path.endsWith(pageId(2)) ? page(2) : page(1),
      };
    }
    if (request.method === "GET" && request.path.startsWith("/v1/comments?")) {
      return {
        body: comments([
          {
            object: "comment",
            id: "comment-1",
            created_by: { id: USER },
            created_time: "2026-10-03T00:00:00.000Z",
            rich_text: [{ plain_text: "First note" }],
          },
        ]),
      };
    }
    if (request.method === "POST" && request.path === "/v1/comments") {
      return { body: { object: "comment", id: "comment-2" } };
    }
    if (request.method === "POST" && request.path === "/v1/pages") {
      return { body: page(3) };
    }
    if (request.method === "GET" && request.path.startsWith(`/v1/blocks/${pageId(1)}/children`)) {
      return {
        body: {
          object: "list",
          results: [
            block("block-1", "heading_2", { rich_text: [{ plain_text: "Overview" }] }),
            block("block-2", "bulleted_list_item", {
              rich_text: [{ plain_text: "one", annotations: { bold: true } }],
            }),
            block(
              "block-3",
              "paragraph",
              { rich_text: [{ plain_text: "child note" }], has_children: true },
              true,
            ),
          ],
          has_more: false,
          next_cursor: null,
        },
      };
    }
    if (request.method === "GET" && request.path.startsWith("/v1/blocks/block-3/children")) {
      return {
        body: {
          object: "list",
          results: [block("block-4", "paragraph", { rich_text: [{ plain_text: "nested" }] })],
          has_more: false,
          next_cursor: null,
        },
      };
    }
    if (request.method === "PATCH" && request.path.startsWith("/v1/blocks/block-")) {
      return { body: { object: "block" } };
    }
    return { status: 404, body: {} };
  };
};

const withTracker = <A, E>(
  body: (fake: Fake, tracker: NotionIssueTrackerApi) => Effect.Effect<A, E>,
) =>
  Effect.gen(function* () {
    const fake = yield* fakeServer;
    serve(fake);
    const tracker = yield* NotionIssueTracker.make.pipe(
      Effect.provide(
        Layer.mergeAll(
          NotionApi.layerTest(fake.origin),
          Layer.succeed(
            IssueTrackerHost.IssueTrackerHost,
            IssueTrackerHost.IssueTrackerHost.of({
              credentials: {
                get: () => Effect.succeedSome(TOKEN),
              },
            }),
          ),
        ),
      ),
    );
    return yield* body(fake, tracker);
  }).pipe(Effect.scoped);

type NotionIssueTrackerApi = StandaloneIssueTrackerApi;

describe("Notion lists a bound data source's pages", () => {
  it.effect("queries the status group and maps states, people and labels", () =>
    withTracker((fake, tracker) =>
      Effect.gen(function* () {
        const listed = yield* tracker.listIssues({
          cwd: "",
          host: "notion.so",
          scope: SOURCE,
          properties: BINDING,
          state: "open",
          involvement: "all",
          viewer: "Houston",
          limit: 50,
          sort: "updated",
        });
        assert.lengthOf(listed.items, 2);
        assert.deepEqual(listed.items[0]?.state, { category: "open", name: "To do" });
        assert.deepEqual(listed.items[0]?.assignees, [
          { login: USER, name: "Ada", avatarUrl: null },
        ]);
        assert.deepEqual(listed.items[0]?.labels, [{ name: "bug", color: "red" }]);
        assert.strictEqual(listed.items[0]?.key, pageId(1).replaceAll("-", ""));
        const query = fake.requests.find(
          (request) => request.method === "POST" && request.path.endsWith("/query"),
        );
        assert.deepEqual(query?.body, {
          filter: {
            or: [
              { property: "status", status: { equals: "To do" } },
              { property: "status", status: { equals: "Doing" } },
            ],
          },
          sorts: [{ timestamp: "last_edited_time", direction: "descending" }],
          page_size: 50,
        });
        assert.isTrue(fake.requests.every((request) => request.notionVersion === "2026-03-11"));
      }),
    ),
  );

  it.effect("refuses the filters Notion's query API cannot express, naming each", () =>
    withTracker((_fake, tracker) =>
      Effect.gen(function* () {
        const assigned = yield* Effect.flip(
          tracker.listIssues({
            cwd: "",
            host: "notion.so",
            scope: SOURCE,
            properties: BINDING,
            state: "all",
            involvement: "assigned",
            viewer: "Houston",
            limit: 50,
            sort: "updated",
          }),
        );
        assert.include(assigned.detail, "assigned");
        const assignee = yield* Effect.flip(
          tracker.listIssues({
            cwd: "",
            host: "notion.so",
            scope: SOURCE,
            properties: BINDING,
            state: "all",
            involvement: "all",
            viewer: "Houston",
            limit: 50,
            sort: "updated",
            assignee: "ada",
          }),
        );
        assert.include(assignee.detail, "assignee");
        assert.include(assignee.detail, "ada");
      }),
    ),
  );
});

describe("a Notion page reads with its body and comments", () => {
  it.effect("the description, bounded markdown blocks, comments and states", () =>
    withTracker((_fake, tracker) =>
      Effect.gen(function* () {
        const detail = yield* tracker.getIssue({
          cwd: "",
          host: "notion.so",
          scope: SOURCE,
          properties: BINDING,
          key: pageId(1),
        });
        assert.include(detail.body, "About 1");
        assert.include(detail.body, "## Overview");
        assert.include(detail.body, "- **one**");
        assert.include(detail.body, "nested");
        assert.deepEqual(
          detail.states.map((state) => [state.category, state.name]),
          [
            ["open", "To do"],
            ["open", "Doing"],
            ["closed", "Done"],
          ],
        );
        assert.deepEqual(
          detail.comments.map((comment) => comment.body),
          ["First note"],
        );
        assert.strictEqual(detail.viewer, "Houston");
        assert.deepEqual(detail.viewerPermissions, {
          setState: true,
          comment: true,
          edit: true,
          labels: true,
          assignees: true,
        });
      }),
    ),
  );

  it.effect("a page outside the bound data source reads as absent", () =>
    withTracker((fake, tracker) =>
      Effect.gen(function* () {
        fake.respond = (request) =>
          request.path === `/v1/data_sources/${SOURCE}`
            ? { body: schema(SOURCE) }
            : request.path === `/v1/pages/${pageId(4)}`
              ? { body: page(4, { parent: { type: "data_source_id", data_source_id: OTHER } }) }
              : { status: 404, body: {} };
        const missing = yield* Effect.flip(
          tracker.getIssue({
            cwd: "",
            host: "notion.so",
            scope: SOURCE,
            properties: BINDING,
            key: pageId(4),
          }),
        );
        assert.strictEqual(missing.reason, "not-found");
        assert.include(missing.detail, OTHER);
      }),
    ),
  );
});

describe("Notion writes", () => {
  it.effect("creates a page with its labels, people and body", () =>
    withTracker((fake, tracker) =>
      Effect.gen(function* () {
        const created = yield* tracker.create!({
          cwd: "",
          host: "notion.so",
          scope: SOURCE,
          properties: BINDING,
          title: "A new page",
          body: "first line\nsecond line",
          labels: ["bug"],
          assignees: [USER],
        });
        assert.strictEqual(created.key, pageId(3).replaceAll("-", ""));
        const post = fake.requests.find(
          (request) => request.method === "POST" && request.path === "/v1/pages",
        );
        const body = post?.body as {
          parent: { type: string; data_source_id: string };
          properties: Record<string, unknown>;
          children: ReadonlyArray<unknown>;
        };
        assert.deepEqual(body.parent, { type: "data_source_id", data_source_id: SOURCE });
        assert.deepEqual(body.properties["title"], {
          title: [{ type: "text", text: { content: "A new page" } }],
        });
        assert.deepEqual(body.properties["labels"], { multi_select: [{ name: "bug" }] });
        assert.deepEqual(body.properties["assignee"], { people: [{ id: USER }] });
        assert.lengthOf(body.children, 2);
      }),
    ),
  );

  it.effect("comments in chunks, edits the title, moves the state and writes the PR URL", () =>
    withTracker((fake, tracker) =>
      Effect.gen(function* () {
        const target = {
          cwd: "",
          host: "notion.so",
          scope: SOURCE,
          properties: BINDING,
          key: pageId(1),
        };
        yield* tracker.comment!({ ...target, body: "x".repeat(2_001) });
        const comment = fake.requests.find(
          (request) => request.method === "POST" && request.path === "/v1/comments",
        );
        const commentBody = comment?.body;
        assert.isDefined(commentBody);
        assert.lengthOf((commentBody as { rich_text: Array<unknown> }).rich_text, 2);

        yield* tracker.update!({ ...target, title: "Renamed" });
        const rename = fake.requests.find(
          (request) => request.method === "PATCH" && request.path === `/v1/pages/${pageId(1)}`,
        );
        assert.deepEqual(rename?.body, {
          properties: { title: { title: [{ type: "text", text: { content: "Renamed" } }] } },
        });

        yield* tracker.setState!({ ...target, state: "Done" });
        const moved = fake.requests.filter(
          (request) => request.method === "PATCH" && request.path === `/v1/pages/${pageId(1)}`,
        );
        assert.deepEqual(moved.at(-1)?.body, {
          properties: { status: { status: { name: "Done" } } },
        });
        const refused = yield* Effect.flip(tracker.setState!({ ...target, state: "Nope" }));
        assert.include(refused.detail, "Nope");

        yield* tracker.setPullRequestUrl!({
          ...target,
          url: "https://github.com/octo-org/project/pull/4",
        });
        assert.deepEqual(
          fake.requests.filter((request) => request.method === "PATCH").at(-1)?.body,
          { properties: { pr: { url: "https://github.com/octo-org/project/pull/4" } } },
        );
      }),
    ),
  );

  it.effect("the credential probe names the account and the data sources it reaches", () =>
    withTracker((_fake, tracker) =>
      Effect.gen(function* () {
        const probe = yield* tracker.probeCredential(TOKEN);
        assert.strictEqual(probe.account, "Houston");
        assert.deepEqual(probe.scopes, [{ key: SOURCE, name: "Tasks" }]);
      }),
    ),
  );
});

describe("Notion URLs", () => {
  it("recognises page URLs on notion.so and notion.site, and nothing else", () => {
    const key = "0123456789abcdef0123456789abcdef";
    assert.deepEqual(
      NotionIssueTracker.parseNotionIssueUrl(new URL(`https://www.notion.so/Page-1-${key}`)),
      { host: "notion.so", scope: "", key, workspace: "" },
    );
    assert.deepEqual(
      NotionIssueTracker.parseNotionIssueUrl(
        new URL(`https://acme.notion.site/Page-1-${key}?pvs=4`),
      ),
      { host: "notion.so", scope: "", key, workspace: "" },
    );
    assert.isNull(NotionIssueTracker.parseNotionIssueUrl(new URL("https://example.com/" + key)));
    assert.isNull(NotionIssueTracker.parseNotionIssueUrl(new URL("https://notion.so/not-a-page")));
  });
});
