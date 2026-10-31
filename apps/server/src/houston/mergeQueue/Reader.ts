// Reads every queued pull request once a minute, and fresh when asked. An entry GitHub reports
// merged or closed leaves the queue; a read that changes nothing publishes nothing.
import { HOUSTON_MERGE_QUEUE_LIMITS } from "@t3tools/contracts/houston/mergeQueue";
import type { ProjectId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { HoustonMergeQueueGitHub, type PullRead } from "./GitHubQueueClient.ts";
import { HoustonMergeQueueProject, type ProjectTarget } from "./Project.ts";
import { HoustonMergeQueueOutcomes } from "./Outcomes.ts";
import {
  handOffMode,
  sameAnswer,
  targetBase,
  verificationHolds,
  type Facts,
  type QueueRow,
} from "./rules.ts";
import { HoustonMergeQueueStore, nowIso } from "./Store.ts";
import { HoustonMergeVerifier } from "./Verifier.ts";

export class HoustonMergeQueueReader extends Context.Service<
  HoustonMergeQueueReader,
  {
    /** Reads one entry and applies the answer; the read, or its failure's text. */
    readonly readEntry: (
      target: ProjectTarget,
      row: QueueRow,
    ) => Effect.Effect<{ readonly read: PullRead | null; readonly error: string | null }>;
    readonly readProject: (projectId: ProjectId) => Effect.Effect<void>;
    readonly readAll: Effect.Effect<void>;
    /** How many read loops this reader started; one per server. */
    readonly loopsStarted: Effect.Effect<number>;
  }
>()("houston/houston/mergeQueue/Reader/HoustonMergeQueueReader") {}

export const failedFacts = (error: string, readAt: string, row: QueueRow): Facts => ({
  readAt,
  error,
  state: "open",
  isDraft: false,
  headSha: row.headSha,
  headRef: row.headRef,
  baseRef: row.baseRef,
  title: row.title,
  url: row.url,
  checks: [],
  reviewDecision: null,
  mergeState: null,
  mergeability: "unknown",
  unresolvedThreads: null,
  threadsTruncated: false,
  mergeMethods: { merge: false, squash: false, rebase: false },
  defaultBranch: null,
  handOff: null,
  nodeId: null,
});

export const makeReader = Effect.fn("HoustonMergeQueueReader.make")(function* (options: {
  readonly loops: boolean;
}) {
  const store = yield* HoustonMergeQueueStore;
  const github = yield* HoustonMergeQueueGitHub;
  const projects = yield* HoustonMergeQueueProject;
  const verifier = yield* HoustonMergeVerifier;
  const outcomes = yield* HoustonMergeQueueOutcomes;
  let loops = 0;

  const leave = Effect.fn("HoustonMergeQueueReader.leave")(function* (
    target: ProjectTarget,
    row: QueueRow,
    merged: boolean,
  ) {
    yield* store.removeEntry(target.projectId, row.number);
    yield* store.clearDependency(
      target.projectId,
      row.number,
      merged
        ? { number: row.number, headSha: row.headSha, headRef: row.headRef, baseRef: row.baseRef }
        : null,
    );
    yield* verifier.forget(target.workspaceRoot, target.remote, row.headRef);
  });

  const readEntry: HoustonMergeQueueReader["Service"]["readEntry"] = Effect.fn(
    "HoustonMergeQueueReader.readEntry",
  )(function* (target, row) {
    const read = yield* Effect.result(github.read(target, row.number));
    if (read._tag === "Failure") {
      const facts = failedFacts(read.failure, yield* nowIso, row);
      yield* store.setFacts(target.projectId, row.number, facts, !sameAnswer(row.facts, facts));
      return { read: null, error: read.failure };
    }
    const { facts } = read.success;
    const base = targetBase({ baseRef: facts.baseRef, stacked: row.stacked });
    if (facts.handOff !== undefined && facts.handOff !== null && base !== null) {
      yield* store.recordHandOff(target.projectId, base, handOffMode(facts, base, {}));
    }
    const hold = row.github;
    if (facts.state === "merged" && hold !== null) {
      // GitHub landed what Houston handed it: the landing finishes as for Houston's own merge.
      const verification = verificationHolds(row);
      yield* outcomes.finishMerge(target, row, {
        commit: facts.headSha,
        method: hold.method ?? null,
        baseBefore: verification?.baseSha ?? null,
        unattended: hold.unattended === true,
      });
      return { read: read.success, error: null };
    }
    if (facts.state !== "open") {
      yield* leave(target, row, facts.state === "merged");
      return { read: read.success, error: null };
    }
    yield* store.setFacts(target.projectId, row.number, facts, !sameAnswer(row.facts, facts));
    return { read: read.success, error: null };
  });

  const readProject = (projectId: ProjectId) =>
    Effect.gen(function* () {
      const target = yield* projects.target("houston.mergeQueue.read", projectId);
      for (const row of yield* store.rows(projectId)) yield* readEntry(target, row);
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning(`Reading the merge queue of ${projectId} failed.`, cause),
      ),
    );

  const readAll = Effect.gen(function* () {
    for (const projectId of yield* store.projectsWithEntries) yield* readProject(projectId);
  });

  if (options.loops) {
    loops += 1;
    yield* Effect.forever(
      readAll.pipe(
        Effect.andThen(
          Effect.sleep(Duration.seconds(HOUSTON_MERGE_QUEUE_LIMITS.readIntervalSeconds)),
        ),
      ),
    ).pipe(Effect.forkScoped);
  }

  return HoustonMergeQueueReader.of({
    readEntry,
    readProject,
    readAll,
    loopsStarted: Effect.sync(() => loops),
  });
});

export const layer = (options: { readonly loops: boolean }) =>
  Layer.effect(HoustonMergeQueueReader, makeReader(options));
