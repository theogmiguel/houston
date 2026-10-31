// The rules that decide a task source outcome, as pure functions over plain values: settings
// validation, the GitHub and Notion mappings, the Notion checkpoint and the three-way merge.
// @effect-diagnostics nodeBuiltinImport:off - keys write-back markers with HMAC-SHA256.
import * as NodeCrypto from "node:crypto";

import type { ProjectId } from "@t3tools/contracts";
import { HoustonTaskStatus } from "@t3tools/contracts/houston/tasks";
import {
  HOUSTON_TASK_SOURCE_LIMITS,
  HoustonTaskSourceError,
  type HoustonTaskSourceConflict,
  type HoustonTaskSourceProjectSnapshot,
  type HoustonTaskSourceProvider,
  type HoustonTaskSourceSettings,
  type HoustonTaskSourceSettingsInput,
  type HoustonTaskSourceSnapshot,
  type HoustonTaskSourceStatusMapping,
  type HoustonTaskSourceSyncState,
} from "@t3tools/contracts/houston/taskSources";
import * as Schema from "effect/Schema";

export const POLL_INTERVAL_SECONDS = 20;
export const GITHUB_PAGE_SIZE = 100;
export const GITHUB_MAX_PAGES = 20;
export const NOTION_PAGE_SIZE = 100;
export const NOTION_MAX_PAGES = 5;
/** Linked Notion pages outside the filter refreshed after each complete poll. */
export const NOTION_REFRESH_PER_POLL = 3;
export const NOTION_API_VERSION = "2026-03-11";
export const NOTION_MAX_RESPONSE_BYTES = 1_048_576;
export const NOTION_MAX_RETRY_AFTER_SECONDS = 30;
export const RECORD_LIMITS = {
  titleChars: 200,
  githubBodyChars: 8_000,
  milestoneDescriptionChars: 4_000,
  notionDescriptionChars: 16_384,
  snapshotBytes: 65_536,
  initiativeKeyChars: 512,
  urlBytes: 2_048,
  errorChars: 1_024,
} as const;
export const TOKEN_ACCOUNT = "integration-token";
export const TOKEN_UNAVAILABLE = "Notion integration token is not available from the OS keychain";
export const TOKEN_MISSING = "Notion integration token is missing";

const isTaskStatus = Schema.is(HoustonTaskStatus);
export const isRefusal = Schema.is(HoustonTaskSourceError);

export const refuse = (
  kind: HoustonTaskSourceError["kind"],
  operation: string,
  message: string,
  extra: {
    readonly field?: string;
    readonly limit?: number;
    readonly actual?: number;
    readonly expected?: number;
  } = {},
) =>
  new HoustonTaskSourceError({
    kind,
    operation,
    message: `${operation} refused: ${message}`,
    ...extra,
  });

const chars = (text: string) => [...text].length;
const bytes = (text: string) => Buffer.byteLength(text, "utf8");

/** At most `max` characters, never splitting a surrogate pair. */
export const cutChars = (text: string, max: number) =>
  chars(text) <= max ? text : [...text].slice(0, max).join("");

/** A refused value as a refusal quotes it: JSON, at most 120 characters of it. */
export const quote = (value: string, max: number = HOUSTON_TASK_SOURCE_LIMITS.quotedChars) =>
  JSON.stringify(cutChars(value, max));

// Settings.

/** Stored settings: what a client set, every field present. */
export type StoredSettings = Omit<
  HoustonTaskSourceSettings,
  "projectId" | "provider" | "revision" | "hasCredential" | "lastSyncAt" | "lastError"
>;

const EMPTY_MAPPING: HoustonTaskSourceStatusMapping = {
  todo: null,
  inProgress: null,
  inReview: null,
  done: null,
  canceled: null,
};

const blankToNull = (value: string | null | undefined) =>
  value === undefined || value === null || value.trim().length === 0 ? null : value;

export const storedSettings = (input: HoustonTaskSourceSettingsInput): StoredSettings => ({
  enabled: input.enabled,
  githubRepository: blankToNull(input.githubRepository),
  githubLabel: blankToNull(input.githubLabel),
  githubAssignedUser: blankToNull(input.githubAssignedUser),
  notionDataSourceId: blankToNull(input.notionDataSourceId),
  notionTitlePropertyId: blankToNull(input.notionTitlePropertyId),
  notionDescriptionPropertyId: blankToNull(input.notionDescriptionPropertyId),
  notionStatusPropertyId: blankToNull(input.notionStatusPropertyId),
  notionAssigneePropertyId: blankToNull(input.notionAssigneePropertyId),
  notionProjectRelationPropertyId: blankToNull(input.notionProjectRelationPropertyId),
  notionAssigneeUserId: blankToNull(input.notionAssigneeUserId),
  notionActiveStatusValues: [...(input.notionActiveStatusValues ?? [])],
  notionProjectsDataSourceId: blankToNull(input.notionProjectsDataSourceId),
  notionProjectTitlePropertyId: blankToNull(input.notionProjectTitlePropertyId),
  notionProjectDescriptionPropertyId: blankToNull(input.notionProjectDescriptionPropertyId),
  notionPrUrlPropertyId: blankToNull(input.notionPrUrlPropertyId),
  notionStatusMapping: input.notionStatusMapping ?? EMPTY_MAPPING,
});

export const unsetSettings = (
  projectId: ProjectId,
  provider: HoustonTaskSourceProvider,
): HoustonTaskSourceSettings => ({
  projectId,
  provider,
  revision: 0,
  ...storedSettings({ enabled: false }),
  hasCredential: false,
  lastSyncAt: null,
  lastError: null,
});

const SAFE_REPOSITORY_PART = /^[A-Za-z0-9_.-]+$/;

/** `owner/name` when both parts are safe in a URL path, else null. */
export const parseRepository = (raw: string): string | null => {
  const parts = raw.split("/");
  if (parts.length !== 2) return null;
  const safe = (part: string) => part !== "." && part !== ".." && SAFE_REPOSITORY_PART.test(part);
  return parts.every(safe) ? raw : null;
};

