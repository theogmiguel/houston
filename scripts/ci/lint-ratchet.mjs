#!/usr/bin/env node
// Lint ratchet: the tree carries lint errors that predate the gate, so the gate
// compares each file's error count with scripts/lint-baseline.json instead of
// demanding zero. A file may keep or lower its count; any increase, and any
// error in a file without an entry, fails. Lowering a count is recorded with
// --update so the allowance only ever falls.
//
//   node scripts/ci/lint-ratchet.mjs            check the whole tree (about 16 s)
//   node scripts/ci/lint-ratchet.mjs <files>    check only these files (pre-push)
//   node scripts/ci/lint-ratchet.mjs --update   rewrite the baseline from the whole tree
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const REPO_ROOT = NodePath.resolve(
  NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
  "../..",
);
const BASELINE_PATH = NodePath.join(REPO_ROOT, "scripts/lint-baseline.json");
// A whole-tree JSON report is about 200 KB today; 256 MB leaves room for a tree that is 1000x worse.
const MAX_REPORT_BYTES = 256 * 1024 * 1024;

/** Error diagnostics grouped by repo-relative file path. */
export function groupErrorsByFile(diagnostics) {
  const byFile = new Map();
  for (const diagnostic of diagnostics) {
    if (diagnostic.severity !== "error") continue;
    const file = String(diagnostic.filename).split(NodePath.sep).join("/");
    const list = byFile.get(file) ?? [];
    list.push(diagnostic);
    byFile.set(file, list);
  }
  return byFile;
}

/**
 * Compare grouped errors with a baseline of allowed counts. `scope` limits which files are judged:
 * a file outside it is neither a regression nor an improvement.
 */
export function compareToBaseline(byFile, baseline, scope = null) {
  const inScope = (file) => scope === null || scope.has(file);
  const regressions = [];
  const improvements = [];
  for (const [file, diagnostics] of byFile) {
    if (!inScope(file)) continue;
    const allowed = baseline[file] ?? 0;
    if (diagnostics.length > allowed)
      regressions.push({ file, count: diagnostics.length, allowed, diagnostics });
  }
  for (const [file, allowed] of Object.entries(baseline)) {
    if (!inScope(file)) continue;
    const count = byFile.get(file)?.length ?? 0;
    if (count < allowed) improvements.push({ file, count, allowed });
  }
  return { regressions, improvements };
}

export function formatRegression({ file, count, allowed, diagnostics }) {
  const lines = diagnostics.map((d) => {
    const label = d.labels?.[0]?.span;
    const where = label ? `${file}:${label.line}:${label.column}` : file;
    return `  ${where} ${d.code}: ${d.message}`;
  });
  return `${file} has ${count} lint error(s), baseline allows ${allowed}; fix the new errors (or lower the count and run --update):\n${lines.join("\n")}`;
}

function runLint(files) {
  const args = [
    "exec",
    "vp",
    "lint",
    "--report-unused-disable-directives",
    "--format",
    "json",
    "--no-error-on-unmatched-pattern",
    ...files,
  ];
  const result = NodeChildProcess.spawnSync("pnpm", args, {
    cwd: REPO_ROOT,
    encoding: "utf8",
    maxBuffer: MAX_REPORT_BYTES,
    shell: process.platform === "win32",
  });
  // Oxlint exits 1 when it reports errors, which is the normal state here; only a missing report is a failure.
  const start = result.stdout.indexOf("{");
  if (result.error || start < 0) {
    throw new Error(
      `lint-ratchet: vp lint produced no JSON report (exit ${result.status}); expected a JSON document on stdout. stderr: ${result.stderr?.slice(0, 500) ?? ""}`,
    );
  }
  return JSON.parse(result.stdout.slice(start)).diagnostics ?? [];
}

function main() {
  const argv = process.argv.slice(2);
  const update = argv.includes("--update");
  const files = argv
    .filter((arg) => !arg.startsWith("--"))
    .map((f) => f.split(NodePath.sep).join("/"));
  if (update && files.length > 0) {
    throw new Error(
      `lint-ratchet: --update rewrites the whole baseline; got file arguments ${JSON.stringify(files)}, expected none`,
    );
  }
  const byFile = groupErrorsByFile(runLint(files));
  if (update) {
    const baseline = Object.fromEntries(
      [...byFile].map(([file, list]) => [file, list.length]).sort(([a], [b]) => a.localeCompare(b)),
    );
    NodeFS.writeFileSync(BASELINE_PATH, `${JSON.stringify(baseline, null, 2)}\n`);
    const total = Object.values(baseline).reduce((sum, n) => sum + n, 0);
    process.stdout.write(
      `lint-ratchet: wrote ${NodePath.relative(REPO_ROOT, BASELINE_PATH)} (${total} error(s) in ${Object.keys(baseline).length} file(s))\n`,
    );
    return;
  }
  const baseline = JSON.parse(NodeFS.readFileSync(BASELINE_PATH, "utf8"));
  const { regressions, improvements } = compareToBaseline(
    byFile,
    baseline,
    files.length > 0 ? new Set(files) : null,
  );
  if (regressions.length > 0) {
    process.stderr.write(`${regressions.map(formatRegression).join("\n")}\n`);
    process.stderr.write(`lint-ratchet: ${regressions.length} file(s) above their baseline\n`);
    process.exitCode = 1;
    return;
  }
  const note =
    improvements.length > 0
      ? `; ${improvements.length} file(s) are below baseline, run --update to lock that in`
      : "";
  process.stdout.write(`lint-ratchet: ok${note}\n`);
}

if (
  process.argv[1] &&
  NodePath.resolve(process.argv[1]) === NodeURL.fileURLToPath(import.meta.url)
) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
