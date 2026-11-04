// A live thread event is serialized for the live-stream budget once, however many clients follow
// the thread; checked by writing a replayed Claude turn through the event sink.
import { assert, describe, it, vi } from "@effect/vitest";
import type { OrchestrationV2DomainEvent, ThreadId } from "@houston-app/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as OrchestrationEventStore from "../persistence/OrchestrationEventStore.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as EventStore from "../orchestration-v2/EventStore.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import { subscribeOrchestrationV2Thread } from "../ws.ts";
import { replayedTurnEvents } from "./shellReads.testkit.ts";

const layerSink = () => {
  const database = SqlitePersistence.layerMemory;
  const stores = Layer.mergeAll(
    database,
    EventStore.layer.pipe(Layer.provideMerge(database)),
    ProjectionStore.layer.pipe(Layer.provideMerge(database)),
  );
  return Layer.fresh(EventSink.layer.pipe(Layer.provide(stores)));
};

/** JSON.stringify calls while `count` clients follow the thread through the rest of the turn. */
const stringifiesWhileFollowing = (
  events: ReadonlyArray<OrchestrationV2DomainEvent>,
  count: number,
) =>
  Effect.gen(function* () {
    const sink = yield* EventSink.EventSinkV2;
    const [first, ...rest] = events;
    const threadId: ThreadId = first!.threadId;
    const [created] = yield* sink.write({ events: [first!] });
    const management = {
      ensureLegacyTranscript: () => Effect.void,
      streamStoredEventsFrom: (input: Parameters<typeof sink.stream>[0]) =>
        sink.stream({ ...input, bounded: true }),
    } as unknown as ThreadManagement.ThreadManagementService["Service"];
    const eventStore = {
      latestAgentSequence: () => Effect.succeed(created!.sequence),
      getAgentReplayStats: () =>
        Effect.succeed({ eventCount: 0, rawPayloadBytes: 0, hasCreateEvent: false }),
      readAgentEvents: () => Stream.empty,
    } as unknown as OrchestrationEventStore.OrchestrationEventStore["Service"];

    const outputs = yield* Effect.forEach(Array.from({ length: count }), () =>
      Effect.gen(function* () {
        const output = yield* Queue.unbounded<{ readonly sequence?: number }>();
        const stream = yield* subscribeOrchestrationV2Thread({
          threadId,
          afterSequence: created!.sequence,
        });
        yield* stream.pipe(
          Stream.runForEach((item) => Queue.offer(output, item as { readonly sequence?: number })),
          Effect.forkScoped,
        );
        return output;
      }),
    ).pipe(
      Effect.provideService(ThreadManagement.ThreadManagementService, management),
      Effect.provideService(OrchestrationEventStore.OrchestrationEventStore, eventStore),
    );
    yield* TestClock.adjust("50 millis");

    const stringify = vi.spyOn(JSON, "stringify");
    try {
      for (const event of rest.filter((event) => event.threadId === threadId)) {
        const [stored] = yield* sink.write({ events: [event] });
        yield* TestClock.adjust("50 millis");
        for (const output of outputs) {
          for (;;) {
            const item = yield* Queue.take(output);
            if (item.sequence === stored!.sequence) break;
          }
        }
      }
      return stringify.mock.calls.length;
    } finally {
      stringify.mockRestore();
    }
  }).pipe(Effect.provide(layerSink()), Effect.scoped);

describe("live thread events", () => {
  it.effect("are serialized for the live budget once for all followers", () =>
    Effect.gen(function* () {
      const events = yield* replayedTurnEvents;
      const one = yield* stringifiesWhileFollowing(events, 1);
      const three = yield* stringifiesWhileFollowing(events, 3);
      assert.equal(three, one);
    }),
  );
});
