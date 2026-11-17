import { assert, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@houston-app/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as CommandReceiptStore from "./CommandReceiptStore.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import type * as ProviderAdapter from "@houston-app/provider-core/server/ProviderAdapter";

const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "gpt-5.1-codex" };
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("Runs here never reach a provider"),
} as ProviderAdapter.ProviderAdapterV2["Service"];
const layerDatabase = SqlitePersistence.layerMemory;
const layerTest = ThreadManagementService.layer.pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      layerDatabase,
      ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
      ProviderReplayHarness.layerWithRegistry(
        { name: "delegated-task-project" },
        ProviderAdapterRegistry.layerFromAdapters([adapter]),
        { databaseLayer: layerDatabase, runEffectWorker: false },
      ),
    ),
  ),
  Layer.provideMerge(ServerSettings.layerTest()),
  Layer.provideMerge(CommandReceiptStore.layer.pipe(Layer.provide(layerDatabase))),
);

const parentProjectId = ProjectId.make("project:delegated-parent");
const otherProjectId = ProjectId.make("project:delegated-other");

/** A parent mid-turn in its own worktree of its project. */
const startParent = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`create:${threadId}`),
      threadId,
      projectId: parentProjectId,
      title: threadId,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: "feature/parent",
      worktreePath: "/srv/parent/.worktrees/feature-parent",
      createdBy: "user",
      creationSource: "web",
    });
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make(`send:${threadId}`),
      threadId,
      messageId: MessageId.make(`message:${threadId}`),
      text: "parent",
      attachments: [],
      dispatchMode: { type: "start_immediately" },
      createdBy: "user",
      creationSource: "web",
    });
  });

const delegate = (
  parentThreadId: ThreadId,
  input: {
    readonly projectId?: ProjectId;
    readonly worktreeBase?: string;
  },
) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const parentRun = (yield* orchestrator.getThreadProjection(parentThreadId)).runs.at(-1)!;
    yield* orchestrator.dispatch({
      type: "delegated_task.request",
      commandId: CommandId.make(`delegate:${parentThreadId}`),
      parentThreadId,
      parentRunId: parentRun.id,
      parentNodeId: parentRun.rootNodeId!,
      task: "Work in the requested project.",
      ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      ...(input.worktreeBase === undefined
        ? {}
        : {
            workspaceStrategy: {
              type: "worktree",
              baseRef: input.worktreeBase,
              startFromOrigin: false,
            },
          }),
      createdBy: "agent",
      creationSource: "mcp",
    });
    const parent = yield* orchestrator.getThreadProjection(parentThreadId);
    const childThreadId = parent.subagents[0]!.childThreadId!;
    return yield* orchestrator.getThreadProjection(childThreadId);
  });

it.layer(layerTest)("a delegated task's project", (it) => {
  it.effect("a task without a project runs in the parent's checkout", () =>
    Effect.gen(function* () {
      const parentThreadId = ThreadId.make("thread:delegated-same-project");
      yield* startParent(parentThreadId);
      const child = yield* delegate(parentThreadId, {});
      assert.equal(child.thread.projectId, parentProjectId);
      assert.equal(child.thread.worktreePath, "/srv/parent/.worktrees/feature-parent");
      assert.equal(child.thread.branch, "feature/parent");
    }),
  );

  it.effect("a task in another project runs in that project's checkout", () =>
    Effect.gen(function* () {
      const parentThreadId = ThreadId.make("thread:delegated-other-shared");
      yield* startParent(parentThreadId);
      const child = yield* delegate(parentThreadId, { projectId: otherProjectId });
      assert.equal(child.thread.projectId, otherProjectId);
      assert.isNull(child.thread.worktreePath);
      assert.isNull(child.thread.branch);
      assert.equal(child.thread.lineage.parentThreadId, parentThreadId);
    }),
  );

  it.effect("a worktree task in another project prepares its checkout there", () =>
    Effect.gen(function* () {
      const parentThreadId = ThreadId.make("thread:delegated-other-worktree");
      yield* startParent(parentThreadId);
      const child = yield* delegate(parentThreadId, {
        projectId: otherProjectId,
        worktreeBase: "head-of-other",
      });
      assert.equal(child.thread.projectId, otherProjectId);
      assert.isNull(child.thread.worktreePath);
      assert.deepEqual(child.runs[0]?.workspacePreparation, {
        type: "worktree",
        baseRef: "head-of-other",
        startFromOrigin: false,
      });
    }),
  );
});
