// @effect-diagnostics nodeBuiltinImport:off - inspects the temporary repositories and processes.
// The verification runner over real git: a scratch worktree, private fetch refs, the command's
// bounds, and a project checkout left byte-identical by every outcome.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";

import * as ServerConfig from "../../config.ts";
import { HoustonBuildSlot } from "./BuildSlot.ts";
import {
  addManagedWorktree,
  createProject,
  entryOf,
  git,
  githubMerges,
  layerMergeQueueTest,
  makeGitHub,
  makeRepos,
  openPull,
  pushBranch,
  remoteHead,
  tryGit,
  type Repos,
} from "./mergeQueue.testkit.ts";
import { HoustonMergeQueueReader } from "./Reader.ts";
import { HoustonMergeQueueRunner } from "./Runner.ts";
import { HoustonMergeQueueService } from "./Service.ts";
import { failureFor } from "./rules.ts";
import {
  HoustonMergeVerifier,
  killProcessTree,
  type VerifyOutcome,
  type VerifyRequest,
} from "./Verifier.ts";

const WINDOWS = process.platform === "win32";
// Real time: on the test clock through its live clock, in a live test directly.
const realSleep = (ms: number) => TestClock.withLive(Effect.sleep(`${ms} millis`));
const liveSleep = (ms: number) => Effect.sleep(`${ms} millis`);

const withVerifier = <A, E>(
  body: (
    verifier: HoustonMergeVerifier["Service"],
  ) => Effect.Effect<A, E, HoustonBuildSlot | ServerConfig.ServerConfig>,
) =>
  Effect.gen(function* () {
    const verifier = yield* HoustonMergeVerifier;
    return yield* body(verifier);
  }).pipe(Effect.provide(Layer.fresh(layerMergeQueueTest({ loops: false }))));

/** A branch `houston/7` off main, then main moves on, so the rebase makes a new commit. */
const branchBehindMain = (
  repos: Repos,
  files: Readonly<Record<string, string>> = { "a.txt": "a\n" },
) => {
  const head = pushBranch(repos, "houston/7", files);
  pushBranch(repos, "main", { "b.txt": "b\n" }, { message: "main moves" });
  return head;
};

const request = (
  repos: Repos,
  scratch: string,
  patch: Partial<VerifyRequest> = {},
): VerifyRequest => ({
  repo: repos.checkout,
  remote: "origin",
  baseRef: "main",
  headRef: "houston/7",
  headSha: remoteHead(repos, "houston/7")!,
  command: "git rev-parse HEAD",
  timeLimitMinutes: 30,
  scratch,
  protectedRoots: [repos.checkout],
  ...patch,
});

const scratchOf = (verifier: HoustonMergeVerifier["Service"]) => verifier.scratchPath;
const registered = (repos: Repos) =>
  git(repos.checkout, ["worktree", "list", "--porcelain"])
    .split("\n")
    .filter((line) => line.startsWith("worktree "));
const quoted = (path: string) => `"${path}"`;

const checkoutState = (repos: Repos) => {
  const dotGit = NodePath.join(repos.checkout, ".git");
  const submodule = NodePath.join(dotGit, "modules", "sub");
  const fetchHead = NodePath.join(dotGit, "FETCH_HEAD");
  return {
    status: git(repos.checkout, ["status", "--porcelain"]),
    head: git(repos.checkout, ["rev-parse", "HEAD"]),
    symbolic: git(repos.checkout, ["symbolic-ref", "HEAD"]),
    index: NodeFS.readFileSync(NodePath.join(dotGit, "index")).toString("base64"),
    refs: git(repos.checkout, ["for-each-ref", "refs/heads", "refs/remotes"]),
    submoduleRefs: NodeFS.existsSync(submodule) ? git(submodule, ["for-each-ref"]) : null,
    fetchHead: NodeFS.existsSync(fetchHead) ? NodeFS.readFileSync(fetchHead, "utf8") : null,
  };
};

