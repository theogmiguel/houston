#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { checkUpstream } from "./check-upstream.mjs";

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

test("check-upstream single-file import names drift and accepts it when listed in adapted", async () => {
  const upstream = fixtureRepo();
  const drifted = { ...upstream, "tsconfig.base.json": '{"strict":true}\n' };
  const first = await makeFixture(drifted, upstream);
  try {
    const result = await checkUpstream({ repoRoot: first.repo, upstreamDir: first.upstream });
    assert.equal(result.ok, false);
    assert.deepEqual(result.problems, [
      "tsconfig.base.json differs from upstream and is not listed in upstream.json adapted",
    ]);
  } finally {
    await rm(first.dir, { recursive: true, force: true });
  }

  const manifest = JSON.parse(drifted["upstream.json"]);
  manifest.adapted["tsconfig.base.json"] = "strict mode on";
  const listed = { ...drifted, "upstream.json": JSON.stringify(manifest) };
  const second = await makeFixture(listed, upstream);
  try {
    const result = await checkUpstream({ repoRoot: second.repo, upstreamDir: second.upstream });
    assert.deepEqual(result.problems, [], JSON.stringify(result.problems));
    assert.equal(result.ok, true);
  } finally {
    await rm(second.dir, { recursive: true, force: true });
  }
});

test("check-upstream ignored files that git ignores are not drift", async () => {
  const repoFiles = {
    ...fixtureRepo(),
    ".gitignore": "*.tsbuildinfo\n",
    "packages/contracts/tsconfig.tsbuildinfo": "{}\n",
    "packages/shared/dist/out.js": "built\n",
  };
  const { dir, repo, upstream } = await makeFixture(repoFiles, fixtureRepo());
  try {
    execFileSync("git", ["init", "-q"], { cwd: repo });
    const result = await checkUpstream({ repoRoot: repo, upstreamDir: upstream });
    // The unignored build output is still reported, so the filter is not a blanket skip.
    assert.deepEqual(result.problems, ["packages/shared/dist/out.js exists only in the repo"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("check-upstream tracked ignored file that drifts is still named", async () => {
  const upstreamFiles = { ...fixtureRepo(), "packages/contracts/gen.log": "upstream\n" };
  const repoFiles = {
    ...upstreamFiles,
    ".gitignore": "*.log\n",
    "packages/contracts/gen.log": "houston\n",
  };
  const { dir, repo, upstream } = await makeFixture(repoFiles, upstreamFiles);
  try {
    execFileSync("git", ["init", "-q"], { cwd: repo });
    execFileSync("git", ["add", "-f", "packages/contracts/gen.log"], { cwd: repo });
    const result = await checkUpstream({ repoRoot: repo, upstreamDir: upstream });
    // Tracked files are never ignored, so a force-added file keeps its drift check.
    assert.deepEqual(result.problems, [
      "packages/contracts/gen.log differs from upstream and is not listed in upstream.json adapted",
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("check-upstream stale adapted names a key matching no file or equal to upstream", async () => {
  const files = fixtureRepo();
  const manifest = JSON.parse(files["upstream.json"]);
  manifest.adapted["packages/contracts/src/gone.ts"] = "file was deleted";
  manifest.adapted["packages/contracts/src/a.ts"] = "no longer differs";
  const repoFiles = { ...files, "upstream.json": JSON.stringify(manifest) };
  const { dir, repo, upstream } = await makeFixture(repoFiles, files);
  try {
    const result = await checkUpstream({ repoRoot: repo, upstreamDir: upstream });
    assert.equal(result.ok, false);
    assert.deepEqual(result.problems, [
      "packages/contracts/src/a.ts is listed in upstream.json adapted but equals upstream",
      "packages/contracts/src/gone.ts is listed in upstream.json adapted but matches no imported file",
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("check-upstream skip leaves a skipped path unchecked and still checks the rest", async () => {
  const upstream = fixtureRepo();
  const repo = {
    ...upstream,
    "upstream.json": JSON.stringify({
      ...JSON.parse(upstream["upstream.json"]),
      adapted: { "packages/shared/src/b.ts": "reskinned" },
    }),
    "packages/shared/src/b.ts": "BRAVO\n",
    "packages/shared/src/extra.ts": "houston only\n",
    "packages/contracts/src/a.ts": "ALPHA\n",
  };
  const { dir, repo: repoDir, upstream: upstreamDir } = await makeFixture(repo, upstream);
  try {
    const result = await checkUpstream({ repoRoot: repoDir, upstreamDir, skip: ["packages/shared"] });
    assert.equal(result.ok, false);
    assert.deepEqual(
      result.problems,
      ["packages/contracts/src/a.ts differs from upstream and is not listed in upstream.json adapted"],
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("check-upstream skip of a prefix inside an import skips only that subtree", async () => {
  const upstream = fixtureRepo();
  const repo = {
    ...upstream,
    "packages/contracts/src/a.ts": "ALPHA\n",
    "packages/contracts/src/keep.ts": "KEEP\n",
  };
  const { dir, repo: repoDir, upstream: upstreamDir } = await makeFixture(repo, upstream);
  try {
    const result = await checkUpstream({
      repoRoot: repoDir,
      upstreamDir,
      skip: ["packages/contracts/src/a.ts"],
    });
    assert.deepEqual(
      result.problems,
      ["packages/contracts/src/keep.ts differs from upstream and is not listed in upstream.json adapted"],
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
