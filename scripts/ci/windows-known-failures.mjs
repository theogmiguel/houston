#!/usr/bin/env node
// Windows server ratchet: a shard fails on any failed test missing from
// scripts/ci/windows-known-failures.json and on any listed test that now passes.
//   --exit-code <n> <report.json>   check one shard's vitest JSON report
//   --update <report.json>...       rewrite the list from every shard's report
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const REPO_ROOT = NodePath.resolve(
  NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
  "../..",
);
export const BASELINE_PATH = NodePath.join(REPO_ROOT, "scripts/ci/windows-known-failures.json");
const SERVER_ROOT_MARKER = "apps/server/";
export const LOAD_FAILURE = "(file failed to run)";

/** The suite file of a report entry, relative to apps/server with forward slashes. */
export function serverRelativeFile(absolutePath) {
  const posix = String(absolutePath).replaceAll("\\", "/");
  const index = posix.lastIndexOf(SERVER_ROOT_MARKER);
  if (index === -1) {
    throw new Error(
      `windows-known-failures: report file ${JSON.stringify(absolutePath)} is outside apps/server; expected a path containing "${SERVER_ROOT_MARKER}"`,
    );
  }
  return posix.slice(index + SERVER_ROOT_MARKER.length);
}

/** Files that ran and the failure keys a vitest JSON report holds. */
export function readReport(report) {
  if (!report || !Array.isArray(report.testResults)) {
    throw new Error(
      `windows-known-failures: expected a vitest JSON report with a testResults array; got keys ${JSON.stringify(Object.keys(report ?? {}))}`,
    );
  }
  const ranFiles = new Set();
  const failures = new Set();
  for (const suite of report.testResults) {
    const file = serverRelativeFile(suite.name);
    ranFiles.add(file);
    const failedTests = (suite.assertionResults ?? []).filter((test) => test.status === "failed");
    for (const test of failedTests) {
      failures.add(`${file} > ${[...(test.ancestorTitles ?? []), test.title].join(" > ")}`);
    }
    // An import error or a crash outside a test fails the file without failing any test in it.
    if (suite.status === "failed" && failedTests.length === 0) {
      failures.add(`${file} > ${LOAD_FAILURE}`);
    }
  }
  return { ranFiles, failures };
}

/** New failures and listed tests that ran without failing. */
export function compareToBaseline({ ranFiles, failures }, baseline) {
  const known = new Set(baseline);
  const unexpected = [...failures].filter((key) => !known.has(key)).sort();
  const fixed = baseline
    .filter((key) => ranFiles.has(key.slice(0, key.indexOf(" > "))) && !failures.has(key))
    .sort();
  return { unexpected, fixed };
}

function readJson(path) {
  return JSON.parse(NodeFS.readFileSync(path, "utf8"));
}

function main(argv) {
  if (argv[0] === "--update") {
    const paths = argv.slice(1);
    if (paths.length === 0) {
      throw new Error("windows-known-failures: --update needs every shard's report path; got none");
    }
    const all = new Set();
    for (const path of paths) for (const key of readReport(readJson(path)).failures) all.add(key);
    NodeFS.writeFileSync(BASELINE_PATH, `${JSON.stringify([...all].sort(), null, 2)}\n`);
    console.log(`windows-known-failures: wrote ${all.size} entries from ${paths.length} report(s)`);
    return 0;
  }
  if (argv[0] !== "--exit-code" || argv.length !== 3 || !/^\d+$/.test(argv[1])) {
    throw new Error(
      `windows-known-failures: expected "--exit-code <n> <report.json>" or "--update <report.json>..."; got ${JSON.stringify(argv)}`,
    );
  }
  const exitCode = Number(argv[1]);
  const reportPath = argv[2];
  if (!NodeFS.existsSync(reportPath)) {
    console.error(
      `windows-known-failures: vitest exited ${exitCode} without writing ${reportPath}; the run crashed before reporting`,
    );
    return 1;
  }
  const result = readReport(readJson(reportPath));
  const baseline = readJson(BASELINE_PATH);
  const { unexpected, fixed } = compareToBaseline(result, baseline);
  // Vitest also fails a run on unhandled errors, which no test carries.
  if (exitCode !== 0 && result.failures.size === 0) {
    console.error(
      `windows-known-failures: vitest exited ${exitCode} but reported no failed test; read the log above for an unhandled error`,
    );
    return 1;
  }
  for (const key of unexpected) console.error(`new Windows failure: ${key}`);
  for (const key of fixed) {
    console.error(
      `now passes on Windows, remove it from scripts/ci/windows-known-failures.json: ${key}`,
    );
  }
  if (unexpected.length > 0 || fixed.length > 0) {
    console.error(
      `windows-known-failures: ${unexpected.length} new failure(s) and ${fixed.length} fixed test(s) still listed, across ${result.ranFiles.size} file(s) in this shard`,
    );
    return 1;
  }
  console.log(
    `windows-known-failures: ok (${result.failures.size} known failure(s) across ${result.ranFiles.size} file(s) in this shard)`,
  );
  return 0;
}

if (import.meta.url === NodeURL.pathToFileURL(process.argv[1] ?? "").href) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