/** Commits `sub` as a gitlink to `sha` (and `.gitmodules` naming `url`) on `branch` and pushes it. */
const pushGitlink = (repos: Repos, branch: string, sha: string, url: string) => {
  const work = NodePath.join(
    repos.root,
    `gitlink-${branch.replaceAll("/", "-")}-${sha.slice(0, 7)}`,
  );
  git(repos.root, ["clone", "--quiet", repos.bare, work]);
  const from = tryGit(work, ["rev-parse", "--verify", `origin/${branch}`]) ?? "origin/main";
  git(work, ["checkout", "--quiet", "-B", branch, from]);
  NodeFS.writeFileSync(
    NodePath.join(work, ".gitmodules"),
    `[submodule "sub"]\n\tpath = sub\n\turl = ${url}\n`,
  );
  git(work, ["add", ".gitmodules"]);
  git(work, ["update-index", "--add", "--cacheinfo", `160000,${sha},sub`]);
  git(work, ["commit", "--quiet", "-m", `sub at ${sha.slice(0, 7)}`]);
  git(work, ["push", "--quiet", "--force", "origin", `HEAD:refs/heads/${branch}`]);
  const head = git(work, ["rev-parse", "HEAD"]);
  NodeFS.rmSync(work, { recursive: true, force: true });
  return head;
};

/** A repository for the submodule with one commit on main; `advance` adds another. */
const makeSubmoduleRemote = (repos: Repos) => {
  const bare = NodePath.join(repos.root, "sub.git");
  const seed = NodePath.join(repos.root, "sub-seed");
  git(repos.root, ["init", "--bare", "--initial-branch=main", bare]);
  git(repos.root, ["init", "--initial-branch=main", seed]);
  const commit = (text: string) => {
    NodeFS.writeFileSync(NodePath.join(seed, "sub.txt"), text);
    git(seed, ["add", "."]);
    git(seed, ["commit", "--quiet", "-m", text.trim()]);
    git(seed, ["push", "--quiet", bare, "main"]);
    return git(seed, ["rev-parse", "HEAD"]);
  };
  return {
    url: bare.replaceAll("\\", "/"),
    first: commit("one\n"),
    advance: () => commit("two\n"),
  };
};

/** A hook that records that it ran; the queue's git must run none of the checkout's hooks. */
const installHooks = (repos: Repos, marker: string) => {
  const hooks = NodePath.join(repos.checkout, ".git", "hooks");
  for (const hook of ["post-checkout", "pre-rebase", "post-rewrite", "reference-transaction"]) {
    NodeFS.writeFileSync(
      NodePath.join(hooks, hook),
      `#!/bin/sh\necho ${hook} >> "${marker.replaceAll("\\", "/")}"\n`,
      { mode: 0o755 },
    );
  }
};

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const passed = (outcome: VerifyOutcome) => {
  assert.strictEqual(outcome._tag, "Passed", JSON.stringify(outcome));
  return outcome as Extract<VerifyOutcome, { _tag: "Passed" }>;
};

describe("a verification rebases in a scratch worktree and records the verified commit", () => {
  it.live("a verification rebases in a scratch worktree and records the verified commit", () =>
    withVerifier((verifier) =>
      Effect.gen(function* () {
        const repos = makeRepos();
        const head = branchBehindMain(repos);
        const base = remoteHead(repos, "main")!;
        const out = NodePath.join(repos.root, "verified.txt");
        const scratch = scratchOf(verifier);
        const outcome = passed(
          yield* verifier.verify(
            request(repos, scratch, { command: `git rev-parse HEAD > ${quoted(out)}` }),
          ),
        );
        assert.strictEqual(outcome.baseSha, base);
        assert.notStrictEqual(outcome.verifiedSha, head);
        // The command ran on the verified commit, whose parent is the fetched base.
        assert.strictEqual(NodeFS.readFileSync(out, "utf8").trim(), outcome.verifiedSha);
        assert.strictEqual(git(repos.checkout, ["rev-parse", `${outcome.verifiedSha}^`]), base);
        assert.strictEqual(
          git(repos.checkout, ["rev-parse", "refs/houston/merge-queue/origin/main"]),
          base,
        );
        assert.strictEqual(
          git(repos.checkout, ["rev-parse", "refs/houston/merge-queue/origin/houston/7"]),
          head,
        );
        assert.isTrue(scratch.endsWith(NodePath.join("houston", "merge-queue", "verify")));
        const config = yield* ServerConfig.ServerConfig;
        assert.isTrue(scratch.startsWith(config.baseDir));
        assert.isFalse(NodeFS.existsSync(scratch));
        assert.deepEqual(registered(repos), [`worktree ${repos.checkout.replaceAll("\\", "/")}`]);
      }),
    ),
  );
});

