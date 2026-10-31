// One pass a minute, or on a wake: for each project with a queue, the entry that goes next moves
// one step at a time (verify, fail, land), at most a few steps per project per pass.
import type { ProjectId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Semaphore from "effect/Semaphore";

import { HoustonBuildSlot } from "./BuildSlot.ts";
import { HoustonMergeLanding } from "./Landing.ts";
import { HoustonMergeQueueProject, type ProjectTarget } from "./Project.ts";
import {
  failingChecks,
  failureFor,
  failureHolds,
  nextUp,
  shortSha,
  verificationHolds,
  type QueueRow,
} from "./rules.ts";
import { HoustonMergeQueueStore, nowIso } from "./Store.ts";
import { HoustonMergeVerifier } from "./Verifier.ts";

/** Steps one project may take in one pass, so one queue cannot hold a pass for long. */
const STEPS_PER_PASS = 8;
const PASS_INTERVAL = Duration.seconds(60);

export class HoustonMergeQueueRunner extends Context.Service<
  HoustonMergeQueueRunner,
  {
    /** One pass over every project with a queue. */
    readonly pass: Effect.Effect<void>;
    /** Moves one project's queue until it can move no further this pass. */
    readonly step: (projectId: ProjectId) => Effect.Effect<void>;
    /** How many runner loops this runner started; one per server. */
    readonly loopsStarted: Effect.Effect<number>;
  }
>()("houston/houston/mergeQueue/Runner/HoustonMergeQueueRunner") {}

export const makeRunner = Effect.fn("HoustonMergeQueueRunner.make")(function* (options: {
  readonly loops: boolean;
}) {
  const store = yield* HoustonMergeQueueStore;
  const projects = yield* HoustonMergeQueueProject;
  const slot = yield* HoustonBuildSlot;
  const verifier = yield* HoustonMergeVerifier;
  const landing = yield* HoustonMergeLanding;
  const passLock = yield* Semaphore.make(1);
  const projectLocks = new Map<string, Semaphore.Semaphore>();
  let loops = 0;

  const protectedRoots = (target: ProjectTarget) =>
    projects.managedDirectories.pipe(
      Effect.map((directories) => [target.workspaceRoot, ...directories]),
    );

  const verifyHead = Effect.fn("HoustonMergeQueueRunner.verifyHead")(function* (
    target: ProjectTarget,
    row: QueueRow,
  ) {
    const settings = yield* store.settings(target.projectId);
    const command = settings.verificationCommand.trim();
    const baseRef = row.baseRef;
    if (baseRef === null) {
      yield* landing.recordFailure(
        target,
        row,
        {
          kind: "refused",
          message: `GitHub reported no base branch for PR #${row.number}`,
          headSha: row.headSha,
          baseSha: null,
          files: [],
          outputTail: null,
          notifiedThreadId: null,
          at: yield* nowIso,
        },
        true,
      );
      return true;
    }
    const roots = yield* protectedRoots(target);
    const ran = yield* slot.withSlot(
      {
        label: `PR #${row.number} of ${target.projectId} (${target.title})`,
        projectId: target.projectId,
        number: row.number,
      },
      store.touch(target.projectId).pipe(
        Effect.andThen(
          verifier.verify({
            repo: target.workspaceRoot,
            remote: target.remote,
            baseRef,
            headRef: row.headRef,
            headSha: row.headSha,
            command,
            timeLimitMinutes: settings.timeLimitMinutes,
            scratch: verifier.scratchPath,
            protectedRoots: roots,
          }),
        ),
      ),
    );
    if (ran._tag === "None") return false;
    const outcome = ran.value;
    const at = yield* nowIso;
    if (outcome._tag === "Passed") {
      yield* store.setVerification(target.projectId, row.number, {
        baseRef,
        baseSha: outcome.baseSha,
        headSha: row.headSha,
        verifiedSha: outcome.verifiedSha,
        at,
      });
      return true;
    }
    const failure = failureFor(outcome, {
      command,
      baseRef,
      headSha: row.headSha,
      timeLimitMinutes: settings.timeLimitMinutes,
      at,
    });
    if (failure === null) {
      // The head moved under the verification; the next read puts the new head in line.
      yield* store.touch(target.projectId);
      return false;
    }
    yield* landing.recordFailure(target, row, failure, true);
    return true;
  });

  /** Moves the project's queue one step; whether it moved. */
  const stepOnce = (projectId: ProjectId) =>
    Effect.gen(function* () {
      const target = yield* projects.target("houston.mergeQueue.run", projectId);
      if ((yield* projects.pausedReason(target)) !== null) return false;
      const view = yield* projects.view(target);
      if (view.context.refusal !== null && view.context.commandSet) return false;
      const settings = yield* store.settings(projectId);
      // A pushed head GitHub's checks failed on leaves the line before anything else moves.
      for (const [index, row] of view.rows.entries()) {
        const held = verificationHolds(row);
        const failing = row.facts === null ? [] : failingChecks(row.facts);
        if (
          view.entries[index]!.position > 0 &&
          held !== null &&
          held.verifiedSha !== held.headSha &&
          row.headSha === held.verifiedSha &&
          failing.length > 0
        ) {
          yield* landing.recordFailure(
            target,
            row,
            {
              kind: "checksFailed",
              message: `GitHub's checks failed on the verified commit ${shortSha(held.verifiedSha)} the queue pushed: ${failing.join(", ")}`,
              headSha: row.headSha,
              baseSha: held.baseSha,
              files: [],
              outputTail: null,
              notifiedThreadId: null,
              at: yield* nowIso,
            },
            true,
          );
          return true;
        }
      }
      const next = nextUp(view.entries);
      if (next === undefined) return false;
      const row = view.rows.find((candidate) => candidate.number === next.number)!;
      if (next.status === "waitingForSlot") return yield* verifyHead(target, row);
      if (
        next.status === "ready" &&
        settings.mergeWhenVerified &&
        settings.verificationCommand.trim().length > 0
      ) {
        const landed = yield* Effect.result(
          landing.land({ projectId, number: row.number, expectedHeadSha: null, unattended: true }),
        );
        if (landed._tag === "Success") return landed.success.outcome === "merged";
        yield* Effect.logWarning(
          `Merge queue: landing PR #${row.number}: ${landed.failure.message}`,
        );
        // A landing that recorded a failure took the entry out of line: the queue moves on.
        const after = (yield* store.rows(projectId)).find((value) => value.number === row.number);
        return after === undefined || failureHolds(after) !== null;
      }
      return false;
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning(`Merge queue step of ${projectId} failed.`, cause).pipe(Effect.as(false)),
      ),
    );

  const step = (projectId: ProjectId) => {
    let lock = projectLocks.get(projectId);
    if (lock === undefined) {
      lock = Semaphore.makeUnsafe(1);
      projectLocks.set(projectId, lock);
    }
    return lock.withPermits(1)(
      Effect.gen(function* () {
        for (let steps = 0; steps < STEPS_PER_PASS; steps += 1) {
          if (!(yield* stepOnce(projectId))) return;
        }
      }),
    );
  };

  const pass = passLock.withPermits(1)(
    Effect.gen(function* () {
      const ids = yield* store.projectsWithEntries;
      yield* Effect.forEach(ids, step, { concurrency: "unbounded", discard: true });
    }),
  );

  if (options.loops) {
    loops += 1;
    yield* Effect.forever(
      pass.pipe(Effect.andThen(Queue.take(store.wakes).pipe(Effect.timeoutOption(PASS_INTERVAL)))),
    ).pipe(Effect.forkScoped);
  }

  return HoustonMergeQueueRunner.of({ pass, step, loopsStarted: Effect.sync(() => loops) });
});

export const layer = (options: { readonly loops: boolean }) =>
  Layer.effect(HoustonMergeQueueRunner, makeRunner(options));
