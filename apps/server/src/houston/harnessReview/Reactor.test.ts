import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { CommandId, MessageId, ThreadId, type OrchestrationV2Run } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import * as Orchestrator from "../../orchestration-v2/Orchestrator.ts";
import {
  awaitReview,
  HarnessReviewReactor,
  HoustonHarnessService,
  HoustonHarnessStore,
  createProject,
  type Kit,
  makeKit,
  model,
  runKit,
  settle,
  until,
} from "./harnessReview.testkit.ts";
import { correctionMessageId, reviewMessageId } from "./Runner.ts";

const service = HoustonHarnessService.HoustonHarnessService;
const store = HoustonHarnessStore.HoustonHarnessStore;

const block = (findings: number, extra: Record<string, unknown> = {}) =>
  [
    "```json",
    JSON.stringify({
      schema: 1,
      run: { cost_usd: 1.25 },
      findings: Array.from({ length: findings }, (_, index) => ({
        key: `finding-${index}`,
        title: `Finding ${index}`,
        category: "tools",
        confidence: "high",
        evidence: { sessions: ["t-1"], count: 1, quotes: ["q"] },
        recommendation: {
          kind: "claude-md",
          target: "CLAUDE.md",
          summary: "Say it",
          apply_prompt: "Add a line",
        },
      })),
      verifications: [],
      ...extra,
    }),
    "```",
  ].join("\n");

const REPORT = "# Harness review\n\nTwo things slowed the agents down.\n";

// Completion signals the tests wait on, instead of a fixed number of yields.
const settled = (review: { readonly status: string }) => review.status !== "running";

const turnStarted = (kit: Kit, threadId: string) =>
  Effect.sync(() => kit.harness.log.started.some((turn) => turn.input.threadId === threadId));

const runCompleted = (threadId: string) =>
  Effect.flatMap(Orchestrator.OrchestratorV2, (orchestrator) =>
    orchestrator.getThreadProjection(ThreadId.make(threadId)),
  ).pipe(Effect.map((projection) => projection.runs.at(-1)?.status === "completed"));

/** A project with one user thread that ran in the window, set up for manual reviews. */
const projectWithThread = (name: string, root?: string) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const harness = yield* service;
    const project = yield* createProject(name, root);
    const threadId = ThreadId.make(`thread:${name}:work`);
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`create:${name}:work`),
      threadId,
      projectId: project.projectId,
      title: "Work",
      modelSelection: model("claudeAgent"),
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: project.root,
      createdBy: "user",
      creationSource: "web",
    });
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make(`send:${name}:work`),
      threadId,
      messageId: MessageId.make(`message:${name}:work`),
      text: "Fix the build",
      attachments: [],
      dispatchMode: { type: "start_immediately" },
      createdBy: "user",
      creationSource: "web",
    });
    yield* until(`${name}'s work run completes`, runCompleted(threadId));
    yield* harness.setup({
      projectId: project.projectId,
      modelSelection: model("claudeAgent"),
      schedule: "manual",
    });
    return project;
  });

const userMessagesOf = (threadId: string) =>
  Effect.flatMap(Orchestrator.OrchestratorV2, (orchestrator) =>
    orchestrator.getThreadProjection(ThreadId.make(threadId)),
  ).pipe(
    Effect.map((projection) => projection.messages.filter((message) => message.role === "user")),
  );

const userMessageCount = (threadId: string, count: number) =>
  userMessagesOf(threadId).pipe(Effect.map((messages) => messages.length === count));

