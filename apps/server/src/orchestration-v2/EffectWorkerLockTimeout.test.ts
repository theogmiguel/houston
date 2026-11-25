// A file database: an in-memory one cannot see another connection's write lock.
import * as NodeSqlite from "node:sqlite";

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { CommandId, RunId, ThreadId } from "@houston-app/contracts";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import type * as Scope from "effect/Scope";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlError from "effect/sql/SqlError";
import * as TestClock from "effect/testing/TestClock";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as EffectWorker from "./EffectWorker.ts";

type Outbox = EffectOutbox.EffectOutboxV2["Service"];

const workerId = "worker-lock-timeout";
const threadId = ThreadId.make("thread:lock-timeout");
const cleanup = { type: "terminal.cleanup" } as const;
const turnStart = { type: "provider-turn.start", runId: RunId.make("run:lock-timeout") } as const;

const isLocked = (error: EffectOutbox.EffectOutboxError) =>
  SqlError.isSqlError(error.cause) && error.cause.reason._tag === "LockTimeoutError";

const lostReply = (operation: string) =>
  new EffectOutbox.EffectOutboxError({ operation, cause: "simulated lost reply" });

/**
 * The real outbox on a file database whose write lock another connection can hold. The server's
 * connection does not wait for the lock, so each attempt times out at once.
 */
const withLockableOutbox = <A, E>(
  use: (input: {
    readonly outbox: Outbox;
    readonly lock: Effect.Effect<void>;
    readonly unlock: Effect.Effect<void>;
    /** Releases the lock once this many settlement writes have timed out on it. */
    readonly unlockAfter: (timeouts: number) => Effect.Effect<void>;
    readonly timeouts: () => number;
    /** The wait the server's connection has outside this test. */
    readonly defaultLockWaitMs: number;
    readonly firstTimeout: Deferred.Deferred<void>;
    readonly row: (id: string) => Effect.Effect<EffectOutbox.OrchestrationEffectV2>;
  }) => Effect.Effect<A, E, Scope.Scope>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const filename = path.join(yield* fs.makeTempDirectoryScoped(), "state.sqlite");
    return yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const real = yield* EffectOutbox.EffectOutboxV2;
      const waits = yield* sql<{ readonly timeout: number }>`PRAGMA busy_timeout`;
      yield* sql`PRAGMA busy_timeout = 0`;
      const other = yield* Effect.acquireRelease(
        Effect.sync(() => new NodeSqlite.DatabaseSync(filename)),
        (database) => Effect.sync(() => database.close()),
      );
      let timeouts = 0;
      let unlockAfter = Number.POSITIVE_INFINITY;
      const firstTimeout = yield* Deferred.make<void>();
      const unlock = Effect.sync(() => other.exec("ROLLBACK"));
      const observe = <B>(write: Effect.Effect<B, EffectOutbox.EffectOutboxError>) =>
        Effect.tapError(write, (error) =>
          Effect.gen(function* () {
            if (!isLocked(error)) return;
            timeouts++;
            yield* Deferred.succeed(firstTimeout, undefined);
            if (timeouts === unlockAfter) yield* unlock;
          }),
        );
      return yield* use({
        outbox: {
          ...real,
          succeed: (input) => observe(real.succeed(input)),
          retry: (input) => observe(real.retry(input)),
          fail: (input) => observe(real.fail(input)),
        },
        lock: Effect.sync(() => other.exec("BEGIN IMMEDIATE")),
        unlock,
        unlockAfter: (count) =>
          Effect.sync(() => {
            unlockAfter = count;
          }),
        timeouts: () => timeouts,
        defaultLockWaitMs: waits[0]!.timeout,
        firstTimeout,
        row: (id) =>
          real.get(id).pipe(
            Effect.map((found) => Option.getOrThrow(found)),
            Effect.orDie,
          ),
      });
    }).pipe(
      Effect.scoped,
      Effect.provide(
        EffectOutbox.layer.pipe(Layer.provideMerge(SqlitePersistence.layerFromPath(filename))),
      ),
    );
  }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)));

