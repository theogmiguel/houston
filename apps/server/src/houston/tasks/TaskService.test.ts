// The Tasks service over one database: writes, revisions, history, queues and initiatives.
import { assert, describe, it } from "@effect/vitest";
import {
  HoustonTaskError,
  type HoustonTask,
  type HoustonTaskStreamEvent,
} from "@t3tools/contracts/houston/tasks";
import { ProjectId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";

import * as HoustonTaskProjectSweep from "./ProjectSweep.ts";
import * as HoustonTaskService from "./TaskService.ts";
import * as HoustonTaskStore from "./TaskStore.ts";
import { createProject, deleteProject, layerTasks } from "./tasks.testkit.ts";

const service = HoustonTaskService.HoustonTaskService;

const failureOf = <A, E>(exit: Exit.Exit<A, E>) => {
  assert.isTrue(Exit.isFailure(exit), "expected a refusal");
  const error = Cause.squash((exit as Exit.Failure<A, E>).cause);
  assert.instanceOf(error, HoustonTaskError);
  return error as HoustonTaskError;
};

const refused = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.exit(effect).pipe(Effect.map(failureOf));

const create = (
  patch: Parameters<HoustonTaskService.HoustonTaskService["Service"]["save"]>[0]["patch"],
) => Effect.flatMap(service, (tasks) => tasks.save({ patch }));

const rowCounts = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const count = (table: string) =>
    sql<{ readonly n: number }>`SELECT COUNT(*) AS n FROM ${sql(table)}`.pipe(
      Effect.map((rows) => rows[0]?.n ?? 0),
    );
  return {
    tasks: yield* count("houston_tasks"),
    acceptance: yield* count("houston_task_acceptance"),
    comments: yield* count("houston_task_comments"),
    history: yield* count("houston_task_history"),
  };
});

const changesOf = (raw: string) =>
  JSON.parse(raw) as Record<string, { old: unknown; new: unknown }>;

describe("an update records each changed field", () => {
  it.effect("the current revision applies the patch, adds 1 and records old and new", () =>
    Effect.gen(function* () {
      const tasks = yield* service;
      const task = yield* create({ title: "Draft", description: "first" });
      const updated = yield* tasks.save({
        id: task.key,
        expectedRevision: 1,
        patch: { title: "Final", priority: "high", description: "first" },
      });
      assert.strictEqual(updated.revision, 2);
      assert.strictEqual(updated.title, "Final");
      assert.strictEqual(updated.priority, "high");
      const detail = yield* tasks.get({ id: task.key });
      assert.strictEqual(detail.history.length, 2);
      const [latest, created] = detail.history;
      assert.strictEqual(created?.action, "created");
      assert.strictEqual(latest?.action, "update");
      assert.strictEqual(latest?.actor, "user");
      assert.deepEqual(changesOf(latest?.changes ?? "{}"), {
        title: { old: "Draft", new: "Final" },
        priority: { old: "none", new: "high" },
      });
    }).pipe(Effect.provide(layerTasks())),
  );
});

describe("an update with a stale revision is refused and changes nothing", () => {
  it.effect("conflict carries expected and actual; the row and history stay", () =>
    Effect.gen(function* () {
      const tasks = yield* service;
      const task = yield* create({ title: "Original" });
      yield* tasks.save({ id: task.key, expectedRevision: 1, patch: { title: "Second" } });
      const error = yield* refused(
        tasks.save({ id: task.key, expectedRevision: 1, patch: { title: "Stale" } }),
      );
      assert.strictEqual(error.kind, "conflict");
      assert.strictEqual(error.expected, 1);
      assert.strictEqual(error.actual, 2);
      assert.strictEqual(error.operation, "houston.tasks.save");
      const detail = yield* tasks.get({ id: task.key });
      assert.strictEqual(detail.task.title, "Second");
      assert.strictEqual(detail.task.revision, 2);
      assert.strictEqual(detail.history.length, 2);
    }).pipe(Effect.provide(layerTasks())),
  );
});

