#!/usr/bin/env node
// Packages the server single-executable with the files a runtime needs beside it.
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SUPPORTED = { linux: ["x64", "arm64"] };
// The deploy installs the server's production closure without the workspace-only
// patches pnpm would otherwise refuse as unused. These two patches change runtime
// behaviour and their patch keys track the versions pnpm-lock.yaml pins.
const RUNTIME_PATCHES = {
  "node-pty@1.2.0-beta.15": "patches/node-pty@1.2.0-beta.15.patch",
  "@ff-labs/fff-node@0.11.0": "patches/@ff-labs__fff-node@0.11.0.patch",
};

function option(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

const platform = option("platform") ?? "linux";
const arch = option("arch");
const version = option("version");
const outputDir = resolve(option("output-dir") ?? join(ROOT, "release-server"));
if (!SUPPORTED[platform]?.includes(arch)) {
  throw new Error(
    `Unsupported server archive target ${platform}-${arch}; expected linux-x64 or linux-arm64.`,
  );
}
if (!version) throw new Error("Pass --version <X.Y.Z> so the archive name matches the release.");

const serverDir = join(ROOT, "apps/server");
const executable = join(serverDir, "dist-exe", "houston");
const client = join(serverDir, "dist", "client");
for (const [path, hint] of [
  [executable, "run `pnpm --filter houston run build:exe` first"],
  [join(client, "index.html"), "run `pnpm --filter @t3tools/web build` and the server build first"],
]) {
  if (!existsSync(path)) throw new Error(`Missing ${path}; ${hint}.`);
}

const stem = `houston-${version}-${platform}-${arch}`;
const stageRoot = mkdtempSync(join(tmpdir(), "houston-server-archive-"));
const content = join(stageRoot, stem);
mkdirSync(content, { recursive: true });
try {
  cpSync(executable, join(content, "houston"));
  chmodSync(join(content, "houston"), 0o755);
  cpSync(client, join(content, "client"), { recursive: true });
  for (const entry of readdirSync(join(content, "client"), { recursive: true })) {
    if (entry.endsWith(".map")) rmSync(join(content, "client", entry), { force: true });
  }
  const resourceMonitor = join(serverDir, "dist", "resource-monitor");
  if (existsSync(resourceMonitor)) {
    cpSync(resourceMonitor, join(content, "resource-monitor"), { recursive: true });
  }

  const deployed = join(stageRoot, "deploy");
  const patches = JSON.stringify(RUNTIME_PATCHES);
  // CI installs pnpm on PATH; developer shells reach it through corepack.
  const pnpm = spawnSync("pnpm", ["--version"], { stdio: "ignore" }).status === 0
    ? ["pnpm"]
    : ["corepack", "pnpm"];
  const deploy = spawnSync(
    pnpm[0],
    [
      ...pnpm.slice(1),
      "--filter",
      "houston",
      "deploy",
      deployed,
      "--prod",
      "--legacy",
      `--config.patchedDependencies=${patches}`,
    ],
    { cwd: ROOT, stdio: "inherit" },
  );
  if (deploy.status !== 0) throw new Error(`pnpm deploy exited with ${deploy.status}.`);
  cpSync(join(deployed, "node_modules"), join(content, "node_modules"), {
    recursive: true,
    verbatimSymlinks: true,
  });

  mkdirSync(outputDir, { recursive: true });
  const archive = join(outputDir, `${stem}.tar.gz`);
  rmSync(archive, { force: true });
  const tar = spawnSync("tar", ["--hard-dereference", "-czf", archive, "-C", stageRoot, stem], {
    stdio: "inherit",
  });
  if (tar.status !== 0) throw new Error(`tar exited with ${tar.status}.`);
  console.log(archive);
} finally {
  rmSync(stageRoot, { recursive: true, force: true });
}
