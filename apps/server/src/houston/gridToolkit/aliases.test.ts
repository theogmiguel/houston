// The houston_grid_* tools are aliases: each one runs the matching workspace handler, so the same
// calls reach the workspace service whichever name an agent uses.
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2ThreadShell,
} from "@houston-app/contracts";
import type { HoustonLayoutWorkspaceError } from "@houston-app/contracts/houston/layoutWorkspaces";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as McpInvocationContext from "../../mcp/McpInvocationContext.ts";
import * as McpToolAccess from "../../mcp/McpToolAccess.ts";
import { liveThreadShell } from "../../mcp/McpToolAccess.testkit.ts";
import * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import * as WorkspaceHandlers from "../workspaceToolkit/handlers.ts";
import { WorkspaceToolkit } from "../workspaceToolkit/tools.ts";
import {
  chatContent,
  chatThreadsOf,
  columnOf,
  layerWorkspaces,
  seedWorkspace,
  WORKSPACE_TEST_ENVIRONMENT,
  workspaceRecord,
} from "../workspaceToolkit/workspaceToolkit.testkit.ts";
import * as HoustonLayoutWorkspaces from "../layoutWorkspaces.ts";
import * as GridHandlers from "./handlers.ts";
import { GridToolkit } from "./tools.ts";

const CALLER = ThreadId.make("thread:caller");
const Service = HoustonLayoutWorkspaces.HoustonLayoutWorkspaceService;

const context = Layer.mergeAll(
  Layer.succeed(McpInvocationContext.McpInvocationContext, {
    environmentId: EnvironmentId.make(WORKSPACE_TEST_ENVIRONMENT),
    requestNamespace: "provider:grid-aliases",
    thread: {
      threadId: CALLER,
      providerSessionId: "provider:grid-aliases",
      providerInstanceId: ProviderInstanceId.make("codex"),
    },
    client: undefined,
    capabilities: new Set(["orchestration" as const]),
    issuedAt: 0,
  }),
  Layer.mock(ThreadManagement.ThreadManagementService)({
    getThreadShell: (threadId) => Effect.succeed(liveThreadShell(threadId)),
    listProjectThreads: () =>
      Effect.succeed([
        {
          ...liveThreadShell(ThreadId.make("t1")),
          title: "title of t1",
        } as OrchestrationV2ThreadShell,
      ]),
  }),
);

/** Both toolkits over one service that logs every method it is asked to run. */
const world = (log: string[]) =>
  Layer.mergeAll(
    McpToolAccess.HandlersLayer.layer(GridHandlers.layer),
    McpToolAccess.HandlersLayer.layer(WorkspaceHandlers.layer),
  ).pipe(
    Layer.provideMerge(NodeCrypto.layer),
    Layer.provideMerge(
      Layer.effect(
        Service,
        Effect.gen(function* () {
          const real = yield* Service;
          const logged = <A extends (...args: any[]) => any>(name: string, method: A): A =>
            ((...args: unknown[]) => {
              log.push(name);
              return method(...args);
            }) as A;
          return Service.of({
            ...real,
            get: logged("get", real.get),
            put: logged("put", real.put),
            reorder: logged("reorder", real.reorder),
            delete: logged("delete", real.delete),
            list: Effect.suspend(() => {
              log.push("list");
              return real.list;
            }),
          });
        }),
      ).pipe(Layer.provide(layerWorkspaces)),
    ),
    Layer.provideMerge(context),
  );

type Run = (tool: "grid" | "workspace", name: string, input: object) => Effect.Effect<any>;

type Needs = HoustonLayoutWorkspaces.HoustonLayoutWorkspaceService;

const call = <A, E>(log: string[], body: (run: Run) => Effect.Effect<A, E, Needs>) =>
  Effect.gen(function* () {
    const grid = yield* GridToolkit;
    const workspace = yield* WorkspaceToolkit;
    const run: Run = (tool, name, input) =>
      (
        (tool === "grid" ? grid : workspace).handle as unknown as (
          name: string,
          input: object,
        ) => Effect.Effect<Stream.Stream<{ result: unknown }>>
      )(name, input).pipe(
        Stream.unwrap,
        Stream.runCollect,
        Effect.map((results) => results.at(-1)?.result),
      );
    return yield* body(run);
  }).pipe(Effect.provide(world(log)));

