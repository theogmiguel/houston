#!/usr/bin/env node
// Reports where CI wall-clock time goes. Reads the last completed runs of the
// CI workflow through the gh CLI and splits each job into queue time
// (started - created) and run time (completed - started).
import * as NodeChildProcess from "node:child_process";
import * as NodeURL from "node:url";

const parseTimestamp = (value) => {
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
};

/** Nearest-rank percentile: the value at ceil(p/100 * n), 1-indexed. */
export function percentile(values, p) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[Math.min(rank, sorted.length) - 1];
}

/**
 * Summarize runs shaped as
 * { createdAt, updatedAt, jobs: [{ name, createdAt, startedAt, completedAt }] }.
 * Durations are milliseconds; missing timestamps (a skipped job) are ignored.
 */
export function summarizeRuns(runs) {
  const byJob = new Map();
  const wallClocks = [];

  for (const run of runs) {
    const created = parseTimestamp(run.createdAt);
    const updated = parseTimestamp(run.updatedAt);
    if (created !== null && updated !== null && updated >= created)
      wallClocks.push(updated - created);

    for (const job of run.jobs ?? []) {
      if (typeof job.name !== "string" || job.name.length === 0) continue;
      const jobCreated = parseTimestamp(job.createdAt) ?? created;
      const started = parseTimestamp(job.startedAt);
      const completed = parseTimestamp(job.completedAt);
      if (started === null) continue;

      const entry = byJob.get(job.name) ?? { waiting: [], running: [] };
      if (jobCreated !== null && started >= jobCreated) entry.waiting.push(started - jobCreated);
      if (completed !== null && completed >= started) entry.running.push(completed - started);
      byJob.set(job.name, entry);
    }
  }

  const jobs = [...byJob.entries()]
    .map(([name, durations]) => ({
      name,
      samples: Math.max(durations.waiting.length, durations.running.length),
      waiting: {
        median: percentile(durations.waiting, 50),
        p90: percentile(durations.waiting, 90),
      },
      running: {
        median: percentile(durations.running, 50),
        p90: percentile(durations.running, 90),
      },
    }))
    .sort((left, right) => (right.running.median ?? 0) - (left.running.median ?? 0));

  return {
    runs: wallClocks.length,
    jobs,
    wallClock: { median: percentile(wallClocks, 50), p90: percentile(wallClocks, 90) },
  };
}

const seconds = (milliseconds) =>
  milliseconds === null || milliseconds === undefined ? "-" : (milliseconds / 1000).toFixed(1);

export function renderMarkdown(summary, { branch, requested }) {
  const lines = [
    `# CI timing: ${branch} (last ${requested} completed runs)`,
    "",
    `${summary.runs} run(s) carried timestamps. Times are seconds; waiting is job start minus run creation.`,
    "",
    "| Job | Samples | Waiting median | Waiting p90 | Running median | Running p90 |",
    "|---|---|---|---|---|---|",
  ];
  for (const job of summary.jobs) {
    lines.push(
      `| ${job.name} | ${job.samples} | ${seconds(job.waiting.median)} | ${seconds(job.waiting.p90)} | ${seconds(job.running.median)} | ${seconds(job.running.p90)} |`,
    );
  }
  lines.push(
    "",
    "| Run wall clock | Median | p90 |",
    "|---|---|---|",
    `| all jobs | ${seconds(summary.wallClock.median)} | ${seconds(summary.wallClock.p90)} |`,
    "",
  );
  return `${lines.join("\n")}\n`;
}

function gh(args) {
  try {
    return NodeChildProcess.execFileSync("gh", args, { encoding: "utf8" });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `timing-report: gh ${args.join(" ")} failed: ${detail} (expected GH_TOKEN and a gh login)`,
      { cause: error },
    );
  }
}

function currentBranch() {
  try {
    return NodeChildProcess.execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      encoding: "utf8",
    }).trim();
  } catch {
    throw new Error(
      "timing-report: no --branch given and the current branch could not be resolved",
    );
  }
}

function parseArgs(argv) {
  const options = { branch: null, runs: 30 };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--branch") options.branch = argv[++index] ?? null;
    else if (arg.startsWith("--branch=")) options.branch = arg.slice("--branch=".length);
    else if (arg === "--runs" || arg === "-n") options.runs = Number(argv[++index]);
    else if (arg.startsWith("--runs=")) options.runs = Number(arg.slice("--runs=".length));
    else
      throw new Error(
        `timing-report: unknown argument ${JSON.stringify(arg)}; expected --branch and --runs`,
      );
  }
  if (!Number.isInteger(options.runs) || options.runs < 1) {
    throw new Error(
      `timing-report: --runs must be a positive integer, got ${JSON.stringify(options.runs)}`,
    );
  }
  options.branch ??= currentBranch();
  return options;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const list = JSON.parse(
    gh([
      "run",
      "list",
      "--workflow",
      "ci.yml",
      "--branch",
      options.branch,
      "--status",
      "completed",
      "--limit",
      String(options.runs),
      "--json",
      "databaseId,createdAt,updatedAt",
    ]),
  );
  const runs = list.map((run) => {
    const view = JSON.parse(gh(["run", "view", String(run.databaseId), "--json", "jobs"]));
    return { ...run, jobs: view.jobs };
  });
  process.stdout.write(
    renderMarkdown(summarizeRuns(runs), { branch: options.branch, requested: options.runs }),
  );
}

if (process.argv[1] && NodeURL.pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
