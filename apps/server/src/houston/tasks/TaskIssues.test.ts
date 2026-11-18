// Issue-backed tasks: one link per task, one live task per issue, and the issue's words stay put.
import { assert, describe, it } from "@effect/vitest";
import { ProjectId, IssueOperationError, type IssueRef } from "@houston-app/contracts";
import { HoustonTaskError, type HoustonTaskDetail } from "@houston-app/contracts/houston/tasks";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as IssueService from "../../issue/IssueService.ts";
import * as HoustonTaskService from "./TaskService.ts";
import { createProject, issueDetailFor, layerIssueService, layerTasks } from "./tasks.testkit.ts";

const service = HoustonTaskService.HoustonTaskService;

const refusal = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.exit(effect).pipe(
    Effect.map((exit) => {
      assert.isTrue(Exit.isFailure(exit), "expected a refusal");
      const error = Cause.squash((exit as Exit.Failure<A, E>).cause);
      assert.instanceOf(error, HoustonTaskError);
      return error as HoustonTaskError;
    }),
  );

const create = (
  patch: Parameters<HoustonTaskService.HoustonTaskService["Service"]["save"]>[0]["patch"],
) => Effect.flatMap(service, (tasks) => tasks.save({ patch }));

/** The stand-in tracker names every issue `Issue <key>` and gives it a body of its own. */
const layerIssue = (
  overrides: {
    readonly title?: (ref: IssueRef) => string;
    readonly body?: (ref: IssueRef) => string;
  } = {},
) =>
  layerIssueService((ref) => ({
    ...issueDetailFor(ref),
    title: overrides.title?.(ref) ?? `Issue ${ref.key}`,
    body: overrides.body?.(ref) ?? `The tracker's own words for ${ref.key}.`,
  }));

const refOf = (projectId: ProjectId, key = "77"): IssueRef & { host: string } => ({
  projectId,
  tracker: "github" as never,
  host: "github.com",
  scope: "acme/houston",
  key,
});

const historyActions = (detail: HoustonTaskDetail) => detail.history.map((entry) => entry.action);

const linkCount = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const [row] = yield* sql<{ readonly n: number }>`SELECT COUNT(*) AS n FROM houston_task_issues`;
  return row?.n ?? 0;
});

describe("creating a task from an issue", () => {
  it.effect("names it after the issue and points at it instead of copying its words", () =>
    Effect.gen(function* () {
      const tasks = yield* service;
      const project = yield* createProject("from-issue");
      const task = yield* tasks.createFromIssue(refOf(project));

      assert.strictEqual(task.title, "Issue 77");
      assert.strictEqual(task.projectId, project);
      assert.strictEqual(task.status, "backlog");
      assert.strictEqual(task.refUrl, "https://github.com/acme/houston/issues/77");
      assert.include(task.description, "#77");
      assert.include(task.description, "https://github.com/acme/houston/issues/77");
      assert.notInclude(task.description, "The tracker's own words");
      assert.strictEqual(task.issue?.key, "77");
      assert.strictEqual(task.issue?.displayKey, "#77");
      assert.strictEqual(task.issue?.tracker, "github");
      assert.strictEqual(task.issue?.host, "github.com");
      assert.strictEqual(task.issue?.scope, "acme/houston");
      assert.strictEqual(task.issue?.title, "Issue 77");
      assert.strictEqual(task.issue?.projectId, project);
      assert.isString(task.issue?.linkedAt);

      const detail = yield* tasks.get({ id: task.key });
      assert.deepEqual(detail.task.issue, task.issue);
      assert.deepEqual(historyActions(detail), ["houston:issue-link", "created"]);
    }).pipe(Effect.provide(layerTasks({ issueService: layerIssue() }))),
  );

  it.effect("a second create for the same issue returns the task it already has", () =>
    Effect.gen(function* () {
      const tasks = yield* service;
      const project = yield* createProject("idempotent");
      const first = yield* tasks.createFromIssue(refOf(project));
      const second = yield* tasks.createFromIssue(refOf(project));
      assert.strictEqual(second.id, first.id);
      assert.strictEqual(second.revision, first.revision);
      const sql = yield* SqlClient.SqlClient;
      const [row] = yield* sql<{ readonly n: number }>`SELECT COUNT(*) AS n FROM houston_tasks`;
      assert.strictEqual(row?.n, 1);
      assert.strictEqual(yield* linkCount, 1);
    }).pipe(Effect.provide(layerTasks({ issueService: layerIssue() }))),
  );

  it.effect(
    "an archived task does not hold the issue; restoring it beside a new task is refused",
    () =>
      Effect.gen(function* () {
        const tasks = yield* service;
        const project = yield* createProject("archived");
        const first = yield* tasks.createFromIssue(refOf(project));
        yield* tasks.archive({ id: first.key, archived: true, expectedRevision: first.revision });
        assert.isNull(yield* tasks.taskForIssue(refOf(project)));

        const second = yield* tasks.createFromIssue(refOf(project));
        assert.notStrictEqual(second.id, first.id);
        assert.strictEqual(second.issue?.key, "77");

        const conflict = yield* refusal(
          tasks.archive({
            id: first.key,
            archived: false,
            expectedRevision: first.revision + 1,
          }),
        );
        assert.strictEqual(conflict.kind, "conflict");
        assert.include(conflict.message, second.key);
        assert.include(conflict.message, "#77");
        const restored = yield* tasks.get({ id: first.key });
        assert.isNotNull(restored.task.archivedAt);
      }).pipe(Effect.provide(layerTasks({ issueService: layerIssue() }))),
  );

  it.effect("an issue that cannot be read is refused by the tracker's own words", () =>
    Effect.gen(function* () {
      const tasks = yield* service;
      const project = yield* createProject("unreadable");
      const error = yield* refusal(tasks.createFromIssue(refOf(project, "404")));
      assert.strictEqual(error.kind, "invalid");
      assert.include(error.message, "#404");
      assert.include(error.message, "no issue 404");
      const sql = yield* SqlClient.SqlClient;
      const [row] = yield* sql<{ readonly n: number }>`SELECT COUNT(*) AS n FROM houston_tasks`;
      assert.strictEqual(row?.n, 0);
    }).pipe(
      Effect.provide(
        layerTasks({
          issueService: Layer.mock(IssueService.IssueService)({
            detail: (ref) =>
              Effect.fail(
                new IssueOperationError({
                  operation: "detail",
                  detail: `no issue ${ref.key}`,
                }),
              ),
          }),
        }),
      ),
    ),
  );
});

