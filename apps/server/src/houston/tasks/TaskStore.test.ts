// Keys and id resolution in the Tasks store.
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Cause from "effect/Cause";
import * as SqlClient from "effect/sql/SqlClient";

import { HoustonTaskError } from "@t3tools/contracts/houston/tasks";
import * as HoustonTaskService from "./TaskService.ts";
import * as HoustonTaskStore from "./TaskStore.ts";
import { createProject, layerTasks } from "./tasks.testkit.ts";

const create = (title: string) =>
  Effect.gen(function* () {
    const service = yield* HoustonTaskService.HoustonTaskService;
    return yield* service.save({ patch: { title } });
  });

const failureOf = <A, E>(exit: Exit.Exit<A, E>) => {
  assert.isTrue(Exit.isFailure(exit));
  const error = Cause.squash((exit as Exit.Failure<A, E>).cause);
  assert.instanceOf(error, HoustonTaskError);
  return error as HoustonTaskError;
};

describe("keys come from the global counter and are never reused", () => {
  it.effect("an empty backlog gives HOU-1", () =>
    Effect.gen(function* () {
      const task = yield* create("first");
      assert.strictEqual(task.key, "HOU-1");
      assert.strictEqual(task.number, 1);
      assert.strictEqual(task.revision, 1);
      assert.strictEqual(task.status, "backlog");
    }).pipe(Effect.provide(layerTasks())),
  );

  it.effect("after HOU-1..HOU-3 with HOU-3 archived the next is HOU-4", () =>
    Effect.gen(function* () {
      const service = yield* HoustonTaskService.HoustonTaskService;
      yield* create("one");
      yield* create("two");
      const third = yield* create("three");
      yield* service.archive({ id: third.key, archived: true, expectedRevision: third.revision });
      assert.strictEqual((yield* create("four")).key, "HOU-4");
    }).pipe(Effect.provide(layerTasks())),
  );

  it.effect("with the counter at 42 the next is HOU-42, and a removed number stays used", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE houston_task_counter SET next_number = 42 WHERE id = 1`;
      const task = yield* create("imported counter");
      assert.strictEqual(task.key, "HOU-42");
      // A row gone from the table does not free its number.
      yield* sql`DELETE FROM houston_tasks WHERE id = ${task.id}`;
      assert.strictEqual((yield* create("after removal")).key, "HOU-43");
      const numbers = yield* sql<{ readonly number: number }>`
        SELECT number FROM houston_tasks ORDER BY number
      `;
      assert.deepEqual(
        numbers.map((row) => row.number),
        [43],
      );
    }).pipe(Effect.provide(layerTasks())),
  );
});

describe("readiness names an initiative of another project", () => {
  it.effect("a task moved to Q whose initiative belongs to P lists the reason", () =>
    Effect.gen(function* () {
      const service = yield* HoustonTaskService.HoustonTaskService;
      const store = yield* HoustonTaskStore.HoustonTaskStore;
      const p = yield* createProject("readiness-p");
      const q = yield* createProject("readiness-q");
      const initiative = yield* service.saveInitiative({ projectId: p, name: "Launch" });
      const task = yield* service.save({
        patch: { title: "moved", projectId: p, acceptance: ["it works"] },
      });
      yield* service.saveDomain({
        id: task.key,
        expectedRevision: task.revision,
        kind: "delivery",
        initiativeId: initiative.id,
      });
      const inP = yield* service.get({ id: task.key });
      assert.deepEqual(inP.domain.readiness.reasons, []);
      yield* service.save({
        id: task.key,
        expectedRevision: inP.task.revision,
        patch: { projectId: q },
      });
      const reason = "the task's initiative is archived or belongs to another project";
      assert.deepEqual((yield* service.get({ id: task.key })).domain.readiness.reasons, [reason]);
      const [summary] = (yield* store.summaries({ scope: { projectId: q } })).summaries;
      assert.strictEqual(summary?.ready, false);
    }).pipe(Effect.provide(layerTasks())),
  );
});

describe("an unknown key is refused naming it", () => {
  it.effect("HOU-42, hou-42 and the task's decimal id resolve to the same task", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const store = yield* HoustonTaskStore.HoustonTaskStore;
      yield* sql`UPDATE houston_task_counter SET next_number = 42 WHERE id = 1`;
      const task = yield* create("forty-two");
      assert.notStrictEqual(task.id, 42);
      for (const ref of ["HOU-42", "hou-42", String(task.id)]) {
        const resolved = yield* store.resolve("houston.tasks.get", ref);
        assert.strictEqual(resolved.id, task.id, ref);
      }
    }).pipe(Effect.provide(layerTasks())),
  );

  it.effect("an unknown key or id fails with not_found naming the input", () =>
    Effect.gen(function* () {
      const store = yield* HoustonTaskStore.HoustonTaskStore;
      yield* create("only");
      for (const ref of ["HOU-99", "hou-7", "99"]) {
        const error = failureOf(yield* Effect.exit(store.resolve("houston.tasks.get", ref)));
        assert.strictEqual(error.kind, "not_found");
        assert.strictEqual(error.operation, "houston.tasks.get");
        assert.include(error.message, ref);
      }
    }).pipe(Effect.provide(layerTasks())),
  );

  it.effect("a malformed id fails with invalid", () =>
    Effect.gen(function* () {
      const store = yield* HoustonTaskStore.HoustonTaskStore;
      for (const ref of ["HOU-0", "HOU-x"]) {
        const error = failureOf(yield* Effect.exit(store.resolve("houston.tasks.get", ref)));
        assert.strictEqual(error.kind, "invalid");
        assert.include(error.message, ref);
      }
    }).pipe(Effect.provide(layerTasks())),
  );
});
