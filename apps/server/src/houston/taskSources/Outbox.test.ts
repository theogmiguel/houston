// @effect-diagnostics nodeBuiltinImport:off - writes a Houston 1 database for the namespace import.
// Write-back through the outbox: task transitions enqueue rows in their transaction, and the drain
// writes them to the in-process GitHub fake and the loopback Notion fake, over one database.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import type { ProjectId } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import type { HoustonTask } from "@t3tools/contracts/houston/tasks";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import type * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import * as HoustonTaskService from "../tasks/TaskService.ts";
import { HoustonTaskStore, nowIso } from "../tasks/TaskStore.ts";
import * as HoustonTaskV1Import from "../tasks/V1Import.ts";
import { createProject, deleteProject } from "../tasks/tasks.testkit.ts";
import { writeV1Database } from "../tasks/v1Fixture.ts";
import { HoustonTaskSourceOutbox, HoustonTaskSourceOutboxDrain } from "./Outbox.ts";
import { HoustonTaskSourcePoller } from "./Poller.ts";
import { commentMarker, deliveryMarker, retryDelayMillis, taskIdentity } from "./rules.ts";
import { HoustonTaskSourceService } from "./SourceService.ts";
import { HoustonTaskSourceStore } from "./SourceStore.ts";
import {
  NOTION_PROJECTS,
  NOTION_SOURCE,
  layerSources,
  makeGithubFake,
  makeNotionFake,
  notionPage,
  notionSchema,
  notionServes,
  notionSettings,
  pageId,
  type GithubFake,
  type NotionFake,
  type SourcesTestOptions,
} from "./taskSources.testkit.ts";
import { HoustonTaskSourceV1Import } from "./V1Import.ts";
import { v1Settings, writeV1TrackerTables } from "./v1TrackerFixture.ts";

type Services = Layer.Success<ReturnType<typeof layerSources>>;

const NOTION_TOKEN = "ntn_outbox_test_token_5f1e";
const REPO = "octo-org/project";

const withSources = <A, E>(
  body: (fakes: { github: GithubFake; notion: NotionFake }) => Effect.Effect<A, E, Services>,
  options: SourcesTestOptions = {},
) =>
  Effect.gen(function* () {
    const notion = yield* makeNotionFake;
    const github = makeGithubFake();
    return yield* body({ github, notion }).pipe(
      Effect.provide(layerSources({ github, notionOrigin: notion.origin, ...options })),
    );
  }).pipe(Effect.scoped);

interface FakeIssue {
  readonly number: number;
  readonly html_url: string;
  title: string;
  body: string;
  state: string;
  readonly updated_at: string;
  labels: Array<{ readonly name: string }>;
  readonly assignees: Array<unknown>;
  readonly milestone: null;
  readonly user: { readonly login: string };
}

interface FakeComment {
  readonly body: string;
  readonly user: { readonly login: string };
}

/** The login the fake answers `GET /user` with: the account the credential acts as. */
const LOGIN = "Houston-Bot";
const AUTHOR = { login: LOGIN.toLowerCase() };

/** A repository's issues and comments as GitHub keeps them; answers reads and writes. */
const serveRepository = (fake: GithubFake, options: { readonly failWrites?: number } = {}) => {
  const issues: Array<FakeIssue> = [];
  const comments = new Map<number, Array<FakeComment>>();
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  fake.respond = (url, request) => {
    const path = url.pathname;
    if (path === "/user") return json(200, { login: LOGIN });
    if (path === `/repos/${REPO}/issues`) {
      if (request.method === "POST") {
        if (options.failWrites !== undefined) return json(options.failWrites, { message: "down" });
        const body = request.body as { readonly title: string; readonly body: string };
        const number = issues.length + 1;
        const issue: FakeIssue = {
          number,
          html_url: `https://github.com/${REPO}/issues/${number}`,
          title: body.title,
          body: body.body,
          state: "open",
          updated_at: "2026-10-01T00:00:00Z",
          labels: [],
          assignees: [],
          milestone: null,
          user: AUTHOR,
        };
        issues.push(issue);
        return json(201, issue);
      }
      const page = Number(url.searchParams.get("page") ?? "1");
      return json(200, issues.slice((page - 1) * 100, page * 100));
    }
    const commentPath = new RegExp(`^/repos/${REPO}/issues/(\\d+)/comments$`).exec(path);
    if (commentPath !== null) {
      const list = comments.get(Number(commentPath[1])) ?? [];
      comments.set(Number(commentPath[1]), list);
      if (request.method === "POST") {
        if (options.failWrites !== undefined) return json(options.failWrites, { message: "down" });
        list.push({ body: (request.body as { readonly body: string }).body, user: AUTHOR });
        return json(201, { id: list.length });
      }
      const page = Number(url.searchParams.get("page") ?? "1");
      return json(200, list.slice((page - 1) * 100, page * 100));
    }
    const issuePath = new RegExp(`^/repos/${REPO}/issues/(\\d+)$`).exec(path);
    if (issuePath !== null && request.method === "PATCH") {
      const issue = issues.find((entry) => entry.number === Number(issuePath[1]));
      if (issue === undefined) return json(404, { message: "Not Found" });
      issue.state = (request.body as { readonly state: string }).state;
      return json(200, issue);
    }
    return json(404, { message: "Not Found" });
  };
  return { issues, comments };
};

const writesTo = (fake: GithubFake) =>
  fake.requests.filter((request) => request.method === "POST" || request.method === "PATCH");

