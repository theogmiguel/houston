// @effect-diagnostics nodeBuiltinImport:off - git runs as a child process in the project's root.
// The git Night shift runs: local reads of the origin and the default branch, and the one network
// read of the remote heads at a run's start and settle.
import * as NodeChildProcess from "node:child_process";

import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

export type OriginReading =
  | { readonly kind: "notRepository" }
  | { readonly kind: "noOrigin" }
  | { readonly kind: "origin"; readonly url: string; readonly host: string };

export class NightShiftGit extends Context.Service<
  NightShiftGit,
  {
    /** Local: whether `root` is a repository and where its `origin` points. */
    readonly origin: (root: string) => Effect.Effect<OriginReading>;
    /** Local: the default branch as `origin/HEAD` names it, else the checked-out one, and its head. */
    readonly defaultBranch: (
      root: string,
    ) => Effect.Effect<{ readonly branch: string; readonly sha: string }, string>;
    /** Network: `git ls-remote --heads origin`, ref to sha. */
    readonly lsRemoteHeads: (root: string) => Effect.Effect<Readonly<Record<string, string>>, string>;
  }
>()("houston/houston/nightShift/Git/NightShiftGit") {}

const run = (
  environment: NodeJS.ProcessEnv,
  root: string,
  args: ReadonlyArray<string>,
  timeout = 15_000,
) =>
  Effect.callback<string, string>((resume) => {
    NodeChildProcess.execFile(
      "git",
      ["-C", root, ...args],
      {
        encoding: "utf8",
        timeout,
        windowsHide: true,
        env: { ...environment, GIT_TERMINAL_PROMPT: "0" },
      },
      (error, stdout, stderr) => {
        if (error === null) resume(Effect.succeed(stdout));
        else resume(Effect.fail(`git ${args.join(" ")} failed: ${(stderr || error.message).trim()}`));
      },
    );
  });

/** The host of a remote URL in the https, ssh or scp form. */
export const remoteHost = (url: string): string => {
  const trimmed = url.trim();
  const scp = /^[^@/:]+@([^:/]+):/.exec(trimmed);
  if (scp !== null) return scp[1]!.toLowerCase();
  try {
    return new URL(trimmed).hostname.toLowerCase();
  } catch {
    return "";
  }
};

export const layer = Layer.effect(
  NightShiftGit,
  Effect.gen(function* () {
    const environment = yield* HostProcess.Environment;
    const git = (root: string, args: ReadonlyArray<string>, timeout?: number) =>
      run(environment, root, args, timeout);
    return NightShiftGit.of({
    origin: Effect.fn("NightShiftGit.origin")(function* (root) {
        const inside = yield* git(root, ["rev-parse", "--is-inside-work-tree"]).pipe(
          Effect.map((out) => out.trim() === "true"),
          Effect.orElseSucceed(() => false),
        );
        if (!inside) return { kind: "notRepository" } as const;
        const url = yield* git(root, ["remote", "get-url", "origin"]).pipe(
          Effect.map((out) => out.trim()),
          Effect.orElseSucceed(() => ""),
        );
        if (url === "") return { kind: "noOrigin" } as const;
        return { kind: "origin", url, host: remoteHost(url) } as const;
      }),
    defaultBranch: Effect.fn("NightShiftGit.defaultBranch")(function* (root) {
        const remoteHead = yield* git(root, [
          "symbolic-ref",
          "--quiet",
          "--short",
          "refs/remotes/origin/HEAD",
        ]).pipe(
          Effect.map((out) => out.trim()),
          Effect.orElseSucceed(() => ""),
        );
        const ref =
          remoteHead !== ""
            ? remoteHead
            : (yield* git(root, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();
        const sha = (yield* git(root, ["rev-parse", `${ref}^{commit}`])).trim();
        return { branch: ref.replace(/^origin\//, ""), sha };
      }),
    lsRemoteHeads: Effect.fn("NightShiftGit.lsRemoteHeads")((root) =>
      git(root, ["ls-remote", "--heads", "origin"], 60_000).pipe(
        Effect.map((out) => {
          const heads: Record<string, string> = {};
          for (const line of out.split("\n")) {
            const [sha, ref] = line.trim().split(/\s+/);
            if (sha !== undefined && ref !== undefined && ref.startsWith("refs/heads/")) {
              heads[ref] = sha;
            }
          }
          return heads;
        }),
      ),
    ),
    });
  }),
);
