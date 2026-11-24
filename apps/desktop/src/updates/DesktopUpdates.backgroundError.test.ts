import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";

import * as ElectronUpdater from "../electron/ElectronUpdater.ts";

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

describe("DesktopUpdates background errors", () => {
  it.effect("keeps an offered update downloadable and clears a stale download context", () => {
    const harness = makeHarness({
      downloadUpdate: Effect.fail(
        new ElectronUpdater.ElectronUpdaterDownloadUpdateError({
          channel: null,
          cause: "download failed",
        }),
      ),
    });
    return withUpdates(
      harness,
      Effect.gen(function* () {
        const updates = yield* configureAttached;
        yield* offered(harness);
        yield* updates.download;
        const failed = yield* updates.getState;
        assert.strictEqual(failed.status, "available");
        assert.strictEqual(failed.errorContext, "download");

        yield* emitEvent(harness, "error", new Error("background updater failure"));

        const state = yield* updates.getState;
        assert.strictEqual(state.status, "available");
        assert.strictEqual(state.availableVersion, "1.2.0");
        assert.isNull(state.errorContext);
        assert.isString(state.message);
        assert.isTrue(state.canRetry);
      }),
    );
  });

  it.effect("keeps a downloaded build when a background error arrives", () => {
    const harness = makeHarness();
    return withUpdates(
      harness,
      Effect.gen(function* () {
        const updates = yield* configureAttached;
        yield* downloaded(harness);

        yield* emitEvent(harness, "error", new Error("background updater failure"));

        const state = yield* updates.getState;
        assert.strictEqual(state.status, "downloaded");
        assert.strictEqual(state.downloadedVersion, "1.2.0");
        assert.isNull(state.errorContext);
        assert.isNull(state.message);
      }),
    );
  });

  it.effect("reports an error with no stale context when nothing is offered", () => {
    const harness = makeHarness();
    return withUpdates(
      harness,
      Effect.gen(function* () {
        const updates = yield* configureAttached;

        yield* emitEvent(harness, "error", new Error("background updater failure"));

        const state = yield* updates.getState;
        assert.strictEqual(state.status, "error");
        assert.isNull(state.errorContext);
        assert.isString(state.message);
      }),
    );
  });
});
