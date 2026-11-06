#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalConsole:off globalDate:off - a command-line harness that prints progress and writes result files.
// SQLite load test: builds scaled databases from the real schema and write paths, times the
// server's hot-path queries on each, and compares runs. See docs/operations/development.md.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

import { ensureDatabases } from "./buildMain.ts";
import { compareResults, formatComparison, type Comparison } from "./compare.ts";
import { DEFAULT_DATA_DIR } from "./paths.ts";
import { renderReport } from "./report.ts";
import { runAll, type RunResults } from "./run.ts";

const DEFAULT_SEED = 20261106;

const { positionals, values } = NodeUtil.parseArgs({
  allowPositionals: true,
  options: {
    scales: { type: "string", default: "1,10,100" },
    seed: { type: "string", default: String(DEFAULT_SEED) },
    "data-dir": { type: "string", default: DEFAULT_DATA_DIR },
    out: { type: "string" },
    label: { type: "string", default: "run" },
    only: { type: "string" },
    rebuild: { type: "boolean", default: false },
    "target-ms": { type: "string", default: "2000" },
    "min-reps": { type: "string", default: "30" },
    "max-reps": { type: "string", default: "200" },
    "cap-ms": { type: "string", default: "60000" },
    warmup: { type: "string", default: "3" },
    before: { type: "string" },
    after: { type: "string" },
    results: { type: "string" },
  },
});

const log = (line: string) => console.log(`${new Date().toISOString().slice(11, 19)} ${line}`);
const command = positionals[0] ?? "run";
const scales = values.scales.split(",").map((s) => Number(s.trim()));
if (scales.some((s) => !Number.isInteger(s) || s < 1)) {
  throw new Error(`--scales takes positive integers separated by commas, got "${values.scales}".`);
}
const seed = Number(values.seed);
const readJson = <T>(path: string): T => JSON.parse(NodeFS.readFileSync(path, "utf8")) as T;
const outDir = (fallback: string) => {
  const dir = NodePath.resolve(
    values.out ?? NodePath.join(values["data-dir"], "results", fallback),
  );
  NodeFS.mkdirSync(dir, { recursive: true });
  return dir;
};
const write = (dir: string, name: string, content: string) => {
  const path = NodePath.join(dir, name);
  NodeFS.writeFileSync(path, content);
  log(`wrote ${path}`);
};

function gitSha(): string {
  try {
    const sha = NodeChildProcess.execFileSync("git", ["rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim();
    const dirty = NodeChildProcess.execFileSync("git", ["status", "--porcelain", "--", "src"], {
      encoding: "utf8",
    }).trim();
    return dirty.length > 0 ? `${sha}+dirty` : sha;
  } catch {
    return "unknown";
  }
}

switch (command) {
  case "build": {
    await ensureDatabases({
      dataDir: values["data-dir"],
      scales,
      seed,
      rebuild: values.rebuild,
      log,
    });
    break;
  }
  case "run": {
    const manifests = await ensureDatabases({
      dataDir: values["data-dir"],
      scales,
      seed,
      rebuild: values.rebuild,
      log,
    });
    const results = await runAll(manifests, {
      label: values.label,
      gitSha: gitSha(),
      seed,
      only: values.only?.split(","),
      targetMs: Number(values["target-ms"]),
      minReps: Number(values["min-reps"]),
      maxReps: Number(values["max-reps"]),
      capMs: Number(values["cap-ms"]),
      warmup: Number(values.warmup),
      log,
    });
    const dir = outDir(values.label);
    write(dir, "results.json", JSON.stringify(results));
    write(dir, "report.html", renderReport(results));
    break;
  }
  case "compare": {
    if (values.before === undefined || values.after === undefined) {
      throw new Error("compare needs --before <results.json> and --after <results.json>.");
    }
    const before = readJson<RunResults>(values.before);
    const after = readJson<RunResults>(values.after);
    const comparison = compareResults(before, after);
    const dir = outDir(`${before.label}-vs-${after.label}`);
    console.log(formatComparison(comparison));
    write(dir, "comparison.json", JSON.stringify(comparison, null, 1));
    write(dir, "comparison.txt", formatComparison(comparison));
    write(dir, "report.html", renderReport(after, { before, comparison }));
    break;
  }
  case "report": {
    if (values.results === undefined) throw new Error("report needs --results <results.json>.");
    const results = readJson<RunResults>(values.results);
    const extra =
      values.before === undefined
        ? undefined
        : (() => {
            const before = readJson<RunResults>(values.before);
            return { before, comparison: compareResults(before, results) satisfies Comparison };
          })();
    write(outDir(results.label), "report.html", renderReport(results, extra));
    break;
  }
  default:
    throw new Error(`Unknown command "${command}"; expected build, run, compare or report.`);
}
