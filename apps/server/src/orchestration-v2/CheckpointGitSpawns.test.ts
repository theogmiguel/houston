import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CheckpointScopeId,
  EventId,
  MessageId,
  NodeId,
  type OrchestrationV2CheckpointScope,
  type OrchestrationV2DomainEvent,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  RunId,
  ThreadId,
} from "@houston-app/contracts";
import * as IdAllocator from "@houston-app/provider-core/server/IdAllocator";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { ChildProcessSpawner } from "effect/process";
import * as Ref from "effect/Ref";

import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as CheckpointCaptureService from "./CheckpointCaptureService.ts";
import * as CheckpointService from "./CheckpointService.ts";
import * as EventSink from "./EventSink.ts";
import * as ProjectionStore from "./ProjectionStore.ts";

// Each git process costs about 60 ms on Windows; these budgets keep removed spawns out.
const FIRST_TURN_BASELINE_GIT_BUDGET = 11;
const FIRST_TURN_FINALIZE_GIT_BUDGET = 12;
// The snapshot overlaps the provider session open; checking and publishing it stay before the turn.
const FIRST_TURN_PUBLISH_GIT_BUDGET = 2;

const isGitCommand = (command: string) => {
  const name = command.split(/[\\/]/).at(-1)?.toLowerCase();
  return name === "git" || name === "git.exe";
};

const makeLayer = (spawns: Array<ReadonlyArray<string>>) => {
  const layerCountingSpawner = Layer.effect(
    ChildProcessSpawner.ChildProcessSpawner,
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      return ChildProcessSpawner.make((command) => {
        if (command._tag === "StandardCommand" && isGitCommand(command.command)) {
          spawns.push(command.args);
        }
        return spawner.spawn(command);
      });
    }),
  ).pipe(Layer.provide(NodeServices.layer));
  return CheckpointService.layer.pipe(
    Layer.provide(CheckpointStore.layer),
    Layer.provide(VcsDriverRegistry.layer),
    Layer.provideMerge(IdAllocator.layer),
    Layer.provideMerge(VcsProcess.layer),
    Layer.provide(layerCountingSpawner),
    Layer.provideMerge(NodeServices.layer),
  );
};

const git = (cwd: string, args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const process = yield* VcsProcess.VcsProcess;
    yield* process.run({ operation: "test.git", command: "git", args: ["-C", cwd, ...args], cwd });
  });

const makeRepository = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "houston-checkpoint-spawns-" });
  yield* git(cwd, ["init", "-b", "main"]);
  yield* git(cwd, ["config", "user.email", "test@test.com"]);
  yield* git(cwd, ["config", "user.name", "Test"]);
  yield* fileSystem.writeFileString(path.join(cwd, "README.md"), "hello\n");
  yield* git(cwd, ["add", "."]);
  yield* git(cwd, ["commit", "-m", "init"]);
  return cwd;
});

const threadId = ThreadId.make("thread:checkpoint-spawns");
const runId = RunId.make("run:checkpoint-spawns:1");
const rootNodeId = NodeId.make("node:checkpoint-spawns:1");
const scopeId = CheckpointScopeId.make("checkpoint-scope:checkpoint-spawns");
const providerThreadId = ProviderThreadId.make("provider-thread:checkpoint-spawns");
const providerInstanceId = ProviderInstanceId.make("codex");
const driver = ProviderDriverKind.make("codex");
const modelSelection = { instanceId: providerInstanceId, model: "gpt-5.4" } as const;