describe("a refused write stores nothing", () => {
  it.effect("each refused create, edit and comment leaves every table as it was", () =>
    Effect.gen(function* () {
      const tasks = yield* service;
      const task = yield* create({ title: "Keep", acceptance: ["one"] });
      const before = yield* rowCounts;
      const refusals = [
        tasks.save({ patch: { title: "t".repeat(201) } }),
        tasks.save({ patch: { title: "" } }),
        tasks.save({ patch: { title: "ok", description: "d".repeat(65_537) } }),
        tasks.save({
          patch: { title: "ok", acceptance: Array.from({ length: 51 }, (_, i) => `a${i}`) },
        }),
        tasks.save({ id: task.key, expectedRevision: 1, patch: { title: "t".repeat(201) } }),
        tasks.save({
          id: task.key,
          expectedRevision: 1,
          patch: { acceptance: Array.from({ length: 51 }, (_, i) => `a${i}`) },
        }),
        tasks.comment({ id: task.key, body: "c".repeat(16_385) }),
      ];
      for (const attempt of refusals) {
        const error = yield* refused(attempt);
        assert.include(["limit", "invalid"], error.kind);
      }
      assert.deepEqual(yield* rowCounts, before);
      assert.strictEqual((yield* tasks.get({ id: task.key })).task.revision, 1);
    }).pipe(Effect.provide(layerTasks())),
  );

  it.effect("the 5,001st task and the 501st comment are refused naming the limit", () =>
    Effect.gen(function* () {
      const tasks = yield* service;
      const sql = yield* SqlClient.SqlClient;
      const task = yield* create({ title: "Commented" });
      // Fill to the caps directly; the cap check is what is under test.
      yield* sql`
        WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 499)
        INSERT INTO houston_task_comments (task_id, body, author, created_at)
        SELECT ${task.id}, 'filler', 'user', '2026-01-01T00:00:00.000Z' FROM n
      `;
      yield* tasks.comment({ id: task.key, body: "the 500th" });
      const comment = yield* refused(tasks.comment({ id: task.key, body: "the 501st" }));
      assert.strictEqual(comment.kind, "limit");
      assert.strictEqual(comment.limit, 500);
      assert.strictEqual(comment.actual, 501);

      yield* sql`
        WITH RECURSIVE n(i) AS (SELECT 2 UNION ALL SELECT i + 1 FROM n WHERE i < 5000)
        INSERT INTO houston_tasks (number, title, status, created_by, created_at, updated_at)
        SELECT 1000 + i, 'filler', 'backlog', 'user', '2026-01-01T00:00:00.000Z',
          '2026-01-01T00:00:00.000Z' FROM n
      `;
      yield* sql`UPDATE houston_task_counter SET next_number = 7000 WHERE id = 1`;
      const before = yield* rowCounts;
      assert.strictEqual(before.tasks, 5_000);
      const cap = yield* refused(tasks.save({ patch: { title: "one too many" } }));
      assert.strictEqual(cap.kind, "limit");
      assert.strictEqual(cap.limit, 5_000);
      assert.strictEqual(cap.actual, 5_001);
      assert.deepEqual(yield* rowCounts, before);
    }).pipe(Effect.provide(layerTasks())),
  );
});

describe("absent, null and a value are distinct in a patch", () => {
  it.effect("projectId, parentId and refUrl: absent keeps, null clears, a value sets", () =>
    Effect.gen(function* () {
      const tasks = yield* service;
      const projectA = yield* createProject("patch-a");
      const projectB = yield* createProject("patch-b");
      const parentA = yield* create({ title: "Parent A" });
      const parentB = yield* create({ title: "Parent B" });
      const fields = {
        projectId: [projectA, projectB],
        parentId: [parentA.id, parentB.id],
        refUrl: ["https://example.test/a", "https://example.test/b"],
      } as const;
      for (const [field, [first, second]] of Object.entries(fields) as Array<
        [keyof typeof fields, readonly [unknown, unknown]]
      >) {
        const task = yield* create({ title: `Field ${field}`, [field]: first } as never);
        assert.strictEqual(task[field as keyof HoustonTask], first, `${field} set on create`);
        const kept = yield* tasks.save({
          id: task.key,
          expectedRevision: task.revision,
          patch: { title: `Field ${field} renamed` },
        });
        assert.strictEqual(kept[field as keyof HoustonTask], first, `${field} absent keeps`);
        const set = yield* tasks.save({
          id: task.key,
          expectedRevision: kept.revision,
          patch: { [field]: second } as never,
        });
        assert.strictEqual(set[field as keyof HoustonTask], second, `${field} value sets`);
        const cleared = yield* tasks.save({
          id: task.key,
          expectedRevision: set.revision,
          patch: { [field]: null } as never,
        });
        assert.isNull(cleared[field as keyof HoustonTask], `${field} null clears`);
      }
    }).pipe(Effect.provide(layerTasks())),
  );

  it.effect("acceptance replaces the whole list; absent keeps it", () =>
    Effect.gen(function* () {
      const tasks = yield* service;
      const task = yield* create({ title: "Listed", acceptance: ["a", "b", "c"] });
      const renamed = yield* tasks.save({
        id: task.key,
        expectedRevision: 1,
        patch: { title: "Listed again" },
      });
      assert.deepEqual(
        (yield* tasks.get({ id: task.key })).acceptance.map((item) => item.text),
        ["a", "b", "c"],
      );
      yield* tasks.save({
        id: task.key,
        expectedRevision: renamed.revision,
        patch: { acceptance: ["z"] },
      });
      const detail = yield* tasks.get({ id: task.key });
      assert.deepEqual(
        detail.acceptance.map((item) => item.text),
        ["z"],
      );
      assert.deepEqual(changesOf(detail.history[0]?.changes ?? "{}").acceptance, {
        old: 3,
        new: 1,
      });
    }).pipe(Effect.provide(layerTasks())),
  );

  it.effect("a project that does not exist is invalid", () =>
    Effect.gen(function* () {
      const error = yield* refused(
        create({ title: "Nowhere", projectId: ProjectId.make("project-missing") }),
      );
      assert.strictEqual(error.kind, "invalid");
      assert.include(error.message, "project-missing");
    }).pipe(Effect.provide(layerTasks())),
  );
});

