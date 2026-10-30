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
  git,
  layerMergeQueueTest,
  makeRepos,
  pushBranch,
  remoteHead,
  type Repos,
} from "./mergeQueue.testkit.ts";
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

const checkoutState = (repos: Repos) => ({
  status: git(repos.checkout, ["status", "--porcelain"]),
  head: git(repos.checkout, ["rev-parse", "HEAD"]),
  symbolic: git(repos.checkout, ["symbolic-ref", "HEAD"]),
  index: NodeFS.readFileSync(NodePath.join(repos.checkout, ".git", "index")).toString("base64"),
  refs: git(repos.checkout, ["for-each-ref", "refs/heads", "refs/remotes"]),
});

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
        branchBehindMain(repos, { "README.md": "head edit\n", "a.txt": "a\n" });
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
      }),
    ),
  );
});

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
