import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import type { ProjectId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";
import { TestClock } from "effect/testing";

import {
  HoustonHarnessService,
  HoustonHarnessStore,
  createProject,
  deleteProject,
  makeKit,
  runKit,
  seedPublished,
} from "./harnessReview.testkit.ts";

const service = HoustonHarnessService.HoustonHarnessService;
const store = HoustonHarnessStore.HoustonHarnessStore;

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
