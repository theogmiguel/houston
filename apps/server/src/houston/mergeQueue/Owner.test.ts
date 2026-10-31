// @effect-diagnostics nodeBuiltinImport:off - reads the merge queue's sources for the launch scan.
// Owners: a failure reaches the owner thread once as a queued message, an entry without one
// parks, Hand to a new thread is the only launch, and a base move tells owners on that base.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { assert, describe, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  ProjectId,
  ThreadId,
  type OrchestrationV2Command,
} from "@t3tools/contracts";
import type { HoustonMergeQueueError } from "@t3tools/contracts/houston/mergeQueue";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerConfig from "../../config.ts";
import * as Orchestrator from "../../orchestration-v2/Orchestrator.ts";
import * as ThreadLaunchService from "../../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import { CODEX, makeHarness, runWith } from "../sideThreads.testkit.ts";
import {
  entryOf,
  layerMergeQueueTest,
  makeGitHub,
  makeRepos,
  makeThreads,
  pushBranch,
  queueScenario,
  remoteHead,
  selection,
  thread,
  type FakeGitHub,
  type FakeThreads,
} from "./mergeQueue.testkit.ts";
import { HoustonMergeQueueReader } from "./Reader.ts";
import { HoustonMergeQueueRunner } from "./Runner.ts";
import { failureNote } from "./rules.ts";
import { HoustonMergeQueueService } from "./Service.ts";
import { HoustonMergeQueueThreads, layer as layerThreads } from "./Threads.ts";

const withQueue = <A, E>(
  github: FakeGitHub,
  threads: FakeThreads,
  body: Effect.Effect<A, E, Layer.Success<ReturnType<typeof layerMergeQueueTest>>>,
) => body.pipe(Effect.provide(Layer.fresh(layerMergeQueueTest({ github, threads, loops: false }))));

const refusal = <A, R>(effect: Effect.Effect<A, HoustonMergeQueueError, R>) => Effect.flip(effect);

const PROJECT = "project-owner";

/** #7's branch and main both edit README.md, so #7's verification stops on a conflict. */
const conflicting = (github: FakeGitHub, projectId: ProjectId) =>
  Effect.gen(function* () {
    pushBranch(github.repos!, "houston/7", { "README.md": "head\n" });
    pushBranch(github.repos!, "main", { "README.md": "main\n" });
    const reader = yield* HoustonMergeQueueReader;
    yield* reader.readProject(projectId);
  });

