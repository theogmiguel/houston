import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as TestClock from "effect/testing/TestClock";

import * as DesktopState from "../app/DesktopState.ts";

import * as DesktopUpdatePolicy from "./DesktopUpdatePolicy.ts";
import * as DesktopUpdates from "./DesktopUpdates.ts";
import { flushCallbacks, makeHarness } from "./updatesTestHarness.ts";

describe("DesktopUpdates.configure", () => {
  it.effect(
    "publishes the update state before the updater attaches, and attaches on the signal",
    () => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        const updates = yield* DesktopUpdates.DesktopUpdates;
        const attach = yield* Deferred.make<void>();

        yield* updates.configure(Deferred.await(attach));
        const state = yield* updates.getState;
        assert.isTrue(state.enabled);
        assert.strictEqual(state.status, "idle");
        assert.deepStrictEqual(harness.feedUrls(), []);
        assert.strictEqual(harness.listenerCount(), 0);

        yield* Deferred.succeed(attach, undefined);
        yield* flushCallbacks;
        yield* flushCallbacks;
        assert.strictEqual(harness.feedUrls().length, 1);
        assert.strictEqual(harness.listenerCount(), 6);
      }).pipe(Effect.provide(harness.layer), Effect.scoped);
    },
  );

  it.effect("runs a check requested before the updater attaches once it attaches", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const updates = yield* DesktopUpdates.DesktopUpdates;
      const attach = yield* Deferred.make<void>();
      yield* updates.configure(Deferred.await(attach));

      const check = yield* updates.check("menu").pipe(Effect.forkChild);
      yield* flushCallbacks;
      assert.strictEqual(harness.checkCount(), 0);

      yield* Deferred.succeed(attach, undefined);
      const result = yield* Fiber.join(check);
      assert.isTrue(result.checked);
      assert.strictEqual(harness.checkCount(), 1);
    }).pipe(Effect.provide(harness.layer), Effect.scoped);
  });

  it.effect("answers a check at once when updates are off, without attaching the updater", () => {
    const harness = makeHarness({
      policy: { ...DesktopUpdatePolicy.unmanagedUpdatePolicy, mode: "off" },
    });
    return Effect.gen(function* () {
      const updates = yield* DesktopUpdates.DesktopUpdates;
      yield* updates.configure(Effect.never);

      const result = yield* updates.check("menu");
      assert.isFalse(result.checked);
      assert.isFalse(result.state.enabled);
      assert.strictEqual(harness.checkCount(), 0);
      assert.strictEqual(harness.listenerCount(), 0);
    }).pipe(Effect.provide(harness.layer), Effect.scoped);
  });
});

describe("DesktopUpdates.afterFirstWindow", () => {
  const waitFor = Effect.gen(function* () {
    const state = yield* DesktopState.DesktopState;
    const fiber = yield* DesktopUpdates.afterFirstWindow(state).pipe(Effect.forkChild);
    yield* TestClock.adjust("9 seconds");
    return { state, fiber };
  });

  it.effect("completes when the main window is first shown", () =>
    Effect.gen(function* () {
      const { state, fiber } = yield* waitFor;
      assert.isUndefined(fiber.pollUnsafe());
      yield* Deferred.succeed(state.mainWindowRevealed, undefined);
      yield* Fiber.join(fiber);
    }).pipe(Effect.provide(DesktopState.layer)),
  );

  it.effect("completes when the backend fails to start, for the startup recovery window", () =>
    Effect.gen(function* () {
      const { state, fiber } = yield* waitFor;
      yield* SubscriptionRef.set(state.primaryBackendStartup, {
        _tag: "Failing",
        reason: "exited with code 1",
        output: "",
      });
      yield* Fiber.join(fiber);
    }).pipe(Effect.provide(DesktopState.layer)),
  );

  it.effect("completes after a bounded wait when no window ever appears", () =>
    Effect.gen(function* () {
      const { fiber } = yield* waitFor;
      assert.isUndefined(fiber.pollUnsafe());
      yield* TestClock.adjust("1 second");
      yield* Fiber.join(fiber);
    }).pipe(Effect.provide(DesktopState.layer)),
  );
});