const enableGithub = (projectId: ProjectId, enabled = true) =>
  Effect.gen(function* () {
    const sources = yield* HoustonTaskSourceService;
    const [current] = yield* sources.getSettings({ projectId });
    yield* sources.setSettings({
      projectId,
      provider: "github_issues",
      ...(current === undefined || current.revision === 0
        ? {}
        : { expectedRevision: current.revision }),
      settings: { enabled, githubRepository: REPO, githubLabel: "import" },
    });
  });

/** A project with an initiative; GitHub write-back is enabled unless asked otherwise. */
const project = (name: string, options: { readonly github?: boolean } = {}) =>
  Effect.gen(function* () {
    const tasks = yield* HoustonTaskService.HoustonTaskService;
    const projectId = yield* createProject(name);
    if (options.github !== false) yield* enableGithub(projectId);
    const initiative = yield* tasks.saveInitiative({ projectId, name: "Launch" });
    return { projectId, initiativeId: initiative.id };
  });

/** A delivery created in backlog through the task service and placed in the initiative, so its
 * slices roll its status up. */
const delivery = (
  where: { readonly projectId: ProjectId; readonly initiativeId: number },
  title: string,
  description = `About ${title}`,
) =>
  Effect.gen(function* () {
    const tasks = yield* HoustonTaskService.HoustonTaskService;
    const created = yield* tasks.save({
      projectId: where.projectId,
      patch: { title, description, status: "backlog" },
    });
    yield* tasks.saveDomain({
      id: created.key,
      expectedRevision: created.revision,
      kind: "delivery",
      initiativeId: where.initiativeId,
    });
    return yield* current(created.id);
  });

/** A slice of `parent`, created through the task service. */
const slice = (parent: HoustonTask, title: string) =>
  Effect.gen(function* () {
    const tasks = yield* HoustonTaskService.HoustonTaskService;
    const created = yield* tasks.save({
      projectId: parent.projectId,
      patch: { title, parentId: parent.id as never, status: "in_progress" },
    });
    yield* tasks.saveDomain({ id: created.key, expectedRevision: created.revision, kind: "slice" });
    return yield* current(created.id);
  });

const current = (id: number) =>
  Effect.gen(function* () {
    const tasks = yield* HoustonTaskService.HoustonTaskService;
    return (yield* tasks.get({ id: String(id) })).task;
  });

const setStatus = (id: number, status: HoustonTask["status"]) =>
  Effect.gen(function* () {
    const tasks = yield* HoustonTaskService.HoustonTaskService;
    const task = yield* current(id);
    return yield* tasks.save({ id: task.key, expectedRevision: task.revision, patch: { status } });
  });

/** What task runs write when a run hands back: the run's summary and the move to review. */
const handBack = (id: number, summary: string, prUrl: string | null) =>
  Effect.gen(function* () {
    const store = yield* HoustonTaskStore;
    const sql = yield* SqlClient.SqlClient;
    yield* store.write(
      Effect.gen(function* () {
        const now = yield* nowIso;
        const task = yield* current(id);
        const [run] = yield* sql<{ readonly id: number }>`
          INSERT INTO houston_task_runs (
            task_id, attempt, kind, state, provider, initial_revision, summary, started_at,
            ended_at, pr_url
          ) VALUES (
            ${id}, 1, 'implementation', 'handed_back', 'claudeAgent', ${task.revision},
            ${summary}, ${now}, ${now}, ${prUrl}
          ) RETURNING id
        `;
        yield* sql`
          UPDATE houston_tasks SET status = 'in_review', revision = revision + 1,
            updated_at = ${now} WHERE id = ${id}
        `;
        yield* store.recordHistory(id, "user", "houston:handback", {
          status: { old: task.status, new: "in_review" },
          run: run?.id ?? null,
        });
        const rolled = yield* store.rollup(id);
        return { result: undefined, touched: [id, ...(rolled === undefined ? [] : [rolled])] };
      }).pipe(Effect.orDie),
    );
  });

/** What task runs write when the run's pull request merges. */
const merge = (id: number, prUrl: string) =>
  Effect.gen(function* () {
    const store = yield* HoustonTaskStore;
    const sql = yield* SqlClient.SqlClient;
    yield* store.write(
      Effect.gen(function* () {
        const now = yield* nowIso;
        const task = yield* current(id);
        yield* sql`
          UPDATE houston_tasks SET status = 'done', revision = revision + 1, updated_at = ${now}
          WHERE id = ${id}
        `;
        yield* store.recordHistory(id, "houston:pr", "houston:pr-merged", {
          status: { old: task.status, new: "done" },
          pullRequest: prUrl,
        });
        const rolled = yield* store.rollup(id);
        return { result: undefined, touched: [id, ...(rolled === undefined ? [] : [rolled])] };
      }).pipe(Effect.orDie),
    );
  });

interface OutboxRow {
  readonly id: number;
  readonly project_id: string;
  readonly task_id: number;
  readonly provider: string;
  readonly action: string;
  readonly revision: number;
  readonly payload_json: string;
  readonly attempts: number;
  readonly next_attempt_at: string;
  readonly last_error: string | null;
  readonly receipt_json: string | null;
}

const outboxRows = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql<OutboxRow>`SELECT * FROM houston_task_source_outbox ORDER BY id`;
});

const drain = Effect.gen(function* () {
  const outbox = yield* HoustonTaskSourceOutboxDrain;
  return yield* outbox.drain;
});

const namespace = Effect.gen(function* () {
  const outbox = yield* HoustonTaskSourceOutbox;
  return yield* outbox.namespace;
});

const markerKey = Effect.gen(function* () {
  const outbox = yield* HoustonTaskSourceOutbox;
  return yield* outbox.markerKey;
});

