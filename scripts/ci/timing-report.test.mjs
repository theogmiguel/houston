#!/usr/bin/env node
import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";

import { percentile, renderMarkdown, summarizeRuns } from "./timing-report.mjs";

const at = (seconds) => new Date(Date.UTC(2026, 0, 1, 0, 0, seconds)).toISOString();

const fixture = [
  {
    createdAt: at(0),
    updatedAt: at(600),
    jobs: [
      { name: "static", createdAt: at(10), startedAt: at(20), completedAt: at(140) },
      { name: "test-server", createdAt: at(10), startedAt: at(60), completedAt: at(180) },
    ],
  },
  {
    createdAt: at(0),
    updatedAt: at(1200),
    jobs: [
      { name: "static", createdAt: at(10), startedAt: at(30), completedAt: at(210) },
      { name: "test-server", createdAt: at(10), startedAt: at(40), completedAt: at(280) },
    ],
  },
  {
    createdAt: at(0),
    updatedAt: at(1800),
    jobs: [
      { name: "static", createdAt: at(10), startedAt: at(40), completedAt: at(280) },
      { name: "test-server", createdAt: at(10), startedAt: null, completedAt: null },
    ],
  },
];

NodeTest.test("nearest-rank percentile matches its definition", () => {
  NodeAssert.equal(percentile([], 50), null);
  NodeAssert.equal(percentile([10, 20, 30], 50), 20);
  NodeAssert.equal(percentile([10, 20, 30], 90), 30);
  NodeAssert.equal(percentile([30, 50], 50), 30);
});

NodeTest.test("each job splits queue time from run time", () => {
  const summary = summarizeRuns(fixture);
  NodeAssert.equal(summary.runs, 3);

  const staticJob = summary.jobs.find((job) => job.name === "static");
  NodeAssert.deepEqual(staticJob.waiting, { median: 20_000, p90: 30_000 });
  NodeAssert.deepEqual(staticJob.running, { median: 180_000, p90: 240_000 });
  NodeAssert.equal(staticJob.samples, 3);

  const serverJob = summary.jobs.find((job) => job.name === "test-server");
  NodeAssert.deepEqual(serverJob.waiting, { median: 30_000, p90: 50_000 });
  NodeAssert.deepEqual(serverJob.running, { median: 120_000, p90: 240_000 });
  NodeAssert.equal(serverJob.samples, 2);
});

NodeTest.test("run wall clock uses creation to completion", () => {
  const summary = summarizeRuns(fixture);
  NodeAssert.deepEqual(summary.wallClock, { median: 1_200_000, p90: 1_800_000 });
});

NodeTest.test("jobs are ordered by median run time", () => {
  const summary = summarizeRuns(fixture);
  NodeAssert.deepEqual(
    summary.jobs.map((job) => job.name),
    ["static", "test-server"],
  );
});

NodeTest.test("markdown renders one row per job and the wall clock", () => {
  const markdown = renderMarkdown(summarizeRuns(fixture), { branch: "v2", requested: 30 });
  NodeAssert.match(markdown, /^\| static \| 3 \| 20\.0 \| 30\.0 \| 180\.0 \| 240\.0 \|$/m);
  NodeAssert.match(markdown, /^\| test-server \| 2 \| 30\.0 \| 50\.0 \| 120\.0 \| 240\.0 \|$/m);
  NodeAssert.match(markdown, /^\| all jobs \| 1200\.0 \| 1800\.0 \|$/m);
});

NodeTest.test("job queue time falls back to the run creation time", () => {
  const summary = summarizeRuns([
    {
      createdAt: at(0),
      updatedAt: at(60),
      jobs: [{ name: "only", startedAt: at(10), completedAt: at(20) }],
    },
  ]);
  NodeAssert.deepEqual(summary.jobs[0].waiting, { median: 10_000, p90: 10_000 });
  NodeAssert.deepEqual(summary.jobs[0].running, { median: 10_000, p90: 10_000 });
});