describe("a moved head is not verified", () => {
  it.live("a moved head is not verified", () =>
    withVerifier((verifier) =>
      Effect.gen(function* () {
        const repos = makeRepos();
        const recorded = branchBehindMain(repos);
        const moved = pushBranch(repos, "houston/7", { "a.txt": "moved\n" });
        const marker = NodePath.join(repos.root, "ran.txt");
        const slot = yield* HoustonBuildSlot;
        const outcome = yield* slot.withSlot(
          "project-moved #7",
          verifier.verify(
            request(repos, scratchOf(verifier), {
              headSha: recorded,
              command: `git rev-parse HEAD > ${quoted(marker)}`,
            }),
          ),
        );
        assert.deepEqual(outcome._tag === "Some" ? outcome.value : null, {
          _tag: "HeadMoved",
          found: moved,
        });
        assert.isFalse(NodeFS.existsSync(marker));
        assert.isNull(yield* slot.holder);
      }),
    ),
  );
});

describe("the project checkout is unchanged by every outcome", () => {
  it.live("the project checkout is unchanged by every outcome", () =>
    withVerifier((verifier) =>
      Effect.gen(function* () {
        const repos = makeRepos();
        // An initialised submodule whose gitlink the head moves, so a recursing fetch would
        // move the submodule's remote-tracking refs.
        const sub = makeSubmoduleRemote(repos);
        pushGitlink(repos, "main", sub.first, sub.url);
        git(repos.checkout, ["pull", "--quiet", "--ff-only", "origin", "main"]);
        git(repos.checkout, ["-c", "protocol.file.allow=always", "submodule", "update", "--init"]);
        git(NodePath.join(repos.checkout, ".git", "modules", "sub"), [
          "config",
          "protocol.file.allow",
          "always",
        ]);
        git(repos.checkout, ["config", "protocol.file.allow", "always"]);
        branchBehindMain(repos, { "README.md": "head edit\n", "a.txt": "a\n" });
        const head = pushGitlink(repos, "houston/7", sub.advance(), sub.url);
        // The user's config moves every local branch in a rebased range, signs every commit
        // with a program that fails, replays recorded resolutions and recurses into submodules.
        for (const [key, value] of [
          ["rebase.updateRefs", "true"],
          ["commit.gpgSign", "true"],
          ["gpg.program", "houston-no-such-gpg"],
          ["rerere.enabled", "true"],
          ["submodule.recurse", "true"],
          ["fetch.recurseSubmodules", "true"],
          ["fetch.prune", "true"],
          ["fetch.pruneTags", "true"],
        ] as const) {
          git(repos.checkout, ["config", key, value]);
        }
        // Local branches on the head and on its parent, checked out nowhere; FETCH_HEAD written.
        git(repos.checkout, [
          "fetch",
          "--quiet",
          "--no-recurse-submodules",
          "origin",
          `+houston/7:refs/heads/houston/x`,
        ]);
        git(repos.checkout, ["branch", "houston/stack", `${head}^`]);
        const marker = NodePath.join(repos.root, "hooks.txt");
        installHooks(repos, marker);
        // An uncommitted edit, a staged file and an untracked one in the user's checkout.
        NodeFS.writeFileSync(NodePath.join(repos.checkout, "README.md"), "user edit\n");
        NodeFS.writeFileSync(NodePath.join(repos.checkout, "staged.txt"), "staged\n");
        git(repos.checkout, ["add", "staged.txt"]);
        NodeFS.writeFileSync(NodePath.join(repos.checkout, "untracked.txt"), "untracked\n");
        const before = checkoutState(repos);
        const scratch = scratchOf(verifier);

        const pass = yield* verifier.verify(request(repos, scratch, { command: "git --version" }));
        assert.strictEqual(pass._tag, "Passed", JSON.stringify(pass));
        assert.deepEqual(checkoutState(repos), before);

        const fail = yield* verifier.verify(request(repos, scratch, { command: "exit 3" }));
        assert.strictEqual(fail._tag, "Failed", JSON.stringify(fail));
        assert.deepEqual(checkoutState(repos), before);

        // main now conflicts with the head's README.md.
        pushBranch(repos, "main", { "README.md": "main edit\n" });
        const conflict = yield* verifier.verify(request(repos, scratch));
        assert.strictEqual(conflict._tag, "Conflict", JSON.stringify(conflict));
        assert.deepEqual(checkoutState(repos), before);
        assert.isFalse(NodeFS.existsSync(scratch));
        assert.isFalse(NodeFS.existsSync(marker), "a hook of the checkout ran");
      }),
    ),
  );

  it.live("the project checkout is unchanged by every outcome: a restack", () =>
    withVerifier((verifier) =>
      Effect.gen(function* () {
        const repos = makeRepos();
        const one = pushBranch(repos, "houston/one", { "1.txt": "one\n" });
        const two = pushBranch(repos, "houston/two", { "2.txt": "two\n" }, { from: "houston/one" });
        pushBranch(repos, "main", { "main.txt": "moved\n" });
        const marker = NodePath.join(repos.root, "hooks.txt");
        hostileConfig(repos, marker, two);
        const before = checkoutState(repos);
        const scratch = scratchOf(verifier);
        const outcome = yield* verifier.verify(
          request(repos, scratch, {
            headRef: "houston/two",
            headSha: two,
            command: "git --version",
            stack: { dependency: "houston/one", recordedHeads: [one], targetsDependency: true },
          }),
        );
        const restacked = passed(outcome);
        assert.strictEqual(restacked.forkSha, one);
        assert.deepEqual(checkoutState(repos), before);
        assert.isFalse(NodeFS.existsSync(scratch));
        assert.isFalse(NodeFS.existsSync(marker), "a hook of the checkout ran");
      }),
    ),
  );

  it.live("the project checkout is unchanged by every outcome: a restack handed off", () => {
    const repos = makeRepos();
    const github = makeGitHub(repos);
    github.autoMergeAllowed = true;
    return Effect.gen(function* () {
      const queue = yield* HoustonMergeQueueService;
      const runner = yield* HoustonMergeQueueRunner;
      const reader = yield* HoustonMergeQueueReader;
      const config = yield* ServerConfig.ServerConfig;
      pushBranch(repos, "houston/one", { "1.txt": "one\n" });
      const two = pushBranch(repos, "houston/two", { "2.txt": "two\n" }, { from: "houston/one" });
      pushBranch(repos, "main", { "main.txt": "moved\n" });
      openPull(github, 1, { headRef: "houston/one" });
      openPull(github, 2, { headRef: "houston/two", baseRef: "houston/one" });
      for (const branch of ["houston/one", "houston/two"]) {
        addManagedWorktree(repos, config.worktreesDir, branch);
      }
      const marker = NodePath.join(repos.root, "hooks.txt");
      hostileConfig(repos, marker, two);
      const projectId = yield* createProject("checkout-handoff", repos.checkout);
      yield* queue.setSettings({
        projectId,
        mergeWhenVerified: true,
        verificationCommand: "git --version",
        timeLimitMinutes: 30,
      });
      yield* queue.enqueue({ projectId, pullRequest: 1 });
      yield* queue.enqueue({ projectId, pullRequest: 2, dependsOn: 1 });
      const before = checkoutState(repos);

      yield* runner.pass;
      assert.strictEqual(entryOf(yield* queue.get({ projectId }), 1).status, "watching");
      githubMerges(github, 1);
      yield* reader.readProject(projectId);
      yield* runner.pass;
      const held = entryOf(yield* queue.get({ projectId }), 2);
      assert.strictEqual(held.status, "watching", JSON.stringify(held));
      assert.strictEqual(github.pulls.get(2)!.baseRef, "main");

      // The lease push records where it left each pushed branch, as git does for its remote;
      // nothing else in the checkout moved.
      const after = checkoutState(repos);
      const pushed = ["refs/remotes/origin/houston/one", "refs/remotes/origin/houston/two"];
      const without = (refs: string) =>
        refs
          .split("\n")
          .filter((line) => !pushed.some((ref) => line.endsWith(`\t${ref}`)))
          .join("\n");
      assert.deepEqual(
        { ...after, refs: without(after.refs) },
        { ...before, refs: without(before.refs) },
      );
      for (const ref of pushed) {
        const line = after.refs.split("\n").find((value) => value.endsWith(`\t${ref}`));
        if (line !== undefined) {
          assert.strictEqual(
            line.split(" ")[0],
            remoteHead(repos, ref.slice("refs/remotes/origin/".length)),
          );
        }
      }
      assert.isFalse(NodeFS.existsSync(marker), "a hook of the checkout ran");
    }).pipe(Effect.provide(Layer.fresh(layerMergeQueueTest({ github, loops: false }))));
  });
});