/** The comment marker of the outbox row of `taskId` with `action`. */
const rowMarker = (taskId: number, action: string, identityTask = taskId) =>
  Effect.gen(function* () {
    const row = (yield* outboxRows).find(
      (entry) => entry.task_id === taskId && entry.action === action,
    );
    return commentMarker(
      yield* markerKey,
      taskIdentity(yield* namespace, identityTask),
      row?.id ?? -1,
      action,
    );
  });

/** An issue as someone wrote it on GitHub, outside Houston. */
const plantedIssue = (number: number, body: string, login: string): FakeIssue => ({
  number,
  html_url: `https://github.com/${REPO}/issues/${number}`,
  title: `Planted ${number}`,
  body,
  state: "open",
  updated_at: "2026-10-01T00:00:00Z",
  labels: [],
  assignees: [],
  milestone: null,
  user: { login },
});

const sourceLinks = (taskId: number) =>
  Effect.gen(function* () {
    const store = yield* HoustonTaskSourceStore;
    return yield* store.linksOf(taskId);
  });

const PR_A = `https://github.com/${REPO}/pull/4`;
const PR_B = `https://github.com/${REPO}/pull/5`;

describe("one outbox row per task, provider, action and revision", () => {
  it.effect("one outbox row per task, provider, action and revision", () =>
    withSources(({ github }) =>
      Effect.gen(function* () {
        serveRepository(github);
        const where = yield* project("dedupe");
        const shipped = yield* delivery(where, "Ship");
        const rows = yield* outboxRows;
        assert.deepEqual(
          rows.map((row) => [row.task_id, row.provider, row.action, row.revision]),
          [[shipped.id, "github_issues", "create", shipped.revision]],
        );

        // The same transition heard again adds no row.
        const outbox = yield* HoustonTaskSourceOutbox;
        const store = yield* HoustonTaskStore;
        yield* store.write(
          outbox
            .recorded([{ taskId: shipped.id, actor: "user", action: "domain_update", changes: {} }])
            .pipe(Effect.as({ result: undefined, touched: [] })),
        );
        assert.lengthOf(yield* outboxRows, 1);

        // A task without a domain row, and an unassigned delivery, enqueue nothing.
        const tasks = yield* HoustonTaskService.HoustonTaskService;
        const plain = yield* tasks.save({
          projectId: where.projectId,
          patch: { title: "Plain", status: "todo" },
        });
        yield* setStatus(plain.id, "in_progress");
        const loose = yield* tasks.save({ projectId: null, patch: { title: "Loose" } });
        yield* tasks.saveDomain({
          id: loose.key,
          expectedRevision: loose.revision,
          kind: "delivery",
        });
        yield* setStatus(loose.id, "in_progress");
        assert.lengthOf(yield* outboxRows, 1);

        // A disabled source enqueues nothing either.
        yield* enableGithub(where.projectId, false);
        yield* delivery(where, "Quiet");
        yield* setStatus(shipped.id, "in_progress");
        assert.lengthOf(yield* outboxRows, 1);
      }),
    ),
  );
});

describe("a delivery opens one marked issue and a retry reuses it", () => {
  it.effect("a delivery opens one marked issue and a retry reuses it", () =>
    withSources(({ github }) =>
      Effect.gen(function* () {
        const repository = serveRepository(github);
        const ns = yield* namespace;
        const key = yield* markerKey;
        const where = yield* project("opens");
        const description = `This closes #3. ${"d".repeat(8_000)}`;
        const shipped = yield* delivery(where, "Ship the importer", description);
        yield* drain;
        const [create] = writesTo(github);
        assert.strictEqual(create?.method, "POST");
        assert.isTrue(create?.url.endsWith(`/repos/${REPO}/issues`));
        const body = create?.body as { readonly title: string; readonly body: string };
        assert.strictEqual(body.title, "Ship the importer");
        const marker = deliveryMarker(ns, key, shipped.id);
        assert.isTrue(body.body.endsWith(`\n\n${marker}`));
        const text = body.body.slice(0, -`\n\n${marker}`.length);
        assert.notMatch(text, /closes/i);
        assert.isAtMost([...text].length, 7_600);
        assert.lengthOf(repository.issues, 1);
        const [link] = yield* sourceLinks(shipped.id);
        assert.deepInclude(link, {
          provider: "github_issues",
          externalId: `${REPO}#1`,
          url: `https://github.com/${REPO}/issues/1`,
          source: "source",
        });
        assert.isNotNull((yield* outboxRows)[0]?.receipt_json);

        // A second delivery whose issue a previous attempt already opened: the lookup finds the
        // marker, nothing is created, and the found issue becomes its link.
        github.requests.length = 0;
        const second = yield* delivery(where, "Ship the exporter");
        repository.issues.push(
          plantedIssue(2, `About it\n\n${deliveryMarker(ns, key, second.id)}`, AUTHOR.login),
        );
        yield* drain;
        assert.lengthOf(writesTo(github), 0);
        assert.isTrue(github.requests.every((request) => request.method === "GET"));
        assert.lengthOf(repository.issues, 2);
        assert.strictEqual((yield* sourceLinks(second.id))[0]?.externalId, `${REPO}#2`);
      }),
    ),
  );

  it.effect("a successful create keeps existing conflicts", () =>
    withSources(({ github }) =>
      Effect.gen(function* () {
        const repository = serveRepository(github);
        const where = yield* project("conflicts");
        const shipped = yield* delivery(where, "Ship");
        // A second create row, enqueued by an edit before the first one was sent.
        const tasks = yield* HoustonTaskService.HoustonTaskService;
        yield* tasks.save({
          id: shipped.key,
          expectedRevision: shipped.revision,
          patch: { description: "Edited" },
        });
        assert.deepEqual(
          (yield* outboxRows).map((row) => row.action),
          ["create", "create"],
        );
        const outbox = yield* HoustonTaskSourceOutboxDrain;
        assert.strictEqual(yield* outbox.drainUpTo(1), 1);
        // The issue is labelled and renamed on GitHub, and a poll records the conflict.
        const issue = repository.issues[0] as FakeIssue;
        issue.labels = [{ name: "import" }];
        issue.title = "Renamed remotely";
        const poller = yield* HoustonTaskSourcePoller;
        yield* poller.poll(where.projectId, "github_issues");
        const before = (yield* sourceLinks(shipped.id))[0];
        assert.deepEqual(
          before?.snapshot.conflicts.map((conflict) => conflict.field),
          ["title"],
        );
        github.requests.length = 0;
        yield* drain;
        assert.lengthOf(writesTo(github), 0);
        assert.lengthOf(repository.issues, 1);
        const after = yield* sourceLinks(shipped.id);
        assert.lengthOf(after, 1);
        assert.deepEqual(after[0]?.snapshot.conflicts, before?.snapshot.conflicts);
        assert.isTrue((yield* outboxRows).every((row) => row.receipt_json !== null));
      }),
    ),
  );
});

