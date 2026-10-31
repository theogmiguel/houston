// Records merged into tasks, initiatives and links, and conflicts resolved, over one database.
import { assert, describe, it } from "@effect/vitest";
import type { ProjectId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import type * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as SqlClient from "effect/sql/SqlClient";

import * as HoustonTaskService from "../tasks/TaskService.ts";
import { createProject } from "../tasks/tasks.testkit.ts";
import { HoustonTaskSourceOutboxDrain } from "./Outbox.ts";
import { HoustonTaskSourcePoller } from "./Poller.ts";
import type { RemoteRecord } from "./rules.ts";
import { HoustonTaskSourceService } from "./SourceService.ts";
import { HoustonTaskSourceStore } from "./SourceStore.ts";
import { HoustonTaskSourceSync } from "./Sync.ts";
import {
  githubIssue,
  issuePages,
  layerSources,
  makeGithubFake,
  makeNotionFake,
  notionPage,
  notionServes,
  notionSettings,
  pageId,
  type GithubFake,
  type NotionFake,
} from "./taskSources.testkit.ts";

type Services = Layer.Success<ReturnType<typeof layerSources>>;

const withSources = <A, E>(
  body: (fakes: { github: GithubFake; notion: NotionFake }) => Effect.Effect<A, E, Services>,
) =>
  Effect.gen(function* () {
    const notion = yield* makeNotionFake;
    const github = makeGithubFake();
    return yield* body({ github, notion }).pipe(
      Effect.provide(layerSources({ github, notionOrigin: notion.origin })),
    );
  }).pipe(Effect.scoped);

const KEY = "github_issues:octo-org/project:milestone:7";

const record = (
  fields: Partial<Record<"title" | "description" | "status", string>> = {},
  project: RemoteRecord["project"] = null,
  externalId = "octo-org/project#1",
): RemoteRecord => ({
  externalId,
  url: `https://github.com/${externalId.replace("#", "/issues/")}`,
  remoteRev: null,
  fields: { title: "Imported", description: "Body", status: "todo", ...fields },
  project,
});

const milestone = (patch: Partial<NonNullable<RemoteRecord["project"]>> = {}) => ({
  externalId: KEY,
  url: "https://github.com/octo-org/project/milestone/7",
  title: "Milestone",
  description: "Why",
  unverified: true,
  ...patch,
});

const enableGithub = (projectId: ProjectId) =>
  Effect.gen(function* () {
    const sources = yield* HoustonTaskSourceService;
    yield* sources.setSettings({
      projectId,
      provider: "github_issues",
      settings: { enabled: true, githubRepository: "octo-org/project", githubLabel: "import" },
    });
  });

const linkOf = (taskId: number) =>
  Effect.gen(function* () {
    const store = yield* HoustonTaskSourceStore;
    const [link] = yield* store.linksOf(taskId);
    if (link === undefined) return yield* Effect.die(`task ${taskId} has no link`);
    return link;
  });

describe("an item imports once as a task without a run", () => {
  it.effect("an item imports once as a task without a run", () =>
    withSources(({ github }) =>
      Effect.gen(function* () {
        const projectId = yield* createProject("import-once");
        yield* enableGithub(projectId);
        const issues = [
          githubIssue(1, {
            milestone: {
              number: 7,
              title: "Milestone",
              description: "Why",
              html_url: "https://github.com/octo-org/project/milestone/7",
            },
          }),
          githubIssue(2),
          githubIssue(3, { labels: [] }),
        ];
        issuePages(github, () => issues);
        const poller = yield* HoustonTaskSourcePoller;
        const tasks = yield* HoustonTaskService.HoustonTaskService;
        const result = yield* poller.poll(projectId, "github_issues");
        assert.isNull(result?.error);
        const first = yield* tasks.get({ id: "HOU-1" });
        assert.deepInclude(first.task, {
          projectId,
          title: "Issue 1",
          createdBy: "tracker:github_issues",
          refUrl: "https://github.com/octo-org/project/issues/1",
        });
        assert.lengthOf(
          first.history.filter((entry) => entry.action === "houston:source-imported"),
          1,
        );
        assert.strictEqual(first.domain.kind, "delivery");
        const [initiative] = yield* tasks.listInitiatives({ projectId });
        assert.strictEqual(first.domain.initiativeId, initiative?.id);
        assert.strictEqual(initiative?.trackerDescription, "Why");
        assert.deepEqual(first.runs, []);
        assert.deepEqual((yield* linkOf(first.task.id)).syncState, { state: "current" });
        const sql = yield* SqlClient.SqlClient;
        const before = yield* sql`SELECT id, revision FROM houston_tasks ORDER BY id`;
        assert.lengthOf(before, 2);
        const links =
          yield* sql`SELECT snapshot_json FROM houston_task_source_links ORDER BY task_id`;

        // The same issues again: no task and no revision moves.
        github.requests.length = 0;
        yield* poller.poll(projectId, "github_issues");
        issuePages(github, () => [...issues]);
        yield* poller.poll(projectId, "github_issues");
        assert.deepEqual(yield* sql`SELECT id, revision FROM houston_tasks ORDER BY id`, before);
        assert.deepEqual(
          yield* sql`SELECT snapshot_json FROM houston_task_source_links ORDER BY task_id`,
          links,
        );
        assert.deepEqual(yield* sql`SELECT COUNT(*) AS n FROM houston_task_runs`, [{ n: 0 }]);
      }),
    ),
  );
});

describe("a record over a bound is skipped and named", () => {
  it.effect("a record over a bound is skipped and named", () =>
    withSources(({ notion }) =>
      Effect.gen(function* () {
        const projectId = yield* createProject("bounds");
        const sources = yield* HoustonTaskSourceService;
        const poller = yield* HoustonTaskSourcePoller;
        const sync = yield* HoustonTaskSourceSync;
        // 16,384 four-byte characters: a description within its character cut, over 65,536 bytes.
        const oversized = (n: number) => {
          const page = notionPage(n);
          return {
            ...page,
            properties: {
              ...page.properties,
              Description: {
                id: "desc",
                type: "rich_text",
                rich_text: [{ plain_text: "😀".repeat(16_384) }],
              },
            },
          };
        };
        const pages = [notionPage(1), oversized(2), oversized(3), notionPage(4)];
        notionServes(notion, () => pages as never);
        yield* sources.setCredential({
          projectId,
          provider: "notion",
          token: Redacted.make("ntn_bounds"),
        });
        yield* sources.setSettings({ projectId, provider: "notion", settings: notionSettings() });
        const result = yield* poller.poll(projectId, "notion");
        const sql = yield* SqlClient.SqlClient;
        const titles = (yield* sql<{
          readonly title: string;
        }>`SELECT title FROM houston_tasks ORDER BY id`).map((row) => row.title);
        assert.deepEqual(titles, ["Page 1", "Page 4"]);
        assert.include(result?.error ?? "", pageId(2));
        assert.include(result?.error ?? "", pageId(3));
        assert.include(result?.error ?? "", "65536");
        const [, notionSettingsAfter] = yield* sources.getSettings({ projectId });
        assert.strictEqual(notionSettingsAfter?.lastError, result?.error);

        // An initiative key over 512 characters is skipped the same way.
        const longKey = yield* sync.apply(
          projectId,
          "github_issues",
          record(
            {},
            milestone({ externalId: `github_issues:${"r".repeat(520)}:milestone:1` }),
            "o/r#9",
          ),
        );
        assert.include(longKey.skipped ?? "", "512");
        assert.include(longKey.skipped ?? "", "o/r#9");
        assert.isNull(longKey.taskId);
        assert.deepEqual(yield* sql`SELECT COUNT(*) AS n FROM houston_tasks`, [{ n: 2 }]);
      }),
    ),
  );
});

describe("linked pages outside the filter refresh three at a time", () => {
  it.effect("linked pages outside the filter refresh three at a time", () =>
    withSources(({ notion }) =>
      Effect.gen(function* () {
        const projectId = yield* createProject("refresh");
        const sources = yield* HoustonTaskSourceService;
        const poller = yield* HoustonTaskSourcePoller;
        yield* sources.setCredential({
          projectId,
          provider: "notion",
          token: Redacted.make("ntn_refresh"),
        });
        const pages = Array.from({ length: 5 }, (_, index) => notionPage(index + 1));
        let inFilter: ReadonlyArray<string> = pages.map((page) => page.id);
        notionServes(notion, () => pages, {
          extra: (request) =>
            request.method === "POST"
              ? {
                  body: {
                    object: "list",
                    results: pages.filter((page) => inFilter.includes(page.id)),
                    has_more: false,
                    next_cursor: null,
                  },
                }
              : null,
        });
        yield* sources.setSettings({ projectId, provider: "notion", settings: notionSettings() });
        yield* poller.poll(projectId, "notion");
        // Now no page is in the filter. The import's poll refreshed 1-3; one more poll ends the
        // cycle, then each complete poll refreshes the next three from the start.
        inFilter = [];
        yield* poller.poll(projectId, "notion");
        const refreshed = () =>
          notion.requests
            .filter((request) => request.method === "GET" && request.path.startsWith("/v1/pages/"))
            .map((request) => request.path.slice("/v1/pages/".length));
        notion.requests.length = 0;
        yield* poller.poll(projectId, "notion");
        assert.deepEqual(refreshed(), [pageId(1), pageId(2), pageId(3)]);
        notion.requests.length = 0;
        yield* poller.poll(projectId, "notion");
        assert.deepEqual(refreshed(), [pageId(4), pageId(5)]);
        notion.requests.length = 0;
        pages[0] = {
          ...pages[0]!,
          properties: {
            ...pages[0]!.properties,
            Name: { id: "title", type: "title", title: [{ plain_text: "Renamed remotely" }] },
          },
        };
        yield* poller.poll(projectId, "notion");
        assert.deepEqual(refreshed(), [pageId(1), pageId(2), pageId(3)]);
        const link = yield* linkOf(1);
        assert.strictEqual(link.snapshot.remote.title, "Renamed remotely");
      }),
    ),
  );

  it.effect("a linked page that fails is skipped and named, and the refresh continues", () =>
    withSources(({ notion }) =>
      Effect.gen(function* () {
        const projectId = yield* createProject("refresh-gone");
        const sources = yield* HoustonTaskSourceService;
        const poller = yield* HoustonTaskSourcePoller;
        yield* sources.setCredential({
          projectId,
          provider: "notion",
          token: Redacted.make("ntn_gone"),
        });
        const pages = Array.from({ length: 5 }, (_, index) => notionPage(index + 1));
        let inFilter: ReadonlyArray<string> = pages.map((page) => page.id);
        let gone = false;
        notionServes(notion, () => pages, {
          extra: (request) => {
            if (request.method === "POST") {
              return {
                body: {
                  object: "list",
                  results: pages.filter((page) => inFilter.includes(page.id)),
                  has_more: false,
                  next_cursor: null,
                },
              };
            }
            // Page 1 was deleted or unshared: Notion answers 404.
            if (gone && request.method === "GET" && request.path === `/v1/pages/${pageId(1)}`) {
              return { status: 404, body: { object: "error", code: "object_not_found" } };
            }
            return null;
          },
        });
        yield* sources.setSettings({ projectId, provider: "notion", settings: notionSettings() });
        yield* poller.poll(projectId, "notion");
        inFilter = [];
        gone = true;
        const refreshed = () =>
          notion.requests
            .filter((request) => request.method === "GET" && request.path.startsWith("/v1/pages/"))
            .map((request) => request.path.slice("/v1/pages/".length));
        notion.requests.length = 0;
        const errors: Array<string | null> = [];
        for (let poll = 0; poll < 4; poll++) {
          errors.push((yield* poller.poll(projectId, "notion"))?.error ?? null);
        }
        // Every page is still reached; page 1 is skipped each time it comes round.
        assert.deepEqual(refreshed(), [
          pageId(4),
          pageId(5),
          pageId(1),
          pageId(2),
          pageId(3),
          pageId(4),
          pageId(5),
          pageId(1),
          pageId(2),
          pageId(3),
        ]);
        assert.isNull(errors[0]);
        assert.include(errors[1] ?? "", pageId(1));
        assert.include(errors[1] ?? "", "404");
        assert.isNull(errors[2]);
        assert.include(errors[3] ?? "", pageId(1));
        const [, notionAfter] = yield* sources.getSettings({ projectId });
        assert.include(notionAfter?.lastError ?? "", pageId(1));
        assert.notInclude(notionAfter?.lastError ?? "", pageId(2));
      }),
    ),
  );
});

describe("a remote change becomes a conflict and leaves the task", () => {
  it.effect("a remote change becomes a conflict and leaves the task", () =>
    withSources(() =>
      Effect.gen(function* () {
        const projectId = yield* createProject("conflicts");
        const sync = yield* HoustonTaskSourceSync;
        const tasks = yield* HoustonTaskService.HoustonTaskService;
        const imported = yield* sync.apply(projectId, "github_issues", record());
        const id = String(imported.taskId);
        const edited = yield* tasks.save({
          id,
          expectedRevision: 1,
          patch: { title: "Local title" },
        });
        // Remote title, description and status all change: three conflicts, task untouched.
        yield* sync.apply(
          projectId,
          "github_issues",
          record({ title: "Remote", description: "New body", status: "done" }),
        );
        const after = yield* tasks.get({ id });
        assert.strictEqual(after.task.revision, edited.revision);
        assert.deepInclude(after.task, {
          title: "Local title",
          description: "Body",
          status: "todo",
        });
        const link = yield* linkOf(after.task.id);
        assert.deepEqual(link.syncState, { state: "diverged" });
        assert.deepEqual(
          link.snapshot.conflicts.map((conflict) => [
            conflict.field,
            conflict.base,
            conflict.local,
            conflict.remote,
          ]),
          [
            ["title", "Imported", "Local title", "Remote"],
            ["description", "Body", "Body", "New body"],
            ["status", "todo", "todo", "done"],
          ],
        );
        // The same poll again: no new revision and still three conflicts.
        yield* sync.apply(
          projectId,
          "github_issues",
          record({ title: "Remote", description: "New body", status: "done" }),
        );
        const again = yield* linkOf(after.task.id);
        assert.strictEqual(again.snapshot.revision, link.snapshot.revision);
        assert.lengthOf(again.snapshot.conflicts, 3);
        assert.strictEqual((yield* tasks.get({ id })).task.revision, edited.revision);

        // A remote status change alone: one status conflict, task revision unchanged (strong case).
        const other = yield* sync.apply(
          projectId,
          "github_issues",
          record({}, null, "octo-org/project#2"),
        );
        yield* sync.apply(
          projectId,
          "github_issues",
          record({ status: "done" }, null, "octo-org/project#2"),
        );
        const otherTask = yield* tasks.get({ id: String(other.taskId) });
        assert.strictEqual(otherTask.task.revision, 1);
        assert.strictEqual(otherTask.task.status, "todo");
        assert.deepEqual(
          (yield* linkOf(otherTask.task.id)).snapshot.conflicts.map((conflict) => conflict.field),
          ["status"],
        );

        // A local status edit with the remote unchanged: no conflict, the link is pending.
        const third = yield* sync.apply(
          projectId,
          "github_issues",
          record({}, null, "octo-org/project#3"),
        );
        yield* tasks.save({
          id: String(third.taskId),
          expectedRevision: 1,
          patch: { status: "in_progress" },
        });
        yield* sync.apply(projectId, "github_issues", record({}, null, "octo-org/project#3"));
        const pending = yield* linkOf(third.taskId as number);
        assert.deepEqual(pending.snapshot.conflicts, []);
        assert.deepEqual(pending.syncState, { state: "pending" });
      }),
    ),
  );
});

describe("a conflict stays when a later poll converges", () => {
  it.effect("a conflict stays when a later poll converges", () =>
    withSources(() =>
      Effect.gen(function* () {
        const projectId = yield* createProject("converge");
        const sync = yield* HoustonTaskSourceSync;
        const tasks = yield* HoustonTaskService.HoustonTaskService;
        const imported = yield* sync.apply(projectId, "github_issues", record());
        const id = String(imported.taskId);
        yield* tasks.save({ id, expectedRevision: 1, patch: { title: "Local" } });
        yield* sync.apply(projectId, "github_issues", record({ title: "Remote" }));
        yield* sync.apply(projectId, "github_issues", record({ title: "Local" }));
        const link = yield* linkOf(Number(id));
        assert.deepEqual(link.snapshot.conflicts, [
          { field: "title", base: "Imported", local: "Local", remote: "Local" },
        ]);
        assert.deepEqual(link.syncState, { state: "diverged" });
      }),
    ),
  );
});

describe("initiative conflicts keep local decisions until resolved", () => {
  it.effect("initiative conflicts keep local decisions until resolved", () =>
    withSources(() =>
      Effect.gen(function* () {
        const projectId = yield* createProject("initiative");
        const sync = yield* HoustonTaskSourceSync;
        const tasks = yield* HoustonTaskService.HoustonTaskService;
        const imported = yield* sync.apply(projectId, "github_issues", record({}, milestone()));
        const taskId = imported.taskId as number;
        const [initiative] = yield* tasks.listInitiatives({ projectId });
        if (initiative === undefined) return yield* Effect.die("no initiative");
        const decided = yield* tasks.saveInitiative({
          projectId,
          id: initiative.id,
          expectedRevision: initiative.revision,
          name: "Local name",
          trackerDescription: "Local why",
          localDecisions: ["keep the API"],
        });
        yield* sync.apply(
          projectId,
          "github_issues",
          record({}, milestone({ title: "Remote name", description: "Remote why" })),
        );
        // The remote converges with local; the recorded conflicts stay.
        yield* sync.apply(
          projectId,
          "github_issues",
          record({}, milestone({ title: "Local name", description: "Local why" })),
        );
        const link = yield* linkOf(taskId);
        assert.deepEqual(
          link.snapshot.conflicts.map((conflict) => conflict.field),
          ["project.title", "project.description"],
        );
        const [unchanged] = yield* tasks.listInitiatives({ projectId });
        assert.deepEqual(unchanged, decided);

        // A changed initiative identity is recorded too.
        yield* sync.apply(
          projectId,
          "github_issues",
          record(
            {},
            milestone({ externalId: "github_issues:octo-org/project:milestone:8", title: "Other" }),
          ),
        );
        const moved = yield* linkOf(taskId);
        assert.include(
          moved.snapshot.conflicts.map((conflict) => conflict.field),
          "project.identity",
        );
        assert.strictEqual(
          (yield* tasks.get({ id: String(taskId) })).domain.initiativeId,
          initiative.id,
        );

        // A stale initiative revision is refused and changes nothing.
        const task = (yield* tasks.get({ id: String(taskId) })).task;
        const stale = yield* Effect.flip(
          sync.resolve({
            taskId: String(taskId),
            expectedTaskRevision: task.revision,
            expectedInitiativeRevision: decided.revision - 1,
            provider: "github_issues",
            externalId: "octo-org/project#1",
            field: "project.title",
            expectedLinkRevision: moved.snapshot.revision,
            resolution: "remote",
          }),
        );
        assert.deepInclude(stale, {
          kind: "conflict",
          expected: decided.revision - 1,
          actual: decided.revision,
        });
        const resolved = yield* sync.resolve({
          taskId: String(taskId),
          expectedTaskRevision: task.revision,
          expectedInitiativeRevision: decided.revision,
          provider: "github_issues",
          externalId: "octo-org/project#1",
          field: "project.title",
          expectedLinkRevision: moved.snapshot.revision,
          resolution: { custom: "Agreed name" },
        });
        assert.notInclude(
          resolved.snapshot.conflicts.map((conflict) => conflict.field),
          "project.title",
        );
        const [renamed] = (yield* tasks.listInitiatives({ projectId })).filter(
          (entry) => entry.id === initiative.id,
        );
        assert.strictEqual(renamed?.name, "Agreed name");
        assert.deepEqual(renamed?.localDecisions, ["keep the API"]);
      }),
    ),
  );

  it.effect("a new item joining a renamed initiative takes its base from the remote", () =>
    withSources(() =>
      Effect.gen(function* () {
        const projectId = yield* createProject("initiative-join");
        const sync = yield* HoustonTaskSourceSync;
        const tasks = yield* HoustonTaskService.HoustonTaskService;
        yield* sync.apply(projectId, "github_issues", record({}, milestone()));
        const [initiative] = yield* tasks.listInitiatives({ projectId });
        if (initiative === undefined) return yield* Effect.die("no initiative");
        yield* tasks.saveInitiative({
          projectId,
          id: initiative.id,
          expectedRevision: initiative.revision,
          name: "Local name",
          trackerDescription: "Local why",
          localDecisions: [],
        });

        // The remote milestone is unchanged: the new item's link is pending, with no conflict.
        const joined = yield* sync.apply(
          projectId,
          "github_issues",
          record({}, milestone(), "octo-org/project#2"),
        );
        const link = yield* linkOf(joined.taskId as number);
        assert.deepEqual(link.snapshot.conflicts, []);
        assert.deepEqual(link.syncState, { state: "pending" });
        const id = String(joined.taskId);
        yield* tasks.save({ id, expectedRevision: 1, patch: { acceptance: ["it works"] } });
        assert.notInclude(
          (yield* tasks.get({ id })).domain.readiness.reasons,
          "the task has an unresolved tracker conflict",
        );

        // The inverse: the remote milestone changed too, so the new item records both conflicts.
        const changed = yield* sync.apply(
          projectId,
          "github_issues",
          record(
            {},
            milestone({ title: "Remote name", description: "Remote why" }),
            "octo-org/project#3",
          ),
        );
        assert.deepEqual(
          (yield* linkOf(changed.taskId as number)).snapshot.conflicts.map((conflict) => [
            conflict.field,
            conflict.base,
            conflict.local,
            conflict.remote,
          ]),
          [
            ["project.title", "Milestone", "Local name", "Remote name"],
            ["project.description", "Why", "Local why", "Remote why"],
          ],
        );
      }),
    ),
  );
});

describe("readiness follows the conflict", () => {
  it.effect("readiness follows the conflict", () =>
    withSources(() =>
      Effect.gen(function* () {
        const projectId = yield* createProject("ready");
        const sync = yield* HoustonTaskSourceSync;
        const tasks = yield* HoustonTaskService.HoustonTaskService;
        const imported = yield* sync.apply(projectId, "github_issues", record());
        const id = String(imported.taskId);
        yield* tasks.save({ id, expectedRevision: 1, patch: { acceptance: ["it works"] } });
        assert.isTrue((yield* tasks.get({ id })).domain.readiness.ready);
        yield* sync.apply(projectId, "github_issues", record({ title: "Remote" }));
        const conflicted = (yield* tasks.get({ id })).domain.readiness;
        assert.isFalse(conflicted.ready);
        assert.include(conflicted.reasons, "the task has an unresolved tracker conflict");
        const task = (yield* tasks.get({ id })).task;
        const link = yield* linkOf(task.id);
        yield* sync.resolve({
          taskId: id,
          expectedTaskRevision: task.revision,
          provider: "github_issues",
          externalId: "octo-org/project#1",
          field: "title",
          expectedLinkRevision: link.snapshot.revision,
          resolution: "local",
        });
        assert.isTrue((yield* tasks.get({ id })).domain.readiness.ready);
      }),
    ),
  );
});

describe("a resolution applies at the expected revisions only", () => {
  it.effect("a resolution applies at the expected revisions only", () =>
    withSources(() =>
      Effect.gen(function* () {
        const projectId = yield* createProject("resolve");
        const sync = yield* HoustonTaskSourceSync;
        const tasks = yield* HoustonTaskService.HoustonTaskService;
        const sql = yield* SqlClient.SqlClient;
        const conflicted = (externalId: string) =>
          Effect.gen(function* () {
            const imported = yield* sync.apply(
              projectId,
              "github_issues",
              record({}, null, externalId),
            );
            yield* sync.apply(
              projectId,
              "github_issues",
              record({ title: "Remote title", status: "done" }, null, externalId),
            );
            const id = imported.taskId as number;
            return {
              id,
              task: (yield* tasks.get({ id: String(id) })).task,
              link: yield* linkOf(id),
            };
          });
        const resolve = (
          state: Effect.Success<ReturnType<typeof conflicted>>,
          field: "title" | "status",
          resolution: "local" | "remote" | { readonly custom: string },
          revisions: { readonly task?: number; readonly link?: number } = {},
        ) =>
          sync.resolve({
            taskId: `HOU-${state.task.number}`,
            expectedTaskRevision: revisions.task ?? state.task.revision,
            provider: "github_issues",
            externalId: state.link.externalId,
            field,
            expectedLinkRevision: revisions.link ?? state.link.snapshot.revision,
            resolution,
          });

        const remote = yield* conflicted("o/r#1");
        const remoteLink = yield* resolve(remote, "status", "remote");
        const afterRemote = yield* tasks.get({ id: String(remote.id) });
        assert.strictEqual(afterRemote.task.status, "done");
        assert.strictEqual(afterRemote.task.revision, remote.task.revision + 1);
        assert.strictEqual(afterRemote.history[0]?.action, "houston:source-resolved");
        assert.deepEqual(
          remoteLink.snapshot.conflicts.map((conflict) => conflict.field),
          ["title"],
        );

        const local = yield* conflicted("o/r#2");
        yield* resolve(local, "title", "local");
        const afterLocal = yield* tasks.get({ id: String(local.id) });
        assert.strictEqual(afterLocal.task.title, "Imported");
        assert.strictEqual(afterLocal.task.revision, local.task.revision);
        assert.deepEqual(
          (yield* linkOf(local.id)).snapshot.conflicts.map((conflict) => conflict.field),
          ["status"],
        );

        const custom = yield* conflicted("o/r#3");
        yield* resolve(custom, "title", { custom: "Agreed" });
        assert.strictEqual((yield* tasks.get({ id: String(custom.id) })).task.title, "Agreed");

        const refusals = yield* conflicted("o/r#4");
        const fingerprint = () =>
          Effect.all([
            sql`SELECT revision, title, status FROM houston_tasks WHERE id = ${refusals.id}`,
            sql`SELECT snapshot_json FROM houston_task_source_links WHERE task_id = ${refusals.id}`,
          ]).pipe(Effect.map((rows) => JSON.stringify(rows)));
        const before = yield* fingerprint();
        const staleTask = yield* Effect.flip(
          resolve(refusals, "title", "remote", { task: refusals.task.revision + 5 }),
        );
        assert.deepInclude(staleTask, {
          kind: "conflict",
          expected: refusals.task.revision + 5,
          actual: refusals.task.revision,
        });
        const staleLink = yield* Effect.flip(
          resolve(refusals, "title", "remote", { link: refusals.link.snapshot.revision + 1 }),
        );
        assert.deepInclude(staleLink, {
          kind: "conflict",
          actual: refusals.link.snapshot.revision,
        });
        const paused = yield* Effect.flip(resolve(refusals, "status", { custom: "paused" }));
        assert.strictEqual(paused.kind, "invalid");
        assert.include(paused.message, '"paused"');
        assert.strictEqual(yield* fingerprint(), before);
      }),
    ),
  );

  it.effect("a resolution that edits the task invalidates an approved plan", () =>
    withSources(() =>
      Effect.gen(function* () {
        const projectId = yield* createProject("resolve-approved");
        const sync = yield* HoustonTaskSourceSync;
        const tasks = yield* HoustonTaskService.HoustonTaskService;
        const sql = yield* SqlClient.SqlClient;
        const imported = yield* sync.apply(projectId, "github_issues", record({}, milestone()));
        const id = imported.taskId as number;
        yield* sync.apply(
          projectId,
          "github_issues",
          record(
            { title: "Remote title", description: "Remote body", status: "done" },
            milestone(),
          ),
        );
        // A plan approved at the live revision, as a Houston 1 import brings it.
        const approve = Effect.gen(function* () {
          const { revision } = (yield* tasks.get({ id: String(id) })).task;
          yield* sql`UPDATE houston_task_domain SET approved_task_revision = ${revision}
            WHERE task_id = ${id}`;
          return revision;
        });
        const approved = () =>
          sql<{ readonly approved: number | null }>`
            SELECT approved_task_revision AS approved FROM houston_task_domain WHERE task_id = ${id}
          `.pipe(Effect.map((rows) => rows[0]?.approved));
        const resolve = (
          field: "title" | "description" | "status",
          resolution: "local" | "remote" | { readonly custom: string },
        ) =>
          Effect.gen(function* () {
            const task = (yield* tasks.get({ id: String(id) })).task;
            const link = yield* linkOf(id);
            return yield* sync.resolve({
              taskId: String(id),
              expectedTaskRevision: task.revision,
              provider: "github_issues",
              externalId: "octo-org/project#1",
              field,
              expectedLinkRevision: link.snapshot.revision,
              resolution,
            });
          });

        // Keeping the local value edits nothing, so the approval stands.
        const kept = yield* approve;
        yield* resolve("title", "local");
        assert.strictEqual(yield* approved(), kept);

        yield* resolve("status", "remote");
        assert.isNull(yield* approved());
        yield* approve;
        yield* resolve("description", { custom: "Agreed body" });
        assert.isNull(yield* approved());
      }),
    ),
  );
});

describe("a local resolution enqueues its write-back atomically", () => {
  it.effect("a local resolution enqueues its write-back atomically", () =>
    withSources(({ github }) =>
      Effect.gen(function* () {
        github.respond = (_url, request) =>
          request.method === "POST"
            ? new Response(JSON.stringify({ id: 1 }), { status: 201 })
            : new Response("[]", { status: 200 });
        const projectId = yield* createProject("local-writeback");
        yield* enableGithub(projectId);
        const sync = yield* HoustonTaskSourceSync;
        const tasks = yield* HoustonTaskService.HoustonTaskService;
        const sql = yield* SqlClient.SqlClient;
        const drain = (yield* HoustonTaskSourceOutboxDrain).drain;
        const outbox = () =>
          sql<{
            readonly action: string;
            readonly revision: number;
            readonly payload_json: string;
            readonly receipt_json: string | null;
          }>`SELECT action, revision, payload_json, receipt_json FROM houston_task_source_outbox ORDER BY id`;

        // An imported delivery the user moved on; its status write-back is sent.
        const imported = yield* sync.apply(projectId, "github_issues", record({}, milestone()));
        const id = imported.taskId as number;
        const task = (yield* tasks.get({ id: String(id) })).task;
        const moved = yield* tasks.save({
          id: task.key,
          expectedRevision: task.revision,
          patch: { status: "in_progress" },
        });
        yield* drain;
        const sent = yield* outbox();
        assert.deepEqual(
          sent.map((row) => [row.action, row.revision, row.receipt_json === null]),
          [["status", moved.revision, false]],
        );

        // The tracker closes the issue meanwhile: a status conflict.
        yield* sync.apply(projectId, "github_issues", record({ status: "done" }, milestone()));
        const link = yield* linkOf(id);
        assert.deepEqual(
          link.snapshot.conflicts.map((conflict) => conflict.field),
          ["status"],
        );
        const resolveLocal = sync.resolve({
          taskId: moved.key,
          expectedTaskRevision: moved.revision,
          provider: "github_issues",
          externalId: link.externalId,
          field: "status",
          expectedLinkRevision: link.snapshot.revision,
          resolution: "local",
        });

        // A failure after the enqueue, while the link is written, rolls both back.
        yield* sql`
          CREATE TEMP TRIGGER fail_link_write AFTER UPDATE ON houston_task_source_links
          BEGIN SELECT RAISE(ABORT, 'injected failure'); END
        `;
        const failed = yield* Effect.exit(resolveLocal);
        assert.isTrue(Exit.isFailure(failed));
        assert.deepEqual(yield* outbox(), sent);
        assert.deepEqual(
          (yield* linkOf(id)).snapshot.conflicts.map((conflict) => conflict.field),
          ["status"],
        );

        // Without the failure the resolution and the status write-back of the live value commit.
        yield* sql`DROP TRIGGER fail_link_write`;
        yield* resolveLocal;
        assert.deepEqual((yield* linkOf(id)).snapshot.conflicts, []);
        const [row] = yield* outbox();
        assert.strictEqual(row?.action, "status");
        assert.isNull(row?.receipt_json);
        assert.deepInclude(JSON.parse(row?.payload_json ?? "{}"), { status: "in_progress" });
      }),
    ),
  );
});

describe("a remote resolution sends nothing back to the tracker", () => {
  it.effect("a remote resolution sends nothing back to the tracker", () =>
    withSources(({ github }) =>
      Effect.gen(function* () {
        github.respond = (_url, request) =>
          request.method === "POST"
            ? new Response(JSON.stringify({ id: 1 }), { status: 201 })
            : new Response("[]", { status: 200 });
        const projectId = yield* createProject("remote-writeback");
        yield* enableGithub(projectId);
        const sync = yield* HoustonTaskSourceSync;
        const tasks = yield* HoustonTaskService.HoustonTaskService;
        const sql = yield* SqlClient.SqlClient;
        const drain = (yield* HoustonTaskSourceOutboxDrain).drain;
        const outbox = () =>
          sql<{
            readonly id: number;
            readonly action: string;
            readonly receipt_json: string | null;
          }>`SELECT id, action, receipt_json FROM houston_task_source_outbox ORDER BY id`;

        // An imported delivery the user moved on, its write-back sent, then closed by the tracker.
        const imported = yield* sync.apply(projectId, "github_issues", record({}, milestone()));
        const id = imported.taskId as number;
        const task = (yield* tasks.get({ id: String(id) })).task;
        const moved = yield* tasks.save({
          id: task.key,
          expectedRevision: task.revision,
          patch: { status: "in_progress" },
        });
        yield* drain;
        yield* sync.apply(projectId, "github_issues", record({ status: "done" }, milestone()));
        const link = yield* linkOf(id);
        const sent = yield* outbox();
        assert.isTrue(sent.every((row) => row.receipt_json !== null));

        // Taking the tracker's status changes the task and writes nothing back.
        github.requests.length = 0;
        yield* sync.resolve({
          taskId: moved.key,
          expectedTaskRevision: moved.revision,
          provider: "github_issues",
          externalId: link.externalId,
          field: "status",
          expectedLinkRevision: link.snapshot.revision,
          resolution: "remote",
        });
        assert.strictEqual((yield* tasks.get({ id: String(id) })).task.status, "done");
        assert.deepEqual(yield* outbox(), sent);
        yield* drain;
        assert.isTrue(github.requests.every((request) => request.method === "GET"));
      }),
    ),
  );
});
