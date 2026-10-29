#!/usr/bin/env node
// Compares Houston's imported paths against an upstream checkout at the commit
// in upstream.json. A copied file that drifts outside `adapted` fails, so later
// upstream fixes arrive as plain diffs.
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

export function checkUpstream({ repoRoot, upstreamDir }) {
  const config = JSON.parse(readFileSync(join(repoRoot, "upstream.json"), "utf8"));
  const adapted = config.adapted ?? {};
  const excluded = config.excluded ?? [];
  const problems = [];
  let fileCount = 0;

  const differs = (path) =>
    `${path} differs from upstream and is not listed in upstream.json adapted`;

  for (const imported of config.imported) {
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
      if (!(imported in adapted) && !readFileSync(repoPath).equals(readFileSync(upstreamPath))) {
        problems.push(differs(imported));
      }
      continue;
    }

    const repoFiles = new Map(listFiles(repoPath).map((f) => [toPosix(relative(repoPath, f)), f]));
    const upstreamFiles = new Map(
      listFiles(upstreamPath).map((f) => [toPosix(relative(upstreamPath, f)), f]),
    );
    for (const [rel, repoFile] of repoFiles) {
      const path = `${imported}/${rel}`;
      if (isExcluded(path, activeExcluded)) continue;
      const upstreamFile = upstreamFiles.get(rel);
      if (!upstreamFile) {
        problems.push(`${path} exists only in the repo`);
        continue;
      }
      upstreamFiles.delete(rel);
      fileCount += 1;
      if (!(path in adapted) && !readFileSync(repoFile).equals(readFileSync(upstreamFile))) {
        problems.push(differs(path));
      }
    }
    for (const rel of upstreamFiles.keys()) {
      const path = `${imported}/${rel}`;
      if (isExcluded(path, activeExcluded)) continue;
      problems.push(`${path} exists only upstream`);
    }
  }

  problems.sort();
  return { ok: problems.length === 0, problems, fileCount, commit: config.commit };
}

function main() {
  const upstreamDir = process.argv[2];
  if (!upstreamDir) {
    process.stderr.write("usage: node scripts/check-upstream.mjs <upstream-checkout>\n");
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
  });
  for (const problem of problems) process.stderr.write(`check-upstream: ${problem}\n`);
  if (ok) {
    process.stdout.write(`check-upstream: ok — ${fileCount} files match upstream ${commit}\n`);
  }
  process.exit(ok ? 0 : 1);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();
