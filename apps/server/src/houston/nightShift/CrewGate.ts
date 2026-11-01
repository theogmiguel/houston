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
import { HoustonNightShiftStore, type StoredRun } from "./Store.ts";
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
  | "houston_merge_queue_dequeue";

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

export interface CrewGateShape {
  /** Admits an operation of `callerThreadId`, or fails with the refusal, without its prefix. */
  readonly admit: (input: {
    readonly callerThreadId: ThreadId;
    readonly operation: GatedOperation;
    readonly delegation?: Delegation | undefined;
  }) => Effect.Effect<Admission, string>;
  /** Ends the crew members of a run whose delegated task reached a terminal status. */
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

  const unreserve = (runId: number, id: number) =>
    Ref.update(reservations, (current) => {
      const next = new Map(current);
      const kept = (current.get(runId) ?? []).filter((reservation) => reservation.id !== id);
      if (kept.length === 0) next.delete(runId);
      else next.set(runId, kept);
      return next;
    });

  const refresh: CrewGateShape["refresh"] = Effect.fn("HoustonCrewGate.refresh")(function* (runId) {
    const crew = yield* store.crew(runId);
    for (const member of crew) {
      if (
        member.role === "orchestrator" ||
        member.endedAt !== null ||
        member.taskId === null ||
        member.parentThreadId === null
      )
        continue;
      const status = yield* threads.taskStatus(member.parentThreadId, member.taskId);
      if (status !== null && TERMINAL_TASK_STATUSES.has(status)) {
        yield* store.endCrew(runId, member.threadId, iso(yield* Clock.currentTimeMillis));
      }
    }
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
    if (isolation !== null) return yield* Effect.fail(isolation);

    yield* refresh(run.id);
    const live = (yield* store.crew(run.id))
      .filter((member) => member.role !== "orchestrator" && member.endedAt === null)
      .map((member) => member.role);
    const reserved = ((yield* Ref.get(reservations)).get(run.id) ?? []).map(
      (reservation) => reservation.role,
    );
    const cap = crewCapRefusal({
      live: [...live, ...reserved],
      role,
      liveWorkers: run.settings.liveWorkers,
    });
    if (cap !== null) return yield* Effect.fail(cap);

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
      return yield* Effect.fail(
        `${requested} is not in the workers chain (${chain.join(", ")}); target one of those instances`,
      );
    }
    const chosen = substituteInstance({ requested, chain, states });
    if ("refusal" in chosen) return yield* Effect.fail(chosen.refusal);

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

    nextReservation += 1;
    const id = nextReservation;
    yield* Ref.update(reservations, (current) =>
      new Map(current).set(run.id, [...(current.get(run.id) ?? []), { id, role }]),
    );
    const release = unreserve(run.id, id);
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

  const admit: CrewGateShape["admit"] = Effect.fn("HoustonCrewGate.admit")(function* (input) {
    const membership = yield* store.liveCrewOf(input.callerThreadId);
    if (membership === undefined) return admitted(input.delegation?.target);
    if (
      input.operation === "houston_merge_queue_enqueue" ||
      input.operation === "houston_merge_queue_dequeue"
    ) {
      return yield* Effect.fail(`${input.operation} is refused: ${NIGHT_SHIFT_ENQUEUES}`);
    }
    if (input.operation !== "delegate_task") {
      return yield* Effect.fail(`${input.operation} is refused: ${STARTS_ONLY_THROUGH_DELEGATION}`);
    }
    const delegation = input.delegation ?? {
      role: undefined,
      isolation: undefined,
      target: undefined,
    };
    return yield* lock.withPermits(1)(delegate(membership.run, membership.member, delegation));
  });

  return { admit, refresh } satisfies CrewGateShape;
});

/** The gate over the Night shift store, readiness and threads; one per server. */
export const layer = Layer.effect(HoustonCrewGate, make);