describe("an update to a project that does not exist changes nothing", () => {
  it.effect("a changed projectId naming no project is invalid; the row and history stay", () =>
    Effect.gen(function* () {
      const tasks = yield* service;
      const project = yield* createProject("update-target");
      for (const start of [null, project]) {
        const task = yield* create({ title: `from ${start ?? "none"}`, projectId: start });
        const before = yield* tasks.get({ id: task.key });
        const error = yield* refused(
          tasks.save({
            id: task.key,
            expectedRevision: task.revision,
            patch: { projectId: ProjectId.make("project-missing") },
          }),
        );
        assert.strictEqual(error.kind, "invalid");
        assert.include(error.message, "project-missing");
        assert.deepEqual(yield* tasks.get({ id: task.key }), before);
      }
    }).pipe(Effect.provide(layerTasks())),
  );
});

/** A delivery with two slices; `before` runs after the delivery exists and before its domain row. */
const deliveryWithSlices = (
  project: ProjectId,
  status: HoustonTask["status"],
  before: (
    delivery: HoustonTask,
  ) => Effect.Effect<unknown, HoustonTaskError, HoustonTaskService.HoustonTaskService>,
) =>
  Effect.gen(function* () {
    const tasks = yield* service;
    const created = yield* create({ title: "Delivery", projectId: project, status });
    yield* before(created);
    const delivery = (yield* tasks.get({ id: created.key })).task;
    yield* tasks.saveDomain({
      id: delivery.key,
      expectedRevision: delivery.revision,
      kind: "delivery",
    });
    const slices: Array<HoustonTask> = [];
    for (const title of ["Slice 1", "Slice 2"]) {
      const slice = yield* create({ title, projectId: project, parentId: delivery.id });
      yield* tasks.saveDomain({ id: slice.key, expectedRevision: slice.revision, kind: "slice" });
      slices.push(slice);
    }
    return { key: delivery.key, slices };
  });

const finishSlices = (slices: ReadonlyArray<HoustonTask>) =>
  Effect.gen(function* () {
    const tasks = yield* service;
    for (const slice of slices) {
      const current = (yield* tasks.get({ id: slice.key })).task;
      yield* tasks.save({
        id: slice.key,
        expectedRevision: current.revision,
        patch: { status: "done" },
      });
    }
  });

const setStatus = (key: string, status: HoustonTask["status"], actor?: string) =>
  Effect.gen(function* () {
    const tasks = yield* service;
    const current = (yield* tasks.get({ id: key })).task;
    return yield* tasks.save(
      { id: key, expectedRevision: current.revision, patch: { status } },
      actor,
    );
  });

