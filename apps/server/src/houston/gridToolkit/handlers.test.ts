// The grid tools over the real grid service: each call's result, its refusals, and who may call it.
import { assert, it } from "@effect/vitest";
import {
  EnvironmentId,
  type OrchestrationV2ThreadShell,
  ProviderInstanceId,
  ThreadId,
} from "@houston-app/contracts";
import { HOUSTON_GRID_LIMITS } from "@houston-app/contracts/houston/grids";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";

import * as McpInvocationContext from "../../mcp/McpInvocationContext.ts";
import * as McpToolAccess from "../../mcp/McpToolAccess.ts";
import { liveThreadShell } from "../../mcp/McpToolAccess.testkit.ts";
import * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import * as HoustonGrids from "../grids.ts";
import { insertThreadRow, layerGrids } from "./gridToolkit.testkit.ts";
import * as GridHandlers from "./handlers.ts";
import { GridToolkit } from "./tools.ts";

const CALLER = ThreadId.make("thread:caller");
const PROJECT = "project:mcp-test";
const OTHER_PROJECT = "project:other";

interface Scenario {
  readonly capabilities?: ReadonlyArray<"orchestration" | "worktree">;
  readonly client?: "read-only" | "full-access";
  readonly noThread?: true;
  readonly activeRunId?: null;
}

const titles = new Map<string, string>();

const world = (scenario: Scenario = {}) => {
  const caller = liveThreadShell(
    CALLER,
    scenario.activeRunId === undefined ? {} : { activeRunId: scenario.activeRunId },
  );
  const dependencies = Layer.mergeAll(
    Layer.succeed(McpInvocationContext.McpInvocationContext, {
      environmentId: EnvironmentId.make("environment-grid-tools"),
      requestNamespace: "provider:grid-tools",
      thread: scenario.noThread
        ? undefined
        : {
            threadId: CALLER,
            providerSessionId: "provider:grid-tools",
            providerInstanceId: ProviderInstanceId.make("codex"),
          },
      client:
        scenario.client === undefined
          ? undefined
          : { sessionId: "client-1", label: "Client", access: scenario.client },
      capabilities: new Set(scenario.capabilities ?? ["orchestration" as const]),
      issuedAt: 0,
    }),
    Layer.mock(ThreadManagement.ThreadManagementService)({
      getThreadShell: (threadId) =>
        Effect.succeed(threadId === CALLER ? caller : liveThreadShell(threadId)),
      listProjectThreads: () =>
        Effect.succeed(
          [...titles].map(
            ([id, title]) =>
              ({ ...liveThreadShell(ThreadId.make(id)), title }) as OrchestrationV2ThreadShell,
          ),
        ),
    }),
  ).pipe(Layer.provideMerge(layerGrids([PROJECT, OTHER_PROJECT])));
  return Layer.provideMerge(McpToolAccess.HandlersLayer.layer(GridHandlers.layer), dependencies);
};

type Run = (name: string, input: object) => Effect.Effect<any>;

const call = <A>(
  scenario: Scenario,
  body: (run: Run) => Effect.Effect<A, never, SqlClient.SqlClient>,
) =>
  Effect.gen(function* () {
    const toolkit = yield* GridToolkit;
    const handle = toolkit.handle as unknown as (
      name: string,
      input: object,
    ) => Effect.Effect<Stream.Stream<{ result: unknown }>>;
    const run: Run = (name, input) =>
      handle(name, input).pipe(
        Stream.unwrap,
        Stream.runCollect,
        Effect.map((results) => results.at(-1)?.result),
      );
    return yield* body(run);
  }).pipe(Effect.provide(world(scenario)));

const seedThreads = (rows: ReadonlyArray<readonly [string, string]>) =>
  Effect.forEach(rows, ([id, project]) => {
    titles.set(id, `title of ${id}`);
    return insertThreadRow(id, project);
  });

