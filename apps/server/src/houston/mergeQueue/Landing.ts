// Lands the entry that goes next: re-checks the pause, gates, head and base, pushes the verified
// commit with a lease when it is not the head yet, and merges exactly the commit the gates read,
// or hands that commit to GitHub's merge queue or auto-merge.
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
import { HoustonMergeQueueOutcomes } from "./Outcomes.ts";
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
  handOffMode,
  mergeRefusal,
  nextUp,
  preferredMethod,
  pushGuard,
  refuse,
  shortSha,
  targetBase,
  targetsDependency,
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
/** GitHub's refusal of a REST merge into a base that requires its merge queue. */
const MERGE_QUEUE_REQUIRED = /merge queue/i;

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
  }
>()("houston/houston/mergeQueue/Landing/HoustonMergeLanding") {}

const make = Effect.gen(function* () {
  const store = yield* HoustonMergeQueueStore;
  const projects = yield* HoustonMergeQueueProject;
  const github = yield* HoustonMergeQueueGitHub;
  const reader = yield* HoustonMergeQueueReader;
  const verifier = yield* HoustonMergeVerifier;
  const outcomes = yield* HoustonMergeQueueOutcomes;
  const vcs = yield* VcsProcess.VcsProcess;
  // One landing at a time on this server.
  const lock = yield* Semaphore.make(1);

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

  const logRow = (
    target: ProjectTarget,
    row: QueueRow,
    entry: Omit<
      Parameters<HoustonMergeQueueStore["Service"]["appendLog"]>[1],
      "number" | "repository" | "url" | "title"
    >,
  ) =>
    store.appendLog(target.projectId, {
      number: row.number,
      repository: row.repository,
      url: row.url,
      title: row.title,
      ...entry,
    });

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
        if (entry.status === "watching") {
          return yield* refuse(
            "conflict",
            OPERATION,
            `PR #${number} is held by GitHub: ${entry.reason ?? "handed off"}; dequeue it to take it back`,
          );
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
        const base = targetBase(row);
        const mode = handOffMode(row.facts, base, yield* store.handOffs(target.projectId));
        const restacked = verification?.forkSha !== undefined;
        // GitHub's merge queue takes the head as it is; a restack is pushed first all the same.
        const commit =
          mode === "mergeQueue" && !restacked
            ? row.headSha
            : (verification?.verifiedSha ?? input.expectedHeadSha ?? row.headSha);
        const pushed = verification !== null && row.headSha !== commit;
        const retarget = targetsDependency(row) && base !== null ? row.baseRef : null;
        const fail = Effect.fn("HoustonMergeLanding.fail")(function* (
          message: string,
          always = false,
        ) {
          if (unattended || always) {
            yield* outcomes.recordFailure(target, row, yield* refusedFailure(row, message), true);
          }
          return yield* refuse("refused", OPERATION, message);
        });

        if (pushed || retarget !== null) {
          const guard = pushGuard({
            branch: row.headRef,
            baseRef: base,
            defaultBranch: row.facts?.defaultBranch ?? null,
            managedBranches: yield* projects.managedBranches(target),
            taskBranches: yield* projects.taskBranches(target.projectId),
          });
          if (guard !== null) return yield* fail(guard);
        }
        if (retarget !== null) {
          yield* pausedNow;
          const moved = yield* Effect.result(github.retarget(target, number, base!));
          if (moved._tag === "Failure") return yield* fail(moved.failure);
          yield* logRow(target, row, {
            kind: "retarget",
            refName: base,
            oldSha: null,
            newSha: null,
            headSha: row.headSha,
            forkSha: null,
            method: null,
            detail: `Retargeted from ${retarget}`,
            unattended,
          });
        }
        if (pushed) {
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
            ...verification!,
            headChecks: row.facts?.checks.length ?? 0,
          });
          yield* logRow(target, row, {
            kind: "push",
            refName: row.headRef,
            oldSha: row.headSha,
            newSha: commit,
            headSha: null,
            forkSha: null,
            method: null,
            detail: null,
            unattended,
          });
          if (restacked) {
            yield* logRow(target, row, {
              kind: "restack",
              refName: row.headRef,
              oldSha: row.headSha,
              newSha: commit,
              headSha: null,
              forkSha: verification!.forkSha!,
              method: null,
              detail: `Replayed onto ${base} after ${shortSha(verification!.forkSha!)}`,
              unattended,
            });
          }
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
          yield* outcomes.recordFailure(
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
        const baseSha = (branch: string) =>
          verifier.fetch(target.workspaceRoot, target.remote, [branch]).pipe(
            Effect.andThen(verifier.remoteSha(target.workspaceRoot, target.remote, branch)),
            Effect.orElseSucceed(() => null),
          );

        if (mode !== "houston") {
          const nodeId = row.facts?.nodeId ?? null;
          if (nodeId === null) {
            return yield* fail(
              `GitHub gave no node id for PR #${number}, so it cannot be handed off`,
            );
          }
          const sent = yield* Effect.result(
            github.handOff({ target, number, nodeId, mode, sha: commit, method }),
          );
          if (sent._tag === "Failure") return yield* fail(sent.failure);
          yield* store.setGitHub(target.projectId, number, {
            mode,
            headSha: commit,
            at: yield* nowIso,
            unattended,
            ...(mode === "autoMerge" ? { method } : {}),
          });
          // One read confirms GitHub holds it at that commit; a host that hides it is trusted.
          const { read } = yield* reader.readEntry(target, row);
          if (read !== null && read.facts.state === "merged") {
            return { outcome: "merged" as const, message: `GitHub merged PR #${number} at once` };
          }
          const shown = read?.facts.handOff ?? null;
          const confirmed =
            read !== null &&
            read.facts.headSha === commit &&
            (shown === null ||
              (mode === "mergeQueue"
                ? shown.queueEntry !== null &&
                  (shown.queueEntry.headSha === null || shown.queueEntry.headSha === commit)
                : shown.autoMerge !== null));
          if (!confirmed) {
            yield* github
              .takeBack({ target, number, nodeId, mode })
              .pipe(
                Effect.catch((error: string) =>
                  Effect.logWarning(`Merge queue: taking PR #${number} back failed: ${error}`),
                ),
              );
            return yield* fail(
              `GitHub did not report PR #${number} ${mode === "mergeQueue" ? "in its merge queue" : "with auto-merge on"} at ${shortSha(commit)} after the hand-off; Houston took it back`,
              true,
            );
          }
          const what =
            mode === "mergeQueue"
              ? `In GitHub's merge queue${shown?.queueEntry?.position == null ? "" : ` (position ${shown.queueEntry.position})`}`
              : `Auto-merge on with a ${method} merge`;
          yield* logRow(target, row, {
            kind: "hand_off",
            refName: base,
            oldSha: verification?.baseSha ?? null,
            newSha: null,
            headSha: commit,
            forkSha: verification?.forkSha ?? null,
            method: mode === "autoMerge" ? method : null,
            detail: what,
            unattended,
          });
          return {
            outcome: "handedOff" as const,
            message: `handed PR #${number} to GitHub at ${commit}: ${what}`,
          };
        }

        const baseBefore = base === null ? null : yield* baseSha(base);
        const merged = yield* Effect.result(github.merge(target, number, commit, method));
        if (merged._tag === "Failure") {
          if (base !== null && MERGE_QUEUE_REQUIRED.test(merged.failure)) {
            // The base requires GitHub's merge queue, which the read did not show.
            yield* store.recordHandOff(target.projectId, base, "mergeQueue");
            return yield* fail(merged.failure, true);
          }
          return yield* fail(merged.failure);
        }
        yield* outcomes.finishMerge(target, row, {
          commit,
          method,
          baseBefore,
          unattended,
        });
        return {
          outcome: "merged" as const,
          message: `merged PR #${number} at ${commit} with a ${method} merge; the next entry is now first`,
        };
      }),
    );

  return HoustonMergeLanding.of({ land });
});

export const layer = Layer.effect(HoustonMergeLanding, make);