/** Enabled GitHub settings need a safe `owner/name` and a label or an assigned user. */
export const checkGithubSettings = (
  operation: string,
  settings: StoredSettings,
): HoustonTaskSourceError | undefined => {
  if (!settings.enabled) return undefined;
  const repository = settings.githubRepository ?? "";
  if (parseRepository(repository) === null) {
    return refuse(
      "invalid",
      operation,
      `githubRepository ${quote(repository)} is not owner/name (each part ASCII letters, digits, "-", "_" or ".", not "." or "..")`,
      { field: "githubRepository" },
    );
  }
  if (settings.githubLabel === null && settings.githubAssignedUser === null) {
    return refuse(
      "invalid",
      operation,
      "githubLabel or githubAssignedUser is required: GitHub Issues imports issues with the label or assigned to the user",
      { field: "githubLabel" },
    );
  }
  return undefined;
};

const NOTION_ID =
  /^(?:[0-9a-fA-F]{32}|[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$/;

export const isNotionId = (value: string) => NOTION_ID.test(value);

const mappingEntries = (mapping: HoustonTaskSourceStatusMapping) =>
  [
    ["todo", mapping.todo],
    ["inProgress", mapping.inProgress],
    ["inReview", mapping.inReview],
    ["done", mapping.done],
    ["canceled", mapping.canceled],
  ] as const;

/** A status value or mapping: 1 to 100 bytes, not blank. */
const checkStatusValue = (
  operation: string,
  field: string,
  value: string,
): HoustonTaskSourceError | undefined => {
  if (value.trim().length === 0) {
    return refuse("invalid", operation, `${field} ${quote(value)} is blank`, { field });
  }
  const size = bytes(value);
  return size > HOUSTON_TASK_SOURCE_LIMITS.statusValueBytes
    ? refuse(
        "limit",
        operation,
        `${field} ${quote(value, 64)} is ${size} bytes, over the limit of ${HOUSTON_TASK_SOURCE_LIMITS.statusValueBytes} bytes`,
        { field, limit: HOUSTON_TASK_SOURCE_LIMITS.statusValueBytes, actual: size },
      )
    : undefined;
};

/** The checks Notion settings pass before any request: ids, property ids and status bounds. */
export const checkNotionSettings = (
  operation: string,
  settings: StoredSettings,
): HoustonTaskSourceError | undefined => {
  const statuses = settings.notionActiveStatusValues;
  if (statuses.length > HOUSTON_TASK_SOURCE_LIMITS.activeStatuses) {
    return refuse(
      "limit",
      operation,
      `notionActiveStatusValues holds ${statuses.length} statuses, over the limit of ${HOUSTON_TASK_SOURCE_LIMITS.activeStatuses}`,
      {
        field: "notionActiveStatusValues",
        limit: HOUSTON_TASK_SOURCE_LIMITS.activeStatuses,
        actual: statuses.length,
      },
    );
  }
  for (const value of statuses) {
    const error = checkStatusValue(operation, "notionActiveStatusValues", value);
    if (error !== undefined) return error;
  }
  for (const [key, value] of mappingEntries(settings.notionStatusMapping)) {
    if (value === null) continue;
    const error = checkStatusValue(operation, `notionStatusMapping.${key}`, value);
    if (error !== undefined) return error;
  }
  if (!settings.enabled) return undefined;
  for (const [field, value] of [
    ["notionDataSourceId", settings.notionDataSourceId],
    ["notionAssigneeUserId", settings.notionAssigneeUserId],
  ] as const) {
    if (value === null || !isNotionId(value)) {
      return refuse(
        "invalid",
        operation,
        `${field} ${quote(value ?? "")} is not a Notion id (32 hex digits or a UUID)`,
        { field },
      );
    }
  }
  const property = (field: string, value: string | null, required: boolean) => {
    if (value === null) {
      return required ? refuse("invalid", operation, `${field} is required`, { field }) : undefined;
    }
    if (
      bytes(value) > HOUSTON_TASK_SOURCE_LIMITS.propertyIdBytes ||
      /[\u0000-\u001f\u007f]/.test(value)
    ) {
      return refuse(
        "invalid",
        operation,
        `${field} ${quote(value)} must be 1 to ${HOUSTON_TASK_SOURCE_LIMITS.propertyIdBytes} bytes without control characters`,
        { field },
      );
    }
    return undefined;
  };
  const projects = settings.notionProjectsDataSourceId;
  for (const [field, value, required] of [
    ["notionTitlePropertyId", settings.notionTitlePropertyId, true],
    ["notionStatusPropertyId", settings.notionStatusPropertyId, true],
    ["notionAssigneePropertyId", settings.notionAssigneePropertyId, true],
    ["notionDescriptionPropertyId", settings.notionDescriptionPropertyId, false],
    ["notionPrUrlPropertyId", settings.notionPrUrlPropertyId, false],
    [
      "notionProjectRelationPropertyId",
      settings.notionProjectRelationPropertyId,
      projects !== null,
    ],
    ["notionProjectTitlePropertyId", settings.notionProjectTitlePropertyId, projects !== null],
    ["notionProjectDescriptionPropertyId", settings.notionProjectDescriptionPropertyId, false],
  ] as const) {
    const error = property(field, value, required);
    if (error !== undefined) return error;
  }
  if (statuses.length === 0) {
    return refuse("invalid", operation, "notionActiveStatusValues needs 1 to 32 statuses", {
      field: "notionActiveStatusValues",
    });
  }
  if (projects !== null && !isNotionId(projects)) {
    return refuse(
      "invalid",
      operation,
      `notionProjectsDataSourceId ${quote(projects)} is not a Notion id (32 hex digits or a UUID)`,
      { field: "notionProjectsDataSourceId" },
    );
  }
  if (
    projects === null &&
    (settings.notionProjectRelationPropertyId !== null ||
      settings.notionProjectTitlePropertyId !== null ||
      settings.notionProjectDescriptionPropertyId !== null)
  ) {
    return refuse(
      "invalid",
      operation,
      "the project relation, title and description need notionProjectsDataSourceId",
      { field: "notionProjectsDataSourceId" },
    );
  }
  return undefined;
};

// Notion schemas.

export interface NotionProperty {
  readonly id: string;
  readonly name: string;
  readonly type: string;
  readonly options: ReadonlyArray<string>;
  /** A relation's target data source. */
  readonly relatedDataSourceId: string | null;
}

type Json = Readonly<Record<string, unknown>>;
const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown) => (typeof value === "string" ? value : null);

/** The properties of a `GET /v1/data_sources/{id}` answer, keyed by id. */
export const notionProperties = (schema: unknown): ReadonlyArray<NotionProperty> => {
  const properties = isObject(schema) && isObject(schema.properties) ? schema.properties : {};
  return Object.entries(properties).flatMap(([name, raw]) => {
    if (!isObject(raw)) return [];
    const type = text(raw.type) ?? "";
    const config = isObject(raw[type]) ? (raw[type] as Json) : {};
    const options = Array.isArray(config.options)
      ? config.options.flatMap((option) =>
          isObject(option) && text(option.name) !== null ? [text(option.name) as string] : [],
        )
      : [];
    return [
      {
        id: text(raw.id) ?? name,
        name,
        type,
        options,
        relatedDataSourceId: text(config.data_source_id),
      },
    ];
  });
};

/** A property by its id, or by its name as Notion also accepts. */
export const findProperty = (properties: ReadonlyArray<NotionProperty>, id: string) =>
  properties.find((property) => property.id === id) ??
  properties.find((property) => property.name === id);

/** The task schema settled from the live data sources; the poll reads with it. */
export interface NotionTaskSchema {
  readonly statusType: "status" | "select";
}

/** Checks configured property ids, types and status options against the live schemas. */
export const checkNotionSchema = (
  operation: string,
  settings: StoredSettings,
  taskSchema: unknown,
  projectsSchema: unknown | null,
): NotionTaskSchema | HoustonTaskSourceError => {
  const task = notionProperties(taskSchema);
  const expect = (
    properties: ReadonlyArray<NotionProperty>,
    label: string,
    field: string,
    id: string | null,
    types: ReadonlyArray<string>,
  ): NotionProperty | HoustonTaskSourceError | null => {
    if (id === null) return null;
    const property = findProperty(properties, id);
    if (property === undefined) {
      return refuse(
        "invalid",
        operation,
        `the ${label} property ${quote(id)} does not exist in the data source`,
        { field },
      );
    }
    if (!types.includes(property.type)) {
      return refuse(
        "invalid",
        operation,
        `the ${label} property ${quote(id)} has type ${property.type}; expected ${types.join(" or ")}`,
        { field },
      );
    }
    return property;
  };
  const checks = [
    ["title", "notionTitlePropertyId", settings.notionTitlePropertyId, ["title"]],
    [
      "description",
      "notionDescriptionPropertyId",
      settings.notionDescriptionPropertyId,
      ["rich_text"],
    ],
    ["status", "notionStatusPropertyId", settings.notionStatusPropertyId, ["status", "select"]],
    ["assignee", "notionAssigneePropertyId", settings.notionAssigneePropertyId, ["people"]],
    [
      "project relation",
      "notionProjectRelationPropertyId",
      settings.notionProjectRelationPropertyId,
      ["relation"],
    ],
    ["pull request URL", "notionPrUrlPropertyId", settings.notionPrUrlPropertyId, ["url"]],
  ] as const;
  let statusType: NotionTaskSchema["statusType"] = "status";
  for (const [label, field, id, types] of checks) {
    const property = expect(task, label, field, id, types);
    if (isRefusal(property)) return property;
    if (property === null) continue;
    if (label === "status") {
      statusType = property.type === "select" ? "select" : "status";
      const values = [
        ...settings.notionActiveStatusValues.map(
          (value) => ["notionActiveStatusValues", value] as const,
        ),
        ...mappingEntries(settings.notionStatusMapping).flatMap(([key, value]) =>
          value === null ? [] : [[`notionStatusMapping.${key}`, value] as const],
        ),
      ];
      for (const [valueField, value] of values) {
        if (!property.options.includes(value)) {
          return refuse(
            "invalid",
            operation,
            `${quote(value)} is not an option of the status property ${quote(property.name)}`,
            { field: valueField },
          );
        }
      }
    }
    if (label === "project relation" && settings.notionProjectsDataSourceId !== null) {
      const related = property.relatedDataSourceId?.replaceAll("-", "").toLowerCase();
      if (related !== settings.notionProjectsDataSourceId.replaceAll("-", "").toLowerCase()) {
        return refuse(
          "invalid",
          operation,
          `the project relation ${quote(property.name)} points to data source ${quote(property.relatedDataSourceId ?? "none")}, not the projects data source`,
          { field },
        );
      }
    }
  }
  if (projectsSchema !== null) {
    const projects = notionProperties(projectsSchema);
    for (const [label, field, id, types] of [
      [
        "project title",
        "notionProjectTitlePropertyId",
        settings.notionProjectTitlePropertyId,
        ["title"],
      ],
      [
        "project description",
        "notionProjectDescriptionPropertyId",
        settings.notionProjectDescriptionPropertyId,
        ["rich_text"],
      ],
    ] as const) {
      const property = expect(projects, label, field, id, types);
      if (isRefusal(property)) return property;
    }
  }
  return { statusType };
};

// Remote records.

/** One tracker item as a poll read it. `fields` hold title, description and status. */
export interface RemoteRecord {
  readonly externalId: string;
  readonly url: string;
  readonly remoteRev: string | null;
  readonly fields: Readonly<Record<string, string>>;
  readonly project: HoustonTaskSourceProjectSnapshot | null;
}

export const githubMilestoneKey = (repository: string, number: number) =>
  `github_issues:${repository}:milestone:${number}`;

const logins = (value: unknown): ReadonlyArray<string> =>
  Array.isArray(value)
    ? value.flatMap((entry) => {
        const login = isObject(entry) ? text(entry.login) : text(entry);
        return login === null ? [] : [login];
      })
    : [];

/** An issue matches when it carries the label or is assigned to the user (case-insensitive). */
export const githubMatches = (issue: unknown, settings: StoredSettings): boolean => {
  if (!isObject(issue)) return false;
  const label = settings.githubLabel;
  const labelled =
    label !== null &&
    Array.isArray(issue.labels) &&
    issue.labels.some((entry) => (isObject(entry) ? text(entry.name) : text(entry)) === label);
  const user = settings.githubAssignedUser?.toLowerCase() ?? null;
  const assignees = [
    ...logins(issue.assignees),
    ...(isObject(issue.assignee) && text(issue.assignee.login) !== null
      ? [text(issue.assignee.login) as string]
      : []),
  ];
  const assigned = user !== null && assignees.some((login) => login.toLowerCase() === user);
  return labelled || assigned;
};

/** A GitHub issue as a record; null for a pull request or an issue without a number or URL. */
export const githubRecord = (issue: unknown, repository: string): RemoteRecord | null => {
  if (!isObject(issue)) return null;
  if (issue.pull_request !== undefined && issue.pull_request !== null) return null;
  const number = typeof issue.number === "number" ? issue.number : null;
  const url = text(issue.html_url);
  if (number === null || url === null) return null;
  const milestone = isObject(issue.milestone) ? issue.milestone : null;
  const milestoneNumber =
    milestone !== null && typeof milestone.number === "number" ? milestone.number : null;
  return {
    externalId: `${repository}#${number}`,
    url,
    remoteRev: text(issue.updated_at),
    fields: {
      title: cutChars(text(issue.title) ?? "", RECORD_LIMITS.titleChars),
      description: cutChars(text(issue.body) ?? "", RECORD_LIMITS.githubBodyChars),
      status: issue.state === "closed" ? "done" : "todo",
    },
    project:
      milestone === null || milestoneNumber === null
        ? null
        : {
            externalId: githubMilestoneKey(repository, milestoneNumber),
            url: text(milestone.html_url) ?? "",
            title: cutChars(text(milestone.title) ?? "", RECORD_LIMITS.titleChars),
            description: cutChars(
              text(milestone.description) ?? "",
              RECORD_LIMITS.milestoneDescriptionChars,
            ),
            unverified: true,
          },
  };
};

/** The paging state GitHub reads keep: each page's ETag and size, for the filter it read. */
export interface GithubCursor {
  readonly repository: string | null;
  readonly label: string | null;
  readonly assignedUser: string | null;
  readonly pages: Readonly<
    Record<string, { readonly etag: string | null; readonly count: number }>
  >;
}

/** Stored ETags only revalidate pages read for the same repository and filter. */
export const githubCursorFits = (cursor: GithubCursor, settings: StoredSettings) =>
  cursor.repository === settings.githubRepository &&
  cursor.label === settings.githubLabel &&
  cursor.assignedUser === settings.githubAssignedUser;

// Notion records.

const richText = (value: unknown) =>
  Array.isArray(value)
    ? value.map((part) => (isObject(part) ? (text(part.plain_text) ?? "") : "")).join("")
    : "";

const propertyValue = (page: Json, id: string): Json | null => {
  const properties = isObject(page.properties) ? page.properties : {};
  for (const [name, value] of Object.entries(properties)) {
    if (isObject(value) && (value.id === id || name === id)) return value;
  }
  return null;
};

export const notionText = (page: Json, id: string, kind: string): string | null => {
  const property = propertyValue(page, id);
  if (property === null) return null;
  if (kind === "title" || kind === "rich_text") return richText(property[kind]);
  if (kind === "status" || kind === "select") {
    const option = property[kind];
    return isObject(option) ? text(option.name) : null;
  }
  return null;
};

/** The task status a Notion status option maps to; an unmapped option is `backlog`. */
export const notionStatus = (option: string | null, mapping: HoustonTaskSourceStatusMapping) => {
  if (option === null) return "backlog";
  const found = (
    [
      [mapping.todo, "todo"],
      [mapping.inProgress, "in_progress"],
      [mapping.inReview, "in_review"],
      [mapping.done, "done"],
      [mapping.canceled, "canceled"],
    ] as const
  ).find(([configured]) => configured === option);
  return found?.[1] ?? "backlog";
};

/** A Notion page as a record without its project; the error names what the page lacks. */
export const notionRecord = (
  page: unknown,
  settings: StoredSettings,
  schema: NotionTaskSchema,
): RemoteRecord | string => {
  if (!isObject(page) || page.object !== "page") return "a query result is not a page";
  const id = text(page.id);
  if (id === null || !isNotionId(id)) return "a page has no Notion id";
  const url = text(page.url);
  if (url === null) return `page ${id} has no URL`;
  const title = notionText(page, settings.notionTitlePropertyId ?? "", "title");
  if (title === null) return `page ${id} has no title property`;
  const description =
    settings.notionDescriptionPropertyId === null
      ? ""
      : (notionText(page, settings.notionDescriptionPropertyId, "rich_text") ?? "");
  const option = notionText(page, settings.notionStatusPropertyId ?? "", schema.statusType);
  return {
    externalId: id,
    url,
    remoteRev: text(page.last_edited_time),
    fields: {
      title: cutChars(title, RECORD_LIMITS.titleChars),
      description: cutChars(description, RECORD_LIMITS.notionDescriptionChars),
      status: notionStatus(option, settings.notionStatusMapping),
    },
    project: null,
  };
};

/** The ids a page's project relation names, in order. */
export const notionRelatedIds = (page: unknown, relationId: string): ReadonlyArray<string> => {
  if (!isObject(page)) return [];
  const property = propertyValue(page, relationId);
  const relation = property?.relation;
  return Array.isArray(relation)
    ? relation.flatMap((entry) =>
        isObject(entry) && text(entry.id) !== null ? [text(entry.id) as string] : [],
      )
    : [];
};

const sameNotionId = (left: string | null, right: string) =>
  left !== null &&
  left.replaceAll("-", "").toLowerCase() === right.replaceAll("-", "").toLowerCase();

/** A related project page as an initiative snapshot, or why the record is skipped. */
export const notionProject = (
  page: unknown,
  settings: StoredSettings,
): HoustonTaskSourceProjectSnapshot | string => {
  const projects = settings.notionProjectsDataSourceId ?? "";
  if (!isObject(page) || page.object !== "page") return "a related project is not a page";
  const id = text(page.id) ?? "";
  const parent = isObject(page.parent) ? text(page.parent.data_source_id) : null;
  if (!sameNotionId(parent, projects)) {
    return `related page ${id} belongs to data source ${parent ?? "none"}, not the projects data source ${projects}`;
  }
  const title = notionText(page, settings.notionProjectTitlePropertyId ?? "", "title");
  if (title === null) return `related page ${id} has no project title property`;
  const description =
    settings.notionProjectDescriptionPropertyId === null
      ? ""
      : (notionText(page, settings.notionProjectDescriptionPropertyId, "rich_text") ?? "");
  return {
    externalId: `notion:${projects}:${id}`,
    url: text(page.url) ?? "",
    title: cutChars(title, RECORD_LIMITS.titleChars),
    description: cutChars(description, RECORD_LIMITS.notionDescriptionChars),
    unverified: true,
  };
};

/** The query body of one Notion page of results. Property ids are sent as configured. */
export const notionQueryBody = (
  settings: StoredSettings,
  schema: NotionTaskSchema,
  since: string,
  startCursor: string | null,
) => {
  const status = settings.notionStatusPropertyId ?? "";
  const active = settings.notionActiveStatusValues.map((value) => ({
    property: status,
    [schema.statusType]: { equals: value },
  }));
  return {
    filter: {
      and: [
        { timestamp: "last_edited_time", last_edited_time: { on_or_after: since } },
        {
          property: settings.notionAssigneePropertyId ?? "",
          people: { contains: settings.notionAssigneeUserId ?? "" },
        },
        active.length === 1 ? active[0] : { or: active },
      ],
    },
    sorts: [{ timestamp: "last_edited_time", direction: "ascending" }],
    page_size: NOTION_PAGE_SIZE,
    ...(startCursor === null ? {} : { start_cursor: startCursor }),
  };
};

/** Where Notion reads resume: the checkpoint and, mid-batch, the query being continued. */
export interface NotionCursor {
  readonly lastEditedTime: string | null;
  readonly continuation: {
    readonly since: string;
    readonly startedAt: string;
    readonly queryCursor: string;
  } | null;
}

export const NOTION_EPOCH = "1970-01-01T00:00:00.000Z";

/** The query a poll starts from: the kept continuation, else everything since the checkpoint. */
export const notionPollStart = (cursor: NotionCursor, now: string) =>
  cursor.continuation ?? {
    since: cursor.lastEditedTime ?? NOTION_EPOCH,
    startedAt: now,
    queryCursor: null as string | null,
  };

/** The checkpoint moves to the poll's start only once the last page was read. */
export const notionPollEnd = (
  cursor: NotionCursor,
  start: ReturnType<typeof notionPollStart>,
  next: string | null,
): NotionCursor =>
  next === null
    ? { lastEditedTime: start.startedAt, continuation: null }
    : {
        lastEditedTime: cursor.lastEditedTime,
        continuation: { since: start.since, startedAt: start.startedAt, queryCursor: next },
      };

/** Why a record cannot be stored, or null. */
export const recordOverBound = (record: RemoteRecord): string | null => {
  const snapshot = bytes(JSON.stringify({ fields: record.fields, project: record.project }));
  if (snapshot > RECORD_LIMITS.snapshotBytes) {
    return `${record.externalId}: snapshot is ${snapshot} bytes, over the limit of ${RECORD_LIMITS.snapshotBytes}`;
  }
  if (
    record.project !== null &&
    chars(record.project.externalId) > RECORD_LIMITS.initiativeKeyChars
  ) {
    return `${record.externalId}: initiative key is ${chars(record.project.externalId)} characters, over the limit of ${RECORD_LIMITS.initiativeKeyChars}`;
  }
  for (const url of [record.url, record.project?.url ?? ""]) {
    if (bytes(url) > RECORD_LIMITS.urlBytes) {
      return `${record.externalId}: URL is ${bytes(url)} bytes, over the limit of ${RECORD_LIMITS.urlBytes}`;
    }
  }
  if ((record.fields.title ?? "").trim().length === 0) return `${record.externalId}: has no title`;
  if (!isTaskStatus(record.fields.status)) {
    return `${record.externalId}: status ${quote(record.fields.status ?? "")} is not a task status`;
  }
  return null;
};

// The three-way merge.

export const TASK_FIELDS = ["title", "description", "status"] as const;
export type TaskField = (typeof TASK_FIELDS)[number];
const PROJECT_FIELDS = ["project.title", "project.description", "project.identity"];

export const firstSnapshot = (record: RemoteRecord): HoustonTaskSourceSnapshot => ({
  base: { ...record.fields },
  local: { ...record.fields },
  remote: { ...record.fields },
  conflicts: [],
  revision: 1,
  projectExternalId: record.project?.externalId ?? null,
  project: record.project,
});

/** Remote equal to local moves the base; equal to the base keeps local; else a lasting conflict. */
export const mergeTaskFields = (
  previous: HoustonTaskSourceSnapshot,
  live: Readonly<Record<TaskField, string>>,
  record: RemoteRecord,
): HoustonTaskSourceSnapshot => {
  const base: Record<string, string> = { ...previous.base };
  const local: Record<string, string> = {};
  const conflicts: Array<HoustonTaskSourceConflict> = [];
  for (const field of TASK_FIELDS) {
    const liveValue = live[field];
    const remoteValue = record.fields[field] ?? liveValue;
    const baseValue = previous.base[field] ?? liveValue;
    const recorded = previous.conflicts.find((conflict) => conflict.field === field);
    local[field] = liveValue;
    if (recorded !== undefined) {
      conflicts.push({ field, base: recorded.base, local: liveValue, remote: remoteValue });
    } else if (remoteValue === liveValue) {
      base[field] = remoteValue;
    } else if (remoteValue !== baseValue) {
      conflicts.push({ field, base: baseValue, local: liveValue, remote: remoteValue });
    }
  }
  const kept = previous.conflicts.filter((conflict) => PROJECT_FIELDS.includes(conflict.field));
  for (const field of PROJECT_FIELDS) {
    if (previous.local[field] !== undefined) local[field] = previous.local[field];
  }
  return {
    ...previous,
    base,
    local,
    remote: { ...record.fields },
    conflicts: [...conflicts, ...kept],
  };
};

/** The initiative a record names, as the store holds it. */
export interface LocalInitiative {
  readonly name: string;
  readonly description: string;
}

/** The same rule over the initiative's title, description and identity (null: same initiative). */
export const mergeProject = (input: {
  readonly previous: HoustonTaskSourceSnapshot | null;
  readonly merged: HoustonTaskSourceSnapshot;
  readonly project: HoustonTaskSourceProjectSnapshot;
  /** Null when the initiative was created by this record. */
  readonly initiative: LocalInitiative | null;
  readonly localIdentity: string | null;
  /** The initiative's last remote values from another link; the base of a first link into it. */
  readonly lastRemote?: HoustonTaskSourceProjectSnapshot | null;
}): HoustonTaskSourceSnapshot => {
  const { previous, merged, project } = input;
  const key = project.externalId;
  const lastRemote = previous === null ? (input.lastRemote ?? null) : null;
  const recorded = (field: string) =>
    previous?.conflicts.find((conflict) => conflict.field === field);
  const previousBase =
    previous !== null && previous.projectExternalId === key
      ? (previous.base["project.description"] ?? previous.project?.description ?? "")
      : (lastRemote?.description ?? "");
  const conflicts: Array<HoustonTaskSourceConflict> = [];
  let localTitle = project.title;
  let localDescription = project.description;
  if (input.initiative !== null) {
    localTitle = input.initiative.name;
    localDescription = input.initiative.description;
    const titleBase = previous?.project?.title ?? lastRemote?.title ?? localTitle;
    const title = recorded("project.title");
    if (title !== undefined) {
      conflicts.push({
        field: "project.title",
        base: title.base,
        local: localTitle,
        remote: project.title,
      });
    } else if (project.title !== localTitle && project.title !== titleBase) {
      conflicts.push({
        field: "project.title",
        base: titleBase,
        local: localTitle,
        remote: project.title,
      });
    }
    const description = recorded("project.description");
    if (description !== undefined) {
      conflicts.push({
        field: "project.description",
        base: description.base,
        local: localDescription,
        remote: project.description,
      });
    } else if (project.description !== localDescription && project.description !== previousBase) {
      conflicts.push({
        field: "project.description",
        base: previousBase,
        local: localDescription,
        remote: project.description,
      });
    }
  }
  // A recorded conflict outlives a change of initiative too; only a resolution removes it.
  for (const field of ["project.title", "project.description"]) {
    const kept = recorded(field);
    if (kept !== undefined && !conflicts.some((conflict) => conflict.field === field)) {
      conflicts.push(kept);
    }
  }
  let identity: HoustonTaskSourceConflict | undefined;
  if (input.localIdentity !== null) {
    const recordedIdentity = recorded("project.identity");
    const identityBase = recordedIdentity?.base ?? previous?.base["project.identity"] ?? "";
    if (recordedIdentity !== undefined || key !== identityBase) {
      identity = {
        field: "project.identity",
        base: identityBase,
        local: input.localIdentity,
        remote: key,
      };
    }
  }
  const titleConflict = conflicts.find((conflict) => conflict.field === "project.title");
  const descriptionConflict = conflicts.find(
    (conflict) => conflict.field === "project.description",
  );
  return {
    ...merged,
    projectExternalId: key,
    project,
    base: {
      ...merged.base,
      "project.title": titleConflict?.base ?? project.title,
      "project.description": descriptionConflict === undefined ? project.description : previousBase,
      "project.identity": identity?.base ?? previous?.base["project.identity"] ?? key,
    },
    local: {
      ...merged.local,
      "project.title": localTitle,
      "project.description": localDescription,
      "project.identity": identity?.local ?? key,
    },
    remote: {
      ...merged.remote,
      "project.title": project.title,
      "project.description": project.description,
      "project.identity": key,
    },
    conflicts: [
      ...merged.conflicts.filter((conflict) => !PROJECT_FIELDS.includes(conflict.field)),
      ...conflicts,
      ...(identity === undefined ? [] : [identity]),
    ],
  };
};

const sameRecord = (
  left: Readonly<Record<string, string>>,
  right: Readonly<Record<string, string>>,
) => {
  const leftKeys = Object.keys(left).toSorted();
  const rightKeys = Object.keys(right).toSorted();
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every((key, index) => key === rightKeys[index] && left[key] === right[key])
  );
};

