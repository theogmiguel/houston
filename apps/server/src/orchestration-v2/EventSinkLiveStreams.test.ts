// Live event delivery per thread: what each subscriber's queue receives and in which order.
import { assert, describe, it } from "@effect/vitest";
import {
  EventId,
  type ModelSelection,
  type OrchestrationV2AppThread,
  type OrchestrationV2DomainEvent,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@houston-app/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import { vi } from "vite-plus/test";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as EventSink from "./EventSink.ts";
import * as EventStore from "./EventStore.ts";
import * as ProjectionStore from "./ProjectionStore.ts";

// Records the subscriptions the event sink opens and what the bounded reader takes from each, so
// a test can count every event that reached a subscriber's queue.
const opened = vi.hoisted(() => ({
  subscriptions: [] as Array<unknown>,
  taken: new Map<unknown, number>(),
}));
vi.mock("effect/PubSub", async (importOriginal) => {
  const original = await importOriginal<typeof import("effect/PubSub")>();
  const { sync, tap } = await import("effect/Effect");
  return {
    ...original,
    subscribe: <A>(pubsub: PubSub.PubSub<A>) =>
      original
        .subscribe(pubsub)
        .pipe(tap((subscription) => sync(() => opened.subscriptions.push(subscription)))),
    take: <A>(subscription: PubSub.Subscription<A>) =>
      original
        .take(subscription)
        .pipe(
          tap(() =>
            sync(() => opened.taken.set(subscription, (opened.taken.get(subscription) ?? 0) + 1)),
          ),
        ),
  };
});

const layerDatabase = SqlitePersistence.layerMemory;
const layerStores = Layer.mergeAll(
  layerDatabase,
  EventStore.layer.pipe(Layer.provideMerge(layerDatabase)),
  ProjectionStore.layer.pipe(Layer.provideMerge(layerDatabase)),
);
const layerTest = EventSink.layer.pipe(Layer.provideMerge(layerStores));

const providerInstanceId = ProviderInstanceId.make("codex");
const modelSelection = {
  instanceId: providerInstanceId,
  model: "gpt-5.4",
} satisfies ModelSelection;

const makeThread = (id: ThreadId, now: DateTime.Utc): OrchestrationV2AppThread => ({
  createdBy: "user",
  creationSource: "web",
  id,
  projectId: ProjectId.make(`project:${id}`),
  title: `Thread ${id}`,
  providerInstanceId,
  modelSelection,
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  activeProviderThreadId: null,
  lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: id },
  forkedFrom: null,
  createdAt: now,
  updatedAt: now,
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  lastVisitedAt: null,
  deletedAt: null,
});

const created = (
  thread: OrchestrationV2AppThread,
  now: DateTime.Utc,
): OrchestrationV2DomainEvent => ({
  id: EventId.make(`event:${thread.id}:created`),
  type: "thread.created",
  threadId: thread.id,
  providerInstanceId,
  occurredAt: now,
  payload: thread,
});

const updates = (
  thread: OrchestrationV2AppThread,
  now: DateTime.Utc,
  label: string,
  count: number,
): Array<OrchestrationV2DomainEvent> =>
  Array.from({ length: count }, (_, index) => ({
    id: EventId.make(`event:${thread.id}:${label}:${index}`),
    type: "thread.metadata-updated" as const,
    threadId: thread.id,
    occurredAt: now,
    payload: { ...thread, title: `${label} ${index}` },
  }));

const twoThreads = Effect.gen(function* () {
  const sink = yield* EventSink.EventSinkV2;
  const now = yield* DateTime.now;
  const a = makeThread(ThreadId.make("thread:a"), now);
  const b = makeThread(ThreadId.make("thread:b"), now);
  const written = yield* sink.write({
    events: [created(a, now), created(b, now), ...updates(b, now, "seed", 1)],
  });
  return { sink, now, a, b, afterSequence: written.at(-1)!.sequence };
});

