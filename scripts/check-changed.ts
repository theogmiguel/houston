#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - plain Node pre-push hook.
// Fast pre-push gate: format, lint and typecheck what this branch changes, and
// skip cleanly when nothing relevant moved. The hook passes no arguments, so
// only committed changes in the push range are checked.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

const repoRoot = NodeChildProcess.execFileSync("git", ["rev-parse", "--show-toplevel"], {
  encoding: "utf8",
}).trim();
const vpBin = NodePath.join(repoRoot, "node_modules", "vite-plus", "bin", "vp");
const isWindows = NodePath.sep === "\\";

function git(args: string[]): string {
  return NodeChildProcess.execFileSync("git", args, { cwd: repoRoot, encoding: "utf8" });
}

function tryGit(args: string[]): string | null {
  try {
    return git(args).trim();
  } catch {
    return null;
  }
}

function parseArgs(argv: string[]): { base: string | null; working: boolean } {
  const options: { base: string | null; working: boolean } = { base: null, working: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === undefined) break;
    if (arg === "--working") options.working = true;
    else if (arg === "--base") options.base = argv[++index] ?? null;
    else if (arg.startsWith("--base=")) options.base = arg.slice("--base=".length);
    else if (arg === "-h" || arg === "--help") {
      process.stdout.write(
        "usage: node scripts/check-changed.ts [--base <ref>] [--working]\n" +
          "  --base     compare against this ref instead of the branch upstream\n" +
          "  --working  also include uncommitted and untracked files\n",
      );
      process.exit(0);
    } else {
      throw new Error(
        `check:changed: unknown argument ${JSON.stringify(arg)}; expected --base or --working`,
      );
    }
  }
  return options;
}

function resolveBase(explicit: string | null): string {
  if (explicit) return explicit;
  const upstream = tryGit(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]);
  if (upstream && upstream !== "@{upstream}") return upstream;
  for (const candidate of ["origin/v2", "origin/main", "origin/HEAD"]) {
    if (tryGit(["rev-parse", "--verify", "--quiet", `${candidate}^{commit}`]) !== null)
      return candidate;
  }
  if (tryGit(["rev-parse", "--verify", "--quiet", "HEAD^"]) !== null) return "HEAD^";
  throw new Error("check:changed: no base ref found; pass --base <ref> or create a commit first");
}

function changedFiles(options: { base: string | null; working: boolean }): string[] {
  if (tryGit(["rev-parse", "--verify", "--quiet", "HEAD"]) === null) return [];

  const base = resolveBase(options.base);
  if (tryGit(["rev-parse", "--verify", "--quiet", `${base}^{commit}`]) === null) {
    throw new Error(
      `check:changed: base ${JSON.stringify(base)} is not a commit; expected a ref such as origin/v2`,
    );
  }
  const mergeBase = tryGit(["merge-base", base, "HEAD"]);
  if (mergeBase === null) {
    throw new Error(
      `check:changed: no merge base between ${JSON.stringify(base)} and HEAD; expected a shared ancestor`,
    );
  }

  const names = new Set<string>(
    git(["diff", "--name-only", "--diff-filter=ACMR", mergeBase, "HEAD"]).split("\n"),
  );
  if (options.working) {
    for (const args of [
      ["diff", "--name-only", "--diff-filter=ACMR"],
      ["diff", "--name-only", "--diff-filter=ACMR", "--cached"],
      ["ls-files", "--others", "--exclude-standard"],
    ]) {
      for (const name of git(args).split("\n")) names.add(name);
    }
  }
  return [...names]
    .map((name) => name.trim())
    .filter((name) => name.length > 0 && !name.startsWith("handoff/"));
}

const FORMATTABLE = /\.(?:[cm]?[jt]sx?|json|jsonc|css|html?|md|ya?ml)$/i;
const LINTABLE = /\.[cm]?[jt]sx?$/i;
const TYPECHECK_SOURCE = /\.[cm]?tsx?$/i;
const TYPECHECK_CONFIG =
  /(^|\/)(?:package\.json|tsconfig[^/]*\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml)$/;
const TYPECHECK_ROOTS = ["apps/", "packages/", "scripts/", "oxlint-plugin-houston/"];

function packageFor(file: string): string | null {
  let dir = NodePath.dirname(file);
  while (dir !== "." && dir !== "") {
    const manifestPath = NodePath.join(repoRoot, dir, "package.json");
    if (NodeFS.existsSync(manifestPath)) {
      try {
        const manifest = JSON.parse(NodeFS.readFileSync(manifestPath, "utf8"));
        return typeof manifest.name === "string" ? manifest.name : null;
      } catch {
        return null;
      }
    }
    dir = NodePath.dirname(dir);
  }
  return null;
}

function typecheckPlan(files: string[]): { full: boolean; packages: string[] } {
  if (files.some((file) => TYPECHECK_CONFIG.test(file) || file === "vite.config.ts")) {
    return { full: true, packages: [] };
  }
  const packages = new Set<string>();
  for (const file of files) {
    if (!TYPECHECK_SOURCE.test(file)) continue;
    if (!TYPECHECK_ROOTS.some((prefix) => file.startsWith(prefix))) continue;
    const name = packageFor(file);
    if (name === null) return { full: true, packages: [] };
    packages.add(name);
  }
  return { full: false, packages: [...packages].sort() };
}

const pnpmCommand = isWindows ? "pnpm.cmd" : "pnpm";

function run(label: string, command: string, args: string[], shell = false): void {
  process.stdout.write(`check:changed: ${label}\n`);
  NodeChildProcess.execFileSync(command, args, { cwd: repoRoot, stdio: "inherit", shell });
}

function main(): void {
  const options = parseArgs(process.argv.slice(2));
  const files = changedFiles(options);

  const formattable = files.filter((file) => FORMATTABLE.test(file)).sort();
  const lintable = files.filter((file) => LINTABLE.test(file)).sort();
  const typecheck = typecheckPlan(files);

  if (
    formattable.length === 0 &&
    lintable.length === 0 &&
    !typecheck.full &&
    typecheck.packages.length === 0
  ) {
    process.stdout.write("check:changed: nothing relevant changed\n");
    return;
  }
  if (!NodeFS.existsSync(vpBin)) {
    throw new Error(`check:changed: ${vpBin} is missing; run pnpm install before pushing`);
  }

  if (formattable.length > 0) {
    run("format", process.execPath, [
      vpBin,
      "fmt",
      "--check",
      "--no-error-on-unmatched-pattern",
      ...formattable,
    ]);
  }
  if (lintable.length > 0) {
    run("lint", process.execPath, [
      vpBin,
      "lint",
      "--report-unused-disable-directives",
      "--no-error-on-unmatched-pattern",
      ...lintable,
    ]);
  }
  if (typecheck.full) {
    run("typecheck", pnpmCommand, ["-r", "--no-bail", "typecheck"], isWindows);
  } else if (typecheck.packages.length > 0) {
    const filters = typecheck.packages.flatMap((name) => ["--filter", name]);
    run("typecheck", pnpmCommand, ["-r", "--no-bail", ...filters, "typecheck"], isWindows);
  }
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
