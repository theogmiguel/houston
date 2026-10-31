// @effect-diagnostics nodeBuiltinImport:off - inspects the untracked entries git lists.
// A checkout's code state for a transfer, through git only: branch, HEAD, a bundle of the commits
// no remote-tracking ref has, a binary diff of tracked changes and untracked, non-ignored files.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as Effect from "effect/Effect";

import * as VcsProcess from "../../vcs/VcsProcess.ts";
import { refusal, secretNames, unportableNames } from "./rules.ts";

const EXPORT = "houston.transfer.export";
/** Bundling or diffing a large checkout runs well past an interactive git call. */
const GIT_TIMEOUT_MS = 600_000;
/** A NUL-separated path list of a very large checkout. */
const GIT_OUTPUT_BYTES = 64 * 1024 * 1024;

const git = (cwd: string, args: ReadonlyArray<string>, allowNonZeroExit = false) =>
  Effect.flatMap(VcsProcess.VcsProcess, (vcs) =>
    vcs.run({
      operation: "HoustonTransfer.git",
      command: "git",
      args: ["-c", "core.quotePath=false", ...args],
      cwd,
      allowNonZeroExit,
      timeoutMs: GIT_TIMEOUT_MS,
      maxOutputBytes: GIT_OUTPUT_BYTES,
    }),
  ).pipe(
    // A git failure here is not a refusal the user can act on: it surfaces as a defect.
    Effect.mapError((error) => new Error(`git ${args.join(" ")} in ${cwd}: ${error.message}`)),
    Effect.orDie,
  );

const text = (cwd: string, args: ReadonlyArray<string>) =>
  git(cwd, args).pipe(Effect.map((output) => output.stdout.trim()));

const nulList = (output: string) => output.split("\0").filter((part) => part !== "");

export const isGitCheckout = (dir: string) =>
  git(dir, ["rev-parse", "--show-toplevel"], true).pipe(
    Effect.map((output) => output.exitCode === 0),
  );

/** The raw `origin` URL; unlike `git remote get-url`, no `insteadOf` rewrite applies. */
export const originUrl = (dir: string) =>
  git(dir, ["config", "--get", "remote.origin.url"], true).pipe(
    Effect.map((output) => (output.exitCode === 0 ? output.stdout.trim() || null : null)),
  );

/** Untracked, non-ignored paths: regular files are carried, anything else is named and skipped. */
export const untrackedEntries = Effect.fn("HoustonTransfer.untrackedEntries")(function* (
  dir: string,
) {
  const listed = nulList(
    (yield* git(dir, ["ls-files", "--others", "--exclude-standard", "-z"])).stdout,
  );
  const files: Array<string> = [];
  const skipped = new Set<string>();
  const links = new Map<string, boolean>();
  // Git for Windows lists the files behind a junction; anything below a link stays behind.
  const linkAbove = (parts: ReadonlyArray<string>) => {
    for (let depth = 1; depth < parts.length; depth += 1) {
      const prefix = parts.slice(0, depth).join("/");
      let isLink = links.get(prefix);
      if (isLink === undefined) {
        isLink =
          NodeFS.lstatSync(NodePath.join(dir, ...parts.slice(0, depth)), {
            throwIfNoEntry: false,
          })?.isSymbolicLink() === true;
        links.set(prefix, isLink);
      }
      if (isLink) return prefix;
    }
    return null;
  };
  for (const relative of listed) {
    const parts = relative.replace(/\/$/, "").split("/");
    const link = linkAbove(parts);
    if (link !== null) {
      skipped.add(link);
      continue;
    }
    const stat = NodeFS.lstatSync(NodePath.join(dir, ...parts), { throwIfNoEntry: false });
    if (stat?.isFile() === true && !stat.isSymbolicLink()) files.push(relative);
    else skipped.add(relative);
  }
  return { files, skipped: [...skipped] };
});

