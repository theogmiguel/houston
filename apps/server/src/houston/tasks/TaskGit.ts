// @effect-diagnostics nodeBuiltinImport:off - git runs as a child process; its exit status decides.
// The git reads and worktree repairs task runs need beyond the thread launcher: base and head
// commits, diff size, and recreating a removed worktree on its branch.
import { execFile } from "node:child_process";

import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export class HoustonTaskGitError extends Schema.TaggedError<HoustonTaskGitError>()(
  "HoustonTaskGitError",
  { cwd: Schema.String, args: Schema.Array(Schema.String), detail: Schema.String },
) {
  override get message(): string {
    return `git ${this.args.join(" ")} in ${this.cwd} failed: ${this.detail}`;
  }
}

/** `git <args>` in `cwd`, its stdout trimmed. */
export const git = (cwd: string, args: ReadonlyArray<string>) =>
  Effect.callback<string, HoustonTaskGitError>((resume) => {
    execFile(
      "git",
      ["-c", "core.autocrlf=false", ...args],
      { cwd, maxBuffer: 16 * 1024 * 1024, windowsHide: true },
      (error, stdout, stderr) => {
        resume(
          error === null
            ? Effect.succeed(stdout.trim())
            : Effect.fail(
                new HoustonTaskGitError({
                  cwd,
                  args: [...args],
                  detail: (stderr.trim() || error.message).slice(0, 2_000),
                }),
              ),
        );
      },
    );
  });

/** The commit `ref` names, or null when it names none. */
export const resolveCommit = (cwd: string, ref: string) =>
  git(cwd, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]).pipe(
    Effect.orElseSucceed(() => null),
    Effect.map((sha) => (sha === null || sha.length === 0 ? null : sha)),
  );

export const currentBranch = (cwd: string) =>
  git(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"]).pipe(Effect.orElseSucceed(() => null));

/** Whether the work tree at `cwd` has no uncommitted change, untracked files included. */
export const isClean = (cwd: string) =>
  git(cwd, ["status", "--porcelain"]).pipe(Effect.map((status) => status.length === 0));

/** Changed lines (added plus deleted) and files between two commits. */
export const diffSize = (cwd: string, base: string, head: string) =>
  git(cwd, ["diff", "--numstat", base, head]).pipe(
    Effect.map((numstat) => {
      const rows = numstat.split("\n").filter((row) => row.length > 0);
      let lines = 0;
      for (const row of rows) {
        const [added, deleted] = row.split("\t");
        // Binary files report "-"; they count as a file with no lines.
        lines += (Number(added) || 0) + (Number(deleted) || 0);
      }
      return { lines, files: rows.length };
    }),
  );

/** Whether `ancestor` is reachable from `descendant`. */
export const contains = (cwd: string, descendant: string, ancestor: string) =>
  git(cwd, ["merge-base", "--is-ancestor", ancestor, descendant]).pipe(
    Effect.as(true),
    Effect.orElseSucceed(() => false),
  );

/** A read-only review tree at exactly `commit`, apart from the implementer's worktree. */
export const addDetachedWorktree = (repo: string, path: string, commit: string) =>
  git(repo, ["worktree", "add", "-q", "--detach", path, commit]);

/** Removes the worktree at `path` and its registration, even when its folder is gone; every other
 * worktree of the repository, stale or not, stays registered. */
export const removeWorktree = (repo: string, path: string) =>
  git(repo, ["worktree", "remove", "--force", path]);

/** Recreates a removed worktree on `branch`, local or pushed; on `freshBranch` from `base` once
 * `base` contains the branch's changes. Returns the branch the worktree is on. */
export const recreateWorktree = Effect.fn("HoustonTaskGit.recreateWorktree")(function* (input: {
  readonly repo: string;
  readonly path: string;
  readonly branch: string;
  readonly base: string;
  readonly freshBranch: string;
}) {
  // A worktree whose folder was deleted is still registered; drop that registration only. When the
  // path is not registered there is nothing to drop, and `worktree add` reports any real problem.
  yield* removeWorktree(input.repo, input.path).pipe(Effect.ignore);
  const local = yield* resolveCommit(input.repo, `refs/heads/${input.branch}`);
  const pushed =
    local === null ? yield* resolveCommit(input.repo, `refs/remotes/origin/${input.branch}`) : null;
  const tip = local ?? pushed;
  const base = yield* resolveCommit(input.repo, input.base);
  if (tip === null || (base !== null && (yield* contains(input.repo, base, tip)))) {
    yield* git(input.repo, [
      "worktree",
      "add",
      "-q",
      "-b",
      input.freshBranch,
      input.path,
      input.base,
    ]);
    return input.freshBranch;
  }
  if (local !== null) {
    yield* git(input.repo, ["worktree", "add", "-q", input.path, input.branch]);
  } else {
    yield* git(input.repo, [
      "worktree",
      "add",
      "-q",
      "--track",
      "-b",
      input.branch,
      input.path,
      `origin/${input.branch}`,
    ]);
  }
  return input.branch;
});