describe("linking a task to an issue", () => {
  it.effect("links by URL and replaces an earlier link with one history row", () =>
    Effect.gen(function* () {
      const tasks = yield* service;
      const project = yield* createProject("link");
      const task = yield* create({ title: "Local only", projectId: project });
      assert.isNull(task.issue);

      const linked = yield* tasks.linkIssue({
        id: task.key,
        expectedRevision: task.revision,
        url: "https://github.com/acme/houston/issues/77",
      });
      assert.strictEqual(linked.task.issue?.key, "77");
      assert.strictEqual(linked.task.revision, task.revision + 1);
      assert.strictEqual(linked.history[0]?.action, "houston:issue-link");

      // Linking the same issue again changes nothing and records nothing.
      const again = yield* tasks.linkIssue({
        id: task.key,
        expectedRevision: linked.task.revision,
        url: "https://github.com/acme/houston/issues/77",
      });
      assert.strictEqual(again.task.revision, linked.task.revision);
      assert.strictEqual(again.history.length, linked.history.length);

      // A different issue replaces it.
      const replaced = yield* tasks.linkIssue({
        id: task.key,
        expectedRevision: again.task.revision,
        url: "https://github.com/acme/houston/issues/78",
      });
      assert.strictEqual(replaced.task.issue?.key, "78");
      assert.strictEqual(yield* linkCount, 1);
    }).pipe(Effect.provide(layerTasks({ issueService: layerIssue() }))),
  );

  it.effect("a stale revision and a second live task are refused by name", () =>
    Effect.gen(function* () {
      const tasks = yield* service;
      const project = yield* createProject("link-refusals");
      const first = yield* create({ title: "First", projectId: project });
      const second = yield* create({ title: "Second", projectId: project });
      const linked = yield* tasks.linkIssue({
        id: first.key,
        expectedRevision: first.revision,
        url: "https://github.com/acme/houston/issues/77",
      });

      const stale = yield* refusal(
        tasks.linkIssue({
          id: second.key,
          expectedRevision: second.revision - 1,
          url: "https://github.com/acme/houston/issues/78",
        }),
      );
      assert.strictEqual(stale.kind, "conflict");

      const held = yield* refusal(
        tasks.linkIssue({
          id: second.key,
          expectedRevision: second.revision,
          url: "https://github.com/acme/houston/issues/77",
        }),
      );
      assert.strictEqual(held.kind, "conflict");
      assert.include(held.message, first.key);
      assert.include(held.message, "#77");
      assert.strictEqual((yield* tasks.get({ id: second.key })).task.issue, null);
      assert.strictEqual(linked.task.issue?.key, "77");
    }).pipe(Effect.provide(layerTasks({ issueService: layerIssue() }))),
  );

  it.effect("unlinking removes the link, keeps the task and records it once", () =>
    Effect.gen(function* () {
      const tasks = yield* service;
      const project = yield* createProject("unlink");
      const task = yield* tasks.createFromIssue(refOf(project));
      const unlinked = yield* tasks.unlinkIssue({
        id: task.key,
        expectedRevision: task.revision,
      });
      assert.isNull(unlinked.task.issue);
      assert.strictEqual(unlinked.task.revision, task.revision + 1);
      assert.strictEqual(unlinked.history[0]?.action, "houston:issue-unlink");
      assert.strictEqual(yield* linkCount, 0);
      assert.strictEqual((yield* tasks.get({ id: task.key })).task.title, "Issue 77");

      const again = yield* tasks.unlinkIssue({
        id: task.key,
        expectedRevision: unlinked.task.revision,
      });
      assert.isNull(again.task.issue);
      assert.strictEqual(again.task.revision, unlinked.task.revision);
    }).pipe(Effect.provide(layerTasks({ issueService: layerIssue() }))),
  );
});