const makeWorker = (
  outbox: Outbox,
  execute: (
    effect: EffectOutbox.OrchestrationEffectV2,
  ) => Effect.Effect<void, EffectWorker.OrchestrationEffectExecutionError>,
  maxAttempts = 5,
) =>
  EffectWorker.OrchestrationEffectWorkerV2.pipe(
    Effect.provide(
      EffectWorker.layerWithOptions({ workerId, maxAttempts }).pipe(
        Layer.provide(
          Layer.merge(
            Layer.succeed(EffectOutbox.EffectOutboxV2, outbox),
            Layer.succeed(
              EffectWorker.OrchestrationEffectExecutorV2,
              EffectWorker.OrchestrationEffectExecutorV2.of({ execute }),
            ),
          ),
        ),
      ),
    ),
  );

const executionFailure = (effect: EffectOutbox.OrchestrationEffectV2) =>
  new EffectWorker.OrchestrationEffectExecutionError({
    effectId: effect.id,
    effectType: effect.request.type,
    cause: "simulated execution failure",
  });

const enqueue = (
  outbox: Outbox,
  id: string,
  request: EffectOutbox.OrchestrationEffectRequestV2 = cleanup,
) => outbox.enqueue([{ id, commandId: CommandId.make(`command:${id}`), threadId, request }]);

const loopTurn = Effect.callback<void>((resume) => {
  const immediate = setImmediate(() => resume(Effect.void));
  return Effect.sync(() => clearImmediate(immediate));
});

/** Moves the test clock through each backoff, with a real loop turn for the reader worker. */
const joinAdvancing = <A, E>(fiber: Fiber.Fiber<A, E>) =>
  Effect.gen(function* () {
    while (fiber.pollUnsafe() === undefined) {
      yield* TestClock.adjust("100 millis");
      yield* loopTurn;
    }
    return yield* Fiber.await(fiber);
  });

it.effect.each([
  { write: "succeed", request: cleanup, status: "succeeded" },
  { write: "requeue", request: cleanup, status: "pending" },
  { write: "fail", request: cleanup, status: "failed" },
  { write: "fallback requeue", request: cleanup, status: "pending" },
  { write: "fallback terminalize", request: turnStart, status: "failed" },
] as const)("a $write survives two lock timeouts without running the effect again", (testCase) =>
  withLockableOutbox(({ outbox, lock, unlockAfter, timeouts, row }) =>
    Effect.gen(function* () {
      yield* enqueue(outbox, "effect", testCase.request);
      yield* unlockAfter(2);
      let executions = 0;
      const worker = yield* makeWorker(
        {
          ...outbox,
          ...(testCase.write === "fallback requeue"
            ? { get: () => Effect.andThen(lock, Effect.fail(lostReply("get"))) }
            : {}),
          ...(testCase.write === "fallback terminalize"
            ? { succeed: () => Effect.andThen(lock, Effect.fail(lostReply("succeed"))) }
            : {}),
        },
        (effect) =>
          Effect.gen(function* () {
            executions++;
            if (!testCase.write.startsWith("fallback")) yield* lock;
            if (testCase.write === "requeue" || testCase.write === "fail") {
              return yield* executionFailure(effect);
            }
          }),
        testCase.write === "fail" ? 1 : 5,
      );
      yield* joinAdvancing(yield* Effect.forkChild(worker.runOnce));

      assert.equal(timeouts(), 2);
      assert.equal((yield* row("effect")).status, testCase.status);
      assert.equal(executions, testCase.write === "fallback requeue" ? 0 : 1);
    }),
  ),
);

