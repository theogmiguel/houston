import type { ThreadId } from "@houston-app/contracts";
import type {
  InferenceGatewayQueue,
  InferenceRequestPurpose,
  InferenceServerId,
} from "@houston-app/contracts/houston/inference";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";

import * as Settings from "../../serverSettings.ts";
import * as InferenceServerRegistry from "./InferenceServerRegistry.ts";

/** Scheduled and background requests waiting this long rank with interactive ones, so none starve. */
export const AGING_MS = 30_000;
/** Per server; past this the gateway refuses instead of queueing. */
export const MAX_WAITING = 64;
/** Local generations can run for minutes, so the wait bound is generous. */
export const MAX_WAIT_MS = 10 * 60_000;

export class InferenceAdmissionError extends Schema.TaggedError<InferenceAdmissionError>()(
  "InferenceAdmissionError",
  {
    reason: Schema.Literals(["queue_full", "timed_out"]),
    message: Schema.String,
  },
) {}

export interface AdmissionTicket {
  readonly serverId: InferenceServerId;
  readonly purpose: InferenceRequestPurpose;
  readonly threadId?: ThreadId | undefined;
}

export class InferenceAdmission extends Context.Service<
  InferenceAdmission,
  {
    /** Waits for a generation slot on the ticket's server; the slot is held until the scope closes. */
    readonly admit: (
      ticket: AdmissionTicket,
    ) => Effect.Effect<void, InferenceAdmissionError, Scope.Scope>;
  }
>()("@houston-app/cli/houston/inference/InferenceAdmission") {}

interface Entry {
  readonly seq: number;
  readonly ticket: AdmissionTicket;
  readonly enqueuedAt: number;
  readonly granted: Deferred.Deferred<void>;
}

interface ServerQueue {
  readonly active: ReadonlyArray<Entry>;
  readonly waiting: ReadonlyArray<Entry>;
}

const RANK: Record<InferenceRequestPurpose, number> = {
  interactive: 0,
  scheduled: 1,
  background: 2,
};

const orderWaiting = (waiting: ReadonlyArray<Entry>, now: number): ReadonlyArray<Entry> => {
  const rank = (entry: Entry) =>
    now - entry.enqueuedAt >= AGING_MS ? RANK.interactive : RANK[entry.ticket.purpose];
  return waiting.toSorted((a, b) => rank(a) - rank(b) || a.seq - b.seq);
};

/** Moves waiters into free slots, best first; returns the new queue and whom to wake. */
const dispatch = (queue: ServerQueue, capacity: number, now: number) => {
  const ordered = orderWaiting(queue.waiting, now);
  const free = Math.max(0, capacity - queue.active.length);
  const granted = ordered.slice(0, free);
  return {
    queue: { active: [...queue.active, ...granted], waiting: ordered.slice(free) },
    granted,
  };
};

const toSnapshot = (capacity: number, queue: ServerQueue, now: number): InferenceGatewayQueue => ({
  capacity,
  active: queue.active.map(({ ticket }) => ({
    ...(ticket.threadId === undefined ? {} : { threadId: ticket.threadId }),
    purpose: ticket.purpose,
  })),
  waiting: orderWaiting(queue.waiting, now).map(({ ticket }, index) => ({
    ...(ticket.threadId === undefined ? {} : { threadId: ticket.threadId }),
    purpose: ticket.purpose,
    position: index + 1,
  })),
});

export interface InferenceAdmissionOptions {
  readonly capacity: (serverId: InferenceServerId) => Effect.Effect<number>;
  readonly publish: (
    serverId: InferenceServerId,
    queue: InferenceGatewayQueue,
  ) => Effect.Effect<void>;
}

const makeWithOptions = Effect.fn("InferenceAdmission.make")(function* (
  options: InferenceAdmissionOptions,
) {
  const queues = yield* Ref.make(new Map<InferenceServerId, ServerQueue>());
  const nextSeq = yield* Ref.make(0);

  /** Applies `change`, fills free slots, wakes whoever got one, and publishes the result. */
  const update = Effect.fn("InferenceAdmission.update")(function* (
    serverId: InferenceServerId,
    change: (queue: ServerQueue) => ServerQueue,
  ) {
    const capacity = yield* options.capacity(serverId);
    const now = yield* Clock.currentTimeMillis;
    const { granted, queue } = yield* Ref.modify(queues, (all) => {
      const result = dispatch(
        change(all.get(serverId) ?? { active: [], waiting: [] }),
        capacity,
        now,
      );
      return [result, new Map(all).set(serverId, result.queue)] as const;
    });
    yield* Effect.forEach(granted, (entry) => Deferred.succeed(entry.granted, undefined), {
      discard: true,
    });
    yield* options.publish(serverId, toSnapshot(capacity, queue, now));
  });

  const remove = (entry: Entry) =>
    update(entry.ticket.serverId, (queue) => ({
      active: queue.active.filter((candidate) => candidate !== entry),
      waiting: queue.waiting.filter((candidate) => candidate !== entry),
    }));

  const admit = Effect.fn("InferenceAdmission.admit")(function* (ticket: AdmissionTicket) {
    const entry = yield* Effect.acquireRelease(
      Effect.gen(function* () {
        const seq = yield* Ref.getAndUpdate(nextSeq, (value) => value + 1);
        const queued: Entry = {
          seq,
          ticket,
          enqueuedAt: yield* Clock.currentTimeMillis,
          granted: yield* Deferred.make<void>(),
        };
        const full = yield* Ref.get(queues).pipe(
          Effect.map((all) => (all.get(ticket.serverId)?.waiting.length ?? 0) >= MAX_WAITING),
        );
        if (full) return undefined;
        yield* update(ticket.serverId, (queue) => ({
          ...queue,
          waiting: [...queue.waiting, queued],
        }));
        return queued;
      }),
      (queued) => (queued === undefined ? Effect.void : remove(queued)),
    );
    if (entry === undefined) {
      return yield* new InferenceAdmissionError({
        reason: "queue_full",
        message: `${MAX_WAITING} requests are already waiting for this inference server.`,
      });
    }
    yield* Deferred.await(entry.granted).pipe(
      Effect.timeoutOrElse({
        duration: Duration.millis(MAX_WAIT_MS),
        orElse: () =>
          remove(entry).pipe(
            Effect.andThen(
              Effect.fail(
                new InferenceAdmissionError({
                  reason: "timed_out",
                  message: "No inference slot freed up within 10 minutes.",
                }),
              ),
            ),
          ),
      }),
    );
  });

  return InferenceAdmission.of({ admit });
});

/**
 * Capacity is the configured max, else what the probe verified for the engine, else 1.
 * Queue state rides on the server's snapshot.
 */
export const layer = Layer.effect(
  InferenceAdmission,
  Effect.gen(function* () {
    const settings = yield* Settings.ServerSettingsService;
    const registry = yield* InferenceServerRegistry.InferenceServerRegistry;
    return yield* makeWithOptions({
      capacity: Effect.fn("InferenceAdmission.capacity")(function* (serverId) {
        const configured = yield* settings.getSettings.pipe(
          Effect.map((current) => current.inferenceServers[serverId]?.maxConcurrentRequests),
          Effect.orElseSucceed(() => undefined),
        );
        if (configured !== undefined) return configured;
        const snapshot = (yield* registry.current).find((candidate) => candidate.id === serverId);
        return snapshot?.maxConcurrentRequests ?? 1;
      }),
      publish: registry.publishGatewayQueue,
    });
  }),
);

export const __testing = { make: makeWithOptions };
