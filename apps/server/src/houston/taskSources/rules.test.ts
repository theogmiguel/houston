import { describe, expect, it } from "@effect/vitest";
import {
  type HoustonTaskSourceSettingsInput,
  type HoustonTaskSourceSnapshot,
} from "@houston-app/contracts/houston/taskSources";

import {
  checkNotionSettings,
  firstSnapshot,
  mergeTaskFields,
  notionPollEnd,
  notionPollStart,
  notionProject,
  notionRecord,
  storedSettings,
  syncStateOf,
  trackerSecretName,
  withRevision,
  writebackActions,
  type NotionCursor,
  type RemoteRecord,
  type WritebackInput,
  type WritebackTask,
} from "./rules.ts";

const OP = "houston.taskSources.settings.set";

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

// Write-back.

const writebackTask = (patch: Partial<WritebackTask> = {}): WritebackTask => ({
  id: 10,
  projectId: "project-a",
  title: "Ship it",
  description: "Why it ships",
  status: "todo",
  revision: 3,
  domain: { kind: "delivery", initiativeId: 1, userStatusOverride: false },
  links: [],
  ...patch,
});

const PAGE_LINK = {
  provider: "notion" as const,
  source: "source" as const,
  externalId: "00000000-0000-0000-0000-000000000001",
  url: "https://www.notion.so/page-1",
};

const linkedDelivery = (patch: Partial<WritebackTask> = {}) =>
  writebackTask({ links: [PAGE_LINK], ...patch });

const slice = (patch: Partial<WritebackTask> = {}) =>
  writebackTask({
    id: 11,
    title: "Slice A",
    status: "in_review",
    revision: 5,
    domain: { kind: "slice", initiativeId: null, userStatusOverride: false },
    ...patch,
  });

const writeback = (patch: Partial<WritebackInput>): WritebackInput => ({
  transition: "updated",
  task: linkedDelivery(),
  delivery: null,
  enabled: ["notion"],
  statusChanged: false,
  slices: { total: 0, done: 0 },
  summary: null,
  prUrl: null,
  ...patch,
});

const actionsOf = (input: WritebackInput) => {
  const entries = writebackActions(input);
  if (typeof entries === "string") throw new Error(entries);
  return entries.map((entry) => `${entry.taskId}:${entry.provider}:${entry.action}`);
};

describe("write-back eligibility follows the transition and the source", () => {
  // Each transition in the shape that writes back: a status change writes the page's status, a
  // slice's handback and merge report on the delivery's page, and a rollup writes the status.
  const transitions = [
    {
      transition: "created",
      input: writeback({ transition: "created", task: writebackTask() }),
      actions: [],
    },
    {
      transition: "updated",
      input: writeback({ transition: "updated", statusChanged: true }),
      actions: ["10:notion:status"],
    },
    {
      transition: "handed_back",
      input: writeback({
        transition: "handed_back",
        task: slice(),
        delivery: linkedDelivery(),
        summary: "Did the thing",
        prUrl: "https://github.com/octo-org/project/pull/4",
      }),
      actions: ["11:notion:status", "11:notion:handback_summary", "11:notion:pull_request_url"],
    },
    {
      transition: "merged",
      input: writeback({
        transition: "merged",
        task: slice({ status: "done" }),
        delivery: linkedDelivery(),
        summary: "Did the thing",
        prUrl: "https://github.com/octo-org/project/pull/4",
      }),
      actions: ["11:notion:handback_summary", "11:notion:pull_request_url"],
    },
    {
      transition: "delivery_rolled_up",
      input: writeback({
        transition: "delivery_rolled_up",
        task: linkedDelivery({ status: "done" }),
        slices: { total: 2, done: 2 },
      }),
      actions: ["10:notion:status"],
    },
  ];

  it.each(transitions)(
    "$transition of a linked task with an enabled source enqueues",
    ({ input, actions }) => {
      expect(actionsOf(input)).toEqual(actions);
    },
  );
  it.each(transitions)("$transition of an unassigned task enqueues nothing", ({ input }) => {
    expect(
      actionsOf({
        ...input,
        task: { ...input.task, projectId: null },
        ...(input.delivery === null ? {} : { delivery: { ...input.delivery, projectId: null } }),
      }),
    ).toEqual([]);
  });
  it.each(transitions)(
    "$transition of a task without a domain row enqueues nothing",
    ({ input }) => {
      expect(actionsOf({ ...input, task: { ...input.task, domain: null } })).toEqual([]);
    },
  );
  it.each(transitions)("$transition with the source disabled enqueues nothing", ({ input }) => {
    expect(actionsOf({ ...input, enabled: [] })).toEqual([]);
  });

  it("an unknown transition is refused naming it", () => {
    const refused = writebackActions(writeback({ transition: "renamed" }));
    expect(typeof refused).toBe("string");
    expect(refused).toContain('"renamed"');
  });

  it("a task without a source link enqueues nothing", () => {
    expect(actionsOf(writeback({ transition: "handed_back", task: writebackTask() }))).toEqual([]);
  });

  it("a slice's handback targets its delivery's page with the slice's own revision", () => {
    const entries = writebackActions(
      writeback({
        transition: "handed_back",
        task: slice(),
        delivery: linkedDelivery(),
        summary: "Did the thing",
      }),
    ) as ReadonlyArray<{ readonly action: string; readonly payload: Record<string, unknown> }>;
    const summary = entries.find((entry) => entry.action === "handback_summary");
    expect(summary?.payload).toMatchObject({
      deliveryTaskId: 10,
      summary: "Slice A: Did the thing",
      revision: 5,
    });
  });

  it("an updated task without a status change enqueues nothing", () => {
    expect(actionsOf(writeback({ transition: "updated" }))).toEqual([]);
  });

  it("notion writes the status, the handback summary and the pull request url", () => {
    expect(
      actionsOf(
        writeback({
          transition: "handed_back",
          task: slice(),
          delivery: linkedDelivery(),
          summary: "Did the thing",
          prUrl: "https://github.com/octo-org/project/pull/4",
        }),
      ),
    ).toEqual(["11:notion:status", "11:notion:handback_summary", "11:notion:pull_request_url"]);
  });
});

describe("a tracker token secret name is unique per project and provider and file-safe", () => {
  it("encodes the project, so no id can climb out of the secrets directory", () => {
    const one = trackerSecretName("project-1", "notion");
    expect(trackerSecretName("project-1", "notion")).toBe(one);
    expect(trackerSecretName("project-2", "notion")).not.toBe(one);
    expect(one).toMatch(/^houston-tracker-notion-[A-Za-z0-9_-]+-integration-token$/);
    for (const id of ["../../etc/passwd", "a/b", "name with spaces", "ü", ""]) {
      expect(trackerSecretName(id, "notion"), id).toMatch(/^[A-Za-z0-9][A-Za-z0-9_-]*$/);
    }
    expect(trackerSecretName("a-b", "notion")).not.toBe(trackerSecretName("a", "notion"));
  });
});
