// @effect-diagnostics nodeBuiltinImport:off - rewrites a branch in a scratch clone.
// Stacked pull requests over real git and the GitHub fake: a dependent replays only its own
// commits, is retargeted to the base, and a chain lands one level per landing.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { assert, describe, it } from "@effect/vitest";
import type { HoustonMergeQueueError } from "@t3tools/contracts/houston/mergeQueue";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerConfig from "../../config.ts";
import {
  addManagedWorktree,
  createProject,
  entryOf,
  git,
  layerMergeQueueTest,
  makeGitHub,
  makeGitLog,
  makeRepos,
  mergesOf,
  openPull,
  pushBranch,
  pushesOf,
  remoteHead,
  type FakeGitHub,
  type GitLog,
} from "./mergeQueue.testkit.ts";
import { HoustonMergeQueueRunner } from "./Runner.ts";
import { HoustonMergeQueueService } from "./Service.ts";

const withQueue = <A, E>(
  github: FakeGitHub,
  body: Effect.Effect<A, E, Layer.Success<ReturnType<typeof layerMergeQueueTest>>>,
  gitLog: GitLog = makeGitLog(),
) => body.pipe(Effect.provide(Layer.fresh(layerMergeQueueTest({ github, gitLog, loops: false }))));

const refusal = <A, R>(effect: Effect.Effect<A, HoustonMergeQueueError, R>) => Effect.flip(effect);

const SETTINGS = { verificationCommand: "git --version", timeLimitMinutes: 30 };

/** Files the commit changes against its first parent. */
const changed = (cwd: string, sha: string) =>
  git(cwd, ["diff-tree", "--no-commit-id", "--name-only", "-r", sha]).split("\n").filter(Boolean);

/** Resets `branch` to main with one new commit, as a force-pushed rewrite would. */
const rewriteBranch = (
  github: FakeGitHub,
  branch: string,
  files: Readonly<Record<string, string>>,
) => {
  const repos = github.repos!;
  const work = NodePath.join(repos.root, `rewrite-${branch.replaceAll("/", "-")}`);
  git(repos.root, ["clone", "--quiet", repos.bare, work]);
  git(work, ["checkout", "--quiet", "-B", branch, "origin/main"]);
  for (const [file, text] of Object.entries(files)) {
    NodeFS.writeFileSync(NodePath.join(work, file), text);
  }
  git(work, ["add", "."]);
  git(work, ["commit", "--quiet", "-m", `rewrite ${branch}`]);
  git(work, ["push", "--quiet", "--force", "origin", `HEAD:refs/heads/${branch}`]);
  const head = git(work, ["rev-parse", "HEAD"]);
  NodeFS.rmSync(work, { recursive: true, force: true });
  return head;
};

interface Layer_ {
  readonly number: number;
  readonly branch: string;
  /** The branch this one is built on; main when absent. */
  readonly from?: string;
  /** The pull request's base on GitHub; `from` (or main) when absent. */
  readonly base?: string;
  readonly dependsOn?: number;
}

/** A project with `layers` pushed, opened and queued in order, every branch managed. */
const stackScenario = (
  github: FakeGitHub,
  layers: ReadonlyArray<Layer_>,
  options: { readonly mergeWhenVerified?: boolean; readonly enqueue?: boolean } = {},
) =>
  Effect.gen(function* () {
    const repos = github.repos!;
    const config = yield* ServerConfig.ServerConfig;
    const queue = yield* HoustonMergeQueueService;
    const heads = new Map<number, string>();
    for (const layer of layers) {
      const from = layer.from ?? "main";
      // Two commits on each branch, so a squash of it differs from its commits' patches.
      pushBranch(repos, layer.branch, { [`${layer.number}.txt`]: "first\n" }, { from });
      heads.set(
        layer.number,
        pushBranch(repos, layer.branch, { [`${layer.number}.txt`]: "second\n" }),
      );
      openPull(github, layer.number, { headRef: layer.branch, baseRef: layer.base ?? from });
    }
    // main moves, so the first verification makes a new commit.
    pushBranch(repos, "main", { "main.txt": "moved\n" });
    for (const layer of layers) addManagedWorktree(repos, config.worktreesDir, layer.branch);
    const projectId = yield* createProject("stack", repos.checkout);
    yield* queue.setSettings({
      projectId,
      mergeWhenVerified: options.mergeWhenVerified ?? false,
      ...SETTINGS,
    });
    if (options.enqueue ?? true) {
      for (const layer of layers) {
        yield* queue.enqueue({
          projectId,
          pullRequest: layer.number,
          dependsOn: layer.dependsOn ?? null,
        });
      }
    }
    return { projectId, heads };
  });

