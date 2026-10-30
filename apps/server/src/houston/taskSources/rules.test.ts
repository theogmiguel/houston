import { describe, expect, it } from "@effect/vitest";
import {
  HoustonTaskSourceError,
  type HoustonTaskSourceSettingsInput,
  type HoustonTaskSourceSnapshot,
} from "@t3tools/contracts/houston/taskSources";

import {
  checkGithubSettings,
  checkNotionSettings,
  firstSnapshot,
  githubMatches,
  githubRecord,
  mergeTaskFields,
  notionPollEnd,
  notionPollStart,
  notionProject,
  notionRecord,
  storedSettings,
  syncStateOf,
  withRevision,
  type NotionCursor,
  type RemoteRecord,
} from "./rules.ts";

const OP = "houston.taskSources.settings.set";

const github = (patch: Partial<HoustonTaskSourceSettingsInput>) =>
  storedSettings({ enabled: true, githubRepository: "octo-org/project", ...patch });

describe("github settings require owner/name and a filter", () => {
  it("octo-org/project with label import is accepted", () => {
    expect(checkGithubSettings(OP, github({ githubLabel: "import" }))).toBeUndefined();
    expect(checkGithubSettings(OP, github({ githubAssignedUser: "theo" }))).toBeUndefined();
  });

  const refused = [
    { name: "neither label nor assignee", patch: {}, field: "githubLabel", quoted: null },
    {
      name: "a host and query (the strong case)",
      patch: { githubRepository: "evil.example/path?token=x", githubLabel: "import" },
      field: "githubRepository",
      quoted: "evil.example/path?token=x",
    },
    {
      name: "three parts",
      patch: { githubRepository: "a/b/c", githubLabel: "import" },
      field: "githubRepository",
      quoted: "a/b/c",
    },
    {
      name: "a dot part",
      patch: { githubRepository: "./x", githubLabel: "import" },
      field: "githubRepository",
      quoted: "./x",
    },
    {
      name: "a dot-dot part",
      patch: { githubRepository: "a/..", githubLabel: "import" },
      field: "githubRepository",
      quoted: "a/..",
    },
    {
      name: "a long value, quoted to 120 characters",
      patch: { githubRepository: `${"o".repeat(150)}/x y`, githubLabel: "import" },
      field: "githubRepository",
      quoted: "o".repeat(120),
    },
  ] as const;

  it.each(refused)("$name is invalid naming the field", ({ patch, field, quoted }) => {
    const error = checkGithubSettings(OP, github(patch));
    expect(error).toBeInstanceOf(HoustonTaskSourceError);
    expect(error?.kind).toBe("invalid");
    expect(error?.field).toBe(field);
    expect(error?.message).toContain(field);
    if (quoted !== null) expect(error?.message).toContain(JSON.stringify(quoted));
    if (field === "githubRepository") expect(error?.message).not.toContain("o".repeat(121));
  });

  it("disabled settings are not checked", () => {
    expect(
      checkGithubSettings(OP, storedSettings({ enabled: false, githubRepository: "a/b/c" })),
    ).toBeUndefined();
  });
});

const NOTION_ID = "0123456789abcdef0123456789abcdef";
const notion = (patch: Partial<HoustonTaskSourceSettingsInput>) =>
  storedSettings({
    enabled: true,
    notionDataSourceId: NOTION_ID,
    notionTitlePropertyId: "title",
    notionStatusPropertyId: "St%3Aa",
    notionAssigneePropertyId: "a%2Fb",
    notionAssigneeUserId: "11111111-2222-3333-4444-555555555555",
    notionActiveStatusValues: ["Ready"],
    ...patch,
  });