describe("a user's status on a delivery stops its rollup", () => {
  it.effect(
    "set by the user after the delivery exists, the status stays when every slice is done",
    () =>
      Effect.gen(function* () {
        const tasks = yield* service;
        const project = yield* createProject("override-user");
        const { key, slices } = yield* deliveryWithSlices(project, "backlog", () => Effect.void);
        yield* setStatus(key, "in_progress");
        yield* finishSlices(slices);
        assert.strictEqual((yield* tasks.get({ id: key })).task.status, "in_progress");
      }).pipe(Effect.provide(layerTasks())),
  );

  it.effect("set by an agent, the delivery still rolls up to done", () =>
    Effect.gen(function* () {
      const tasks = yield* service;
      const project = yield* createProject("override-agent");
      const { key, slices } = yield* deliveryWithSlices(project, "backlog", () => Effect.void);
      yield* setStatus(key, "in_progress", "agent:thread-1");
      yield* finishSlices(slices);
      assert.strictEqual((yield* tasks.get({ id: key })).task.status, "done");
    }).pipe(Effect.provide(layerTasks())),
  );

  it.effect("set by the user before the task became a delivery, the status stays", () =>
    Effect.gen(function* () {
      const tasks = yield* service;
      const project = yield* createProject("override-before");
      // The user moved it and back: still backlog, but the user chose its status.
      const { key, slices } = yield* deliveryWithSlices(project, "backlog", (delivery) =>
        Effect.andThen(setStatus(delivery.key, "todo"), setStatus(delivery.key, "backlog")),
      );
      yield* finishSlices(slices);
      assert.strictEqual((yield* tasks.get({ id: key })).task.status, "backlog");
    }).pipe(Effect.provide(layerTasks())),
  );

  it.effect("a delivery never set by the user rolls up to done", () =>
    Effect.gen(function* () {
      const tasks = yield* service;
      const project = yield* createProject("override-none");
      const { key, slices } = yield* deliveryWithSlices(project, "backlog", () => Effect.void);
      yield* finishSlices(slices);
      assert.strictEqual((yield* tasks.get({ id: key })).task.status, "done");
    }).pipe(Effect.provide(layerTasks())),
  );
});

describe("an unknown parent is refused naming it", () => {
  it.effect("not_found names the parent id; a cycle through the parent is refused", () =>
    Effect.gen(function* () {
      const tasks = yield* service;
      const missing = yield* refused(create({ title: "Orphan", parentId: 999 }));
      assert.strictEqual(missing.kind, "not_found");
      assert.include(missing.message, "999");
      const parent = yield* create({ title: "Parent" });
      const child = yield* create({ title: "Child", parentId: parent.id });
      const cycle = yield* refused(
        tasks.save({
          id: parent.key,
          expectedRevision: parent.revision,
          patch: { parentId: child.id },
        }),
      );
      assert.strictEqual(cycle.kind, "cycle");
      const self = yield* refused(
        tasks.save({
          id: parent.key,
          expectedRevision: parent.revision,
          patch: { parentId: parent.id },
        }),
      );
      assert.strictEqual(self.kind, "cycle");
    }).pipe(Effect.provide(layerTasks())),
  );
});

describe("checking an acceptance item records who and when", () => {
  it.effect("check sets checkedAt and checkedBy, uncheck clears both; each adds a revision", () =>
    Effect.gen(function* () {
      const tasks = yield* service;
      const task = yield* create({ title: "Checked", acceptance: ["loads", "saves"] });
      const item = (yield* tasks.get({ id: task.key })).acceptance[1];
      assert.isDefined(item);
      const checked = yield* tasks.check({ id: task.key, item: item!.id, checked: true });
      assert.strictEqual(checked.revision, 2);
      const afterCheck = yield* tasks.get({ id: task.key });
      const ticked = afterCheck.acceptance[1];
      assert.isNotNull(ticked?.checkedAt);
      assert.strictEqual(ticked?.checkedBy, "user");
      assert.isNull(afterCheck.acceptance[0]?.checkedAt);
      assert.strictEqual(afterCheck.history[0]?.action, "check");
      const unchecked = yield* tasks.check({ id: task.key, item: item!.id, checked: false });
      assert.strictEqual(unchecked.revision, 3);
      const afterUncheck = yield* tasks.get({ id: task.key });
      assert.isNull(afterUncheck.acceptance[1]?.checkedAt);
      assert.isNull(afterUncheck.acceptance[1]?.checkedBy);
      assert.strictEqual(afterUncheck.history[0]?.action, "uncheck");
      assert.strictEqual(afterUncheck.history.length, 3);
      const missing = yield* refused(tasks.check({ id: task.key, item: 9_999, checked: true }));
      assert.strictEqual(missing.kind, "not_found");
    }).pipe(Effect.provide(layerTasks())),
  );
});

