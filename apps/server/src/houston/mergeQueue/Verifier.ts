// @effect-diagnostics nodeBuiltinImport:off - spawns the verification command as its own process
// group or tree, so a timeout can stop everything it started.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerConfig from "../../config.ts";
import * as VcsProcess from "../../vcs/VcsProcess.ts";
import { GIT_NETWORK_TIMEOUT_MS, git, gitOk, resolvesInside } from "./Project.ts";
import { keepTail, noForkPoint, reportTail, type VerifyOutcome } from "./rules.ts";

export type { VerifyOutcome } from "./rules.ts";

export interface VerifyRequest {
  /** The project's checkout; the scratch worktree is a worktree of its repository. */
  readonly repo: string;
  readonly remote: string;
  readonly baseRef: string;
  readonly headRef: string;
  readonly headSha: string;
  readonly command: string;
  readonly timeLimitMinutes: number;
  readonly scratch: string;
  /** The project root and managed worktrees directories the scratch path may not resolve into. */
  readonly protectedRoots: ReadonlyArray<string>;
  /** A dependency merged ahead of the entry: the restack replays only the entry's own commits. */
  readonly stack?: StackRequest | null;
}

export interface StackRequest {
  /** The merged dependency's head branch. */
  readonly dependency: string;
  /** Every head the queue recorded for the dependency (rules.recordedHeads). */
  readonly recordedHeads: ReadonlyArray<string>;
  /** Whether the pull request still targets the dependency's branch on GitHub. */
  readonly targetsDependency: boolean;
  readonly number?: number;
}

/** The private ref a branch is fetched into; the user's remote-tracking refs never move. */
export const queueRef = (remote: string, branch: string) =>
  `refs/houston/merge-queue/${remote}/${branch}`;

// The highest pid_t; u32::MAX cast to pid_t is -1, which signals every process.
const MAX_PID = 2_147_483_647;

/** Stops `pid` with its process group (POSIX) or tree (Windows); refuses a pid outside 2..2^31-1. */
export const killProcessTree = (
  pid: number,
  signal: (pid: number) => void = (target) => {
    if (process.platform === "win32") {
      NodeChildProcess.spawnSync("taskkill", ["/T", "/F", "/PID", String(target)], {
        stdio: "ignore",
        windowsHide: true,
      });
    } else {
      try {
        process.kill(-target, "SIGKILL");
      } catch {
        // The group already exited.
      }
    }
  },
): string | null => {
  if (!Number.isInteger(pid) || pid <= 1 || pid > MAX_PID) {
    return `refusing to kill process ${pid}: a pid must be an integer from 2 to ${MAX_PID}`;
  }
  signal(pid);
  return null;
};

/** How long the output may keep arriving after the shell exits. */
const OUTPUT_GRACE = Duration.seconds(2);

interface CommandRun {
  readonly code: number | null;
  readonly timedOut: boolean;
  readonly tail: string;
}