it.effect("a settlement that outlasts its retries is written by a later run, in order", () =>
  withLockableOutbox(({ outbox, lock, unlock, timeouts, row }) =>
    Effect.gen(function* () {
      yield* enqueue(outbox, "first");
      yield* enqueue(outbox, "second");
      const executed: Array<string> = [];
      const worker = yield* makeWorker(outbox, (effect) =>
        Effect.gen(function* () {
          executed.push(effect.id);
          if (executed.length > 1) return;
          yield* lock;
          return yield* executionFailure(effect);
        }),
      );

      const kept = yield* joinAdvancing(yield* Effect.forkChild(worker.runOnce));
      assert.isTrue(Exit.isFailure(kept));
      assert.equal(timeouts(), 3);
      assert.equal((yield* row("first")).status, "running");

      // Still locked: the run reports the failure, so the daemon cools off, and keeps the write.
      assert.isTrue(Exit.isFailure(yield* Effect.exit(worker.runOnce)));
      assert.deepEqual(executed, ["first"]);

      yield* unlock;
      // The kept write goes first, and the thread's later effect does not overtake it.
      assert.isFalse(yield* worker.runOnce);
      const requeued = yield* row("first");
      assert.equal(requeued.status, "pending");
      assert.include(requeued.lastError ?? "", "simulated execution failure");
      assert.deepEqual(executed, ["first"]);

      yield* TestClock.adjust("1 second");
      assert.equal(yield* worker.drain(), 2);
      assert.deepEqual(executed, ["first", "first", "second"]);
      assert.equal((yield* row("first")).status, "succeeded");
      assert.equal((yield* row("second")).status, "succeeded");
    }),
  ),
);

it.effect("the daemon pauses between every try of a kept settlement and logs its limits", () => {
  const logged: Array<readonly [string, Record<string, unknown>]> = [];
  const layerLogger = Logger.layer([
    Logger.make(({ message }) => {
      const [text, fields] = Array.isArray(message) ? message : [message];
      if (String(text).includes("kept")) {
        logged.push([String(text), fields as Record<string, unknown>]);
      }
    }),
  ]);
  return withLockableOutbox(({ outbox, lock, unlockAfter, defaultLockWaitMs, firstTimeout, row }) =>
    Effect.gen(function* () {
      yield* enqueue(outbox, "effect");
      yield* unlockAfter(5);
      const tries: Array<number> = [];
      const worker = yield* makeWorker(
        {
          ...outbox,
          succeed: (input) =>
            Effect.gen(function* () {
              tries.push(yield* Clock.currentTimeMillis);
              return yield* outbox.succeed(input);
            }),
        },
        () => lock,
      );
      const daemon = yield* EffectWorker.runDaemonWithOptions({ concurrency: 1 }).pipe(
        Effect.provideService(EffectWorker.OrchestrationEffectWorkerV2, worker),
        Effect.forkChild,
      );
      yield* Deferred.await(firstTimeout);
      for (let step = 0; step < 100 && tries.length < 6; step++) {
        yield* TestClock.adjust("100 millis");
        for (let turn = 0; turn < 5; turn++) yield* loopTurn;
      }
      yield* Fiber.interrupt(daemon);

      const first = tries[0] ?? 0;
      assert.deepEqual(
        tries.map((at) => at - first),
        [0, 500, 1_500, 2_500, 3_500, 4_500],
      );
      assert.equal((yield* row("effect")).status, "succeeded");
      const fields = { effectId: "effect", effectType: "terminal.cleanup" };
      assert.deepEqual(logged, [
        [
          "Effect settlement kept until the database lock is free",
          {
            ...fields,
            operation: "succeed",
            tries: 3,
            lockWaitMsPerTry: defaultLockWaitMs,
            keptSettlements: 1,
          },
        ],
        ["Wrote the kept effect settlement", { ...fields, keptSettlements: 0 }],
      ]);
    }),
  ).pipe(Effect.provide(layerLogger));
});

it.effect("a kept settlement that then fails for another reason does not block later work", () =>
  withLockableOutbox(({ outbox, lock, unlock, row }) =>
    Effect.gen(function* () {
      yield* enqueue(outbox, "effect");
      let unlocked = false;
      let writes = 0;
      const worker = yield* makeWorker(
        {
          ...outbox,
          succeed: (input) =>
            Effect.suspend(() => {
              writes++;
              return unlocked ? Effect.fail(lostReply("succeed")) : outbox.succeed(input);
            }),
        },
        () => lock,
      );
      yield* joinAdvancing(yield* Effect.forkChild(worker.runOnce));
      yield* unlock;
      unlocked = true;

      // The failure takes the ordinary recovery path once, and the settlement is not kept again.
      assert.isTrue(Exit.isFailure(yield* Effect.exit(worker.runOnce)));
      assert.equal((yield* row("effect")).status, "pending");
      assert.equal(writes, 4);
    }),
  ),
);

