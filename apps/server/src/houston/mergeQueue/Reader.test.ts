// The reader's cadence on the test clock: each queued pull request once a minute, and an entry
// GitHub reports merged or closed leaves the queue.
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as TestClock from "effect/testing/TestClock";

import {
  createProject,
  layerMergeQueueTest,
  makeGitHub,
  makeRepos,
  openPull,
  pushBranch,
  remoteHead,
} from "./mergeQueue.testkit.ts";
import { HoustonMergeQueueReader } from "./Reader.ts";
import { HoustonMergeQueueService } from "./Service.ts";
import { HoustonMergeQueueStore } from "./Store.ts";

// Real time while the test clock holds the reader's minute.
const realSleep = (ms: number) => TestClock.withLive(Effect.sleep(`${ms} millis`));

describe("queued pull requests are re-read each minute and leave when merged or closed", () => {
  it.effect("queued pull requests are re-read each minute and leave when merged or closed", () => {
    const repos = makeRepos();
    const github = makeGitHub(repos);
    return Effect.gen(function* () {
      const queue = yield* HoustonMergeQueueService;
      const store = yield* HoustonMergeQueueStore;
      const reader = yield* HoustonMergeQueueReader;
      for (const number of [12, 13, 14]) {
        pushBranch(repos, `houston/${number}`, { [`f${number}.txt`]: `${number}\n` });
        openPull(github, number);
      }
      const projectId = yield* createProject("reader", repos.checkout);
      const idle = makeRepos("houston-mq-idle-");
      yield* createProject("idle", idle.checkout);
      // The loop's first pass ran at startup on empty queues: nothing was read.
      yield* realSleep(100);
      assert.deepEqual(github.requests, []);
      assert.strictEqual(yield* reader.loopsStarted, 1);

      yield* queue.enqueue({ projectId, pullRequest: 12 });
      yield* queue.enqueue({ projectId, pullRequest: 13, dependsOn: 12 });
      yield* queue.enqueue({ projectId, pullRequest: 14 });
      const events = yield* PubSub.subscribe(store.events);
      const settle = (count: number) =>
        Effect.gen(function* () {
          for (let waited = 0; waited < 200 && github.requests.length < count; waited += 1) {
            yield* realSleep(25);
          }
          yield* realSleep(100);
        });

      // A minute later each queued entry is read once: three reads and three facts queries.
      github.requests.length = 0;
      yield* TestClock.adjust("59 seconds");
      yield* realSleep(100);
      assert.deepEqual(github.requests, []);
      yield* TestClock.adjust("1 second");
      yield* settle(12);
      const read = (requests: typeof github.requests) =>
        requests.map((request) => request.path.replace(/^.*\//, "")).sort();
      assert.strictEqual(github.requests.length, 12);
      assert.deepEqual(
        read(github.requests.filter((request) => request.via === "pullRequestService")),
        ["12", "12", "12", "13", "13", "13", "14", "14", "14"],
      );
      assert.strictEqual(
        github.requests.filter((request) => request.path.endsWith("/graphql")).length,
        3,
      );
      // Nothing changed on GitHub, so nothing was published.
      assert.strictEqual(yield* PubSub.remaining(events), 0);

      // #12 merged and #14 closed outside the queue.
      const head12 = remoteHead(repos, "houston/12")!;
      github.pulls.get(12)!.state = "merged";
      github.pulls.get(14)!.state = "closed";
      github.requests.length = 0;
      yield* TestClock.adjust("60 seconds");
      yield* settle(12);
      const rows = yield* store.rows(projectId);
      assert.deepEqual(
        rows.map((row) => row.number),
        [13],
      );
      assert.isNull(rows[0]!.dependsOn);
      assert.deepEqual(rows[0]!.stacked, {
        number: 12,
        headSha: head12,
        headRef: "houston/12",
        baseRef: "main",
      });
      assert.isAbove(yield* PubSub.remaining(events), 0);

      // The idle project's queue was never read.
      assert.isTrue(
        github.requests.every(
          (request) => /\/(12|13|14)$/.test(request.path) || request.path.endsWith("/graphql"),
        ),
      );
    }).pipe(
      Effect.scoped,
      Effect.provide(Layer.fresh(layerMergeQueueTest({ github, loops: true }))),
    );
  });
});
