#!/usr/bin/env node
/* oxlint-disable houston/no-global-process-runtime -- Exercises the dependency-free launcher on this host; no Effect runtime. */
import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeTest from "node:test";

import {
  NPM_LAUNCHER_PACKAGE_NAME,
  buildNpmLauncher,
  latestServerMigrationId,
  npmLauncherPackageManifest,
} from "./build-npm-launcher.mjs";
import {
  SUPPORTED_PLATFORM_KEYS,
  houstonHome,
  unsupportedPlatformMessage,
} from "./npm-launcher/houston.mjs";

const VERSION = "9.8.7";
const PLATFORM_KEY = `${NodeOS.platform()}-${NodeOS.arch()}`;
const canRunLauncher = SUPPORTED_PLATFORM_KEYS.includes(PLATFORM_KEY);

function tempDir(prefix) {
  return NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), prefix));
}

/** A release archive shaped like build-server-archive.mjs output: one top-level folder. */
function fakeArchive(root) {
  const stem = `houston-${VERSION}-${PLATFORM_KEY}`;
  const stage = NodePath.join(root, "stage");
  NodeFS.mkdirSync(NodePath.join(stage, stem), { recursive: true });
  const executable = NodePath.join(stage, stem, "houston");
  NodeFS.writeFileSync(
    executable,
    [
      "#!/bin/sh",
      `if [ "$1" = "--version" ]; then echo ${VERSION}; exit 0; fi`,
      'echo "ran: $*"',
      'echo "launcher: $HOUSTON_NPM_LAUNCHER_PATH"',
      "",
    ].join("\n"),
  );
  NodeFS.chmodSync(executable, 0o755);
  const archive = NodePath.join(root, `${stem}.tar.gz`);
  NodeChildProcess.execFileSync("tar", ["-czf", archive, "-C", stage, stem]);
  return archive;
}