/** The user's config that would move branches, sign, recurse or run hooks; local branches beside. */
const hostileConfig = (repos: Repos, marker: string, head: string) => {
  for (const [key, value] of [
    ["rebase.updateRefs", "true"],
    ["commit.gpgSign", "true"],
    ["gpg.program", "houston-no-such-gpg"],
    ["rerere.enabled", "true"],
    ["submodule.recurse", "true"],
    ["fetch.recurseSubmodules", "true"],
    ["fetch.prune", "true"],
    ["fetch.pruneTags", "true"],
    ["push.followTags", "true"],
    ["push.gpgSign", "true"],
  ] as const) {
    git(repos.checkout, ["config", key, value]);
  }
  git(repos.checkout, ["fetch", "--quiet", "origin", `+${head}:refs/heads/houston/x`]);
  git(repos.checkout, ["branch", "houston/stack", `${head}^`]);
  git(repos.checkout, ["tag", "-a", "user-tag", "-m", "the user's", head]);
  installHooks(repos, marker);
  const hooks = NodePath.join(repos.checkout, ".git", "hooks");
  NodeFS.writeFileSync(
    NodePath.join(hooks, "pre-push"),
    `#!/bin/sh\necho pre-push >> "${marker.replaceAll("\\", "/")}"\n`,
    { mode: 0o755 },
  );
  NodeFS.writeFileSync(NodePath.join(repos.checkout, "README.md"), "user edit\n");
  NodeFS.writeFileSync(NodePath.join(repos.checkout, "untracked.txt"), "untracked\n");
};