/** Runs `command` through the platform shell at below-normal priority, within `limit`. */
const runCommand = Effect.fn("HoustonMergeVerifier.runCommand")(function* (
  command: string,
  cwd: string,
  limit: Duration.Duration,
) {
  let kept: Uint8Array = new Uint8Array(0);
  const child = yield* Effect.try({
    try: () => {
      const spawned =
        process.platform === "win32"
          ? NodeChildProcess.spawn("cmd.exe", ["/d", "/s", "/c", `"${command}"`], {
              cwd,
              windowsVerbatimArguments: true,
              windowsHide: true,
              stdio: ["ignore", "pipe", "pipe"],
            })
          : NodeChildProcess.spawn("nice", ["-n", "10", "sh", "-c", command], {
              cwd,
              detached: true,
              stdio: ["ignore", "pipe", "pipe"],
            });
      if (process.platform === "win32" && spawned.pid !== undefined) {
        try {
          NodeOS.setPriority(spawned.pid, NodeOS.constants.priority.PRIORITY_BELOW_NORMAL);
        } catch {
          // The command already exited.
        }
      }
      const collect = (chunk: Buffer) => {
        kept = keepTail(kept, chunk);
      };
      spawned.stdout?.on("data", collect);
      spawned.stderr?.on("data", collect);
      return spawned;
    },
    catch: (error) => `could not start the verification command: ${String(error)}`,
  });
  // A process the command left running would hold the pipes and the scratch directory. Its POSIX
  // group outlives the shell; a Windows tree does not, so there it is left (plan, door 3).
  const killLeftovers = () => {
    if (process.platform !== "win32" && child.pid !== undefined) killProcessTree(child.pid);
  };
  // The shell's own exit, not `close`: a process it left behind can hold the pipes open.
  const exited = Effect.callback<number | null>((resume) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      killLeftovers();
      resume(Effect.succeed(child.exitCode));
      return;
    }
    child.once("exit", (code) => {
      killLeftovers();
      resume(Effect.succeed(code));
    });
    child.once("error", () => resume(Effect.succeed(null)));
  });
  const drained = Effect.callback<void>((resume) => {
    if (child.stdout === null || child.stdout.destroyed || child.stdout.readableEnded) {
      resume(Effect.void);
      return;
    }
    child.once("close", () => resume(Effect.void));
  }).pipe(Effect.timeoutOption(OUTPUT_GRACE));
  const stop = Effect.sync(() => {
    if (child.pid !== undefined && child.exitCode === null && child.signalCode === null) {
      killProcessTree(child.pid);
    }
  });
  const finished = yield* exited.pipe(
    Effect.timeoutOption(limit),
    Effect.onInterrupt(() => stop),
  );
  if (finished._tag === "None") {
    yield* stop;
    yield* exited.pipe(Effect.timeoutOption(Duration.seconds(10)));
  }
  yield* drained;
  return {
    code: finished._tag === "Some" ? finished.value : null,
    timedOut: finished._tag === "None",
    tail: reportTail(kept),
  } satisfies CommandRun;
});

export class HoustonMergeVerifier extends Context.Service<
  HoustonMergeVerifier,
  {
    /** `<baseDir>/houston/merge-queue/verify`: one directory serves the one slot. */
    readonly scratchPath: string;
    /** Fetch, rebase in the scratch worktree, run the command; the worktree is always removed. */
    readonly verify: (request: VerifyRequest) => Effect.Effect<VerifyOutcome>;
    /** Fetches `branches` of `remote` into the queue's private refs. */
    readonly fetch: (
      repo: string,
      remote: string,
      branches: ReadonlyArray<string>,
    ) => Effect.Effect<void, string>;
    /** The commit a branch's private ref names after the last fetch. */
    readonly remoteSha: (
      repo: string,
      remote: string,
      branch: string,
    ) => Effect.Effect<string, string>;
    /** Drops a branch's private ref once its entry leaves the queue. */
    readonly forget: (repo: string, remote: string, branch: string) => Effect.Effect<void>;
  }
