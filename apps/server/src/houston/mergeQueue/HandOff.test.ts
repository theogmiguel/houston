// Hand-off to GitHub's merge queue and auto-merge over real git and the GitHub fake: the mode
// rides on the reads, every hand-off is pinned to the verified commit, and a held entry settles.
import { assert, describe, it } from "@effect/vitest";
import type { HoustonMergeQueueError } from "@t3tools/contracts/houston/mergeQueue";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";

import { HoustonBuildSlot } from "./BuildSlot.ts";
import {
  entryOf,
  githubMerges,
  layerMergeQueueTest,
  makeGitHub,
  makeGitLog,
  makeRepos,
  mergesOf,
  mutationsOf,
  openPull,
  pullNodeId,
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

const withQueue = <A, E>(
  github: FakeGitHub | ReadonlyArray<FakeGitHub>,
  body: Effect.Effect<A, E, Layer.Success<ReturnType<typeof layerMergeQueueTest>>>,
  gitLog: GitLog = makeGitLog(),
) => body.pipe(Effect.provide(Layer.fresh(layerMergeQueueTest({ github, gitLog, loops: false }))));

const refusal = <A, R>(effect: Effect.Effect<A, HoustonMergeQueueError, R>) => Effect.flip(effect);

type ProjectId = Parameters<HoustonMergeQueueService["Service"]["get"]>[0]["projectId"];

/** Verifies #N with the policy off, so it waits as Ready for the user's Merge. */
const verified = (projectId: ProjectId, number: number) =>
  Effect.gen(function* () {
    const queue = yield* HoustonMergeQueueService;
    const runner = yield* HoustonMergeQueueRunner;
    yield* runner.step(projectId);
    const entry = entryOf(yield* queue.get({ projectId }), number);
    assert.isNotNull(entry.verification, JSON.stringify(entry));
    return entry;
  });

/** #7 verified and handed to GitHub by the user's Merge; the held entry. */
const handedOff = (github: FakeGitHub, projectId: ProjectId) =>
  Effect.gen(function* () {
    const queue = yield* HoustonMergeQueueService;
    const entry = yield* verified(projectId, 7);
    const result = yield* queue.mergeHead({ projectId, number: 7, expectedHeadSha: entry.headSha });
    assert.strictEqual(result.outcome, "handedOff", result.message);
    const held = entryOf(yield* queue.get({ projectId }), 7);
    assert.strictEqual(held.status, "watching", JSON.stringify(held));
    return { entry, held, pull: github.pulls.get(7)! };
  });

const factsQueries = (github: FakeGitHub) =>
  github.requests.filter(
    (request) =>
      request.path.endsWith("/graphql") &&
      String((request.body as { query?: unknown }).query).includes("MergeQueueFacts"),
  );

describe("the hand-off rides on the reads, learns from a refusal and survives an older schema", () => {
  it.live(
    "the hand-off rides on the reads, learns from a refusal and survives an older schema: the reads",
    () => {
      const github = makeGitHub(makeRepos());
      github.autoMergeAllowed = true;
      return withQueue(
        github,
        Effect.gen(function* () {
          const queue = yield* HoustonMergeQueueService;
          const reader = yield* HoustonMergeQueueReader;
          const projectId = yield* queueScenario(github, [7]);
          github.requests.length = 0;
          yield* reader.readProject(projectId);
          // One read: upstream's detail, activity and checks, and one facts query; nothing else.
          assert.deepEqual(
            github.requests.map((request) => `${request.method} ${request.path}`).toSorted(),
            ["GET activity/7", "GET checks/7", "GET detail/7", "POST /graphql"],
          );
          assert.strictEqual((yield* queue.get({ projectId })).handOff, "autoMerge");

          github.mergeQueueBases.add("main");
          github.requests.length = 0;
          yield* reader.readProject(projectId);
          assert.strictEqual(factsQueries(github).length, 1);
          assert.strictEqual((yield* queue.get({ projectId })).handOff, "mergeQueue");
        }),
      );
    },
  );

  it.live(
    "the hand-off rides on the reads, learns from a refusal and survives an older schema: the refusal",
    () => {
      const github = makeGitHub(makeRepos());
      // The host hides whether a merge queue applies, and the base requires one.
      github.schemaLacksHandOff = true;
      github.mergeQueueBases.add("main");
      const gitLog = makeGitLog();
      return withQueue(
        github,
        Effect.gen(function* () {
          const queue = yield* HoustonMergeQueueService;
          const projectId = yield* queueScenario(github, [7], { command: "git --version" });
          const entry = yield* verified(projectId, 7);
          const failed = yield* refusal(
            queue.mergeHead({ projectId, number: 7, expectedHeadSha: entry.headSha }),
          );
          assert.include(failed.message, "Changes must be made through the merge queue");
          const snapshot = yield* queue.get({ projectId });
          const refused = entryOf(snapshot, 7);
          assert.strictEqual(refused.failure?.kind, "refused");
          assert.include(refused.failure?.message, "Changes must be made through the merge queue");
          assert.strictEqual(snapshot.handOff, "mergeQueue");

          // The next landing on that base hands off instead of merging.
          yield* queue.retry({ projectId, number: 7 });
          const again = entryOf(yield* queue.get({ projectId }), 7);
          const merges = mergesOf(github).length;
          const result = yield* queue.mergeHead({
            projectId,
            number: 7,
            expectedHeadSha: again.headSha,
          });
          assert.strictEqual(result.outcome, "handedOff", result.message);
          assert.strictEqual(mergesOf(github).length, merges);
          assert.deepEqual(
            mutationsOf(github).map((mutation) => [mutation.name, mutation.variables.oid]),
            [["enqueuePullRequest", again.headSha]],
          );
        }),
        gitLog,
      );
    },
  );

  it.live(
    "the hand-off rides on the reads, learns from a refusal and survives an older schema: an older schema",
    () => {
      const github = makeGitHub(makeRepos());
      github.schemaLacksHandOff = true;
      github.autoMergeAllowed = true;
      return withQueue(
        github,
        Effect.gen(function* () {
          const queue = yield* HoustonMergeQueueService;
          const reader = yield* HoustonMergeQueueReader;
          const projectId = yield* queueScenario(github, [7], { mainMoves: false });
          github.pulls.get(7)!.unresolvedThreads = 1;
          github.requests.length = 0;
          yield* reader.readProject(projectId);
          // Retried once without the hand-off fields; the other facts are kept.
          assert.strictEqual(factsQueries(github).length, 2);
          const read = entryOf(yield* queue.get({ projectId }), 7);
          const gate = (kind: string) => read.gates.find((value) => value.kind === kind);
          assert.strictEqual(gate("mergeable")?.state, "passed", JSON.stringify(read.gates));
          assert.include(gate("reviewThreads")?.reason, "1 unresolved review thread");
          assert.isNull((yield* queue.get({ projectId })).handOff);

          github.pulls.get(7)!.unresolvedThreads = 0;
          yield* reader.readProject(projectId);
          const head = entryOf(yield* queue.get({ projectId }), 7).headSha;
          const result = yield* queue.mergeHead({ projectId, number: 7, expectedHeadSha: head });
          assert.strictEqual(result.outcome, "merged", result.message);
          assert.deepEqual(
            mergesOf(github).map((request) => (request.body as { sha?: string }).sha),
            [head],
          );
          assert.deepEqual(mutationsOf(github), []);
        }),
      );
    },
  );
});

describe("a hand-off is pinned to the verified commit and confirmed", () => {
  it.live("a hand-off is pinned to the verified commit and confirmed: github's merge queue", () => {
    const github = makeGitHub(makeRepos());
    github.mergeQueueBases.add("main");
    github.queuePosition = 2;
    const gitLog = makeGitLog();
    return withQueue(
      github,
      Effect.gen(function* () {
        const queue = yield* HoustonMergeQueueService;
        const projectId = yield* queueScenario(github, [7], { command: "git --version" });
        const entry = yield* verified(projectId, 7);
        github.requests.length = 0;
        const result = yield* queue.mergeHead({
          projectId,
          number: 7,
          expectedHeadSha: entry.headSha,
        });
        assert.strictEqual(result.outcome, "handedOff", result.message);
        // No push: GitHub's merge queue takes the verified head as it is.
        assert.deepEqual(pushesOf(gitLog), []);
        assert.strictEqual(remoteHead(github.repos!, "houston/7"), entry.headSha);
        assert.deepEqual(mutationsOf(github), [
          { name: "enqueuePullRequest", variables: { id: pullNodeId(7), oid: entry.headSha } },
        ]);
        assert.deepEqual(mergesOf(github), []);
        // One confirming read follows the hand-off.
        const order = github.requests.map((request) =>
          String((request.body as { query?: unknown } | null)?.query ?? request.path),
        );
        const sent = order.findIndex((value) => value.includes("enqueuePullRequest("));
        assert.isAbove(
          order.findIndex((value, index) => index > sent && value.includes("MergeQueueFacts")),
          sent,
        );
        const snapshot = yield* queue.get({ projectId });
        const held = entryOf(snapshot, 7);
        assert.strictEqual(held.status, "watching");
        assert.strictEqual(held.reason, "In GitHub's merge queue (position 2)");
        assert.deepEqual([held.github?.mode, held.github?.headSha], ["mergeQueue", entry.headSha]);
        const rows = snapshot.log.filter((row) => row.kind === "hand_off");
        assert.strictEqual(rows.length, 1);
        assert.deepEqual([rows[0]!.number, rows[0]!.headSha], [7, entry.headSha]);
      }),
      gitLog,
    );
  });

  it.live("a hand-off is pinned to the verified commit and confirmed: auto-merge", () => {
    const github = makeGitHub(makeRepos());
    github.autoMergeAllowed = true;
    const gitLog = makeGitLog();
    return withQueue(
      github,
      Effect.gen(function* () {
        const queue = yield* HoustonMergeQueueService;
        const projectId = yield* queueScenario(github, [7], { command: "git --version" });
        const entry = yield* verified(projectId, 7);
        const verifiedSha = entry.verification!.verifiedSha;
        const result = yield* queue.mergeHead({
          projectId,
          number: 7,
          expectedHeadSha: entry.headSha,
        });
        assert.strictEqual(result.outcome, "handedOff", result.message);
        // The verified commit is pushed with the lease, then auto-merge is pinned to it.
        assert.deepEqual(pushesOf(gitLog), [
          [
            "push",
            "--porcelain",
            `--force-with-lease=refs/heads/houston/7:${entry.headSha}`,
            "origin",
            `${verifiedSha}:refs/heads/houston/7`,
          ],
        ]);
        assert.deepEqual(mutationsOf(github), [
          {
            name: "enablePullRequestAutoMerge",
            variables: { id: pullNodeId(7), oid: verifiedSha, method: "SQUASH" },
          },
        ]);
        assert.deepEqual(mergesOf(github), []);
        const snapshot = yield* queue.get({ projectId });
        const held = entryOf(snapshot, 7);
        assert.strictEqual(held.status, "watching");
        assert.include(held.reason, "Auto-merge");
        assert.deepEqual([held.github?.mode, held.github?.headSha], ["autoMerge", verifiedSha]);
        assert.strictEqual(snapshot.log.filter((row) => row.kind === "hand_off").length, 1);
      }),
      gitLog,
    );
  });

  it.live("a hand-off is pinned to the verified commit and confirmed: not confirmed", () => {
    const github = makeGitHub(makeRepos());
    github.mergeQueueBases.add("main");
    github.handOffIgnored = true;
    return withQueue(
      github,
      Effect.gen(function* () {
        const queue = yield* HoustonMergeQueueService;
        const projectId = yield* queueScenario(github, [7], { command: "git --version" });
        const entry = yield* verified(projectId, 7);
        const failed = yield* refusal(
          queue.mergeHead({ projectId, number: 7, expectedHeadSha: entry.headSha }),
        );
        assert.strictEqual(failed.kind, "refused");
        // The request is taken back and the entry fails.
        assert.deepEqual(
          mutationsOf(github).map((mutation) => mutation.name),
          ["enqueuePullRequest", "dequeuePullRequest"],
        );
        const snapshot = yield* queue.get({ projectId });
        const out = entryOf(snapshot, 7);
        assert.strictEqual(out.failure?.kind, "refused");
        assert.include(out.failure?.message, "did not report");
        assert.isNull(out.github);
        assert.deepEqual(
          snapshot.log.filter((row) => row.kind === "hand_off"),
          [],
        );
      }),
    );
  });

  it.live("a hand-off is pinned to the verified commit and confirmed: the push guard holds", () => {
    const github = makeGitHub(makeRepos());
    github.autoMergeAllowed = true;
    const gitLog = makeGitLog();
    return withQueue(
      github,
      Effect.gen(function* () {
        const queue = yield* HoustonMergeQueueService;
        const runner = yield* HoustonMergeQueueRunner;
        const projectId = yield* queueScenario(github, [7], {
          command: "git --version",
          mergeWhenVerified: true,
          heads: { 7: "feature/x" },
          managed: [],
        });
        const before = remoteHead(github.repos!, "feature/x");
        yield* runner.pass;
        assert.strictEqual(remoteHead(github.repos!, "feature/x"), before);
        assert.deepEqual(pushesOf(gitLog), []);
        assert.deepEqual(mutationsOf(github), []);
        const out = entryOf(yield* queue.get({ projectId }), 7);
        assert.strictEqual(out.failure?.kind, "refused");
        assert.include(out.failure?.message, "outside houston/ and t3/");
      }),
      gitLog,
    );
  });

  it.live("a hand-off is pinned to the verified commit and confirmed: paused", () => {
    const github = makeGitHub(makeRepos());
    github.mergeQueueBases.add("main");
    return withQueue(
      github,
      Effect.gen(function* () {
        const queue = yield* HoustonMergeQueueService;
        const projectId = yield* queueScenario(github, [7], { command: "git --version" });
        const entry = yield* verified(projectId, 7);
        yield* queue.pause({ projectId, paused: true });
        const failed = yield* refusal(
          queue.mergeHead({ projectId, number: 7, expectedHeadSha: entry.headSha }),
        );
        assert.strictEqual(failed.kind, "paused");
        assert.deepEqual(mutationsOf(github), []);
      }),
    );
  });
});

describe("github's merge, ejection, failure or a new head settle a held entry", () => {
  it.live("github's merge, ejection, failure or a new head settle a held entry: merged", () => {
    const github = makeGitHub(makeRepos());
    github.mergeQueueBases.add("main");
    return withQueue(
      github,
      Effect.gen(function* () {
        const queue = yield* HoustonMergeQueueService;
        const reader = yield* HoustonMergeQueueReader;
        const projectId = yield* queueScenario(github, [7, 8], { command: "git --version" });
        const { entry } = yield* handedOff(github, projectId);
        const merged = githubMerges(github, 7);
        yield* reader.readProject(projectId);
        const snapshot = yield* queue.get({ projectId });
        assert.deepEqual(
          snapshot.entries.map((value) => value.number),
          [8],
        );
        const rows = snapshot.log.filter((row) => row.kind === "merge");
        assert.strictEqual(rows.length, 1);
        assert.deepEqual(
          [rows[0]!.number, rows[0]!.refName, rows[0]!.headSha, rows[0]!.newSha],
          [7, "main", entry.headSha, merged],
        );
        assert.deepEqual(
          github.reported.map((report) => [report.reference.number, report.state]),
          [[7, "merged"]],
        );
        assert.strictEqual(entryOf(snapshot, 8).position, 1);
      }),
    );
  });

  it.live("github's merge, ejection, failure or a new head settle a held entry: ejected", () => {
    const github = makeGitHub(makeRepos());
    github.mergeQueueBases.add("main");
    return withQueue(
      github,
      Effect.gen(function* () {
        const queue = yield* HoustonMergeQueueService;
        const reader = yield* HoustonMergeQueueReader;
        const runner = yield* HoustonMergeQueueRunner;
        const projectId = yield* queueScenario(github, [7], { command: "git --version" });
        const { pull } = yield* handedOff(github, projectId);
        pull.queued = null;
        pull.letGo = "MERGE_CONFLICT";
        yield* reader.readProject(projectId);
        yield* runner.step(projectId);
        const out = entryOf(yield* queue.get({ projectId }), 7);
        assert.strictEqual(out.failure?.kind, "ejected", JSON.stringify(out));
        assert.include(out.failure?.message, "GitHub removed PR #7 from its merge queue");
        assert.include(out.failure?.message, "MERGE_CONFLICT");
        assert.isNull(out.github);
      }),
    );
  });

  it.live(
    "github's merge, ejection, failure or a new head settle a held entry: auto-merge off",
    () => {
      const github = makeGitHub(makeRepos());
      github.autoMergeAllowed = true;
      return withQueue(
        github,
        Effect.gen(function* () {
          const queue = yield* HoustonMergeQueueService;
          const reader = yield* HoustonMergeQueueReader;
          const runner = yield* HoustonMergeQueueRunner;
          const projectId = yield* queueScenario(github, [7], { command: "git --version" });
          const { pull } = yield* handedOff(github, projectId);
          pull.autoMerge = null;
          pull.letGo = "the base branch was changed";
          yield* reader.readProject(projectId);
          yield* runner.step(projectId);
          const out = entryOf(yield* queue.get({ projectId }), 7);
          assert.strictEqual(out.failure?.kind, "ejected", JSON.stringify(out));
          assert.include(out.failure?.message, "auto-merge");
          assert.include(out.failure?.message, "the base branch was changed");
        }),
      );
    },
  );

  it.live(
    "github's merge, ejection, failure or a new head settle a held entry: a failing check",
    () => {
      const github = makeGitHub(makeRepos());
      github.autoMergeAllowed = true;
      return withQueue(
        github,
        Effect.gen(function* () {
          const queue = yield* HoustonMergeQueueService;
          const reader = yield* HoustonMergeQueueReader;
          const runner = yield* HoustonMergeQueueRunner;
          const projectId = yield* queueScenario(github, [7], { command: "git --version" });
          const { pull } = yield* handedOff(github, projectId);
          pull.checks = [{ name: "build", status: "failure", required: true }];
          yield* reader.readProject(projectId);
          yield* runner.step(projectId);
          const out = entryOf(yield* queue.get({ projectId }), 7);
          assert.strictEqual(out.failure?.kind, "checksFailed", JSON.stringify(out));
          assert.include(out.failure?.message, "build");
          assert.deepEqual(mergesOf(github), []);
        }),
      );
    },
  );

  it.live(
    "github's merge, ejection, failure or a new head settle a held entry: a new head while another project verifies",
    () => {
      const github = makeGitHub(makeRepos());
      github.mergeQueueBases.add("main");
      return withQueue(
        github,
        Effect.gen(function* () {
          const queue = yield* HoustonMergeQueueService;
          const reader = yield* HoustonMergeQueueReader;
          const runner = yield* HoustonMergeQueueRunner;
          const slot = yield* HoustonBuildSlot;
          const projectId = yield* queueScenario(github, [7], { command: "git --version" });
          yield* handedOff(github, projectId);
          // Another project holds the verification slot meanwhile.
          const release = yield* Deferred.make<void>();
          const taken = yield* Deferred.make<void>();
          const other = yield* slot
            .withSlot(
              { label: "PR #1 of project-other", projectId: "project-other", number: 1 },
              Deferred.succeed(taken, undefined).pipe(Effect.andThen(Deferred.await(release))),
            )
            .pipe(Effect.forkChild);
          yield* Deferred.await(taken);
          const moved = pushBranch(github.repos!, "houston/7", { "new.txt": "new\n" });
          yield* reader.readProject(projectId);
          yield* runner.step(projectId);
          assert.deepEqual(
            mutationsOf(github).map((mutation) => mutation.name),
            ["enqueuePullRequest", "dequeuePullRequest"],
          );
          const back = entryOf(yield* queue.get({ projectId }), 7);
          assert.strictEqual(back.headSha, moved);
          assert.isNull(back.github);
          assert.isNull(back.failure);
          assert.strictEqual(back.position, 1);
          assert.strictEqual(back.status, "waitingForSlot");
          yield* Deferred.succeed(release, undefined);
          yield* Fiber.join(other);
        }),
      );
    },
  );
});

describe("dequeue and pause take the entry back from github first", () => {
  it.live("dequeue and pause take the entry back from github first: dequeue", () => {
    const github = makeGitHub(makeRepos());
    github.mergeQueueBases.add("main");
    return withQueue(
      github,
      Effect.gen(function* () {
        const queue = yield* HoustonMergeQueueService;
        const projectId = yield* queueScenario(github, [7], { command: "git --version" });
        const { pull } = yield* handedOff(github, projectId);
        // GitHub refuses the take-back: the entry stays, held, and the refusal is named.
        github.takeBackFailure = "Resource not accessible by integration";
        const refused = yield* refusal(queue.dequeue({ projectId, number: 7 }));
        assert.strictEqual(refused.kind, "remote");
        assert.include(refused.message, "Resource not accessible by integration");
        assert.strictEqual(entryOf(yield* queue.get({ projectId }), 7).status, "watching");

        github.takeBackFailure = null;
        yield* queue.dequeue({ projectId, number: 7 });
        assert.deepEqual(
          mutationsOf(github).map((mutation) => [mutation.name, mutation.variables.id]),
          [
            ["enqueuePullRequest", pullNodeId(7)],
            ["dequeuePullRequest", pullNodeId(7)],
            ["dequeuePullRequest", pullNodeId(7)],
          ],
        );
        assert.isNull(pull.queued);
        assert.deepEqual((yield* queue.get({ projectId })).entries, []);
      }),
    );
  });

  it.live("dequeue and pause take the entry back from github first: auto-merge", () => {
    const github = makeGitHub(makeRepos());
    github.autoMergeAllowed = true;
    return withQueue(
      github,
      Effect.gen(function* () {
        const queue = yield* HoustonMergeQueueService;
        const projectId = yield* queueScenario(github, [7], { command: "git --version" });
        const { pull } = yield* handedOff(github, projectId);
        yield* queue.dequeue({ projectId, number: 7 });
        assert.deepEqual(
          mutationsOf(github).map((mutation) => mutation.name),
          ["enablePullRequestAutoMerge", "disablePullRequestAutoMerge"],
        );
        assert.isNull(pull.autoMerge);
        assert.deepEqual((yield* queue.get({ projectId })).entries, []);
      }),
    );
  });

  it.live("dequeue and pause take the entry back from github first: pause and resume", () => {
    const github = makeGitHub(makeRepos());
    github.mergeQueueBases.add("main");
    return withQueue(
      github,
      Effect.gen(function* () {
        const queue = yield* HoustonMergeQueueService;
        const runner = yield* HoustonMergeQueueRunner;
        const projectId = yield* queueScenario(github, [7], {
          command: "git --version",
          mergeWhenVerified: true,
        });
        yield* runner.pass;
        const held = entryOf(yield* queue.get({ projectId }), 7);
        assert.strictEqual(held.status, "watching", JSON.stringify(held));
        const pull = github.pulls.get(7)!;

        yield* queue.pause({ projectId, paused: true });
        assert.deepEqual(
          mutationsOf(github).map((mutation) => mutation.name),
          ["enqueuePullRequest", "dequeuePullRequest"],
        );
        assert.isNull(pull.queued);
        const paused = entryOf(yield* queue.get({ projectId }), 7);
        assert.isNull(paused.github);
        assert.isNotNull(paused.verification);
        assert.strictEqual(paused.position, 1);
        yield* runner.pass;
        assert.strictEqual(mutationsOf(github).length, 2);

        yield* queue.pause({ projectId, paused: false });
        yield* runner.pass;
        assert.deepEqual(
          mutationsOf(github).map((mutation) => mutation.name),
          ["enqueuePullRequest", "dequeuePullRequest", "enqueuePullRequest"],
        );
        assert.strictEqual(entryOf(yield* queue.get({ projectId }), 7).status, "watching");
      }),
    );
  });

  it.live("dequeue and pause take the entry back from github first: pause every queue", () => {
    const github = makeGitHub(makeRepos());
    github.mergeQueueBases.add("main");
    return withQueue(
      github,
      Effect.gen(function* () {
        const queue = yield* HoustonMergeQueueService;
        const projectId = yield* queueScenario(github, [7], { command: "git --version" });
        yield* handedOff(github, projectId);
        yield* queue.pause({ paused: true });
        assert.deepEqual(
          mutationsOf(github).map((mutation) => mutation.name),
          ["enqueuePullRequest", "dequeuePullRequest"],
        );
        assert.isNull(entryOf(yield* queue.get({ projectId }), 7).github);
      }),
    );
  });
});

describe("required checks come from the head and no branch rules are read", () => {
  it.live("required checks come from the head and no branch rules are read", () => {
    const github = makeGitHub(makeRepos());
    github.autoMergeAllowed = true;
    return withQueue(
      github,
      Effect.gen(function* () {
        const reader = yield* HoustonMergeQueueReader;
        const store = yield* HoustonMergeQueueStore;
        const projectId = yield* queueScenario(github, [1, 2], { bases: { 2: "release" } });
        // #2's only check is not required, so auto-merge would have nothing to wait for.
        openPull(github, 2, {
          headRef: "houston/2",
          baseRef: "release",
          checks: [{ name: "lint", status: "success", required: false }],
        });
        for (let pass = 0; pass < 3; pass += 1) yield* reader.readAll;
        assert.deepEqual(
          github.requests.filter((request) =>
            /rules\/branches\/|branches\/[^/]+\/protection|\/rulesets/.test(request.path),
          ),
          [],
        );
        assert.deepEqual(yield* store.handOffs(projectId), {
          main: "autoMerge",
          release: "houston",
        });
      }),
    );
  });
});