describe("notion settings are bounded and name the offending value", () => {
  it("a complete configuration passes", () => {
    expect(checkNotionSettings(OP, notion({}))).toBeUndefined();
  });

  it("a 31-hex data source id is invalid", () => {
    const error = checkNotionSettings(OP, notion({ notionDataSourceId: NOTION_ID.slice(1) }));
    expect(error?.kind).toBe("invalid");
    expect(error?.field).toBe("notionDataSourceId");
  });

  it("32 active statuses are accepted, 33 are a limit naming 32 and 33", () => {
    const statuses = (n: number) => Array.from({ length: n }, (_, index) => `S${index}`);
    expect(
      checkNotionSettings(OP, notion({ notionActiveStatusValues: statuses(32) })),
    ).toBeUndefined();
    const error = checkNotionSettings(OP, notion({ notionActiveStatusValues: statuses(33) }));
    expect(error).toMatchObject({ kind: "limit", limit: 32, actual: 33 });
    expect(error?.message).toMatch(/33.*32/);
  });

  it("a 101-byte mapping is a limit naming 100 and 101 and quoting its first 64 characters", () => {
    const value = `${"m".repeat(64)}${"z".repeat(37)}`;
    const error = checkNotionSettings(
      OP,
      notion({
        notionStatusMapping: {
          todo: value,
          inProgress: null,
          inReview: null,
          done: null,
          canceled: null,
        },
      }),
    );
    expect(error).toMatchObject({ kind: "limit", limit: 100, actual: 101 });
    expect(error?.message).toContain(JSON.stringify("m".repeat(64)));
    expect(error?.message).not.toContain("z");
    const fits = checkNotionSettings(
      OP,
      notion({
        notionStatusMapping: {
          todo: "m".repeat(100),
          inProgress: null,
          inReview: null,
          done: null,
          canceled: null,
        },
      }),
    );
    expect(fits).toBeUndefined();
  });

  it("a blank active status is invalid quoting it", () => {
    const error = checkNotionSettings(OP, notion({ notionActiveStatusValues: ["Ready", "  "] }));
    expect(error?.kind).toBe("invalid");
    expect(error?.message).toContain(JSON.stringify("  "));
  });

  it("a projects source without a relation property is invalid", () => {
    const error = checkNotionSettings(
      OP,
      notion({ notionProjectsDataSourceId: NOTION_ID, notionProjectTitlePropertyId: "title" }),
    );
    expect(error?.kind).toBe("invalid");
    expect(error?.field).toBe("notionProjectRelationPropertyId");
  });
});

const issue = (patch: Record<string, unknown>) => ({
  number: 42,
  html_url: "https://github.com/octo-org/project/issues/42",
  title: "Issue",
  body: "Body",
  state: "open",
  updated_at: "2026-10-01T00:00:00Z",
  labels: [],
  assignee: null,
  assignees: [],
  milestone: null,
  ...patch,
});

describe("github issues filter by label or assignee and map to tasks", () => {
  const filter = github({ githubLabel: "import", githubAssignedUser: "theo" });
  const cases = [
    { name: "label import", issue: issue({ labels: [{ name: "import" }] }), matches: true },
    {
      name: "assignee THEO for theo",
      issue: issue({ assignee: { login: "THEO" }, assignees: [{ login: "THEO" }] }),
      matches: true,
    },
    {
      name: "a second assignee THEO",
      issue: issue({ assignees: [{ login: "ana" }, { login: "THEO" }] }),
      matches: true,
    },
    {
      name: "assignee other",
      issue: issue({ assignee: { login: "other" }, assignees: [{ login: "other" }] }),
      matches: false,
    },
  ] as const;

  it.each(cases)("$name", ({ issue: raw, matches }) => {
    expect(githubMatches(raw, filter)).toBe(matches);
    expect(githubRecord(raw, "octo-org/project")).not.toBeNull();
  });

  it("a pull request with the label is skipped", () => {
    const pull = issue({ labels: [{ name: "import" }], pull_request: { url: "x" } });
    expect(githubMatches(pull, filter)).toBe(true);
    expect(githubRecord(pull, "octo-org/project")).toBeNull();
  });

  it("maps title, body, state, id and milestone within their bounds", () => {
    const record = githubRecord(
      issue({
        title: "t".repeat(250),
        body: "b".repeat(9_000),
        state: "closed",
        milestone: {
          number: 7,
          title: "Milestone",
          description: "d".repeat(5_000),
          html_url: "https://github.com/octo-org/project/milestone/7",
        },
      }),
      "octo-org/project",
    );
    expect(record?.externalId).toBe("octo-org/project#42");
    expect(record?.url).toBe("https://github.com/octo-org/project/issues/42");
    expect(record?.fields.title).toHaveLength(200);
    expect(record?.fields.description).toHaveLength(8_000);
    expect(record?.fields.status).toBe("done");
    expect(record?.project).toEqual({
      externalId: "github_issues:octo-org/project:milestone:7",
      url: "https://github.com/octo-org/project/milestone/7",
      title: "Milestone",
      description: "d".repeat(4_000),
      unverified: true,
    });
    expect(githubRecord(issue({ state: "open" }), "octo-org/project")?.fields.status).toBe("todo");
  });
});