describe("a scratch path inside the checkout or a managed worktree is refused", () => {
  it.live("a scratch path inside the checkout or a managed worktree is refused", () =>
    withVerifier((verifier) =>
      Effect.gen(function* () {
        const repos = makeRepos();
        branchBehindMain(repos);
        const managed = NodePath.join(repos.root, "managed");
        NodeFS.mkdirSync(managed);
        const outside = NodePath.join(repos.root, "outside");
        NodeFS.mkdirSync(outside);
        const linkToCheckout = NodePath.join(outside, "to-checkout");
        const linkToManaged = NodePath.join(outside, "to-managed");
        NodeFS.symlinkSync(repos.checkout, linkToCheckout, "junction");
        NodeFS.symlinkSync(managed, linkToManaged, "junction");
        const candidates = [
          NodePath.join(repos.checkout, "verify"),
          NodePath.join(managed, "r", "verify"),
          NodePath.join(linkToCheckout, "verify"),
          NodePath.join(linkToManaged, "verify"),
        ];
        const before = registered(repos);
        for (const scratch of candidates) {
          const outcome = yield* verifier.verify(
            request(repos, scratch, { protectedRoots: [repos.checkout, managed] }),
          );
          assert.strictEqual(outcome._tag, "Refused", scratch);
          assert.include((outcome as { message: string }).message, scratch);
          assert.isFalse(NodeFS.existsSync(scratch), scratch);
        }
        assert.deepEqual(registered(repos), before);
        assert.isNull(
          (() => {
            try {
              return git(repos.checkout, [
                "rev-parse",
                "--verify",
                "refs/houston/merge-queue/origin/main",
              ]);
            } catch {
              return null;
            }
          })(),
        );
      }),
    ),
  );
});

