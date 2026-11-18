/**
 * Notion as a standalone issue tracker. A scope is a data source id and an issue key is the
 * id of one of its pages. The status property's options are the states, in the data source's
 * own order; a status group named "Complete" closes a state, as Notion's own board does.
 */
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import {
  IssueTrackerKind,
  type IssueActor,
  type IssueCapabilities,
  type IssueComment,
  type IssueCommentsPage,
  type IssueCreateResult,
  type IssueLabel,
  type IssueState,
  type IssueTrackerProperty,
  type IssueTrackerScope,
  type IssueViewerPermissions,
  type StandaloneIssueTrackerDescriptor,
} from "@houston-app/contracts";
import {
  IssueTrackerError,
  type StandaloneIssueTrackerApi,
  type TrackerIssueDetail,
  type TrackerIssuePage,
  type TrackerIssueSummary,
} from "@houston-app/source-control-core/server/IssueTracker";
import * as IssueTrackerHost from "@houston-app/source-control-core/server/IssueTrackerHost";

import * as NotionApi from "./NotionApi.ts";

export const KIND = IssueTrackerKind.make("notion");
const HOST = "notion.so";
const COMMENTS_PAGE = 100;
const PROPERTIES_PAGE = 100;
const MAX_BODY_BLOCKS = 400;
const MAX_BODY_CHARS = 65_536;
const MAX_BLOCK_DEPTH = 2;
const MAX_BLOCK_PAGES = 3;
const MAX_WRITTEN_BLOCKS = 100;
const MAX_COMMENT_CHUNKS = 100;
const RICH_TEXT_CHARS = 2_000;
const MAX_PR_URL_BYTES = 2_048;
/** A page answer without times reads as the oldest instant rather than the current clock. */
const NOTION_EPOCH = "1970-01-01T00:00:00.000Z";

/** The binding meanings Notion accepts; the UI draws a picker for each listed one. */
const BINDING_PROPERTIES: StandaloneIssueTrackerDescriptor["bindingProperties"] = [
  {
    key: "title",
    label: "Title property",
    required: true,
    types: ["title"],
  },
  {
    key: "status",
    label: "Status property",
    required: true,
    types: ["status", "select"],
  },
  {
    key: "body",
    label: "Description property",
    description: "A rich-text property written with the issue's opening words.",
    required: false,
    types: ["rich_text"],
  },
  {
    key: "assignee",
    label: "Assignee property",
    required: false,
    types: ["people"],
  },
  {
    key: "labels",
    label: "Labels property",
    description: "A select or multi-select property whose options are the issue's labels.",
    required: false,
    types: ["select", "multi_select"],
  },
  {
    key: "prUrl",
    label: "Pull request URL property",
    description: "A URL property that records the task's pull request.",
    required: false,
    types: ["url"],
  },
];

const DESCRIPTOR: StandaloneIssueTrackerDescriptor = {
  tracker: KIND,
  displayName: "Notion",
  host: HOST,
  scopeNoun: "data source",
  credential: {
    label: "Integration token",
    helpUrl: "https://www.notion.so/my-integrations",
  },
  bindingProperties: BINDING_PROPERTIES,
};

/**
 * Notion has no reactions, templates or event history. Its search reads titles only, so the
 * free-text filter is a title `contains`, and a people filter needs a user id rather than a login.
 */
const CAPABILITIES: IssueCapabilities = {
  create: true,
  edit: true,
  comment: true,
  labels: true,
  assignees: true,
  reactions: false,
  templates: false,
  linkedPullRequests: false,
  events: false,
  search: true,
};

const VIEWER_PERMISSIONS: IssueViewerPermissions = {
  setState: true,
  comment: true,
  edit: true,
  labels: true,
  assignees: true,
};

type Json = Readonly<Record<string, unknown>>;

const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown) => (typeof value === "string" ? value : null);
const array = (value: unknown): ReadonlyArray<unknown> => (Array.isArray(value) ? value : []);