const seedFirstRun = (cwd: string, now: DateTime.Utc) =>
  Effect.gen(function* () {
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const scope: OrchestrationV2CheckpointScope = {
      id: scopeId,
      threadId,
      runId,
      nodeId: rootNodeId,
      parentScopeId: null,
      providerThreadId,
      kind: "root_run",
      ordinalWithinParent: 0,
      advancesAppRunCount: true,
      cwd,
      createdAt: now,
    };
    const events: ReadonlyArray<OrchestrationV2DomainEvent> = [
      {
        id: EventId.make("event:checkpoint-spawns:thread"),
        type: "thread.created",
        threadId,
        occurredAt: now,
        payload: {
          createdBy: "user",
          creationSource: "web",
          id: threadId,
          projectId: ProjectId.make("project:checkpoint-spawns"),
          title: "Checkpoint spawns",
          providerInstanceId,
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          activeProviderThreadId: null,
          lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
          forkedFrom: null,
          createdAt: now,
          updatedAt: now,
          archivedAt: null,
          settledOverride: null,
          settledAt: null,
          lastVisitedAt: null,
          deletedAt: null,
        },
      },
      {
        id: EventId.make("event:checkpoint-spawns:run"),
        type: "run.updated",
        threadId,
        runId,
        nodeId: rootNodeId,
        providerInstanceId,
        occurredAt: now,
        payload: {
          id: runId,
          threadId,
          ordinal: 1,
          providerInstanceId,
          modelSelection,
          providerThreadId,
          userMessageId: MessageId.make("message:checkpoint-spawns"),
          rootNodeId,
          activeAttemptId: null,
          status: "waiting",
          requestedAt: now,
          startedAt: now,
          completedAt: null,
          checkpointId: null,
          contextHandoffId: null,
        },
      },
      {
        id: EventId.make("event:checkpoint-spawns:node"),
        type: "node.updated",
        threadId,
        runId,
        nodeId: rootNodeId,
        providerInstanceId,
        occurredAt: now,
        payload: {
          id: rootNodeId,
          threadId,
          runId,
          parentNodeId: null,
          rootNodeId,
          kind: "root_turn",
          status: "waiting",
          countsForRun: true,
          providerThreadId,
          providerTurnId: null,
          nativeItemRef: null,
          runtimeRequestId: null,
          checkpointScopeId: scopeId,
          startedAt: now,
          completedAt: null,
        },
      },
      {
        id: EventId.make("event:checkpoint-spawns:provider-thread"),
        type: "provider-thread.updated",
        threadId,
        nodeId: rootNodeId,
        driver,
        providerInstanceId,
        occurredAt: now,
        payload: {
          id: providerThreadId,
          driver,
          providerInstanceId,
          providerSessionId: null,
          appThreadId: threadId,
          ownerNodeId: rootNodeId,
          nativeThreadRef: null,
          nativeConversationHeadRef: null,
          status: "idle",
          firstRunOrdinal: 1,
          lastRunOrdinal: 1,
          handoffIds: [],
          forkedFrom: null,
          createdAt: now,
          updatedAt: now,
        },
      },
      {
        id: EventId.make("event:checkpoint-spawns:scope"),
        type: "checkpoint-scope.created",
        threadId,
        runId,
        nodeId: rootNodeId,
        occurredAt: now,
        payload: scope,
      },
    ];
    yield* Effect.forEach(events, (event) => projections.apply(event), { discard: true });
    return scope;
  });