export const sameSnapshot = (left: HoustonTaskSourceSnapshot, right: HoustonTaskSourceSnapshot) =>
  sameRecord(left.base, right.base) &&
  sameRecord(left.local, right.local) &&
  sameRecord(left.remote, right.remote) &&
  JSON.stringify(left.conflicts) === JSON.stringify(right.conflicts) &&
  left.projectExternalId === right.projectExternalId &&
  JSON.stringify(left.project) === JSON.stringify(right.project);

/** The next snapshot's revision moves only when something in it changed. */
export const withRevision = (
  previous: HoustonTaskSourceSnapshot,
  next: HoustonTaskSourceSnapshot,
): HoustonTaskSourceSnapshot =>
  sameSnapshot(previous, next)
    ? { ...next, revision: previous.revision }
    : { ...next, revision: previous.revision + 1 };

export const syncStateOf = (snapshot: HoustonTaskSourceSnapshot): HoustonTaskSourceSyncState => {
  if (snapshot.conflicts.length > 0) return { state: "diverged" };
  const pending = Object.entries(snapshot.local).some(
    ([field, value]) => snapshot.remote[field] !== undefined && snapshot.remote[field] !== value,
  );
  return { state: pending ? "pending" : "current" };
};

/** The value a resolution picks for a conflicted field. */
export const resolvedValue = (
  resolution: "local" | "remote" | { readonly custom: string },
  live: string,
  remote: string,
) => (resolution === "local" ? live : resolution === "remote" ? remote : resolution.custom);

