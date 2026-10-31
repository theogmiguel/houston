import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { CommandId, MessageId, type ProjectId, ThreadId } from "@t3tools/contracts";
import type { HoustonTaskStatus } from "@t3tools/contracts/houston/tasks";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Logger from "effect/Logger";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";
import { TestClock } from "effect/testing";

import * as Orchestrator from "../../orchestration-v2/Orchestrator.ts";
import { HoustonHarnessFixTasks } from "./FixTasks.ts";
import {
  HoustonHarnessService,
  HoustonHarnessStore,
  HoustonTaskService,
  NOW,
  awaitReview,
  createProject,
  deleteProject,
  makeKit,
  model,
  runKit,
  seedPublished,
  until,
} from "./harnessReview.testkit.ts";
import { reviewMessageId } from "./Runner.ts";

const service = HoustonHarnessService.HoustonHarnessService;
const store = HoustonHarnessStore.HoustonHarnessStore;
const tasksService = HoustonTaskService.HoustonTaskService;

const kindOf = (error: unknown) => (error as { readonly kind?: string }).kind;
const messageOf = (error: unknown) => (error as { readonly message?: string }).message ?? "";

const day = (date: number) => `2026-10-${String(date).padStart(2, "0")}T00:00:00.000Z`;

const findingOf = (projectId: ProjectId, key: string) =>
  Effect.flatMap(service, (harness) => harness.get({ projectId })).pipe(
    Effect.map((snapshot) => snapshot.findings.find((finding) => finding.key === key)),
  );

describe("findings in the snapshot", () => {
  it.effect("one finding per key from the newest review", () =>
    Effect.gen(function* () {
      const kit = yield* makeKit("one-per-key");
      yield* runKit(
        kit,
        Effect.gen(function* () {
          const { projectId } = yield* createProject("one-per-key");
          yield* seedPublished({
            projectId,
            findings: [{ key: "denied-push", title: "Old title", quotes: ["old quote"] }],
            endedAt: day(1),
          });
          yield* seedPublished({ projectId, findings: [{ key: "other" }], endedAt: day(5) });
          yield* seedPublished({
            projectId,
            findings: [
              {
                key: "denied-push",
                title: "Denied git push",
                quotes: ["why was this denied"],
                recommendation: "Allow pushes to the fork",
                applyPrompt: "Add Bash(git push:*) to allow",
              },
            ],
            endedAt: day(10),
          });
          const snapshot = yield* (yield* service).get({ projectId });
          const matches = snapshot.findings.filter((finding) => finding.key === "denied-push");
          assert.lengthOf(matches, 1);
          assert.deepInclude(matches[0]!, {
            key: "denied-push",
            reviewId: 3,
            title: "Denied git push",
            recommendation: "Allow pushes to the fork",
            applyPrompt: "Add Bash(git push:*) to allow",
            state: "open",
            decidedAt: null,
            recurred: false,
            phase: "open",
            lastSeenReviewId: 3,
          });
          assert.deepEqual(matches[0]!.quotes, ["why was this denied"]);
          assert.deepEqual(matches[0]!.sessions, ["t-1"]);
          assert.equal(matches[0]!.target, ".claude/settings.json");
          assert.equal((yield* findingOf(projectId, "other"))!.phase, "notSeen");
          assert.deepEqual(
            snapshot.reviews.map((review) => review.id),
            [3, 2, 1],
          );
        }),
      );
    }),
  );

  it.effect("decisions outlive their review and a recurrence reopens them", () =>
    Effect.gen(function* () {
      const kit = yield* makeKit("decisions");
      yield* runKit(
        kit,
        Effect.gen(function* () {
          const harness = yield* service;
          const { projectId } = yield* createProject("decisions");
          yield* seedPublished({ projectId, findings: [{ key: "denied-push" }], endedAt: day(20) });
          yield* harness.decide({ projectId, key: "denied-push", state: "dismissed" });
          let finding = (yield* findingOf(projectId, "denied-push"))!;
          assert.equal(finding.state, "dismissed");
          assert.equal(finding.phase, "dismissed");
          assert.equal(finding.decidedAt, "2026-10-30T09:00:00.000Z");

          yield* seedPublished({ projectId, findings: [{ key: "other" }], endedAt: day(30) });
          finding = (yield* findingOf(projectId, "denied-push"))!;
          assert.equal(finding.state, "dismissed");
          assert.isFalse(finding.recurred);

          yield* seedPublished({
            projectId,
            findings: [{ key: "denied-push" }],
            endedAt: "2026-10-31T00:00:00.000Z",
          });
          finding = (yield* findingOf(projectId, "denied-push"))!;
          assert.equal(finding.state, "open");
          assert.isTrue(finding.recurred);
          assert.equal(finding.phase, "open");

          yield* TestClock.setTime(Date.parse("2026-11-01T00:00:00.000Z"));
          yield* harness.decide({ projectId, key: "denied-push", state: "dismissed" });
          finding = (yield* findingOf(projectId, "denied-push"))!;
          assert.equal(finding.state, "dismissed");
          assert.isFalse(finding.recurred);

          const unknown = yield* Effect.flip(
            harness.decide({ projectId, key: "never-raised", state: "resolved" }),
          );
          assert.equal(kindOf(unknown), "not_found");
          assert.include(messageOf(unknown), "never-raised");
        }),
      );
    }),
  );
});