it.effect("creates, lists, updates, places, removes and deletes a grid", () =>
  call({}, (run) =>
    Effect.gen(function* () {
      titles.clear();
      yield* seedThreads([
        ["t1", PROJECT],
        ["t2", PROJECT],
      ]);
      const created = yield* run("houston_grid_create", { name: "Review" });
      assert.include(created, { name: "Review", projectId: PROJECT, pinned: false, hidden: false });
      assert.deepEqual(created.threadIds, []);
      const gridId: string = created.gridId;

      yield* run("houston_grid_place_thread", { gridId, threadId: "t1" });
      const placed = yield* run("houston_grid_place_thread", { gridId, threadId: "t2" });
      assert.deepEqual(placed.threadIds, ["t1", "t2"]);

      const listed = yield* run("houston_grid_list", {});
      assert.equal(listed.grids.length, 1);
      assert.deepEqual(listed.grids[0].threads, [
        { threadId: "t1", title: "title of t1", status: "running" },
        { threadId: "t2", title: "title of t2", status: "running" },
      ]);

      const updated = yield* run("houston_grid_update", {
        gridId,
        name: "Docs",
        hidden: true,
        pinned: true,
      });
      assert.include(updated, { name: "Docs", hidden: true, pinned: true });

      const removed = yield* run("houston_grid_remove_thread", { gridId, threadId: "t1" });
      assert.deepEqual(removed.threadIds, ["t2"]);

      assert.deepEqual(yield* run("houston_grid_delete", { gridId }), { deleted: true });
      assert.deepEqual((yield* run("houston_grid_list", {})).grids, []);
    }),
  ),
);

it.effect("lists one project's grids, or all of them from outside a thread", () =>
  call({ noThread: true, client: "full-access" }, (run) =>
    Effect.gen(function* () {
      yield* run("houston_grid_create", { projectId: PROJECT });
      yield* run("houston_grid_create", { projectId: OTHER_PROJECT });
      assert.equal((yield* run("houston_grid_list", {})).grids.length, 2);
      const one = yield* run("houston_grid_list", { projectId: OTHER_PROJECT });
      assert.deepEqual(
        one.grids.map((grid: { projectId: string }) => grid.projectId),
        [OTHER_PROJECT],
      );
      // Outside a thread there is no project to default to.
      assert.include((yield* run("houston_grid_create", {})).message, "projectId");
    }),
  ),
);

it.effect("names the offending value and the limit in every refusal", () =>
  call({}, (run) =>
    Effect.gen(function* () {
      titles.clear();
      yield* seedThreads([["foreign", OTHER_PROJECT]]);
      const created = yield* run("houston_grid_create", {});
      const gridId: string = created.gridId;

      assert.deepEqual(yield* run("houston_grid_delete", { gridId: "ghost" }), { deleted: false });
      const missing = yield* run("houston_grid_update", { gridId: "ghost", name: "x" });
      assert.include(missing, { _tag: "HoustonGridError", kind: "not_found" });
      assert.include(missing.message, "ghost");

      const crossProject = yield* run("houston_grid_place_thread", { gridId, threadId: "foreign" });
      assert.include(crossProject, { kind: "cross_project" });
      assert.include(crossProject.message, "foreign");
      assert.include(crossProject.message, OTHER_PROJECT);

      const noThread = yield* run("houston_grid_place_thread", { gridId, threadId: "nothing" });
      assert.include(noThread, { kind: "not_found" });

      const empty = yield* run("houston_grid_update", { gridId });
      assert.include(empty.message, "name, hidden or pinned");

      const full = yield* Effect.forEach(
        Array.from({ length: HOUSTON_GRID_LIMITS.threads }),
        (_, n) =>
          Effect.gen(function* () {
            yield* seedThreads([[`full-${n}`, PROJECT]]);
            return yield* run("houston_grid_place_thread", { gridId, threadId: `full-${n}` });
          }),
      );
      assert.equal(full.at(-1).threadIds.length, HOUSTON_GRID_LIMITS.threads);
      yield* seedThreads([["one-more", PROJECT]]);
      const refused = yield* run("houston_grid_place_thread", { gridId, threadId: "one-more" });
      assert.include(refused, { kind: "grid_full" });
      assert.include(refused.message, String(HOUSTON_GRID_LIMITS.threads));
    }),
  ),
);

