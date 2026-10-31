// @effect-diagnostics nodeBuiltinImport:off - builds temporary git repositories for the tests.
// Checkout capture with real git in temporary repositories: no network, no system or user config.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import type { HoustonTransferError } from "@t3tools/contracts/houston/transfer";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { afterAll, beforeAll } from "vite-plus/test";

import * as VcsProcess from "../../vcs/VcsProcess.ts";
import { captureCheckout, checkCheckoutNames } from "./checkout.ts";
import { TransferProbe } from "./probe.ts";

const roots: Array<string> = [];
const makeDir = (prefix: string) => {
  const dir = NodeFS.realpathSync(NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), prefix)));
  roots.push(dir);
  return dir;
};

const saved: Record<string, string | undefined> = {};
beforeAll(() => {
  // The code under test runs git with the process environment: point it away from the user's.
  const home = makeDir("houston-transfer-home-");
  const global = NodePath.join(home, ".gitconfig");
  NodeFS.writeFileSync(global, "");
  for (const [key, value] of Object.entries({
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: global,
    GIT_TERMINAL_PROMPT: "0",
  })) {
    saved[key] = process.env[key];
    process.env[key] = value;
  }
});
afterAll(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  for (const dir of roots.splice(0)) NodeFS.rmSync(dir, { recursive: true, force: true });
});

const fixtureEnv = (): NodeJS.ProcessEnv => ({
  ...process.env,
  GIT_AUTHOR_NAME: "Fixture Author",
  GIT_AUTHOR_EMAIL: "author@example.test",
  GIT_COMMITTER_NAME: "Fixture Committer",
  GIT_COMMITTER_EMAIL: "committer@example.test",
});