describe("a failure goes to the owner thread once and parks without one", () => {
  it.live("a failure goes to the owner thread once and parks without one: the enqueuer", () => {
    const github = makeGitHub(makeRepos());
    const threads = makeThreads([thread("thread-T", PROJECT)]);
    return withQueue(
      github,
      threads,
      Effect.gen(function* () {
        const queue = yield* HoustonMergeQueueService;
        const runner = yield* HoustonMergeQueueRunner;
        const projectId = yield* queueScenario(github, [7, 8], {
          name: "owner",
          command: "git --version",
          owners: { 7: "thread-T" },
          mainMoves: false,
        });
        yield* conflicting(github, projectId);
        yield* runner.step(projectId);
        const snapshot = yield* queue.get({ projectId });
        const fixing = entryOf(snapshot, 7);
        assert.strictEqual(fixing.status, "fixing", JSON.stringify(fixing));
        assert.strictEqual(fixing.failure?.kind, "conflict");
        assert.strictEqual(fixing.failure?.notifiedThreadId, "thread-T");
        assert.deepEqual(threads.notes, [
          {
            threadId: "thread-T",
            messageId: `message:merge-queue:${projectId}:7:${fixing.headSha}:conflict`,
            text: failureNote({
              number: 7,
              url: fixing.url,
              title: fixing.title,
              headRef: "houston/7",
              failure: fixing.failure!,
            }),
          },
        ]);
        assert.deepEqual(
          snapshot.log.filter((row) => row.kind === "park"),
          [],
        );
        assert.deepEqual(threads.launched, []);
        // The queue moved on to #8.
        assert.isNotNull(entryOf(snapshot, 8).verification);

        // The same head failing the same way again sends nothing.
        yield* queue.retry({ projectId, number: 7 });
        yield* runner.step(projectId);
        const again = entryOf(yield* queue.get({ projectId }), 7);
        assert.strictEqual(again.status, "fixing");
        assert.strictEqual(threads.notes.length, 1);
      }),
    );
  });

  it.live("a failure goes to the owner thread once and parks without one: no owner", () => {
    const github = makeGitHub(makeRepos());
    const threads = makeThreads([
      thread("thread-T", PROJECT, { archived: true }),
      // A thread of another project on the same branch is no owner.
      thread("thread-elsewhere", "project-other", { branch: "houston/7", worktreePath: "/w/7" }),
    ]);
    return withQueue(
      github,
      threads,
      Effect.gen(function* () {
        const queue = yield* HoustonMergeQueueService;
        const runner = yield* HoustonMergeQueueRunner;
        const projectId = yield* queueScenario(github, [7, 8], {
          name: "owner",
          command: "git --version",
          owners: { 7: "thread-T" },
          mainMoves: false,
        });
        yield* conflicting(github, projectId);
        yield* runner.step(projectId);
        const snapshot = yield* queue.get({ projectId });
        const parked = entryOf(snapshot, 7);
        assert.strictEqual(parked.status, "parked", JSON.stringify(parked));
        assert.isNull(parked.failure?.notifiedThreadId);
        const parks = snapshot.log.filter((row) => row.kind === "park");
        assert.deepEqual(
          parks.map((row) => row.number),
          [7],
        );
        assert.deepEqual(threads.notes, []);
        assert.deepEqual(threads.launched, []);
        assert.isNotNull(entryOf(snapshot, 8).verification);
      }),
    );
  });

  it.live(
    "a failure goes to the owner thread once and parks without one: a thread on the head branch",
    () => {
      const github = makeGitHub(makeRepos());
      const threads = makeThreads([
        thread("thread-archived", PROJECT, {
          branch: "houston/7",
          worktreePath: "/w/a",
          archived: true,
        }),
        thread("thread-U", PROJECT, { branch: "houston/7", worktreePath: "/w/u" }),
        thread("thread-other-branch", PROJECT, { branch: "houston/8", worktreePath: "/w/8" }),
      ]);
      return withQueue(
        github,
        threads,
        Effect.gen(function* () {
          const queue = yield* HoustonMergeQueueService;
          const runner = yield* HoustonMergeQueueRunner;
          const projectId = yield* queueScenario(github, [7], {
            name: "owner",
            command: "git --version",
            mainMoves: false,
          });
          yield* conflicting(github, projectId);
          yield* runner.step(projectId);
          const fixing = entryOf(yield* queue.get({ projectId }), 7);
          assert.strictEqual(fixing.status, "fixing", JSON.stringify(fixing));
          assert.deepEqual(
            threads.notes.map((note) => note.threadId),
            ["thread-U"],
          );
        }),
      );
    },
  );

  it.effect("a failure goes to the owner thread once and parks without one: the command", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness("merge-queue-notify", [CODEX]);
        yield* runWith(harness, (context) =>
          Effect.gen(function* () {
            const owner = yield* context.createThread({ threadId: "owner", driver: "codex" });
            const notify = (commandId: string, messageId: string, text: string) =>
              context.dispatch({
                type: "houston.merge-queue.notify",
                commandId: CommandId.make(commandId),
                threadId: owner,
                messageId: MessageId.make(messageId),
                text,
              } as OrchestrationV2Command);
            const started = () =>
              harness.log.started
                .filter((turn) => turn.input.threadId === owner)
                .map((turn) => String(turn.input.message.messageId));

            // An idle owner starts a turn on the note.
            yield* notify("note:1", "message:merge-queue:p:7:a:conflict", "PR #7 failed");
            yield* context.settle;
            assert.deepEqual(started(), ["message:merge-queue:p:7:a:conflict"]);
            const projection = yield* context.orchestrator.getThreadProjection(owner);
            const message = projection.messages.find(
              (value) => value.id === "message:merge-queue:p:7:a:conflict",
            );
            assert.strictEqual(message?.role, "user");
            assert.strictEqual(message?.text, "PR #7 failed");

            // The same note again adds nothing, by a new command or a replayed one.
            yield* notify("note:1", "message:merge-queue:p:7:a:conflict", "PR #7 failed");
            const twice = yield* Effect.flip(
              notify("note:2", "message:merge-queue:p:7:a:conflict", "PR #7 failed"),
            );
            assert.isDefined(twice);
            yield* context.settle;
            assert.deepEqual(started(), ["message:merge-queue:p:7:a:conflict"]);

            // While a turn runs, the note queues behind it instead of interrupting it.
            harness.script.hold.add("message:busy");
            yield* context.send(owner, "message:busy", "keep working");
            yield* context.settle;
            yield* notify("note:3", "message:merge-queue:p:7:b:failed", "PR #7 failed again");
            yield* context.settle;
            assert.deepEqual(started(), ["message:merge-queue:p:7:a:conflict", "message:busy"]);
            assert.deepEqual(harness.log.interrupted, []);
            yield* harness.release("message:busy");
            yield* context.settle;
            assert.deepEqual(started(), [
              "message:merge-queue:p:7:a:conflict",
              "message:busy",
              "message:merge-queue:p:7:b:failed",
            ]);
          }),
        );
      }),
    ),
  );

  it.effect("a failure goes to the owner thread once and parks without one: the adapter", () => {
    const dispatched: Array<OrchestrationV2Command> = [];
    const adapter = layerThreads.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(Orchestrator.OrchestratorV2)({
            dispatch: (command: OrchestrationV2Command) =>
              Effect.sync(() => {
                dispatched.push(command);
                return { sequence: 1, storedEvents: [] };
              }),
          } as never),
          Layer.mock(ThreadManagement.ThreadManagementService)({
            listProjectThreads: () =>
              Effect.succeed([
                {
                  id: ThreadId.make("thread-a"),
                  projectId: ProjectId.make(PROJECT),
                  branch: "houston/7",
                  worktreePath: "/w/7",
                  archivedAt: null,
                },
                {
                  id: ThreadId.make("thread-b"),
                  projectId: ProjectId.make(PROJECT),
                  branch: null,
                  worktreePath: null,
                  archivedAt: DateTime.makeUnsafe(0),
                },
              ]),
          } as never),
          Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
        ),
      ),
    );
    return Effect.gen(function* () {
      const threads = yield* HoustonMergeQueueThreads;
      assert.deepEqual(yield* threads.list(ProjectId.make(PROJECT)), [
        {
          id: "thread-a",
          projectId: PROJECT,
          branch: "houston/7",
          worktreePath: "/w/7",
          archived: false,
        },
        { id: "thread-b", projectId: PROJECT, branch: null, worktreePath: null, archived: true },
      ]);
      yield* threads.notify({
        threadId: "thread-a",
        messageId: "message:merge-queue:x",
        text: "t",
      });
      assert.deepEqual(dispatched, [
        {
          type: "houston.merge-queue.notify",
          commandId: CommandId.make("houston-merge-queue:message:merge-queue:x"),
          threadId: ThreadId.make("thread-a"),
          messageId: MessageId.make("message:merge-queue:x"),
          text: "t",
        },
      ]);
    }).pipe(Effect.provide(adapter));
  });
});

