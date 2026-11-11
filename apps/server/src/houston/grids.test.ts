// The grid service over an in-memory database: the shared domain's operations, revisions,
// the project and cap checks, and the change events.
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, describe, it } from "@effect/vitest";
import { EnvironmentId, ProjectId } from "@houston-app/contracts";
import {
  HOUSTON_GRID_LIMITS,
  type HoustonGridError,
  type HoustonGridRecord,
} from "@houston-app/contracts/houston/grids";
import { MAX_GRID_THREADS } from "@houston-app/shared/grid/record";
import { preorderThreads } from "@houston-app/shared/grid/tree";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as HoustonGrids from "./grids.ts";

const ENV = "env-1";
const KNOWN_PROJECTS = ["p1", "p2"];

const layer = HoustonGrids.layer.pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
        getEnvironmentId: Effect.succeed(EnvironmentId.make(ENV)),
      }),
      Layer.mock(ProjectStore.ProjectStoreV2)({
        get: (projectId: ProjectId) =>
          Effect.succeed(
            KNOWN_PROJECTS.includes(projectId)
              ? Option.some({ projectId, deletedAt: null } as never)
              : Option.none(),
          ),
      }),
    ),
  ),
  Layer.provideMerge(Layer.fresh(SqlitePersistence.layerMemory)),
  Layer.provideMerge(NodeCrypto.layer),
);

const addThreads = (rows: ReadonlyArray<readonly [string, string]>) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    for (const [threadId, projectId] of rows) {
      yield* sql`
        INSERT INTO houston_thread_shell (thread_id, project_id, deleted, archived, payload_valid, watches_pull_request)
        VALUES (${threadId}, ${projectId}, 0, 0, 1, 0)
      `;
    }
  });

const ids = (record: HoustonGridRecord) =>
  record.tree === null ? [] : preorderThreads(record.tree).map((leaf) => leaf.threadId);

const failure = <A>(effect: Effect.Effect<A, HoustonGridError>) => Effect.flip(effect);

describe("the grid limits match the domain", () => {
  it("the per-grid thread cap is the shared domain's", () => {
    assert.equal(HOUSTON_GRID_LIMITS.threads, MAX_GRID_THREADS);
  });
});

