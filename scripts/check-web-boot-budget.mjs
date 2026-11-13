#!/usr/bin/env node
// Fails when the renderer's boot closure outgrows its budget. Run after the web build:
//   node scripts/check-web-boot-budget.mjs [--verbose] [apps/web/dist]
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeZlib from "node:zlib";

// Measured at 3,981,009 bytes once rarely used dialogs loaded on demand. The 2% headroom absorbs
// build-environment defines and small additions; beyond it, load the new code with a dynamic
// import or raise this with the reason in the commit.
export const BOOT_BUDGET_BYTES = 4_060_000;

// What a cold start loads before React mounts: each entry and its static imports, plus the
// chunks its own dynamic imports preload (bootstrap.ts → main.tsx), with their stylesheets.
export function bootClosure(manifest) {
  const files = new Set();
  const visited = new Set();
  const visit = (key) => {
    if (visited.has(key)) return;
    visited.add(key);
    const chunk = manifest[key];
    if (!chunk) throw new Error(`Manifest has no entry ${JSON.stringify(key)}`);
    files.add(chunk.file);
    for (const css of chunk.css ?? []) files.add(css);
    for (const imported of chunk.imports ?? []) visit(imported);
  };
  const entries = Object.keys(manifest).filter((key) => manifest[key].isEntry);
  if (entries.length === 0) throw new Error("Manifest has no entry chunk (isEntry: true)");
  for (const key of entries) {
    visit(key);
    for (const dynamic of manifest[key].dynamicImports ?? []) visit(dynamic);
  }
  return [...files].toSorted();
}

export function measure(distDir, files) {
  let raw = 0;
  let gzip = 0;
  const sizes = files.map((file) => {
    const bytes = NodeFS.readFileSync(NodePath.join(distDir, file));
    const zipped = NodeZlib.gzipSync(bytes, { level: 9 }).length;
    raw += bytes.length;
    gzip += zipped;
    return { file, raw: bytes.length, gzip: zipped };
  });
  return { raw, gzip, sizes: sizes.toSorted((a, b) => b.raw - a.raw) };
}

function main() {
  const repoRoot = NodeURL.fileURLToPath(new URL("..", import.meta.url));
  const args = process.argv.slice(2);
  const verbose = args.includes("--verbose");
  const distArg = args.find((arg) => !arg.startsWith("--"));
  const distDir = NodePath.resolve(distArg ?? NodePath.join(repoRoot, "apps/web/dist"));
  const manifestPath = NodePath.join(distDir, ".vite/manifest.json");
  if (!NodeFS.existsSync(manifestPath)) {
    console.error(`No build manifest at ${manifestPath}. Run the web build first.`);
    process.exit(1);
  }
  const manifest = JSON.parse(NodeFS.readFileSync(manifestPath, "utf8"));
  const { raw, gzip, sizes } = measure(distDir, bootClosure(manifest));
  for (const { file, raw: bytes } of verbose ? sizes : sizes.slice(0, 10)) {
    console.log(`${String(bytes).padStart(10)}  ${file}`);
  }
  console.log(
    `Boot closure: ${sizes.length} files, ${raw} bytes (${gzip} gzip); budget ${BOOT_BUDGET_BYTES} bytes.`,
  );
  if (raw > BOOT_BUDGET_BYTES) {
    console.error(
      `The boot closure is ${raw} bytes, ${raw - BOOT_BUDGET_BYTES} over the ${BOOT_BUDGET_BYTES}-byte budget. ` +
        "Load the new code with a dynamic import, or raise BOOT_BUDGET_BYTES with the reason.",
    );
    process.exitCode = 1;
  }
}

if (
  process.argv[1] &&
  NodePath.resolve(process.argv[1]) === NodeURL.fileURLToPath(import.meta.url)
) {
  main();
}