it.effect.each([
  { write: "requeue", request: cleanup, after: "pending" },
  { write: "fallback requeue", request: cleanup, after: "pending" },
  { write: "fallback terminalize", request: turnStart, after: "cancelled" },
] as const)("shutdown interrupts a $write that is waiting on a lock", (testCase) =>
  withLockableOutbox(({ outbox, lock, unlock, timeouts, firstTimeout, row }) =>
    Effect.gen(function* () {
      yield* enqueue(outbox, "effect", testCase.request);
      const worker = yield* makeWorker(
        {
          ...outbox,
          ...(testCase.write === "fallback requeue"
            ? { get: () => Effect.andThen(lock, Effect.fail(lostReply("get"))) }
            : {}),
          ...(testCase.write === "fallback terminalize"
            ? { succeed: () => Effect.andThen(lock, Effect.fail(lostReply("succeed"))) }
            : {}),
        },
        (effect) =>
          testCase.write === "requeue"
            ? Effect.andThen(lock, Effect.fail(executionFailure(effect)))
            : Effect.void,
      );
      const daemon = yield* EffectWorker.runDaemonWithOptions({ concurrency: 1 }).pipe(
        Effect.provideService(EffectWorker.OrchestrationEffectWorkerV2, worker),
        Effect.forkChild,
      );
      yield* Deferred.await(firstTimeout);
      const stop = yield* Effect.forkChild(Fiber.interrupt(daemon));
      // The clock does not move, so a stop that waits for a backoff is still pending here.
      for (let turn = 0; turn < 50 && stop.pollUnsafe() === undefined; turn++) yield* loopTurn;
      const stopped = stop.pollUnsafe() !== undefined;
      yield* joinAdvancing(stop);
      assert.isTrue(stopped);
      assert.equal(timeouts(), 1);

      yield* unlock;
      yield* outbox.reconcileAfterProcessLoss;
      const settled = yield* row("effect");
      assert.equal(settled.status, testCase.after);
      assert.isNull(settled.leaseOwner);
    }),
  ),
);

it.effect("a success whose reply was lost does not run the effect again", () =>
  withLockableOutbox(({ outbox, row }) =>
    Effect.gen(function* () {
      yield* enqueue(outbox, "effect");
      let executions = 0;
      const worker = yield* makeWorker(
        {
          ...outbox,
          succeed: (input) =>
            Effect.andThen(outbox.succeed(input), Effect.fail(lostReply("succeed"))),
        },
        () =>
          Effect.sync(() => {
            executions++;
          }),
      );
      assert.isTrue(Exit.isFailure(yield* Effect.exit(worker.runOnce)));
      assert.equal((yield* row("effect")).status, "succeeded");
      assert.isFalse(yield* worker.runOnce);
      assert.equal(executions, 1);
    }),
  ),
);

it.effect("a late requeue does not take back an effect that was claimed again", () =>
  withLockableOutbox(({ outbox, row }) =>
    Effect.gen(function* () {
      yield* enqueue(outbox, "effect");
      let replyLost = false;
      const worker = yield* makeWorker(
        {
          ...outbox,
          retry: (input) =>
            Effect.gen(function* () {
              const requeued = yield* outbox.retry(input);
              if (replyLost) return requeued;
              replyLost = true;
              // The requeue committed, and another fiber of the same worker claims it next.
              yield* TestClock.adjust("1 second");
              assert.isTrue(Option.isSome(yield* outbox.claimNext({ workerId })));
              return yield* lostReply("retry");
            }),
        },
        (effect) => Effect.fail(executionFailure(effect)),
      );
      yield* Effect.exit(worker.runOnce);

      const claimedAgain = yield* row("effect");
      assert.isTrue(replyLost);
      assert.equal(claimedAgain.status, "running");
      assert.equal(claimedAgain.attemptCount, 2);
    }),
  ),
);
