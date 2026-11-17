// Write-back through the outbox: task transitions enqueue rows in their transaction, and the drain
// writes them to the loopback Notion fake over one database.
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import type * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as SqlClient from "effect/sql/SqlClient";
import { assert, describe, it } from "@effect/vitest";

import type { ProjectId } from "@houston-app/contracts";
import type { HoustonTask } from "@houston-app/contracts/houston/tasks";

import * as HoustonTaskService from "../tasks/TaskService.ts";
import { HoustonTaskStore, nowIso } from "../tasks/TaskStore.ts";
import { createProject, deleteProject } from "../tasks/tasks.testkit.ts";
import { HoustonTaskSourceOutboxDrain } from "./Outbox.ts";
import { retryDelayMillis } from "./rules.ts";
import { HoustonTaskSourceService } from "./SourceService.ts";
import { HoustonTaskSourceStore } from "./SourceStore.ts";
import { HoustonTaskSourceSync } from "./Sync.ts";
import {
  NOTION_SOURCE,
  layerSources,
  makeNotionFake,
  notionPage,
  notionSchema,
  notionServes,
  notionSettings,
  pageId,
  type NotionFake,
  type SourcesTestOptions,
} from "./taskSources.testkit.ts";

type Services = Layer.Success<ReturnType<typeof layerSources>>;

const NOTION_TOKEN = "ntn_outbox_test_token_5f1e";
const PAGE = pageId(1);
const PR_A = "https://github.com/octo-org/project/pull/4";
const PR_B = "https://github.com/octo-org/project/pull/5";

interface FakeNotion {
  readonly comments: Array<unknown>;
  readonly patches: Array<{ readonly body: unknown }>;
  failWrites: number | null;
}

/** The task data source with the pull request property the settings name, and the page writes. */
const serveNotion = (fake: NotionFake, pages: () => ReadonlyArray<unknown>) => {
  const state: FakeNotion = { comments: [], patches: [], failWrites: null };
  notionServes(fake, pages as never, {
    extra: (request) => {
      if (request.method === "GET" && request.path === `/v1/data_sources/${NOTION_SOURCE}`) {
        return {
          body: notionSchema(NOTION_SOURCE, {
            PR: { id: "pr", name: "PR", type: "url", url: {} },
          }),
        };
      }
      if (request.method === "PATCH" && request.path.startsWith("/v1/pages/")) {
        if (state.failWrites !== null) {
          return { status: state.failWrites, body: { object: "error" } };
        }
        state.patches.push({ body: request.body });
        return { body: pages()[0] ?? notionPage(1) };
      }
      if (request.method === "GET" && request.path.startsWith("/v1/comments?")) {
        return { body: { object: "list", results: state.comments, has_more: false } };
      }
      if (request.method === "POST" && request.path === "/v1/comments") {
        state.comments.push(request.body);
        return { body: { object: "comment" } };
      }
      return null;
    },
  });
  return state;
};

const withSources = <A, E>(
  body: (fakes: { notion: NotionFake }) => Effect.Effect<A, E, Services>,
  options: SourcesTestOptions = {},
) =>
  Effect.gen(function* () {
    const notion = yield* makeNotionFake;
    return yield* body({ notion }).pipe(
      Effect.provide(layerSources({ notionOrigin: notion.origin, ...options })),
    );
  }).pipe(Effect.scoped);

const settings = notionSettings({
  notionPrUrlPropertyId: "pr",
  notionStatusMapping: {
    todo: "Ready",
    inProgress: "Doing",
    inReview: "Doing",
    done: "Shipped",
    canceled: null,
  },
});

const enableNotion = (projectId: ProjectId, enabled = true) =>
  Effect.gen(function* () {
    const sources = yield* HoustonTaskSourceService;
    const [current] = yield* sources.getSettings({ projectId });
    yield* sources.setSettings({
      projectId,
      provider: "notion",
      ...(current === undefined || current.revision === 0
        ? {}
        : { expectedRevision: current.revision }),
      settings: { ...settings, enabled },
    });
  });

/** A project with an initiative and its Notion source enabled. */
const project = (name: string, options: { readonly notion?: boolean } = {}) =>
  Effect.gen(function* () {
    const sources = yield* HoustonTaskSourceService;
    const projectId = yield* createProject(name);
    yield* sources.setCredential({
      projectId,
      provider: "notion",
      token: Redacted.make(NOTION_TOKEN),
    });
    if (options.notion !== false) yield* enableNotion(projectId);
    return { projectId };
  });