>()("houston/houston/mergeQueue/Verifier/HoustonMergeVerifier") {}

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const vcs = yield* VcsProcess.VcsProcess;
  const scratchPath = NodePath.join(config.baseDir, "houston", "merge-queue", "verify");
  const withVcs = <A, E>(effect: Effect.Effect<A, E, VcsProcess.VcsProcess>) =>
    Effect.provideService(effect, VcsProcess.VcsProcess, vcs);

  const fetch: HoustonMergeVerifier["Service"]["fetch"] = (repo, remote, branches) =>
    withVcs(
      gitOk(
        repo,
        [
          "-c",
          "gc.auto=0",
          "-c",
          "maintenance.auto=false",
          "fetch",
          "--no-tags",
          "--quiet",
          // The checkout's FETCH_HEAD, submodules and other refs stay as the user left them.
          "--no-write-fetch-head",
          "--no-recurse-submodules",
          "--no-prune",
          // No configured refmap: refs/remotes/* stay where the user's own fetch left them.
          "--refmap=",
          remote,
          ...branches.map((branch) => `+refs/heads/${branch}:${queueRef(remote, branch)}`),
        ],
        GIT_NETWORK_TIMEOUT_MS,
      ),
    ).pipe(
      Effect.asVoid,
      Effect.mapError((error) => `fetching ${branches.join(", ")} from ${remote} failed: ${error}`),
    );

  const remoteSha: HoustonMergeVerifier["Service"]["remoteSha"] = (repo, remote, branch) =>
    withVcs(
      gitOk(repo, ["rev-parse", "--verify", "--quiet", `${queueRef(remote, branch)}^{commit}`]),
    ).pipe(Effect.mapError(() => `${remote}/${branch} does not name a commit after the fetch`));

  const forget: HoustonMergeVerifier["Service"]["forget"] = (repo, remote, branch) =>
    withVcs(git(repo, ["update-ref", "-d", queueRef(remote, branch)])).pipe(Effect.ignore);

  const removeScratch = Effect.fn("HoustonMergeVerifier.removeScratch")(function* (
    repo: string,
    scratch: string,
  ) {
    // Removes only the scratch's own registration, also when its directory is gone;
    // `worktree prune` would drop the user's other stale worktrees as well.
    const unregister = withVcs(git(repo, ["worktree", "remove", "--force", scratch])).pipe(
      Effect.ignore,
    );
    yield* unregister;
    if (NodeFS.existsSync(scratch)) {
      yield* Effect.sync(() => NodeFS.rmSync(scratch, { recursive: true, force: true })).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning(`Removing the scratch worktree ${scratch} failed.`, cause),
        ),
      );
      yield* unregister;
    }
  });

  /** `-c` pairs naming the head's author as committer when git config names nobody. */
  const committerFallback = Effect.fn("HoustonMergeVerifier.committerFallback")(function* (
    dir: string,
    headSha: string,
  ) {
    const missing: Array<string> = [];
    for (const key of ["user.name", "user.email"]) {
      const value = yield* withVcs(gitOk(dir, ["config", "--get", key])).pipe(
        Effect.orElseSucceed(() => ""),
      );
      if (value.length === 0) missing.push(key);
    }
    if (missing.length === 0) return [];
    const author = yield* withVcs(gitOk(dir, ["log", "-1", "--format=%an%x00%ae", headSha])).pipe(
      Effect.orElseSucceed(() => ""),
    );
    const [name, email] = author.split("\0");
    if (name === undefined || email === undefined) return [];
    return missing.flatMap((key) => ["-c", `${key}=${key === "user.name" ? name : email}`]);
  });

  const isAncestor = (repo: string, ancestor: string, descendant: string) =>
    withVcs(git(repo, ["merge-base", "--is-ancestor", ancestor, descendant])).pipe(
      Effect.map((result) => result.exitCode === 0),
      Effect.orElseSucceed(() => false),
    );

  /** The newest recorded dependency head the head contains; null rebases plainly. */
  const forkPoint = Effect.fn("HoustonMergeVerifier.forkPoint")(function* (
    request: VerifyRequest,
    stack: StackRequest,
    baseSha: string,
  ) {
    const contained: Array<{ readonly sha: string; readonly depth: number }> = [];
    for (const sha of stack.recordedHeads) {
      if (!(yield* isAncestor(request.repo, sha, request.headSha))) continue;
      const depth = yield* withVcs(gitOk(request.repo, ["rev-list", "--count", sha])).pipe(
        Effect.map(Number),
        Effect.orElseSucceed(() => 0),
      );
      contained.push({ sha, depth });
    }
    if (contained.length > 0) {
      return { fork: contained.toSorted((left, right) => right.depth - left.depth)[0]!.sha };
    }
    // The dependency's branch, when it is still on the remote, shows commits it shares.
    yield* fetch(request.repo, request.remote, [stack.dependency]).pipe(Effect.ignore);
    const dependencyHead = yield* remoteSha(request.repo, request.remote, stack.dependency).pipe(
      Effect.orElseSucceed(() => null),
    );
    yield* forget(request.repo, request.remote, stack.dependency);
    let carries = stack.targetsDependency;
    for (const sha of [
      ...stack.recordedHeads,
      ...(dependencyHead === null ? [] : [dependencyHead]),
    ]) {
      if (carries) break;
      const shared = yield* withVcs(gitOk(request.repo, ["merge-base", request.headSha, sha])).pipe(
        Effect.orElseSucceed(() => ""),
      );
      carries = shared.length > 0 && !(yield* isAncestor(request.repo, shared, baseSha));
    }
    if (!carries) return { fork: null };
    return {
      refusal: noForkPoint({
        label: stack.number === undefined ? request.headRef : `PR #${stack.number}`,
        headRef: request.headRef,
        dependencyRef: stack.dependency,
        baseRef: request.baseRef,
        recordedHeads: stack.recordedHeads,
      }),
    };
  });

  const inScratch = (request: VerifyRequest, baseSha: string, fork: string | null) =>
    Effect.gen(function* () {
      const scratch = request.scratch;
      yield* removeScratch(request.repo, scratch);
      yield* Effect.sync(() => NodeFS.mkdirSync(NodePath.dirname(scratch), { recursive: true }));
      yield* withVcs(
        gitOk(request.repo, ["worktree", "add", "--detach", "--force", scratch, request.headSha]),
      ).pipe(Effect.mapError((error) => `creating the scratch worktree failed: ${error}`));
      const identity = yield* committerFallback(scratch, request.headSha);
      const rebase = yield* withVcs(
        git(scratch, [
          ...identity,
          "-c",
          "rebase.autoSquash=false",
          "-c",
          "rebase.autoStash=false",
          // A git older than the key ignores it; --no-update-refs would fail there.
          "-c",
          "rebase.updateRefs=false",
          "rebase",
          ...(fork === null ? [baseSha] : ["--onto", baseSha, fork]),
        ]),
      );
      if (rebase.exitCode !== 0) {
        const unmerged = yield* withVcs(
          gitOk(scratch, ["diff", "--name-only", "--diff-filter=U", "-z"]),
        ).pipe(Effect.orElseSucceed(() => ""));
        yield* withVcs(git(scratch, ["rebase", "--abort"])).pipe(Effect.ignore);
        const files = unmerged.split("\0").filter((file) => file.length > 0);
        if (files.length === 0) {
          return yield* Effect.fail(
            `rebasing ${request.headRef} onto ${request.baseRef} at ${baseSha} failed: ${rebase.stderr.trim()}`,
          );
        }
        return { _tag: "Conflict", baseSha, files } satisfies VerifyOutcome;
      }
      const verifiedSha = yield* withVcs(gitOk(scratch, ["rev-parse", "HEAD"]));
      const run = yield* runCommand(
        request.command,
        scratch,
        Duration.minutes(request.timeLimitMinutes),
      );
      if (run.timedOut)
        return { _tag: "TimedOut", baseSha, tail: run.tail } satisfies VerifyOutcome;
      return run.code === 0
        ? ({
            _tag: "Passed",
            baseSha,
            verifiedSha,
            ...(fork === null ? {} : { forkSha: fork }),
          } satisfies VerifyOutcome)
        : ({ _tag: "Failed", baseSha, code: run.code, tail: run.tail } satisfies VerifyOutcome);
    }).pipe(Effect.ensuring(removeScratch(request.repo, request.scratch)));

  const verify: HoustonMergeVerifier["Service"]["verify"] = Effect.fn(
    "HoustonMergeVerifier.verify",
  )(
    function* (request) {
      const inside = request.protectedRoots.find((root) => resolvesInside(request.scratch, root));
      if (inside !== undefined) {
        return yield* Effect.fail(
          `refusing the scratch path ${request.scratch}: it resolves inside ${inside}, and the merge queue never verifies in the project checkout or a managed worktree`,
        );
      }
      yield* fetch(request.repo, request.remote, [request.baseRef, request.headRef]);
      const found = yield* remoteSha(request.repo, request.remote, request.headRef);
      if (found !== request.headSha) return { _tag: "HeadMoved", found } satisfies VerifyOutcome;
      const baseSha = yield* remoteSha(request.repo, request.remote, request.baseRef);
      const stack = request.stack ?? null;
      const point = stack === null ? { fork: null } : yield* forkPoint(request, stack, baseSha);
      if ("refusal" in point) {
        return { _tag: "Refused", message: point.refusal } satisfies VerifyOutcome;
      }
      return yield* inScratch(request, baseSha, point.fork);
    },
    Effect.catch((message: string) =>
      Effect.succeed({ _tag: "Refused", message } satisfies VerifyOutcome),
    ),
  );

  return HoustonMergeVerifier.of({ scratchPath, verify, fetch, remoteSha, forget });
});

export const layer = Layer.effect(HoustonMergeVerifier, make);