/** After a resolution: the chosen value is local, the remote value the new base. */
export const resolveInSnapshot = (
  snapshot: HoustonTaskSourceSnapshot,
  field: string,
  chosen: string,
  remote: string,
): HoustonTaskSourceSnapshot => ({
  ...snapshot,
  local: { ...snapshot.local, [field]: chosen },
  base: { ...snapshot.base, [field]: remote },
  remote: { ...snapshot.remote, [field]: remote },
  conflicts: snapshot.conflicts.filter((conflict) => conflict.field !== field),
  revision: snapshot.revision + 1,
});

export const errorText = (message: string) => cutChars(message, RECORD_LIMITS.errorChars);

// Write-back.

export const OUTBOX_BATCH = 25;
export const OUTBOX_MAX_DELAY_MS = 3_600_000;
export const WRITE_LIMITS = {
  issueTitleChars: 500,
  issueBodyChars: 7_600,
  statusSummaryChars: 2_000,
  summaryChars: 3_500,
  notionSummaryChars: 11_500,
  notionChunkChars: 2_000,
  notionChunks: 6,
  /** Comment pages read to find a marker before posting. */
  notionCommentPages: 5,
} as const;

export const WRITEBACK_TRANSITIONS = [
  "created",
  "updated",
  "handed_back",
  "merged",
  "delivery_rolled_up",
] as const;
export type WritebackTransition = (typeof WRITEBACK_TRANSITIONS)[number];