describe("the command runs below normal priority in the scratch worktree", () => {
  it.live("the command runs below normal priority in the scratch worktree", () =>
    withVerifier((verifier) =>
      Effect.gen(function* () {
        const repos = makeRepos();
        branchBehindMain(repos);
        const where = NodePath.join(repos.root, "where.txt");
        const priority = NodePath.join(repos.root, "priority.txt");
        const scratch = scratchOf(verifier);
        const command = WINDOWS
          ? `cd > ${quoted(where)} && powershell -NoProfile -Command "[System.Diagnostics.Process]::GetCurrentProcess().PriorityClass" > ${quoted(priority)}`
          : `pwd -P > ${quoted(where)} && nice > ${quoted(priority)}`;
        passed(yield* verifier.verify(request(repos, scratch, { command })));
        // The scratch worktree is gone by now; the base dir is already a real path.
        assert.strictEqual(
          NodeFS.readFileSync(where, "utf8").trim().toLowerCase(),
          scratch.toLowerCase(),
        );
        assert.strictEqual(
          NodeFS.readFileSync(priority, "utf8").trim(),
          WINDOWS ? "BelowNormal" : String(NodeOS.getPriority() + 10),
        );

        const failed = yield* verifier.verify(request(repos, scratch, { command: "exit 3" }));
        assert.deepEqual(
          { tag: failed._tag, code: (failed as { code?: number | null }).code },
          { tag: "Failed", code: 3 },
        );
        const failure = failureFor(failed, {
          command: "exit 3",
          baseRef: "main",
          headSha: remoteHead(repos, "houston/7")!,
          timeLimitMinutes: 30,
          at: "2026-10-30T10:00:00.000Z",
        });
        assert.strictEqual(failure?.kind, "failed");
        assert.include(failure?.message, "exit 3");
        assert.include(failure?.message, "main@");
      }),
    ),
  );
});

describe("a command past its limit times out and its children are gone", () => {
  it.effect("a command past its limit times out and its children are gone", () =>
    withVerifier((verifier) =>
      Effect.gen(function* () {
        const repos = makeRepos();
        branchBehindMain(repos);
        const shellPid = NodePath.join(repos.root, "shell.pid");
        const childPid = NodePath.join(repos.root, "child.pid");
        const command = WINDOWS
          ? `powershell -NoProfile -Command "$c = Start-Process -PassThru -WindowStyle Hidden powershell -ArgumentList '-NoProfile','-Command','Start-Sleep 600'; Set-Content -Path '${childPid}' -Value $c.Id; Set-Content -Path '${shellPid}' -Value $PID; Write-Output 'started the child'; Start-Sleep 600"`
          : `echo started the child; sleep 600 & echo $! > ${quoted(childPid)}; echo $$ > ${quoted(shellPid)}; wait`;
        const slot = yield* HoustonBuildSlot;
        const fiber = yield* slot
          .withSlot(
            "project-timeout #7",
            verifier.verify(request(repos, scratchOf(verifier), { command, timeLimitMinutes: 1 })),
          )
          .pipe(Effect.forkChild);
        for (let waited = 0; waited < 600; waited += 1) {
          if (NodeFS.existsSync(shellPid) && NodeFS.existsSync(childPid)) break;
          yield* realSleep(50);
        }
        yield* realSleep(200);
        const pids = [shellPid, childPid].map((file) =>
          Number(NodeFS.readFileSync(file, "utf8").trim()),
        );
        assert.isTrue(pids.every(alive), `both started: ${pids.join(", ")}`);
        assert.strictEqual(yield* slot.holder, "project-timeout #7");
        yield* TestClock.adjust("1 minute");
        const outcome = yield* Fiber.join(fiber);
        const value = outcome._tag === "Some" ? outcome.value : null;
        assert.strictEqual(value?._tag, "TimedOut", JSON.stringify(value));
        assert.include((value as { tail: string }).tail, "started the child");
        for (let waited = 0; waited < 100 && pids.some(alive); waited += 1) yield* realSleep(50);
        assert.deepEqual(pids.filter(alive), []);
        assert.isNull(yield* slot.holder);
        assert.isFalse(NodeFS.existsSync(scratchOf(verifier)));
      }),
    ),
  );
});

