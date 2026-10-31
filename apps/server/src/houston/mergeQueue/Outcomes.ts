// How an entry leaves the line: a failure goes to its owner thread once or parks, and a merge,
// Houston's or GitHub's, is logged, reported and announced to the owners on that base.
import type {
  HoustonMergeQueueFailure,
  HoustonMergeQueueMergeMethod,
} from "@t3tools/contracts/houston/mergeQueue";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { HoustonMergeQueueGitHub } from "./GitHubQueueClient.ts";
import type { ProjectTarget } from "./Project.ts";
import {
  baseMovedNote,
  failureNote,
  noteMessageId,
  ownerThread,
  shortSha,
  targetBase,
  type QueueRow,
} from "./rules.ts";
import { HoustonMergeQueueStore } from "./Store.ts";
import { HoustonMergeQueueThreads } from "./Threads.ts";
import { HoustonMergeVerifier } from "./Verifier.ts";

export interface Merged {
  /** The commit that merged. */
  readonly commit: string;
  readonly method: HoustonMergeQueueMergeMethod | null;
  readonly baseBefore: string | null;
  readonly unattended: boolean;
}

export class HoustonMergeQueueOutcomes extends Context.Service<
  HoustonMergeQueueOutcomes,
  {
    /** Records a failure for the entry's head: Fixing with an owner told once, else Parked. */
    readonly recordFailure: (
      target: ProjectTarget,
      row: QueueRow,
      failure: HoustonMergeQueueFailure,
      unattended: boolean,
    ) => Effect.Effect<void>;
    /** Removes a merged entry, logs and reports the merge, and tells owners on its base. */
    readonly finishMerge: (
      target: ProjectTarget,
      row: QueueRow,
      merged: Merged,
    ) => Effect.Effect<void>;
  }
>()("houston/houston/mergeQueue/Outcomes/HoustonMergeQueueOutcomes") {}

const make = Effect.gen(function* () {
  const store = yield* HoustonMergeQueueStore;
  const github = yield* HoustonMergeQueueGitHub;
  const verifier = yield* HoustonMergeVerifier;
  const threads = yield* HoustonMergeQueueThreads;
  // Notes sent since start; across a restart the orchestrator's receipt replays the same note.
  const sent = new Set<string>();

  const tell = (threadId: string, messageId: string, text: string) =>
    sent.has(messageId)
      ? Effect.succeed(true)
      : threads.notify({ threadId, messageId, text }).pipe(
          Effect.tap(() => Effect.sync(() => sent.add(messageId))),
          Effect.as(true),
          Effect.catch((error: string) =>
            Effect.logWarning(`Merge queue: telling thread ${threadId} failed: ${error}`).pipe(
              Effect.as(false),
            ),
          ),
        );

  const recordFailure: HoustonMergeQueueOutcomes["Service"]["recordFailure"] = Effect.fn(
    "HoustonMergeQueueOutcomes.recordFailure",
  )(function* (target, row, failure, unattended) {
    const owner = ownerThread(
      yield* threads.list(target.projectId),
      row.ownerThreadId,
      row.headRef,
    );
    const told =
      owner !== null &&
      (yield* tell(
        owner,
        noteMessageId(target.projectId, row.number, failure.headSha, failure.kind),
        failureNote({
          number: row.number,
          url: row.url,
          title: row.title,
          headRef: row.headRef,
          failure,
        }),
      ));
    yield* store.setGitHub(target.projectId, row.number, null);
    yield* store.setFailure(target.projectId, row.number, {
      ...failure,
      notifiedThreadId: told ? owner : null,
    });
    if (told) return;
    yield* store.appendLog(target.projectId, {
      kind: "park",
      number: row.number,
      repository: row.repository,
      url: row.url,
      title: row.title,
      refName: row.headRef,
      oldSha: null,
      newSha: null,
      headSha: row.headSha,
      forkSha: null,
      method: null,
      detail: failure.message,
      unattended,
    });
  });

  const baseSha = (target: ProjectTarget, branch: string) =>
    verifier.fetch(target.workspaceRoot, target.remote, [branch]).pipe(
      Effect.andThen(verifier.remoteSha(target.workspaceRoot, target.remote, branch)),
      Effect.orElseSucceed(() => null),
    );

  const finishMerge: HoustonMergeQueueOutcomes["Service"]["finishMerge"] = Effect.fn(
    "HoustonMergeQueueOutcomes.finishMerge",
  )(function* (target, row, merged) {
    const base = targetBase(row);
    yield* store.removeEntry(target.projectId, row.number);
    yield* store.clearDependency(target.projectId, row.number, {
      number: row.number,
      headSha: merged.commit,
      headRef: row.headRef,
      baseRef: base,
    });
    yield* verifier.forget(target.workspaceRoot, target.remote, row.headRef);
    const baseAfter = base === null ? null : yield* baseSha(target, base);
    yield* store.appendLog(target.projectId, {
      kind: "merge",
      number: row.number,
      repository: row.repository,
      url: row.url,
      title: row.title,
      refName: base,
      oldSha: merged.baseBefore,
      newSha: baseAfter,
      headSha: merged.commit,
      forkSha: null,
      method: merged.method,
      detail: null,
      unattended: merged.unattended,
    });
    yield* github.reportMerged(target, row.number);
    if (base !== null && baseAfter !== null) {
      const project = yield* threads.list(target.projectId);
      const told = new Set<string>();
      for (const other of yield* store.rows(target.projectId)) {
        if (targetBase(other) !== base) continue;
        const owner = ownerThread(project, other.ownerThreadId, other.headRef);
        if (owner === null || told.has(owner)) continue;
        told.add(owner);
        yield* tell(
          owner,
          `message:merge-queue:${target.projectId}:${other.number}:base:${shortSha(baseAfter)}`,
          baseMovedNote(base, baseAfter, row.number),
        );
      }
    }
    yield* store.wake;
  });

  return HoustonMergeQueueOutcomes.of({ recordFailure, finishMerge });
});

export const layer = Layer.effect(HoustonMergeQueueOutcomes, make);
