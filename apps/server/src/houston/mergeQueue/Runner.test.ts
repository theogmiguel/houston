// @effect-diagnostics nodeBuiltinImport:off - reads the sources and the commands' marker files.
// The runner's passes over real git and the GitHub fake: the line, the one slot, the pause and
// the Merge when verified policy.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { assert, describe, it } from "@effect/vitest";
import type { ProjectId } from "@t3tools/contracts";
import type { HoustonMergeQueueError } from "@t3tools/contracts/houston/mergeQueue";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";

import { HoustonBuildSlot } from "./BuildSlot.ts";
import {
  entryOf,
  layerMergeQueueTest,
  makeGitHub,
  makeGitLog,
  makeRepos,
  mergesOf,
  pushBranch,
  pushesOf,
  queueScenario,
  remoteHead,
  type FakeGitHub,
  type GitLog,
} from "./mergeQueue.testkit.ts";
import { HoustonMergeQueueReader } from "./Reader.ts";
import { HoustonMergeQueueRunner } from "./Runner.ts";
import { HoustonMergeQueueService } from "./Service.ts";
import { HoustonMergeQueueStore } from "./Store.ts";

const realSleep = (ms: number) => Effect.sleep(`${ms} millis`);
const quoted = (path: string) => `"${path}"`;
const WINDOWS = process.platform === "win32";
/** A command that leaves `marker` behind, then waits until `release` exists. */
const blockUntil = (marker: string, release: string, exit = 0) =>
  WINDOWS
    ? `echo started> ${quoted(marker)} && powershell -NoProfile -Command "while (-not (Test-Path '${release}')) { Start-Sleep -Milliseconds 50 }; exit ${exit}"`
    : `echo started > ${quoted(marker)}; while [ ! -e ${quoted(release)} ]; do sleep 0.05; done; exit ${exit}`;

const withQueue = <A, E>(
  github: FakeGitHub,
  body: Effect.Effect<A, E, Layer.Success<ReturnType<typeof layerMergeQueueTest>>>,
  gitLog: GitLog = makeGitLog(),
) => body.pipe(Effect.provide(Layer.fresh(layerMergeQueueTest({ github, gitLog, loops: false }))));

const merged = (github: FakeGitHub) =>
  mergesOf(github).map((request) => Number(/pulls\/(\d+)\/merge/.exec(request.path)![1]));

describe("an unresolved review thread lets the next entry merge and goes first once resolved", () => {
  it.live(
    "an unresolved review thread lets the next entry merge and goes first once resolved",
    () => {
      const github = makeGitHub(makeRepos());
      return withQueue(
        github,
        Effect.gen(function* () {
          const queue = yield* HoustonMergeQueueService;
          const runner = yield* HoustonMergeQueueRunner;
          const reader = yield* HoustonMergeQueueReader;
          const projectId = yield* queueScenario(github, [1, 2], {
            command: "git --version",
            mergeWhenVerified: true,
          });
          github.pulls.get(1)!.unresolvedThreads = 1;
          yield* reader.readProject(projectId);
          const blocked = yield* queue.get({ projectId });
          assert.deepEqual(
            { position: entryOf(blocked, 1).position, status: entryOf(blocked, 1).status },
            { position: 1, status: "blocked" },
          );
          assert.strictEqual(entryOf(blocked, 2).status, "waitingForSlot");

          yield* runner.pass;
          assert.deepEqual(merged(github), [2]);
          const after = yield* queue.get({ projectId });
          assert.deepEqual(
            after.entries.map((entry) => [entry.number, entry.position, entry.status]),
            [[1, 1, "blocked"]],
          );

          github.pulls.get(1)!.unresolvedThreads = 0;
          yield* reader.readProject(projectId);
          yield* runner.pass;
          assert.deepEqual(merged(github), [2, 1]);
          assert.deepEqual((yield* queue.get({ projectId })).entries, []);
        }),
      );
    },
  );
});