describe("publishing a review", () => {
  it.effect("a completed run publishes its report and findings", () =>
    Effect.gen(function* () {
      const kit = yield* makeKit("publish");
      yield* runKit(
        kit,
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const harness = yield* service;
          const reviews = yield* store;
          const project = yield* projectWithThread("publish");

          kit.harness.script.replies.set(
            reviewMessageId(1),
            `${REPORT}\n${block(2, { summary: "Two findings on pushes" })}`,
          );
          const started = yield* harness.runNow({ projectId: project.projectId });
          assert.equal(started.reviewId, 1);
          yield* awaitReview(1, settled);
          const review = (yield* reviews.getReview(1))!;
          assert.equal(review.status, "published");
          assert.equal(review.summary, "Two findings on pushes");
          assert.equal(review.findingCount, 2);
          assert.equal(review.costUsd, 1.25);
          assert.equal(review.threads, 1);
          assert.equal(review.prompts, 1);
          // A first review reads the fortnight before its start.
          assert.equal(review.windowUntil, review.startedAt);
          assert.equal(
            Date.parse(review.windowUntil!) - Date.parse(review.windowSince!),
            14 * 86_400_000,
          );
          assert.equal(review.corrections, 0);
          const dir = path.join(project.root, ...review.runDir.split("/"));
          const report = yield* fs.readFileString(path.join(dir, "report.md"));
          assert.include(report, "Two things slowed the agents down.");
          assert.notInclude(report, '"schema"');
          const findings = JSON.parse(yield* fs.readFileString(path.join(dir, "findings.json")));
          assert.equal(findings.schema, 1);
          assert.lengthOf(findings.findings, 2);
          const snapshot = yield* harness.get({ projectId: project.projectId });
          assert.deepEqual(snapshot.findings.map((finding) => finding.key).toSorted(), [
            "finding-0",
            "finding-1",
          ]);

          kit.harness.script.replies.set(reviewMessageId(2), `${REPORT}\n${block(2)}`);
          yield* harness.runNow({ projectId: project.projectId });
          yield* awaitReview(2, settled);
          assert.equal((yield* reviews.getReview(2))!.summary, "2 findings");

          kit.harness.script.replies.set(
            reviewMessageId(3),
            `${REPORT}\n${block(1, { summary: "s".repeat(300) })}`,
          );
          yield* harness.runNow({ projectId: project.projectId });
          yield* awaitReview(3, settled);
          assert.equal((yield* reviews.getReview(3))!.summary, "s".repeat(200));
        }),
      );
    }),
  );

  it.effect("an unreadable answer gets at most two corrections", () =>
    Effect.gen(function* () {
      const kit = yield* makeKit("corrections");
      yield* runKit(
        kit,
        Effect.gen(function* () {
          const harness = yield* service;
          const reviews = yield* store;
          const reactor = yield* HarnessReviewReactor.HarnessReviewReactor;
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const project = yield* projectWithThread("corrections");

          // Review 1: three unreadable answers.
          kit.harness.script.replies.set(reviewMessageId(1), "# Report without a block");
          kit.harness.script.hold.add(correctionMessageId(1, 1));
          const first = yield* harness.runNow({ projectId: project.projectId });
          yield* until("the first correction is sent", userMessageCount(first.threadId, 2));
          let messages = yield* userMessagesOf(first.threadId);
          assert.lengthOf(messages, 2);
          assert.include(messages[1]!.text, "no fenced `json` block");
          assert.include(messages[1]!.text, '"schema": 1');
          assert.equal((yield* reviews.getReview(1))!.status, "running");

          // The corrected run seen again, by a repeated run.updated or a restart, is not corrected twice.
          const answered = (yield* orchestrator.getThreadProjection(
            ThreadId.make(first.threadId),
          )).runs.find((run) => run.status === "completed")!;
          yield* reactor.settleRun(answered);
          yield* reactor.recover;
          assert.lengthOf(yield* userMessagesOf(first.threadId), 2);
          assert.equal((yield* reviews.getReview(1))!.corrections, 1);

          kit.harness.script.replies.set(correctionMessageId(1, 1), "Still no block");
          kit.harness.script.replies.set(correctionMessageId(1, 2), "{ broken json");
          yield* kit.harness.release(correctionMessageId(1, 1));
          yield* awaitReview(1, settled);
          messages = yield* userMessagesOf(first.threadId);
          assert.lengthOf(messages, 3);
          const failed = (yield* reviews.getReview(1))!;
          assert.equal(failed.status, "failed");
          assert.equal(failed.corrections, 2);
          assert.include(failed.error ?? "", "no fenced `json` block");
          yield* settle;
          assert.lengthOf(yield* userMessagesOf(first.threadId), 3);

          // Review 2: a report over 1 MiB, then a corrected answer.
          kit.harness.script.replies.set(
            reviewMessageId(2),
            `${"x".repeat(1.5 * 1024 * 1024)}\n${block(1)}`,
          );
          kit.harness.script.replies.set(correctionMessageId(2, 1), `${REPORT}\n${block(1)}`);
          const second = yield* harness.runNow({ projectId: project.projectId });
          yield* awaitReview(2, settled);
          const corrections = yield* userMessagesOf(second.threadId);
          assert.include(corrections[1]!.text, "1 MiB");
          const published = (yield* reviews.getReview(2))!;
          assert.equal(published.status, "published");
          assert.equal(published.corrections, 1);
        }),
      );
    }),
  );

  it.effect("a run that ends without an answer fails and a restart settles open reviews", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const base = yield* fs.makeTempDirectoryScoped({ prefix: "harness-restart-" });
      const databaseFile = path.join(base, "state.sqlite");

      const kit = yield* makeKit("ended");
      yield* runKit(
        kit,
        Effect.gen(function* () {
          const harness = yield* service;
          const reviews = yield* store;
          const reactor = yield* HarnessReviewReactor.HarnessReviewReactor;
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const project = yield* projectWithThread("ended");

          // Stopped: the provider ends the turn interrupted.
          kit.harness.script.hold.add(reviewMessageId(1));
          const stopped = yield* harness.runNow({ projectId: project.projectId });
          yield* until("review 1's turn starts", turnStarted(kit, stopped.threadId));
          yield* orchestrator.dispatch({
            type: "thread.stop",
            commandId: CommandId.make("stop:review-1"),
            threadId: ThreadId.make(stopped.threadId),
          });
          yield* awaitReview(1, settled);
          const interrupted = (yield* reviews.getReview(1))!;
          assert.equal(interrupted.status, "failed");
          assert.include(interrupted.error ?? "", "the run ended without a readable answer: ");
          assert.include(interrupted.error ?? "", "interrupted");

          // Failed and cancelled runs, as the orchestrator reports them.
          for (const [index, status] of [
            [2, "failed"],
            [3, "cancelled"],
          ] as const) {
            kit.harness.script.hold.add(reviewMessageId(index));
            const started = yield* harness.runNow({ projectId: project.projectId });
            yield* until(`review ${index}'s turn starts`, turnStarted(kit, started.threadId));
            const projection = yield* orchestrator.getThreadProjection(
              ThreadId.make(started.threadId),
            );
            yield* reactor.settleRun({
              ...projection.runs[0]!,
              status,
            } as OrchestrationV2Run);
            const ended = (yield* reviews.getReview(index))!;
            assert.equal(ended.status, "failed", status);
            assert.equal(
              ended.error,
              `the run ended without a readable answer: the run ${status === "failed" ? "failed" : "was cancelled"}`,
            );
            yield* kit.harness.release(reviewMessageId(index));
            yield* until(`review ${index}'s run completes`, runCompleted(started.threadId));
            assert.equal((yield* reviews.getReview(index))!.status, "failed");
          }

          // A deleted review thread.
          kit.harness.script.hold.add(reviewMessageId(4));
          const deleted = yield* harness.runNow({ projectId: project.projectId });
          yield* until("review 4's turn starts", turnStarted(kit, deleted.threadId));
          yield* orchestrator.dispatch({
            type: "thread.delete",
            commandId: CommandId.make("delete:review-4"),
            threadId: ThreadId.make(deleted.threadId),
          });
          yield* awaitReview(4, settled);
          const gone = (yield* reviews.getReview(4))!;
          assert.equal(gone.status, "failed");
          assert.include(gone.error ?? "", "the run ended without a readable answer: ");
          assert.include(gone.error ?? "", "deleted");
          assert.isNull(gone.summary);
        }),
      );

      // Restart: a preparing review and a running review whose run completed meanwhile.
      const preparingRoot = yield* fs.makeTempDirectoryScoped({ prefix: "harness-preparing-" });
      const runningRoot = yield* fs.makeTempDirectoryScoped({ prefix: "harness-running-" });
      const before = yield* makeKit("restart-before", { databaseFile, reactor: false });
      const ids = yield* runKit(
        before,
        Effect.gen(function* () {
          const harness = yield* service;
          const reviews = yield* store;
          const preparing = yield* createProject("restart-preparing", preparingRoot);
          const preparingReview = yield* reviews.openReview({
            projectId: preparing.projectId,
            trigger: "manual",
            scheduledTaskId: null,
            providerInstanceId: "claudeAgent",
            startedAt: "2026-10-30T09:00:00.000Z",
          });
          const running = yield* projectWithThread("restart-running", runningRoot);
          before.harness.script.replies.set(
            reviewMessageId(preparingReview.id + 1),
            `${REPORT}\n${block(1)}`,
          );
          const started = yield* harness.runNow({ projectId: running.projectId });
          yield* until("the review's run completes", runCompleted(started.threadId));
          assert.equal((yield* reviews.getReview(started.reviewId))!.status, "running");
          return { preparing: preparingReview.id, running: started.reviewId };
        }),
      );
      const after = yield* makeKit("restart-after", { databaseFile });
      yield* runKit(
        after,
        Effect.gen(function* () {
          const reviews = yield* store;
          yield* awaitReview(ids.running, settled);
          const preparing = (yield* reviews.getReview(ids.preparing))!;
          assert.equal(preparing.status, "failed");
          assert.equal(preparing.error, "the server stopped while this review was being prepared");
          const running = (yield* reviews.getReview(ids.running))!;
          assert.equal(running.status, "published");
          assert.equal(running.findingCount, 1);
        }),
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