/** A delivery imported from the page, placed in an initiative, with its source link. */
const importedDelivery = (projectId: ProjectId, externalId = PAGE) =>
  Effect.gen(function* () {
    const sync = yield* HoustonTaskSourceSync;
    const outcome = yield* sync.apply(projectId, "notion", {
      externalId,
      url: `https://www.notion.so/${externalId}`,
      remoteRev: null,
      fields: { title: "Page 1", description: "About 1", status: "todo" },
      project: {
        externalId: "notion:projects:page-7",
        url: "https://www.notion.so/project-7",
        title: "Launch",
        description: "Why",
        unverified: true,
      },
    });
    if (outcome.taskId === null) return yield* Effect.die(outcome.skipped ?? "not imported");
    return yield* current(outcome.taskId);
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

const sourceLinks = (taskId: number) =>
  Effect.gen(function* () {
    const store = yield* HoustonTaskSourceStore;
    return yield* store.linksOf(taskId);
  });

const writes = (notion: NotionFake) =>
  notion.requests.filter((request) => request.method === "PATCH" || request.method === "POST");

describe("one outbox row per task, provider, action and revision", () => {
  it.effect("one outbox row per task, provider, action and revision", () =>
    withSources(({ notion }) =>
      Effect.gen(function* () {
        const pages = [notionPage(1)];
        const fake = serveNotion(notion, () => pages);
        const where = yield* project("dedupe");
        const shipped = yield* importedDelivery(where.projectId);
        assert.isEmpty(yield* outboxRows);

        yield* setStatus(shipped.id, "in_progress");
        const first = yield* setStatus(shipped.id, "in_review");
        const rows = yield* outboxRows;
        assert.deepEqual(
          rows.map((row) => [row.task_id, row.provider, row.action, row.revision]),
          [
            [shipped.id, "notion", "status", first.revision - 1],
            [shipped.id, "notion", "status", first.revision],
          ],
        );

        yield* drain;
        assert.isTrue((yield* outboxRows).every((row) => row.receipt_json !== null));
        assert.deepEqual(fake.patches.at(-1), {
          body: { properties: { "St%3Aa": { status: { name: "Doing" } } } },
        });
        assert.isTrue(
          notion.requests.every(
            (request) =>
              request.authorization === `Bearer ${NOTION_TOKEN}` ||
              request.path.startsWith("/v1/data_sources"),
          ),
        );
        assert.deepEqual((yield* sourceLinks(shipped.id))[0]?.syncState, { state: "current" });
      }),
    ),
  );
});

describe("two slices hand back to notion with distinct identities", () => {
  it.effect("two slices hand back to notion with distinct identities", () =>
    withSources(({ notion }) =>
      Effect.gen(function* () {
        const pages = [notionPage(1)];
        const fake = serveNotion(notion, () => pages);
        const where = yield* project("notion-handback");
        const imported = yield* importedDelivery(where.projectId);
        const a = yield* slice(imported, "Slice A");
        const b = yield* slice(imported, "Slice B");
        notion.requests.length = 0;
        yield* handBack(a.id, "Same summary", PR_A);
        yield* handBack(b.id, "Same summary", PR_B);
        yield* drain;

        const sent = writes(notion);
        assert.isTrue(sent.every((request) => request.path !== "/v1/pages"));
        assert.isTrue(
          sent.every(
            (request) => request.path === `/v1/pages/${PAGE}` || request.path === "/v1/comments",
          ),
        );
        const statuses = sent.filter(
          (request) =>
            request.method === "PATCH" && JSON.stringify(request.body).includes('"St%3Aa"'),
        );
        assert.isNotEmpty(statuses);
        assert.deepEqual(statuses.at(-1)?.body, {
          properties: { "St%3Aa": { status: { name: "Doing" } } },
        });
        const urls = sent
          .filter((request) => JSON.stringify(request.body).includes('"pr"'))
          .map(
            (request) =>
              (request.body as { properties: { pr: { url: string } } }).properties.pr.url,
          );
        assert.deepEqual(urls, [PR_A, PR_B]);
        const posted = fake.comments.map((comment) =>
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
  it.effect("the outbox drains 25 rows per cycle in id order", () =>
    withSources(({ notion }) =>
      Effect.gen(function* () {
        const pages = [notionPage(1)];
        serveNotion(notion, () => pages);
        const where = yield* project("batches");
        const shipped = yield* importedDelivery(where.projectId);
        yield* drain;
        for (let index = 0; index < 30; index += 1) {
          yield* setStatus(shipped.id, index % 2 === 0 ? "in_progress" : "in_review");
        }
        const pending = (yield* outboxRows).filter((row) => row.receipt_json === null);
        assert.lengthOf(pending, 30);
        const outbox = yield* HoustonTaskSourceOutboxDrain;
        assert.strictEqual(yield* outbox.drainUpTo(25), 25);
        assert.deepEqual(
          (yield* outboxRows)
            .filter((row) => row.receipt_json !== null && row.action === "status")
            .map((row) => row.id),
          pending.slice(0, 25).map((row) => row.id),
        );
        yield* drain;
        assert.isTrue((yield* outboxRows).every((row) => row.receipt_json !== null));
      }),
    ),
  );

  it.effect("a failing row waits 1, 2 and 4 seconds and never more than an hour", () =>
    withSources(({ notion }) =>
      Effect.gen(function* () {
        const pages = [notionPage(1)];
        const fake = serveNotion(notion, () => pages);
        const where = yield* project("backoff");
        const shipped = yield* importedDelivery(where.projectId);
        yield* setStatus(shipped.id, "in_progress");
        fake.failWrites = 502;
        const sql = yield* SqlClient.SqlClient;
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
          const before = writes(notion).length;
          yield* drain;
          assert.strictEqual(writes(notion).length, before);
          yield* sql`
            UPDATE houston_task_source_outbox SET next_attempt_at = ${yield* nowIso}
            WHERE id = ${row?.id ?? -1}
          `;
        }
        assert.strictEqual(retryDelayMillis(0), 1_000);
        assert.strictEqual(retryDelayMillis(2), 4_000);
        assert.strictEqual(retryDelayMillis(11), 2_048_000);
        assert.strictEqual(retryDelayMillis(12), 3_600_000);
        assert.strictEqual(retryDelayMillis(40), 3_600_000);
        // The failure is visible on the link until a write succeeds.
        assert.deepEqual((yield* sourceLinks(shipped.id))[0]?.syncState.state, "error");
      }),
    ),
  );

  it.effect("a disabled or removed source fails its rows by name and sends nothing", () =>
    withSources(({ notion }) =>
      Effect.gen(function* () {
        serveNotion(notion, () => [notionPage(1)]);
        const quiet = yield* project("quiet");
        const quietDelivery = yield* importedDelivery(quiet.projectId);
        yield* setStatus(quietDelivery.id, "in_progress");
        yield* enableNotion(quiet.projectId, false);

        const gone = yield* project("gone");
        const goneDelivery = yield* importedDelivery(gone.projectId, pageId(2));
        yield* setStatus(goneDelivery.id, "in_progress");
        yield* deleteProject(gone.projectId);

        const before = writes(notion).length;
        yield* drain;
        assert.strictEqual(writes(notion).length, before);
        const rows = yield* outboxRows;
        const quietRow = rows.find(
          (row) => row.task_id === quietDelivery.id && row.action === "status",
        );
        const goneRow = rows.find(
          (row) => row.task_id === goneDelivery.id && row.action === "status",
        );
        assert.include(quietRow?.last_error ?? "", "tracker is disabled");
        assert.include(goneRow?.last_error ?? "", "tracker configuration was removed");
      }),
    ),
  );

  it.effect("a rolled-back task write enqueues nothing", () =>
    withSources(({ notion }) =>
      Effect.gen(function* () {
        serveNotion(notion, () => [notionPage(1)]);
        const sql = yield* SqlClient.SqlClient;
        const where = yield* project("rolled-back");
        const shipped = yield* importedDelivery(where.projectId);
        yield* sql`
          CREATE TEMP TRIGGER fail_task_write AFTER UPDATE ON houston_tasks
          BEGIN SELECT RAISE(ABORT, 'injected failure'); END
        `;
        const failed = yield* Effect.exit(setStatus(shipped.id, "in_progress"));
        assert.isTrue(Exit.isFailure(failed));
        yield* sql`DROP TRIGGER fail_task_write`;
        assert.isEmpty(yield* outboxRows);
      }),
    ),
  );
});
