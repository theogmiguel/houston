// Lands the entry that goes next: re-checks the pause, gates, head and base, pushes the verified
// commit with a lease when it is not the head yet, and merges exactly the commit the gates read.
import type { ProjectId } from "@t3tools/contracts";
import type {
  HoustonMergeQueueFailure,
  HoustonMergeQueueMergeHeadResult,
  HoustonMergeQueueVerification,
} from "@t3tools/contracts/houston/mergeQueue";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";

import * as VcsProcess from "../../vcs/VcsProcess.ts";
import { HoustonMergeQueueGitHub } from "./GitHubQueueClient.ts";
import {
  GIT_NETWORK_TIMEOUT_MS,
  HoustonMergeQueueProject,
  git,
  type ProjectTarget,
} from "./Project.ts";
import { HoustonMergeQueueReader } from "./Reader.ts";
import {
  baseOnly,
  failingChecks,
  mergeRefusal,
  nextUp,
  preferredMethod,
  pushGuard,
  refuse,
  shortSha,
  unreportedChecks,
  verificationHolds,
  type QueueRow,
} from "./rules.ts";
import { HoustonMergeQueueStore, nowIso } from "./Store.ts";
import { HoustonMergeVerifier } from "./Verifier.ts";

const OPERATION = "houston.mergeQueue.mergeHead";
/** After a push, GitHub is read this many times, this far apart, to see the pushed head. */
const AFTER_PUSH_READS = 6;
const AFTER_PUSH_WAIT = Duration.seconds(5);

export interface LandInput {
  readonly projectId: ProjectId;
  readonly number: number;
  /** The head the user saw; null for the runner's own landing. */
  readonly expectedHeadSha: string | null;
  readonly unattended: boolean;
}

/** The queue's only push: the verified commit, only while the branch is at the recorded head. */
export const pushWithLease = (
  repo: string,
  remote: string,
  branch: string,
  oldSha: string,
  newSha: string,
) =>
  git(
    repo,
    [
      "push",
      "--porcelain",
      `--force-with-lease=refs/heads/${branch}:${oldSha}`,
      remote,
      `${newSha}:refs/heads/${branch}`,
    ],
    GIT_NETWORK_TIMEOUT_MS,
  ).pipe(
    Effect.flatMap((result) => {
      if (result.exitCode === 0) return Effect.void;
      const said = `${result.stdout}${result.stderr}`;
      return Effect.fail(
        /stale info|fetch first|rejected/.test(said)
          ? `the push to ${branch} was refused: ${remote}/${branch} is no longer at the recorded ${oldSha}, so the lease did not hold and nothing was overwritten`
          : `pushing ${newSha} to ${remote}/${branch} failed (exit ${result.exitCode}): ${said.trim()}`,
      );
    }),
  );

export class HoustonMergeLanding extends Context.Service<
  HoustonMergeLanding,
  {
    readonly land: (
      input: LandInput,
    ) => Effect.Effect<HoustonMergeQueueMergeHeadResult, ReturnType<typeof refuse>>;
    /** Records a failure for the entry's current head and parks it with a log row. */
    readonly recordFailure: (
      target: ProjectTarget,
      row: QueueRow,
      failure: HoustonMergeQueueFailure,
      unattended: boolean,
    ) => Effect.Effect<void>;
  }
>()("houston/houston/mergeQueue/Landing/HoustonMergeLanding") {}

