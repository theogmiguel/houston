#!/usr/bin/env node
// Compares Houston's imported paths against an upstream checkout at the commit
// in upstream.json. A copied file that drifts outside `adapted` fails, so later
// upstream fixes arrive as plain diffs.
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// Houston-owned code inside a copied package and dependency stores are not
// upstream files; both sides are pruned at these directories.
const SKIPPED_DIRECTORIES = new Set(["houston", "node_modules"]);

const toPosix = (p) => p.split(sep).join("/");

function isExcluded(relativePath, excluded) {
  return excluded.some((path) => relativePath === path || relativePath.startsWith(`${path}/`));
}

function listFiles(base) {
  const files = [];
  const visit = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIPPED_DIRECTORIES.has(entry.name)) continue;
        visit(path);
      } else if (entry.isFile()) {
        files.push(path);
      }
    }
  };
  visit(base);
  return files;
}

// Paths under `base` that git ignores (build output such as *.tsbuildinfo).
// A tracked file is never ignored, so drift in tracked files is still seen.
// Outside a git work tree nothing is ignored.
function ignoredPaths(repoRoot, base, files) {
  const prefix = toPosix(relative(repoRoot, base));
  const paths = files.map((f) => `${prefix}/${f}`);
  if (paths.length === 0) return new Set();
  const result = spawnSync("git", ["check-ignore", "--stdin", "-z"], {
    cwd: repoRoot,
    input: paths.join("\0"),
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
  if (result.status !== 0 && result.status !== 1) return new Set();
  return new Set(result.stdout.split("\0").filter(Boolean));
}

export function checkUpstream({ repoRoot, upstreamDir, skip = [] }) {
  const config = JSON.parse(readFileSync(join(repoRoot, "upstream.json"), "utf8"));
  const adapted = config.adapted ?? {};
  // Houston-authored additions and removals inside a copied package are listed
  // here instead of failing as unexpected files.
  const added = new Set(config.added ?? []);
  const removed = new Set(config.removed ?? []);
  const excluded = config.excluded ?? [];
  const problems = [];
  let fileCount = 0;
  // Every imported file compared, with the two paths it was compared at.
  const compared = new Map();

  const differs = (path) =>
    `${path} differs from upstream and is not listed in upstream.json adapted`;

  for (const imported of config.imported) {
    if (isExcluded(imported, skip)) continue;
    // `excluded` prunes the walk below; an explicitly imported path is
    // deliberate, so excluded prefixes it sits under do not veto it or its
    // children.
    const activeExcluded = excluded.filter(
      (path) => imported !== path && !imported.startsWith(`${path}/`),
    );
    const repoPath = join(repoRoot, imported);
    const upstreamPath = join(upstreamDir, imported);
    if (!existsSync(repoPath) && !existsSync(upstreamPath)) {
      problems.push(`${imported} is imported but missing from the repo and upstream`);
      continue;
    }
    if (!existsSync(repoPath)) {
      problems.push(`${imported} is imported but missing from the repo`);
      continue;
    }
    if (!existsSync(upstreamPath)) {
      problems.push(`${imported} is imported but missing upstream`);
      continue;
    }

    const repoStat = statSync(repoPath);
    const upstreamStat = statSync(upstreamPath);
    if (repoStat.isFile() !== upstreamStat.isFile()) {
      problems.push(
        repoStat.isFile()
          ? `${imported} is a file in the repo but a directory upstream`
          : `${imported} is a directory in the repo but a file upstream`,
      );
      continue;
    }

    if (repoStat.isFile()) {
      fileCount += 1;
      compared.set(imported, [repoPath, upstreamPath]);
      if (!(imported in adapted) && !readFileSync(repoPath).equals(readFileSync(upstreamPath))) {
        problems.push(differs(imported));
      }
      continue;
    }

    const repoFiles = new Map(listFiles(repoPath).map((f) => [toPosix(relative(repoPath, f)), f]));
    const ignored = ignoredPaths(repoRoot, repoPath, [...repoFiles.keys()]);
    for (const rel of repoFiles.keys()) {
      if (ignored.has(`${toPosix(relative(repoRoot, repoPath))}/${rel}`)) repoFiles.delete(rel);
    }
    const upstreamFiles = new Map(
      listFiles(upstreamPath).map((f) => [toPosix(relative(upstreamPath, f)), f]),
    );
    for (const [rel, repoFile] of repoFiles) {
      const path = `${imported}/${rel}`;
      if (isExcluded(path, activeExcluded) || isExcluded(path, skip)) continue;
      const upstreamFile = upstreamFiles.get(rel);
      if (!upstreamFile) {
        if (!added.has(path)) problems.push(`${path} exists only in the repo`);
        continue;
      }
      upstreamFiles.delete(rel);
      fileCount += 1;
      compared.set(path, [repoFile, upstreamFile]);
      if (!(path in adapted) && !readFileSync(repoFile).equals(readFileSync(upstreamFile))) {
        problems.push(differs(path));
      }
    }
    for (const rel of upstreamFiles.keys()) {
      const path = `${imported}/${rel}`;
      if (isExcluded(path, activeExcluded) || isExcluded(path, skip)) continue;
      if (!removed.has(path)) problems.push(`${path} exists only upstream`);
    }
  }

  // An adapted entry that no longer adapts anything would hide later drift.
  for (const key of Object.keys(adapted)) {
    if (isExcluded(key, skip)) continue;
    if (!compared.has(key)) {
      problems.push(`${key} is listed in upstream.json adapted but matches no imported file`);
    } else if (readFileSync(compared.get(key)[0]).equals(readFileSync(compared.get(key)[1]))) {
      problems.push(`${key} is listed in upstream.json adapted but equals upstream`);
    }
  }

  problems.sort();
  return { ok: problems.length === 0, problems, fileCount, commit: config.commit };
}

function main() {
  const args = process.argv.slice(2);
  const skip = [];
  for (let i = args.indexOf("--skip"); i !== -1; i = args.indexOf("--skip")) {
    if (!args[i + 1]) {
      process.stderr.write("check-upstream: --skip needs a path, for example --skip apps/web\n");
      process.exit(2);
    }
    skip.push(args[i + 1].replace(/\/+$/, ""));
    args.splice(i, 2);
  }
  const upstreamDir = args[0];
  if (!upstreamDir) {
    process.stderr.write("usage: node scripts/check-upstream.mjs <upstream-checkout> [--skip <path>]...\n");
    process.exit(2);
  }
  const upstreamRoot = resolve(upstreamDir);
  if (!existsSync(upstreamRoot)) {
    process.stderr.write(
      `check-upstream: ${upstreamRoot} does not exist — pass a checkout of pingdotgg/t3code at the pinned commit\n`,
    );
    process.exit(2);
  }
  const { ok, problems, fileCount, commit } = checkUpstream({
    repoRoot: ROOT,
    upstreamDir: upstreamRoot,
    skip,
  });
  for (const problem of problems) process.stderr.write(`check-upstream: ${problem}\n`);
  if (ok) {
    const skipped = skip.length > 0 ? ` (skipped: ${skip.join(", ")})` : "";
    process.stdout.write(`check-upstream: ok — ${fileCount} files match upstream ${commit}${skipped}\n`);
  }
  process.exit(ok ? 0 : 1);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();