describe("comments keep their author and order", () => {
  it.effect("user from the RPC, agent:<threadId> from an agent write, oldest first", () =>
    Effect.gen(function* () {
      const tasks = yield* service;
      const task = yield* create({ title: "Discussed" });
      yield* tasks.comment({ id: task.key, body: "first" });
      yield* tasks.comment({ id: task.key, body: "second" }, "agent:thread-7");
      yield* tasks.comment({ id: task.key, body: "third" });
      const detail = yield* tasks.get({ id: task.key });
      assert.deepEqual(
        detail.comments.map((comment) => [comment.body, comment.author]),
        [
          ["first", "user"],
          ["second", "agent:thread-7"],
          ["third", "user"],
        ],
      );
      assert.isTrue(detail.comments.every((comment) => comment.createdAt.length > 0));
      assert.strictEqual(detail.task.revision, 4);
    }).pipe(Effect.provide(layerTasks())),
  );
});

describe("archiving keeps the status and leaves the queues", () => {
  it.effect("archive and restore move the task out of and back into its queue", () =>
    Effect.gen(function* () {
      const tasks = yield* service;
      const task = yield* create({ title: "Review me", status: "in_review" });
      const snapshotOf = Effect.scoped(
        Effect.gen(function* () {
          const events = yield* Stream.take(tasks.subscribe({ scope: "all" }), 1).pipe(
            Stream.runCollect,
          );
          const first = events[0] as Extract<HoustonTaskStreamEvent, { snapshot: unknown }>;
          return first.snapshot;
        }),
      );
      const before = yield* snapshotOf;
      assert.strictEqual(before.tasks[0]?.queue, "your_turn");
      assert.strictEqual(before.counts.inReview, 1);
      assert.strictEqual(before.counts.yourTurn, 1);

      const stale = yield* refused(
        tasks.archive({ id: task.key, archived: true, expectedRevision: 9 }),
      );
      assert.strictEqual(stale.kind, "conflict");

      const archived = yield* tasks.archive({ id: task.key, archived: true, expectedRevision: 1 });
      assert.strictEqual(archived.status, "in_review");
      assert.isNotNull(archived.archivedAt);
      const during = yield* snapshotOf;
      assert.strictEqual(during.tasks[0]?.queue, "none");
      assert.isNotNull(during.tasks[0]?.archivedAt);
      assert.strictEqual(during.counts.inReview, 0);
      assert.strictEqual(during.counts.yourTurn, 0);
      assert.strictEqual((yield* tasks.get({ id: task.key })).task.status, "in_review");

      const restored = yield* tasks.archive({
        id: task.key,
        archived: false,
        expectedRevision: archived.revision,
      });
      assert.isNull(restored.archivedAt);
      const after = yield* snapshotOf;
      assert.strictEqual(after.tasks[0]?.queue, "your_turn");
      assert.strictEqual(after.counts.yourTurn, 1);
    }).pipe(Effect.provide(layerTasks())),
  );
});

describe("a write during the snapshot is never lost", () => {
  it.effect("a write committed after the snapshot rows were read arrives as an event", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const tasks = yield* service;
        yield* create({ title: "Before" });
        const snapshotRead = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const events = yield* Queue.unbounded<HoustonTaskStreamEvent>();
        const subscriber = yield* tasks.subscribe({ scope: "all" }).pipe(
          Stream.runForEach((event) => Queue.offer(events, event)),
          Effect.provideService(
            HoustonTaskStore.SnapshotReadHook,
            Deferred.succeed(snapshotRead, undefined).pipe(Effect.andThen(Deferred.await(release))),
          ),
          Effect.forkScoped,
        );
        // The snapshot read is held open while another write commits.
        yield* Deferred.await(snapshotRead);
        const during = yield* create({ title: "During" });
        yield* Deferred.succeed(release, undefined);

        const first = yield* Queue.take(events);
        assert.isTrue("snapshot" in first);
        const snapshotKeys =
          "snapshot" in first ? first.snapshot.tasks.map((task) => task.key) : [];
        if (!snapshotKeys.includes(during.key)) {
          const next = yield* Queue.take(events);
          assert.isTrue("changed" in next && next.changed.key === during.key);
        }
        yield* Fiber.interrupt(subscriber);
      }),
    ).pipe(Effect.provide(layerTasks())),
  );

  it.effect("subscribe sends one changed event per committed write, in commit order", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const tasks = yield* service;
        const events = yield* Queue.unbounded<HoustonTaskStreamEvent>();
        yield* tasks.subscribe({ scope: "all" }).pipe(
          Stream.runForEach((event) => Queue.offer(events, event)),
          Effect.forkScoped,
        );
        const first = yield* Queue.take(events);
        assert.isTrue("snapshot" in first);
        yield* Effect.all(
          [create({ title: "one" }), create({ title: "two" }), create({ title: "three" })],
          { concurrency: "unbounded" },
        );
        const keys: Array<string> = [];
        for (let index = 0; index < 3; index += 1) {
          const event = yield* Queue.take(events);
          if ("changed" in event) keys.push(event.changed.key);
        }
        assert.deepEqual(keys, ["HOU-1", "HOU-2", "HOU-3"]);
      }),
    ).pipe(Effect.provide(layerTasks())),
  );
});