const make = Effect.gen(function* () {
  const store = yield* HoustonMergeQueueStore;
  const projects = yield* HoustonMergeQueueProject;
  const github = yield* HoustonMergeQueueGitHub;
  const reader = yield* HoustonMergeQueueReader;
  const verifier = yield* HoustonMergeVerifier;
  const vcs = yield* VcsProcess.VcsProcess;
  // One landing at a time on this server.
  const lock = yield* Semaphore.make(1);

  const recordFailure: HoustonMergeLanding["Service"]["recordFailure"] = Effect.fn(
    "HoustonMergeLanding.recordFailure",
  )(function* (target, row, failure, unattended) {
    yield* store.setFailure(target.projectId, row.number, failure);
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

  const refusedFailure = (row: QueueRow, message: string) =>
    nowIso.pipe(
      Effect.map((at): HoustonMergeQueueFailure => ({
        kind: "refused",
        message,
        headSha: row.headSha,
        baseSha: null,
        files: [],
        outputTail: null,
        notifiedThreadId: null,
        at,
      })),
    );

  /** Fetches the base; a base that moved since the verification discards it. */
  const baseMoved = Effect.fn("HoustonMergeLanding.baseMoved")(
    function* (target: ProjectTarget, row: QueueRow, verification: HoustonMergeQueueVerification) {
      yield* verifier.fetch(target.workspaceRoot, target.remote, [verification.baseRef]);
      const now = yield* verifier.remoteSha(
        target.workspaceRoot,
        target.remote,
        verification.baseRef,
      );
      if (now === verification.baseSha) return null;
      yield* store.setVerification(target.projectId, row.number, null);
      yield* store.wake;
      return `${verification.baseRef} moved from ${shortSha(verification.baseSha)} to ${shortSha(now)} since PR #${row.number} was verified; it verifies again on the new base`;
    },
    Effect.mapError((error) => refuse("remote", OPERATION, error)),
  );

  const land: HoustonMergeLanding["Service"]["land"] = (input) =>
    lock.withPermits(1)(
      Effect.gen(function* () {
        const { number, unattended } = input;
        const target = yield* projects.target(OPERATION, input.projectId);
        const pausedNow = projects
          .pausedReason(target)
          .pipe(
            Effect.flatMap((paused) =>
              paused === null
                ? Effect.void
                : Effect.fail(
                    refuse("paused", OPERATION, `${paused}; PR #${number} was not merged`),
                  ),
            ),
          );
        yield* pausedNow;
        let view = yield* projects.view(target);
        const commandSet = view.context.commandSet;
        if (commandSet && view.context.refusal !== null) {
          return yield* refuse("refused", OPERATION, view.context.refusal);
        }
        const find = () => {
          const index = view.rows.findIndex((row) => row.number === number);
          return index < 0
            ? Effect.fail(
                refuse(
                  "not_found",
                  OPERATION,
                  `PR #${number} is not in the merge queue of ${target.title}`,
                ),
              )
            : Effect.succeed({ row: view.rows[index]!, entry: view.entries[index]! });
        };
        let { row, entry } = yield* find();
        // The user's Merge of an entry ahead of the next one reads it again: it may have cleared.
        const next = nextUp(view.entries);
        if (
          !unattended &&
          entry.position > 0 &&
          (next === undefined || entry.position < next.position)
        ) {
          yield* reader.readEntry(target, row);
          view = yield* projects.view(target);
          ({ row, entry } = yield* find());
        }
        const goesNext = nextUp(view.entries);
        if (goesNext?.number !== number) {
          const why = entry.reason ?? "no reason recorded";
          const place =
            entry.position === 0
              ? `out of line: ${why}`
              : entry.status === "blocked"
                ? `blocked: ${why}`
                : `number ${entry.position} in line`;
          const first =
            goesNext === undefined ? "no entry goes next" : `#${goesNext.number} goes next`;
          return yield* refuse(
            "conflict",
            OPERATION,
            `only the entry that goes next can be merged from the merge queue: ${first} and PR #${number} is ${place}; dequeue #${number} to merge it on its own`,
          );
        }
        if (input.expectedHeadSha !== null && input.expectedHeadSha !== row.headSha) {
          return yield* refuse(
            "conflict",
            OPERATION,
            `PR #${number} head moved from ${input.expectedHeadSha} to ${row.headSha}; refusing to merge an unseen commit`,
          );
        }
        const verification = commandSet ? verificationHolds(row) : null;
        if (commandSet && verification === null) {
          return yield* refuse(
            "conflict",
            OPERATION,
            `PR #${number} has not passed verification on its base yet; it merges once it is verified`,
          );
        }
        if (verification !== null) {
          const moved = yield* baseMoved(target, row, verification);
          if (moved !== null) return { outcome: "waiting" as const, message: moved };
        }
        const commit = verification?.verifiedSha ?? input.expectedHeadSha ?? row.headSha;
        const pushed = verification !== null && row.headSha !== commit;
        const fail = Effect.fn("HoustonMergeLanding.fail")(function* (message: string) {
          if (unattended)
            yield* recordFailure(target, row, yield* refusedFailure(row, message), true);
          return yield* refuse("refused", OPERATION, message);
        });

        if (pushed) {
          const guard = pushGuard({
            branch: row.headRef,
            baseRef: row.baseRef,
            defaultBranch: row.facts?.defaultBranch ?? null,
            managedBranches: yield* projects.managedBranches(target),
            taskBranches: yield* projects.taskBranches(target.projectId),
          });
          if (guard !== null) return yield* fail(guard);
          yield* pausedNow;
          const leased = yield* Effect.result(
            Effect.provideService(
              pushWithLease(target.workspaceRoot, target.remote, row.headRef, row.headSha, commit),
              VcsProcess.VcsProcess,
              vcs,
            ),
          );
          if (leased._tag === "Failure") return yield* fail(leased.failure);
          // Until CI registers on the pushed commit GitHub may call it clean with no checks.
          yield* store.setVerification(target.projectId, number, {
            ...verification,
            headChecks: row.facts?.checks.length ?? 0,
          });
          yield* store.appendLog(target.projectId, {
            kind: "push",
            number,
            repository: row.repository,
            url: row.url,
            title: row.title,
            refName: row.headRef,
            oldSha: row.headSha,
            newSha: commit,
            headSha: null,
            forkSha: null,
            method: null,
            detail: null,
            unattended,
          });
        }

        // GitHub must report the commit as the head before its gates are read on it.
        for (let reads = 1; ; reads += 1) {
          const { read, error } = yield* reader.readEntry(target, row);
          if (read === null) {
            return yield* refuse(
              "remote",
              OPERATION,
              `could not read PR #${number} to merge it: ${error}`,
            );
          }
          if (read.facts.state !== "open") {
            return yield* refuse(
              "conflict",
              OPERATION,
              `PR #${number} is ${read.facts.state} on GitHub; it left the merge queue`,
            );
          }
          if (read.facts.headSha === commit) break;
          if (!pushed) {
            return yield* refuse(
              "conflict",
              OPERATION,
              `PR #${number} head moved from ${commit} to ${read.facts.headSha}; refusing to merge an unseen commit`,
            );
          }
          if (reads >= AFTER_PUSH_READS) {
            return {
              outcome: "waiting" as const,
              message: `GitHub still reports ${read.facts.headSha} as the head of PR #${number} after the push of ${commit}; it merges once GitHub reports the pushed commit`,
            };
          }
          yield* Effect.sleep(AFTER_PUSH_WAIT);
        }

        view = yield* projects.view(target);
        ({ row, entry } = yield* find());
        const held = verificationHolds(row);
        const failing = row.facts === null ? [] : failingChecks(row.facts);
        if (
          held !== null &&
          held.verifiedSha !== held.headSha &&
          row.headSha === held.verifiedSha &&
          failing.length > 0
        ) {
          const message = `GitHub's checks failed on the verified commit ${shortSha(held.verifiedSha)} the queue pushed: ${failing.join(", ")}`;
          yield* recordFailure(
            target,
            row,
            {
              ...(yield* refusedFailure(row, message)),
              kind: "checksFailed",
              baseSha: held.baseSha,
            },
            unattended,
          );
          return yield* refuse(
            "refused",
            OPERATION,
            `GitHub's checks failed on the verified commit of PR #${number}; it left the line`,
          );
        }
        const reported = row.facts?.checks.length ?? 0;
        const awaited = unreportedChecks(row);
        if (held !== null && awaited !== null) {
          return {
            outcome: "waiting" as const,
            message: `GitHub reports ${reported} of ${awaited} checks on the pushed commit ${shortSha(held.verifiedSha)} of PR #${number}; it merges once every check the previous head had has reported and passed`,
          };
        }
        if (entry.status === "blocked") {
          const reason = entry.reason ?? "";
          if (pushed) {
            return {
              outcome: "waiting" as const,
              message: `pushed the verified commit of PR #${number}; it merges once GitHub clears this: ${reason}`,
            };
          }
          return yield* refuse(
            "refused",
            OPERATION,
            `PR #${number} is blocked in the merge queue: ${reason}`,
          );
        }
        if (verification !== null) {
          const moved = yield* baseMoved(target, row, verification);
          if (moved !== null) return { outcome: "waiting" as const, message: moved };
        }
        // The base held, so a base-only refusal is GitHub's answer for the commit before the rebase.
        if (commandSet && row.facts !== null && baseOnly(number, row.facts)) {
          return {
            outcome: "waiting" as const,
            message: `${mergeRefusal(number, row.facts)}; it merges once GitHub recomputes against the verified commit`,
          };
        }
        yield* pausedNow;
        const method = preferredMethod(row.facts?.mergeMethods) ?? "squash";
        const base = row.baseRef;
        const baseSha = (branch: string) =>
          verifier.fetch(target.workspaceRoot, target.remote, [branch]).pipe(
            Effect.andThen(verifier.remoteSha(target.workspaceRoot, target.remote, branch)),
            Effect.orElseSucceed(() => null),
          );
        const baseBefore = base === null ? null : yield* baseSha(base);
        const merged = yield* Effect.result(github.merge(target, number, commit, method));
        if (merged._tag === "Failure") return yield* fail(merged.failure);

        yield* store.removeEntry(target.projectId, number);
        yield* store.clearDependency(target.projectId, number, {
          number,
          headSha: commit,
          headRef: row.headRef,
          baseRef: base,
        });
        yield* verifier.forget(target.workspaceRoot, target.remote, row.headRef);
        const baseAfter = base === null ? null : yield* baseSha(base);
        yield* store.appendLog(target.projectId, {
          kind: "merge",
          number,
          repository: row.repository,
          url: row.url,
          title: row.title,
          refName: base,
          oldSha: baseBefore,
          newSha: baseAfter,
          headSha: commit,
          forkSha: null,
          method,
          detail: null,
          unattended,
        });
        yield* github.reportMerged(target, number);
        yield* store.wake;
        return {
          outcome: "merged" as const,
          message: `merged PR #${number} at ${commit} with a ${method} merge; the next entry is now first`,
        };
      }),
    );

  return HoustonMergeLanding.of({ land, recordFailure });
});

export const layer = Layer.effect(HoustonMergeLanding, make);