describe("a process the command leaves running is killed when it exits", () => {
  it.live("a process the command leaves running is killed when it exits", () =>
    withVerifier((verifier) =>
      Effect.gen(function* () {
        const repos = makeRepos();
        branchBehindMain(repos);
        const childPid = NodePath.join(repos.root, "child.pid");
        const command = WINDOWS
          ? `powershell -NoProfile -Command "$c = Start-Process -PassThru -WindowStyle Hidden powershell -ArgumentList '-NoProfile','-Command','Start-Sleep 600'; Set-Content -Path '${childPid}' -Value $c.Id"`
          : `sleep 600 > /dev/null 2>&1 & echo $! > ${quoted(childPid)}; exit 0`;
        const slot = yield* HoustonBuildSlot;
        const scratch = scratchOf(verifier);
        const outcome = yield* slot.withSlot(
          "project-leftover #7",
          verifier.verify(request(repos, scratch, { command })),
        );
        const value = outcome._tag === "Some" ? outcome.value : null;
        assert.strictEqual(value?._tag, "Passed", JSON.stringify(value));
        assert.isNull(yield* slot.holder);
        const pid = Number(NodeFS.readFileSync(childPid, "utf8").trim());
        if (WINDOWS) {
          // A Windows tree ends with its shell: the leftover lives on and may hold the scratch
          // directory, which the next verification replaces once it is free.
          assert.isTrue(alive(pid), `the leftover ${pid} is still running`);
          killProcessTree(pid);
          for (let waited = 0; waited < 100 && alive(pid); waited += 1) yield* liveSleep(50);
          passed(yield* verifier.verify(request(repos, scratch)));
        } else {
          for (let waited = 0; waited < 100 && alive(pid); waited += 1) yield* liveSleep(50);
          assert.isFalse(alive(pid), `the leftover ${pid} is still running`);
        }
        assert.isFalse(NodeFS.existsSync(scratch));
        assert.deepEqual(registered(repos), [`worktree ${repos.checkout.replaceAll("\\", "/")}`]);
      }),
    ),
  );
});

describe("the kill refuses a pid that is not an integer above 1", () => {
  it.live("the kill refuses a pid that is not an integer above 1", () =>
    Effect.gen(function* () {
      const signalled: Array<number> = [];
      for (const pid of [0, 1, -1, 4_294_967_295, 1.5, Number.NaN]) {
        const refusal = killProcessTree(pid, (target) => signalled.push(target));
        assert.isString(refusal, String(pid));
        assert.include(refusal, String(pid));
      }
      assert.deepEqual(signalled, []);

      const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "houston-mq-kill-"));
      const childPid = NodePath.join(root, "child.pid");
      const parent = WINDOWS
        ? NodeChildProcess.spawn(
            "powershell",
            [
              "-NoProfile",
              "-Command",
              `$c = Start-Process -PassThru -WindowStyle Hidden powershell -ArgumentList '-NoProfile','-Command','Start-Sleep 600'; Set-Content -Path '${childPid}' -Value $c.Id; Start-Sleep 600`,
            ],
            { stdio: "ignore", windowsHide: true },
          )
        : NodeChildProcess.spawn("sh", ["-c", `sleep 600 & echo $! > "${childPid}"; wait`], {
            stdio: "ignore",
            detached: true,
          });
      for (let waited = 0; waited < 600 && !NodeFS.existsSync(childPid); waited += 1) {
        yield* liveSleep(50);
      }
      yield* liveSleep(200);
      const pids = [parent.pid!, Number(NodeFS.readFileSync(childPid, "utf8").trim())];
      assert.isTrue(pids.every(alive));
      assert.isNull(killProcessTree(parent.pid!));
      for (let waited = 0; waited < 100 && pids.some(alive); waited += 1) yield* liveSleep(50);
      assert.deepEqual(pids.filter(alive), []);
    }),
  );
});

