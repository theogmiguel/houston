// @effect-diagnostics nodeBuiltinImport:off - serves the loopback Notion fake.
// Task sources over one database with the real project service, the memory keychain, upstream's
// GitHub client answered by an in-process fake of api.github.com, and a loopback Notion fake.
import * as NodeHttp from "node:http";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as SourceControlRateLimit from "@t3tools/source-control-core/server/SourceControlRateLimit";
import * as GitHubAppSignIn from "@t3tools/source-control-github/server/GitHubAppSignIn";
import * as GitHubCredentials from "@t3tools/source-control-github/server/GitHubCredentials";
import * as GitHubQuota from "@t3tools/source-control-github/server/GitHubQuota";
import * as GitHubRest from "@t3tools/source-control-github/server/GitHubRest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { HttpClient, HttpClientResponse } from "effect/http";

import * as ServerConfig from "../../config.ts";
import * as ProjectStore from "../../orchestration-v2/ProjectStore.ts";
import * as RuntimeLayer from "../../orchestration-v2/runtimeLayer.ts";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import * as ProjectEnrichmentService from "../../project/ProjectEnrichmentService.ts";
import * as ServerSettings from "../../serverSettings.ts";
import { HostedLaunch } from "../baseDir.ts";
import { layerMemory, makeMemory, type MemoryKeychain } from "../secrets/HoustonKeychain.ts";
import * as HoustonTaskService from "../tasks/TaskService.ts";
import * as HoustonTaskStore from "../tasks/TaskStore.ts";
import * as HoustonTaskV1Import from "../tasks/V1Import.ts";
import {
  CONFIGURED_INSTANCES,
  layerInstances,
  layerProjectMetadata,
  layerWorkspacePaths,
} from "../tasks/tasks.testkit.ts";
import { layerTaskSources } from "./layer.ts";
import * as NotionClient from "./NotionClient.ts";
import * as HoustonTaskSourceOutbox from "./Outbox.ts";
import * as HoustonTaskSourceStore from "./SourceStore.ts";

/** The token GitHubCredentials hands out in tests, as a Settings token would be. */
export const GITHUB_SETTINGS_TOKEN = "ghp_settings_token_for_tests";

export interface GithubFakeRequest {
  readonly method: string;
  readonly url: string;
  readonly authorization: string | undefined;
  readonly ifNoneMatch: string | undefined;
  /** The JSON body of a write. */
  readonly body: unknown;
}

/** Answers requests to https://api.github.com in process; `"stall"` never answers. */
export interface GithubFake {
  readonly requests: Array<GithubFakeRequest>;
  respond: (url: URL, request: GithubFakeRequest) => Response | "stall";
}

export const makeGithubFake = (): GithubFake => ({
  requests: [],
  respond: () => new Response("[]", { status: 200, headers: { etag: '"empty"' } }),
});

const appSignedOut = Layer.mock(GitHubAppSignIn.GitHubAppSignIn)({
  enabled: false,
  token: () => Effect.succeedNone,
  invalidate: () => Effect.void,
});

/** Upstream's GitHub client with a Settings credential, answered by `fake`. */
export const layerGitHubFake = (fake: GithubFake) => {
  const credentials = Layer.succeed(
    GitHubCredentials.GitHubCredentials,
    GitHubCredentials.GitHubCredentials.of({
      get: (host) =>
        Effect.succeed({
          host,
          token: Redacted.make(GITHUB_SETTINGS_TOKEN),
          source: "settings" as const,
          fingerprint: `${host}:settings`,
        }),
      saved: () => Effect.succeedNone,
      fingerprint: (host, token) => Effect.succeed(`${host}:${token.length}`),
      invalidate: () => Effect.void,
    }),
  );
  const http = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) => {
      const entry: GithubFakeRequest = {
        method: request.method,
        url: request.url,
        authorization: request.headers.authorization,
        ifNoneMatch: request.headers["if-none-match"],
        body:
          request.body._tag === "Uint8Array"
            ? (JSON.parse(new TextDecoder().decode(request.body.body)) as unknown)
            : undefined,
      };
      fake.requests.push(entry);
      const answer = fake.respond(new URL(request.url), entry);
      return answer === "stall"
        ? Effect.never
        : Effect.succeed(HttpClientResponse.fromWeb(request, answer));
    }),
  );
  return GitHubRest.layer.pipe(
    Layer.provide(Layer.mergeAll(credentials, http, appSignedOut)),
    Layer.provideMerge(GitHubQuota.layer),
    Layer.provideMerge(SourceControlRateLimit.layer),
  );
};

