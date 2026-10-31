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
  commentMarker,
  deliveryMarker,
  githubPullRequestUrl,
  issueNumberOf,
  neutralise,
  withoutCloseKeywords,
  writebackActions,
  type NotionCursor,
  type RemoteRecord,
  type WritebackInput,
  type WritebackTask,
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

// Write-back.

const NS = "0123456789abcdef0123456789abcdef";
const KEY = "fedcba9876543210fedcba9876543210";

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

const ISSUE_LINK = {
  provider: "github_issues" as const,
  source: "source" as const,
  externalId: "octo-org/project#7",
  url: "https://github.com/octo-org/project/issues/7",
};

const linkedDelivery = (patch: Partial<WritebackTask> = {}) =>
  writebackTask({ links: [ISSUE_LINK], ...patch });

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
  enabled: ["github_issues"],
  statusChanged: false,
  slices: { total: 0, done: 0 },
  summary: null,
  prUrl: null,
  namespace: NS,
  markerKey: KEY,
  ...patch,
});

const actionsOf = (input: WritebackInput) => {
  const entries = writebackActions(input);
  if (typeof entries === "string") throw new Error(entries);
  return entries.map((entry) => `${entry.taskId}:${entry.provider}:${entry.action}`);
};

describe("write-back eligibility follows the transition and the source", () => {
  // Each transition in the shape that writes back: a delivery without a link opens its issue,
  // a status change comments, a slice's handback and merge report on the delivery's issue, and a
  // delivery whose slices are all done closes it.
  const transitions = [
    {
      transition: "created",
      input: writeback({ transition: "created", task: writebackTask() }),
      actions: ["10:github_issues:create"],
    },
    {
      transition: "updated",
      input: writeback({ transition: "updated", statusChanged: true }),
      actions: ["10:github_issues:status"],
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
      actions: [
        "11:github_issues:status",
        "11:github_issues:summary_comment",
        "11:github_issues:pr_reference",
      ],
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
      actions: ["11:github_issues:summary_comment", "11:github_issues:pr_reference"],
    },
    {
      transition: "delivery_rolled_up",
      input: writeback({
        transition: "delivery_rolled_up",
        task: linkedDelivery({ status: "done" }),
        slices: { total: 2, done: 2 },
      }),
      actions: ["10:github_issues:delivery_close"],
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

  it("a delivery create carries the door 5 marker, its title and its description", () => {
    const [entry] = writebackActions(
      writeback({ transition: "created", task: writebackTask() }),
    ) as ReadonlyArray<{ readonly payload: Record<string, unknown> }>;
    expect(entry?.payload).toMatchObject({
      marker: deliveryMarker(NS, KEY, 10),
      title: "Ship it",
      description: "Why it ships",
    });
  });

  it("a slice's handback targets its delivery's issue with the slice's own identity", () => {
    const entries = writebackActions(
      writeback({
        transition: "handed_back",
        task: slice(),
        delivery: linkedDelivery(),
        summary: "Did the thing",
      }),
    ) as ReadonlyArray<{ readonly action: string; readonly payload: Record<string, unknown> }>;
    const summary = entries.find((entry) => entry.action === "summary_comment");
    expect(summary?.payload).toMatchObject({
      deliveryTaskId: 10,
      issueNumber: 7,
      taskIdentity: `houston-task-${NS}-11`,
      summary: "Slice A: Did the thing",
    });
  });

  it("an updated task without a status change enqueues nothing", () => {
    expect(actionsOf(writeback({ transition: "updated" }))).toEqual([]);
  });

  it("a user's done on a delivery comments its status and closes its issue", () => {
    expect(
      actionsOf(
        writeback({
          transition: "updated",
          statusChanged: true,
          task: linkedDelivery({
            status: "done",
            domain: { kind: "delivery", initiativeId: 1, userStatusOverride: true },
          }),
        }),
      ),
    ).toEqual(["10:github_issues:status", "10:github_issues:delivery_close"]);
  });

  it("notion writes the status, the handback summary and the pull request url", () => {
    const page = {
      provider: "notion" as const,
      source: "source" as const,
      externalId: "00000000-0000-0000-0000-000000000001",
      url: "https://www.notion.so/page-1",
    };
    expect(
      actionsOf(
        writeback({
          transition: "handed_back",
          enabled: ["notion"],
          task: slice(),
          delivery: writebackTask({ links: [page] }),
          summary: "Did the thing",
          prUrl: "https://github.com/octo-org/project/pull/4",
        }),
      ),
    ).toEqual(["11:notion:status", "11:notion:handback_summary", "11:notion:pull_request_url"]);
  });
});

describe("close keywords are removed and pull request urls are pinned to the repository", () => {
  it("close keywords lose their word", () => {
    const cleaned = withoutCloseKeywords("This closes #7 and fixes #8");
    expect(cleaned).not.toMatch(/closes|fixes/i);
    expect(cleaned).toContain("#7");
    expect(cleaned).toContain("#8");
    expect(withoutCloseKeywords("Resolved. CLOSE it, Fixed")).not.toMatch(/resolve|close|fix/i);
    expect(withoutCloseKeywords("disclosed prefix")).toBe("disclosed prefix");
  });

  it("markers name the namespace, the task, the transition and the action, keyed", () => {
    const delivery = deliveryMarker(NS, KEY, 10);
    expect(delivery).toMatch(
      new RegExp(
        `^<!-- houston-delivery:houston-task-${NS}-10:delivery-${NS}-10:[0-9a-f]{32} -->$`,
      ),
    );
    const comment = commentMarker(KEY, `houston-task-${NS}-11`, 42, "pr_reference");
    expect(comment).toMatch(
      new RegExp(`^<!-- houston-task:houston-task-${NS}-11:42:pr_reference:[0-9a-f]{32} -->$`),
    );
    // The tag depends on the installation's key and on everything the marker names, so another
    // installation, task or transition cannot produce it from what a marker shows.
    const other = "00112233445566778899aabbccddeeff";
    expect(deliveryMarker(NS, other, 10)).not.toBe(delivery);
    expect(deliveryMarker(NS, KEY, 11).slice(-36)).not.toBe(delivery.slice(-36));
    expect(commentMarker(other, `houston-task-${NS}-11`, 42, "pr_reference")).not.toBe(comment);
    expect(commentMarker(KEY, `houston-task-${NS}-11`, 43, "pr_reference").slice(-36)).not.toBe(
      comment.slice(-36),
    );
    expect(commentMarker(KEY, `houston-task-${NS}-11`, 42, "status").slice(-36)).not.toBe(
      comment.slice(-36),
    );
  });

  it("a link of another repository has no issue number in the configured one", () => {
    expect(issueNumberOf("octo-org/project#12", "octo-org/project")).toBe(12);
    expect(issueNumberOf("octo-org/old#12", "octo-org/new")).toBeNull();
    expect(issueNumberOf("octo-org/project#0", "octo-org/project")).toBeNull();
    expect(issueNumberOf("octo-org/project", "octo-org/project")).toBeNull();
  });

  const repository = "octo-org/project";
  it("a pull request of the same repository on github.com is accepted", () => {
    expect(githubPullRequestUrl("https://github.com/octo-org/project/pull/4", repository)).toBe(
      "https://github.com/octo-org/project/pull/4",
    );
  });

  it.each([
    "https://evil.example/octo-org/project/pull/4",
    "https://github.com/octo-org/other/pull/4",
    "http://github.com/octo-org/project/pull/4",
    "https://github.com/octo-org/project/pull/0",
    "https://github.com/octo-org/project/pull/4/files",
    "https://github.com.evil.example/octo-org/project/pull/4",
    "https://github.com/octo-org/project/issues/4",
  ])("%s is refused", (url) => {
    expect(githubPullRequestUrl(url, repository)).toBeNull();
  });
});

describe("mentions and references in copied text are inert on GitHub", () => {
  it("mentions, team mentions and issue references are wrapped in inline code", () => {
    expect(
      neutralise("cc @octo-org/everyone and @alice, see #12 and octo-org/other#3. This fixes #9"),
    ).toBe("cc `@octo-org/everyone` and `@alice`, see `#12` and `octo-org/other#3`. This  `#9`");
  });

  it.each([
    ["mail me at dev@example.com", "mail me at dev@example.com"],
    ["already `@alice` quoted", "already `@alice` quoted"],
    ["issue#4 is not a reference", "issue#4 is not a reference"],
    ["a # heading and C# code", "a # heading and C# code"],
    ["(@bob) [#7]", "(`@bob`) [`#7`]"],
  ])("%s", (text, expected) => {
    expect(neutralise(text)).toBe(expected);
  });
});
