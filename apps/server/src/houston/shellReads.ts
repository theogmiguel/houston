// Houston: the shell stream reads a thread's shell once per change for all of its subscribers, and
// not at all for a batch whose events cannot change that shell.
import type {
  OrchestrationV2DomainEvent,
  OrchestrationV2ThreadShell,
  ThreadId,
} from "@houston-app/contracts";
import type * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";

// What a thread event can change in its shell: `inert` events write only the thread's `updatedAt`
// and tables the shell never reads; an `item` event is inert once its item is counted.
export type ShellFootprint =
  | { readonly kind: "shell" }
  | { readonly kind: "inert"; readonly occurredAt: DateTime.Utc }
  | { readonly kind: "item"; readonly key: string; readonly occurredAt: DateTime.Utc };

const SHELL: ShellFootprint = { kind: "shell" };

export function shellEventFootprint(event: OrchestrationV2DomainEvent): ShellFootprint {
  switch (event.type) {
    case "node.updated":
    case "provider-turn.updated":
    case "run-attempt.created":
    case "run-attempt.updated":
      return { kind: "inert", occurredAt: event.occurredAt };
    case "message.updated":
      // The shell reads user messages only.
      return event.payload.role === "assistant"
        ? { kind: "inert", occurredAt: event.occurredAt }
        : SHELL;
    case "turn-item.updated":
      return (event.payload.type === "assistant_message" || event.payload.type === "reasoning") &&
        event.payload.threadId === event.threadId
        ? {
            kind: "item",
            key: `${event.payload.runId ?? ""}\u0000${event.payload.id}\u0000${event.payload.type}`,
            occurredAt: event.occurredAt,
          }
        : SHELL;
    default:
      return SHELL;
  }
}

/** The events of one thread in one shell batch. */
interface ThreadShellBatch {
  readonly inert: boolean;
  readonly itemKeys: ReadonlyArray<string>;
  /** When the batch's last event happened: the thread's `updatedAt` once it is applied. */
  readonly occurredAt: DateTime.Utc | undefined;
}

type ShellBatchEvent =
  | { readonly aggregateKind: unknown }
  | {
      readonly event: { readonly threadId: string };
      readonly footprint?: ShellFootprint;
    };

/** Groups a batch's thread events by thread; a replayed event carries its whole domain event. */
export function planShellBatch(
  events: ReadonlyArray<ShellBatchEvent>,
): ReadonlyMap<string, ThreadShellBatch> {
  const batches = new Map<string, ThreadShellBatch>();
  for (const stored of events) {
    if ("aggregateKind" in stored) continue;
    const footprint =
      stored.footprint ??
      ("type" in stored.event
        ? shellEventFootprint(stored.event as OrchestrationV2DomainEvent)
        : SHELL);
    const previous = batches.get(stored.event.threadId);
    batches.set(stored.event.threadId, {
      inert: (previous?.inert ?? true) && footprint.kind !== "shell",
      itemKeys:
        footprint.kind === "item"
          ? [...(previous?.itemKeys ?? []), footprint.key]
          : (previous?.itemKeys ?? []),
      occurredAt: footprint.kind === "shell" ? undefined : footprint.occurredAt,
    });
  }
  return batches;
}

type Shell = OrchestrationV2ThreadShell | null;

interface SharedRead {
  /** The read started after this sequence was committed, so it covers every event up to it. */
  readonly sequence: number;
  readonly result: Deferred.Deferred<Exit.Exit<Shell, unknown>>;
}

// Keyed by the reading service, so each server (and each test runtime) shares only its own reads.
const sharedReadsByOwner = new WeakMap<object, Map<string, SharedRead>>();

// Bounds the threads remembered; a forgotten thread only costs one more read.
const SHARED_READS_LIMIT = 256;
const KNOWN_ITEMS_LIMIT = 512;

function readShared<E>(
  reads: Map<string, SharedRead>,
  getThreadShell: (threadId: ThreadId) => Effect.Effect<Shell, E>,
  threadId: ThreadId,
  sequence: number,
): Effect.Effect<Shell, E> {
  return Effect.uninterruptibleMask((restore) =>
    Effect.suspend(() => {
      const existing = reads.get(threadId);
      if (existing !== undefined && existing.sequence >= sequence) {
        // A read that failed or was interrupted is retried by each waiter on its own.
        return restore(Deferred.await(existing.result)).pipe(
          Effect.flatMap((exit) =>
            Exit.isSuccess(exit)
              ? Effect.succeed(exit.value)
              : readShared(reads, getThreadShell, threadId, sequence),
          ),
        );
      }
      const entry: SharedRead = { sequence, result: Deferred.makeUnsafe() };
      reads.delete(threadId);
      reads.set(threadId, entry);
      if (reads.size > SHARED_READS_LIMIT) reads.delete(reads.keys().next().value!);
      return restore(getThreadShell(threadId)).pipe(
        Effect.onExit((exit) =>
          Effect.suspend(() => {
            if (Exit.isFailure(exit) && reads.get(threadId) === entry) reads.delete(threadId);
            return Deferred.succeed(entry.result, exit);
          }),
        ),
      );
    }),
  );
}

// One subscriber's shell reads. An inert batch keeps the last shell with the batch's `updatedAt`;
// other reads are shared by subscribers reading that thread at the same or an earlier sequence.
export function makeSubscriberShellReads<E>(
  owner: object,
  getThreadShell: (threadId: ThreadId) => Effect.Effect<Shell, E>,
) {
  let reads = sharedReadsByOwner.get(owner);
  if (reads === undefined) {
    reads = new Map();
    sharedReadsByOwner.set(owner, reads);
  }
  const shared = reads;
  const last = new Map<string, { readonly shell: Shell; readonly items: Set<string> }>();
  return (
    threadId: ThreadId,
    sequence: number,
    batch: ThreadShellBatch | undefined,
  ): Effect.Effect<Shell, E> =>
    Effect.gen(function* () {
      const prior = last.get(threadId);
      const reuse =
        prior !== undefined &&
        batch !== undefined &&
        batch.inert &&
        batch.occurredAt !== undefined &&
        batch.itemKeys.every((key) => prior.items.has(key));
      const shell =
        reuse && batch.occurredAt !== undefined
          ? prior.shell === null
            ? null
            : { ...prior.shell, updatedAt: batch.occurredAt }
          : yield* readShared(shared, getThreadShell, threadId, sequence);
      const items =
        prior === undefined || prior.items.size >= KNOWN_ITEMS_LIMIT
          ? new Set<string>()
          : prior.items;
      for (const key of batch?.itemKeys ?? []) items.add(key);
      last.set(threadId, { shell, items });
      return shell;
    });
}