const git = (cwd: string, args: ReadonlyArray<string>) =>
  NodeChildProcess.execFileSync("git", [...args], {
    cwd,
    env: fixtureEnv(),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();

const write = (root: string, relative: string, contents: string | Uint8Array) => {
  const path = NodePath.join(root, ...relative.split("/"));
  NodeFS.mkdirSync(NodePath.dirname(path), { recursive: true });
  NodeFS.writeFileSync(path, contents);
};

/** A bare origin with one pushed commit, and a clone of it as the checkout. */
const makeRepos = () => {
  const root = makeDir("houston-transfer-git-");
  const origin = NodePath.join(root, "origin.git");
  const seed = NodePath.join(root, "seed");
  const checkout = NodePath.join(root, "checkout");
  git(root, ["init", "--quiet", "--bare", "--initial-branch=main", origin]);
  git(root, ["init", "--quiet", "--initial-branch=main", seed]);
  write(seed, "README.md", "base\n");
  write(seed, "logo.bin", Buffer.from([0, 1, 2, 3, 255, 254]));
  git(seed, ["add", "."]);
  git(seed, ["commit", "--quiet", "-m", "base"]);
  git(seed, ["push", "--quiet", origin, "main"]);
  git(root, ["clone", "--quiet", origin, checkout]);
  return { root, origin, checkout };
};

/** A link in `checkout` to a file outside it; a junction to a folder where Windows refuses that. */
const makeLink = (checkout: string, file: string, folder: string) => {
  try {
    NodeFS.symlinkSync(file, NodePath.join(checkout, "link.txt"), "file");
    return "link.txt";
  } catch {
    NodeFS.symlinkSync(folder, NodePath.join(checkout, "linked-dir"), "junction");
    return "linked-dir";
  }
};

/** Every file below `dir` except `.git`, with its bytes. */
const tree = (dir: string) => {
  const files: Record<string, string> = {};
  const walk = (folder: string) => {
    for (const entry of NodeFS.readdirSync(folder, { withFileTypes: true })) {
      if (entry.name === ".git") continue;
      const path = NodePath.join(folder, entry.name);
      if (entry.isDirectory()) walk(path);
      else
        files[NodePath.relative(dir, path).replaceAll("\\", "/")] =
          NodeFS.readFileSync(path).toString("base64");
    }
  };
  walk(dir);
  return files;
};

const layer = Layer.mergeAll(VcsProcess.layer).pipe(Layer.provideMerge(NodeServices.layer));

const failureOf = <A, R>(effect: Effect.Effect<A, HoustonTransferError, R>) => Effect.flip(effect);

describe("capture carries local commits, the diff and untracked files", () => {
  it.effect("capture carries local commits, the diff and untracked files", () =>
    Effect.gen(function* () {
      const { root, origin, checkout } = makeRepos();
      write(checkout, "a.txt", "one\n");
      git(checkout, ["add", "."]);
      git(checkout, ["commit", "--quiet", "-m", "local one"]);
      write(checkout, "b.txt", "two\n");
      git(checkout, ["add", "."]);
      git(checkout, ["commit", "--quiet", "-m", "local two"]);
      write(checkout, "README.md", "base\nedited\n");
      write(checkout, "logo.bin", Buffer.from([9, 8, 7, 0, 0, 1]));
      write(checkout, "notes.txt", "untracked\n");
      write(checkout, "docs/plan.md", "untracked too\n");
      const head = git(checkout, ["rev-parse", "HEAD"]);

      const scratch = NodePath.join(root, "scratch");
      const captured = yield* captureCheckout(checkout, scratch);
      assert.strictEqual(captured.branch, "main");
      assert.strictEqual(captured.head, head);
      assert.isNotNull(captured.bundle);
      assert.isNotNull(captured.diff);
      assert.deepEqual([...captured.untracked].toSorted(), ["docs/plan.md", "notes.txt"]);
      assert.deepEqual(captured.skippedPaths, []);

      // Another computer: a clone of origin that takes the bundle, the diff and the files.
      const target = NodePath.join(root, "target");
      git(root, ["clone", "--quiet", origin, target]);
      git(target, ["fetch", "--quiet", captured.bundle!, `HEAD:refs/houston/test`]);
      git(target, ["checkout", "--quiet", "-B", "main", "refs/houston/test"]);
      git(target, ["apply", "--binary", captured.diff!]);
      for (const relative of captured.untracked) {
        write(target, relative, NodeFS.readFileSync(NodePath.join(checkout, relative)));
      }
      assert.strictEqual(git(target, ["rev-parse", "HEAD"]), head);
      assert.deepEqual(tree(target), tree(checkout));

      // With every commit on a remote there is no bundle; a detached HEAD has no branch.
      git(checkout, ["push", "--quiet", "origin", "main"]);
      git(checkout, ["checkout", "--quiet", "--detach", "HEAD~1"]);
      const pushed = yield* captureCheckout(checkout, NodePath.join(root, "scratch-2"));
      assert.isNull(pushed.bundle);
      assert.isNull(pushed.branch);
      assert.strictEqual(pushed.head, git(checkout, ["rev-parse", "HEAD"]));
    }).pipe(Effect.provide(layer)),
  );
});

describe("capture skips links and nested repositories and names them", () => {
  it.effect("capture skips links and nested repositories and names them", () =>
    Effect.gen(function* () {
      const { root, checkout } = makeRepos();
      write(checkout, "kept.txt", "kept\n");
      const outside = NodePath.join(root, "outside.txt");
      NodeFS.writeFileSync(outside, "outside\n");
      const link = makeLink(checkout, outside, root);
      const nested = NodePath.join(checkout, "vendor", "lib");
      NodeFS.mkdirSync(nested, { recursive: true });
      git(nested, ["init", "--quiet", "--initial-branch=main"]);
      write(nested, "lib.txt", "lib\n");
      git(nested, ["add", "."]);
      git(nested, ["commit", "--quiet", "-m", "nested"]);

      const captured = yield* captureCheckout(checkout, NodePath.join(root, "scratch"));
      assert.deepEqual(captured.untracked, ["kept.txt"]);
      assert.isTrue(
        captured.skippedPaths.some((path) => path.replace(/\/$/, "") === link),
        JSON.stringify(captured.skippedPaths),
      );
      assert.isTrue(
        captured.skippedPaths.some((path) => path.replace(/\/$/, "") === "vendor/lib"),
        JSON.stringify(captured.skippedPaths),
      );
    }).pipe(Effect.provide(layer)),
  );
});

describe("partially staged files are named and unportable names refuse before reading", () => {
  it.effect("partially staged files are named and unportable names refuse before reading", () =>
    Effect.gen(function* () {
      const { checkout } = makeRepos();
      write(checkout, "fine.txt", "fine\n");
      // Windows cannot create these names, so only Linux reaches them; the rules test covers both.
      if ((yield* HostProcess.Platform) !== "win32") {
        write(checkout, "notes:v2.txt", "colon\n");
        write(checkout, "aux.md", "device\n");
        write(checkout, "Fine.txt", "case\n");
        const reads: Array<string> = [];
        const refused = yield* failureOf(
          checkCheckoutNames(checkout).pipe(
            Effect.provideService(TransferProbe, {
              ...TransferProbe.defaultValue(),
              onFileRead: (path) => reads.push(path),
            }),
          ),
        );
        assert.strictEqual(refused.kind, "unportable_names");
        for (const name of ["aux.md", "notes:v2.txt", "Fine.txt"]) {
          assert.isTrue(
            refused.items.some((item) => item.includes(name)),
            name,
          );
        }
        assert.deepEqual(reads, []);
        for (const name of ["notes:v2.txt", "aux.md", "Fine.txt"]) {
          NodeFS.rmSync(NodePath.join(checkout, name));
        }
      }
      write(checkout, "README.md", "staged\n");
      git(checkout, ["add", "README.md"]);
      yield* checkCheckoutNames(checkout);
      write(checkout, "README.md", "staged then edited\n");
      const partial = yield* failureOf(checkCheckoutNames(checkout));
      assert.strictEqual(partial.kind, "partially_staged");
      assert.isTrue(partial.items.some((item) => item.includes("README.md")));
    }).pipe(Effect.provide(layer)),
  );
});