/** Verifies and merges the entry that goes next by the user's Merge. */
const landNext = (
  projectId: Parameters<HoustonMergeQueueService["Service"]["get"]>[0]["projectId"],
  number: number,
) =>
  Effect.gen(function* () {
    const queue = yield* HoustonMergeQueueService;
    const runner = yield* HoustonMergeQueueRunner;
    yield* runner.step(projectId);
    const entry = entryOf(yield* queue.get({ projectId }), number);
    assert.isNotNull(entry.verification, JSON.stringify(entry));
    const result = yield* queue.mergeHead({ projectId, number, expectedHeadSha: entry.headSha });
    assert.strictEqual(result.outcome, "merged", result.message);
    return entry;
  });

describe("a dependent on a squash-merged branch replays only its own commits", () => {
  it.live("a dependent on a squash-merged branch replays only its own commits", () => {
    const github = makeGitHub(makeRepos());
    return withQueue(
      github,
      Effect.gen(function* () {
        const queue = yield* HoustonMergeQueueService;
        const runner = yield* HoustonMergeQueueRunner;
        const { projectId, heads } = yield* stackScenario(github, [
          { number: 1, branch: "houston/one" },
          { number: 2, branch: "houston/two", from: "houston/one", dependsOn: 1 },
        ]);
        yield* landNext(projectId, 1);
        const base = remoteHead(github.repos!, "main")!;

        yield* runner.step(projectId);
        const two = entryOf(yield* queue.get({ projectId }), 2);
        assert.isNull(two.failure, JSON.stringify(two.failure));
        const verification = two.verification!;
        assert.isNotNull(verification, JSON.stringify(two));
        // Rebased onto the base past #1's newest recorded head it contains: #1's own head.
        assert.strictEqual(verification.baseRef, "main");
        assert.strictEqual(verification.baseSha, base);
        assert.strictEqual(verification.forkSha, heads.get(1));
        const checkout = github.repos!.checkout;
        git(checkout, ["fetch", "--quiet", "origin", "+refs/heads/*:refs/fetched/*"]);
        assert.strictEqual(git(checkout, ["rev-parse", `${verification.verifiedSha}~2`]), base);
        assert.deepEqual(changed(checkout, verification.verifiedSha), ["2.txt"]);
        assert.deepEqual(changed(checkout, `${verification.verifiedSha}^`), ["2.txt"]);
      }),
    );
  });
});

describe("a dependency in order only is rebased plainly", () => {
  it.live("a dependency in order only is rebased plainly", () => {
    const github = makeGitHub(makeRepos());
    const gitLog = makeGitLog();
    return withQueue(
      github,
      Effect.gen(function* () {
        const queue = yield* HoustonMergeQueueService;
        const runner = yield* HoustonMergeQueueRunner;
        const { projectId } = yield* stackScenario(github, [
          { number: 1, branch: "houston/one" },
          { number: 2, branch: "houston/two", dependsOn: 1 },
        ]);
        yield* landNext(projectId, 1);
        gitLog.calls.length = 0;
        yield* runner.step(projectId);
        const two = entryOf(yield* queue.get({ projectId }), 2);
        assert.isNotNull(two.verification, JSON.stringify(two));
        assert.isUndefined(two.verification!.forkSha);
        const rebases = gitLog.calls.filter((args) => args.includes("rebase"));
        assert.isNotEmpty(rebases);
        for (const args of rebases) assert.notInclude(args, "--onto");

        const requests = github.requests.length;
        yield* queue.mergeHead({ projectId, number: 2, expectedHeadSha: two.headSha });
        const rows = (yield* queue.get({ projectId })).log;
        assert.deepEqual(
          rows.filter((row) => row.kind === "restack" || row.kind === "retarget"),
          [],
        );
        assert.deepEqual(
          github.requests.slice(requests).filter((request) => request.method === "PATCH"),
          [],
        );
      }),
      gitLog,
    );
  });
});

