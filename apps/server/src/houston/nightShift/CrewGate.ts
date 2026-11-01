// The crew gate: what a thread of a live Night shift run may start, and the run's record of the
// threads it started. Upstream's delegation and launch tools and Houston's task and merge queue
// tools ask it first; outside every live run, and by default, it admits everything unchanged.
import {
  OrchestratorMcpFailure,
  type OrchestratorMcpTarget,
  type OrchestratorMcpTaskRole,
  ProviderInstanceId,
  type ThreadId,
} from "@t3tools/contracts";
import type { NightCrewRole } from "@t3tools/contracts/houston/nightShift";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";

import type { McpInvocationScope } from "../../mcp/McpInvocationContext.ts";
import { NightShiftProviders } from "./Host.ts";
import {
  crewCapRefusal,
  isolationRefusal,
  substituteInstance,
  type InstanceState,
} from "./rules.ts";
import { HoustonNightShiftStore, type NightGateRefusal, type StoredRun } from "./Store.ts";
import { messageId, NightShiftThreads } from "./Threads.ts";

export type GatedOperation =
  | "delegate_task"
  | "create_threads"
  | "t3_thread_launch"
  | "schedule_task"
  | "delete_scheduled_task"
  | "t3_environment_link"
  | "houston_task_execute"
  | "houston_merge_queue_enqueue"
  | "houston_merge_queue_dequeue"
  | "t3_thread_send"
  | "run_scheduled_task_now"
  | "houston_task_review";

export const STARTS_ONLY_THROUGH_DELEGATION =
  "a Night shift run starts work only through delegate_task";
export const NIGHT_SHIFT_ENQUEUES = "Night shift enqueues its pull requests itself";

const TERMINAL_TASK_STATUSES: ReadonlySet<string> = new Set([
  "completed",
  "failed",
  "cancelled",
  "interrupted",
]);

export interface Delegation {
  readonly role: OrchestratorMcpTaskRole | undefined;
  readonly isolation: "shared" | "worktree" | undefined;
  readonly target: OrchestratorMcpTarget | undefined;
}

export interface DispatchedChild {
  readonly taskId: string;
  readonly childThreadId: ThreadId | null;
  readonly providerInstanceId: string;
}

export interface Admission {
  /** The delegation's target, with the instance replaced when the requested one is unusable. */
  readonly target: OrchestratorMcpTarget | undefined;
  /** Records the dispatched child in the run's crew; nothing outside a run. */
  readonly record: (child: DispatchedChild) => Effect.Effect<void>;
  /** Frees the cap slot the admission held; safe to run more than once. */
  readonly release: Effect.Effect<void>;
}

export interface ReviewAdmission {
  /** Records the review thread in the run's crew; nothing outside a run. */
  readonly record: (threadId: ThreadId) => Effect.Effect<void>;
  /** Frees the review slot the admission held; safe to run more than once. */
  readonly release: Effect.Effect<void>;
}

export interface CrewGateShape {
  /** Admits an operation of `callerThreadId`, or fails with the refusal, without its prefix. */
  readonly admit: (input: {
    readonly callerThreadId: ThreadId;
    readonly operation: GatedOperation;
    readonly delegation?: Delegation | undefined;
    /** `t3_thread_send`'s target thread. */
    readonly targetThreadId?: ThreadId | undefined;
  }) => Effect.Effect<Admission, string>;
  /** Admits the automatic review a handback of `callerThreadId`'s task run starts. */
  readonly review: (input: {
    readonly callerThreadId: ThreadId;
    readonly providerInstanceId: string;
  }) => Effect.Effect<ReviewAdmission, string>;
  /** Ends the crew members of a run whose delegated task or review thread has ended. */
  readonly refresh: (runId: number) => Effect.Effect<void>;
}

const admitted = (target: OrchestratorMcpTarget | undefined): Admission => ({
  target,
  record: () => Effect.void,
  release: Effect.void,
});

/** Admits everything unchanged: upstream's tests and a server without Night shift. */
export const allowAll: CrewGateShape = {
  admit: (input) => Effect.succeed(admitted(input.delegation?.target)),
  review: () => Effect.succeed({ record: () => Effect.void, release: Effect.void }),
  refresh: () => Effect.void,
};

export const HoustonCrewGate = Context.Reference<CrewGateShape>(
  "houston/houston/nightShift/CrewGate/HoustonCrewGate",
  { defaultValue: () => allowAll },
);

/** How a gate refusal reaches an agent through upstream's tools. */
export const crewGateFailure = (message: string) =>
  new OrchestratorMcpFailure({ code: "invalid_request", message: `Night shift: ${message}` });

/** Admits a non-delegating operation of the scope's thread; a non-thread client is not gated. */
export const admitOperation = Effect.fn("HoustonCrewGate.admitOperation")(function* (
  scope: McpInvocationScope,
  operation: GatedOperation,
) {
  const threadId = scope.thread?.threadId;
  if (threadId === undefined) return;
  const gate = yield* HoustonCrewGate;
  yield* gate.admit({ callerThreadId: threadId, operation });
});

const iso = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));

interface Reservation {
  readonly id: number;
  readonly role: NightCrewRole;
}