/** The receipt of a row that live state no longer asks for. */
export const SUPERSEDED = { superseded: true } as const;

/** 1 second × 2^attempts, at most an hour. */
export const retryDelayMillis = (attempts: number) =>
  Math.min(1_000 * 2 ** Math.min(attempts, 12), OUTBOX_MAX_DELAY_MS);

export const taskIdentity = (namespace: string, taskId: number) =>
  `houston-task-${namespace}-${taskId}`;

/** A marker ends with an HMAC of what it names under the installation's marker key, which never
 * leaves the database: what a public marker shows does not let anyone write the next one. */
const keyedMarker = (kind: string, name: string, key: string) =>
  `<!-- ${kind}:${name}:${NodeCrypto.createHmac("sha256", key)
    .update(`${kind}:${name}`)
    .digest("hex")
    .slice(0, 32)} -->`;

export const deliveryMarker = (namespace: string, key: string, taskId: number) =>
  keyedMarker(
    "houston-delivery",
    `${taskIdentity(namespace, taskId)}:delivery-${namespace}-${taskId}`,
    key,
  );

/** A comment's marker; `transitionId` is the outbox row's id, the same on every retry. */
export const commentMarker = (
  key: string,
  identity: string,
  transitionId: number,
  action: string,
) => keyedMarker("houston-task", `${identity}:${transitionId}:${action}`, key);

