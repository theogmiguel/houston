// The `/ws` shell stream over a replayed Claude turn: what each subscriber receives, how many shell
// reads it costs, and how many bytes of thread shells it sends.
import { assert, describe, it } from "@effect/vitest";
import {
  type OrchestrationV2DomainEvent,
  OrchestrationV2ShellStreamItem,
  ThreadId,
} from "@houston-app/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as OrchestrationEventStore from "../persistence/OrchestrationEventStore.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectEnrichment from "../project/ProjectEnrichmentService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import {
  shellStreamItemFromThreadShell,
  skipUnchangedThreadShells,
} from "../orchestration-v2/ShellStream.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import { subscribeOrchestrationV2Shell } from "../ws.ts";
import { makeSubscriberShellReads } from "./shellReads.ts";
import { replayedTurnEvents } from "./shellReads.testkit.ts";

const encodeItem = Schema.encodeSync(Schema.toCodecJson(OrchestrationV2ShellStreamItem));
const wire = (item: OrchestrationV2ShellStreamItem) => JSON.stringify(encodeItem(item));

interface ShellRun {
  readonly reads: number;
  readonly threadBatches: number;
  /** What each subscriber received after its initial snapshot, as wire JSON. */
  readonly received: ReadonlyArray<ReadonlyArray<string>>;
  /** What the shell stream sent before shell reads were shared: a fresh read per batch. */
  readonly expected: ReadonlyArray<string>;
}

const SENTINEL_PROJECT = "project:shell-reads-sentinel";

interface ShellRunOptions {
  /** A lagging subscriber: every event is applied before the first batch reaches it. */
  readonly applyFirst?: boolean;
  readonly cadence?: Duration.Input;
}