/** Runs `setup`, then one call, and returns the service methods that call ran and its result. */
const trace = (
  tool: "grid" | "workspace",
  name: string,
  input: object,
  setup: Effect.Effect<void, HoustonLayoutWorkspaceError, Needs> = Effect.void,
) => {
  const log: string[] = [];
  return call(log, (run) =>
    Effect.gen(function* () {
      yield* setup;
      log.length = 0;
      const result = yield* run(tool, name, input);
      return { methods: [...log], result };
    }),
  );
};

const seeded = Effect.gen(function* () {
  yield* seedWorkspace(workspaceRecord("w", [columnOf([chatContent("t1")])]));
  yield* seedWorkspace(workspaceRecord("w2", [], { position: 1 }));
}).pipe(Effect.asVoid);

const PAIRS = [
  ["houston_grid_list", {}, "houston_workspace_list", {}],
  ["houston_grid_create", { name: "N" }, "houston_workspace_create", { name: "N" }],
  [
    "houston_grid_update",
    { gridId: "w", name: "Renamed", pinned: true, hidden: true },
    "houston_workspace_update",
    { workspaceId: "w", name: "Renamed", pinned: true, hidden: true },
  ],
  ["houston_grid_delete", { gridId: "w2" }, "houston_workspace_delete", { workspaceId: "w2" }],
  [
    "houston_grid_place_thread",
    { gridId: "w2", threadId: "t1" },
    "houston_workspace_add_thread",
    { workspaceId: "w2", threadId: "t1" },
  ],
  [
    "houston_grid_remove_thread",
    { gridId: "w", threadId: "t1" },
    "houston_workspace_remove_thread",
    { workspaceId: "w", threadId: "t1" },
  ],
] as const;

for (const [alias, aliasInput, tool, toolInput] of PAIRS) {
  it.effect(`${alias} runs the same service calls as ${tool}`, () =>
    Effect.gen(function* () {
      const viaAlias = yield* trace("grid", alias, aliasInput, seeded);
      const viaTool = yield* trace("workspace", tool, toolInput, seeded);
      assert.isAbove(viaTool.methods.length, 0);
      assert.deepEqual(viaAlias.methods, viaTool.methods);
    }),
  );
}

it.effect("a grid id is a workspace id, and the alias answers with it as gridId", () =>
  Effect.gen(function* () {
    const log: string[] = [];
    yield* call(log, (run) =>
      Effect.gen(function* () {
        yield* seeded;
        const added = yield* run("grid", "houston_grid_place_thread", {
          gridId: "w2",
          threadId: "t1",
        });
        assert.include(added, { gridId: "w2", workspaceId: "w2" });
        assert.deepEqual(added.threadIds, ["t1"]);
        const listed = yield* run("grid", "houston_grid_list", {});
        assert.deepEqual(
          listed.grids.map((grid: { gridId: string }) => grid.gridId),
          ["workspace:default", "w", "w2"],
        );
        assert.deepEqual(listed.grids[2].threads, [
          { threadId: "t1", title: "title of t1", status: "running" },
        ]);
        const service = yield* Service;
        assert.deepEqual(chatThreadsOf(yield* service.get("w")), []);
      }),
    );
  }),
);

it.effect("grid tools accept and ignore projectId", () =>
  Effect.gen(function* () {
    const log: string[] = [];
    yield* call(log, (run) =>
      Effect.gen(function* () {
        const created = yield* run("grid", "houston_grid_create", {
          projectId: "project:anything",
          name: "Any",
        });
        assert.include(created, { name: "Any" });
        assert.notProperty(created, "projectId");
        const listed = yield* run("grid", "houston_grid_list", { projectId: "project:elsewhere" });
        assert.equal(listed.grids.length, 2);
      }),
    );
  }),
);

it.effect("grid tools advertise that they are aliases that will be removed", () =>
  Effect.sync(() => {
    for (const tool of Object.values(GridToolkit.tools)) {
      assert.match(tool.description ?? "", /Alias of `houston_workspace_[a-z_]+`/);
      assert.include(tool.description ?? "", "will be removed");
    }
  }),
);