describe("counts carry your turn per status and ready", () => {
  it.effect("yourTurn equals the your_turn summaries; archived tasks are not counted", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const tasks = yield* service;
        const project = yield* createProject("counts");
        yield* create({ title: "review 1", status: "in_review" });
        yield* create({ title: "review 2", status: "in_review" });
        const archived = yield* create({ title: "review archived", status: "in_review" });
        yield* tasks.archive({ id: archived.key, archived: true, expectedRevision: 1 });
        yield* create({ title: "ready", status: "todo", projectId: project, acceptance: ["done"] });
        yield* create({ title: "unready todo", status: "todo" });
        yield* create({ title: "idea" });
        yield* create({ title: "working", status: "in_progress" });
        yield* create({ title: "shipped", status: "done" });
        yield* create({ title: "dropped", status: "canceled" });
        const events = yield* Stream.take(tasks.subscribe({ scope: "all" }), 1).pipe(
          Stream.runCollect,
        );
        const first = events[0];
        assert.isTrue(first !== undefined && "snapshot" in first);
        const snapshot = (first as Extract<HoustonTaskStreamEvent, { snapshot: unknown }>).snapshot;
        const yourTurn = snapshot.tasks.filter((task) => task.queue === "your_turn").length;
        assert.strictEqual(yourTurn, 2);
        assert.deepEqual(snapshot.counts, {
          yourTurn: 2,
          ready: 1,
          backlog: 1,
          todo: 2,
          inProgress: 1,
          inReview: 2,
          done: 1,
          canceled: 1,
        });
        assert.strictEqual(snapshot.truncated, false);
        assert.strictEqual(snapshot.tasks.find((task) => task.title === "ready")?.queue, "up_next");
        assert.strictEqual(
          snapshot.tasks.find((task) => task.title === "working")?.queue,
          "stopped",
        );
        assert.isFalse(snapshot.tasks.some((task) => "description" in task));
      }),
    ).pipe(Effect.provide(layerTasks())),
  );
});

describe("initiatives save, archive and refuse a stale revision", () => {
  it.effect("an initiative keeps its fields and revision, archives and restores", () =>
    Effect.gen(function* () {
      const tasks = yield* service;
      const project = yield* createProject("initiatives");
      const saved = yield* tasks.saveInitiative({
        projectId: project,
        name: "Checkout",
        externalUrl: "https://tracker.test/checkout",
        trackerDescription: "From the tracker",
        localDecisions: ["Ship behind a flag"],
      });
      assert.deepInclude(saved, {
        projectId: project,
        name: "Checkout",
        externalUrl: "https://tracker.test/checkout",
        trackerDescription: "From the tracker",
        revision: 1,
        archivedAt: null,
      });
      assert.deepEqual(saved.localDecisions, ["Ship behind a flag"]);
      const edited = yield* tasks.saveInitiative({
        projectId: project,
        id: saved.id,
        expectedRevision: 1,
        name: "Checkout v2",
      });
      assert.strictEqual(edited.revision, 2);
      assert.strictEqual(edited.name, "Checkout v2");
      assert.strictEqual(edited.externalUrl, "https://tracker.test/checkout");
      const stale = yield* refused(
        tasks.saveInitiative({
          projectId: project,
          id: saved.id,
          expectedRevision: 1,
          name: "Old",
        }),
      );
      assert.strictEqual(stale.kind, "conflict");
      assert.strictEqual(stale.expected, 1);
      assert.strictEqual(stale.actual, 2);
      const archived = yield* tasks.archiveInitiative({
        id: saved.id,
        archived: true,
        expectedRevision: 2,
      });
      assert.isNotNull(archived.archivedAt);
      const staleArchive = yield* refused(
        tasks.archiveInitiative({ id: saved.id, archived: false, expectedRevision: 2 }),
      );
      assert.strictEqual(staleArchive.kind, "conflict");
      const restored = yield* tasks.archiveInitiative({
        id: saved.id,
        archived: false,
        expectedRevision: archived.revision,
      });
      assert.isNull(restored.archivedAt);
      const listed = yield* tasks.listInitiatives({ projectId: project });
      assert.deepEqual(
        listed.map((initiative) => initiative.name),
        ["Checkout v2"],
      );
      const empty = yield* refused(tasks.saveInitiative({ projectId: project, name: " " }));
      assert.strictEqual(empty.kind, "invalid");
    }).pipe(Effect.provide(layerTasks())),
  );
});