const partiallyStaged = Effect.fn("HoustonTransfer.partiallyStaged")(function* (dir: string) {
  const staged = new Set(
    nulList((yield* git(dir, ["diff", "--cached", "--name-only", "--no-renames", "-z"])).stdout),
  );
  return nulList((yield* git(dir, ["diff", "--name-only", "--no-renames", "-z"])).stdout).filter(
    (path) => staged.has(path),
  );
});

/** Refusals before anything is read: unportable or secret-like names, partly staged files. */
export const checkCheckoutNames = Effect.fn("HoustonTransfer.checkCheckoutNames")(function* (
  dir: string,
  label: string | null = null,
) {
  const { files, skipped } = yield* untrackedEntries(dir);
  const where = (item: string) => (label === null ? item : `${item} (in ${label})`);
  const names = [...files, ...skipped.map((path) => path.replace(/\/$/, ""))];
  const unportable = unportableNames(names);
  if (unportable.length > 0) {
    return yield* refusal(
      "unportable_names",
      EXPORT,
      "Some untracked files have names a transfer to another computer cannot carry.",
      {
        items: unportable.map(where),
        steps: ["Rename, ignore or delete each listed file, then export again."],
      },
    );
  }
  const secrets = secretNames(files);
  if (secrets.length > 0) {
    return yield* refusal(
      "secret_files",
      EXPORT,
      "Some untracked files look like they hold credentials, and a transfer never carries those.",
      {
        items: secrets.map(where),
        steps: [
          "Add each listed file to .gitignore, move it out of the project or delete it, then export again.",
        ],
      },
    );
  }
  const partial = yield* partiallyStaged(dir);
  if (partial.length > 0) {
    return yield* refusal(
      "partially_staged",
      EXPORT,
      "Some files have staged changes that differ from the working copy, and a transfer carries only the working copy.",
      {
        items: partial.map(where),
        steps: ["Stage or unstage these files completely, then export again."],
      },
    );
  }
  return { files, skipped };
});

export interface Captured {
  /** Null on a detached HEAD. */
  readonly branch: string | null;
  readonly head: string;
  /** Files under the scratch folder; null when there is nothing to carry. */
  readonly bundle: string | null;
  readonly diff: string | null;
  /** Untracked regular files, `/`-separated and relative to the checkout. */
  readonly untracked: ReadonlyArray<string>;
  /** Untracked entries not carried: links, nested repositories and other non-regular paths. */
  readonly skippedPaths: ReadonlyArray<string>;
}

/** Captures `dir`'s code state, writing the bundle and diff under `scratch`. */
export const captureCheckout = Effect.fn("HoustonTransfer.captureCheckout")(function* (
  dir: string,
  scratch: string,
  label: string | null = null,
) {
  NodeFS.mkdirSync(scratch, { recursive: true, mode: 0o700 });
  const head = yield* text(dir, ["rev-parse", "--verify", "HEAD^{commit}"]);
  const symbolic = yield* git(dir, ["symbolic-ref", "--quiet", "--short", "HEAD"], true);
  const branch = symbolic.exitCode === 0 ? symbolic.stdout.trim() : null;
  const local = yield* text(dir, ["rev-list", "--count", "HEAD", "--not", "--remotes"]);
  let bundle: string | null = null;
  if (local !== "0") {
    bundle = NodePath.join(scratch, "head.bundle");
    yield* git(dir, ["bundle", "create", bundle, "HEAD", "--not", "--remotes"]);
  }
  const diffPath = NodePath.join(scratch, "tracked.diff");
  yield* git(dir, [
    "diff",
    "--binary",
    "--no-color",
    "--no-ext-diff",
    "--no-textconv",
    "--src-prefix=a/",
    "--dst-prefix=b/",
    `--output=${diffPath}`,
    "HEAD",
  ]);
  const diff = NodeFS.statSync(diffPath).size > 0 ? diffPath : null;
  // The listing carried is the one checked: a file may appear after the export's first check.
  const { files, skipped } = yield* checkCheckoutNames(dir, label);
  return { branch, head, bundle, diff, untracked: files, skippedPaths: skipped } satisfies Captured;
});