describe("one slot serialises verification across projects", () => {
  it.live("one slot serialises verification across projects", () => {
    const first = makeGitHub(makeRepos("houston-mq-a-", "o/a"));
    const second = makeGitHub(makeRepos("houston-mq-b-", "o/b"));
    return Effect.gen(function* () {
      const queue = yield* HoustonMergeQueueService;
      const runner = yield* HoustonMergeQueueRunner;
      const slot = yield* HoustonBuildSlot;
      const startedA = NodePath.join(first.repos!.root, "a-started");
      const releaseA = NodePath.join(first.repos!.root, "a-release");
      const startedB = NodePath.join(second.repos!.root, "b-started");
      const projectA = yield* queueScenario(first, [1], {
        name: "a",
        command: blockUntil(startedA, releaseA, 1),
      });
      const projectB = yield* queueScenario(second, [1], {
        name: "b",
        command: `echo started > ${quoted(startedB)}`,
      });
      const fiber = yield* runner.step(projectA).pipe(Effect.forkChild);
      for (let waited = 0; waited < 400 && !NodeFS.existsSync(startedA); waited += 1) {
        yield* realSleep(25);
      }
      assert.isTrue(NodeFS.existsSync(startedA));
      const holder = yield* slot.holder;
      assert.include(holder, projectA);
      assert.include(holder, "#1");
      assert.strictEqual(entryOf(yield* queue.get({ projectId: projectA }), 1).status, "verifying");

      // B's step finds the slot taken: it waits and its command has not started.
      yield* runner.step(projectB);
      assert.strictEqual(
        entryOf(yield* queue.get({ projectId: projectB }), 1).status,
        "waitingForSlot",
      );
      assert.isFalse(NodeFS.existsSync(startedB));

      // A's command fails; the slot frees and B verifies on its next step.
      NodeFS.writeFileSync(releaseA, "go");
      yield* Fiber.join(fiber);
      assert.isNull(yield* slot.holder);
      assert.strictEqual(entryOf(yield* queue.get({ projectId: projectA }), 1).status, "parked");
      yield* runner.step(projectB);
      assert.isTrue(NodeFS.existsSync(startedB));
      const b = entryOf(yield* queue.get({ projectId: projectB }), 1);
      assert.isNotNull(b.verification);
      assert.strictEqual(b.status, "ready");
    }).pipe(
      Effect.provide(Layer.fresh(layerMergeQueueTest({ github: [first, second], loops: false }))),
    );
  });
});

describe("a parked entry re-enters when its head moves", () => {
  it.live("a parked entry re-enters when its head moves", () => {
    const github = makeGitHub(makeRepos());
    return withQueue(
      github,
      Effect.gen(function* () {
        const queue = yield* HoustonMergeQueueService;
        const runner = yield* HoustonMergeQueueRunner;
        const reader = yield* HoustonMergeQueueReader;
        const projectId = yield* queueScenario(github, [7], { command: "exit 1" });
        yield* runner.pass;
        const parked = entryOf(yield* queue.get({ projectId }), 7);
        assert.deepEqual([parked.position, parked.status], [0, "parked"]);
        assert.strictEqual(parked.failure?.kind, "failed");

        pushBranch(github.repos!, "houston/7", { "fix.txt": "fixed\n" });
        yield* reader.readProject(projectId);
        const back = entryOf(yield* queue.get({ projectId }), 7);
        assert.deepEqual([back.position, back.status], [1, "waitingForSlot"]);
        assert.isNull(back.failure);
      }),
    );
  });
});

describe("a pause stops verification, push and merge and keeps the entry in line", () => {
  for (const scope of ["project", "global"] as const) {
    it.live(
      `a pause stops verification, push and merge and keeps the entry in line: ${scope}`,
      () => {
        const github = makeGitHub(makeRepos());
        const gitLog = makeGitLog();
        return withQueue(
          github,
          Effect.gen(function* () {
            const queue = yield* HoustonMergeQueueService;
            const runner = yield* HoustonMergeQueueRunner;
            const store = yield* HoustonMergeQueueStore;
            const marker = NodePath.join(github.repos!.root, "verified-2");
            const projectId = yield* queueScenario(github, [1, 2], {
              command: `git rev-parse HEAD >> ${quoted(marker)}`,
            });
            // #1 verifies while the queue runs; the policy is off, so it waits for Merge.
            yield* runner.step(projectId);
            const verified = entryOf(yield* queue.get({ projectId }), 1);
            assert.isNotNull(verified.verification);
            const lines = () =>
              NodeFS.existsSync(marker)
                ? NodeFS.readFileSync(marker, "utf8").trim().split("\n").length
                : 0;
            const ranBefore = lines();

            const pause = (paused: boolean) =>
              queue.pause(scope === "project" ? { projectId, paused } : { paused });
            const paused = yield* pause(true);
            assert.include(paused.message, "paused");
            yield* queue.setSettings({
              projectId,
              mergeWhenVerified: true,
              verificationCommand: `git rev-parse HEAD >> ${quoted(marker)}`,
              timeLimitMinutes: 30,
              expectedRevision: 1,
            });
            // Dequeue #1's verification holder so #2 would need one: no verification starts either.
            const pushesBefore = pushesOf(gitLog).length;
            yield* runner.pass;
            assert.strictEqual(lines(), ranBefore);
            assert.deepEqual(mergesOf(github), []);
            assert.strictEqual(pushesOf(gitLog).length, pushesBefore);
            const refused = (yield* Effect.flip(
              queue.mergeHead({ projectId, number: 1, expectedHeadSha: verified.headSha }),
            )) as HoustonMergeQueueError;
            assert.strictEqual(refused.kind, "paused");
            assert.include(
              refused.message,
              scope === "project"
                ? "the merge queue of scenario is paused"
                : "every merge queue is paused",
            );
            const held = yield* queue.get({ projectId });
            assert.deepEqual(
              held.entries.map((entry) => [entry.number, entry.position]),
              [
                [1, 1],
                [2, 2],
              ],
            );
            assert.strictEqual(entryOf(held, 1).status, "paused");
            assert.deepEqual(entryOf(held, 1).verification, verified.verification);
            assert.deepEqual(
              (yield* store.rows(projectId)).map((row) => row.verification !== null),
              [true, false],
            );

            yield* pause(false);
            yield* runner.pass;
            assert.deepEqual(merged(github).slice(0, 1), [1]);
          }),
          gitLog,
        );
      },
    );
  }
});