it.effect("moves a thread to another grid of its project instead of copying it", () =>
  call({}, (run) =>
    Effect.gen(function* () {
      titles.clear();
      yield* seedThreads([["m1", PROJECT]]);
      const first = (yield* run("houston_grid_create", {})).gridId;
      const second = (yield* run("houston_grid_create", {})).gridId;
      yield* run("houston_grid_place_thread", { gridId: first, threadId: "m1" });
      yield* run("houston_grid_place_thread", { gridId: second, threadId: "m1" });
      const grids = (yield* run("houston_grid_list", {})).grids;
      assert.deepEqual(
        grids.map((grid: { threads: unknown[] }) => grid.threads.length),
        [0, 1],
      );
    }),
  ),
);

it.effect("refuses a client approved for read-only access every change but allows reading", () =>
  call({ client: "read-only", noThread: true }, (run) =>
    Effect.gen(function* () {
      assert.deepEqual((yield* run("houston_grid_list", {})).grids, []);
      for (const [name, input] of [
        ["houston_grid_create", { projectId: PROJECT }],
        ["houston_grid_update", { gridId: "g", name: "x" }],
        ["houston_grid_delete", { gridId: "g" }],
        ["houston_grid_place_thread", { gridId: "g", threadId: "t" }],
        ["houston_grid_remove_thread", { gridId: "g", threadId: "t" }],
      ] as const) {
        const refusal = yield* run(name, input);
        assert.equal(refusal.code, "capability_denied", name);
      }
    }),
  ),
);

it.effect("refuses a credential that cannot control threads, for reads and changes", () =>
  call({ capabilities: ["worktree"] }, (run) =>
    Effect.gen(function* () {
      for (const [name, input] of [
        ["houston_grid_list", {}],
        ["houston_grid_create", {}],
        ["houston_grid_delete", { gridId: "g" }],
      ] as const) {
        assert.equal((yield* run(name, input)).code, "capability_denied", name);
      }
    }),
  ),
);

it.effect("refuses a change from a thread whose turn has ended", () =>
  call({ activeRunId: null }, (run) =>
    Effect.gen(function* () {
      assert.equal((yield* run("houston_grid_create", {})).code, "parent_not_active");
      assert.deepEqual((yield* run("houston_grid_list", {})).grids, []);
    }),
  ),
);

it.effect("does not touch the grid service for a refused caller", () =>
  Effect.gen(function* () {
    const calls: string[] = [];
    const layer = McpToolAccess.HandlersLayer.layer(GridHandlers.layer).pipe(
      Layer.provideMerge(
        Layer.mergeAll(
          Layer.succeed(McpInvocationContext.McpInvocationContext, {
            environmentId: EnvironmentId.make("environment-grid-tools"),
            requestNamespace: "provider:grid-tools",
            thread: undefined,
            client: { sessionId: "c", label: "Client", access: "read-only" },
            capabilities: new Set(["orchestration" as const]),
            issuedAt: 0,
          }),
          Layer.mock(ThreadManagement.ThreadManagementService)({}),
          Layer.mock(HoustonGrids.HoustonGridService)({
            delete: () =>
              Effect.sync(() => calls.push("delete")).pipe(Effect.as({ deleted: true })),
          }),
        ),
      ),
    );
    const toolkit = yield* GridToolkit.pipe(Effect.provide(layer));
    yield* toolkit
      .handle("houston_grid_delete", { gridId: "g" })
      .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(layer));
    assert.deepEqual(calls, []);
  }),
);