/** Whether `body` ends with `marker`, where Houston writes it, rather than merely quoting it. */
export const endsWithMarker = (body: string, marker: string) => body.trimEnd().endsWith(marker);

const CLOSE_KEYWORDS = /\b(?:close|closes|closed|fix|fixes|fixed|resolve|resolves|resolved)\b/gi;

/** GitHub closes an issue a comment or body names with these words; they are dropped. */
export const withoutCloseKeywords = (text: string) => text.replaceAll(CLOSE_KEYWORDS, "");

// `@user`, `@org/team`, `#12` and `owner/repo#12`, not inside a word, an address or inline code.
const MENTIONS_AND_REFERENCES =
  /(?<![\w`/.@-])(?:@[A-Za-z0-9][A-Za-z0-9-]*(?:\/[A-Za-z0-9][\w.-]*)?|(?:[A-Za-z0-9][\w.-]*\/[\w.-]+)?#[0-9]+)(?![\w`])/g;

/** Text copied from a task to GitHub: close keywords dropped, and mentions and references wrapped
 * in inline code, so the copy neither notifies, links nor closes anything. */
export const neutralise = (text: string) =>
  withoutCloseKeywords(text).replaceAll(MENTIONS_AND_REFERENCES, (match) => `\`${match}\``);

/** `https://github.com/<repository>/pull/<n>` of the same repository, or null. */
export const githubPullRequestUrl = (url: string, repository: string): string | null => {
  const prefix = `https://github.com/${repository}/pull/`;
  if (!url.startsWith(prefix)) return null;
  const number = url.slice(prefix.length);
  return /^[1-9][0-9]*$/.test(number) ? url : null;
};