describe("merge when verified lands unattended only while on", () => {
  it.live("merge when verified lands unattended only while on", () => {
    const github = makeGitHub(makeRepos());
    const gitLog = makeGitLog();
    return withQueue(
      github,
      Effect.gen(function* () {
        const queue = yield* HoustonMergeQueueService;
        const runner = yield* HoustonMergeQueueRunner;
        const projectId = yield* queueScenario(github, [1], { command: "git --version" });
        yield* runner.pass;
        const ready = entryOf(yield* queue.get({ projectId }), 1);
        assert.strictEqual(ready.status, "ready");
        assert.isNotNull(ready.verification);
        assert.deepEqual(mergesOf(github), []);
        assert.deepEqual(pushesOf(gitLog), []);
        const remoteBefore = remoteHead(github.repos!, "houston/1");
        yield* runner.pass;
        assert.deepEqual(mergesOf(github), []);
        assert.strictEqual(remoteHead(github.repos!, "houston/1"), remoteBefore);

        yield* queue.setSettings({
          projectId,
          mergeWhenVerified: true,
          verificationCommand: "git --version",
          timeLimitMinutes: 30,
        });
        yield* runner.pass;
        assert.deepEqual(merged(github), [1]);
        const log = (yield* queue.get({ projectId })).log;
        const mergeRow = log.find((row) => row.kind === "merge");
        assert.isTrue(mergeRow?.unattended);
        assert.isTrue(log.find((row) => row.kind === "push")?.unattended);
      }),
      gitLog,
    );
  });

  it.live(
    "merge when verified lands unattended only while on: the user's merge is attended",
    () => {
      const github = makeGitHub(makeRepos());
      return withQueue(
        github,
        Effect.gen(function* () {
          const queue = yield* HoustonMergeQueueService;
          const runner = yield* HoustonMergeQueueRunner;
          const projectId = yield* queueScenario(github, [1], { command: "git --version" });
          yield* runner.pass;
          const ready = entryOf(yield* queue.get({ projectId }), 1);
          const result = yield* queue.mergeHead({
            projectId,
            number: 1,
            expectedHeadSha: ready.headSha,
          });
          assert.strictEqual(result.outcome, "merged");
          assert.isFalse(
            (yield* queue.get({ projectId })).log.find((row) => row.kind === "merge")?.unattended,
          );
        }),
      );
    },
  );
});

describe("the server and the harness start one runner and one slot", () => {
  const source = (file: string) =>
    NodeFS.readFileSync(NodePath.join(import.meta.dirname, file), "utf8");

  it.live("the server and the harness start one runner and one slot", () => {
    const server = source("../../server.ts");
    const assemblies = server.match(/layerMergeQueue\(/g) ?? [];
    assert.strictEqual(assemblies.length, 1);
    assert.match(server, /layerMergeQueue\(\s*Layer\.mergeAll\(GitHubRest\.layerWithDependencies,/);
    const layer = source("layer.ts");
    assert.strictEqual((layer.match(/BuildSlot\.layer/g) ?? []).length, 1);
    assert.strictEqual((layer.match(/Runner\.layer/g) ?? []).length, 1);
    assert.strictEqual((layer.match(/Reader\.layer/g) ?? []).length, 1);
    const harness = source("mergeQueue.testkit.ts");
    assert.match(harness, /layerMergeQueue\(\s*Layer\.mergeAll\(layerGitHubRestFake\(github\)/);
    const github = makeGitHub(makeRepos());
    return Effect.gen(function* () {
      const runner = yield* HoustonMergeQueueRunner;
      const reader = yield* HoustonMergeQueueReader;
      yield* realSleep(50);
      assert.strictEqual(yield* runner.loopsStarted, 1);
      assert.strictEqual(yield* reader.loopsStarted, 1);
    }).pipe(Effect.provide(Layer.fresh(layerMergeQueueTest({ github, loops: true }))));
  });
});

describe("the memory floor does not hold an ordinary verification", () => {
  it.live("the memory floor does not hold an ordinary verification", () => {
    const directory = import.meta.dirname;
    for (const file of NodeFS.readdirSync(directory)) {
      if (!file.endsWith(".ts") || file.includes(".test.") || file.includes("testkit")) continue;
      const text = NodeFS.readFileSync(NodePath.join(directory, file), "utf8");
      assert.notMatch(text, /freemem|totalmem|meminfo|HostResources|memoryFloor/, file);
    }
    const github = makeGitHub(makeRepos());
    return withQueue(
      github,
      Effect.gen(function* () {
        const queue = yield* HoustonMergeQueueService;
        const runner = yield* HoustonMergeQueueRunner;
        const projectId: ProjectId = yield* queueScenario(github, [1], {
          command: "git --version",
        });
        yield* runner.pass;
        assert.isNotNull(entryOf(yield* queue.get({ projectId }), 1).verification);
      }),
    );
  });
});
