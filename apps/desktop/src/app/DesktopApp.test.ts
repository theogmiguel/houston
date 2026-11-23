import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";

import { acquireDesktopSingleInstanceLock, isUpdateRelaunchLaunch } from "./DesktopApp.ts";

describe("update relaunch detection", () => {
  it("recognises the environment electron-updater passes to the new AppImage", () => {
    assert.isTrue(
      isUpdateRelaunchLaunch({ appImageSilentInstall: "true", restartMarkerFresh: false }),
    );
  });

  it("recognises the restart marker the install writes before quitting", () => {
    assert.isTrue(
      isUpdateRelaunchLaunch({ appImageSilentInstall: undefined, restartMarkerFresh: true }),
    );
  });

  it("treats any other launch as an ordinary one", () => {
    assert.isFalse(
      isUpdateRelaunchLaunch({ appImageSilentInstall: undefined, restartMarkerFresh: false }),
    );
    assert.isFalse(
      isUpdateRelaunchLaunch({ appImageSilentInstall: "false", restartMarkerFresh: false }),
    );
  });
});

describe("single instance lock during an update relaunch", () => {
  it.effect("keeps retrying until the old process releases the lock", () =>
    Effect.gen(function* () {
      let attempts = 0;
      const lockHeld = yield* acquireDesktopSingleInstanceLock({
        updateRelaunch: true,
        requestLock: Effect.sync(() => {
          attempts += 1;
          return attempts >= 3;
        }),
      }).pipe(Effect.forkChild);
      yield* TestClock.adjust("2 seconds");
      assert.isTrue(yield* Fiber.join(lockHeld));
      assert.strictEqual(attempts, 3);
    }),
  );

  it.effect("gives up after the bounded window when the lock never frees", () =>
    Effect.gen(function* () {
      let attempts = 0;
      const lockHeld = yield* acquireDesktopSingleInstanceLock({
        updateRelaunch: true,
        requestLock: Effect.sync(() => {
          attempts += 1;
          return false;
        }),
      }).pipe(Effect.forkChild);
      yield* TestClock.adjust("20 seconds");
      assert.isFalse(yield* Fiber.join(lockHeld));
      assert.isAbove(attempts, 1);
    }),
  );

  it.effect("does not retry an ordinary second launch", () =>
    Effect.gen(function* () {
      let attempts = 0;
      const lockHeld = yield* acquireDesktopSingleInstanceLock({
        updateRelaunch: false,
        requestLock: Effect.sync(() => {
          attempts += 1;
          return false;
        }),
      });
      assert.isFalse(lockHeld);
      assert.strictEqual(attempts, 1);
    }),
  );
});
