// @effect-diagnostics nodeBuiltinImport:off - writes the run's report file.
// The morning report over the kit's store: what `houston.nightShift.report` gathers for a run.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, describe, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import {
  NOW,
  Service,
  Store,
  createProject,
  makeKit,
  makeRepository,
  runKit,
  seedNightShift,
} from "./nightShift.testkit.ts";

const ORCHESTRATOR = ThreadId.make("report-orchestrator");
const MIB = 1024 * 1024;

describe("night shift morning report", () => {
  it.effect("the morning report gathers the run", () =>
    Effect.gen(function* () {
      const kit = yield* makeKit("report");
      kit.state.backlogStatuses.set("HOU-7", "in_review");
      yield* runKit(
        kit,
        Effect.gen(function* () {
          const fixture = makeRepository("report", null);
          const projectId = yield* createProject("report", fixture.root);
          yield* seedNightShift(projectId);
          const store = yield* Store.HoustonNightShiftStore;
          const service = yield* Service.HoustonNightShiftService;
          const settings = (yield* store.settings(projectId))!.settings;
          const run = yield* store.openRun({
            projectId,
            trigger: "manual",
            scheduledTaskId: null,
            settings,
            startedAt: NOW,
            wrapUpAt: "2026-10-31T06:45:00.000Z",
            hardStopAt: "2026-10-31T07:30:00.000Z",
            operation: "test",
          });
          yield* store.markRunning(run.id, {
            threadId: ORCHESTRATOR,
            worktreePath: "/worktrees/night",
            branch: `houston/night/${run.id}`,
            remoteHeads: {},
          });
          yield* store.addCrew({
            runId: run.id,
            threadId: ThreadId.make("report-worker"),
            taskId: "task:1",
            parentThreadId: ORCHESTRATOR,
            role: "implementation",
            providerInstanceId: "claudeAgent",
            requestedInstanceId: "codex",
            worktreePath: null,
            branch: "t3/a",
            startedAt: NOW,
            endedAt: null,
          });
          const add = (
            entry: Omit<Parameters<typeof store.addEntry>[0], "runId" | "projectId" | "createdAt">,
          ) => store.addEntry({ runId: run.id, projectId, createdAt: NOW, ...entry });

          const p1 = yield* add({
            kind: "plan",
            title: "Retry uploads",
            status: "planned",
            detail: {
              claims: [
                { claim: "A dropped upload retries", proof: "upload.test.ts" },
                { claim: "Order is kept", proof: "upload.test.ts order" },
              ],
            },
          });
          const p2 = yield* add({
            kind: "plan",
            title: "Show retries",
            status: "planned",
            detail: {
              claims: [{ claim: "The badge shows", proof: "badge.test.ts" }],
              dependsOn: [p1.id],
            },
          });
          const gates = {
            checks: "passed",
            ci: "passed",
            verify: "pending",
            review: "notApplicable",
            qa: "notApplicable",
          };
          // #1 builds on #2's plan; the five others are performance work.
          yield* add({
            kind: "pr",
            title: "Show retries",
            theme: "reliability",
            prNumber: 1,
            status: "open",
            detail: { plans: [p2.id], builtBy: [], visible: true, gates },
          });
          yield* add({
            kind: "pr",
            title: "Retry uploads",
            theme: "reliability",
            prNumber: 2,
            status: "open",
            detail: {
              plans: [p1.id],
              builtBy: [],
              visible: false,
              gates: { ...gates, ci: "failed", verify: "failed" },
              ci: { failing: [{ name: "lint", url: "https://github.com/o/r/actions/runs/1" }] },
            },
          });
          for (const number of [3, 4, 5, 6, 7]) {
            yield* add({
              kind: "pr",
              title: `Faster ${number}`,
              theme: "performance",
              prNumber: number,
              status: "open",
              detail: { plans: [], builtBy: [], visible: false, gates },
            });
          }
          yield* add({
            kind: "verdict",
            title: `#2 plan ${p1.id} claim 0`,
            status: "passed",
            detail: {
              pullRequest: 2,
              plan: p1.id,
              claim: 0,
              passed: true,
              evidence: "src/upload.ts:12",
            },
          });
          yield* add({
            kind: "verdict",
            title: `#2 plan ${p1.id} claim 1`,
            status: "failed",
            detail: {
              pullRequest: 2,
              plan: p1.id,
              claim: 1,
              passed: false,
              evidence: "src/upload.ts:40",
            },
          });
          const decisions = [];
          for (const title of ["Drop v1?", "Rename the flag?", "Split the module?"]) {
            decisions.push(
              yield* add({
                kind: "decision",
                title,
                body: `${title} Which?`,
                detail: { options: ["yes", "no"], recommendation: "yes" },
              }),
            );
          }
          yield* store.decide(decisions[0]!.id, "no", "2026-10-31T08:00:00.000Z");
          yield* add({ kind: "pick", title: "HOU-7 Fix the login", taskNumber: 7 });
          yield* store.addInterruption(run.id, {
            at: "2026-10-31T01:00:00.000Z",
            detail: "the server restarted at 01:00",
          });
          yield* store.setLimited(run.id, [
            {
              instanceId: "codex",
              state: "outOfUsage",
              resetsAt: "2026-10-31T05:00:00.000Z",
              at: "2026-10-31T02:00:00.000Z",
              clearedAt: null,
            },
          ]);
          yield* store.setRemoteChanges(
            run.id,
            Store.toJson({
              changes: [{ ref: "refs/heads/main", oldSha: "1".repeat(40), newSha: "2".repeat(40) }],
            }),
          );
          const cost = {
            members: [{ threadId: ORCHESTRATOR, providerInstanceId: "claudeAgent", hours: 2 }],
            instances: { claudeAgent: 2 },
            tokens: { claudeAgent: "not tracked" as const },
          };
          yield* store.setCost(run.id, Store.toJson(cost));
          const folder = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "night-report-"));
          const reportPath = NodePath.join(folder, "report.md");
          NodeFS.writeFileSync(reportPath, `# Night\n${"x".repeat(MIB + 10)}`);
          yield* store.setReport(run.id, { reportPath, summary: "Seven changes, one failing." });

          const report = yield* service.report({ runId: run.id });
          assert.equal(report.headline, "7 pull requests, 2 open decisions");
          assert.equal(report.summary, "Seven changes, one failing.");
          assert.deepEqual(
            report.decisions.open.map((decision) => decision.title),
            ["Rename the flag?", "Split the module?"],
          );
          assert.equal(report.decisions.answered.length, 1);
          assert.equal(report.decisions.answered[0]!.choice, "no");
          assert.deepEqual(report.decisions.open[0]!.options, ["yes", "no"]);

          assert.deepEqual(
            report.pullRequests.map((group) => [
              group.theme,
              group.pullRequests.map((pr) => pr.number),
            ]),
            [
              ["reliability", [1, 2]],
              ["performance", [3, 4, 5, 6, 7]],
            ],
          );
          const second = report.pullRequests[0]!.pullRequests[1]!;
          assert.deepEqual(Object.keys(second.gates).toSorted(), [
            "checks",
            "ci",
            "qa",
            "review",
            "verify",
          ]);
          assert.equal(second.gates.ci, "failed");
          assert.deepEqual(second.failedChecks, [
            { name: "lint", url: "https://github.com/o/r/actions/runs/1" },
          ]);
          assert.deepEqual(
            second.claims.map((claim) => [claim.claim, claim.verdict, claim.evidence]),
            [
              ["A dropped upload retries", "passed", "src/upload.ts:12"],
              ["Order is kept", "failed", "src/upload.ts:40"],
            ],
          );
          // #1's plan depends on #2's, so #2 merges first; the rest keep entry order.
          assert.deepEqual(report.mergeOrder, [2, 1, 3, 4, 5, 6, 7]);
          assert.deepEqual(report.picks, [
            { taskNumber: 7, title: "HOU-7 Fix the login", status: "in_review" },
          ]);
          // Remote changes outside Houston come first among the events.
          assert.equal(report.events[0]!.kind, "remoteChange");
          assert.include(report.events[0]!.text, "refs/heads/main");
          const kinds = report.events.map((event) => event.kind);
          for (const kind of ["interruption", "limit", "substitution"]) assert.include(kinds, kind);
          assert.deepEqual(report.remoteChanges, [
            { ref: "refs/heads/main", oldSha: "1".repeat(40), newSha: "2".repeat(40) },
          ]);
          assert.deepEqual(report.cost, cost);
          assert.isTrue(report.truncated);
          assert.isAtMost(Buffer.byteLength(report.markdown, "utf8"), MIB);
          assert.isTrue(report.markdown.startsWith("# Night"));
        }),
      );
    }),
  );
});