describe("reports", () => {
  it.effect("the report is read bounded from the run directory", () =>
    Effect.gen(function* () {
      const kit = yield* makeKit("report");
      yield* runKit(
        kit,
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const harness = yield* service;
          const { projectId, root } = yield* createProject("report");
          const small = yield* seedPublished({ projectId, findings: [], endedAt: day(1) });
          const large = yield* seedPublished({ projectId, findings: [], endedAt: day(2) });
          const write = (reviewId: number, text: string) =>
            Effect.gen(function* () {
              const runDir = (yield* (yield* store).getReview(reviewId))!.runDir;
              const dir = path.join(root, ...runDir.split("/"));
              yield* fs.makeDirectory(dir, { recursive: true });
              yield* fs.writeFileString(path.join(dir, "report.md"), text);
              return path.join(dir, "report.md");
            });
          const smallFile = yield* write(small, "# Report\n\nAll good.\n");
          yield* write(large, "r".repeat(1.2 * 1024 * 1024));

          assert.deepEqual(yield* harness.report({ reviewId: small }), {
            markdown: "# Report\n\nAll good.\n",
            truncated: false,
          });
          const capped = yield* harness.report({ reviewId: large });
          assert.equal(capped.markdown.length, 1024 * 1024);
          assert.isTrue(capped.truncated);

          yield* fs.remove(smallFile);
          const gone = yield* Effect.flip(harness.report({ reviewId: small }));
          assert.equal(kindOf(gone), "not_found");
          assert.include(messageOf(gone), smallFile);
          const unknown = yield* Effect.flip(harness.report({ reviewId: 999 }));
          assert.equal(kindOf(unknown), "not_found");
          assert.include(messageOf(unknown), "999");
        }),
      );
    }),
  );
});