describe("domain fields round trip and a cycle changes nothing", () => {
  it.effect("kind, initiative and blockedBy come back; a cycle is refused unchanged", () =>
    Effect.gen(function* () {
      const tasks = yield* service;
      const project = yield* createProject("domain");
      const initiative = yield* tasks.saveInitiative({ projectId: project, name: "Billing" });
      const a = yield* create({ title: "A", projectId: project });
      const b = yield* create({ title: "B", projectId: project });
      const domain = yield* tasks.saveDomain({
        id: a.key,
        expectedRevision: a.revision,
        kind: "delivery",
        initiativeId: initiative.id,
        blockedBy: [b.id],
      });
      assert.strictEqual(domain.kind, "delivery");
      assert.strictEqual(domain.initiativeId, initiative.id);
      assert.deepEqual(domain.blockedBy, [b.id]);
      const read = (yield* tasks.get({ id: a.key })).domain;
      assert.strictEqual(read.kind, "delivery");
      assert.strictEqual(read.initiativeId, initiative.id);
      assert.deepEqual(read.blockedBy, [b.id]);
      assert.deepEqual(read.readiness.unfinishedBlockers, [b.id]);

      const bBefore = yield* tasks.get({ id: b.key });
      const cycle = yield* refused(
        tasks.saveDomain({ id: b.key, expectedRevision: b.revision, blockedBy: [a.id] }),
      );
      assert.strictEqual(cycle.kind, "cycle");
      const bAfter = yield* tasks.get({ id: b.key });
      assert.strictEqual(bAfter.task.revision, bBefore.task.revision);
      assert.deepEqual(bAfter.domain.blockedBy, []);
      assert.strictEqual(bAfter.history.length, bBefore.history.length);

      const aNow = (yield* tasks.get({ id: a.key })).task;
      const self = yield* refused(
        tasks.saveDomain({ id: a.key, expectedRevision: aNow.revision, blockedBy: [a.id] }),
      );
      assert.strictEqual(self.kind, "cycle");
      assert.deepEqual((yield* tasks.get({ id: a.key })).domain.blockedBy, [b.id]);

      const stale = yield* refused(
        tasks.saveDomain({ id: a.key, expectedRevision: 1, kind: "slice" }),
      );
      assert.strictEqual(stale.kind, "conflict");
    }).pipe(Effect.provide(layerTasks())),
  );
});

describe("settings default and refuse out-of-range values", () => {
  it.effect("an unset project gets the defaults; set values come back; bounds are named", () =>
    Effect.gen(function* () {
      const tasks = yield* service;
      const project = yield* createProject("settings");
      assert.deepEqual(yield* tasks.getSettings({ projectId: project }), {
        access: "write",
        startModel: { instanceId: "claudeAgent", model: "claude-opus-5-5" },
        delivery: "send",
        reviewer: null,
        reviewMode: "manual",
        focus: "bugs",
        reworkRounds: 0,
      } as never);

      const withReviewer = yield* tasks.setSettings({
        projectId: project,
        settings: {
          access: "read",
          startModel: { instanceId: "codex", model: "gpt-6-astra" },
          delivery: "prefill",
          reviewer: { instanceId: "claudeAgent", model: "claude-opus-5-5" },
          focus: "security",
          reworkRounds: 5,
        } as never,
      });
      // A reviewer without an explicit mode reviews on handback.
      assert.strictEqual(withReviewer.reviewMode, "handback");
      assert.strictEqual(withReviewer.reworkRounds, 5);
      assert.deepEqual(yield* tasks.getSettings({ projectId: project }), withReviewer);

      const rounds = yield* refused(
        tasks.setSettings({
          projectId: project,
          settings: { ...withReviewer, reworkRounds: 6 },
        }),
      );
      assert.strictEqual(rounds.kind, "limit");
      assert.strictEqual(rounds.limit, 5);
      assert.strictEqual(rounds.actual, 6);

      const deadInstance = yield* refused(
        tasks.setSettings({
          projectId: project,
          settings: { ...withReviewer, startModel: { instanceId: "zed", model: "m" } } as never,
        }),
      );
      assert.strictEqual(deadInstance.kind, "invalid");
      assert.include(deadInstance.message, "zed");
      assert.deepEqual(yield* tasks.getSettings({ projectId: project }), withReviewer);

      const manual = yield* tasks.setSettings({
        projectId: project,
        settings: { ...withReviewer, reviewMode: "manual" },
      });
      assert.strictEqual(manual.reviewMode, "manual");
    }).pipe(Effect.provide(layerTasks())),
  );
});