// Applies each event to a fresh projection and delivers it to every subscriber as its own 50 ms
// batch, the cadence of a streaming turn. A project removal after each event marks the batch end.
const runShellSubscribers = (
  events: ReadonlyArray<OrchestrationV2DomainEvent>,
  count: number,
  options: ShellRunOptions = {},
) =>
  Effect.gen(function* () {
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    if (options.applyFirst) {
      for (const event of events) yield* projections.apply(event);
    }
    let reads = 0;
    const live = yield* Effect.forEach(Array.from({ length: count }), () =>
      Queue.unbounded<unknown>(),
    );
    let subscribed = 0;
    const management = {
      getThreadShell: (threadId: ThreadId) =>
        Effect.suspend(() => {
          reads += 1;
          return projections.getThreadShell(threadId);
        }),
      listActiveShellIndex: projections.listActiveShellIndex,
      readShellSnapshot: projections.readShellSnapshot,
      listActiveSubagentThreadIds: projections.listActiveSubagentThreadIds,
    } as unknown as ThreadManagement.ThreadManagementService["Service"];
    const eventStore = {
      latestApplicationSequence: Effect.succeed(0),
      streamProjectedApplicationEvents: (input: {
        readonly project: (event: never) => unknown;
        readonly filter?: (event: never) => boolean;
      }) =>
        Stream.fromQueue(live[subscribed++]!).pipe(
          Stream.filter((event) => input.filter?.(event as never) ?? true),
          Stream.map((event) => input.project(event as never)),
        ),
    } as unknown as OrchestrationEventStore.OrchestrationEventStore["Service"];
    const enrichment = yield* PubSub.unbounded<never>();

    const outputs = yield* Effect.forEach(live, () =>
      Effect.gen(function* () {
        const output = yield* Queue.unbounded<OrchestrationV2ShellStreamItem>();
        const stream = yield* subscribeOrchestrationV2Shell({});
        yield* stream.pipe(
          Stream.runForEach((item) => Queue.offer(output, item)),
          Effect.forkScoped,
        );
        assert.equal((yield* Queue.take(output)).kind, "snapshot");
        return output;
      }),
    ).pipe(
      Effect.provideService(ThreadManagement.ThreadManagementService, management),
      Effect.provideService(OrchestrationEventStore.OrchestrationEventStore, eventStore),
      Effect.provideService(ProjectStore.ProjectStoreV2, {
        listShells: () => Effect.succeed([]),
      } as unknown as ProjectStore.ProjectStoreV2["Service"]),
      Effect.provideService(ProjectService.ProjectService, {
        getShell: () => Effect.succeedNone,
      } as unknown as ProjectService.ProjectService["Service"]),
      Effect.provideService(ProjectEnrichment.ProjectEnrichmentService, {
        subscribeChanges: PubSub.subscribe(enrichment),
      } as unknown as ProjectEnrichment.ProjectEnrichmentService["Service"]),
    );

    // The pre-change stream: one fresh read per thread batch, through the same unchanged filter.
    const referenceInput = yield* Queue.unbounded<OrchestrationV2ShellStreamItem>();
    const referenceOutput = yield* Queue.unbounded<OrchestrationV2ShellStreamItem>();
    yield* Stream.fromQueue(referenceInput).pipe(
      skipUnchangedThreadShells,
      Stream.runForEach((item) => Queue.offer(referenceOutput, item)),
      Effect.forkScoped,
    );

    const received = outputs.map(() => [] as Array<string>);
    const expected: Array<string> = [];
    let sequence = 0;
    for (const event of events) {
      if (!options.applyFirst) yield* projections.apply(event);
      const stored = { sequence: ++sequence, commandId: null, event };
      const sentinel = {
        aggregateKind: "project",
        aggregateId: SENTINEL_PROJECT,
        type: "project.deleted",
        sequence: ++sequence,
      };
      for (const queue of live) yield* Queue.offerAll(queue, [stored, sentinel]);
      yield* TestClock.adjust(options.cadence ?? "50 millis");
      for (const [index, output] of outputs.entries()) {
        for (;;) {
          const item = yield* Queue.take(output);
          if (item.kind === "project.removed") break;
          received[index]!.push(wire(item));
        }
      }
      yield* Queue.offer(
        referenceInput,
        shellStreamItemFromThreadShell({
          stored: { sequence: stored.sequence, event: { threadId: event.threadId } },
          shell: yield* projections.getThreadShell(event.threadId),
        }),
      );
      for (const item of yield* Queue.clear(referenceOutput)) expected.push(wire(item));
    }
    return { reads, threadBatches: events.length, received, expected } satisfies ShellRun;
  }).pipe(
    Effect.provide(
      Layer.fresh(ProjectionStore.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory))),
    ),
    Effect.scoped,
  );