describe("the overview", () => {
  it.effect("the overview counts phases and attention since the seen cursor", () =>
    Effect.gen(function* () {
      const kit = yield* makeKit("overview");
      yield* runKit(
        kit,
        Effect.gen(function* () {
          const harness = yield* service;
          const p = yield* createProject("overview-p");
          const q = yield* createProject("overview-q");
          // Review 1 raises old-open and later-unseen; the cursor then moves past it.
          yield* seedPublished({
            projectId: p.projectId,
            findings: [{ key: "seen-before" }, { key: "dismiss-me" }, { key: "resolve-me" }],
            endedAt: day(1),
          });
          yield* harness.markSeen({ projectId: p.projectId, reviewId: 1 });
          // Review 2 raises sixty findings again, including seen-before.
          yield* seedPublished({
            projectId: p.projectId,
            findings: [
              { key: "seen-before" },
              { key: "dismiss-me" },
              { key: "resolve-me" },
              ...Array.from({ length: 60 }, (_, index) => ({
                key: `open-${String(index).padStart(2, "0")}`,
              })),
            ],
            endedAt: day(2),
          });
          yield* harness.decide({ projectId: p.projectId, key: "dismiss-me", state: "dismissed" });
          yield* harness.decide({ projectId: p.projectId, key: "resolve-me", state: "resolved" });
          // Q has a newer review, and one finding the latest review no longer raised.
          yield* seedPublished({
            projectId: q.projectId,
            findings: [{ key: "q-gone" }],
            endedAt: day(3),
          });
          yield* seedPublished({
            projectId: q.projectId,
            findings: [{ key: "q-new" }],
            endedAt: day(4),
          });

          const overview = yield* harness.overview({});
          const rowOf = (projectId: ProjectId) =>
            overview.rows.find((row) => row.projectId === projectId)!;
          assert.deepInclude(rowOf(p.projectId), {
            open: 61,
            fixing: 0,
            awaitingVerification: 0,
            notSeen: 0,
            resolved: 1,
            dismissed: 1,
            suspectedDefects: 0,
            latestPublishedReviewId: 2,
            seenReviewId: 1,
            attention: 61,
          });
          assert.deepInclude(rowOf(q.projectId), {
            open: 1,
            notSeen: 1,
            latestPublishedReviewId: 4,
            seenReviewId: 0,
            attention: 2,
          });

          yield* harness.markSeen({ projectId: p.projectId, reviewId: 2 });
          const seen = yield* harness.overview({});
          assert.equal(seen.rows.find((row) => row.projectId === p.projectId)!.attention, 0);

          assert.lengthOf(seen.suggested, 50);
          assert.equal(seen.suggested[0]!.projectId, q.projectId);
          assert.equal(seen.suggested[0]!.finding.key, "q-new");
          const fromP = seen.suggested.filter((suggestion) => suggestion.projectId === p.projectId);
          assert.isFalse(fromP.some((suggestion) => suggestion.finding.key === "dismiss-me"));
          assert.isFalse(fromP.some((suggestion) => suggestion.finding.key === "resolve-me"));
          assert.isTrue(seen.suggested.every((suggestion) => suggestion.finding.phase === "open"));
        }),
      );
    }),
  );

  it.effect("the seen cursor clamps, never moves backwards and survives a restart", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const base = yield* fs.makeTempDirectoryScoped({ prefix: "harness-seen-" });
      const databaseFile = path.join(base, "state.sqlite");
      const first = yield* makeKit("seen-first", { databaseFile });
      const projectId = yield* runKit(
        first,
        Effect.gen(function* () {
          const harness = yield* service;
          const { projectId } = yield* createProject("seen");
          for (let index = 1; index <= 5; index += 1) {
            yield* seedPublished({ projectId, findings: [], endedAt: day(index) });
          }
          assert.deepEqual(yield* harness.markSeen({ projectId, reviewId: 9 }), {
            seenReviewId: 5,
          });
          assert.deepEqual(yield* harness.markSeen({ projectId, reviewId: 3 }), {
            seenReviewId: 5,
          });
          return projectId;
        }),
      );
      const second = yield* makeKit("seen-second", { databaseFile });
      yield* runKit(
        second,
        Effect.gen(function* () {
          const snapshot = yield* (yield* service).get({ projectId });
          assert.equal(snapshot.seenReviewId, 5);
        }),
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});

describe("project deletion", () => {
  it.effect("project deletion removes its review rows only", () =>
    Effect.gen(function* () {
      const kit = yield* makeKit("deletion");
      yield* runKit(
        kit,
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const sql = yield* SqlClient.SqlClient;
          const harness = yield* service;
          const reviews = yield* store;
          const p = yield* createProject("delete-p");
          const q = yield* createProject("delete-q");
          for (const project of [p, q]) {
            const reviewId = yield* seedPublished({
              projectId: project.projectId,
              findings: [{ key: "denied-push" }],
              endedAt: day(1),
            });
            yield* harness.decide({
              projectId: project.projectId,
              key: "denied-push",
              state: "dismissed",
            });
            yield* reviews.setSeen(project.projectId, reviewId);
            yield* sql`INSERT INTO houston_harness_finding_tasks (project_id, key, task_id, review_id, created_at)
              VALUES (${project.projectId}, 'denied-push', ${reviewId}, ${reviewId}, ${day(2)})`;
            yield* sql`INSERT INTO houston_harness_verifications (review_id, key, task_id, verdict, sessions_after, evidence_json)
              VALUES (${reviewId}, 'denied-push', ${reviewId}, 'gone', 3, '[]')`;
            yield* sql`INSERT INTO houston_defects (project_id, key, source, title, evidence_json, destination, first_seen_at, last_seen_at, count)
              VALUES (${project.projectId}, 'defect-agent-00000000', 'agent', 'Broken', '[]', 'houston', ${day(2)}, ${day(2)}, 1)`;
            yield* fs.makeDirectory(
              path.join(project.root, ".houston", "harness", `review-${reviewId}`),
              {
                recursive: true,
              },
            );
          }
          const count = (table: string, projectId: ProjectId) =>
            table === "houston_harness_findings" || table === "houston_harness_verifications"
              ? sql<{ n: number }>`SELECT COUNT(*) AS n FROM ${sql(table)}
                  WHERE review_id IN (SELECT id FROM houston_harness_reviews WHERE project_id = ${projectId})`
              : sql<{
                  n: number;
                }>`SELECT COUNT(*) AS n FROM ${sql(table)} WHERE project_id = ${projectId}`;
          const tables = [
            "houston_harness_settings",
            "houston_harness_reviews",
            "houston_harness_findings",
            "houston_harness_decisions",
            "houston_harness_finding_tasks",
            "houston_harness_verifications",
            "houston_defects",
          ];
          const countsOf = (projectId: ProjectId) =>
            Effect.forEach(tables, (table) =>
              count(table, projectId).pipe(Effect.map((rows) => rows[0]!.n)),
            );
          const qBefore = yield* countsOf(q.projectId);
          assert.deepEqual(yield* countsOf(p.projectId), [1, 1, 1, 1, 1, 1, 1]);

          yield* deleteProject(p.projectId);
          assert.deepEqual(
            yield* sql<{
              n: number;
            }>`SELECT COUNT(*) AS n FROM houston_harness_reviews WHERE project_id = ${p.projectId}`,
            [{ n: 0 }],
          );
          const orphaned = yield* sql<{
            n: number;
          }>`SELECT COUNT(*) AS n FROM houston_harness_findings
            WHERE review_id NOT IN (SELECT id FROM houston_harness_reviews)`;
          assert.equal(orphaned[0]!.n, 0);
          const orphanedVerifications = yield* sql<{
            n: number;
          }>`SELECT COUNT(*) AS n FROM houston_harness_verifications
            WHERE review_id NOT IN (SELECT id FROM houston_harness_reviews)`;
          assert.equal(orphanedVerifications[0]!.n, 0);
          for (const table of [
            "houston_harness_settings",
            "houston_harness_decisions",
            "houston_harness_finding_tasks",
            "houston_defects",
          ]) {
            const rows = yield* count(table, p.projectId);
            assert.equal(rows[0]!.n, 0, table);
          }
          assert.deepEqual(yield* countsOf(q.projectId), qBefore);
          assert.isTrue(yield* fs.exists(path.join(p.root, ".houston", "harness")));
        }),
      );
    }),
  );
});