describe("the notion checkpoint advances only after the last page", () => {
  const start: NotionCursor = { lastEditedTime: "2026-10-01T00:00:00.000Z", continuation: null };
  const now = "2026-10-02T00:00:00.000Z";

  it("a poll read to its last page moves the checkpoint to its start time", () => {
    const begun = notionPollStart(start, now);
    expect(begun).toEqual({ since: start.lastEditedTime, startedAt: now, queryCursor: null });
    expect(notionPollEnd(start, begun, null)).toEqual({ lastEditedTime: now, continuation: null });
  });

  it("a poll cut at its page bound keeps the old checkpoint and the continuation", () => {
    const begun = notionPollStart(start, now);
    const kept = notionPollEnd(start, begun, "cursor-6");
    expect(kept).toEqual({
      lastEditedTime: start.lastEditedTime,
      continuation: { since: start.lastEditedTime, startedAt: now, queryCursor: "cursor-6" },
    });
    // The next poll resumes the same query, then advances to the first poll's start.
    const resumed = notionPollStart(kept, "2026-10-03T00:00:00.000Z");
    expect(resumed).toEqual({
      since: start.lastEditedTime,
      startedAt: now,
      queryCursor: "cursor-6",
    });
    expect(notionPollEnd(kept, resumed, null)).toEqual({ lastEditedTime: now, continuation: null });
  });

  it("a first poll reads from the epoch", () => {
    expect(notionPollStart({ lastEditedTime: null, continuation: null }, now).since).toBe(
      "1970-01-01T00:00:00.000Z",
    );
  });
});