describe("the task of an issue", () => {
  it.effect("answers with the live task, and with nothing for an unknown or archived one", () =>
    Effect.gen(function* () {
      const tasks = yield* service;
      const project = yield* createProject("lookup");
      const task = yield* tasks.createFromIssue(refOf(project));

      const found = yield* tasks.taskForIssue(refOf(project));
      assert.strictEqual(found?.key, task.key);
      assert.strictEqual(found?.issue?.key, "77");
      assert.isNull(yield* tasks.taskForIssue(refOf(project, "79")));

      yield* tasks.archive({ id: task.key, archived: true, expectedRevision: task.revision });
      assert.isNull(yield* tasks.taskForIssue(refOf(project)));
    }).pipe(Effect.provide(layerTasks({ issueService: layerIssue() }))),
  );
});

describe("a task's status moves the linked issue when the project chose it", () => {
  const settings = (updateIssueState: boolean) => ({
    access: "write" as const,
    startModel: { instanceId: "claudeAgent" as never, model: "claude-opus-5-5" },
    delivery: "send" as const,
    reviewer: null,
    focus: "bugs" as const,
    reworkRounds: 0,
    updateIssueState,
  });
  type Move = { readonly key: string; readonly state: string };
  const tracker = (moves: Array<Move>, refusal = false) =>
    Layer.mock(IssueService.IssueService)({
      detail: (ref) => Effect.succeed(issueDetailFor(ref)),
      setState: (input) => {
        moves.push({ key: input.key, state: input.state });
        return refusal
          ? Effect.fail(
              new IssueOperationError({
                operation: "setState",
                detail: "the tracker is read-only today",
              }),
            )
          : Effect.void;
      },
    });

  it.effect("In progress, In review and Done choose the tracker's own states", () => {
    const moves: Array<Move> = [];
    return Effect.gen(function* () {
      const tasks = yield* service;
      const project = yield* createProject("issue-state");
      yield* tasks.setSettings({ projectId: project, settings: settings(true) });
      const task = yield* tasks.createFromIssue(refOf(project));

      const progress = yield* tasks.save({
        id: task.key,
        expectedRevision: task.revision,
        patch: { status: "in_progress" },
      });
      assert.deepEqual(moves, [{ key: "77", state: "In Progress" }]);

      const review = yield* tasks.save({
        id: task.key,
        expectedRevision: progress.revision,
        patch: { status: "in_review" },
      });
      assert.deepEqual(moves.at(-1), { key: "77", state: "In Review" });

      yield* tasks.save({
        id: task.key,
        expectedRevision: review.revision,
        patch: { status: "done" },
      });
      // Done takes the first closed state; the task's own status is never held back.
      assert.deepEqual(moves.at(-1), { key: "77", state: "Completed" });
      assert.strictEqual((yield* tasks.get({ id: task.key })).task.status, "done");
    }).pipe(Effect.provide(layerTasks({ issueService: tracker(moves) })));
  });

  it.effect("with the setting off, a status change leaves the issue alone", () => {
    const moves: Array<Move> = [];
    return Effect.gen(function* () {
      const tasks = yield* service;
      const project = yield* createProject("issue-state-off");
      const task = yield* tasks.createFromIssue(refOf(project));

      yield* tasks.save({
        id: task.key,
        expectedRevision: task.revision,
        patch: { status: "done" },
      });
      assert.deepEqual(moves, []);
    }).pipe(Effect.provide(layerTasks({ issueService: tracker(moves) })));
  });

  it.effect("a refusal is noted once in the activity and the task still moves", () => {
    const moves: Array<Move> = [];
    return Effect.gen(function* () {
      const tasks = yield* service;
      const project = yield* createProject("issue-state-failed");
      yield* tasks.setSettings({ projectId: project, settings: settings(true) });
      const task = yield* tasks.createFromIssue(refOf(project));

      const done = yield* tasks.save({
        id: task.key,
        expectedRevision: task.revision,
        patch: { status: "done" },
      });
      assert.strictEqual(done.status, "done");
      const detail = yield* tasks.get({ id: task.key });
      const notes = detail.comments.filter((comment) => comment.body.includes("was not changed"));
      assert.lengthOf(notes, 1);
      assert.include(notes[0]?.body ?? "", "#77");
      assert.include(notes[0]?.body ?? "", "read-only today");
      assert.deepEqual(historyActions(detail).slice(0, 1), ["houston:issue-state-failed"]);

      // The same refusal at the next revision is not repeated.
      yield* tasks.save({
        id: task.key,
        expectedRevision: done.revision,
        patch: { status: "done" },
      });
      assert.strictEqual(
        (yield* tasks.get({ id: task.key })).comments.filter((comment) =>
          comment.body.includes("was not changed"),
        ).length,
        1,
      );
    }).pipe(Effect.provide(layerTasks({ issueService: tracker(moves, true) })));
  });
});