describe("hand to a new thread launches one thread with the failure", () => {
  it.live("hand to a new thread launches one thread with the failure", () => {
    const github = makeGitHub(makeRepos());
    const threads = makeThreads();
    return withQueue(
      github,
      threads,
      Effect.gen(function* () {
        const queue = yield* HoustonMergeQueueService;
        const runner = yield* HoustonMergeQueueRunner;
        const config = yield* ServerConfig.ServerConfig;
        const projectId = yield* queueScenario(github, [7, 8], {
          name: "owner",
          command: "git --version",
          mainMoves: false,
        });
        yield* conflicting(github, projectId);
        yield* runner.step(projectId);
        const parked = entryOf(yield* queue.get({ projectId }), 7);
        assert.strictEqual(parked.status, "parked");

        const notParked = yield* refusal(
          queue.handToThread({ projectId, number: 8, modelSelection: selection() }),
        );
        assert.strictEqual(notParked.kind, "invalid");
        assert.include(notParked.message, "PR #8");
        assert.deepEqual(threads.launched, []);

        const { threadId } = yield* queue.handToThread({
          projectId,
          number: 7,
          modelSelection: selection(),
        });
        assert.strictEqual(threads.launched.length, 1);
        const launched = threads.launched[0]!;
        assert.strictEqual(launched.threadId, threadId);
        assert.strictEqual(launched.projectId, projectId);
        assert.strictEqual(launched.branch, "houston/7");
        assert.strictEqual(
          launched.worktreePath,
          NodePath.join(config.worktreesDir, "r", "houston-7"),
        );
        assert.deepEqual(launched.modelSelection, selection());
        assert.strictEqual(
          launched.text,
          failureNote({
            number: 7,
            url: parked.url,
            title: parked.title,
            headRef: "houston/7",
            failure: parked.failure!,
          }),
        );
        const fixing = entryOf(yield* queue.get({ projectId }), 7);
        assert.strictEqual(fixing.status, "fixing");
        assert.strictEqual(fixing.failure?.notifiedThreadId, threadId);
        assert.strictEqual(fixing.ownerThreadId, threadId);

        // A launch that fails is named and launches nothing.
        threads.launchFailure = "the provider is not installed";
        const failed = yield* refusal(
          queue.handToThread({ projectId, number: 7, modelSelection: selection() }),
        );
        assert.strictEqual(failed.kind, "remote");
        assert.include(failed.message, "the provider is not installed");
        assert.strictEqual(threads.launched.length, 1);
      }),
    );
  });

  it.live("hand to a new thread launches one thread with the failure: the only launch", () =>
    Effect.sync(() => {
      const directory = import.meta.dirname;
      const sources = NodeFS.readdirSync(directory, { recursive: true })
        .map(String)
        .filter(
          (file) => file.endsWith(".ts") && !file.includes(".test.") && !file.includes("testkit"),
        );
      const launchers = sources.filter((file) =>
        /ThreadLaunchService|\.launch\(/.test(
          NodeFS.readFileSync(NodePath.join(directory, file), "utf8"),
        ),
      );
      assert.deepEqual(launchers.toSorted(), ["Service.ts", "Threads.ts"]);
      const service = NodeFS.readFileSync(NodePath.join(directory, "Service.ts"), "utf8");
      assert.strictEqual(service.match(/\.launch\(/g)?.length, 1);
      assert.notMatch(service, /ThreadLaunchService/);
      const handToThread = service.slice(service.indexOf("const handToThread"));
      assert.match(handToThread.slice(0, handToThread.indexOf("\n  });")), /threads\.launch\(/);
    }),
  );

  it.effect("hand to a new thread launches one thread with the failure: the adapter", () => {
    const launches: Array<ThreadLaunchService.ThreadLaunchInput> = [];
    const adapter = layerThreads.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(Orchestrator.OrchestratorV2)({}),
          Layer.mock(ThreadManagement.ThreadManagementService)({}),
          Layer.mock(ThreadLaunchService.ThreadLaunchService)({
            launch: (input: ThreadLaunchService.ThreadLaunchInput) =>
              Effect.sync(() => {
                launches.push(input);
                return { projection: { runs: [] } };
              }),
          } as never),
        ),
      ),
    );
    return Effect.gen(function* () {
      const threads = yield* HoustonMergeQueueThreads;
      yield* threads.launch({
        projectId: ProjectId.make(PROJECT),
        threadId: "thread-new",
        title: "Fix PR #7",
        modelSelection: selection(),
        branch: "houston/7",
        worktreePath: "/w/7",
        messageId: "message:merge-queue:hand:7",
        text: "the note",
      });
      assert.strictEqual(launches.length, 1);
      assert.deepEqual(launches[0]!.workspaceStrategy, {
        type: "existing_worktree",
        worktreePath: "/w/7",
        branch: "houston/7",
      });
      assert.deepEqual(launches[0]!.initialMessage, {
        messageId: MessageId.make("message:merge-queue:hand:7"),
        text: "the note",
        attachments: [],
      });
      assert.strictEqual(launches[0]!.threadId, "thread-new");
      assert.deepEqual(launches[0]!.modelSelection, selection());
    }).pipe(Effect.provide(adapter));
  });
});

