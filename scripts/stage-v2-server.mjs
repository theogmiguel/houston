#!/usr/bin/env node
/**
 * Stage the v2 server single-executable and the node_modules tree it resolves
 * native packages from into src-tauri/v2-server/, where tauri.conf.json bundles
 * it as a resource. The Tauri host runs the executable directly; it never looks
 * for a Node runtime when the bundle is present.
 */
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { selectCliRuntimeExternalDependencies } from "./lib/cli-external-packages.ts";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const isWindows = process.platform === "win32";
const outputDir = join(repoRoot, "src-tauri", "v2-server");
const executableName = `houston-v2-server${isWindows ? ".exe" : ""}`;
const builtExecutable = join(
  repoRoot,
  "apps",
  "server",
  "dist-exe",
  `t3${isWindows ? ".exe" : ""}`,
);

const externalPatches = [
  "@ff-labs__fff-node@0.11.0.patch",
  "node-pty@1.2.0-beta.15.patch",
];

const platformKey =
  process.platform === "win32"
    ? process.arch === "arm64"
      ? "win32-arm64"
      : "win32-x64"
    : process.platform === "darwin"
      ? process.arch === "arm64"
        ? "darwin-arm64"
        : "darwin-x64"
      : process.arch === "arm64"
        ? "linux-arm64"
        : "linux-x64";

function fail(message) {
  console.error(`[stage-v2-server] ${message}`);
  process.exit(1);
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    stdio: "inherit",
    shell: isWindows,
  });
  if (result.status !== 0) {
    fail(`${command} ${args.join(" ")} exited with ${result.status ?? "no status"}`);
  }
}

function directorySize(dir) {
  let total = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    total += entry.isDirectory() ? directorySize(path) : lstatSync(path).size;
  }
  return total;
}

if (!existsSync(builtExecutable)) {
  fail(
    `${builtExecutable} is missing. Run \`pnpm --filter houston build:exe\` with the Node version pinned in package.json engines.node first.`,
  );
}

mkdirSync(outputDir, { recursive: true });
for (const entry of readdirSync(outputDir)) {
  if (entry !== ".gitkeep") {
    rmSync(join(outputDir, entry), { recursive: true, force: true });
  }
}

// Resolve the exact versions the workspace installed, then keep only packages
// the SEA leaves external at runtime.
const listed = spawnSync(
  "pnpm",
  ["--filter", "houston", "list", "--depth", "0", "--prod", "--json"],
  { cwd: repoRoot, encoding: "utf8", shell: isWindows },
);
if (listed.status !== 0) {
  fail(`pnpm list exited with ${listed.status ?? "no status"}: ${listed.stderr}`);
}
const [serverPackage] = JSON.parse(listed.stdout);
const resolvedDependencies = Object.fromEntries(
  Object.entries(serverPackage?.dependencies ?? {}).map(([name, info]) => [
    name,
    info.version,
  ]),
);
const runtimeDependencies = selectCliRuntimeExternalDependencies(resolvedDependencies);
const runtimeNames = Object.keys(runtimeDependencies);
if (runtimeNames.length === 0) {
  fail(`no runtime-external packages were selected from ${JSON.stringify(resolvedDependencies)}`);
}

writeFileSync(
  join(outputDir, "package.json"),
  `${JSON.stringify(
    {
      name: "houston-v2-runtime",
      private: true,
      dependencies: runtimeDependencies,
    },
    null,
    2,
  )}\n`,
);
mkdirSync(join(outputDir, "patches"), { recursive: true });
for (const patch of externalPatches) {
  cpSync(join(repoRoot, "patches", patch), join(outputDir, "patches", patch));
}
writeFileSync(
  join(outputDir, "pnpm-workspace.yaml"),
  [
    "nodeLinker: hoisted",
    "allowBuilds:",
    "  node-pty: true",
    "patchedDependencies:",
    `  "@ff-labs/fff-node@0.11.0": patches/@ff-labs__fff-node@0.11.0.patch`,
    "  node-pty@1.2.0-beta.15: patches/node-pty@1.2.0-beta.15.patch",
    "",
  ].join("\n"),
);

run("pnpm", ["install", "--prod"], outputDir);

cpSync(builtExecutable, join(outputDir, executableName));
if (!isWindows) {
  chmodSync(join(outputDir, executableName), 0o755);
}

// The Tauri webview loads its own frontendDist, so the server's browser client
// would duplicate the web app in the installer; desktop mode does not need it.
console.log("[stage-v2-server] skipping the server's browser client/; the webview is the renderer");

for (const entry of [
  "package.json",
  "pnpm-workspace.yaml",
  "pnpm-lock.yaml",
  "patches",
  join("node_modules", ".bin"),
  join("node_modules", ".pnpm"),
  join("node_modules", ".modules.yaml"),
  join("node_modules", ".pnpm-workspace-state-v1.json"),
]) {
  rmSync(join(outputDir, entry), { recursive: true, force: true });
}

const prebuilds = join(outputDir, "node_modules", "node-pty", "prebuilds");
if (existsSync(prebuilds)) {
  for (const entry of readdirSync(prebuilds)) {
    if (entry !== platformKey) {
      rmSync(join(prebuilds, entry), { recursive: true, force: true });
    }
  }
}

const executableBytes = lstatSync(join(outputDir, executableName)).size;
const treeBytes = directorySize(outputDir);
console.log(
  `[stage-v2-server] wrote ${outputDir}: executable ${executableBytes} bytes (t3 -> ${executableName}), runtime ${treeBytes} bytes total for ${platformKey}`,
);