describe("github comments are marked, deduplicated and target the delivery", () => {
  it.effect("github comments are marked, deduplicated and target the delivery", () =>
    withSources(({ github }) =>
      Effect.gen(function* () {
        const repository = serveRepository(github);
        const ns = yield* namespace;
        const where = yield* project("comments");
        const shipped = yield* delivery(where, "Ship");
        yield* drain;
        const issueComments = () => repository.comments.get(1) ?? [];

        // A status change comments once with its marker.
        yield* setStatus(shipped.id, "in_progress");
        yield* drain;
        const statusMarker = yield* rowMarker(shipped.id, "status");
        assert.deepEqual(
          issueComments().map((comment) => comment.body),
          [`Task status: in_progress\n\n${statusMarker}`],
        );
        // A row whose receipt was lost finds its marker and posts nothing.
        const sql = yield* SqlClient.SqlClient;
        yield* sql`UPDATE houston_task_source_outbox SET receipt_json = NULL WHERE action = 'status'`;
        github.requests.length = 0;
        yield* drain;
        assert.lengthOf(writesTo(github), 0);
        assert.lengthOf(issueComments(), 1);

        // Two sibling slices hand back and merge onto the delivery's issue.
        const sliceA = yield* slice(shipped, "Slice A");
        const sliceB = yield* slice(shipped, "Slice B");
        yield* handBack(sliceA.id, "This closes #7 and fixes #8", PR_A);
        yield* handBack(sliceB.id, "Did B", PR_B);
        yield* merge(sliceA.id, PR_A);
        yield* merge(sliceB.id, PR_B);
        yield* drain;
        const bodies = issueComments().map((comment) => comment.body);
        for (const body of bodies) {
          assert.notMatch(body, /\b(closes|fixes)\b/i);
          assert.match(
            body,
            /<!-- houston-task:houston-task-[0-9a-f]{32}-\d+:\d+:[a-z_]+:[0-9a-f]{32} -->$/,
          );
        }
        assert.lengthOf(
          bodies.filter((body) => body.startsWith(`Pull request: ${PR_A}\n`)),
          1,
        );
        assert.lengthOf(
          bodies.filter((body) => body.startsWith(`Pull request: ${PR_B}\n`)),
          1,
        );
        const summaries = bodies.filter((body) => /:summary_comment:[0-9a-f]{32} -->$/.test(body));
        assert.isTrue(summaries.some((body) => body.startsWith("Slice A: This  `#7` and  `#8`")));
        assert.isTrue(summaries.some((body) => body.startsWith("Slice B: Did B")));
        assert.isTrue(
          summaries.some((body) => body.includes(`houston-task-${ns}-${sliceA.id}:`)) &&
            summaries.some((body) => body.includes(`houston-task-${ns}-${sliceB.id}:`)),
        );
        // Every comment went to the delivery's issue; the slices have no issue of their own.
        assert.deepEqual([...repository.comments.keys()], [1]);
        assert.lengthOf(repository.issues, 1);
        const linksA = yield* sourceLinks(sliceA.id);
        const linksB = yield* sourceLinks(sliceB.id);
        assert.deepEqual(
          linksA.map((link) => [link.source, link.externalId]),
          [["pull_request", PR_A]],
        );
        assert.deepEqual(
          linksB.map((link) => [link.source, link.externalId]),
          [["pull_request", PR_B]],
        );

        // A pull request on another host is refused by name and nothing is posted for it.
        const sliceC = yield* slice(shipped, "Slice C");
        github.requests.length = 0;
        yield* handBack(sliceC.id, "Did C", "https://evil.example/octo-org/project/pull/6");
        yield* drain;
        assert.isFalse(
          writesTo(github).some((request) => JSON.stringify(request.body).includes("evil")),
        );
        const refused = (yield* outboxRows).find(
          (row) => row.task_id === sliceC.id && row.action === "pr_reference",
        );
        assert.include(refused?.last_error ?? "", "https://github.com/octo-org/project/pull/");
        assert.strictEqual(refused?.attempts, 1);
      }),
    ),
  );
});