/** The issue number of a GitHub source link `owner/repo#N` in `repository`, or null. */
export const issueNumberOf = (externalId: string, repository: string): number | null => {
  const [repo, number] = externalId.split("#");
  return repo === repository && number !== undefined && /^[1-9][0-9]*$/.test(number)
    ? Number(number)
    : null;
};

export interface WritebackLink {
  readonly provider: HoustonTaskSourceProvider;
  readonly source: "source" | "pull_request";
  readonly externalId: string;
  readonly url: string;
}

/** A task as write-back reads it. */
export interface WritebackTask {
  readonly id: number;
  readonly projectId: string | null;
  readonly title: string;
  readonly description: string;
  readonly status: string;
  readonly revision: number;
  readonly domain: {
    readonly kind: "delivery" | "slice";
    readonly initiativeId: number | null;
    readonly userStatusOverride: boolean;
  } | null;
  readonly links: ReadonlyArray<WritebackLink>;
}

export interface WritebackInput {
  readonly transition: string;
  readonly task: WritebackTask;
  /** A slice's parent delivery. */
  readonly delivery: WritebackTask | null;
  /** The providers enabled for the task's project. */
  readonly enabled: ReadonlyArray<HoustonTaskSourceProvider>;
  readonly statusChanged: boolean;
  /** A delivery's slices. */
  readonly slices: { readonly total: number; readonly done: number };
  /** The latest run summary and pull request of the task. */
  readonly summary: string | null;
  readonly prUrl: string | null;
  readonly namespace: string;
  /** The installation's marker key. */
  readonly markerKey: string;
}

