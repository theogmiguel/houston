// The workspace tools over the real workspace service: each call's result, its refusals, and who may call it.
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it } from "@effect/vitest";
import {
  EnvironmentId,
  type OrchestrationV2ThreadShell,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@houston-app/contracts";
import { HOUSTON_LAYOUT_WORKSPACE_LIMITS as LIMITS } from "@houston-app/contracts/houston/layoutWorkspaces";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as McpInvocationContext from "../../mcp/McpInvocationContext.ts";
import * as McpToolAccess from "../../mcp/McpToolAccess.ts";
import { liveThreadShell } from "../../mcp/McpToolAccess.testkit.ts";
import * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import * as HoustonLayoutWorkspaces from "../layoutWorkspaces.ts";
import * as WorkspaceHandlers from "./handlers.ts";
import { WorkspaceToolkit } from "./tools.ts";
import {
  chatContent,
  columnOf,
  layerWorkspaces,
  seedWorkspace,
  WORKSPACE_TEST_ENVIRONMENT,
  workspaceRecord,
} from "./workspaceToolkit.testkit.ts";

const CALLER = ThreadId.make("thread:caller");
/** The workspace a fresh database starts with, so a layout is never empty. */
const DEFAULT = "workspace:default";

interface Scenario {
  readonly capabilities?: ReadonlyArray<"orchestration" | "worktree">;
  readonly client?: "read-only" | "full-access";
  readonly noThread?: true;
  readonly activeRunId?: null;
  /** Thread ids that no longer exist. */
  readonly gone?: ReadonlyArray<string>;
}

const titles = new Map<string, string>();

const world = (scenario: Scenario = {}) => {
  const caller = liveThreadShell(
    CALLER,
    scenario.activeRunId === undefined ? {} : { activeRunId: scenario.activeRunId },
  );
  const dependencies = Layer.mergeAll(
    Layer.succeed(McpInvocationContext.McpInvocationContext, {
      environmentId: EnvironmentId.make(WORKSPACE_TEST_ENVIRONMENT),
      requestNamespace: "provider:workspace-tools",
      thread: scenario.noThread
        ? undefined
        : {
            threadId: CALLER,
            providerSessionId: "provider:workspace-tools",
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
        threadId === CALLER
          ? Effect.succeed(caller)
          : scenario.gone?.includes(threadId)
            ? Effect.fail({ _tag: "ThreadManagementThreadNotFoundError" } as never)
            : Effect.succeed({
                ...liveThreadShell(threadId),
                // Threads named `other:*` belong to a project other than the caller's.
                ...(threadId.startsWith("other:")
                  ? { projectId: ProjectId.make("project:other") }
                  : {}),
              }),
      listProjectThreads: () =>
        Effect.succeed(
          [...titles].map(
            ([id, title]) =>
              ({ ...liveThreadShell(ThreadId.make(id)), title }) as OrchestrationV2ThreadShell,
          ),
        ),
    }),
  ).pipe(Layer.provideMerge(layerWorkspaces));
  return Layer.provideMerge(
    McpToolAccess.HandlersLayer.layer(WorkspaceHandlers.layer),
    dependencies,
  );
};

type Run = (name: string, input: object) => Effect.Effect<any>;

const call = <A, E>(
  scenario: Scenario,
  body: (run: Run) => Effect.Effect<A, E, HoustonLayoutWorkspaces.HoustonLayoutWorkspaceService>,
) =>
  Effect.gen(function* () {
    const toolkit = yield* WorkspaceToolkit;
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

it.effect("creates, lists, updates, adds, removes, reorders and deletes a workspace", () =>
  call({}, (run) =>
    Effect.gen(function* () {
      titles.clear();
      titles.set("t1", "title of t1");
      titles.set("t2", "title of t2");
      const created = yield* run("houston_workspace_create", { name: "Review" });
      assert.include(created, { name: "Review", pinned: false, hidden: false });
      assert.deepEqual(created.threadIds, []);
      const workspaceId: string = created.workspaceId;

      yield* run("houston_workspace_add_thread", { workspaceId, threadId: "t1" });
      const added = yield* run("houston_workspace_add_thread", { workspaceId, threadId: "t2" });
      assert.deepEqual(added.threadIds, ["t1", "t2"]);

      const listed = yield* run("houston_workspace_list", {});
      assert.deepEqual(
        listed.workspaces.map((workspace: { workspaceId: string }) => workspace.workspaceId),
        [DEFAULT, workspaceId],
      );
      assert.deepEqual(listed.workspaces[1].threads, [
        { threadId: "t1", title: "title of t1", status: "running" },
        { threadId: "t2", title: "title of t2", status: "running" },
      ]);

      const updated = yield* run("houston_workspace_update", {
        workspaceId,
        name: "Docs",
        hidden: true,
        pinned: true,
      });
      assert.include(updated, { name: "Docs", hidden: true, pinned: true });
      const unpinned = yield* run("houston_workspace_update", { workspaceId, pinned: false });
      assert.include(unpinned, { name: "Docs", hidden: true, pinned: false });

      const removed = yield* run("houston_workspace_remove_thread", {
        workspaceId,
        threadId: "t1",
      });
      assert.deepEqual(removed.threadIds, ["t2"]);

      const second = (yield* run("houston_workspace_create", {})).workspaceId;
      const reordered = yield* run("houston_workspace_reorder", {
        workspaceIds: [second, workspaceId, DEFAULT],
      });
      assert.deepEqual(
        reordered.workspaces.map((workspace: { workspaceId: string }) => workspace.workspaceId),
        [second, workspaceId, DEFAULT],
      );

      // Deleting keeps the threads: their chat tabs move to the first remaining workspace.
      assert.deepEqual(yield* run("houston_workspace_delete", { workspaceId }), { deleted: true });
      const after = (yield* run("houston_workspace_list", {})).workspaces;
      assert.deepEqual(
        after.map((workspace: { workspaceId: string }) => workspace.workspaceId),
        [second, DEFAULT],
      );
      assert.deepEqual(
        after[0].threads.map((thread: { threadId: string }) => thread.threadId),
        ["t2"],
      );
    }),
  ),
);

it.effect("names a default workspace after how many exist", () =>
  call({}, (run) =>
    Effect.gen(function* () {
      assert.equal((yield* run("houston_workspace_create", {})).name, "Workspace 2");
      assert.equal((yield* run("houston_workspace_create", {})).name, "Workspace 3");
    }),
  ),
);

it.effect("adding a thread to another workspace moves it instead of copying it", () =>
  call({}, (run) =>
    Effect.gen(function* () {
      const first = (yield* run("houston_workspace_create", {})).workspaceId;
      const second = (yield* run("houston_workspace_create", {})).workspaceId;
      yield* run("houston_workspace_add_thread", { workspaceId: first, threadId: "m1" });
      yield* run("houston_workspace_add_thread", { workspaceId: second, threadId: "m1" });
      const listed = (yield* run("houston_workspace_list", {})).workspaces;
      assert.deepEqual(
        listed.map((workspace: { threads: unknown[] }) => workspace.threads.length),
        [0, 0, 1],
      );
    }),
  ),
);

it.effect("a workspace holds threads of any project", () =>
  call({}, (run) =>
    Effect.gen(function* () {
      // The caller's project and another project's thread share one workspace.
      const workspaceId = (yield* run("houston_workspace_create", {})).workspaceId;
      yield* run("houston_workspace_add_thread", { workspaceId, threadId: "mine" });
      const foreign = yield* run("houston_workspace_add_thread", {
        workspaceId,
        threadId: "other:thread",
      });
      assert.deepEqual(foreign.threadIds, ["mine", "other:thread"]);
    }),
  ),
);

it.effect("names the offending value and the limit in every refusal", () =>
  call({ gone: ["gone"] }, (run) =>
    Effect.gen(function* () {
      const workspaceId: string = (yield* run("houston_workspace_create", {})).workspaceId;

      assert.deepEqual(yield* run("houston_workspace_delete", { workspaceId: "ghost" }), {
        deleted: false,
      });
      const missing = yield* run("houston_workspace_update", { workspaceId: "ghost", name: "x" });
      assert.include(missing, { _tag: "HoustonLayoutWorkspaceError", kind: "not_found" });
      assert.include(missing.message, "ghost");

      const noThread = yield* run("houston_workspace_add_thread", {
        workspaceId,
        threadId: "gone",
      });
      assert.include(noThread.message, "gone");

      const empty = yield* run("houston_workspace_update", { workspaceId });
      assert.include(empty.message, "name, hidden or pinned");
      assert.include(empty.message, workspaceId);

      assert.deepEqual(yield* run("houston_workspace_delete", { workspaceId: DEFAULT }), {
        deleted: true,
      });
      const last = yield* run("houston_workspace_delete", { workspaceId });
      assert.include(last, { kind: "last_workspace" });
      assert.include(last.message, workspaceId);

      const longName = "x".repeat(LIMITS.nameChars + 1);
      const tooLong = yield* run("houston_workspace_update", { workspaceId, name: longName });
      assert.isDefined(tooLong.message);

      const partial = yield* run("houston_workspace_reorder", { workspaceIds: [] });
      assert.include(partial, { kind: "invalid" });
      assert.include(partial.message, workspaceId);

      const notThere = yield* run("houston_workspace_remove_thread", {
        workspaceId,
        threadId: "nobody",
      });
      assert.include(notThere, { kind: "not_found" });
      assert.include(notThere.message, "nobody");
    }),
  ),
);

it.effect("refuses the tab limit with the limit and the value", () =>
  call({}, (run) =>
    Effect.gen(function* () {
      const full = Array.from({ length: LIMITS.tabsPerPane }, (_, n) => chatContent(`full-${n}`));
      yield* seedWorkspace(workspaceRecord("full", [columnOf(full)]));
      const refused = yield* run("houston_workspace_add_thread", {
        workspaceId: "full",
        threadId: "one-more",
      });
      assert.include(refused, { kind: "limit", limit: LIMITS.tabsPerPane });
      assert.include(refused.message, String(LIMITS.tabsPerPane));
      assert.include(refused.message, String(LIMITS.tabsPerPane + 1));
    }),
  ),
);

it.effect("refuses the workspace limit when creating one more", () =>
  call({}, (run) =>
    Effect.gen(function* () {
      for (let n = 0; n < LIMITS.workspaces - 1; n += 1) {
        yield* seedWorkspace(workspaceRecord(`w-${n}`, [], { position: n }));
      }
      const refused = yield* run("houston_workspace_create", {});
      assert.include(refused, {
        kind: "limit",
        limit: LIMITS.workspaces,
        actual: LIMITS.workspaces,
      });
      assert.include(refused.message, String(LIMITS.workspaces));
    }),
  ),
);

it.effect(
  "lists workspaces from outside a thread, with titles null for threads it cannot read",
  () =>
    call({ noThread: true, client: "full-access" }, (run) =>
      Effect.gen(function* () {
        titles.clear();
        yield* seedWorkspace(workspaceRecord("w", [columnOf([chatContent("archived")])]));
        const listed = (yield* run("houston_workspace_list", {})).workspaces;
        const held = listed.find(
          (workspace: { workspaceId: string }) => workspace.workspaceId === "w",
        );
        assert.deepEqual(held.threads, [{ threadId: "archived", title: null, status: null }]);
      }),
    ),
);

it.effect("refuses a client approved for read-only access every change but allows reading", () =>
  call({ client: "read-only", noThread: true }, (run) =>
    Effect.gen(function* () {
      assert.equal((yield* run("houston_workspace_list", {})).workspaces.length, 1);
      for (const [name, input] of [
        ["houston_workspace_create", {}],
        ["houston_workspace_update", { workspaceId: "w", name: "x" }],
        ["houston_workspace_reorder", { workspaceIds: [] }],
        ["houston_workspace_delete", { workspaceId: "w" }],
        ["houston_workspace_add_thread", { workspaceId: "w", threadId: "t" }],
        ["houston_workspace_remove_thread", { workspaceId: "w", threadId: "t" }],
      ] as const) {
        assert.equal((yield* run(name, input)).code, "capability_denied", name);
      }
    }),
  ),
);

it.effect("refuses a credential that cannot control threads, for reads and changes", () =>
  call({ capabilities: ["worktree"] }, (run) =>
    Effect.gen(function* () {
      for (const [name, input] of [
        ["houston_workspace_list", {}],
        ["houston_workspace_create", {}],
        ["houston_workspace_delete", { workspaceId: "w" }],
      ] as const) {
        assert.equal((yield* run(name, input)).code, "capability_denied", name);
      }
    }),
  ),
);

it.effect("refuses a change from a thread whose turn has ended", () =>
  call({ activeRunId: null }, (run) =>
    Effect.gen(function* () {
      assert.equal((yield* run("houston_workspace_create", {})).code, "parent_not_active");
      assert.equal((yield* run("houston_workspace_list", {})).workspaces.length, 1);
    }),
  ),
);

it.effect("does not touch the workspace service for a refused caller", () =>
  Effect.gen(function* () {
    const calls: string[] = [];
    const layer = McpToolAccess.HandlersLayer.layer(WorkspaceHandlers.layer).pipe(
      Layer.provideMerge(
        Layer.mergeAll(
          Layer.succeed(McpInvocationContext.McpInvocationContext, {
            environmentId: EnvironmentId.make(WORKSPACE_TEST_ENVIRONMENT),
            requestNamespace: "provider:workspace-tools",
            thread: undefined,
            client: { sessionId: "c", label: "Client", access: "read-only" },
            capabilities: new Set(["orchestration" as const]),
            issuedAt: 0,
          }),
          Layer.mock(ThreadManagement.ThreadManagementService)({}),
          NodeCrypto.layer,
          Layer.mock(HoustonLayoutWorkspaces.HoustonLayoutWorkspaceService)({
            delete: () =>
              Effect.sync(() => calls.push("delete")).pipe(Effect.as({ deleted: true })),
          }),
        ),
      ),
    );
    const toolkit = yield* WorkspaceToolkit.pipe(Effect.provide(layer));
    yield* toolkit
      .handle("houston_workspace_delete", { workspaceId: "w" })
      .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(layer));
    assert.deepEqual(calls, []);
  }),
);
