// @effect-diagnostics nodeBuiltinImport:off - reads the merge queue's sources for the guard scans.
// Landing over real git and the GitHub fake: the lease push, the merge pinned to the gated commit,
// and every refusal that sends nothing.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { assert, describe, it } from "@effect/vitest";
import type { HoustonMergeQueueError } from "@t3tools/contracts/houston/mergeQueue";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as PullRequestService from "../../pullRequest/PullRequestService.ts";
import { pushWithLease } from "./Landing.ts";
import {
  entryOf,
  git,
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

const withQueue = <A, E>(
  github: FakeGitHub,
  body: Effect.Effect<A, E, Layer.Success<ReturnType<typeof layerMergeQueueTest>>>,
  gitLog: GitLog = makeGitLog(),
) => body.pipe(Effect.provide(Layer.fresh(layerMergeQueueTest({ github, gitLog, loops: false }))));

const refusal = <A, R>(effect: Effect.Effect<A, HoustonMergeQueueError, R>) => Effect.flip(effect);

const mergeBodies = (github: FakeGitHub) =>
  mergesOf(github).map((request): Record<string, unknown> => ({
    path: request.path,
    ...(request.body as Record<string, unknown>),
  }));

/** Verifies #N with the policy off, so it waits as Ready for the user's Merge. */
const verified = (
  projectId: Parameters<HoustonMergeQueueService["Service"]["get"]>[0]["projectId"],
  number: number,
) =>
  Effect.gen(function* () {
    const queue = yield* HoustonMergeQueueService;
    const runner = yield* HoustonMergeQueueRunner;
    yield* runner.step(projectId);
    const entry = entryOf(yield* queue.get({ projectId }), number);
    assert.isNotNull(entry.verification, JSON.stringify(entry));
    return entry;
  });

describe("a pull request github reports conflicting lands once a clean rebase is pushed", () => {
  it.live("a pull request github reports conflicting lands once a clean rebase is pushed", () => {
    const github = makeGitHub(makeRepos());
    return withQueue(
      github,
      Effect.gen(function* () {
        const queue = yield* HoustonMergeQueueService;
        const runner = yield* HoustonMergeQueueRunner;
        const reader = yield* HoustonMergeQueueReader;
        const projectId = yield* queueScenario(github, [7], {
          command: "git --version",
          mergeWhenVerified: true,
        });
        const pull = github.pulls.get(7)!;
        pull.mergeState = "DIRTY";
        pull.mergeability = "conflicting";
        yield* reader.readProject(projectId);
        const before = entryOf(yield* queue.get({ projectId }), 7);
        assert.strictEqual(before.status, "waitingForSlot");
        const head = before.headSha;

        // The clean rebase is pushed; GitHub still reports the stale conflict for it.
        yield* runner.pass;
        const pushed = remoteHead(github.repos!, "houston/7")!;
        assert.notStrictEqual(pushed, head);
        assert.deepEqual(mergesOf(github), []);
        const waiting = entryOf(yield* queue.get({ projectId }), 7);
        assert.strictEqual(waiting.headSha, pushed);
        assert.isNull(waiting.failure);

        pull.mergeState = "CLEAN";
        pull.mergeability = "mergeable";
        yield* reader.readProject(projectId);
        yield* runner.pass;
        assert.deepEqual(
          mergeBodies(github).map((body) => [body.path, body.sha]),
          [["/repos/o/r/pulls/7/merge", pushed]],
        );
      }),
    );
  });
});

describe("a pull request github reports conflicting parks on a real conflict", () => {
  it.live("a pull request github reports conflicting parks on a real conflict", () => {
    const github = makeGitHub(makeRepos());
    return withQueue(
      github,
      Effect.gen(function* () {
        const queue = yield* HoustonMergeQueueService;
        const runner = yield* HoustonMergeQueueRunner;
        const reader = yield* HoustonMergeQueueReader;
        const projectId = yield* queueScenario(github, [7], {
          command: "git --version",
          mergeWhenVerified: true,
          mainMoves: false,
        });
        pushBranch(github.repos!, "houston/7", { "README.md": "head\n" });
        pushBranch(github.repos!, "main", { "README.md": "main\n" });
        const pull = github.pulls.get(7)!;
        pull.mergeState = "DIRTY";
        pull.mergeability = "conflicting";
        yield* reader.readProject(projectId);
        yield* runner.pass;
        const parked = entryOf(yield* queue.get({ projectId }), 7);
        assert.strictEqual(parked.status, "parked");
        assert.strictEqual(parked.failure?.kind, "conflict");
        assert.deepEqual(parked.failure?.files, ["README.md"]);
        assert.deepEqual(mergesOf(github), []);
        assert.isTrue((yield* queue.get({ projectId })).log.some((row) => row.kind === "park"));
      }),
    );
  });
});

describe("only the entry that goes next merges, at the commit the user saw", () => {
  it.live("only the entry that goes next merges, at the commit the user saw", () => {
    const github = makeGitHub(makeRepos());
    const gitLog = makeGitLog();
    return withQueue(
      github,
      Effect.gen(function* () {
        const queue = yield* HoustonMergeQueueService;
        const projectId = yield* queueScenario(github, [1, 2], { mainMoves: false });
        const snapshot = yield* queue.get({ projectId });
        const one = entryOf(snapshot, 1);
        const two = entryOf(snapshot, 2);

        const notNext = yield* refusal(
          queue.mergeHead({ projectId, number: 2, expectedHeadSha: two.headSha }),
        );
        assert.strictEqual(notNext.kind, "conflict");
        assert.include(notNext.message, "#1 goes next");
        assert.include(notNext.message, "PR #2 is number 2 in line");

        const older = "0".repeat(40);
        const moved = yield* refusal(
          queue.mergeHead({ projectId, number: 1, expectedHeadSha: older }),
        );
        assert.strictEqual(moved.kind, "conflict");
        assert.include(
          moved.message,
          `head moved from ${older} to ${one.headSha}; refusing to merge an unseen commit`,
        );

        const shape = yield* refusal(
          queue.mergeHead({ projectId, number: 1, expectedHeadSha: "abc" }),
        );
        assert.strictEqual(shape.kind, "invalid");
        assert.include(shape.message, "abc");

        assert.deepEqual(mergesOf(github), []);
        assert.deepEqual(pushesOf(gitLog), []);
      }),
      gitLog,
    );
  });
});

describe("a verified head is pushed with a lease and merged at exactly that commit", () => {
  for (const [methods, expected] of [
    [{ merge: true, squash: true, rebase: true }, "squash"],
    [{ merge: true, squash: false, rebase: true }, "merge"],
  ] as const) {
    it.live(
      `a verified head is pushed with a lease and merged at exactly that commit: ${expected}`,
      () => {
        const github = makeGitHub(makeRepos());
        github.mergeMethods = { ...methods };
        const gitLog = makeGitLog();
        return withQueue(
          github,
          Effect.gen(function* () {
            const queue = yield* HoustonMergeQueueService;
            const projectId = yield* queueScenario(github, [7], { command: "git --version" });
            const entry = yield* verified(projectId, 7);
            const head = entry.headSha;
            const verifiedSha = entry.verification!.verifiedSha;
            assert.notStrictEqual(verifiedSha, head);
            github.requests.length = 0;

            const result = yield* queue.mergeHead({ projectId, number: 7, expectedHeadSha: head });
            assert.strictEqual(result.outcome, "merged", result.message);
            assert.deepEqual(pushesOf(gitLog), [
              [
                "push",
                "--porcelain",
                `--force-with-lease=refs/heads/houston/7:${head}`,
                "origin",
                `${verifiedSha}:refs/heads/houston/7`,
              ],
            ]);
            // GitHub reported the pushed commit before the gates were read on it and the merge sent.
            const order = github.requests.map((request) => `${request.method} ${request.path}`);
            assert.include(order, "GET detail/7");
            assert.isBelow(
              order.indexOf("GET detail/7"),
              order.indexOf("PUT /repos/o/r/pulls/7/merge"),
            );
            assert.deepEqual(mergeBodies(github), [
              { path: "/repos/o/r/pulls/7/merge", sha: verifiedSha, merge_method: expected },
            ]);
          }),
          gitLog,
        );
      },
    );
  }
});

describe("a moved base or an unseen push merges nothing", () => {
  it.live("a moved base or an unseen push merges nothing: the base moved", () => {
    const github = makeGitHub(makeRepos());
    const gitLog = makeGitLog();
    return withQueue(
      github,
      Effect.gen(function* () {
        const queue = yield* HoustonMergeQueueService;
        const runner = yield* HoustonMergeQueueRunner;
        const projectId = yield* queueScenario(github, [7], { command: "git --version" });
        const entry = yield* verified(projectId, 7);
        pushBranch(github.repos!, "main", { "later.txt": "later\n" });
        const result = yield* queue.mergeHead({
          projectId,
          number: 7,
          expectedHeadSha: entry.headSha,
        });
        assert.strictEqual(result.outcome, "waiting");
        assert.include(result.message, "verifies again on the new base");
        assert.isNull(entryOf(yield* queue.get({ projectId }), 7).verification);
        assert.deepEqual(pushesOf(gitLog), []);
        assert.deepEqual(mergesOf(github), []);
        // The next pass verifies on the new base.
        yield* runner.step(projectId);
        const again = entryOf(yield* queue.get({ projectId }), 7);
        assert.strictEqual(again.verification?.baseSha, remoteHead(github.repos!, "main"));
      }),
      gitLog,
    );
  });

  it.effect("a moved base or an unseen push merges nothing: github never reports the push", () => {
    const github = makeGitHub(makeRepos());
    return withQueue(
      github,
      Effect.gen(function* () {
        const queue = yield* HoustonMergeQueueService;
        const projectId = yield* queueScenario(github, [7], { command: "git --version" });
        const entry = yield* verified(projectId, 7);
        // GitHub keeps answering with the old head.
        github.pulls.get(7)!.headSha = entry.headSha;
        github.requests.length = 0;
        const fiber = yield* queue
          .mergeHead({ projectId, number: 7, expectedHeadSha: entry.headSha })
          .pipe(Effect.forkChild);
        for (let step = 0; step < 400 && fiber.pollUnsafe() === undefined; step += 1) {
          yield* TestClock.withLive(Effect.sleep("20 millis"));
          yield* TestClock.adjust("5 seconds");
        }
        const result = yield* Fiber.join(fiber);
        assert.strictEqual(result.outcome, "waiting");
        assert.include(result.message, "still reports");
        assert.strictEqual(
          github.requests.filter((request) => request.path === "detail/7").length,
          6,
        );
        assert.deepEqual(mergesOf(github), []);
      }),
    );
  });

  it.live(
    "a moved base or an unseen push merges nothing: without a command the head merges",
    () => {
      const github = makeGitHub(makeRepos());
      const gitLog = makeGitLog();
      return withQueue(
        github,
        Effect.gen(function* () {
          const queue = yield* HoustonMergeQueueService;
          const projectId = yield* queueScenario(github, [7], { mainMoves: false });
          const head = entryOf(yield* queue.get({ projectId }), 7).headSha;
          github.requests.length = 0;
          const result = yield* queue.mergeHead({ projectId, number: 7, expectedHeadSha: head });
          assert.strictEqual(result.outcome, "merged", result.message);
          assert.include(
            github.requests.map((request) => request.path),
            "detail/7",
          );
          assert.deepEqual(
            mergeBodies(github).map((body) => body.sha),
            [head],
          );
          assert.deepEqual(pushesOf(gitLog), []);
        }),
        gitLog,
      );
    },
  );
});

describe("a pushed commit merges only once its checks are green", () => {
  it.live("a pushed commit merges only once its checks are green", () => {
    const github = makeGitHub(makeRepos());
    return withQueue(
      github,
      Effect.gen(function* () {
        const queue = yield* HoustonMergeQueueService;
        const projectId = yield* queueScenario(github, [7], { command: "git --version" });
        const entry = yield* verified(projectId, 7);
        const pull = github.pulls.get(7)!;
        pull.checks = [{ name: "build", status: "pending", required: true }];
        const first = yield* queue.mergeHead({
          projectId,
          number: 7,
          expectedHeadSha: entry.headSha,
        });
        assert.strictEqual(first.outcome, "waiting");
        assert.deepEqual(mergesOf(github), []);
        const pushed = remoteHead(github.repos!, "houston/7")!;
        assert.strictEqual(pushed, entry.verification!.verifiedSha);

        pull.checks = [{ name: "build", status: "success", required: true }];
        const second = yield* queue.mergeHead({ projectId, number: 7, expectedHeadSha: pushed });
        assert.strictEqual(second.outcome, "merged", second.message);
        assert.deepEqual(
          mergeBodies(github).map((body) => body.sha),
          [pushed],
        );
      }),
    );
  });

  it.live(
    "a pushed commit merges only once its checks are green: none reported yet after the push",
    () => {
      const github = makeGitHub(makeRepos());
      return withQueue(
        github,
        Effect.gen(function* () {
          const queue = yield* HoustonMergeQueueService;
          const projectId = yield* queueScenario(github, [7], { command: "git --version" });
          const pull = github.pulls.get(7)!;
          pull.checks = [
            { name: "build", status: "success", required: true },
            { name: "lint", status: "success", required: false },
          ];
          yield* (yield* HoustonMergeQueueReader).readProject(projectId);
          const entry = yield* verified(projectId, 7);
          // CI has not registered on the pushed commit yet, and GitHub calls it clean.
          pull.checks = [];
          const first = yield* queue.mergeHead({
            projectId,
            number: 7,
            expectedHeadSha: entry.headSha,
          });
          assert.strictEqual(first.outcome, "waiting", first.message);
          assert.include(first.message, "0 of 2 checks");
          assert.deepEqual(mergesOf(github), []);
          const pushed = remoteHead(github.repos!, "houston/7")!;
          assert.strictEqual(pushed, entry.verification!.verifiedSha);

          pull.checks = [{ name: "build", status: "success", required: true }];
          const partial = yield* queue.mergeHead({
            projectId,
            number: 7,
            expectedHeadSha: pushed,
          });
          assert.strictEqual(partial.outcome, "waiting", partial.message);
          assert.include(partial.message, "1 of 2 checks");
          assert.deepEqual(mergesOf(github), []);

          pull.checks = [
            { name: "build", status: "success", required: true },
            { name: "lint", status: "success", required: false },
          ];
          const merged = yield* queue.mergeHead({ projectId, number: 7, expectedHeadSha: pushed });
          assert.strictEqual(merged.outcome, "merged", merged.message);
          assert.deepEqual(
            mergeBodies(github).map((body) => body.sha),
            [pushed],
          );
        }),
      );
    },
  );

  it.live(
    "a pushed commit merges only once its checks are green: a repository without checks",
    () => {
      const github = makeGitHub(makeRepos());
      return withQueue(
        github,
        Effect.gen(function* () {
          const queue = yield* HoustonMergeQueueService;
          const projectId = yield* queueScenario(github, [7], { command: "git --version" });
          github.pulls.get(7)!.checks = [];
          yield* (yield* HoustonMergeQueueReader).readProject(projectId);
          const entry = yield* verified(projectId, 7);
          const result = yield* queue.mergeHead({
            projectId,
            number: 7,
            expectedHeadSha: entry.headSha,
          });
          assert.strictEqual(result.outcome, "merged", result.message);
          assert.deepEqual(
            mergeBodies(github).map((body) => body.sha),
            [entry.verification!.verifiedSha],
          );
        }),
      );
    },
  );

  it.live("a pushed commit merges only once its checks are green: a failing check", () => {
    const github = makeGitHub(makeRepos());
    return withQueue(
      github,
      Effect.gen(function* () {
        const queue = yield* HoustonMergeQueueService;
        const projectId = yield* queueScenario(github, [7], { command: "git --version" });
        const entry = yield* verified(projectId, 7);
        github.pulls.get(7)!.checks = [{ name: "build", status: "failure", required: true }];
        const failed = yield* refusal(
          queue.mergeHead({ projectId, number: 7, expectedHeadSha: entry.headSha }),
        );
        assert.strictEqual(failed.kind, "refused");
        const after = entryOf(yield* queue.get({ projectId }), 7);
        assert.strictEqual(after.position, 0);
        assert.strictEqual(after.failure?.kind, "checksFailed");
        assert.include(after.failure?.message, "build");
        assert.deepEqual(mergesOf(github), []);
      }),
    );
  });
});

describe("a refused push runs no git push and records the failure", () => {
  it.live("a refused push runs no git push and records the failure", () => {
    const github = makeGitHub(makeRepos());
    const gitLog = makeGitLog();
    return withQueue(
      github,
      Effect.gen(function* () {
        const queue = yield* HoustonMergeQueueService;
        const runner = yield* HoustonMergeQueueRunner;
        // #7's branch is outside houston/ and t3/; #8's is a managed houston/ branch.
        const projectId = yield* queueScenario(github, [7, 8], {
          command: "git --version",
          mergeWhenVerified: true,
          heads: { 7: "feature/x" },
          managed: ["houston/8"],
        });
        const remoteBefore = remoteHead(github.repos!, "feature/x");
        yield* runner.pass;
        assert.strictEqual(remoteHead(github.repos!, "feature/x"), remoteBefore);
        assert.isFalse(
          pushesOf(gitLog).some((args) => args.some((arg) => arg.includes("feature/x"))),
        );
        const snapshot = yield* queue.get({ projectId });
        const refused = entryOf(snapshot, 7);
        assert.strictEqual(refused.failure?.kind, "refused");
        assert.include(refused.failure?.message, "feature/x");
        assert.include(refused.failure?.message, "outside houston/ and t3/");
        // The queue moved on: #8 landed.
        assert.deepEqual(
          mergesOf(github).map((request) => request.path),
          ["/repos/o/r/pulls/8/merge"],
        );
      }),
      gitLog,
    );
  });

  it.live(
    "a refused push runs no git push and records the failure: a houston branch in the user's checkout",
    () => {
      const github = makeGitHub(makeRepos());
      const gitLog = makeGitLog();
      const repos = github.repos!;
      return withQueue(
        github,
        Effect.gen(function* () {
          const queue = yield* HoustonMergeQueueService;
          const runner = yield* HoustonMergeQueueRunner;
          // No managed worktree and no task run: houston/9 is checked out only in the project's
          // own checkout, which Houston does not manage.
          const projectId = yield* queueScenario(github, [9], {
            command: "git --version",
            mergeWhenVerified: true,
            managed: [],
          });
          git(repos.checkout, ["fetch", "--quiet", "origin", "+houston/9:refs/heads/houston/9"]);
          git(repos.checkout, ["checkout", "--quiet", "houston/9"]);
          const remoteBefore = remoteHead(repos, "houston/9");
          yield* runner.pass;
          assert.strictEqual(remoteHead(repos, "houston/9"), remoteBefore);
          assert.deepEqual(pushesOf(gitLog), []);
          const refused = entryOf(yield* queue.get({ projectId }), 9);
          assert.strictEqual(refused.failure?.kind, "refused", JSON.stringify(refused));
          assert.include(refused.failure?.message, "houston/9");
          assert.include(refused.failure?.message, "Houston created no worktree on that branch");
          assert.deepEqual(mergesOf(github), []);
        }),
        gitLog,
      );
    },
  );
});

describe("the merge queue has no push but the lease and no unpinned merge", () => {
  it.live("the merge queue has no push but the lease and no unpinned merge", () =>
    Effect.sync(() => {
      const directory = import.meta.dirname;
      const sources = NodeFS.readdirSync(directory, { recursive: true })
        .map(String)
        .filter(
          (file) => file.endsWith(".ts") && !file.includes(".test.") && !file.includes("testkit"),
        );
      assert.isNotEmpty(sources);
      // Every git argument list that names `push`, wherever it starts.
      const pushSites: Array<{ readonly file: string; readonly args: string }> = [];
      const handOffs = new Set<string>();
      for (const file of sources) {
        const text = NodeFS.readFileSync(NodePath.join(directory, file), "utf8");
        for (const match of text.matchAll(/\[[^\]]*["'`]push["'`][^\]]*\]/g)) {
          pushSites.push({ file, args: match[0] });
        }
        assert.notMatch(text, /git push|--mirror|--force-if-includes/, file);
        assert.notMatch(text, /\bupdateRef\b|git\/refs/, file);
        // Upstream's actions only open a revert: its merge and auto-merge are not pinned.
        for (const call of text.matchAll(/runAction\(\{[^}]*\}/g)) {
          assert.match(call[0], /action: "revert"/, `${file}: ${call[0]}`);
        }
        assert.notMatch(text, /"merge"\s*as PullRequestAction|action: "merge"/, file);
        assert.notMatch(text, /enable-auto-merge|auto_merge/, file);
        // Every hand-off GitHub mutation is pinned to the commit the gates read.
        for (const mutation of text.matchAll(
          /(enqueuePullRequest|enablePullRequestAutoMerge)\(input: \{[^}]*\}/g,
        )) {
          assert.match(mutation[0], /expectedHeadOid: \$oid/, `${file}: ${mutation[0]}`);
          handOffs.add(mutation[1]!);
        }
      }
      assert.deepEqual([...handOffs].toSorted(), [
        "enablePullRequestAutoMerge",
        "enqueuePullRequest",
      ]);
      // The one lease push, in Landing.ts, and no other force form.
      assert.deepEqual(
        pushSites.map((site) => site.file),
        ["Landing.ts"],
        pushSites.map((site) => site.args).join("\n"),
      );
      const args = pushSites[0]!.args;
      assert.match(args, /^\[\s*"push",\s*"--porcelain",\s*`--force-with-lease=refs\/heads\/\$\{/);
      assert.notMatch(args, /"--force"|"-f"|"\+|`\+|--delete|"-d"/);
      assert.match(args, /`\$\{[^}]+\}:refs\/heads\/\$\{[^}]+\}`\s*,?\s*\]$/);
    }),
  );
});

describe("the lease push sends only the branch whatever the user's git config says", () => {
  it.live("the lease push sends only the branch whatever the user's git config says", () => {
    const repos = makeRepos();
    const head = pushBranch(repos, "houston/7", { "a.txt": "a\n" });
    git(repos.checkout, ["fetch", "--quiet", "origin", "+houston/7:refs/heads/houston/7"]);
    git(repos.checkout, ["checkout", "--quiet", "houston/7"]);
    NodeFS.writeFileSync(NodePath.join(repos.checkout, "b.txt"), "b\n");
    git(repos.checkout, ["add", "b.txt"]);
    git(repos.checkout, ["commit", "--quiet", "-m", "verified"]);
    const commit = git(repos.checkout, ["rev-parse", "HEAD"]);
    // A tag of the user's on the pushed commit, and config that would push it beside the branch.
    git(repos.checkout, ["tag", "-a", "user-tag", "-m", "the user's", commit]);
    git(repos.checkout, ["config", "push.followTags", "true"]);
    git(repos.checkout, ["config", "push.gpgSign", "true"]);
    git(repos.checkout, ["config", "gpg.program", "houston-no-such-gpg"]);
    const marker = NodePath.join(repos.root, "pre-push.txt");
    NodeFS.writeFileSync(
      NodePath.join(repos.checkout, ".git", "hooks", "pre-push"),
      `#!/bin/sh\necho ran >> "${marker.replaceAll("\\", "/")}"\n`,
      { mode: 0o755 },
    );
    return withQueue(
      makeGitHub(repos),
      Effect.gen(function* () {
        yield* pushWithLease(repos.checkout, "origin", "houston/7", head, commit);
        assert.strictEqual(remoteHead(repos, "houston/7"), commit);
        assert.strictEqual(git(repos.bare, ["tag", "--list"]), "");
        assert.isFalse(NodeFS.existsSync(marker), "the checkout's pre-push hook ran");
      }),
    );
  });
});

describe("the lease refuses a push once the branch moved on the remote", () => {
  it.live("the lease refuses a push once the branch moved on the remote", () => {
    const github = makeGitHub(makeRepos());
    return withQueue(
      github,
      Effect.gen(function* () {
        const queue = yield* HoustonMergeQueueService;
        const projectId = yield* queueScenario(github, [7], { command: "git --version" });
        const entry = yield* verified(projectId, 7);
        // Someone pushes to the branch; GitHub's answer still shows the recorded head.
        github.pulls.get(7)!.headSha = entry.headSha;
        const theirs = pushBranch(github.repos!, "houston/7", { "theirs.txt": "theirs\n" });
        const failed = yield* refusal(
          queue.mergeHead({ projectId, number: 7, expectedHeadSha: entry.headSha }),
        );
        assert.include(failed.message, "the lease did not hold and nothing was overwritten");
        assert.strictEqual(remoteHead(github.repos!, "houston/7"), theirs);
        assert.deepEqual(mergesOf(github), []);
      }),
    );
  });
});

describe("a queue merge is logged, reported and moves the next entry up", () => {
  it.live("a queue merge is logged, reported and moves the next entry up", () => {
    const github = makeGitHub(makeRepos());
    return withQueue(
      github,
      Effect.scoped(
        Effect.gen(function* () {
          const queue = yield* HoustonMergeQueueService;
          const pullRequests = yield* PullRequestService.PullRequestService;
          const changes = yield* pullRequests.subscribeStateChanges;
          const projectId = yield* queueScenario(github, [1, 2], { command: "git --version" });
          const entry = yield* verified(projectId, 1);
          const baseBefore = remoteHead(github.repos!, "main")!;
          const result = yield* queue.mergeHead({
            projectId,
            number: 1,
            expectedHeadSha: entry.headSha,
          });
          assert.strictEqual(result.outcome, "merged", result.message);
          const baseAfter = remoteHead(github.repos!, "main")!;
          const snapshot = yield* queue.get({ projectId });
          const push = snapshot.log.filter((row) => row.kind === "push");
          const merge = snapshot.log.filter((row) => row.kind === "merge");
          assert.strictEqual(push.length, 1);
          assert.deepEqual(
            [push[0]!.refName, push[0]!.oldSha, push[0]!.newSha],
            ["houston/1", entry.headSha, entry.verification!.verifiedSha],
          );
          assert.strictEqual(merge.length, 1);
          assert.deepEqual(
            [
              merge[0]!.refName,
              merge[0]!.oldSha,
              merge[0]!.newSha,
              merge[0]!.headSha,
              merge[0]!.method,
            ],
            ["main", baseBefore, baseAfter, entry.verification!.verifiedSha, "squash"],
          );
          assert.deepEqual(
            github.reported.map((report) => [report.reference.number, report.state]),
            [[1, "merged"]],
          );
          const key = yield* Stream.runHead(changes);
          assert.strictEqual(key._tag === "Some" ? key.value.number : null, 1);
          assert.deepEqual(
            snapshot.entries.map((value) => [value.number, value.position]),
            [[2, 1]],
          );
          assert.strictEqual(entryOf(snapshot, 2).status, "waitingForSlot");
        }),
      ),
    );
  });
});

describe("a queue merge completes the linked task through the tasks rule", () => {
  it.live("a queue merge completes the linked task through the tasks rule", () => {
    const directory = import.meta.dirname;
    for (const file of NodeFS.readdirSync(directory, { recursive: true }).map(String)) {
      if (!file.endsWith(".ts") || file.includes(".test.") || file.includes("testkit")) continue;
      const text = NodeFS.readFileSync(NodePath.join(directory, file), "utf8");
      assert.notMatch(
        text,
        /(UPDATE|INSERT INTO)\s+houston_task|HoustonTaskService|setStatus|houston:pr-merged/,
        file,
      );
    }
    const github = makeGitHub(makeRepos());
    return withQueue(
      github,
      Effect.gen(function* () {
        const queue = yield* HoustonMergeQueueService;
        const projectId = yield* queueScenario(github, [1], { mainMoves: false });
        const head = entryOf(yield* queue.get({ projectId }), 1).headSha;
        yield* queue.mergeHead({ projectId, number: 1, expectedHeadSha: head });
        // The merge reaches the Tasks backlog only through upstream's pull request state.
        assert.deepEqual(
          github.reported.map((report) => ({
            projectId: report.reference.projectId,
            repository: report.reference.repository,
            number: report.reference.number,
            state: report.state,
          })),
          [{ projectId, repository: "o/r", number: 1, state: "merged" }],
        );
      }),
    );
  });
});