describe("startup unassigns tasks of a project that no longer exists", () => {
  it.effect("a task left on a deleted project is unassigned; live and unassigned tasks stay", () =>
    Effect.gen(function* () {
      const tasks = yield* service;
      const sql = yield* SqlClient.SqlClient;
      const gone = yield* createProject("sweep-gone");
      const live = yield* createProject("sweep-live");
      const orphan = yield* create({ title: "orphan", projectId: gone });
      const kept = yield* create({ title: "kept", projectId: live });
      const loose = yield* create({ title: "loose" });
      yield* sql`
        INSERT INTO houston_task_runs (
          task_id, attempt, kind, state, provider, initial_revision, started_at
        ) VALUES (${orphan.id}, 1, 'implementation', 'running', 'claude', 1, '2026-01-01T00:00:00.000Z')
      `;
      // The deletion committed but its hook never ran: the server stopped in between.
      yield* deleteProject(gone);
      yield* sql`DELETE FROM houston_task_history WHERE action = 'houston:project-removed'`;
      yield* sql`
        UPDATE houston_tasks SET project_id = ${gone}, revision = 1 WHERE id = ${orphan.id}
      `;
      yield* sql`UPDATE houston_task_runs SET state = 'running', reason = NULL, ended_at = NULL`;
      const keptBefore = yield* tasks.get({ id: kept.key });
      const looseBefore = yield* tasks.get({ id: loose.key });

      yield* HoustonTaskProjectSweep.sweep;

      const swept = yield* tasks.get({ id: orphan.key });
      assert.isNull(swept.task.projectId);
      assert.strictEqual(swept.history[0]?.action, "houston:project-removed");
      assert.deepEqual(changesOf(swept.history[0]?.changes ?? "{}").projectId, {
        old: gone,
        new: null,
      });
      assert.strictEqual(swept.runs[0]?.state, "interrupted");
      assert.strictEqual(swept.runs[0]?.reason, "project removed");
      assert.deepEqual(yield* tasks.get({ id: kept.key }), keptBefore);
      assert.deepEqual(yield* tasks.get({ id: loose.key }), looseBefore);
      // A second start finds nothing left to sweep.
      yield* HoustonTaskProjectSweep.sweep;
      assert.deepEqual(yield* tasks.get({ id: orphan.key }), swept);
    }).pipe(Effect.provide(layerTasks())),
  );
});

describe("deleting a project unassigns its tasks and interrupts their runs", () => {
  it.effect("tasks of the deleted project lose it with history; others stay", () =>
    Effect.gen(function* () {
      const tasks = yield* service;
      const sql = yield* SqlClient.SqlClient;
      const removed = yield* createProject("removed");
      const kept = yield* createProject("kept");
      const first = yield* create({ title: "first", projectId: removed });
      const second = yield* create({ title: "second", projectId: removed });
      const other = yield* create({ title: "other", projectId: kept });
      for (const [task, state] of [
        [first, "running"],
        [second, "handed_back"],
        [other, "running"],
      ] as const) {
        yield* sql`
          INSERT INTO houston_task_runs (
            task_id, attempt, kind, state, provider, initial_revision, started_at
          ) VALUES (${task.id}, 1, 'implementation', ${state}, 'claude', 1, '2026-01-01T00:00:00.000Z')
        `;
      }
      const otherBefore = yield* tasks.get({ id: other.key });

      yield* deleteProject(removed);

      for (const task of [first, second]) {
        const detail = yield* tasks.get({ id: task.key });
        assert.isNull(detail.task.projectId);
        assert.strictEqual(detail.task.revision, 2);
        const row = detail.history[0];
        assert.strictEqual(row?.action, "houston:project-removed");
        assert.deepEqual(changesOf(row?.changes ?? "{}").projectId, { old: removed, new: null });
      }
      const firstRun = (yield* tasks.get({ id: first.key })).runs[0];
      assert.strictEqual(firstRun?.state, "interrupted");
      assert.strictEqual(firstRun?.reason, "project removed");
      assert.isNotNull(firstRun?.endedAt);
      // A run that was not open keeps its state.
      assert.strictEqual((yield* tasks.get({ id: second.key })).runs[0]?.state, "handed_back");
      const otherAfter = yield* tasks.get({ id: other.key });
      assert.deepEqual(otherAfter, otherBefore);
    }).pipe(Effect.provide(layerTasks())),
  );
});