const make = Effect.gen(function* () {
  const store = yield* HoustonNightShiftStore;
  const providers = yield* NightShiftProviders;
  const threads = yield* NightShiftThreads;
  // One admission at a time, so two delegations cannot both take a run's last slot.
  const lock = yield* Semaphore.make(1);
  // Slots admitted but not yet recorded or released, per run; each holds one cap slot.
  const reservations = yield* Ref.make<ReadonlyMap<number, ReadonlyArray<Reservation>>>(new Map());
  let nextReservation = 0;

  /** Fails with `message` after counting the refusal on the run, for the morning report. */
  const refuse = (runId: number, reason: NightGateRefusal, message: string) =>
    store.countRefusal(runId, reason).pipe(Effect.andThen(Effect.fail(message)));

  const unreserve = (runId: number, id: number) =>
    Ref.update(reservations, (current) => {
      const next = new Map(current);
      const kept = (current.get(runId) ?? []).filter((reservation) => reservation.id !== id);
      if (kept.length === 0) next.delete(runId);
      else next.set(runId, kept);
      return next;
    });

  /** Holds one cap slot of `role` in `runId` until recorded or released. */
  const reserve = Effect.fn("HoustonCrewGate.reserve")(function* (
    runId: number,
    role: NightCrewRole,
  ) {
    nextReservation += 1;
    const id = nextReservation;
    yield* Ref.update(reservations, (current) =>
      new Map(current).set(runId, [...(current.get(runId) ?? []), { id, role }]),
    );
    return unreserve(runId, id);
  });

  const refresh: CrewGateShape["refresh"] = Effect.fn("HoustonCrewGate.refresh")(function* (runId) {
    const crew = yield* store.crew(runId);
    for (const member of crew) {
      if (member.role === "orchestrator" || member.endedAt !== null) continue;
      let ended = false;
      if (member.taskId === null) {
        // A review a handback started has no delegated task: it ends with its thread's run.
        const state = yield* threads.state(member.threadId);
        ended = !state.present || (!state.activeRun && state.lastRunStatus !== null);
      } else if (member.parentThreadId !== null) {
        const status = yield* threads.taskStatus(member.parentThreadId, member.taskId);
        ended = status !== null && TERMINAL_TASK_STATUSES.has(status);
      }
      if (ended) yield* store.endCrew(runId, member.threadId, iso(yield* Clock.currentTimeMillis));
    }
  });

  /** The roles holding a cap slot of the run: live members and reservations. */
  const slots = Effect.fn("HoustonCrewGate.slots")(function* (runId: number) {
    yield* refresh(runId);
    const live = (yield* store.crew(runId))
      .filter((member) => member.role !== "orchestrator" && member.endedAt === null)
      .map((member) => member.role);
    const reserved = ((yield* Ref.get(reservations)).get(runId) ?? []).map(
      (reservation) => reservation.role,
    );
    return [...live, ...reserved];
  });

  const instanceStates = Effect.fn("HoustonCrewGate.instanceStates")(function* (run: StoredRun) {
    const listed = yield* providers.list;
    const limited = new Set(
      run.limited.filter((limit) => limit.clearedAt === null).map((limit) => limit.instanceId),
    );
    const states = new Map<string, InstanceState>();
    for (const provider of listed) {
      states.set(provider.instanceId, {
        instanceId: provider.instanceId,
        state: provider.readiness?.state ?? "unknown",
        limited: limited.has(provider.instanceId),
      });
    }
    return { listed, states };
  });

  const delegate = Effect.fn("HoustonCrewGate.delegate")(function* (
    run: StoredRun,
    caller: { readonly threadId: ThreadId; readonly providerInstanceId: string },
    delegation: Delegation,
  ) {
    const role: NightCrewRole = delegation.role ?? "general";
    const isolation = isolationRefusal({
      role,
      isolation: delegation.isolation,
      environmentId: delegation.target?.environmentId,
    });
    if (isolation !== null) return yield* refuse(run.id, "isolation", isolation);

    const cap = crewCapRefusal({
      live: yield* slots(run.id),
      role,
      liveWorkers: run.settings.liveWorkers,
    });
    if (cap !== null) return yield* refuse(run.id, "crewCap", cap);

    const { listed, states } = yield* instanceStates(run);
    const target = delegation.target;
    const requested =
      target?.providerInstanceId ??
      (target?.driverKind === undefined
        ? caller.providerInstanceId
        : (listed.find((provider) => provider.driver === target.driverKind)?.instanceId ??
          caller.providerInstanceId));
    const chain = run.settings.workers.map((worker) => worker.instanceId as string);
    // Crew work stays on the providers the user listed, so it leaves the machine only to them.
    if (!chain.includes(requested)) {
      return yield* refuse(
        run.id,
        "workersChain",
        `${requested} is not in the workers chain (${chain.join(", ")}); target one of those instances`,
      );
    }
    const chosen = substituteInstance({ requested, chain, states });
    if ("refusal" in chosen) {
      return yield* refuse(run.id, "noReadyInstance", chosen.refusal);
    }

    let admittedTarget = target;
    if (chosen.instanceId !== requested) {
      const selection = run.settings.workers.find(
        (worker) => worker.instanceId === chosen.instanceId,
      );
      admittedTarget = {
        providerInstanceId: ProviderInstanceId.make(chosen.instanceId),
        ...(selection === undefined ? {} : { model: selection.model }),
      };
      const state = states.get(requested);
      const why =
        state === undefined ? "missing" : state.limited ? `limited (${state.state})` : state.state;
      if (run.orchestratorThreadId !== null) {
        yield* threads
          .notify({
            threadId: run.orchestratorThreadId,
            messageId: messageId(run.id, "substituted", requested),
            text: `Night shift: ${requested} is ${why}, so delegations to it run on ${chosen.instanceId} until it is ready again.`,
          })
          .pipe(Effect.ignore);
      }
    }

    const release = yield* reserve(run.id, role);
    const record = Effect.fn("HoustonCrewGate.record")(function* (child: DispatchedChild) {
      if (child.childThreadId === null) return;
      const workspace = yield* threads.workspace(child.childThreadId);
      yield* store.addCrew({
        runId: run.id,
        threadId: child.childThreadId,
        taskId: child.taskId,
        parentThreadId: caller.threadId,
        role,
        providerInstanceId: child.providerInstanceId,
        requestedInstanceId: requested,
        worktreePath: workspace.worktreePath,
        branch: workspace.branch,
        startedAt: iso(yield* Clock.currentTimeMillis),
        endedAt: null,
      });
    }, Effect.ensuring(release));
    return { target: admittedTarget, record, release } satisfies Admission;
  });

  const sendTo = Effect.fn("HoustonCrewGate.sendTo")(function* (
    run: StoredRun,
    target: ThreadId | undefined,
  ) {
    yield* refresh(run.id);
    const member = (yield* store.crew(run.id)).find(
      (candidate) => candidate.threadId === target && candidate.role !== "orchestrator",
    );
    if (member === undefined) {
      return yield* refuse(
        run.id,
        "threadSend",
        `t3_thread_send to ${target} is refused: it is not a live crew thread of run ${run.id}; send only to threads this run delegated`,
      );
    }
    if (member.endedAt !== null) {
      return yield* refuse(
        run.id,
        "threadSend",
        `t3_thread_send to ${target} is refused: its task has ended; start new work with delegate_task`,
      );
    }
    return admitted(undefined);
  });

  const review: CrewGateShape["review"] = Effect.fn("HoustonCrewGate.review")(function* (input) {
    const membership = yield* store.liveCrewOf(input.callerThreadId);
    if (membership === undefined) return { record: () => Effect.void, release: Effect.void };
    const { run } = membership;
    return yield* lock.withPermits(1)(
      Effect.gen(function* () {
        const cap = crewCapRefusal({
          live: yield* slots(run.id),
          role: "review",
          liveWorkers: run.settings.liveWorkers,
        });
        if (cap !== null) {
          return yield* refuse(
            run.id,
            "reviewCap",
            `the automatic review of a handback is refused: ${cap}`,
          );
        }
        const release = yield* reserve(run.id, "review");
        const record = Effect.fn("HoustonCrewGate.recordReview")(function* (threadId: ThreadId) {
          const workspace = yield* threads.workspace(threadId);
          yield* store.addCrew({
            runId: run.id,
            threadId,
            taskId: null,
            parentThreadId: input.callerThreadId,
            role: "review",
            providerInstanceId: input.providerInstanceId,
            requestedInstanceId: input.providerInstanceId,
            worktreePath: workspace.worktreePath,
            branch: workspace.branch,
            startedAt: iso(yield* Clock.currentTimeMillis),
            endedAt: null,
          });
        }, Effect.ensuring(release));
        return { record, release } satisfies ReviewAdmission;
      }),
    );
  });

  const admit: CrewGateShape["admit"] = Effect.fn("HoustonCrewGate.admit")(function* (input) {
    const membership = yield* store.liveCrewOf(input.callerThreadId);
    if (membership === undefined) return admitted(input.delegation?.target);
    if (input.operation === "t3_thread_send") {
      return yield* lock.withPermits(1)(sendTo(membership.run, input.targetThreadId));
    }
    if (
      input.operation === "houston_merge_queue_enqueue" ||
      input.operation === "houston_merge_queue_dequeue"
    ) {
      return yield* refuse(
        membership.run.id,
        "mergeQueue",
        `${input.operation} is refused: ${NIGHT_SHIFT_ENQUEUES}`,
      );
    }
    if (input.operation !== "delegate_task") {
      return yield* refuse(
        membership.run.id,
        "operation",
        `${input.operation} is refused: ${STARTS_ONLY_THROUGH_DELEGATION}`,
      );
    }
    const delegation = input.delegation ?? {
      role: undefined,
      isolation: undefined,
      target: undefined,
    };
    return yield* lock.withPermits(1)(delegate(membership.run, membership.member, delegation));
  });

  return { admit, review, refresh } satisfies CrewGateShape;
});

/** The gate over the Night shift store, readiness and threads; one per server. */
export const layer = Layer.effect(HoustonCrewGate, make);
