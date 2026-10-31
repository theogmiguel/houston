// Reads a review run's answer when its run ends: publishes the report and findings, sends at most
// two corrections for an unreadable answer, or fails the review. On start it settles open reviews.
import { CommandId, type OrchestrationV2Run, ThreadId } from "@t3tools/contracts";
import { HOUSTON_HARNESS_LIMITS } from "@t3tools/contracts/houston/harnessReview";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";

import * as Orchestrator from "../../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../../orchestration-v2/ProjectStore.ts";
import { finalAssistantText } from "../sideThreads.ts";
import { runDirectory } from "./runDirectory.ts";
import { correctionMessageId } from "./Runner.ts";
import {
  correctionMessage,
  type LinkedTask,
  parseFindings,
  readAnswer,
  reviewSummary,
} from "./rules.ts";
import { HoustonHarnessStore, type StoredReview } from "./Store.ts";

const ENDED: ReadonlySet<OrchestrationV2Run["status"]> = new Set([
  "completed",
  "failed",
  "cancelled",
  "interrupted",
  "rolled_back",
]);

const UNREADABLE = "the run ended without a readable answer";
const STOPPED_WHILE_PREPARING = "the server stopped while this review was being prepared";

const endedBecause = (status: OrchestrationV2Run["status"]) =>
  status === "failed"
    ? "the run failed"
    : status === "cancelled"
      ? "the run was cancelled"
      : status === "interrupted"
        ? "the run was interrupted"
        : `the run ended ${status}`;

const MIB = HOUSTON_HARNESS_LIMITS.reportBytes;

export class HarnessReviewReactor extends Context.Service<
  HarnessReviewReactor,
  {
    /** Settles a review thread's ended run; a run of any other thread is ignored. */
    readonly settleRun: (run: OrchestrationV2Run) => Effect.Effect<void>;
    /** Settles every open review against the stored runs, as the server does on start. */
    readonly recover: Effect.Effect<void>;
  }
>()("houston/houston/harnessReview/Reactor/HarnessReviewReactor") {}