it.effect("captures a first-turn baseline and finalizes the turn within their git budgets", () =>
  Effect.gen(function* () {
    const spawns: Array<ReadonlyArray<string>> = [];
    const committed = yield* Ref.make<ReadonlyArray<OrchestrationV2DomainEvent>>([]);
    const layerProjections = ProjectionStore.layer.pipe(
      Layer.provideMerge(SqlitePersistence.layerMemory),
    );
    const layerCapture = CheckpointCaptureService.layer.pipe(
      Layer.provide(
        Layer.mock(EventSink.EventSinkV2)({
          commitCommand: (input) =>
            Ref.set(committed, input.events).pipe(
              Effect.as({
                commandId: input.commandId,
                committed: true,
                sequence: 1,
                events: input.events,
                effects: [],
              } as never),
            ),
        }),
      ),
      Layer.provideMerge(makeLayer(spawns)),
      Layer.provideMerge(layerProjections),
    );
    yield* Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const cwd = yield* makeRepository;
      const scope = yield* seedFirstRun(cwd, yield* DateTime.now);
      const checkpoints = yield* CheckpointService.CheckpointServiceV2;
      const capture = yield* CheckpointCaptureService.CheckpointCaptureServiceV2;

      spawns.length = 0;
      yield* checkpoints.captureBaseline({ scope, ordinalWithinScope: 0 });
      const baselineSpawns = spawns.length;

      yield* fileSystem.writeFileString(path.join(cwd, "README.md"), "hello world\n");
      spawns.length = 0;
      yield* capture.execute({ threadId, runId, scopeId });
      const finalizeSpawns = spawns.length;

      const captured = (yield* Ref.get(committed)).flatMap((event) =>
        event.type === "checkpoint.captured" ? [event.payload] : [],
      );
      assert.deepEqual(
        captured.map((checkpoint) => ({
          ordinal: checkpoint.ordinalWithinScope,
          status: checkpoint.status,
          files: checkpoint.files,
        })),
        [
          { ordinal: 0, status: "ready", files: [] },
          {
            ordinal: 1,
            status: "ready",
            files: [{ path: "README.md", kind: "modified", additions: 1, deletions: 1 }],
          },
        ],
      );
      assert.isAtMost(
        baselineSpawns,
        FIRST_TURN_BASELINE_GIT_BUDGET,
        `the baseline started ${baselineSpawns} git processes`,
      );
      assert.isAtMost(
        finalizeSpawns,
        FIRST_TURN_FINALIZE_GIT_BUDGET,
        `finalization started ${finalizeSpawns} git processes`,
      );
    }).pipe(Effect.provide(layerCapture));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("prepares a baseline off the critical path and publishes it like a capture", () =>
  Effect.gen(function* () {
    const spawns: Array<ReadonlyArray<string>> = [];
    yield* Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const cwd = yield* makeRepository;
      yield* fileSystem.writeFileString(path.join(cwd, "draft.txt"), "uncommitted\n");
      const checkpoints = yield* CheckpointService.CheckpointServiceV2;
      const now = yield* DateTime.now;
      const scopeFor = (id: string): OrchestrationV2CheckpointScope => ({
        id: CheckpointScopeId.make(id),
        threadId,
        runId,
        nodeId: rootNodeId,
        parentScopeId: null,
        providerThreadId,
        kind: "root_run",
        ordinalWithinParent: 0,
        advancesAppRunCount: true,
        cwd,
        createdAt: now,
      });
      const refOf = (scope: OrchestrationV2CheckpointScope) =>
        CheckpointService.checkpointRefForScopeOrdinal({
          scopeId: scope.id,
          ordinalWithinScope: 0,
        });
      const resolve = (rev: string) =>
        Effect.gen(function* () {
          const process = yield* VcsProcess.VcsProcess;
          const result = yield* process.run({
            operation: "test.git",
            command: "git",
            args: ["-C", cwd, "rev-parse", "--verify", "--quiet", rev],
            cwd,
            allowNonZeroExit: true,
          });
          return result.exitCode === 0 ? result.stdout.trim() : null;
        });

      const captured = scopeFor("checkpoint-scope:captured");
      yield* checkpoints.captureBaseline({ scope: captured, ordinalWithinScope: 0 });

      const prepared = scopeFor("checkpoint-scope:prepared");
      const publish = yield* checkpoints.prepareBaseline({
        scope: prepared,
        ordinalWithinScope: 0,
      });
      assert.isNull(yield* resolve(yield* refOf(prepared)), "preparing must not publish the ref");
      spawns.length = 0;
      yield* publish;
      assert.isAtMost(
        spawns.length,
        FIRST_TURN_PUBLISH_GIT_BUDGET,
        `publishing started ${spawns.length} git processes`,
      );
      assert.strictEqual(
        yield* resolve(`${yield* refOf(prepared)}^{tree}`),
        yield* resolve(`${yield* refOf(captured)}^{tree}`),
      );

      // A ref created between preparing and publishing is kept, as captureBaseline keeps it.
      const raced = scopeFor("checkpoint-scope:raced");
      const racedPublish = yield* checkpoints.prepareBaseline({
        scope: raced,
        ordinalWithinScope: 0,
      });
      yield* git(cwd, ["update-ref", yield* refOf(raced), "HEAD"]);
      yield* racedPublish;
      assert.strictEqual(yield* resolve(yield* refOf(raced)), yield* resolve("HEAD"));
    }).pipe(Effect.provide(makeLayer(spawns)));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("publishes a prepared baseline with the edits made before publication", () =>
  Effect.gen(function* () {
    const spawns: Array<ReadonlyArray<string>> = [];
    yield* Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const cwd = yield* makeRepository;
      yield* fileSystem.writeFileString(path.join(cwd, "draft.txt"), "uncommitted\n");
      yield* fileSystem.writeFileString(path.join(cwd, "notes.txt"), "notes\n");
      const checkpoints = yield* CheckpointService.CheckpointServiceV2;
      const now = yield* DateTime.now;
      const scopeFor = (id: string): OrchestrationV2CheckpointScope => ({
        id: CheckpointScopeId.make(id),
        threadId,
        runId,
        nodeId: rootNodeId,
        parentScopeId: null,
        providerThreadId,
        kind: "root_run",
        ordinalWithinParent: 0,
        advancesAppRunCount: true,
        cwd,
        createdAt: now,
      });
      const treeOf = (scope: OrchestrationV2CheckpointScope) =>
        Effect.gen(function* () {
          const ref = yield* CheckpointService.checkpointRefForScopeOrdinal({
            scopeId: scope.id,
            ordinalWithinScope: 0,
          });
          const process = yield* VcsProcess.VcsProcess;
          const result = yield* process.run({
            operation: "test.git",
            command: "git",
            args: ["-C", cwd, "ls-tree", "-r", `${ref}^{tree}`],
            cwd,
          });
          return result.stdout;
        });

      // Same size and second as the snapshot, so only a content check sees the edit.
      const prepared = scopeFor("checkpoint-scope:edited");
      const publish = yield* checkpoints.prepareBaseline({
        scope: prepared,
        ordinalWithinScope: 0,
      });
      yield* fileSystem.writeFileString(path.join(cwd, "draft.txt"), "user edit!!\n");
      yield* fileSystem.writeFileString(path.join(cwd, "autosave.txt"), "autosaved\n");
      yield* fileSystem.remove(path.join(cwd, "notes.txt"));
      yield* publish;

      const captured = scopeFor("checkpoint-scope:after-edits");
      yield* checkpoints.captureBaseline({ scope: captured, ordinalWithinScope: 0 });
      const publishedTree = yield* treeOf(prepared);
      assert.strictEqual(publishedTree, yield* treeOf(captured));
      assert.include(publishedTree, "autosave.txt");
      assert.notInclude(publishedTree, "notes.txt");
    }).pipe(Effect.provide(makeLayer(spawns)));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("removes a prepared baseline's scratch index when its turn never publishes", () =>
  Effect.gen(function* () {
    const spawns: Array<ReadonlyArray<string>> = [];
    yield* Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const cwd = yield* makeRepository;
      const checkpoints = yield* CheckpointService.CheckpointServiceV2;
      const now = yield* DateTime.now;
      const scratchIndexes = fileSystem
        .readDirectory(path.join(cwd, ".git"))
        .pipe(
          Effect.map((entries) =>
            entries.filter((entry) => entry.startsWith("houston-checkpoint-index-")),
          ),
        );
      yield* Effect.scoped(
        checkpoints
          .prepareBaseline({
            scope: {
              id: CheckpointScopeId.make("checkpoint-scope:abandoned"),
              threadId,
              runId,
              nodeId: rootNodeId,
              parentScopeId: null,
              providerThreadId,
              kind: "root_run",
              ordinalWithinParent: 0,
              advancesAppRunCount: true,
              cwd,
              createdAt: now,
            },
            ordinalWithinScope: 0,
          })
          .pipe(
            Effect.andThen(scratchIndexes),
            Effect.map((kept) => assert.lengthOf(kept, 1, "publishing checks the kept index")),
          ),
      );
      assert.deepEqual(yield* scratchIndexes, []);
    }).pipe(Effect.provide(makeLayer(spawns)));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