describe("EventSink live streams per thread", () => {
  it.effect.each([
    ["a thread", {}],
    ["a thread and event type", { eventType: "thread.metadata-updated" as const }],
    ["a bounded thread", { bounded: true }],
  ] as const)("a subscriber on %s queues no events of another thread", ([, filter]) =>
    Effect.scoped(
      Effect.gen(function* () {
        const { sink, now, a, b } = yield* twoThreads;
        opened.subscriptions.length = 0;
        // The reader pulls until the replayed seed, then stops taking from its queue.
        const pull = yield* Stream.toPull(sink.stream({ threadId: b.id, ...filter }));
        const seed = EventId.make("event:thread:b:seed:0");
        while (!Array.from(yield* pull, (stored) => stored.event.id).includes(seed)) continue;
        assert.lengthOf(opened.subscriptions, 1);
        const queue = opened.subscriptions[0] as PubSub.Subscription<unknown>;

        yield* sink.write({ events: updates(a, now, "a", 20) });
        const reached = (yield* PubSub.remaining(queue)) + (opened.taken.get(queue) ?? 0);
        assert.strictEqual(reached, 0);
        const [mine] = yield* sink.write({ events: updates(b, now, "b", 1) });
        assert.deepStrictEqual(
          Array.from(yield* pull, (stored) => stored.sequence),
          [mine!.sequence],
        );
      }),
    ).pipe(Effect.provide(layerTest)),
  );

  it.effect("thread and unfiltered subscribers see every event of theirs in commit order", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { sink, now, a, b, afterSequence } = yield* twoThreads;
        const collect = (input: Parameters<EventSink.EventSinkV2Shape["stream"]>[0], n: number) =>
          sink.stream(input).pipe(Stream.take(n), Stream.runCollect, Effect.forkScoped);
        const all = yield* collect({ afterSequence }, 120);
        const onA = yield* collect({ threadId: a.id, afterSequence }, 60);
        const onB = yield* collect({ threadId: b.id, afterSequence, bounded: true }, 60);
        // Writers on both threads race; each write publishes in commit order.
        const writes = yield* Effect.forEach(
          Array.from({ length: 6 }, (_, round) => round),
          (round) =>
            sink.write({
              events: updates(round % 2 === 0 ? a : b, now, `r${round}`, 10),
            }),
          { concurrency: "unbounded" },
        ).pipe(Effect.map((batches) => batches.flat()));
        yield* sink.write({ events: updates(a, now, "tail-a", 30) });
        yield* sink.write({ events: updates(b, now, "tail-b", 30) });
        const committed = yield* sink
          .stream({ afterSequence })
          .pipe(Stream.take(120), Stream.runCollect);
        assert.lengthOf(writes, 60);

        const sequences = (events: Iterable<{ readonly sequence: number }>) =>
          Array.from(events, (stored) => stored.sequence);
        const ofThread = (id: ThreadId) =>
          sequences(committed.filter((stored) => stored.event.threadId === id));
        assert.deepStrictEqual(sequences(yield* Fiber.join(all)), sequences(committed));
        assert.deepStrictEqual(sequences(yield* Fiber.join(onA)), ofThread(a.id));
        assert.deepStrictEqual(sequences(yield* Fiber.join(onB)), ofThread(b.id));
      }),
    ).pipe(Effect.provide(layerTest)),
  );

  it.effect("a thread subscriber after an earlier one closed still receives live events", () =>
    Effect.gen(function* () {
      const { sink, now, a } = yield* twoThreads;
      // Each reader replays a marker before the live write, so it is subscribed when it lands.
      const readLive = (label: string) =>
        Effect.scoped(
          Effect.gen(function* () {
            const [marker] = yield* sink.write({ events: updates(a, now, `${label}-marker`, 1) });
            const pull = yield* Stream.toPull(
              sink.stream({ threadId: a.id, afterSequence: marker!.sequence - 1 }),
            );
            assert.deepStrictEqual(
              Array.from(yield* pull, (stored) => stored.sequence),
              [marker!.sequence],
            );
            const [live] = yield* sink.write({ events: updates(a, now, label, 1) });
            assert.deepStrictEqual(
              Array.from(yield* pull, (stored) => stored.sequence),
              [live!.sequence],
            );
          }),
        );
      yield* readLive("first");
      yield* readLive("second");
    }).pipe(Effect.provide(layerTest)),
  );
});