describe("shell stream reads over a replayed Claude turn", () => {
  it.effect(
    "sends every subscriber the shells a fresh read per batch sends, with fewer reads",
    () =>
      Effect.gen(function* () {
        const events = yield* replayedTurnEvents;
        const one = yield* runShellSubscribers(events, 1);
        const three = yield* runShellSubscribers(events, 3);

        assert.isAbove(one.expected.length, 0);
        assert.deepEqual(one.received, [one.expected]);
        assert.deepEqual(three.received, [three.expected, three.expected, three.expected]);
        // More subscribers add no reads, and batches that cannot change a shell read nothing.
        assert.equal(three.reads, one.reads);
        assert.isBelow(one.reads, one.threadBatches);
      }),
  );

  it.effect("a subscriber waiting on an interrupted shared read reads on its own", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread:shared-read");
      const gate = yield* Deferred.make<void>();
      let reads = 0;
      const read = () =>
        Effect.suspend(() => {
          reads += 1;
          return reads === 1 ? Deferred.await(gate).pipe(Effect.as(null)) : Effect.succeed(null);
        });
      const owner = {};
      const first = yield* makeSubscriberShellReads(owner, read)(threadId, 1, undefined).pipe(
        Effect.forkChild,
      );
      yield* Effect.yieldNow;
      const second = yield* makeSubscriberShellReads(owner, read)(threadId, 1, undefined).pipe(
        Effect.forkChild,
      );
      yield* Effect.yieldNow;
      assert.equal(reads, 1);
      yield* Fiber.interrupt(first);
      assert.isNull(yield* Fiber.join(second));
      assert.equal(reads, 2);
    }),
  );

  it.effect("a lagging subscriber never sends a thread's updatedAt backwards", () =>
    Effect.gen(function* () {
      // The first read already sees the final state; the batches behind it carry older times.
      const run = yield* runShellSubscribers(yield* replayedTurnEvents, 1, {
        applyFirst: true,
        cadence: "1 second",
      });
      assert.isAbove(run.expected.length, 1);
      assert.deepEqual(run.received, [run.expected]);
    }),
  );

  it.effect("a subscriber retrying a shared read can be interrupted", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread:shared-read-retry");
      const firstGate = yield* Deferred.make<void>();
      const retryGate = yield* Deferred.make<void>();
      let reads = 0;
      const read = () =>
        Effect.suspend(() => {
          reads += 1;
          return Deferred.await(reads === 1 ? firstGate : retryGate).pipe(Effect.as(null));
        });
      const owner = {};
      const first = yield* makeSubscriberShellReads(owner, read)(threadId, 1, undefined).pipe(
        Effect.forkChild,
      );
      yield* Effect.yieldNow;
      const second = yield* makeSubscriberShellReads(owner, read)(threadId, 1, undefined).pipe(
        Effect.forkChild,
      );
      yield* Effect.yieldNow;
      yield* Fiber.interrupt(first);
      yield* Effect.yieldNow;
      assert.equal(reads, 2);
      const closing = yield* Fiber.interrupt(second).pipe(
        Effect.timeoutOption("1 second"),
        Effect.forkChild,
      );
      yield* TestClock.adjust("1 second");
      const closed = yield* Fiber.join(closing);
      yield* Deferred.succeed(retryGate, undefined);
      assert.isTrue(Option.isSome(closed), "closing the window waited for the retried read");
    }),
  );

  it.effect("a thread whose shell is gone is read again rather than remembered", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread:gone");
      let reads = 0;
      const readThreadShell = makeSubscriberShellReads({}, () =>
        Effect.sync(() => {
          reads += 1;
          return null;
        }),
      );
      const inert = {
        inert: true,
        itemKeys: [],
        occurredAt: DateTime.makeUnsafe("2026-01-01T00:00:00Z"),
      };
      assert.isNull(yield* readThreadShell(threadId, 1, undefined));
      assert.isNull(yield* readThreadShell(threadId, 2, inert));
      assert.equal(reads, 2);
    }),
  );

  it.effect("sends thread shells only when they change", () =>
    Effect.gen(function* () {
      const run = yield* runShellSubscribers(yield* replayedTurnEvents, 1);
      const updates = run.received[0]!.filter((item) => item.includes('"thread.updated"'));
      const bytes = updates.reduce((sum, item) => sum + Buffer.byteLength(item), 0);
      const previous = new Map<string, Record<string, unknown>>();
      for (const update of updates) {
        const thread = (JSON.parse(update) as { thread: Record<string, unknown> }).thread;
        const prior = previous.get(String(thread.id));
        if (prior !== undefined) {
          const changed = Object.keys(thread).filter(
            (key) =>
              key !== "updatedAt" && JSON.stringify(thread[key]) !== JSON.stringify(prior[key]),
          );
          assert.isNotEmpty(changed, `a frame that changes nothing: ${update}`);
        }
        previous.set(String(thread.id), thread);
      }
      // Each frame carries a whole shell, as the contract has no delta. Measured: 19 frames, 45.5 KB.
      assert.isAtMost(updates.length, 19);
      assert.isAtMost(bytes, 46_000);
    }),
  );
});