describe("notion pages map to tasks and initiatives", () => {
  const PROJECTS = "fedcba9876543210fedcba9876543210";
  const settings = notion({
    notionDescriptionPropertyId: "desc",
    notionProjectsDataSourceId: PROJECTS,
    notionProjectRelationPropertyId: "rel",
    notionProjectTitlePropertyId: "ptitle",
    notionProjectDescriptionPropertyId: "pdesc",
    notionStatusMapping: {
      todo: "Ready",
      inProgress: "Doing",
      inReview: null,
      done: "Shipped",
      canceled: null,
    },
  });
  const page = (status: string) => ({
    object: "page",
    id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    url: "https://www.notion.so/page",
    last_edited_time: "2026-10-01T00:00:00.000Z",
    properties: {
      Name: {
        id: "title",
        type: "title",
        title: [{ plain_text: "n".repeat(150) }, { plain_text: "m".repeat(100) }],
      },
      Description: {
        id: "desc",
        type: "rich_text",
        rich_text: [{ plain_text: "x".repeat(17_000) }],
      },
      Status: { id: "St%3Aa", type: "status", status: { name: status } },
    },
  });

  it("title, description, mapped and unmapped status, id and URL", () => {
    const record = notionRecord(page("Doing"), settings, { statusType: "status" }) as RemoteRecord;
    expect(record.externalId).toBe("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
    expect(record.url).toBe("https://www.notion.so/page");
    expect(record.fields.title).toBe(`${"n".repeat(150)}${"m".repeat(50)}`);
    expect(record.fields.description).toHaveLength(16_384);
    expect(record.fields.status).toBe("in_progress");
    const unmapped = notionRecord(page("Someday"), settings, {
      statusType: "status",
    }) as RemoteRecord;
    expect(unmapped.fields.status).toBe("backlog");
  });

  it("a related page of the projects source becomes an unverified initiative", () => {
    const related = {
      object: "page",
      id: "99999999-8888-7777-6666-555555555555",
      url: "https://www.notion.so/project",
      parent: { type: "data_source_id", data_source_id: PROJECTS },
      properties: {
        Name: { id: "ptitle", type: "title", title: [{ plain_text: "Launch" }] },
        About: { id: "pdesc", type: "rich_text", rich_text: [{ plain_text: "Why" }] },
      },
    };
    expect(notionProject(related, settings)).toEqual({
      externalId: `notion:${PROJECTS}:99999999-8888-7777-6666-555555555555`,
      url: "https://www.notion.so/project",
      title: "Launch",
      description: "Why",
      unverified: true,
    });
    const foreign = notionProject(
      { ...related, parent: { type: "data_source_id", data_source_id: NOTION_ID } },
      settings,
    );
    expect(typeof foreign).toBe("string");
    expect(foreign).toContain("99999999-8888-7777-6666-555555555555");
  });
});

const record = (fields: Record<string, string>): RemoteRecord => ({
  externalId: "octo-org/project#1",
  url: "https://github.com/octo-org/project/issues/1",
  remoteRev: null,
  fields,
  project: null,
});

describe("the three-way merge never overwrites a local field", () => {
  const imported = { title: "T", description: "D", status: "todo" };
  const base: HoustonTaskSourceSnapshot = firstSnapshot(record(imported));
  const merge = (live: Record<string, string>, remote: Record<string, string>, from = base) =>
    withRevision(from, mergeTaskFields(from, live as never, record(remote)));

  it("a local title edit and remote title, description and status changes: 3 conflicts", () => {
    const live = { ...imported, title: "T local" };
    const next = merge(live, { title: "T remote", description: "D remote", status: "done" });
    expect(next.conflicts).toEqual([
      { field: "title", base: "T", local: "T local", remote: "T remote" },
      { field: "description", base: "D", local: "D", remote: "D remote" },
      { field: "status", base: "todo", local: "todo", remote: "done" },
    ]);
    expect(next.local).toMatchObject(live);
    expect(syncStateOf(next)).toEqual({ state: "diverged" });
    // The same poll again: no new revision and still the 3 conflicts.
    const again = withRevision(
      next,
      mergeTaskFields(
        next,
        live as never,
        record({ title: "T remote", description: "D remote", status: "done" }),
      ),
    );
    expect(again.revision).toBe(next.revision);
    expect(again.conflicts).toHaveLength(3);
  });

  it("a remote status change alone is one status conflict (the strong case)", () => {
    const next = merge(imported, { ...imported, status: "done" });
    expect(next.conflicts).toEqual([
      { field: "status", base: "todo", local: "todo", remote: "done" },
    ]);
    expect(next.local.status).toBe("todo");
  });

  it("a local status edit with the remote unchanged is pending, without a conflict", () => {
    const next = merge({ ...imported, status: "in_progress" }, imported);
    expect(next.conflicts).toEqual([]);
    expect(syncStateOf(next)).toEqual({ state: "pending" });
  });

  it("a remote that catches up with local moves the base and is current", () => {
    const next = merge({ ...imported, title: "New" }, { ...imported, title: "New" });
    expect(next.conflicts).toEqual([]);
    expect(next.base.title).toBe("New");
    expect(syncStateOf(next)).toEqual({ state: "current" });
  });
});