export interface OutboxEntry {
  readonly taskId: number;
  readonly provider: HoustonTaskSourceProvider;
  readonly action: string;
  readonly revision: number;
  readonly payload: Readonly<Record<string, unknown>>;
}

const sourceLink = (task: WritebackTask, provider: HoustonTaskSourceProvider) =>
  task.links.find((link) => link.provider === provider && link.source === "source");

/** The rows a committed transition enqueues, as Houston 1 decided them; a string refuses it. */
export const writebackActions = (input: WritebackInput): ReadonlyArray<OutboxEntry> | string => {
  const { transition, task, namespace } = input;
  if (!(WRITEBACK_TRANSITIONS as ReadonlyArray<string>).includes(transition)) {
    return `unknown task transition ${quote(transition)}; expected one of ${WRITEBACK_TRANSITIONS.join(", ")}`;
  }
  if (task.projectId === null || task.domain === null) return [];
  const kind = task.domain.kind;
  const entries: Array<OutboxEntry> = [];
  for (const provider of input.enabled) {
    // A slice's handback and merge report on its delivery's issue or page.
    const redirected =
      kind === "slice" && (transition === "handed_back" || transition === "merged");
    const target = redirected ? input.delivery : task;
    if (target === null || target.projectId !== task.projectId || target.domain === null) continue;
    if (redirected && target.domain.kind !== "delivery") continue;
    const source = sourceLink(target, provider);
    const entry = (action: string, revision: number, payload: Record<string, unknown>) =>
      entries.push({ taskId: task.id, provider, action, revision, payload });
    const delivered = target.id === task.id ? {} : { deliveryTaskId: target.id };
    if (
      (transition === "created" || transition === "updated") &&
      kind === "delivery" &&
      task.domain.initiativeId !== null &&
      source === undefined &&
      provider === "github_issues"
    ) {
      entry("create", task.revision, {
        marker: deliveryMarker(namespace, input.markerKey, task.id),
        title: task.title,
        description: task.description,
      });
      continue;
    }
    if (source === undefined) continue;
    const github = provider === "github_issues";
    const status = (revision: number) =>
      entry(
        "status",
        revision,
        github
          ? {
              ...delivered,
              taskIdentity: taskIdentity(namespace, target.id),
              status: target.status,
              revision: target.revision,
            }
          : { ...delivered, externalId: source.externalId, status: target.status },
      );
    const close = () =>
      entries.push({
        taskId: target.id,
        provider,
        action: "delivery_close",
        revision: target.revision,
        payload: {},
      });
    const summary = () => {
      const text = `${task.title}: ${input.summary ?? task.description}`;
      entry(github ? "summary_comment" : "handback_summary", task.revision, {
        ...delivered,
        taskIdentity: taskIdentity(namespace, task.id),
        summary: text,
        revision: task.revision,
      });
    };
    const pullRequest = () => {
      if (input.prUrl === null) return;
      entry(github ? "pr_reference" : "pull_request_url", task.revision, {
        ...delivered,
        taskIdentity: taskIdentity(namespace, task.id),
        url: input.prUrl,
        revision: task.revision,
      });
    };
    const overridden = target.status === "done" && target.domain.userStatusOverride;
    switch (transition) {
      case "updated":
        if (!input.statusChanged) break;
        status(task.revision);
        if (github && kind === "delivery" && overridden) close();
        break;
      case "handed_back":
        status(task.revision);
        summary();
        pullRequest();
        break;
      case "merged":
        summary();
        pullRequest();
        break;
      case "delivery_rolled_up": {
        if (kind !== "delivery") break;
        const allDone = input.slices.total > 0 && input.slices.done === input.slices.total;
        if (github && (allDone || overridden)) close();
        else if (!github) status(target.revision);
        break;
      }
    }
  }
  // The GitHub payloads name the issue; the drain checks it against the live link.
  return entries.map((entry) => {
    const target = entry.payload.deliveryTaskId === undefined ? task : input.delivery;
    const link = target === null ? undefined : sourceLink(target, entry.provider);
    const number = link?.externalId.split("#")[1];
    return entry.provider === "github_issues" && number !== undefined
      ? { ...entry, payload: { ...entry.payload, issueNumber: Number(number) } }
      : entry;
  });
};

/** A GitHub status comment: the status, an optional summary and the marker. */
export const statusComment = (status: string, summary: string, marker: string) =>
  `Task status: ${status}\n${neutralise(cutChars(summary, WRITE_LIMITS.statusSummaryChars))}\n${marker}`;

/** The marker of a Notion handback comment: a hash of the page and the summary. */
export const notionHandbackMarker = (hash: string) => `houston-handback:${hash.slice(0, 24)}`;
