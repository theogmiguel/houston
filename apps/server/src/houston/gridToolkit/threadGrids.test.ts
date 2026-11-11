// The thread tools name a thread's grid and place the threads create_threads makes.
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
import * as HoustonGrids from "../grids.ts";
import { insertThreadRow, layerGrids } from "./gridToolkit.testkit.ts";

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
    environmentId: EnvironmentId.make("environment-grid-tools"),
    requestNamespace: "provider:grid-tools",
    thread: {
      threadId: CALLER,
      providerSessionId: "provider:grid-tools",
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
        threads: [listItem("in-grid"), listItem("loose")],
        nextCursor: null,
        total: 2,
      } as never),
    readThread: () =>
      Effect.succeed({
        thread: detail("in-grid"),
        recentRuns: [],
        items: [],
        nextPosition: null,
        hasMore: false,
      } as never),
  }),
).pipe(Layer.provideMerge(layerGrids([PROJECT])));

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

it.effect("reads and lists a thread with the grid it is in, or null", () =>
  Effect.gen(function* () {
    yield* insertThreadRow("in-grid", PROJECT);
    const grids = yield* HoustonGrids.HoustonGridService;
    const grid = yield* grids.create({ projectId: PROJECT as never, name: "Review" });
    yield* grids.placeThread({ gridId: grid.id, threadId: "in-grid" });

    const listed = yield* run("houston_thread_list", {});
    assert.deepEqual(
      listed.threads.map((thread: any) => [thread.threadId, thread.gridId]),
      [
        ["in-grid", grid.id],
        ["loose", null],
      ],
    );
    const read = yield* run("houston_thread_read", { threadId: "in-grid" });
    assert.equal(read.thread.gridId, grid.id);
  }).pipe(Effect.provide(provided)),
);

it.effect("places every thread create_threads makes in one new grid, and reports each", () =>
  Effect.gen(function* () {
    const grids = yield* HoustonGrids.HoustonGridService;
    yield* Effect.forEach(["made-0", "made-1"], (id) => insertThreadRow(id, PROJECT));
    const result = yield* run("create_threads", {
      threads: [
        { prompt: "a", target: {} },
        { prompt: "b", target: {} },
      ],
      grid: { newGridName: "Batch" },
    });
    const listed = yield* grids.list({});
    assert.equal(listed.length, 1);
    assert.equal(listed[0]?.name, "Batch");
    assert.deepEqual(
      result.threads.map((thread: any) => thread.grid),
      [
        { placed: true, gridId: listed[0]?.id },
        { placed: true, gridId: listed[0]?.id },
      ],
    );
  }).pipe(Effect.provide(provided)),
);

it.effect("keeps a created thread and says why the grid refused it", () =>
  Effect.gen(function* () {
    const result = yield* run("create_threads", {
      threads: [{ prompt: "a", target: {} }],
      grid: { gridId: "ghost" },
    });
    assert.equal(result.threads[0].threadId, "made-0");
    assert.include(result.threads[0].grid, { placed: false });
    assert.include(result.threads[0].grid.error, "ghost");
  }).pipe(Effect.provide(provided)),
);

it.effect("a replayed create_threads neither moves a placed thread nor makes a second grid", () =>
  Effect.gen(function* () {
    const grids = yield* HoustonGrids.HoustonGridService;
    yield* insertThreadRow("made-0", PROJECT);
    const input = {
      threads: [{ prompt: "a", target: {} }],
      grid: { newGridName: "Once" },
      clientRequestId: "same",
    };
    yield* run("create_threads", input);
    const replay = yield* run("create_threads", input);
    const listed = yield* grids.list({});
    assert.equal(listed.length, 1);
    assert.deepEqual(replay.threads[0].grid, { placed: true, gridId: listed[0]?.id });
  }).pipe(Effect.provide(provided)),
);