/** Serves `issues` as GitHub's paged list; a page's ETag changes with its content. */
export const issuePages = (fake: GithubFake, issues: () => ReadonlyArray<unknown>) => {
  fake.respond = (url) => {
    const page = Number(url.searchParams.get("page") ?? "1");
    const items = issues().slice((page - 1) * 100, page * 100);
    const etag = `"p${page}-${JSON.stringify(items).length}-${String(
      items
        .map((item) => JSON.stringify(item))
        .join("")
        .split("")
        .reduce((hash, char) => (hash * 31 + char.charCodeAt(0)) | 0, 7),
    )}"`;
    return new Response(JSON.stringify(items), {
      status: 200,
      headers: { "content-type": "application/json", etag },
    });
  };
};

export const githubIssue = (number: number, patch: Record<string, unknown> = {}) => ({
  number,
  html_url: `https://github.com/octo-org/project/issues/${number}`,
  title: `Issue ${number}`,
  body: `Body ${number}`,
  state: "open",
  updated_at: "2026-10-01T00:00:00Z",
  labels: [{ name: "import" }],
  assignee: null,
  assignees: [],
  milestone: null,
  ...patch,
});

// The loopback Notion fake.

export interface NotionFakeRequest {
  readonly method: string;
  readonly path: string;
  readonly authorization: string | undefined;
  readonly notionVersion: string | undefined;
  readonly body: unknown;
}

export interface NotionFakeAnswer {
  readonly status?: number;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: unknown;
  /** Raw bytes instead of JSON. */
  readonly raw?: string;
}

export interface NotionFake {
  readonly origin: string;
  readonly requests: Array<NotionFakeRequest>;
  respond: (request: NotionFakeRequest) => NotionFakeAnswer;
}