const MINUTE_MS = 60_000;
/** NOW plus `minutes`, as the ISO text the stores write. */
const at = (minutes: number) =>
  DateTime.formatIso(DateTime.makeUnsafe(Date.parse(NOW) + minutes * MINUTE_MS));
const setClock = (minutes: number) => TestClock.setTime(Date.parse(NOW) + minutes * MINUTE_MS);

const countRows = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const [tasks] = yield* sql<{ n: number }>`SELECT COUNT(*) AS n FROM houston_tasks`;
  const [links] = yield* sql<{
    n: number;
  }>`SELECT COUNT(*) AS n FROM houston_harness_finding_tasks`;
  return { tasks: tasks!.n, links: links!.n };
});

/** Moves a task through the Tasks service, as the user does in Tasks. */
const setStatus = (key: string, status: HoustonTaskStatus) =>
  Effect.gen(function* () {
    const tasks = yield* tasksService;
    const detail = yield* tasks.get({ id: key });
    return yield* tasks.save({
      id: key,
      expectedRevision: detail.task.revision,
      patch: { status },
    });
  });

const createThreadAt = (input: {
  readonly projectId: ProjectId;
  readonly root: string;
  readonly id: string;
  readonly minutes: number;
}) =>
  Effect.gen(function* () {
    yield* setClock(input.minutes);
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const threadId = ThreadId.make(input.id);
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`create:${input.id}`),
      threadId,
      projectId: input.projectId,
      title: input.id,
      modelSelection: model("claudeAgent"),
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: input.root,
      createdBy: "user",
      creationSource: "web",
    });
    return threadId;
  });

const answerWith = (verifications: ReadonlyArray<Record<string, unknown>>) =>
  [
    "# Harness review",
    "",
    "Verifying the fix tasks.",
    "",
    "```json",
    JSON.stringify({ schema: 1, findings: [], verifications }),
    "```",
  ].join("\n");