describe("a conflict or a git failure is recorded and the scratch worktree removed", () => {
  it.live("a conflict or a git failure is recorded and the scratch worktree removed", () =>
    withVerifier((verifier) =>
      Effect.gen(function* () {
        const repos = makeRepos();
        const head = pushBranch(repos, "houston/7", { "README.md": "head\n", "two.txt": "head\n" });
        pushBranch(repos, "main", { "README.md": "main\n", "two.txt": "main\n" });
        const base = remoteHead(repos, "main")!;
        const scratch = scratchOf(verifier);
        const conflict = yield* verifier.verify(request(repos, scratch));
        assert.strictEqual(conflict._tag, "Conflict", JSON.stringify(conflict));
        assert.deepEqual([...(conflict._tag === "Conflict" ? conflict.files : [])].sort(), [
          "README.md",
          "two.txt",
        ]);
        const failure = failureFor(conflict, {
          command: "git rev-parse HEAD",
          baseRef: "main",
          headSha: head,
          timeLimitMinutes: 30,
          at: "2026-10-30T10:00:00.000Z",
        });
        assert.strictEqual(failure?.kind, "conflict");
        assert.include(
          failure?.message,
          `Rebasing onto main@${base.slice(0, 7)} stopped on a conflict in 2 files`,
        );
        assert.deepEqual([...(failure?.files ?? [])].sort(), ["README.md", "two.txt"]);
        assert.isFalse(NodeFS.existsSync(scratch));
        assert.strictEqual(registered(repos).length, 1);

        const fetchFails = yield* verifier.verify(request(repos, scratch, { remote: "nowhere" }));
        assert.strictEqual(fetchFails._tag, "Refused", JSON.stringify(fetchFails));
        assert.include((fetchFails as { message: string }).message, "nowhere");
        const refused = failureFor(fetchFails, {
          command: "git rev-parse HEAD",
          baseRef: "main",
          headSha: head,
          timeLimitMinutes: 30,
          at: "2026-10-30T10:00:00.000Z",
        });
        assert.strictEqual(refused?.kind, "refused");
        assert.isFalse(NodeFS.existsSync(scratch));
        assert.strictEqual(registered(repos).length, 1);
      }),
    ),
  );
});

describe("a rebase needs no configured git identity", () => {
  it.live("a rebase needs no configured git identity", () =>
    Effect.gen(function* () {
      const repos = makeRepos();
      const head = branchBehindMain(repos);
      // No global or system identity for the server's git, and none in the repository.
      const emptyGlobal = NodePath.join(repos.root, "empty.gitconfig");
      NodeFS.writeFileSync(emptyGlobal, "");
      const saved = {
        GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL,
        GIT_CONFIG_NOSYSTEM: process.env.GIT_CONFIG_NOSYSTEM,
      };
      process.env.GIT_CONFIG_GLOBAL = emptyGlobal;
      process.env.GIT_CONFIG_NOSYSTEM = "1";
      const isolated = { ...process.env };
      delete isolated.GIT_AUTHOR_NAME;
      delete isolated.GIT_AUTHOR_EMAIL;
      delete isolated.GIT_COMMITTER_NAME;
      delete isolated.GIT_COMMITTER_EMAIL;
      try {
        const name = () => {
          try {
            return git(repos.checkout, ["config", "--get", "user.name"], isolated);
          } catch {
            return "";
          }
        };
        assert.strictEqual(name(), "");
        const outcome = yield* withVerifier((verifier) =>
          verifier.verify(request(repos, scratchOf(verifier), { headSha: head })),
        );
        const verified = passed(outcome).verifiedSha;
        assert.strictEqual(
          git(repos.checkout, ["log", "-1", "--format=%cn <%ce>", verified], isolated),
          git(repos.checkout, ["log", "-1", "--format=%an <%ae>", head], isolated),
        );
        assert.strictEqual(name(), "");
        assert.notInclude(
          NodeFS.readFileSync(NodePath.join(repos.checkout, ".git", "config"), "utf8"),
          "[user]",
        );
      } finally {
        for (const [key, value] of Object.entries(saved)) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
      }
    }),
  );
});