async function serveRelease(files) {
  const requests = [];
  const server = NodeHttp.createServer((request, response) => {
    requests.push(request.url);
    const body = files.get(request.url);
    if (body === undefined) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { "content-length": body.length }).end(body);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    baseUrl: `http://127.0.0.1:${port}/download`,
    requests,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

/** Async: the fake release server runs in this process, so a blocking spawn would deadlock. */
function runLauncher(launcher, args, env) {
  return new Promise((resolve, reject) => {
    const child = NodeChildProcess.spawn(process.execPath, [launcher, ...args], {
      env: { ...process.env, ...env },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

NodeTest.test(
  "the manifest publishes houston-app with a houston bin and the migration head",
  () => {
    const manifest = npmLauncherPackageManifest(VERSION, 78);
    NodeAssert.equal(manifest.name, "houston-app");
    NodeAssert.equal(manifest.version, VERSION);
    NodeAssert.deepEqual(manifest.bin, { houston: "./bin/houston.mjs" });
    NodeAssert.deepEqual(manifest.houston, { databaseMigration: 78 });
    NodeAssert.deepEqual(manifest.files, ["bin"]);
  },
);

NodeTest.test("the migration head is the highest numbered server migration file", () => {
  const head = latestServerMigrationId();
  NodeAssert.ok(Number.isInteger(head) && head > 0, `expected a positive id, got ${head}`);
});

NodeTest.test("houstonHome defaults to the server's v2 directory and honours HOUSTON_HOME", () => {
  NodeAssert.equal(houstonHome({}, "/home/u"), NodePath.join("/home/u", ".houston", "v2"));
  NodeAssert.equal(houstonHome({ HOUSTON_HOME: "~/elsewhere" }, "/home/u"), "/home/u/elsewhere");
  NodeAssert.equal(houstonHome({ HOUSTON_HOME: "/srv/h" }, "/home/u"), "/srv/h");
});

NodeTest.test(
  "an unsupported platform is refused by name, with the in-app route on Windows",
  () => {
    const message = unsupportedPlatformMessage("win32-x64");
    NodeAssert.match(message, /win32-x64/);
    NodeAssert.match(message, /linux-x64/);
    NodeAssert.match(message, /What went wrong\?/);
    NodeAssert.doesNotMatch(unsupportedPlatformMessage("freebsd-x64"), /What went wrong/);
  },
);

NodeTest.test("the build writes a publishable tarball rooted under package/", async () => {
  const out = tempDir("npm-launcher-build-");
  try {
    const { packageDir, tarball } = await buildNpmLauncher({ version: VERSION, outputDir: out });
    NodeAssert.equal(tarball, NodePath.join(out, `${NPM_LAUNCHER_PACKAGE_NAME}.tgz`));
    const listing = NodeChildProcess.execFileSync("tar", ["-tzf", tarball], { encoding: "utf8" })
      .split("\n")
      .filter(Boolean)
      .sort();
    NodeAssert.deepEqual(listing, [
      "package/",
      "package/README.md",
      "package/bin/",
      "package/bin/houston.mjs",
      "package/package.json",
    ]);
    const manifest = JSON.parse(
      NodeFS.readFileSync(NodePath.join(packageDir, "package.json"), "utf8"),
    );
    NodeAssert.equal(manifest.version, VERSION);
    NodeAssert.ok(NodeFS.statSync(NodePath.join(packageDir, "bin/houston.mjs")).mode & 0o100);
  } finally {
    NodeFS.rmSync(out, { recursive: true, force: true });
  }
});

NodeTest.test(
  "the launcher downloads, verifies and caches the release archive, then runs it",
  { skip: !canRunLauncher && `no archive is built for ${PLATFORM_KEY}` },
  async () => {
    const root = tempDir("npm-launcher-run-");
    try {
      const { packageDir } = await buildNpmLauncher({
        version: VERSION,
        outputDir: NodePath.join(root, "out"),
      });
      const archive = NodeFS.readFileSync(fakeArchive(root));
      const archiveName = `houston-${VERSION}-${PLATFORM_KEY}.tar.gz`;
      const sha = NodeCrypto.createHash("sha256").update(archive).digest("hex");
      const release = await serveRelease(
        new Map([
          [`/download/v${VERSION}/SHA256SUMS`, Buffer.from(`${sha}  ${archiveName}\n`)],
          [`/download/v${VERSION}/${archiveName}`, archive],
        ]),
      );
      const home = NodePath.join(root, "home");
      const launcher = NodePath.join(packageDir, "bin/houston.mjs");
      const env = { HOUSTON_HOME: home, HOUSTON_RELEASE_BASE_URL: release.baseUrl };
      try {
        const first = await runLauncher(launcher, ["triage", "--agent", "claude"], env);
        NodeAssert.equal(first.status, 0, first.stderr);
        NodeAssert.match(first.stdout, /ran: triage --agent claude/);
        NodeAssert.match(first.stdout, new RegExp(`launcher: ${launcher}`));
        NodeAssert.ok(
          NodeFS.existsSync(NodePath.join(home, "runtime/versions", VERSION, ".install-complete")),
        );
        const fetched = release.requests.length;

        const second = await runLauncher(launcher, ["triage"], env);
        NodeAssert.equal(second.status, 0, second.stderr);
        NodeAssert.equal(release.requests.length, fetched, "a cached install fetches nothing");
      } finally {
        await release.close();
      }
    } finally {
      NodeFS.rmSync(root, { recursive: true, force: true });
    }
  },
);

NodeTest.test(
  "the launcher refuses an archive whose checksum does not match SHA256SUMS",
  { skip: !canRunLauncher && `no archive is built for ${PLATFORM_KEY}` },
  async () => {
    const root = tempDir("npm-launcher-sum-");
    try {
      const { packageDir } = await buildNpmLauncher({
        version: VERSION,
        outputDir: NodePath.join(root, "out"),
      });
      const archiveName = `houston-${VERSION}-${PLATFORM_KEY}.tar.gz`;
      const release = await serveRelease(
        new Map([
          [`/download/v${VERSION}/SHA256SUMS`, Buffer.from(`${"0".repeat(64)}  ${archiveName}\n`)],
          [`/download/v${VERSION}/${archiveName}`, NodeFS.readFileSync(fakeArchive(root))],
        ]),
      );
      const home = NodePath.join(root, "home");
      try {
        const result = await runLauncher(NodePath.join(packageDir, "bin/houston.mjs"), ["triage"], {
          HOUSTON_HOME: home,
          HOUSTON_RELEASE_BASE_URL: release.baseUrl,
        });
        NodeAssert.equal(result.status, 1);
        NodeAssert.match(result.stderr, new RegExp(`checksum mismatch for ${archiveName}`));
        NodeAssert.ok(!NodeFS.existsSync(NodePath.join(home, "runtime/versions", VERSION)));
      } finally {
        await release.close();
      }
    } finally {
      NodeFS.rmSync(root, { recursive: true, force: true });
    }
  },
);
