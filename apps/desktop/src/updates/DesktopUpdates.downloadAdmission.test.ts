import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";

import * as DesktopUpdates from "./DesktopUpdates.ts";
import { flushCallbacks, makeHarness } from "./updatesTestHarness.ts";

const configureAttached = Effect.gen(function* () {
  const updates = yield* DesktopUpdates.DesktopUpdates;
  const attach = yield* Deferred.make<void>();
  yield* updates.configure(Deferred.await(attach));
  yield* Deferred.succeed(attach, undefined);
  yield* flushCallbacks;
  yield* flushCallbacks;
  return updates;
});

const emitEvent = (harness: ReturnType<typeof makeHarness>, event: string, payload?: unknown) =>
  Effect.gen(function* () {
    harness.emit(event, payload);
    yield* flushCallbacks;
    yield* flushCallbacks;
  });

const withUpdates = <E, R>(
  harness: ReturnType<typeof makeHarness>,
  effect: Effect.Effect<void, E, R>,
) => effect.pipe(Effect.provide(harness.layer), Effect.scoped);

const offered = (harness: ReturnType<typeof makeHarness>) =>
  emitEvent(harness, "update-available", { version: "1.2.0" });

const downloaded = (harness: ReturnType<typeof makeHarness>) =>
  offered(harness).pipe(
    Effect.andThen(emitEvent(harness, "update-downloaded", { version: "1.2.0" })),
  );

describe("DesktopUpdates download admission", () => {
  it.effect("waits for an in-flight check before downloading", () => {
    const checkStarted = Deferred.make<void>();
    const releaseCheck = Deferred.make<void>();

    return Effect.gen(function* () {
      const started = yield* checkStarted;
      const release = yield* releaseCheck;
      const harness = makeHarness({
        checkForUpdates: Deferred.succeed(started, undefined).pipe(
          Effect.andThen(Deferred.await(release)),
        ),
      });

      yield* withUpdates(
        harness,
        Effect.gen(function* () {
          const updates = yield* configureAttached;
          yield* offered(harness);
          assert.strictEqual((yield* updates.getState).status, "available");

          const check = yield* updates.check("poll").pipe(Effect.forkChild);
          yield* Deferred.await(started);

          const download = yield* updates.download.pipe(Effect.forkChild);
          yield* flushCallbacks;
          yield* flushCallbacks;
          assert.isUndefined(download.pollUnsafe());
          assert.strictEqual((yield* updates.getState).status, "available");

          yield* Deferred.succeed(release, undefined);
          const result = yield* Fiber.join(download);
          yield* Fiber.join(check);

          assert.isTrue(result.accepted);
          assert.isTrue(result.completed);
          assert.strictEqual(harness.downloadCount(), 1);
        }),
      );
    });
  });

  it.effect("refuses a download while another download is active", () => {
    const downloadStarted = Deferred.make<void>();
    const releaseDownload = Deferred.make<void>();

    return Effect.gen(function* () {
      const started = yield* downloadStarted;
      const release = yield* releaseDownload;
      const harness = makeHarness({
        downloadUpdate: Deferred.succeed(started, undefined).pipe(
          Effect.andThen(Deferred.await(release)),
        ),
      });

      yield* withUpdates(
        harness,
        Effect.gen(function* () {
          const updates = yield* configureAttached;
          yield* offered(harness);

          const download = yield* updates.download.pipe(Effect.forkChild);
          yield* Deferred.await(started);

          const second = yield* updates.download;
          assert.isFalse(second.accepted);

          yield* Deferred.succeed(release, undefined);
          const first = yield* Fiber.join(download);
          assert.isTrue(first.accepted);
        }),
      );
    });
  });
});

describe("DesktopUpdates install admission", () => {
  const installWaitsForCheck = (
    install: () => Effect.Effect<
      { readonly accepted: boolean; readonly completed: boolean },
      never,
      DesktopUpdates.DesktopUpdates
    >,
  ) =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const harness = makeHarness({
        checkForUpdates: Deferred.succeed(started, undefined).pipe(
          Effect.andThen(Deferred.await(release)),
        ),
      });

      yield* withUpdates(
        harness,
        Effect.gen(function* () {
          const updates = yield* configureAttached;
          yield* downloaded(harness);
          assert.strictEqual((yield* updates.getState).status, "downloaded");

          const check = yield* updates.check("poll").pipe(Effect.forkChild);
          yield* Deferred.await(started);
          assert.strictEqual((yield* updates.getState).status, "downloaded");

          const installing = yield* install().pipe(Effect.forkChild);
          yield* flushCallbacks;
          yield* flushCallbacks;
          assert.isUndefined(installing.pollUnsafe());

          yield* Deferred.succeed(release, undefined);
          const result = yield* Fiber.join(installing);
          yield* Fiber.join(check);

          assert.isTrue(result.accepted);
          assert.strictEqual(harness.quitAndInstalls(), 1);
        }),
      );
    });

  it.effect("install without an expected version waits for an in-flight check", () =>
    installWaitsForCheck(() =>
      Effect.gen(function* () {
        const updates = yield* DesktopUpdates.DesktopUpdates;
        return yield* updates.install;
      }),
    ),
  );

  it.effect("installPrepared waits for an in-flight check", () =>
    installWaitsForCheck(() =>
      Effect.gen(function* () {
        const updates = yield* DesktopUpdates.DesktopUpdates;
        return yield* updates.installPrepared("1.2.0");
      }),
    ),
  );

  it.effect(
    "install without an expected version uses the downloaded build without a new check",
    () =>
      Effect.gen(function* () {
        const harness = makeHarness();
        yield* withUpdates(
          harness,
          Effect.gen(function* () {
            const updates = yield* configureAttached;
            yield* downloaded(harness);
            const checksBefore = harness.checkCount();

            const result = yield* updates.install;

            assert.isTrue(result.accepted);
            assert.strictEqual(harness.checkCount(), checksBefore);
            assert.strictEqual(harness.quitAndInstalls(), 1);
          }),
        );
      }),
  );
});