describe("a dependent with no recorded fork point is refused by name", () => {
  it.live("a dependent with no recorded fork point is refused by name", () => {
    const github = makeGitHub(makeRepos());
    const gitLog = makeGitLog();
    return withQueue(
      github,
      Effect.gen(function* () {
        const queue = yield* HoustonMergeQueueService;
        const runner = yield* HoustonMergeQueueRunner;
        const { projectId } = yield* stackScenario(
          github,
          [
            { number: 1, branch: "houston/one" },
            { number: 2, branch: "houston/two", from: "houston/one", dependsOn: 1 },
          ],
          { enqueue: false },
        );
        // #1's branch is rewritten before the queue ever reads it: #2 carries commits of
        // houston/one that no recorded head of #1 names.
        rewriteBranch(github, "houston/one", { "1.txt": "rewritten\n" });
        yield* queue.enqueue({ projectId, pullRequest: 1 });
        yield* queue.enqueue({ projectId, pullRequest: 2, dependsOn: 1 });
        const one = yield* landNext(projectId, 1);
        const before = remoteHead(github.repos!, "houston/two");
        gitLog.calls.length = 0;

        yield* runner.step(projectId);
        const two = entryOf(yield* queue.get({ projectId }), 2);
        assert.strictEqual(two.failure?.kind, "refused", JSON.stringify(two));
        const message = two.failure!.message;
        assert.include(message, one.headSha.slice(0, 7));
        assert.include(message, one.verification!.verifiedSha.slice(0, 7));
        assert.include(
          message,
          "Houston does not guess one. Rebase houston/two onto main and push",
        );
        assert.deepEqual(pushesOf(gitLog), []);
        assert.strictEqual(remoteHead(github.repos!, "houston/two"), before);
        const merges = mergesOf(github).length;
        const refused = yield* refusal(
          queue.mergeHead({ projectId, number: 2, expectedHeadSha: two.headSha }),
        );
        assert.strictEqual(refused.kind, "conflict");
        assert.strictEqual(mergesOf(github).length, merges);
      }),
      gitLog,
    );
  });
});

describe("a restacked dependent is retargeted, landed, and a chain moves one level per landing", () => {
  it.live(
    "a restacked dependent is retargeted, landed, and a chain moves one level per landing",
    () => {
      const github = makeGitHub(makeRepos());
      return withQueue(
        github,
        Effect.gen(function* () {
          const queue = yield* HoustonMergeQueueService;
          const runner = yield* HoustonMergeQueueRunner;
          const { projectId } = yield* stackScenario(
            github,
            [
              { number: 1, branch: "houston/one" },
              { number: 2, branch: "houston/two", from: "houston/one", dependsOn: 1 },
              { number: 3, branch: "houston/three", from: "houston/two", dependsOn: 2 },
            ],
            { mergeWhenVerified: true },
          );
          yield* runner.pass;
          const snapshot = yield* queue.get({ projectId });
          assert.deepEqual(snapshot.entries, [], JSON.stringify(snapshot.entries));
          // Each dependent was retargeted to main before its merge, once.
          const patches = github.requests.filter((request) => request.method === "PATCH");
          assert.deepEqual(
            patches.map((request) => [request.path, request.body]),
            [
              ["/repos/o/r/pulls/2", { base: "main" }],
              ["/repos/o/r/pulls/3", { base: "main" }],
            ],
          );
          const order = github.requests.map((request) => `${request.method} ${request.path}`);
          for (const number of [2, 3]) {
            assert.isBelow(
              order.indexOf(`PATCH /repos/o/r/pulls/${number}`),
              order.indexOf(`PUT /repos/o/r/pulls/${number}/merge`),
            );
          }
          assert.deepEqual(
            mergesOf(github).map((request) => request.path),
            ["/repos/o/r/pulls/1/merge", "/repos/o/r/pulls/2/merge", "/repos/o/r/pulls/3/merge"],
          );
          // Oldest first: a retarget, then its restack and push, then the merge.
          const log = [...snapshot.log].reverse();
          const of = (kind: string) => log.filter((row) => row.kind === kind);
          assert.deepEqual(
            of("retarget").map((row) => [row.number, row.detail]),
            [
              [2, "Retargeted from houston/one"],
              [3, "Retargeted from houston/two"],
            ],
          );
          assert.deepEqual(
            of("restack").map((row) => row.number),
            [2, 3],
          );
          for (const row of of("restack")) assert.isNotNull(row.forkSha);
          for (const number of [2, 3]) {
            const ids = (kind: string) =>
              log.filter((row) => row.kind === kind && row.number === number).map((row) => row.id);
            assert.isBelow(ids("retarget")[0]!, ids("push")[0]!);
            assert.isBelow(ids("push")[0]!, ids("merge")[0]!);
          }
          // main holds every layer's own change, each once.
          const checkout = github.repos!.checkout;
          git(checkout, ["fetch", "--quiet", "origin", "+refs/heads/main:refs/fetched/main"]);
          for (const file of ["1.txt", "2.txt", "3.txt"]) {
            assert.strictEqual(git(checkout, ["show", `refs/fetched/main:${file}`]), "second");
          }
        }),
      );
    },
  );
});
