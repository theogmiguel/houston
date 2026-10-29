#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { checkUpstream } from "./check-upstream.mjs";

const run = promisify(execFile);

const UPSTREAM_COMMIT = "9826dbb9904b2591bfbf60d1317486b59132f56b";

async function writeTree(root, files) {
  for (const [relative, body] of Object.entries(files)) {
    const target = join(root, relative);
    await mkdir(join(target, ".."), { recursive: true });
    await writeFile(target, body);
  }
}

// A minimal imported tree: two package paths and one standalone file.
function fixtureRepo() {
  return {
    "upstream.json": JSON.stringify({
      repo: "pingdotgg/t3code",
      commit: UPSTREAM_COMMIT,
      imported: ["packages/contracts", "packages/shared", "tsconfig.base.json"],
      excluded: [],
      adapted: {},
    }),
    "packages/contracts/src/a.ts": "alpha\n",
    "packages/contracts/src/keep.ts": "keep\n",
    "packages/shared/src/b.ts": "bravo\n",
    "tsconfig.base.json": "{}\n",
  };
}

async function makeFixture(repoFiles, upstreamFiles) {
  const dir = await mkdtemp(join(tmpdir(), "check-upstream-"));
  const repo = join(dir, "repo");
  const upstream = join(dir, "upstream");
  await mkdir(repo, { recursive: true });
  await mkdir(upstream, { recursive: true });
  await writeTree(repo, repoFiles);
  await writeTree(upstream, upstreamFiles);
  return { dir, repo, upstream };
}

test("check-upstream accepts an untouched copy", async () => {
  const { dir, repo, upstream } = await makeFixture(fixtureRepo(), fixtureRepo());
  try {
    const result = await checkUpstream({ repoRoot: repo, upstreamDir: upstream });
    assert.deepEqual(result.problems, [], JSON.stringify(result.problems));
    assert.equal(result.ok, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("check-upstream accepts houston/ folders as Houston-owned and skips node_modules", async () => {
  const repoFiles = {
    ...fixtureRepo(),
    "packages/contracts/src/houston/terminalFrames.ts": "export {};\n",
    "packages/contracts/src/houston/terminalFrames.test.ts": "import './terminalFrames.ts';\n",
    "packages/contracts/node_modules/.package-lock.json": "{}\n",
  };
  const { dir, repo, upstream } = await makeFixture(repoFiles, fixtureRepo());
  try {
    const result = await checkUpstream({ repoRoot: repo, upstreamDir: upstream });
    assert.deepEqual(result.problems, [], JSON.stringify(result.problems));
    assert.equal(result.ok, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("check-upstream drift names a changed file that is not in adapted", async () => {
  const upstream = fixtureRepo();
  const repo = {
    ...upstream,
    "packages/contracts/src/a.ts": "ALPHA\n",
  };
  const { dir, repo: repoDir, upstream: upstreamDir } = await makeFixture(repo, upstream);
  try {
    const result = await checkUpstream({ repoRoot: repoDir, upstreamDir });
    assert.equal(result.ok, false);
    assert.deepEqual(
      result.problems,
      ["packages/contracts/src/a.ts differs from upstream and is not listed in upstream.json adapted"],
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("check-upstream drift accepts the same file when it is listed in adapted", async () => {
  const upstream = fixtureRepo();
  const manifest = JSON.parse(upstream["upstream.json"]);
  manifest.adapted["packages/contracts/src/a.ts"] = "renamed a constant Houston does not have";
  upstream["upstream.json"] = JSON.stringify(manifest);
  const repo = {
    ...upstream,
    "packages/contracts/src/a.ts": "ALPHA\n",
  };
  const { dir, repo: repoDir, upstream: upstreamDir } = await makeFixture(repo, upstream);
  try {
    const result = await checkUpstream({ repoRoot: repoDir, upstreamDir });
    assert.deepEqual(result.problems, [], JSON.stringify(result.problems));
    assert.equal(result.ok, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("check-upstream missing names a file present on only one side", async () => {
  const upstream = fixtureRepo();
  const repo = {
    ...fixtureRepo(),
    "packages/shared/src/extra.ts": "extra\n",
  };
  delete repo["packages/contracts/src/keep.ts"];
  const { dir, repo: repoDir, upstream: upstreamDir } = await makeFixture(repo, upstream);
  try {
    const result = await checkUpstream({ repoRoot: repoDir, upstreamDir });
    assert.equal(result.ok, false);
    assert.deepEqual(result.problems, [
      "packages/contracts/src/keep.ts exists only upstream",
      "packages/shared/src/extra.ts exists only in the repo",
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("check-upstream checks an explicit import even when an excluded prefix covers it", async () => {
  const upstream = fixtureRepo();
  const manifest = JSON.parse(upstream["upstream.json"]);
  manifest.excluded = ["packages"];
  upstream["upstream.json"] = JSON.stringify(manifest);
  const repo = {
    ...upstream,
    "packages/contracts/src/a.ts": "CHANGED\n",
  };
  const { dir, repo: repoDir, upstream: upstreamDir } = await makeFixture(repo, upstream);
  try {
    const result = await checkUpstream({ repoRoot: repoDir, upstreamDir });
    assert.equal(result.ok, false);
    assert.deepEqual(
      result.problems,
      ["packages/contracts/src/a.ts differs from upstream and is not listed in upstream.json adapted"],
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("check-upstream accepts a repo-side file that .gitignore excludes", async () => {
  const { dir, repo, upstream } = await makeFixture(fixtureRepo(), fixtureRepo());
  await writeFile(
    join(repo, ".gitignore"),
    "*.tsbuildinfo\n",
  );
  await writeFile(
    join(repo, "packages/contracts/tsconfig.tsbuildinfo"),
    '{"version":"5.1"}',
  );
  await run("git", ["init", "--quiet"], { cwd: repo });
  try {
    const result = await checkUpstream({ repoRoot: repo, upstreamDir: upstream });
    assert.deepEqual(result.problems, [], JSON.stringify(result.problems));
    assert.equal(result.ok, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("check-upstream names an imported path missing from either side", async () => {
  const upstream = fixtureRepo();
  delete upstream["packages/shared/src/b.ts"];
  const repo = { ...fixtureRepo() };
  delete repo["tsconfig.base.json"];
  const { dir, repo: repoDir, upstream: upstreamDir } = await makeFixture(repo, upstream);
  try {
    const result = await checkUpstream({ repoRoot: repoDir, upstreamDir });
    assert.equal(result.ok, false);
    assert.deepEqual(result.problems, [
      "packages/shared is imported but missing upstream",
      "tsconfig.base.json is imported but missing from the repo",
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