/** A Notion API on 127.0.0.1 for the scope's lifetime. */
export const makeNotionFake = Effect.acquireRelease(
  Effect.callback<{ readonly fake: NotionFake; readonly server: NodeHttp.Server }>((resume) => {
    const fake = {
      origin: "",
      requests: [] as Array<NotionFakeRequest>,
      respond: (_request: NotionFakeRequest): NotionFakeAnswer => ({ status: 404, body: {} }),
    };
    const server = NodeHttp.createServer((request, response) => {
      const chunks: Array<Buffer> = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        const entry: NotionFakeRequest = {
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
).pipe(Effect.map(({ fake }) => fake as NotionFake));

export interface SourcesTestOptions {
  readonly databaseFile?: string;
  readonly baseDir?: string;
  readonly hosted?: boolean;
  readonly keychain?: MemoryKeychain;
  readonly github?: GithubFake;
  /** The loopback Notion fake's origin; requests fail to connect when absent. */
  readonly notionOrigin?: string;
}

/** Tasks and task sources as the server assembles them, with the test seams. */
export const layerSources = (options: SourcesTestOptions = {}) =>
  layerTaskSources(
    Layer.mergeAll(
      layerGitHubFake(options.github ?? makeGithubFake()),
      NotionClient.layerTest(options.notionOrigin ?? "http://127.0.0.1:9"),
    ),
  ).pipe(
    Layer.provideMerge(Layer.mergeAll(HoustonTaskService.layer, HoustonTaskV1Import.layer)),
    Layer.provideMerge(RuntimeLayer.layerProjectService),
    Layer.provideMerge(ProjectStore.layer),
    // Below the project service, so a project deletion reaches it, as in server.ts.
    Layer.provideMerge(HoustonTaskSourceStore.layer),
    Layer.provideMerge(layerMemory(options.keychain ?? makeMemory())),
    Layer.provideMerge(HoustonTaskStore.layer),
    // Below the Tasks store, which hands it every write's transitions, as in server.ts.
    Layer.provideMerge(HoustonTaskSourceOutbox.layer),
    Layer.provideMerge(layerInstances(CONFIGURED_INSTANCES)),
    Layer.provideMerge(ProjectEnrichmentService.layer),
    Layer.provideMerge(layerWorkspacePaths),
    Layer.provideMerge(layerProjectMetadata),
    Layer.provideMerge(
      options.databaseFile === undefined
        ? Layer.fresh(SqlitePersistence.layerMemory)
        : Layer.fresh(SqlitePersistence.layerFromPath(options.databaseFile)),
    ),
    Layer.provideMerge(ServerSettings.layerTest()),
    Layer.provideMerge(
      ServerConfig.layerTest(process.cwd(), options.baseDir ?? { prefix: "houston-sources-test-" }),
    ),
    Layer.provideMerge(NodeServices.layer),
    Layer.provideMerge(
      Layer.succeed(HostedLaunch, options.hosted ?? options.baseDir !== undefined),
    ),
  );

export const NOTION_SOURCE = "0123456789abcdef0123456789abcdef";
export const NOTION_PROJECTS = "fedcba9876543210fedcba9876543210";
export const NOTION_USER = "11111111-2222-3333-4444-555555555555";

/** A Notion data source schema with the properties the default settings name. */
export const notionSchema = (id: string, patch: Record<string, unknown> = {}) => ({
  object: "data_source",
  id,
  properties: {
    Name: { id: "title", name: "Name", type: "title", title: {} },
    Description: { id: "desc", name: "Description", type: "rich_text", rich_text: {} },
    Status: {
      id: "St%3Aa",
      name: "Status",
      type: "status",
      status: { options: [{ name: "Ready" }, { name: "Doing" }, { name: "Shipped" }] },
    },
    Assignee: { id: "a%2Fb", name: "Assignee", type: "people", people: {} },
    ...patch,
  },
});

export const notionSettings = (patch: Record<string, unknown> = {}) => ({
  enabled: true,
  notionDataSourceId: NOTION_SOURCE,
  notionTitlePropertyId: "title",
  notionDescriptionPropertyId: "desc",
  notionStatusPropertyId: "St%3Aa",
  notionAssigneePropertyId: "a%2Fb",
  notionAssigneeUserId: NOTION_USER,
  notionActiveStatusValues: ["Ready", "Doing"],
  notionStatusMapping: {
    todo: "Ready",
    inProgress: "Doing",
    inReview: null,
    done: "Shipped",
    canceled: null,
  },
  ...patch,
});

/** A Notion page id: 8-4-4-4-12 hex from a number. */
export const pageId = (n: number) => {
  const hex = n.toString(16).padStart(32, "0");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

export const notionPage = (n: number, patch: Record<string, unknown> = {}) => ({
  object: "page",
  id: pageId(n),
  url: `https://www.notion.so/page-${n}`,
  last_edited_time: "2026-10-01T00:00:00.000Z",
  parent: { type: "data_source_id", data_source_id: NOTION_SOURCE },
  properties: {
    Name: { id: "title", type: "title", title: [{ plain_text: `Page ${n}` }] },
    Description: { id: "desc", type: "rich_text", rich_text: [{ plain_text: `About ${n}` }] },
    Status: { id: "St%3Aa", type: "status", status: { name: "Ready" } },
    Assignee: { id: "a%2Fb", type: "people", people: [{ id: NOTION_USER }] },
  },
  ...patch,
});

/** Answers schema reads, queries from `pages` and page reads; `pageSize` cuts query pages. */
export const notionServes = (
  fake: NotionFake,
  pages: () => ReadonlyArray<ReturnType<typeof notionPage>>,
  options: {
    readonly pageSize?: number;
    readonly extra?: (request: NotionFakeRequest) => NotionFakeAnswer | null;
  } = {},
) => {
  fake.respond = (request) => {
    const extra = options.extra?.(request);
    if (extra !== null && extra !== undefined) return extra;
    if (request.method === "GET" && request.path === `/v1/data_sources/${NOTION_SOURCE}`) {
      return { body: notionSchema(NOTION_SOURCE) };
    }
    if (request.method === "POST" && request.path === `/v1/data_sources/${NOTION_SOURCE}/query`) {
      const size = options.pageSize ?? 100;
      const start = Number((request.body as { start_cursor?: string }).start_cursor ?? "0");
      const all = pages();
      const slice = all.slice(start, start + size);
      const more = start + size < all.length;
      return {
        body: {
          object: "list",
          results: slice,
          has_more: more,
          next_cursor: more ? String(start + size) : null,
        },
      };
    }
    const match = /^\/v1\/pages\/(.+)$/.exec(request.path);
    if (request.method === "GET" && match !== null) {
      const page = pages().find((entry) => entry.id === match[1]);
      return page === undefined ? { status: 404, body: {} } : { body: page };
    }
    return { status: 404, body: { object: "error" } };
  };
};
