// The thread tools name a thread's workspace and place the threads create_threads makes.
import { assert, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@houston-app/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as McpInvocationContext from "../../mcp/McpInvocationContext.ts";
import * as McpToolAccess from "../../mcp/McpToolAccess.ts";
import { liveThreadShell } from "../../mcp/McpToolAccess.testkit.ts";
import * as OrchestratorMcpService from "../../mcp/OrchestratorMcpService.ts";
import * as OrchestratorHandlers from "../../mcp/toolkits/orchestrator/handlers.ts";
import { OrchestratorToolkit } from "../../mcp/toolkits/orchestrator/tools.ts";
import * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import * as HoustonLayoutWorkspaces from "../layoutWorkspaces.ts";
import {
  chatContent,
  chatThreadsOf,
  columnOf,
  layerWorkspaces,
  seedWorkspace,
  WORKSPACE_TEST_ENVIRONMENT,
  workspaceRecord,
} from "./workspaceToolkit.testkit.ts";

const CALLER = ThreadId.make("thread:caller");
const PROJECT = "project:mcp-test";

const NOW = "2026-01-01T00:00:00.000Z";
const model = { providerInstanceId: "codex", model: "test-model" };

const createdThread = (threadId: string) => ({
  threadId,
  runId: null,
  status: "idle",
  title: threadId,
  createdBy: "agent",
  creationSource: "mcp",
  ...model,
});

const listItem = (threadId: string) => ({
  threadId,
  projectId: PROJECT,
  title: threadId,
  createdBy: "agent",
  creationSource: "mcp",
  status: "idle",
  latestRunId: null,
  ...model,
  runtimeMode: "approval-required",
  interactionMode: "default",
  linkedPullRequest: null,
  settled: false,
  settledAt: null,
  snoozed: false,
  snoozedUntil: null,
  parentThreadId: null,
  relationshipToParent: null,
  itemCount: 0,
  createdAt: NOW,
  updatedAt: NOW,
});

const detail = (threadId: string) => ({
  ...listItem(threadId),
  activeRunId: null,
  titleRegeneration: null,
  branch: null,
  worktreePath: null,
  runCount: 0,
  pendingRequestCount: 0,
  archived: false,
});

const world = Layer.mergeAll(
  Layer.succeed(McpInvocationContext.McpInvocationContext, {
    environmentId: EnvironmentId.make(WORKSPACE_TEST_ENVIRONMENT),
    requestNamespace: "provider:workspace-tools",
    thread: {
      threadId: CALLER,
      providerSessionId: "provider:workspace-tools",
      providerInstanceId: ProviderInstanceId.make("codex"),
    },
    client: undefined,
    capabilities: new Set(["orchestration" as const]),
    issuedAt: 0,
  }),
  Layer.mock(ThreadManagement.ThreadManagementService)({
    getThreadShell: (threadId) => Effect.succeed(liveThreadShell(threadId)),
  }),
  Layer.mock(OrchestratorMcpService.OrchestratorMcpService)({
    createThreads: (_scope, input) =>
      Effect.succeed({
        threads: input.threads.map((_, index) => createdThread(`made-${index}`)),
      } as never),
    listThreads: () =>
      Effect.succeed({
        projectId: PROJECT,
        currentThreadId: CALLER,
        threads: [listItem("in-workspace"), listItem("loose")],
        nextCursor: null,
        total: 2,
      } as never),
    readThread: () =>
      Effect.succeed({
        thread: detail("in-workspace"),
        recentRuns: [],
        items: [],
        nextPosition: null,
        hasMore: false,
      } as never),
  }),
).pipe(Layer.provideMerge(layerWorkspaces));

const run = (name: string, input: object) =>
  Effect.gen(function* () {
    const toolkit = yield* OrchestratorToolkit;
    const handle = toolkit.handle as unknown as (
      name: string,
      input: object,
    ) => Effect.Effect<Stream.Stream<{ result: unknown }>>;
    return yield* handle(name, input).pipe(
      Stream.unwrap,
      Stream.runCollect,
      Effect.map((results) => results.at(-1)?.result as any),
    );
  });

const provided = Layer.provideMerge(
  McpToolAccess.HandlersLayer.layer(OrchestratorHandlers.layer),
  world,
);

const listWorkspaces = Effect.gen(function* () {
  return yield* (yield* HoustonLayoutWorkspaces.HoustonLayoutWorkspaceService).list;
});

it.effect("reads and lists a thread with the workspace it is in, or null", () =>
  Effect.gen(function* () {
    const workspace = yield* seedWorkspace(
      workspaceRecord("review", [columnOf([chatContent("in-workspace")])]),
    );
    const listed = yield* run("houston_thread_list", {});
    assert.deepEqual(
      listed.threads.map((thread: any) => [thread.threadId, thread.workspaceId, thread.gridId]),
      [
        ["in-workspace", workspace.id, workspace.id],
        ["loose", null, null],
      ],
    );
    const read = yield* run("houston_thread_read", { threadId: "in-workspace" });
    assert.equal(read.thread.workspaceId, workspace.id);
    assert.equal(read.thread.gridId, workspace.id);
  }).pipe(Effect.provide(provided)),
);

it.effect("places every thread create_threads makes in one new workspace, and reports each", () =>
  Effect.gen(function* () {
    const result = yield* run("create_threads", {
      threads: [
        { prompt: "a", target: {} },
        { prompt: "b", target: {} },
      ],
      workspace: { newWorkspaceName: "Batch" },
    });
    // The new workspace joins the default one every database starts with.
    const listed = yield* listWorkspaces;
    assert.equal(listed.length, 2);
    const batch = listed.find((workspace) => workspace.name === "Batch")!;
    assert.deepEqual(chatThreadsOf(batch), ["made-0", "made-1"]);
    assert.deepEqual(
      result.threads.map((thread: any) => thread.workspace),
      [
        { placed: true, workspaceId: batch.id },
        { placed: true, workspaceId: batch.id },
      ],
    );
    assert.deepEqual(
      result.threads.map((thread: any) => thread.grid),
      [
        { placed: true, gridId: batch.id },
        { placed: true, gridId: batch.id },
      ],
    );
  }).pipe(Effect.provide(provided)),
);

it.effect("accepts the old grid field names as aliases of the workspace target", () =>
  Effect.gen(function* () {
    const named = yield* run("create_threads", {
      threads: [{ prompt: "a", target: {} }],
      grid: { newGridName: "Old name" },
    });
    const created = (yield* listWorkspaces).find((workspace) => workspace.name === "Old name")!;
    assert.deepEqual(named.threads[0].workspace, { placed: true, workspaceId: created.id });

    const existing = yield* run("create_threads", {
      threads: [{ prompt: "b", target: {} }],
      grid: { gridId: created.id },
    });
    assert.deepEqual(existing.threads[0].grid, { placed: true, gridId: created.id });
    const after = (yield* listWorkspaces).find((workspace) => workspace.id === created.id)!;
    assert.deepEqual(chatThreadsOf(after), ["made-0"]);
  }).pipe(Effect.provide(provided)),
);

it.effect("keeps a created thread and says why the workspace refused it", () =>
  Effect.gen(function* () {
    const result = yield* run("create_threads", {
      threads: [{ prompt: "a", target: {} }],
      workspace: { workspaceId: "ghost" },
    });
    assert.equal(result.threads[0].threadId, "made-0");
    assert.include(result.threads[0].workspace, { placed: false });
    assert.include(result.threads[0].workspace.error, "ghost");
    assert.include(result.threads[0].grid.error, "ghost");
  }).pipe(Effect.provide(provided)),
);

it.effect(
  "a replayed create_threads neither moves a placed thread nor makes a second workspace",
  () =>
    Effect.gen(function* () {
      const input = {
        threads: [{ prompt: "a", target: {} }],
        workspace: { newWorkspaceName: "Once" },
        clientRequestId: "same",
      };
      yield* run("create_threads", input);
      const replay = yield* run("create_threads", input);
      const named = (yield* listWorkspaces).filter((workspace) => workspace.name === "Once");
      assert.equal(named.length, 1);
      assert.deepEqual(replay.threads[0].workspace, { placed: true, workspaceId: named[0]?.id });
    }).pipe(Effect.provide(provided)),
);

it.effect("a replay does not move a thread that has since been placed in another workspace", () =>
  Effect.gen(function* () {
    const first = yield* seedWorkspace(
      workspaceRecord("first", [columnOf([chatContent("made-0")])]),
    );
    yield* seedWorkspace(workspaceRecord("second", [], { position: 1 }));
    const replay = yield* run("create_threads", {
      threads: [{ prompt: "a", target: {} }],
      workspace: { workspaceId: "second" },
      clientRequestId: "same",
    });
    assert.deepEqual(replay.threads[0].workspace, { placed: true, workspaceId: first.id });
    const second = (yield* listWorkspaces).find((workspace) => workspace.id === "second")!;
    assert.deepEqual(chatThreadsOf(second), []);
  }).pipe(Effect.provide(provided)),
);
