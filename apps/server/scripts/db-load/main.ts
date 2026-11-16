#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalConsole:off globalDate:off - a command-line harness that prints progress and writes result files.
// SQLite load test: builds scaled databases from the real schema and write paths, times the
// server's hot-path queries on each, and compares runs. See docs/operations/development.md.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeUtil from "node:util";

import { blockOrder, copyDatabasesFor, measureBlock, mergeBlocks } from "./ab.ts";
import { ensureDatabases } from "./buildMain.ts";
import { compareResults, formatComparison, type Comparison } from "./compare.ts";
import { DEFAULT_DATA_DIR } from "./paths.ts";
import { renderReport } from "./report.ts";
import { assembleResults, measureScale, type RunResults, type ScaleResults } from "./run.ts";

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
    "cap-ms": { type: "string", default: "30000" },
    "heap-mb": { type: "string", default: "6144" },
    scale: { type: "string" },
    rerun: { type: "boolean", default: false },
    warmup: { type: "string", default: "3" },
    before: { type: "string" },
    after: { type: "string" },
    results: { type: "string" },
    a: { type: "string" },
    b: { type: "string" },
    "a-label": { type: "string", default: "before" },
    "b-label": { type: "string", default: "after" },
    blocks: { type: "string", default: "4" },
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

function gitSha(root?: string): string {
  try {
    const options = { encoding: "utf8" as const, ...(root === undefined ? {} : { cwd: root }) };
    const sha = NodeChildProcess.execFileSync("git", ["rev-parse", "HEAD"], options).trim();
    const dirty = NodeChildProcess.execFileSync(
      "git",
      ["status", "--porcelain", "--", "apps/server/src"],
      options,
    ).trim();
    return dirty.length > 0 ? `${sha}+dirty` : sha;
  } catch {
    return "unknown";
  }
}

const scaleFile = (dir: string, scale: number) => NodePath.join(dir, `scale-${scale}x.json`);
// Options a measuring child needs to see the same databases and repetition policy.
const forwarded = [
  "--scales",
  values.scales,
  "--seed",
  values.seed,
  "--data-dir",
  values["data-dir"],
  "--label",
  values.label,
  "--target-ms",
  values["target-ms"],
  "--min-reps",
  values["min-reps"],
  "--max-reps",
  values["max-reps"],
  "--cap-ms",
  values["cap-ms"],
  "--warmup",
  values.warmup,
  ...(values.only === undefined ? [] : ["--only", values.only]),
];

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
    const dir = outDir(values.label);
    const startedAt = new Date().toISOString();
    const perScale = new Map<number, ScaleResults>();
    for (const manifest of manifests) {
      const file = scaleFile(dir, manifest.scale);
      if (!values.rerun && NodeFS.existsSync(file)) {
        log(`${manifest.scale}x: reusing ${file} (pass --rerun to measure again)`);
        perScale.set(manifest.scale, readJson<ScaleResults>(file));
        continue;
      }
      // One process per scale with a bounded heap: a scale's garbage never meets the next scale,
      // and a large decode cannot push the machine into memory pressure.
      const child = NodeChildProcess.spawnSync(
        process.execPath,
        [
          `--max-old-space-size=${values["heap-mb"]}`,
          "--expose-gc",
          NodeURL.fileURLToPath(import.meta.url),
          "measure",
          "--scale",
          String(manifest.scale),
          "--out",
          dir,
          ...forwarded,
        ],
        { stdio: "inherit" },
      );
      if (child.status !== 0) {
        throw new Error(
          `Measuring ${manifest.scale}x exited with status ${child.status} (signal ${child.signal}); finished scales are kept in ${dir}.`,
        );
      }
      perScale.set(manifest.scale, readJson<ScaleResults>(file));
    }
    const results = assembleResults(manifests, perScale, {
      label: values.label,
      gitSha: gitSha(),
      only: values.only?.split(","),
      startedAt,
    });
    write(dir, "results.json", JSON.stringify(results));
    write(dir, "report.html", renderReport(results));
    break;
  }
  case "measure": {
    const scale = Number(values.scale);
    const manifests = await ensureDatabases({
      dataDir: values["data-dir"],
      scales,
      seed,
      rebuild: false,
      log,
    });
    const manifest = manifests.find((m) => m.scale === scale);
    if (manifest === undefined)
      throw new Error(`--scale ${values.scale} is not one of --scales ${values.scales}.`);
    const measured = await measureScale(manifest, manifests, {
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
    write(outDir(values.label), `scale-${scale}x.json`, JSON.stringify(measured));
    break;
  }
  case "ab": {
    if (values.a === undefined || values.b === undefined) {
      throw new Error("ab needs --a <checkout root> and --b <checkout root>.");
    }
    const manifests = await ensureDatabases({
      dataDir: values["data-dir"],
      scales,
      seed,
      rebuild: values.rebuild,
      log,
    });
    const sides = [
      { name: values["a-label"], root: NodePath.resolve(values.a) },
      { name: values["b-label"], root: NodePath.resolve(values.b) },
    ] as const;
    const dir = outDir(`${sides[0].name}-vs-${sides[1].name}`);
    const sideData = sides.map((side) =>
      copyDatabasesFor(side, values["data-dir"], manifests, log),
    );
    const blocks = Number(values.blocks);
    const share = (value: string) => String(Math.max(1, Math.ceil(Number(value) / blocks)));
    // Each block takes a share of the repetitions, so the total matches a single run.
    const args = [
      "--scales",
      values.scales,
      "--seed",
      values.seed,
      "--target-ms",
      share(values["target-ms"]),
      "--min-reps",
      share(values["min-reps"]),
      "--max-reps",
      share(values["max-reps"]),
      "--cap-ms",
      share(values["cap-ms"]),
      "--warmup",
      values.warmup,
      ...(values.only === undefined ? [] : ["--only", values.only]),
    ];
    const startedAt = new Date().toISOString();
    const perSide = sides.map(() => new Map<number, ScaleResults>());
    for (const manifest of manifests) {
      const parts: Array<Array<ScaleResults>> = sides.map(() => []);
      for (let block = 0; block < blocks; block++) {
        for (const index of blockOrder(0, 1, block)) {
          const side = sides[index]!;
          log(`${manifest.scale}x block ${block + 1}/${blocks}: ${side.name}`);
          parts[index]!.push(
            measureBlock({
              side,
              sideDataDir: sideData[index]!,
              scale: manifest.scale,
              out: NodePath.join(dir, side.name, `block-${block}`),
              heapMb: values["heap-mb"],
              args: [...args, "--label", `${side.name}-block-${block}`],
            }),
          );
        }
      }
      sides.forEach((_, index) => perSide[index]!.set(manifest.scale, mergeBlocks(parts[index]!)));
    }
    const [before, after] = sides.map((side, index) =>
      assembleResults(manifests, perSide[index]!, {
        label: side.name,
        gitSha: gitSha(side.root),
        only: values.only?.split(","),
        startedAt,
      }),
    ) as [RunResults, RunResults];
    const comparison = compareResults(before, after);
    console.log(formatComparison(comparison));
    write(dir, `${before.label}.json`, JSON.stringify(before));
    write(dir, `${after.label}.json`, JSON.stringify(after));
    write(dir, "comparison.json", JSON.stringify(comparison, null, 1));
    write(dir, "comparison.txt", formatComparison(comparison));
    write(dir, "report.html", renderReport(after, { before, comparison }));
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
    throw new Error(
      `Unknown command "${command}"; expected build, run, measure, ab, compare or report.`,
    );
}