const NOTION_ID =
  /^(?:[0-9a-fA-F]{32}|[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$/;

export const isNotionId = (value: string) => NOTION_ID.test(value.trim());

/** Notion accepts a page or data source id with or without dashes; links use the bare form. */
export const canonicalId = (value: string) => value.replaceAll("-", "").toLowerCase();

const sameId = (left: string, right: string) => canonicalId(left) === canonicalId(right);

const cutChars = (value: string, max: number) =>
  [...value].length <= max ? value : [...value].slice(0, max).join("");

const PAGE_IN_URL = /([0-9a-f]{32})$/i;
const PAGE_IN_URL_WITH_DASHES = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

function pageIdFromUrl(url: URL): string | null {
  const segment =
    url.pathname
      .split("/")
      .filter((part) => part.length > 0)
      .at(-1) ?? "";
  const match = PAGE_IN_URL_WITH_DASHES.exec(segment) ?? PAGE_IN_URL.exec(segment);
  return match === null ? null : canonicalId(match[1] as string);
}

const canonicalPageUrl = (id: string) => `https://www.notion.so/${canonicalId(id)}`;

/** A Notion page URL names no data source, so its scope is left for the service to find. */
export function parseNotionIssueUrl(
  url: URL,
): { host: string; scope: string; key: string; workspace: string } | null {
  if (url.protocol !== "https:") return null;
  const host = url.hostname.toLowerCase();
  const notion =
    host === HOST ||
    host === `www.${HOST}` ||
    host.endsWith(`.${HOST}`) ||
    host === "notion.site" ||
    host.endsWith(".notion.site");
  if (!notion) return null;
  const key = pageIdFromUrl(url);
  return key === null ? null : { host: HOST, scope: "", key, workspace: "" };
}

interface NotionOption {
  readonly id: string | null;
  readonly name: string;
  readonly color: string | null;
  readonly group: string | null;
}

interface NotionProperty {
  readonly id: string;
  readonly name: string;
  readonly type: string;
  readonly options: ReadonlyArray<NotionOption>;
  /** A relation's target data source. */
  readonly relatedDataSourceId: string | null;
}

/** The properties of a data source schema, with each status option's group resolved. */
export function schemaProperties(schema: unknown): ReadonlyArray<NotionProperty> {
  const properties = isObject(schema) && isObject(schema.properties) ? schema.properties : {};
  return Object.entries(properties).flatMap(([name, raw]) => {
    if (!isObject(raw)) return [];
    const type = text(raw.type) ?? "";
    const config = isObject(raw[type]) ? (raw[type] as Json) : {};
    const groupNames = new Map<string, string>();
    for (const group of array(config.groups)) {
      if (!isObject(group)) continue;
      const groupName = text(group.name);
      if (groupName === null) continue;
      for (const option of array(group.option_ids)) {
        if (typeof option === "string") groupNames.set(option, groupName);
      }
    }
    const options = array(config.options).flatMap((option) => {
      if (!isObject(option) || text(option.name) === null) return [];
      const id = text(option.id);
      return [
        {
          id,
          name: text(option.name) as string,
          color: text(option.color),
          group: id === null ? null : (groupNames.get(id) ?? null),
        } satisfies NotionOption,
      ];
    });
    return [
      {
        id: text(raw.id) ?? name,
        name,
        type,
        options,
        relatedDataSourceId: text(config.data_source_id),
      } satisfies NotionProperty,
    ];
  });
}

function findProperty(
  properties: ReadonlyArray<NotionProperty>,
  idOrName: string,
): NotionProperty | undefined {
  const wanted = idOrName.trim();
  const unhyphenated = canonicalId(wanted);
  return (
    properties.find((property) => property.id === wanted) ??
    properties.find((property) => property.name === wanted) ??
    properties.find((property) => canonicalId(property.id) === unhyphenated) ??
    properties.find((property) => canonicalId(property.name) === unhyphenated)
  );
}

const propertyValue = (page: Json, idOrName: string): Json | null => {
  const properties = isObject(page.properties) ? page.properties : {};
  const wanted = [idOrName, canonicalId(idOrName)];
  for (const [name, value] of Object.entries(properties)) {
    if (!isObject(value)) continue;
    const id = text(value.id);
    if (name === idOrName || (id !== null && wanted.includes(canonicalId(id)))) return value;
  }
  return null;
};

const richText = (value: unknown): string =>
  array(value)
    .map((part) => (isObject(part) ? (text(part.plain_text) ?? text(part.content) ?? "") : ""))
    .join("");

const RICH_TEXT_ITEM = /[\s\S]{1,2000}/g;

function richTextItems(body: string) {
  const chunks = [...body].length === 0 ? [""] : (body.match(RICH_TEXT_ITEM) ?? [body]);
  return chunks.map((content) => ({ type: "text", text: { content } }));
}

const pageTitle = (page: Json, property: NotionProperty): string => {
  const value = propertyValue(page, property.id) ?? propertyValue(page, property.name);
  return value === null ? "" : richText(value["title"]);
};

const pageRichText = (page: Json, property: NotionProperty): string => {
  const value = propertyValue(page, property.id) ?? propertyValue(page, property.name);
  return value === null ? "" : richText(value["rich_text"]);
};

const pageOption = (page: Json, property: NotionProperty): string | null => {
  const value = propertyValue(page, property.id) ?? propertyValue(page, property.name);
  if (value === null) return null;
  const option = property.type === "select" ? value["select"] : value["status"];
  return isObject(option) ? text(option.name) : null;
};

const categoryOf = (property: NotionProperty, optionName: string | null): IssueState => {
  const option = property.options.find((entry) => entry.name === optionName);
  const closed = option?.group?.toLowerCase() === "complete";
  return closed
    ? { category: "closed", name: optionName as string, closeReason: "completed" }
    : { category: "open", name: optionName ?? "No status" };
};

function peopleOf(page: Json, property: NotionProperty): ReadonlyArray<IssueActor> {
  const value = propertyValue(page, property.id) ?? propertyValue(page, property.name);
  if (value === null) return [];
  return array(value["people"]).flatMap((person) => {
    if (!isObject(person)) return [];
    const id = text(person.id);
    if (id === null) return [];
    return [
      {
        login: id,
        name: text(person.name),
        avatarUrl: text(person.avatar_url),
      },
    ];
  });
}

function labelsOf(page: Json, property: NotionProperty | null): ReadonlyArray<IssueLabel> {
  if (property === null) return [];
  const value = propertyValue(page, property.id) ?? propertyValue(page, property.name);
  if (value === null) return [];
  const names =
    property.type === "multi_select"
      ? array(value["multi_select"]).flatMap((entry) =>
          isObject(entry) && text(entry.name) !== null ? [text(entry.name) as string] : [],
        )
      : (() => {
          const selected = value["select"];
          return isObject(selected) && text(selected.name) !== null
            ? [text(selected.name) as string]
            : [];
        })();
  return names.map((name) => ({
    name,
    color: property.options.find((option) => option.name === name)?.color ?? null,
  }));
}

const COMMENT_TEXT = (comment: unknown) =>
  isObject(comment) && Array.isArray(comment.rich_text) ? richText(comment.rich_text) : "";

const commentAuthor = (comment: unknown): IssueActor | null => {
  if (!isObject(comment)) return null;
  const creator = isObject(comment.created_by) ? text(comment.created_by.id) : null;
  return creator === null ? null : { login: creator, name: null, avatarUrl: null };
};

function toComment(comment: unknown): IssueComment | null {
  if (!isObject(comment)) return null;
  const id = text(comment.id);
  const createdAt = text(comment.created_time);
  if (id === null || createdAt === null) return null;
  return {
    id,
    author: commentAuthor(comment),
    body: COMMENT_TEXT(comment),
    createdAt,
    url: null,
  };
}

/** One page as a listing row; reads the mapped title, status, people and labels properties. */
function toSummary(page: Json, binding: Binding): TrackerIssueSummary | string {
  const id = text(page.id);
  if (id === null || !isNotionId(id)) return "a result has no Notion page id";
  const title = cutChars(pageTitle(page, binding.title).trim(), 1_024);
  if (title.length === 0) return `page ${id} has no title`;
  const option = pageOption(page, binding.status);
  return {
    key: canonicalId(id),
    displayKey: canonicalId(id).slice(0, 8),
    title,
    url: text(page.url) ?? canonicalPageUrl(id),
    author: null,
    state: categoryOf(binding.status, option),
    createdAt: text(page.created_time) ?? text(page.last_edited_time) ?? NOTION_EPOCH,
    updatedAt: text(page.last_edited_time) ?? text(page.created_time) ?? NOTION_EPOCH,
    closedAt:
      categoryOf(binding.status, option).category === "closed"
        ? (text(page.last_edited_time) ?? null)
        : null,
    assignees: binding.assignee === null ? [] : peopleOf(page, binding.assignee),
    labels: labelsOf(page, binding.labels),
    commentCount: 0,
  };
}

interface Binding {
  readonly title: NotionProperty;
  readonly status: NotionProperty;
  readonly body: NotionProperty | null;
  readonly assignee: NotionProperty | null;
  readonly labels: NotionProperty | null;
  readonly prUrl: NotionProperty | null;
}

/**
 * The properties a project mapped, with a single title and status property picked when the
 * binding left them out. A string says what the binding must name instead.
 */
function bindingOf(
  properties: ReadonlyArray<NotionProperty>,
  mapping: Readonly<Record<string, string>> | undefined,
): Binding | string {
  const named = (key: string, types: ReadonlyArray<string>, label: string) => {
    const id = mapping?.[key];
    if (id === undefined || id.trim().length === 0) return null;
    const property = findProperty(properties, id);
    if (property === undefined) {
      return `${label} ${JSON.stringify(id)} is not a property of this data source`;
    }
    return types.includes(property.type)
      ? property
      : `${label} ${JSON.stringify(property.name)} has type ${property.type}; expected ${types.join(" or ")}`;
  };
  const fallback = (types: ReadonlyArray<string>) => {
    const matches = properties.filter((property) => types.includes(property.type));
    return matches.length === 1 ? matches[0]! : null;
  };
  const title = named("title", ["title"], "title property") ?? fallback(["title"]);
  if (title === null || typeof title === "string") {
    return typeof title === "string"
      ? title
      : "the data source has no title property to bind; map one in Settings";
  }
  const status =
    named("status", ["status", "select"], "status property") ?? fallback(["status", "select"]);
  if (status === null || typeof status === "string") {
    return typeof status === "string"
      ? status
      : "the data source has no single status property; map one in Settings";
  }
  for (const [key, types, label] of [
    ["body", ["rich_text"], "description property"],
    ["assignee", ["people"], "assignee property"],
    ["labels", ["select", "multi_select"], "labels property"],
    ["prUrl", ["url"], "pull request URL property"],
  ] as const) {
    const property = named(key, types, label);
    if (typeof property === "string") return property;
  }
  const optional = (key: string) => {
    const id = mapping?.[key];
    return id === undefined ? null : (findProperty(properties, id) ?? null);
  };
  return {
    title,
    status,
    body: optional("body"),
    assignee: optional("assignee"),
    labels: optional("labels"),
    prUrl: optional("prUrl"),
  };
}

const fail = (
  operation: string,
  reason: IssueTrackerError["reason"],
  detail: string,
  cause?: unknown,
) =>
  new IssueTrackerError({
    tracker: KIND,
    operation,
    reason,
    detail,
    ...(cause === undefined ? {} : { cause }),
  });

const UNAUTHENTICATED = /HTTP 401|HTTP 403/;
const NOT_FOUND = /HTTP 404/;
const NEWLINES = /\r?\n/;

const httpFailure = (operation: string, message: string) => {
  if (UNAUTHENTICATED.test(message)) {
    return fail(operation, "unauthenticated", "Notion rejected the integration token.");
  }
  if (NOT_FOUND.test(message)) {
    return fail(operation, "not-found", "Notion has no such page or data source.");
  }
  return fail(operation, "failed", message);
};

const call = <A>(
  operation: string,
  run: Effect.Effect<A, string>,
): Effect.Effect<A, IssueTrackerError> =>
  run.pipe(Effect.mapError((message) => httpFailure(operation, message)));

const dataSourcePath = (scope: string) => `v1/data_sources/${encodeURIComponent(scope)}`;
const pagePath = (id: string) => `v1/pages/${encodeURIComponent(id)}`;

const isPage = (value: unknown): value is Json =>
  isObject(value) && value.object === "page" && text(value.id) !== null;

/** The page must sit in the binding's data source; a page of another source reads as absent. */
function pageInScope(page: Json, scope: string, operation: string) {
  const parent = isObject(page.parent) ? text(page.parent.data_source_id) : null;
  return parent !== null && sameId(parent, scope)
    ? null
    : fail(
        operation,
        "not-found",
        `the page belongs to data source ${parent ?? "none"}, not the bound ${scope}`,
      );
}

type NotionApiService = NotionApi.NotionApi["Service"];

type BlockRead = Effect.Effect<
  { readonly markdown: string; readonly truncated: boolean },
  IssueTrackerError
>;

/** The page content as markdown, bounded in blocks, pages and characters. */
const readBlocks: (
  api: NotionApiService,
  token: Redacted.Redacted<string>,
  pageId: string,
  depth?: number,
) => BlockRead = Effect.fnUntraced(function* (
  api: NotionApiService,
  token: Redacted.Redacted<string>,
  pageId: string,
  depth = 0,
) {
  const lines: Array<string> = [];
  let cursor: string | null = null;
  let total = 0;
  let truncated = false;
  for (let page = 0; page < MAX_BLOCK_PAGES; page += 1) {
    const query = new URLSearchParams({ page_size: String(PROPERTIES_PAGE) });
    if (cursor !== null) query.set("start_cursor", cursor);
    const answer = yield* call(
      "readBlocks",
      api.request(token, "GET", `v1/blocks/${encodeURIComponent(pageId)}/children?${query}`),
    );
    if (!isObject(answer) || !Array.isArray(answer.results)) {
      return yield* fail("readBlocks", "failed", "Notion's block list is not a result list");
    }
    for (const block of answer.results) {
      if (total >= MAX_BODY_BLOCKS) {
        truncated = true;
        break;
      }
      total += 1;
      if (!isObject(block)) continue;
      const rendered = yield* renderBlock(api, token, block, depth);
      if (rendered.length > 0) lines.push(rendered);
    }
    if (truncated || answer.has_more !== true) {
      if (answer.has_more === true) truncated = true;
      break;
    }
    if (typeof answer.next_cursor !== "string") {
      return yield* fail("readBlocks", "failed", "Notion indicated more blocks without a cursor");
    }
    cursor = answer.next_cursor;
  }
  return { markdown: lines.join("\n"), truncated };
});

const renderBlock: (
  api: NotionApiService,
  token: Redacted.Redacted<string>,
  block: Json,
  depth: number,
) => Effect.Effect<string, IssueTrackerError> = Effect.fnUntraced(function* (
  api: NotionApiService,
  token: Redacted.Redacted<string>,
  block: Json,
  depth: number,
) {
  const type = text(block.type) ?? "";
  const value = isObject(block[type]) ? (block[type] as Json) : {};
  const body = richTextFormat(value.rich_text);
  const withChildren = (line: string): Effect.Effect<string, IssueTrackerError> =>
    block.has_children === true && depth < MAX_BLOCK_DEPTH
      ? Effect.gen(function* () {
          const id = text(block.id);
          if (id === null) return line;
          const children = yield* readBlocks(api, token, id, depth + 1);
          return children.markdown.length === 0 ? line : `${line}\n${children.markdown}`;
        })
      : Effect.succeed(line);
  switch (type) {
    case "paragraph":
      return yield* withChildren(body);
    case "heading_1":
      return yield* withChildren(`# ${body}`);
    case "heading_2":
      return yield* withChildren(`## ${body}`);
    case "heading_3":
      return yield* withChildren(`### ${body}`);
    case "bulleted_list_item":
      return yield* withChildren(`- ${body}`);
    case "numbered_list_item":
      return yield* withChildren(`1. ${body}`);
    case "to_do":
      return yield* withChildren(`- [${value.checked === true ? "x" : " "}] ${body}`);
    case "quote":
    case "callout":
      return yield* withChildren(`> ${body}`);
    case "code": {
      const language = text(value.language) ?? "";
      return yield* withChildren(`\`\`\`${language}\n${body}\n\`\`\``);
    }
    case "divider":
      return "---";
    case "child_page":
      return yield* withChildren(text(value.title) ?? "");
    case "toggle":
      return yield* withChildren(body);
    case "bookmark":
    case "embed":
    case "link_preview":
    case "image":
    case "video":
    case "file":
    case "pdf": {
      const url = text(value.url) ?? richText(value.caption);
      return url === null || url.length === 0 ? "" : url;
    }
    default:
      return yield* withChildren(body);
  }
});

/** Rich text with the annotations markdown carries; a link keeps its text and target. */
function richTextFormat(value: unknown): string {
  return array(value)
    .map((part) => {
      if (!isObject(part)) return "";
      let content = text(part.plain_text) ?? "";
      const link = isObject(part.text) && isObject(part.text.link) ? part.text.link : null;
      const href = text(part.href) ?? (link === null ? null : text(link.url));
      const annotations = isObject(part.annotations) ? part.annotations : {};
      if (annotations.code === true) content = `\`${content}\``;
      if (annotations.bold === true) content = `**${content}**`;
      if (annotations.italic === true) content = `_${content}_`;
      if (annotations.strikethrough === true) content = `~~${content}~~`;
      if (href !== null && href.length > 0) content = `[${content}](${href})`;
      return content;
    })
    .join("");
}

const paragraphBlocks = (body: string): ReadonlyArray<Json> | string => {
  const lines = body.split(NEWLINES).filter((line) => line.trim().length > 0);
  if (lines.length > MAX_WRITTEN_BLOCKS) {
    return `the body has ${lines.length} lines; at most ${MAX_WRITTEN_BLOCKS} can be written at once`;
  }
  return lines.map((line) => ({
    object: "block",
    type: "paragraph",
    paragraph: { rich_text: richTextItems(cutChars(line, RICH_TEXT_CHARS)) },
  }));
};

const commentChunks = (body: string): ReadonlyArray<string> | string => {
  const chunks: Array<string> = [];
  for (let start = 0; start < [...body].length; start += RICH_TEXT_CHARS) {
    chunks.push([...body].slice(start, start + RICH_TEXT_CHARS).join(""));
  }
  return chunks.length > MAX_COMMENT_CHUNKS
    ? `the comment needs ${chunks.length} rich-text chunks of ${RICH_TEXT_CHARS} characters, over the limit of ${MAX_COMMENT_CHUNKS}`
    : chunks;
};

const searchDataSources = (answer: unknown): ReadonlyArray<IssueTrackerScope> => {
  if (!isObject(answer) || !Array.isArray(answer.results)) return [];
  return answer.results.flatMap((raw) => {
    if (!isObject(raw) || raw.object !== "data_source") return [];
    const id = text(raw.id);
    if (id === null) return [];
    const title = richText(raw.title).trim() || text(raw.name)?.trim() || id;
    return [{ key: id, name: cutChars(title, 200) }];
  });
};

export const make: Effect.Effect<
  StandaloneIssueTrackerApi,
  never,
  NotionApi.NotionApi | IssueTrackerHost.IssueTrackerHost
> = Effect.gen(function* () {
  const api = yield* NotionApi.NotionApi;
  const host = yield* IssueTrackerHost.IssueTrackerHost;

  const storedToken = (operation: string) =>
    host.credentials
      .get(KIND)
      .pipe(
        Effect.flatMap((stored) =>
          Option.isNone(stored)
            ? Effect.fail(
                fail(operation, "unauthenticated", "Notion is not connected on this server."),
              )
            : Effect.succeed(Redacted.make(stored.value)),
        ),
      );

  const schemaOf = (operation: string, token: Redacted.Redacted<string>, scope: string) =>
    call(operation, api.request(token, "GET", dataSourcePath(scope))).pipe(
      Effect.filterOrFail(
        (schema): schema is Json => isObject(schema) && isObject(schema.properties),
        () => fail(operation, "failed", "Notion's data source answer has no properties"),
      ),
    );

  const bindingFor = (
    operation: string,
    properties: ReadonlyArray<NotionProperty>,
    mapping: Readonly<Record<string, string>> | undefined,
  ) => {
    const binding = bindingOf(properties, mapping);
    return typeof binding === "string"
      ? Effect.fail(fail(operation, "failed", binding))
      : Effect.succeed(binding);
  };

  const pageOf = (operation: string, token: Redacted.Redacted<string>, key: string) =>
    call(operation, api.request(token, "GET", pagePath(key))).pipe(
      Effect.filterOrFail(
        (page): page is Json => isPage(page),
        () => fail(operation, "not-found", "Notion has no page by that id."),
      ),
    );

  const viewerOf = (token: Redacted.Redacted<string>) =>
    call("getViewer", api.request(token, "GET", "v1/users/me")).pipe(
      Effect.map((me) => (isObject(me) ? (text(me.name) ?? text(me.id) ?? "Notion") : "Notion")),
    );

  const openNames = (status: NotionProperty) =>
    status.options
      .filter((option) => option.group?.toLowerCase() !== "complete")
      .map((o) => o.name);
  const closedNames = (status: NotionProperty) =>
    status.options
      .filter((option) => option.group?.toLowerCase() === "complete")
      .map((o) => o.name);

  const stateFilter = (
    status: NotionProperty,
    state: "open" | "closed",
    names: ReadonlyArray<string>,
  ) => {
    if (names.length === 0) return null;
    const value = status.type === "select" ? "select" : "status";
    const clauses = names.map((name) => ({
      property: status.id,
      [value]: { equals: name },
    }));
    return clauses.length === 1 ? clauses[0] : { or: clauses };
  };

  const issueStates = (status: NotionProperty): ReadonlyArray<IssueState> =>
    status.options.map((option) =>
      option.group?.toLowerCase() === "complete"
        ? { category: "closed", name: option.name, closeReason: "completed" }
        : { category: "open", name: option.name },
    );

  const listIssues: StandaloneIssueTrackerApi["listIssues"] = Effect.fn(
    "NotionIssueTracker.listIssues",
  )(function* (input) {
    if (input.involvement !== "all") {
      return yield* fail(
        "listIssues",
        "failed",
        `Notion cannot filter issues by involvement "${input.involvement}": its API cannot ask for pages by the connected user.`,
      );
    }
    if (input.assignee !== undefined) {
      return yield* fail(
        "listIssues",
        "failed",
        `Notion cannot filter issues by assignee "${input.assignee}": its query API filters people by user id, not login.`,
      );
    }
    const token = yield* storedToken("listIssues");
    const schema = yield* schemaOf("listIssues", token, input.scope);
    const binding = yield* bindingFor("listIssues", schemaProperties(schema), input.properties);
    if (input.labels !== undefined && input.labels.length > 0 && binding.labels === null) {
      return yield* fail(
        "listIssues",
        "failed",
        "this project's Notion binding maps no labels property, so labels cannot narrow a listing",
      );
    }
    const clauses: Array<unknown> = [];
    const names =
      input.state === "closed" ? closedNames(binding.status) : openNames(binding.status);
    if (input.state !== "all") {
      const filtered = stateFilter(binding.status, input.state, names);
      // A select has no closed option of its own, so a closed listing is legitimately empty.
      if (filtered === null) return { items: [], nextCursor: null } satisfies TrackerIssuePage;
      clauses.push(filtered);
    }
    for (const label of input.labels ?? []) {
      const value = binding.labels?.type === "multi_select" ? "multi_select" : "select";
      clauses.push({
        property: binding.labels?.id ?? "",
        [value]: value === "multi_select" ? { contains: label } : { equals: label },
      });
    }
    if (input.query !== undefined && input.query.trim().length > 0) {
      clauses.push({ property: binding.title.id, title: { contains: input.query.trim() } });
    }
    const filter =
      clauses.length === 0 ? undefined : clauses.length === 1 ? clauses[0] : { and: clauses };
    const answer = yield* call(
      "listIssues",
      api.request(token, "POST", `${dataSourcePath(input.scope)}/query`, {
        ...(filter === undefined ? {} : { filter }),
        sorts: [
          {
            timestamp: input.sort === "created" ? "created_time" : "last_edited_time",
            direction: "descending",
          },
        ],
        page_size: Math.min(Math.max(input.limit, 1), 100),
        ...(input.cursor === undefined ? {} : { start_cursor: input.cursor }),
      }),
    );
    if (!isObject(answer) || !Array.isArray(answer.results)) {
      return yield* fail("listIssues", "failed", "Notion's query did not answer a result list");
    }
    const items: Array<TrackerIssueSummary> = [];
    for (const page of answer.results) {
      if (!isPage(page)) continue;
      const summary = toSummary(page, binding);
      if (typeof summary === "string") {
        yield* Effect.logWarning(`Notion list: ${summary}`);
        continue;
      }
      items.push(summary);
    }
    return {
      items,
      nextCursor:
        answer.has_more === true && typeof answer.next_cursor === "string"
          ? answer.next_cursor
          : null,
    } satisfies TrackerIssuePage;
  });

  const getIssue: StandaloneIssueTrackerApi["getIssue"] = Effect.fn("NotionIssueTracker.getIssue")(
    function* (input) {
      const token = yield* storedToken("getIssue");
      const schema = yield* schemaOf("getIssue", token, input.scope);
      const binding = yield* bindingFor("getIssue", schemaProperties(schema), input.properties);
      const page = yield* pageOf("getIssue", token, input.key);
      const outOfScope = pageInScope(page, input.scope, "getIssue");
      if (outOfScope !== null) return yield* outOfScope;
      const summary = toSummary(page, binding);
      if (typeof summary === "string") return yield* fail("getIssue", "failed", summary);
      const comments = yield* call(
        "getIssue",
        api.request(
          token,
          "GET",
          `v1/comments?block_id=${encodeURIComponent(input.key)}&page_size=${COMMENTS_PAGE}`,
        ),
      );
      const listed = isObject(comments) && Array.isArray(comments.results) ? comments.results : [];
      const blocks = yield* readBlocks(api, token, input.key);
      const description = binding.body === null ? "" : pageRichText(page, binding.body).trim();
      const markdown = [description, blocks.markdown]
        .filter((part) => part.length > 0)
        .join("\n\n");
      return {
        ...summary,
        body:
          cutChars(markdown, MAX_BODY_CHARS) + (markdown.length > MAX_BODY_CHARS ? "\n\n…" : ""),
        viewer: yield* viewerOf(token),
        viewerPermissions: VIEWER_PERMISSIONS,
        states: issueStates(binding.status),
        comments: listed.flatMap((comment) => toComment(comment) ?? []),
        commentsCursor:
          isObject(comments) &&
          comments.has_more === true &&
          typeof comments.next_cursor === "string"
            ? comments.next_cursor
            : null,
        events: [],
        linkedPullRequests: [],
      } satisfies TrackerIssueDetail;
    },
  );

  const getComments: StandaloneIssueTrackerApi["getComments"] = Effect.fn(
    "NotionIssueTracker.getComments",
  )(function* (input) {
    const token = yield* storedToken("getComments");
    const page = yield* pageOf("getComments", token, input.key);
    const outOfScope = pageInScope(page, input.scope, "getComments");
    if (outOfScope !== null) return yield* outOfScope;
    const answer = yield* call(
      "getComments",
      api.request(
        token,
        "GET",
        `v1/comments?block_id=${encodeURIComponent(input.key)}&page_size=${COMMENTS_PAGE}&start_cursor=${encodeURIComponent(input.cursor)}`,
      ),
    );
    if (!isObject(answer) || !Array.isArray(answer.results)) {
      return yield* fail("getComments", "failed", "Notion's comment list is not a result list");
    }
    return {
      comments: answer.results.flatMap((comment) => toComment(comment) ?? []),
      nextCursor:
        answer.has_more === true && typeof answer.next_cursor === "string"
          ? answer.next_cursor
          : null,
    } satisfies IssueCommentsPage;
  });

  const create: NonNullable<StandaloneIssueTrackerApi["create"]> = Effect.fn(
    "NotionIssueTracker.create",
  )(function* (input) {
    const token = yield* storedToken("create");
    const schema = yield* schemaOf("create", token, input.scope);
    const binding = yield* bindingFor("create", schemaProperties(schema), input.properties);
    const properties: Record<string, unknown> = {
      [binding.title.id]: { title: richTextItems(input.title) },
    };
    if (input.labels.length > 0) {
      if (binding.labels === null) {
        return yield* fail(
          "create",
          "failed",
          "this project's Notion binding maps no labels property, so labels cannot be written",
        );
      }
      if (binding.labels.type === "select") {
        if (input.labels.length > 1) {
          return yield* fail(
            "create",
            "failed",
            "the bound labels property is a single select, so one label is written at most",
          );
        }
        const [label] = input.labels;
        properties[binding.labels.id] = { select: { name: label } };
      } else {
        properties[binding.labels.id] = {
          multi_select: input.labels.map((name) => ({ name })),
        };
      }
    }
    if (input.assignees.length > 0) {
      if (binding.assignee === null) {
        return yield* fail(
          "create",
          "failed",
          "this project's Notion binding maps no assignee property, so people cannot be written",
        );
      }
      properties[binding.assignee.id] = {
        people: input.assignees.map((id) => ({ id })),
      };
    }
    const blocks = paragraphBlocks(input.body);
    if (typeof blocks === "string") return yield* fail("create", "failed", blocks);
    const created = yield* call(
      "create",
      api.request(token, "POST", "v1/pages", {
        parent: { type: "data_source_id", data_source_id: input.scope },
        properties,
        ...(blocks.length === 0 ? {} : { children: blocks }),
      }),
    );
    if (!isPage(created)) {
      return yield* fail("create", "failed", "Notion did not answer the created page");
    }
    const id = text(created.id) as string;
    return {
      key: canonicalId(id),
      displayKey: canonicalId(id).slice(0, 8),
      url: text(created.url) ?? canonicalPageUrl(id),
    } satisfies IssueCreateResult;
  });

  const comment: NonNullable<StandaloneIssueTrackerApi["comment"]> = Effect.fn(
    "NotionIssueTracker.comment",
  )(function* (input) {
    const token = yield* storedToken("comment");
    const page = yield* pageOf("comment", token, input.key);
    const outOfScope = pageInScope(page, input.scope, "comment");
    if (outOfScope !== null) return yield* outOfScope;
    const chunks = commentChunks(input.body);
    if (typeof chunks === "string") return yield* fail("comment", "failed", chunks);
    yield* call(
      "comment",
      api.request(token, "POST", "v1/comments", {
        parent: { page_id: input.key },
        rich_text: chunks.map((content) => ({ type: "text", text: { content } })),
      }),
    );
  });

  const replaceBlocks = Effect.fn("NotionIssueTracker.replaceBlocks")(function* (
    token: Redacted.Redacted<string>,
    pageId: string,
    blocks: ReadonlyArray<Json>,
  ) {
    let cursor: string | null = null;
    for (let page = 0; page < MAX_BLOCK_PAGES; page += 1) {
      const query = new URLSearchParams({ page_size: String(PROPERTIES_PAGE) });
      if (cursor !== null) query.set("start_cursor", cursor);
      const answer = yield* call(
        "update",
        api.request(token, "GET", `v1/blocks/${encodeURIComponent(pageId)}/children?${query}`),
      );
      if (!isObject(answer) || !Array.isArray(answer.results)) {
        return yield* fail("update", "failed", "Notion's block list is not a result list");
      }
      for (const block of answer.results) {
        if (!isObject(block) || text(block.id) === null) continue;
        yield* call(
          "update",
          api.request(token, "PATCH", `v1/blocks/${encodeURIComponent(text(block.id) as string)}`, {
            archived: true,
          }),
        );
      }
      if (answer.has_more !== true) break;
      if (typeof answer.next_cursor !== "string") {
        return yield* fail("update", "failed", "Notion indicated more blocks without a cursor");
      }
      cursor = answer.next_cursor;
    }
    if (blocks.length === 0) return;
    yield* call(
      "update",
      api.request(token, "PATCH", `v1/blocks/${encodeURIComponent(pageId)}/children`, {
        children: blocks,
      }),
    );
  });

  const update: NonNullable<StandaloneIssueTrackerApi["update"]> = Effect.fn(
    "NotionIssueTracker.update",
  )(function* (input) {
    const token = yield* storedToken("update");
    const schema = yield* schemaOf("update", token, input.scope);
    const binding = yield* bindingFor("update", schemaProperties(schema), input.properties);
    const page = yield* pageOf("update", token, input.key);
    const outOfScope = pageInScope(page, input.scope, "update");
    if (outOfScope !== null) return yield* outOfScope;
    const properties: Record<string, unknown> = {};
    if (input.title !== undefined) {
      properties[binding.title.id] = { title: richTextItems(input.title) };
    }
    if (input.body !== undefined) {
      if (binding.body !== null) {
        properties[binding.body.id] = {
          rich_text: richTextItems(cutChars(input.body, MAX_BODY_CHARS)),
        };
      } else {
        const blocks = paragraphBlocks(cutChars(input.body, MAX_BODY_CHARS));
        if (typeof blocks === "string") return yield* fail("update", "failed", blocks);
        yield* replaceBlocks(token, input.key, blocks);
      }
    }
    if (input.labels !== undefined) {
      if (binding.labels === null) {
        return yield* fail(
          "update",
          "failed",
          "this project's Notion binding maps no labels property, so labels cannot be written",
        );
      }
      if (binding.labels.type === "select") {
        if (input.labels.length > 1) {
          return yield* fail(
            "update",
            "failed",
            "the bound labels property is a single select, so one label is written at most",
          );
        }
        properties[binding.labels.id] = {
          select: input.labels[0] === undefined ? null : { name: input.labels[0] },
        };
      } else {
        properties[binding.labels.id] = {
          multi_select: input.labels.map((name) => ({ name })),
        };
      }
    }
    if (input.assignees !== undefined) {
      if (binding.assignee === null) {
        return yield* fail(
          "update",
          "failed",
          "this project's Notion binding maps no assignee property, so people cannot be written",
        );
      }
      properties[binding.assignee.id] = {
        people: input.assignees.map((id) => ({ id })),
      };
    }
    if (Object.keys(properties).length > 0) {
      yield* call("update", api.request(token, "PATCH", pagePath(input.key), { properties }));
    }
  });

  const setState: NonNullable<StandaloneIssueTrackerApi["setState"]> = Effect.fn(
    "NotionIssueTracker.setState",
  )(function* (input) {
    const token = yield* storedToken("setState");
    const schema = yield* schemaOf("setState", token, input.scope);
    const binding = yield* bindingFor("setState", schemaProperties(schema), input.properties);
    const page = yield* pageOf("setState", token, input.key);
    const outOfScope = pageInScope(page, input.scope, "setState");
    if (outOfScope !== null) return yield* outOfScope;
    if (!binding.status.options.some((option) => option.name === input.state)) {
      return yield* fail(
        "setState",
        "failed",
        `the bound status property has no "${input.state}" option`,
      );
    }
    const value = binding.status.type === "select" ? "select" : "status";
    yield* call(
      "setState",
      api.request(token, "PATCH", pagePath(input.key), {
        properties: { [binding.status.id]: { [value]: { name: input.state } } },
      }),
    );
  });

  const setPullRequestUrl: NonNullable<StandaloneIssueTrackerApi["setPullRequestUrl"]> = Effect.fn(
    "NotionIssueTracker.setPullRequestUrl",
  )(function* (input) {
    const token = yield* storedToken("setPullRequestUrl");
    const schema = yield* schemaOf("setPullRequestUrl", token, input.scope);
    const binding = yield* bindingFor(
      "setPullRequestUrl",
      schemaProperties(schema),
      input.properties,
    );
    if (binding.prUrl === null) {
      return yield* fail(
        "setPullRequestUrl",
        "failed",
        "this project's Notion binding maps no pull request URL property",
      );
    }
    if (
      Buffer.byteLength(input.url, "utf8") > MAX_PR_URL_BYTES ||
      URL.parse(input.url)?.protocol !== "https:"
    ) {
      return yield* fail(
        "setPullRequestUrl",
        "failed",
        `the pull request URL must be an https URL of at most ${MAX_PR_URL_BYTES} bytes`,
      );
    }
    const page = yield* pageOf("setPullRequestUrl", token, input.key);
    const outOfScope = pageInScope(page, input.scope, "setPullRequestUrl");
    if (outOfScope !== null) return yield* outOfScope;
    yield* call(
      "setPullRequestUrl",
      api.request(token, "PATCH", pagePath(input.key), {
        properties: { [binding.prUrl.id]: { url: input.url } },
      }),
    );
  });

  const parseIssueUrl = parseNotionIssueUrl;

  return {
    kind: KIND,
    capabilities: CAPABILITIES,
    standalone: DESCRIPTOR,
    parseIssueUrl,
    sameScope: sameId,

    probeCredential: Effect.fn("NotionIssueTracker.probeCredential")(function* (token) {
      const key = Redacted.make(token);
      const account = yield* viewerOf(key);
      const found = yield* call(
        "probeCredential",
        api.request(Redacted.make(token), "POST", "v1/search", {
          filter: { property: "object", value: "data_source" },
          page_size: 100,
        }),
      );
      return { account, scopes: searchDataSources(found) };
    }),

    getViewer: Effect.fn("NotionIssueTracker.getViewer")(function* () {
      const token = yield* storedToken("getViewer");
      return yield* viewerOf(token);
    }),

    listIssues,
    getIssue,
    getComments,
    create,
    comment,
    update,
    setState,
    setPullRequestUrl,

    listCandidates: Effect.fn("NotionIssueTracker.listCandidates")(function* (input) {
      const token = yield* storedToken("listCandidates");
      const schema = yield* schemaOf("listCandidates", token, input.scope);
      const binding = yield* bindingFor(
        "listCandidates",
        schemaProperties(schema),
        input.properties,
      );
      const labels =
        binding.labels === null
          ? []
          : binding.labels.options.map((option) => ({
              name: option.name,
              color: option.color,
              description: null,
            }));
      return { labels, assignees: [], truncated: false };
    }),

    listProperties: Effect.fn("NotionIssueTracker.listProperties")(function* (scope) {
      const token = yield* storedToken("listProperties");
      const schema = yield* schemaOf("listProperties", token, scope);
      return schemaProperties(schema).map(
        (property) =>
          ({
            id: property.id,
            name: property.name,
            type: property.type,
            options: property.options.map((option) => option.name),
          }) satisfies IssueTrackerProperty,
      );
    }),
  } satisfies StandaloneIssueTrackerApi;
});