describe("create, rename, hide, pin and delete", () => {
  it.effect("creates a numbered empty grid for a known project", () =>
    Effect.gen(function* () {
      const grids = yield* HoustonGrids.HoustonGridService;
      const first = yield* grids.create({ projectId: "p1" });
      const second = yield* grids.create({ projectId: "p1", name: " Review " });
      assert.deepInclude(first, {
        name: "Grid 1",
        environmentId: ENV,
        workspaceKey: `${ENV}:p1`,
        tree: null,
        revision: 1,
        hidden: false,
        pinnedAt: null,
      });
      assert.equal(second.name, "Review");
      assert.deepEqual(
        (yield* grids.list({ projectId: "p1" })).map((grid) => grid.id),
        [first.id, second.id],
      );
    }).pipe(Effect.provide(layer)),
  );

  it.effect("refuses an unknown project by id", () =>
    Effect.gen(function* () {
      const grids = yield* HoustonGrids.HoustonGridService;
      const error = yield* failure(grids.create({ projectId: "ghost" }));
      assert.deepInclude(error, { kind: "not_found", field: "projectId" });
      assert.include(error.message, "ghost");
    }).pipe(Effect.provide(layer)),
  );

  it.effect("refuses the 201st grid naming the limit, the count and the request", () =>
    Effect.gen(function* () {
      const grids = yield* HoustonGrids.HoustonGridService;
      for (let n = 0; n < HOUSTON_GRID_LIMITS.gridsPerProject; n += 1) {
        yield* grids.create({ projectId: "p1" });
      }
      const error = yield* failure(grids.create({ projectId: "p1" }));
      assert.deepInclude(error, {
        kind: "limit",
        limit: HOUSTON_GRID_LIMITS.gridsPerProject,
        actual: HOUSTON_GRID_LIMITS.gridsPerProject,
      });
      assert.include(error.message, "limit is 200");
      assert.include(error.message, "already has 200 grids");
      assert.include(error.message, "adds 1 more");
      assert.equal((yield* grids.create({ projectId: "p2" })).revision, 1);
    }).pipe(Effect.provide(layer)),
  );

  it.effect(
    "renames, hides and pins with a revision bump each, and refuses a blank or long name",
    () =>
      Effect.gen(function* () {
        const grids = yield* HoustonGrids.HoustonGridService;
        const grid = yield* grids.create({ projectId: "p1" });
        const renamed = yield* grids.rename({ gridId: grid.id, name: " Docs " });
        const hidden = yield* grids.setHidden({ gridId: grid.id, hidden: true });
        const pinned = yield* grids.setPinned({ gridId: grid.id, pinned: true });
        assert.deepInclude(pinned, { name: "Docs", hidden: true, revision: 4 });
        assert.isString(pinned.pinnedAt);
        assert.equal(renamed.revision, 2);
        assert.equal(hidden.revision, 3);
        const unpinned = yield* grids.setPinned({ gridId: grid.id, pinned: false });
        assert.isNull(unpinned.pinnedAt);
        const blank = yield* failure(grids.rename({ gridId: grid.id, name: "  " }));
        assert.deepInclude(blank, { kind: "invalid", field: "name" });
        const long = yield* failure(
          grids.rename({ gridId: grid.id, name: "x".repeat(HOUSTON_GRID_LIMITS.nameChars + 1) }),
        );
        assert.deepInclude(long, { kind: "limit", limit: 120, actual: 121 });
      }).pipe(Effect.provide(layer)),
  );

  it.effect("an operation that changes nothing keeps the revision", () =>
    Effect.gen(function* () {
      const grids = yield* HoustonGrids.HoustonGridService;
      const grid = yield* grids.create({ projectId: "p1" });
      const same = yield* grids.setHidden({ gridId: grid.id, hidden: false });
      assert.equal(same.revision, 1);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("deletes a grid once and reports a second delete", () =>
    Effect.gen(function* () {
      const grids = yield* HoustonGrids.HoustonGridService;
      const grid = yield* grids.create({ projectId: "p1" });
      assert.deepEqual(yield* grids.delete({ gridId: grid.id }), { deleted: true });
      assert.deepEqual(yield* grids.delete({ gridId: grid.id }), { deleted: false });
      assert.deepEqual(yield* grids.list({}), []);
    }).pipe(Effect.provide(layer)),
  );
});

describe("placing and removing threads", () => {
  it.effect("appends a thread and moves it out of another grid of the project", () =>
    Effect.gen(function* () {
      yield* addThreads([
        ["t1", "p1"],
        ["t2", "p1"],
      ]);
      const grids = yield* HoustonGrids.HoustonGridService;
      const a = yield* grids.create({ projectId: "p1" });
      const b = yield* grids.create({ projectId: "p1" });
      yield* grids.placeThread({ gridId: a.id, threadId: "t1" });
      yield* grids.placeThread({ gridId: a.id, threadId: "t2" });
      const moved = yield* grids.placeThread({ gridId: b.id, threadId: "t1" });
      assert.deepEqual(ids(moved), ["t1"]);
      assert.deepEqual(ids(yield* grids.get(a.id)), ["t2"]);
      assert.equal((yield* grids.get(a.id)).revision, 4);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("refuses a thread of another project, an unknown thread and a full grid by name", () =>
    Effect.gen(function* () {
      yield* addThreads([["other", "p2"]]);
      yield* addThreads(
        Array.from({ length: MAX_GRID_THREADS + 1 }, (_, n) => [`t${n}`, "p1"] as const),
      );
      const grids = yield* HoustonGrids.HoustonGridService;
      const grid = yield* grids.create({ projectId: "p1" });
      const foreign = yield* failure(grids.placeThread({ gridId: grid.id, threadId: "other" }));
      assert.equal(foreign.kind, "cross_project");
      assert.include(foreign.message, "other");
      assert.include(foreign.message, "p2");
      const missing = yield* failure(grids.placeThread({ gridId: grid.id, threadId: "nope" }));
      assert.deepInclude(missing, { kind: "not_found", field: "threadId" });
      for (let n = 0; n < MAX_GRID_THREADS; n += 1) {
        yield* grids.placeThread({ gridId: grid.id, threadId: `t${n}` });
      }
      const full = yield* failure(
        grids.placeThread({ gridId: grid.id, threadId: `t${MAX_GRID_THREADS}` }),
      );
      assert.deepInclude(full, {
        kind: "grid_full",
        limit: MAX_GRID_THREADS,
        actual: MAX_GRID_THREADS,
      });
    }).pipe(Effect.provide(layer)),
  );

  it.effect("removes a thread and refuses one the grid does not show", () =>
    Effect.gen(function* () {
      yield* addThreads([["t1", "p1"]]);
      const grids = yield* HoustonGrids.HoustonGridService;
      const grid = yield* grids.create({ projectId: "p1" });
      yield* grids.placeThread({ gridId: grid.id, threadId: "t1" });
      assert.isNull((yield* grids.removeThread({ gridId: grid.id, threadId: "t1" })).tree);
      const error = yield* failure(grids.removeThread({ gridId: grid.id, threadId: "t1" }));
      assert.deepInclude(error, { kind: "not_found", field: "threadId" });
    }).pipe(Effect.provide(layer)),
  );
});

describe("put with an expected revision", () => {
  it.effect("creates at revision 0, saves at the stored revision and bumps it", () =>
    Effect.gen(function* () {
      yield* addThreads([["t1", "p1"]]);
      const grids = yield* HoustonGrids.HoustonGridService;
      const base: HoustonGridRecord = {
        id: "client-grid",
        environmentId: ENV,
        projectId: "p1",
        workspaceKey: `${ENV}:p1`,
        name: "Mine",
        tree: null,
        pinnedAt: null,
        hidden: false,
        createdAt: "2026-01-01T00:00:00.000Z",
        revision: 0,
        updatedAt: "2026-01-01T00:00:00.000Z",
      };
      const created = yield* grids.put({ grid: base, expectedRevision: 0 });
      assert.equal(created.status === "saved" && created.grid.revision, 1);
      const tree = { kind: "thread", threadId: "t1", id: "pane-1" } as const;
      const saved = yield* grids.put({ grid: { ...base, tree }, expectedRevision: 1 });
      assert.equal(saved.status === "saved" && saved.grid.revision, 2);
      const unchanged = yield* grids.put({ grid: { ...base, tree }, expectedRevision: 2 });
      assert.equal(unchanged.status === "saved" && unchanged.grid.revision, 2);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("a stale revision returns the stored grid and changes nothing", () =>
    Effect.gen(function* () {
      const grids = yield* HoustonGrids.HoustonGridService;
      const grid = yield* grids.create({ projectId: "p1" });
      yield* grids.rename({ gridId: grid.id, name: "Server name" });
      const result = yield* grids.put({
        grid: { ...grid, name: "Client name" },
        expectedRevision: 1,
      });
      assert.equal(result.status, "conflict");
      assert.equal(result.status === "conflict" && result.current?.name, "Server name");
      assert.equal((yield* grids.get(grid.id)).name, "Server name");
    }).pipe(Effect.provide(layer)),
  );

  it.effect("a put for a deleted grid conflicts with no current grid", () =>
    Effect.gen(function* () {
      const grids = yield* HoustonGrids.HoustonGridService;
      const grid = yield* grids.create({ projectId: "p1" });
      yield* grids.delete({ gridId: grid.id });
      const result = yield* grids.put({ grid, expectedRevision: 1 });
      assert.deepEqual(result, { status: "conflict", current: null });
    }).pipe(Effect.provide(layer)),
  );

  it.effect("refuses another environment, a foreign thread and a project change", () =>
    Effect.gen(function* () {
      yield* addThreads([["other", "p2"]]);
      const grids = yield* HoustonGrids.HoustonGridService;
      const grid = yield* grids.create({ projectId: "p1" });
      const wrongEnv = yield* failure(
        grids.put({
          grid: { ...grid, environmentId: "elsewhere", workspaceKey: "elsewhere:p1" },
          expectedRevision: 1,
        }),
      );
      assert.deepInclude(wrongEnv, { kind: "invalid", field: "environmentId" });
      const foreign = yield* failure(
        grids.put({
          grid: { ...grid, tree: { kind: "thread", threadId: "other", id: "pane" } },
          expectedRevision: 1,
        }),
      );
      assert.equal(foreign.kind, "cross_project");
      const moved = yield* failure(
        grids.put({
          grid: { ...grid, projectId: "p2", workspaceKey: `${ENV}:p2` },
          expectedRevision: 1,
        }),
      );
      assert.deepInclude(moved, { kind: "invalid", field: "projectId" });
    }).pipe(Effect.provide(layer)),
  );
});

describe("the change stream", () => {
  it.effect("opens with a snapshot, then carries each committed change in order", () =>
    Effect.gen(function* () {
      const grids = yield* HoustonGrids.HoustonGridService;
      const existing = yield* grids.create({ projectId: "p1" });
      const taken = yield* grids.subscribe.pipe(
        Stream.take(4),
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* Effect.yieldNow;
      const created = yield* grids.create({ projectId: "p1" });
      yield* grids.rename({ gridId: created.id, name: "Renamed" });
      yield* grids.delete({ gridId: created.id });
      const events = yield* Fiber.join(taken);
      assert.deepEqual(events[0], { snapshot: { grids: [existing] } });
      assert.equal("upserted" in events[1]! && events[1].upserted.id, created.id);
      assert.equal("upserted" in events[2]! && events[2].upserted.name, "Renamed");
      assert.deepEqual(events[3], { deleted: { gridId: created.id, projectId: "p1" } });
    }).pipe(Effect.provide(layer)),
  );

  it.effect("sweeping drops the grids of a project that is gone and announces each", () =>
    Effect.gen(function* () {
      const grids = yield* HoustonGrids.HoustonGridService;
      const keep = yield* grids.create({ projectId: "p2" });
      const sql = yield* SqlClient.SqlClient;
      // Composed fixture: a grid whose project was deleted after the grid was saved.
      yield* sql`
        INSERT INTO houston_grids (id, project_id, record_json, revision, created_at, updated_at)
        VALUES ('orphan', 'gone', ${JSON.stringify({ ...keep, id: "orphan", projectId: "gone", workspaceKey: `${ENV}:gone` })}, 1, 'now', 'now')
      `;
      const taken = yield* grids.subscribe.pipe(
        Stream.take(2),
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* Effect.yieldNow;
      yield* grids.sweepOrphans;
      const events = yield* Fiber.join(taken);
      assert.deepEqual(events[1], { deleted: { gridId: "orphan", projectId: "gone" } });
      assert.deepEqual(
        (yield* grids.list({})).map((entry) => entry.id),
        [keep.id],
      );
    }).pipe(Effect.provide(layer)),
  );
});