describe("only a trailing marker Houston's account wrote is adopted", () => {
  it.effect("a description holding the next delivery's marker cannot take its issue", () =>
    withSources(({ github }) =>
      Effect.gen(function* () {
        const repository = serveRepository(github);
        const ns = yield* namespace;
        const key = yield* markerKey;
        const where = yield* project("hijack");
        const first = yield* delivery(where, "First");
        const second = yield* delivery(where, "Second");
        // The first delivery's description quotes the second's marker and mentions a team.
        const tasks = yield* HoustonTaskService.HoustonTaskService;
        yield* tasks.save({
          id: first.key,
          expectedRevision: first.revision,
          patch: {
            description: `cc @octo-org/everyone ${deliveryMarker(ns, key, second.id)} see #12`,
          },
        });
        yield* drain;
        assert.lengthOf(repository.issues, 2);
        assert.strictEqual((yield* sourceLinks(first.id))[0]?.externalId, `${REPO}#1`);
        assert.strictEqual((yield* sourceLinks(second.id))[0]?.externalId, `${REPO}#2`);
        assert.isTrue((yield* outboxRows).every((row) => row.last_error === null));
        // The copied mention and reference reach GitHub inert.
        const body = repository.issues[0]?.body ?? "";
        assert.include(body, "cc `@octo-org/everyone` ");
        assert.include(body, " see `#12`");
        assert.notMatch(body, /(^|[^`])@octo-org/);
      }),
    ),
  );

  it.effect("an issue or comment with the marker by another account is not adopted", () =>
    withSources(({ github }) =>
      Effect.gen(function* () {
        const repository = serveRepository(github);
        const ns = yield* namespace;
        const key = yield* markerKey;
        const where = yield* project("planted");
        const shipped = yield* delivery(where, "Shipped");
        repository.issues.push(
          plantedIssue(1, `Planted\n\n${deliveryMarker(ns, key, shipped.id)}`, "mallory"),
        );
        yield* drain;
        assert.lengthOf(repository.issues, 2);
        assert.strictEqual(repository.issues[1]?.user.login, AUTHOR.login);
        assert.strictEqual((yield* sourceLinks(shipped.id))[0]?.externalId, `${REPO}#2`);

        // A status comment whose marker another account posted first is still posted.
        yield* setStatus(shipped.id, "in_progress");
        const marker = yield* rowMarker(shipped.id, "status");
        repository.comments.set(2, [
          { body: `Task status: done\n\n${marker}`, user: { login: "mallory" } },
        ]);
        yield* drain;
        assert.deepEqual(
          (repository.comments.get(2) ?? []).map((comment) => [comment.user.login, comment.body]),
          [
            ["mallory", `Task status: done\n\n${marker}`],
            [AUTHOR.login, `Task status: in_progress\n\n${marker}`],
          ],
        );
      }),
    ),
  );
});

describe("a status retry after a lost receipt and an edit posts nothing new", () => {
  it.effect("a status retry after a lost receipt and an edit posts nothing new", () =>
    withSources(({ github }) =>
      Effect.gen(function* () {
        const repository = serveRepository(github);
        const where = yield* project("lost-receipt");
        const shipped = yield* delivery(where, "Ship");
        yield* drain;
        const moved = yield* setStatus(shipped.id, "in_progress");
        yield* drain;
        assert.lengthOf(repository.comments.get(1) ?? [], 1);
        // The receipt is lost, then the title is edited before the retry.
        const sql = yield* SqlClient.SqlClient;
        yield* sql`UPDATE houston_task_source_outbox SET receipt_json = NULL WHERE action = 'status'`;
        const tasks = yield* HoustonTaskService.HoustonTaskService;
        yield* tasks.save({
          id: moved.key,
          expectedRevision: moved.revision,
          patch: { title: "Ship it now" },
        });
        github.requests.length = 0;
        yield* drain;
        assert.lengthOf(writesTo(github), 0);
        assert.deepEqual(
          (repository.comments.get(1) ?? []).map((comment) => comment.body.split("\n")[0]),
          ["Task status: in_progress"],
        );
      }),
    ),
  );
});

describe("a link of another repository is never written through the configured one", () => {
  it.effect("a link of another repository is never written through the configured one", () =>
    withSources(({ github }) =>
      Effect.gen(function* () {
        const repository = serveRepository(github);
        const where = yield* project("moved-repository");
        const shipped = yield* delivery(where, "Ship");
        yield* drain;
        assert.strictEqual((yield* sourceLinks(shipped.id))[0]?.externalId, `${REPO}#1`);
        // The repository setting moves; the delivery keeps its link to the old repository.
        const sources = yield* HoustonTaskSourceService;
        const [settings] = yield* sources.getSettings({ projectId: where.projectId });
        yield* sources.setSettings({
          projectId: where.projectId,
          provider: "github_issues",
          expectedRevision: settings?.revision ?? 0,
          settings: { enabled: true, githubRepository: "octo-org/moved", githubLabel: "import" },
        });
        github.requests.length = 0;
        yield* setStatus(shipped.id, "in_progress");
        yield* drain;
        assert.lengthOf(writesTo(github), 0);
        assert.lengthOf(github.requests, 0);
        assert.lengthOf(repository.comments.get(1) ?? [], 0);
        const status = (yield* outboxRows).find((row) => row.action === "status");
        assert.isNull(status?.receipt_json);
        assert.strictEqual(status?.attempts, 1);
        assert.include(status?.last_error ?? "", `"${REPO}#1"`);
        assert.include(status?.last_error ?? "", '"octo-org/moved"');
      }),
    ),
  );
});

describe("a rolled-back task write enqueues nothing", () => {
  it.effect("a rolled-back task write enqueues nothing", () =>
    withSources(({ github }) =>
      Effect.gen(function* () {
        serveRepository(github);
        const where = yield* project("rolled-back");
        const shipped = yield* delivery(where, "Ship");
        yield* drain;
        const before = yield* outboxRows;
        // A status change whose write fails after its history row.
        const store = yield* HoustonTaskStore;
        const sql = yield* SqlClient.SqlClient;
        const failed = yield* Effect.exit(
          store.write(
            Effect.gen(function* () {
              const now = yield* nowIso;
              yield* sql`
                UPDATE houston_tasks SET status = 'in_progress', revision = revision + 1,
                  updated_at = ${now} WHERE id = ${shipped.id}
              `.pipe(Effect.orDie);
              yield* store.recordHistory(shipped.id, "user", "update", {
                status: { old: "backlog", new: "in_progress" },
              });
              return yield* Effect.fail("injected failure" as const);
            }),
          ),
        );
        assert.isTrue(failed._tag === "Failure");
        assert.strictEqual((yield* current(shipped.id)).status, "backlog");
        // The next write records nothing of its own and enqueues nothing for the failed one.
        yield* store.write(Effect.succeed({ result: undefined, touched: [] }));
        assert.deepEqual(yield* outboxRows, before);
      }),
    ),
  );
});

describe("a delivery issue closes only when every slice is done", () => {
  it.effect("a delivery issue closes only when every slice is done", () =>
    withSources(({ github }) =>
      Effect.gen(function* () {
        const repository = serveRepository(github);
        const where = yield* project("close");
        const closes = () => writesTo(github).filter((request) => request.method === "PATCH");

        // Both slices done: the rollup closes the issue.
        const rolled = yield* delivery(where, "Rolled");
        yield* drain;
        const a = yield* slice(rolled, "A");
        const b = yield* slice(rolled, "B");
        yield* setStatus(a.id, "done");
        yield* drain;
        assert.lengthOf(closes(), 0);
        yield* setStatus(b.id, "done");
        yield* drain;
        assert.lengthOf(closes(), 1);
        assert.isTrue(closes()[0]?.url.endsWith(`/repos/${REPO}/issues/1`));
        assert.deepEqual(closes()[0]?.body, { state: "closed" });
        assert.strictEqual(repository.issues[0]?.state, "closed");

        // The user sets a delivery without slices done: its issue closes.
        const manual = yield* delivery(where, "Manual");
        yield* drain;
        yield* setStatus(manual.id, "done");
        yield* drain;
        assert.lengthOf(closes(), 2);
        assert.strictEqual(repository.issues[1]?.state, "closed");

        // A reopened delivery: its slices finishing roll nothing up and close nothing.
        const reopened = yield* delivery(where, "Reopened");
        yield* drain;
        const c = yield* slice(reopened, "C");
        const d = yield* slice(reopened, "D");
        yield* setStatus(reopened.id, "todo");
        yield* setStatus(c.id, "done");
        yield* setStatus(d.id, "done");
        yield* drain;
        assert.lengthOf(closes(), 2);
        assert.strictEqual(repository.issues[2]?.state, "open");

        // A close retried after a slice reopened re-checks the slices and sends nothing.
        const retried = yield* delivery(where, "Retried");
        yield* drain;
        const e = yield* slice(retried, "E");
        const f = yield* slice(retried, "F");
        yield* setStatus(e.id, "done");
        yield* setStatus(f.id, "done");
        assert.isTrue(
          (yield* outboxRows).some(
            (row) =>
              row.action === "delivery_close" &&
              row.task_id === retried.id &&
              row.receipt_json === null,
          ),
        );
        yield* setStatus(e.id, "in_progress");
        yield* drain;
        assert.lengthOf(closes(), 2);
        assert.strictEqual(repository.issues[3]?.state, "open");
        const close = (yield* outboxRows).find(
          (row) => row.action === "delivery_close" && row.task_id === retried.id,
        );
        assert.deepEqual(JSON.parse(close?.receipt_json ?? "null"), { superseded: true });
      }),
    ),
  );
});

describe("two slices hand back to notion with distinct identities", () => {
  it.effect("two slices hand back to notion with distinct identities", () =>
    withSources(({ notion }) =>
      Effect.gen(function* () {
        const settings = notionSettings({
          notionProjectsDataSourceId: NOTION_PROJECTS,
          notionProjectRelationPropertyId: "rel",
          notionProjectTitlePropertyId: "ptitle",
          notionPrUrlPropertyId: "pr",
          notionStatusMapping: {
            todo: "Ready",
            inProgress: "Doing",
            inReview: "Doing",
            done: "Shipped",
            canceled: null,
          },
        });
        const page = notionPage(1, {
          properties: {
            ...notionPage(1).properties,
            Project: { id: "rel", type: "relation", relation: [{ id: pageId(101) }] },
          },
        });
        const comments: Array<unknown> = [];
        notionServes(notion, () => [page], {
          extra: (request) => {
            if (request.method === "GET" && request.path === `/v1/data_sources/${NOTION_SOURCE}`) {
              return {
                body: notionSchema(NOTION_SOURCE, {
                  Project: {
                    id: "rel",
                    name: "Project",
                    type: "relation",
                    relation: { data_source_id: NOTION_PROJECTS },
                  },
                  PR: { id: "pr", name: "PR", type: "url", url: {} },
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
            if (request.method === "GET" && request.path === `/v1/pages/${pageId(101)}`) {
              return {
                body: {
                  object: "page",
                  id: pageId(101),
                  url: "https://www.notion.so/project-101",
                  parent: { type: "data_source_id", data_source_id: NOTION_PROJECTS },
                  properties: {
                    Name: { id: "ptitle", type: "title", title: [{ plain_text: "Launch" }] },
                  },
                },
              };
            }
            if (request.method === "PATCH" && request.path === `/v1/pages/${pageId(1)}`) {
              return { body: page };
            }
            if (request.method === "GET" && request.path.startsWith("/v1/comments?")) {
              return { body: { object: "list", results: comments, has_more: false } };
            }
            if (request.method === "POST" && request.path === "/v1/comments") {
              comments.push(request.body);
              return { body: { object: "comment" } };
            }
            return null;
          },
        });
        const projectId = yield* createProject("notion-handback");
        const sources = yield* HoustonTaskSourceService;
        yield* sources.setCredential({
          projectId,
          provider: "notion",
          token: Redacted.make(NOTION_TOKEN),
        });
        yield* sources.setSettings({ projectId, provider: "notion", settings });
        const poller = yield* HoustonTaskSourcePoller;
        const polled = yield* poller.poll(projectId, "notion");
        assert.isNull(polled?.error ?? null);
        const imported = yield* current(1);
        const a = yield* slice(imported, "Slice A");
        const b = yield* slice(imported, "Slice B");
        notion.requests.length = 0;
        yield* handBack(a.id, "Same summary", PR_A);
        yield* handBack(b.id, "Same summary", PR_B);
        yield* drain;

        const writes = notion.requests.filter(
          (request) => request.method === "PATCH" || request.method === "POST",
        );
        assert.isTrue(writes.every((request) => request.path !== "/v1/pages"));
        assert.isTrue(
          writes.every(
            (request) =>
              request.path === `/v1/pages/${pageId(1)}` || request.path === "/v1/comments",
          ),
        );
        const statuses = writes.filter(
          (request) =>
            request.method === "PATCH" && JSON.stringify(request.body).includes('"St%3Aa"'),
        );
        assert.isNotEmpty(statuses);
        assert.deepEqual(statuses.at(-1)?.body, {
          properties: { "St%3Aa": { status: { name: "Doing" } } },
        });
        const urls = writes
          .filter((request) => JSON.stringify(request.body).includes('"pr"'))
          .map(
            (request) =>
              (request.body as { properties: { pr: { url: string } } }).properties.pr.url,
          );
        assert.deepEqual(urls, [PR_A, PR_B]);
        const posted = comments.map((comment) =>
          (comment as { rich_text: Array<{ text: { content: string } }> }).rich_text
            .map((chunk) => chunk.text.content)
            .join(""),
        );
        assert.lengthOf(posted, 2);
        assert.isTrue(posted[0]?.startsWith("Slice A: Same summary"));
        assert.isTrue(posted[1]?.startsWith("Slice B: Same summary"));
        const markers = posted.map((text) => /houston-handback:[0-9a-f]{24}$/.exec(text)?.[0]);
        assert.notStrictEqual(markers[0], markers[1]);
        assert.isTrue(
          notion.requests.every((request) => request.authorization === `Bearer ${NOTION_TOKEN}`),
        );
        assert.isTrue((yield* outboxRows).every((row) => row.receipt_json !== null));
        assert.deepEqual(
          (yield* sourceLinks(a.id)).map((link) => [link.provider, link.source, link.externalId]),
          [["notion", "pull_request", PR_A]],
        );
      }),
    ),
  );
});

describe("the outbox drains in bounded batches with backoff", () => {
  it.effect("the outbox drains every 20 seconds, 25 rows per cycle in id order", () =>
    withSources(({ github }) =>
      Effect.gen(function* () {
        serveRepository(github);
        const where = yield* project("batches");
        const shipped = yield* delivery(where, "Ship");
        yield* drain;
        for (let index = 0; index < 30; index += 1) {
          yield* setStatus(shipped.id, index % 2 === 0 ? "in_progress" : "todo");
        }
        const pending = (yield* outboxRows).filter((row) => row.receipt_json === null);
        assert.lengthOf(pending, 30);
        yield* TestClock.adjust(Duration.seconds(19));
        assert.lengthOf(
          (yield* outboxRows).filter((row) => row.receipt_json === null),
          30,
        );
        yield* TestClock.adjust(Duration.seconds(1));
        const afterOne = yield* outboxRows;
        assert.deepEqual(
          afterOne
            .filter((row) => row.receipt_json !== null && row.action === "status")
            .map((row) => row.id),
          pending.slice(0, 25).map((row) => row.id),
        );
        yield* TestClock.adjust(Duration.seconds(20));
        assert.isTrue((yield* outboxRows).every((row) => row.receipt_json !== null));
      }),
    ),
  );

  it.effect("a failing row waits 1, 2 and 4 seconds and never more than an hour", () =>
    withSources(({ github }) =>
      Effect.gen(function* () {
        const repository = serveRepository(github);
        const where = yield* project("backoff");
        const shipped = yield* delivery(where, "Ship");
        yield* drain;
        assert.lengthOf(repository.issues, 1);
        yield* setStatus(shipped.id, "in_progress");
        serveRepository(github, { failWrites: 502 }).issues.push(...repository.issues);
        const plusSeconds = (iso: string, seconds: number) =>
          DateTime.formatIso(DateTime.add(DateTime.makeUnsafe(iso), { seconds }));
        const statusRow = Effect.map(outboxRows, (rows) =>
          rows.find((row) => row.action === "status"),
        );
        for (const [attempts, wait] of [
          [1, 1],
          [2, 2],
          [3, 4],
        ] as const) {
          const failedAt = yield* nowIso;
          yield* drain;
          const row = yield* statusRow;
          assert.strictEqual(row?.attempts, attempts);
          assert.include(row?.last_error ?? "", "502");
          assert.strictEqual(row?.next_attempt_at, plusSeconds(failedAt, wait));
          // Not due yet: another drain sends nothing.
          github.requests.length = 0;
          yield* drain;
          assert.lengthOf(github.requests, 0);
          yield* TestClock.adjust(Duration.seconds(wait));
        }
        assert.strictEqual(retryDelayMillis(0), 1_000);
        assert.strictEqual(retryDelayMillis(2), 4_000);
        assert.strictEqual(retryDelayMillis(11), 2_048_000);
        assert.strictEqual(retryDelayMillis(12), 3_600_000);
        assert.strictEqual(retryDelayMillis(40), 3_600_000);
        // The failure is visible on the delivery's link until a write succeeds.
        assert.deepEqual((yield* sourceLinks(shipped.id))[0]?.syncState.state, "error");
      }),
    ),
  );

  it.effect("a disabled or removed source fails its rows by name and sends nothing", () =>
    withSources(({ github }) =>
      Effect.gen(function* () {
        serveRepository(github);
        const quiet = yield* project("quiet");
        const quietDelivery = yield* delivery(quiet, "Quiet");
        yield* drain;
        yield* setStatus(quietDelivery.id, "in_progress");
        yield* enableGithub(quiet.projectId, false);

        const gone = yield* project("gone");
        const goneDelivery = yield* delivery(gone, "Gone");
        yield* drain;
        yield* setStatus(goneDelivery.id, "in_progress");
        yield* deleteProject(gone.projectId);

        github.requests.length = 0;
        yield* drain;
        assert.lengthOf(github.requests, 0);
        const rows = yield* outboxRows;
        const quietRow = rows.find(
          (row) => row.task_id === quietDelivery.id && row.action === "status",
        );
        const goneRow = rows.find(
          (row) => row.task_id === goneDelivery.id && row.action === "status",
        );
        assert.include(quietRow?.last_error ?? "", "tracker is disabled");
        assert.isNull(quietRow?.receipt_json);
        assert.include(goneRow?.last_error ?? "", "tracker configuration was removed");
        assert.isNull(goneRow?.receipt_json);
      }),
    ),
  );

  it.effect("a row that no longer matches live state is superseded and sends nothing", () =>
    withSources(({ github }) =>
      Effect.gen(function* () {
        serveRepository(github);
        const where = yield* project("moving");
        const other = yield* createProject("elsewhere");
        const shipped = yield* delivery(where, "Ship");
        yield* drain;
        const moved = yield* setStatus(shipped.id, "in_progress");
        const tasks = yield* HoustonTaskService.HoustonTaskService;
        yield* tasks.save({
          id: moved.key,
          expectedRevision: moved.revision,
          patch: { projectId: other },
        });
        github.requests.length = 0;
        yield* drain;
        assert.lengthOf(github.requests, 0);
        const row = (yield* outboxRows).find((entry) => entry.action === "status");
        assert.deepEqual(JSON.parse(row?.receipt_json ?? "null"), { superseded: true });
      }),
    ),
  );
});

describe("the marker namespace is fixed once written", () => {
  it.effect("the namespace is 32 hex digits, written once and kept across a reopen", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "houston-sources-namespace-" });
      const options: SourcesTestOptions = {
        databaseFile: NodePath.join(dir, "state.sqlite"),
        baseDir: dir,
      };
      const first = yield* Effect.gen(function* () {
        const ns = yield* namespace;
        assert.match(ns, /^[0-9a-f]{32}$/);
        assert.strictEqual(yield* namespace, ns);
        return ns;
      }).pipe(Effect.provide(layerSources({ ...options, github: makeGithubFake() })));
      const reopened = yield* namespace.pipe(
        Effect.provide(layerSources({ ...options, github: makeGithubFake() })),
      );
      assert.strictEqual(reopened, first);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("after a tracker import the namespace is Houston 1's", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const channel = yield* fs.makeTempDirectoryScoped({ prefix: "houston-sources-namespace-" });
      const baseDir = NodePath.join(channel, "v2");
      NodeFS.mkdirSync(baseDir);
      const source = NodePath.join(channel, "houston.db");
      const root =
        HostProcess.Platform.defaultValue() === "win32" ? "C:\\work\\shop" : "/work/shop";
      const v1Namespace = "feedfacefeedfacefeedfacefeedface";
      writeV1Database(source, { nextNumber: 1, tasks: [] });
      writeV1TrackerTables(source, {
        namespace: v1Namespace,
        settings: [
          v1Settings(root, "github_issues", { github_repository: REPO, github_label: "import" }),
        ],
        links: [],
        outbox: [],
        pollState: [],
        refreshCursors: [],
      });
      yield* Effect.gen(function* () {
        yield* createProject("shop", root);
        yield* (yield* HoustonTaskV1Import.HoustonTaskV1Import).run;
        yield* (yield* HoustonTaskSourceV1Import).run;
        assert.strictEqual(yield* namespace, v1Namespace);
      }).pipe(Effect.provide(layerSources({ baseDir, github: makeGithubFake() })));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});

describe("the marker key is random, written once and kept", () => {
  it.effect("the marker key is random, written once and kept", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "houston-sources-marker-key-" });
      const options: SourcesTestOptions = {
        databaseFile: NodePath.join(dir, "state.sqlite"),
        baseDir: dir,
      };
      const first = yield* Effect.gen(function* () {
        const key = yield* markerKey;
        assert.match(key, /^[0-9a-f]{32}$/);
        assert.notStrictEqual(key, yield* namespace);
        assert.strictEqual(yield* markerKey, key);
        const sql = yield* SqlClient.SqlClient;
        assert.deepEqual(
          yield* sql`SELECT marker_key FROM houston_task_source_identity WHERE id = 1`,
          [{ marker_key: key }],
        );
        return key;
      }).pipe(Effect.provide(layerSources({ ...options, github: makeGithubFake() })));
      const reopened = yield* markerKey.pipe(
        Effect.provide(layerSources({ ...options, github: makeGithubFake() })),
      );
      assert.strictEqual(reopened, first);
      // Another installation draws another key.
      const other = yield* markerKey.pipe(
        Effect.provide(layerSources({ github: makeGithubFake() })),
      );
      assert.notStrictEqual(other, first);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