describe("fix tasks", () => {
  it.effect("create task makes one linked task without quotes", () =>
    Effect.gen(function* () {
      const kit = yield* makeKit("create-task");
      yield* runKit(
        kit,
        Effect.gen(function* () {
          const harness = yield* service;
          const tasks = yield* tasksService;
          const sql = yield* SqlClient.SqlClient;
          const { projectId } = yield* createProject("create-task");
          yield* seedPublished({ projectId, findings: [], endedAt: day(1) });
          yield* seedPublished({ projectId, findings: [], endedAt: day(2) });
          yield* seedPublished({
            projectId,
            findings: [
              {
                key: "other",
                title: "Other thing",
                quotes: ["QUOTE-other"],
                recommendation: "Say it",
                applyPrompt: "Add the rule",
              },
            ],
            endedAt: day(3),
          });
          yield* seedPublished({
            projectId,
            findings: [
              {
                key: "denied-push",
                title: "Denied git push",
                quotes: ["QUOTE-why-was-this-denied"],
                recommendation: "Allow pushes to the fork",
                applyPrompt: "The finding's own prompt",
              },
            ],
            endedAt: day(4),
          });

          const { task } = yield* harness.createTask({
            projectId,
            key: "denied-push",
            applyPrompt: "Add Bash(git push:*) to allow",
          });
          assert.deepInclude(task, {
            key: "HOU-1",
            projectId,
            title: "Harness: Denied git push",
            status: "todo",
            createdBy: "houston:harness",
          });
          const detail = yield* tasks.get({ id: task.key });
          assert.equal(
            detail.task.description,
            [
              "Finding: denied-push",
              "Review: #4",
              "Recommendation: Allow pushes to the fork",
              "Target: .claude/settings.json",
              "Apply prompt: Add Bash(git push:*) to allow",
            ].join("\n"),
          );
          assert.notInclude(detail.task.description, "QUOTE-why-was-this-denied");
          assert.notInclude(detail.task.description, "The finding's own prompt");
          assert.deepEqual(
            detail.acceptance.map((item) => item.text),
            [".claude/settings.json contains the recommended change for finding denied-push."],
          );
          assert.lengthOf(detail.runs, 0);
          assert.isTrue(detail.history.every((entry) => entry.actor === "houston:harness"));
          assert.deepEqual(
            yield* sql<{
              project_id: string;
              key: string;
              task_id: number;
              review_id: number;
            }>`SELECT project_id, key, task_id, review_id FROM houston_harness_finding_tasks`,
            [{ project_id: projectId, key: "denied-push", task_id: task.id, review_id: 4 }],
          );
          const finding = (yield* findingOf(projectId, "denied-push"))!;
          assert.equal(finding.phase, "fixing");
          assert.deepEqual(finding.task, {
            taskId: task.id,
            key: "HOU-1",
            status: "todo",
            landedAt: null,
          });

          // Without an apply prompt, the finding's own is used.
          const other = yield* harness.createTask({ projectId, key: "other" });
          assert.equal(
            (yield* tasks.get({ id: other.task.key })).task.description,
            [
              "Finding: other",
              "Review: #3",
              "Recommendation: Say it",
              "Target: .claude/settings.json",
              "Apply prompt: Add the rule",
            ].join("\n"),
          );
          assert.deepEqual(yield* countRows, { tasks: 2, links: 2 });
        }),
      );
    }),
  );

  it.effect("create task refuses by name and allows a fix after still present", () =>
    Effect.gen(function* () {
      const kit = yield* makeKit("create-task-refusals");
      yield* runKit(
        kit,
        Effect.gen(function* () {
          const harness = yield* service;
          const tasks = yield* tasksService;
          const sql = yield* SqlClient.SqlClient;
          const { projectId } = yield* createProject("refusals");
          yield* seedPublished({
            projectId,
            findings: [
              { key: "denied-push", title: "Denied git push" },
              { key: "fresh", title: "Fresh" },
              { key: "long-title", title: "x".repeat(200) },
            ],
            endedAt: day(1),
          });
          for (let index = 1; index <= 6; index += 1) {
            yield* tasks.save({ projectId, patch: { title: `Filler ${index}` } });
          }
          const first = yield* harness.createTask({ projectId, key: "denied-push" });
          assert.equal(first.task.key, "HOU-7");
          const before = yield* countRows;
          assert.deepEqual(before, { tasks: 7, links: 1 });

          const refused = (input: { readonly key: string; readonly applyPrompt?: string }) =>
            Effect.flip(harness.createTask({ projectId, ...input }));
          const cases: ReadonlyArray<
            readonly [
              string,
              { readonly key: string; readonly applyPrompt?: string },
              string,
              ReadonlyArray<string | RegExp>,
            ]
          > = [
            ["key shape", { key: "Bad Key" }, "invalid", ["Bad Key"]],
            ["unpublished key", { key: "never-raised" }, "invalid", ["never-raised"]],
            ["open linked task", { key: "denied-push" }, "busy", ["HOU-7"]],
            ["title over the Tasks limit", { key: "long-title" }, "invalid", ["209", "200"]],
            [
              "description over the Tasks limit",
              { key: "fresh", applyPrompt: "é".repeat(40_000) },
              "invalid",
              ["65,536", /8\d,\d{3} bytes/],
            ],
          ];
          for (const [name, input, kind, texts] of cases) {
            const error = yield* refused(input);
            assert.equal(kindOf(error), kind, name);
            for (const text of texts) {
              if (typeof text === "string") assert.include(messageOf(error), text, name);
              else assert.match(messageOf(error), text, name);
            }
            assert.deepEqual(yield* countRows, before, name);
          }

          const settings = yield* tasks.getSettings({ projectId });
          for (const [access, kind] of [
            ["off", "access_off"],
            ["read", "read_only"],
          ] as const) {
            yield* tasks.setSettings({ projectId, settings: { ...settings, access } });
            const error = yield* refused({ key: "fresh" });
            assert.equal(kindOf(error), kind, access);
            assert.include(messageOf(error), "Settings ▸ Tasks", access);
            assert.deepEqual(yield* countRows, before, access);
          }
          yield* tasks.setSettings({ projectId, settings: { ...settings, access: "write" } });

          // The strong case: HOU-7 landed and was found still present, so a new fix is allowed.
          yield* setStatus("HOU-7", "done");
          yield* seedPublished({
            projectId,
            findings: [],
            endedAt: day(2),
            verifications: [
              {
                key: "denied-push",
                taskId: first.task.id,
                verdict: "still_present",
                sessionsAfter: 3,
                evidence: ["still denied"],
              },
            ],
          });
          assert.equal((yield* findingOf(projectId, "denied-push"))!.phase, "open");
          const again = yield* harness.createTask({ projectId, key: "denied-push" });
          assert.equal(again.task.key, "HOU-8");
          assert.include(
            (yield* tasks.get({ id: "HOU-8" })).task.description,
            "Review: #1\nPrevious fix task: HOU-7\nRecommendation: ",
          );
          assert.deepEqual(yield* countRows, { tasks: 8, links: 2 });
          // HOU-8 is newer than the still present verdict, so the finding is being fixed again.
          const fixing = (yield* findingOf(projectId, "denied-push"))!;
          assert.equal(fixing.phase, "fixing");
          assert.equal(fixing.task?.key, "HOU-8");

          // A full backlog: 5,000 tasks.
          yield* sql`
            WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 4992)
            INSERT INTO houston_tasks (number, title, status, created_by, created_at, updated_at)
            SELECT 1000 + i, 'filler', 'backlog', 'user', '2026-01-01T00:00:00.000Z',
              '2026-01-01T00:00:00.000Z' FROM n
          `;
          yield* sql`UPDATE houston_task_counter SET next_number = 7000 WHERE id = 1`;
          const full = yield* countRows;
          assert.equal(full.tasks, 5_000);
          const limit = yield* refused({ key: "fresh" });
          assert.equal(kindOf(limit), "limit");
          assert.include(messageOf(limit), "5,000");
          assert.equal((limit as { readonly limit?: number }).limit, 5_000);
          assert.equal((limit as { readonly actual?: number }).actual, 5_000);
          assert.deepEqual(yield* countRows, full);
        }),
      );
    }),
  );

  it.effect("a linked task moves the finding to fixing and awaiting verification", () =>
    Effect.gen(function* () {
      const kit = yield* makeKit("fix-phases");
      yield* runKit(
        kit,
        Effect.gen(function* () {
          const harness = yield* service;
          const sql = yield* SqlClient.SqlClient;
          const fixTasks = yield* HoustonHarnessFixTasks;
          const project = yield* createProject("fix-phases");
          const { projectId } = project;
          yield* seedPublished({ projectId, findings: [{ key: "denied-push" }], endedAt: day(1) });
          const { task } = yield* harness.createTask({ projectId, key: "denied-push" });
          let finding = (yield* findingOf(projectId, "denied-push"))!;
          assert.equal(finding.phase, "fixing");
          assert.equal(finding.task?.status, "todo");

          yield* setStatus("HOU-1", "in_progress");
          finding = (yield* findingOf(projectId, "denied-push"))!;
          assert.equal(finding.phase, "fixing");
          assert.equal(finding.task?.status, "in_progress");

          yield* setClock(5);
          yield* setStatus("HOU-1", "done");
          finding = (yield* findingOf(projectId, "denied-push"))!;
          assert.equal(finding.phase, "awaitingVerification");
          assert.deepEqual(finding.task, {
            taskId: task.id,
            key: "HOU-1",
            status: "done",
            landedAt: at(5),
          });

          // A merged pull request lands the task at its merge, the newest one when there are two.
          for (const minutes of [-120, -60]) {
            yield* sql`INSERT INTO houston_task_history (task_id, actor, action, changes, created_at)
              VALUES (${task.id}, 'houston:pr', 'houston:pr-merged', '{}', ${at(minutes)})`;
          }
          finding = (yield* findingOf(projectId, "denied-push"))!;
          assert.equal(finding.phase, "awaitingVerification");
          assert.equal(finding.task?.landedAt, at(-60));

          // Moved back out of done, the task has not landed: no landing time, no sessions after.
          yield* createThreadAt({ ...project, id: "thread:after-landing", minutes: 6 });
          yield* setStatus("HOU-1", "in_progress");
          finding = (yield* findingOf(projectId, "denied-push"))!;
          assert.equal(finding.phase, "fixing");
          assert.deepEqual(finding.task, {
            taskId: task.id,
            key: "HOU-1",
            status: "in_progress",
            landedAt: null,
          });
          const link = (yield* fixTasks.links(projectId)).find(
            (candidate) => candidate.key === "denied-push",
          )!;
          assert.equal(link.landedAt, null);
          assert.equal(link.sessionsAfter, 0);
        }),
      );
    }),
  );

  it.effect("sessions after landing exclude the task's own threads and reviews", () =>
    Effect.gen(function* () {
      const kit = yield* makeKit("sessions-after");
      yield* runKit(
        kit,
        Effect.gen(function* () {
          const harness = yield* service;
          const sql = yield* SqlClient.SqlClient;
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const fixTasks = yield* HoustonHarnessFixTasks;
          const p = yield* createProject("sessions-p");
          const q = yield* createProject("sessions-q");
          yield* seedPublished({
            projectId: p.projectId,
            findings: [{ key: "denied-push" }],
            endedAt: day(1),
          });
          const { task } = yield* harness.createTask({
            projectId: p.projectId,
            key: "denied-push",
          });
          yield* createThreadAt({ ...p, id: "thread:before-landing", minutes: 1 });
          yield* setClock(2);
          yield* setStatus("HOU-1", "done");

          const ownRun = yield* createThreadAt({ ...p, id: "thread:own-run", minutes: 3 });
          yield* sql`INSERT INTO houston_task_runs
            (task_id, attempt, kind, state, provider, thread_id, initial_revision, started_at)
            VALUES (${task.id}, 1, 'implementation', 'ended', 'claudeAgent', ${ownRun}, 1, ${at(3)})`;
          yield* orchestrator.dispatch({
            type: "houston.harness-review.start",
            commandId: CommandId.make("harness-review:99"),
            threadId: ThreadId.make("harness-review:99"),
            projectId: p.projectId,
            reviewId: 99,
            modelSelection: model("claudeAgent"),
            messageId: MessageId.make("message:harness-review:99"),
            text: "Review this project",
          });
          yield* createThreadAt({ ...q, id: "thread:other-project", minutes: 3 });
          yield* createThreadAt({ ...p, id: "thread:after-1", minutes: 3 });
          yield* createThreadAt({ ...p, id: "thread:after-2", minutes: 4 });
          yield* createThreadAt({ ...p, id: "thread:after-3", minutes: 5 });

          const linkOf = (links: ReadonlyArray<{ readonly key: string }>) =>
            links.find((link) => link.key === "denied-push") as
              | { readonly landedAt: string | null; readonly sessionsAfter: number }
              | undefined;
          const link = linkOf(yield* fixTasks.links(p.projectId))!;
          assert.equal(link.landedAt, at(2));
          assert.equal(link.sessionsAfter, 3);
          // Counted up to a review's start, so the inputs and the parser agree.
          assert.equal(linkOf(yield* fixTasks.links(p.projectId, at(4)))!.sessionsAfter, 2);
          assert.lengthOf(yield* fixTasks.links(q.projectId), 0);
        }),
      );
    }),
  );

  it.effect("verdicts resolve or reopen and comment on the task", () => {
    const logs: Array<string> = [];
    const logger = Logger.make((options) => {
      logs.push(`${String(options.message)} ${Cause.pretty(options.cause)}`);
    });
    return Effect.gen(function* () {
      const kit = yield* makeKit("verdicts");
      yield* runKit(
        kit,
        Effect.gen(function* () {
          const harness = yield* service;
          const tasks = yield* tasksService;
          const reviews = yield* store;
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const project = yield* createProject("verdicts");
          const { projectId } = project;
          for (let index = 1; index <= 4; index += 1) {
            yield* seedPublished({ projectId, findings: [], endedAt: day(index) });
          }
          const keys = ["denied-push", "slow-tests", "flaky-ci", "lint-noise"] as const;
          yield* seedPublished({
            projectId,
            findings: keys.map((key) => ({ key, quotes: [`raised ${key}`] })),
            endedAt: day(5),
          });
          for (const key of keys) yield* harness.createTask({ projectId, key });
          // HOU-4 holds the Tasks limit of 500 comments, so its verdict comment is refused.
          for (let index = 1; index <= 500; index += 1) {
            yield* tasks.comment({ id: "HOU-4", body: `note ${index}` });
          }
          yield* setClock(2);
          for (const number of [1, 2, 3, 4]) yield* setStatus(`HOU-${number}`, "done");
          for (const minutes of [3, 4, 5]) {
            yield* createThreadAt({ ...project, id: `thread:after-${minutes}`, minutes });
          }
          yield* harness.setup({
            projectId,
            modelSelection: model("claudeAgent"),
            schedule: "manual",
          });
          kit.harness.script.replies.set(
            reviewMessageId(6),
            answerWith([
              { key: "denied-push", task: "HOU-1", verdict: "gone", sessions_after: 3 },
              {
                key: "slow-tests",
                task: "HOU-2",
                verdict: "still_present",
                sessions_after: 3,
                quotes: ["still slow"],
              },
              { key: "flaky-ci", task: "HOU-3", verdict: "inconclusive", sessions_after: 3 },
              { key: "lint-noise", task: "HOU-4", verdict: "gone", sessions_after: 3 },
            ]),
          );
          yield* setClock(6);
          const started = yield* harness.runNow({ projectId });
          assert.equal(started.reviewId, 6);

          // The run's inputs list each linked task with its landing and the sessions since.
          const review = (yield* reviews.getReview(6))!;
          const decisions = JSON.parse(
            yield* fs.readFileString(
              path.join(project.root, ...review.runDir.split("/"), "decisions.json"),
            ),
          ) as { findings: Array<{ key: string; tasks: unknown }> };
          assert.deepEqual(
            decisions.findings.find((finding) => finding.key === "denied-push")!.tasks,
            [{ key: "HOU-1", status: "done", landed_at: at(2), sessions_after: 3 }],
          );

          yield* awaitReview(6, (stored) => stored.status !== "running");
          const published = (yield* reviews.getReview(6))!;
          assert.equal(published.status, "published", published.error ?? "");
          yield* until(
            "the gone verdict is commented",
            tasks.get({ id: "HOU-1" }).pipe(Effect.map((detail) => detail.comments.length > 0)),
          );
          yield* until(
            "the still present verdict is commented",
            tasks.get({ id: "HOU-2" }).pipe(Effect.map((detail) => detail.comments.length > 0)),
          );

          const commentsOf = (key: string) =>
            tasks
              .get({ id: key })
              .pipe(
                Effect.map((detail) =>
                  detail.comments.map((comment) => ({
                    body: comment.body,
                    author: comment.author,
                  })),
                ),
              );
          assert.deepEqual(yield* commentsOf("HOU-1"), [
            {
              body: "Harness review 6 verified finding denied-push as gone.",
              author: "houston:harness",
            },
          ]);
          assert.deepEqual(yield* commentsOf("HOU-2"), [
            {
              body: "Harness review 6 found finding slow-tests still present; evidence is available in Review.",
              author: "houston:harness",
            },
          ]);
          assert.deepEqual(yield* commentsOf("HOU-3"), []);
          const lint = yield* commentsOf("HOU-4");
          assert.lengthOf(lint, 500);
          assert.isFalse(lint.some((comment) => comment.author === "houston:harness"));

          const gone = (yield* findingOf(projectId, "denied-push"))!;
          assert.equal(gone.phase, "resolved");
          assert.equal(gone.state, "resolved");
          assert.equal(gone.verification?.verdict, "gone");
          const still = (yield* findingOf(projectId, "slow-tests"))!;
          assert.equal(still.phase, "open");
          assert.deepEqual(still.quotes, ["still slow"]);
          assert.deepInclude(still.verification!, {
            reviewId: 6,
            verdict: "stillPresent",
            sessionsAfter: 3,
          });
          const unsure = (yield* findingOf(projectId, "flaky-ci"))!;
          assert.equal(unsure.phase, "awaitingVerification");
          assert.equal(unsure.verification?.verdict, "inconclusive");
          assert.equal((yield* findingOf(projectId, "lint-noise"))!.phase, "resolved");
          assert.include(logs.join("\n"), "HOU-4");
        }),
      );
    }).pipe(Effect.provide(Logger.layer([logger])));
  });

  it.effect("a later omission supersedes an older still present verdict", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const base = yield* fs.makeTempDirectoryScoped({ prefix: "harness-verdicts-" });
      const databaseFile = path.join(base, "state.sqlite");
      const first = yield* makeKit("omission-first", { databaseFile });
      const { projectId, before } = yield* runKit(
        first,
        Effect.gen(function* () {
          const harness = yield* service;
          const { projectId } = yield* createProject("omission");
          yield* seedPublished({ projectId, findings: [{ key: "denied-push" }], endedAt: day(1) });
          const { task } = yield* harness.createTask({ projectId, key: "denied-push" });
          yield* setStatus("HOU-1", "done");
          const verdictReview = yield* seedPublished({
            projectId,
            findings: [{ key: "other" }],
            endedAt: day(2),
            verifications: [
              {
                key: "denied-push",
                taskId: task.id,
                verdict: "still_present",
                sessionsAfter: 3,
                evidence: ["still denied"],
              },
            ],
          });
          assert.equal(verdictReview, 2);
          assert.equal((yield* findingOf(projectId, "denied-push"))!.phase, "open");
          yield* seedPublished({ projectId, findings: [{ key: "another" }], endedAt: day(3) });
          const finding = (yield* findingOf(projectId, "denied-push"))!;
          assert.equal(finding.phase, "notSeen");
          assert.deepEqual(finding.task, {
            taskId: task.id,
            key: "HOU-1",
            status: "done",
            landedAt: NOW,
          });
          assert.deepEqual(finding.verification, {
            reviewId: 2,
            taskId: task.id,
            verdict: "stillPresent",
            sessionsAfter: 3,
            evidence: ["still denied"],
          });
          return { projectId, before: finding };
        }),
      );
      const second = yield* makeKit("omission-second", { databaseFile });
      yield* runKit(
        second,
        Effect.gen(function* () {
          assert.deepEqual(yield* findingOf(projectId, "denied-push"), before);
        }),
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("verify now runs a review and suggested work drops decided findings", () =>
    Effect.gen(function* () {
      const kit = yield* makeKit("verify-now");
      yield* runKit(
        kit,
        Effect.gen(function* () {
          const harness = yield* service;
          const reviews = yield* store;
          const { projectId } = yield* createProject("verify-now");
          yield* seedPublished({
            projectId,
            findings: [{ key: "awaiting-fix" }, { key: "fix-me" }, { key: "dismiss-me" }],
            endedAt: day(1),
          });
          yield* harness.createTask({ projectId, key: "awaiting-fix" });
          yield* setStatus("HOU-1", "done");
          assert.equal(
            (yield* findingOf(projectId, "awaiting-fix"))!.phase,
            "awaitingVerification",
          );

          const suggestedKeys = harness
            .overview({})
            .pipe(
              Effect.map((overview) =>
                overview.suggested.map((suggestion) => suggestion.finding.key).toSorted(),
              ),
            );
          assert.deepEqual(yield* suggestedKeys, ["dismiss-me", "fix-me"]);
          const row = (yield* harness.overview({})).rows.find((r) => r.projectId === projectId)!;
          assert.equal(row.awaitingVerification, 1);
          assert.equal(row.open, 2);

          // Verify now is Run review now: one review of the project through its scheduled task.
          yield* harness.setup({
            projectId,
            modelSelection: model("claudeAgent"),
            schedule: "manual",
          });
          kit.harness.script.hold.add(reviewMessageId(2));
          const started = yield* harness.runNow({ projectId });
          assert.equal(started.reviewId, 2);
          const review = (yield* reviews.getReview(2))!;
          assert.equal(review.trigger, "manual");
          assert.equal(review.threadId, started.threadId);
          assert.include(["preparing", "running"], review.status);

          yield* harness.createTask({ projectId, key: "fix-me" });
          assert.deepEqual(yield* suggestedKeys, ["dismiss-me"]);
          const fixing = (yield* harness.overview({})).rows.find((r) => r.projectId === projectId)!;
          assert.equal(fixing.fixing, 1);
          yield* harness.decide({ projectId, key: "dismiss-me", state: "dismissed" });
          assert.deepEqual(yield* suggestedKeys, []);
        }),
      );
    }),
  );
});

describe("door 5", () => {
  it.effect("harness review writes tasks only through the tasks service", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = import.meta.dirname;
      const files = (yield* fs.readDirectory(root, { recursive: true }))
        .map((file) => file.replaceAll("\\", "/"))
        .filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts"));
      assert.isAbove(files.length, 5);
      const writes =
        /\b(?:INSERT\s+(?:OR\s+\w+\s+)?INTO|REPLACE\s+INTO|UPDATE|DELETE\s+FROM)\s+["`]?houston_task/i;
      const texts = yield* Effect.forEach(files, (file) =>
        fs.readFileString(path.join(root, ...file.split("/"))),
      );
      const offenders = files.filter((_, index) => writes.test(texts[index]!));
      assert.deepEqual(offenders, []);
      const all = texts.join("\n");
      assert.match(all, /\.save\(/);
      assert.match(all, /\.comment\(/);
      assert.include(all, '"houston:harness"');
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