describe("the base-moved notice reaches only owners of entries on that base", () => {
  it.live("the base-moved notice reaches only owners of entries on that base", () => {
    const github = makeGitHub(makeRepos());
    const threads = makeThreads([
      thread("thread-1", PROJECT),
      thread("thread-2", PROJECT),
      thread("thread-3", PROJECT),
      thread("thread-idle", PROJECT, { branch: "houston/9", worktreePath: "/w/9" }),
    ]);
    return withQueue(
      github,
      threads,
      Effect.gen(function* () {
        const queue = yield* HoustonMergeQueueService;
        const projectId = yield* queueScenario(github, [1, 2, 3], {
          name: "owner",
          owners: { 1: "thread-1", 2: "thread-2", 3: "thread-3" },
          bases: { 3: "release" },
          mainMoves: false,
        });
        const head = entryOf(yield* queue.get({ projectId }), 1).headSha;
        const result = yield* queue.mergeHead({ projectId, number: 1, expectedHeadSha: head });
        assert.strictEqual(result.outcome, "merged", result.message);
        const main = remoteHead(github.repos!, "main")!;
        assert.deepEqual(
          threads.notes.map((note) => [note.threadId, note.text]),
          [["thread-2", `The base moved: main@${main.slice(0, 7)} now contains #1`]],
        );
      }),
    );
  });
});