const make = Effect.gen(function* () {
  const store = yield* HoustonHarnessStore;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));
  const fail = (review: StoredReview, error: string) =>
    Effect.flatMap(nowIso, (endedAt) => store.fail(review.id, { endedAt, error }));

  const correct = Effect.fn("HarnessReviewReactor.correct")(function* (
    review: StoredReview,
    run: OrchestrationV2Run,
    error: string,
  ) {
    if (review.corrections >= HOUSTON_HARNESS_LIMITS.corrections) {
      return yield* fail(
        review,
        `the answer could not be read after ${review.corrections} corrections: ${error}`,
      );
    }
    const number = review.corrections + 1;
    yield* store.recordCorrection(review.id, run.id);
    yield* orchestrator
      .dispatch({
        type: "message.dispatch",
        createdBy: "system",
        creationSource: "server",
        commandId: CommandId.make(`harness-review:${review.id}:correction-${number}`),
        threadId: ThreadId.make(review.threadId!),
        messageId: correctionMessageId(review.id, number),
        text: correctionMessage(error),
        attachments: [],
        dispatchMode: { type: "start_immediately" },
      })
      .pipe(
        Effect.catchCause((cause) =>
          fail(review, `sending correction ${number} failed: ${String(cause)}`),
        ),
      );
  });

  const publishAnswer = Effect.fn("HarnessReviewReactor.publishAnswer")(function* (
    review: StoredReview,
    run: OrchestrationV2Run,
  ) {
    const records = yield* projections
      .getThreadRecords(run.threadId, ["turnItems"], {
        turnItemRunId: run.id,
        turnItemTypes: ["assistant_message"],
      })
      .pipe(Effect.option);
    const answer = Option.isNone(records)
      ? undefined
      : finalAssistantText(records.value.turnItems, run.id);
    if (answer === undefined) return yield* correct(review, run, "the answer is empty");
    const read = readAnswer(answer);
    if (!read.ok) return yield* correct(review, run, read.error);
    for (const [name, text] of [
      ["the report", read.report],
      ["findings.json", read.findingsJson],
    ] as const) {
      const bytes = Buffer.byteLength(text);
      if (bytes > MIB) {
        return yield* correct(review, run, `${name} is ${bytes} bytes, over the 1 MiB cap`);
      }
    }
    const parsed = parseFindings(read.findingsJson, new Map<string, ReadonlyArray<LinkedTask>>());
    if (!parsed.ok) return yield* correct(review, run, parsed.error);

    const project = yield* projects.get(review.projectId).pipe(Effect.orElseSucceed(Option.none));
    if (Option.isSome(project)) {
      const dir = path.join(project.value.workspaceRoot, ...review.runDir.split("/"));
      const written = yield* runDirectory(project.value.workspaceRoot, review.runDir, {
        create: false,
      }).pipe(
        Effect.flatMap(() =>
          Effect.all([
            fs.writeFileString(path.join(dir, "report.md"), read.report),
            fs.writeFileString(path.join(dir, "findings.json"), `${read.findingsJson.trim()}\n`),
          ]),
        ),
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, path),
        Effect.result,
      );
      if (written._tag === "Failure") {
        return yield* fail(
          review,
          `writing the report into ${dir} failed: ${written.failure.message}`,
        );
      }
    }
    yield* store.publish(review.id, {
      endedAt: yield* nowIso,
      windowSince: null,
      windowUntil: null,
      threads: null,
      prompts: null,
      costUsd: parsed.value.costUsd,
      summary: reviewSummary(parsed.value.summary, parsed.value.findings.length),
      findings: parsed.value.findings,
      verifications: parsed.value.verifications,
    });
  });

  const settleRun: HarnessReviewReactor["Service"]["settleRun"] = Effect.fn(
    "HarnessReviewReactor.settleRun",
  )(
    function* (run) {
      if (!ENDED.has(run.status)) return;
      const review = yield* store.reviewByThread(run.threadId);
      if (review === undefined || review.status !== "running" || review.runId === run.id) return;
      if (run.status === "completed") return yield* publishAnswer(review, run);
      return yield* fail(review, `${UNREADABLE}: ${endedBecause(run.status)}`);
    },
    (effect, run) =>
      effect.pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Could not settle a harness review run", {
            threadId: run.threadId,
            runId: run.id,
            cause,
          }),
        ),
      ),
  );

  const threadDeleted = Effect.fn("HarnessReviewReactor.threadDeleted")(function* (
    threadId: ThreadId,
  ) {
    const review = yield* store.reviewByThread(threadId);
    if (review === undefined || review.status !== "running") return;
    yield* fail(review, `${UNREADABLE}: its thread was deleted`);
  });

  const recover: HarnessReviewReactor["Service"]["recover"] = Effect.gen(function* () {
    for (const review of yield* store.activeReviews) {
      if (review.status === "preparing") {
        yield* fail(review, STOPPED_WHILE_PREPARING);
        continue;
      }
      if (review.threadId === null) {
        yield* fail(review, `${UNREADABLE}: its thread was never started`);
        continue;
      }
      const records = yield* projections
        .getThreadRecords(review.threadId, ["runs"])
        .pipe(Effect.option);
      if (Option.isNone(records) || records.value.thread.deletedAt !== null) {
        yield* threadDeleted(review.threadId);
        continue;
      }
      const latest = records.value.runs.toSorted((left, right) => right.ordinal - left.ordinal)[0];
      if (latest !== undefined) yield* settleRun(latest);
    }
  });

  yield* recover;
  yield* orchestrator.streamDomainEvents.pipe(
    Stream.runForEach((event) =>
      event.type === "run.updated"
        ? settleRun(event.payload)
        : event.type === "thread.deleted" && event.payload.side?.kind === "harnessReview"
          ? threadDeleted(event.threadId)
          : Effect.void,
    ),
    Effect.catchCause((cause) =>
      Effect.logWarning("The harness review reactor stopped", { cause }),
    ),
    Effect.forkScoped,
  );

  return HarnessReviewReactor.of({ settleRun, recover });
});

/** Settles open reviews and follows run ends for as long as the layer lives. */
export const layer = Layer.effect(HarnessReviewReactor, make);
