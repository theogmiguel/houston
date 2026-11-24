import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";

import { makeRendererRecovery } from "./RendererRecovery.ts";

const makeHarness = Effect.sync(() => {
  const state = { windowGone: false, quitting: false, reloads: 0 };
  const recovery = makeRendererRecovery({
    isWindowGone: () => state.windowGone,
    isQuitting: Effect.sync(() => state.quitting),
    reload: () => {
      state.reloads += 1;
    },
  });
  const advance = (ms: number) =>
    Effect.gen(function* () {
      yield* TestClock.adjust(ms);
      yield* Effect.yieldNow;
      yield* Effect.yieldNow;
    });
  // Crashes the renderer and proves the reload comes exactly `delayMs` later.
  const crashAndExpectReloadAfter = (delayMs: number) =>
    Effect.gen(function* () {
      const before = state.reloads;
      const decision = yield* recovery.renderProcessGone("crashed");
      assert.deepStrictEqual(decision, { recovering: true, reloadInMs: delayMs });
      yield* advance(delayMs - 1);
      assert.strictEqual(state.reloads, before, `reloaded before ${delayMs} ms`);
      yield* advance(1);
      assert.strictEqual(state.reloads, before + 1, `no reload after ${delayMs} ms`);
    });
  return { recovery, state, advance, crashAndExpectReloadAfter };
});

describe("RendererRecovery", () => {
  it.effect("keeps reloading a renderer that crashes more than three times a minute", () =>
    Effect.gen(function* () {
      const { recovery, state, advance } = yield* makeHarness;
      for (let crash = 1; crash <= 6; crash++) {
        const decision = yield* recovery.renderProcessGone("oom");
        assert.isTrue(decision.recovering, `crash ${crash} was not recovered`);
        yield* advance(decision.reloadInMs ?? 0);
        assert.strictEqual(state.reloads, crash, `no reload after crash ${crash}`);
      }
    }),
  );

  it.effect("doubles the delay from 500 ms up to a 30 s ceiling", () =>
    Effect.gen(function* () {
      const { crashAndExpectReloadAfter } = yield* makeHarness;
      for (const delayMs of [500, 1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000]) {
        yield* crashAndExpectReloadAfter(delayMs);
      }
    }),
  );

  it.effect("starts again at 500 ms once a reloaded renderer stays up for a minute", () =>
    Effect.gen(function* () {
      const { advance, crashAndExpectReloadAfter } = yield* makeHarness;
      yield* crashAndExpectReloadAfter(500);
      yield* crashAndExpectReloadAfter(1_000);
      yield* crashAndExpectReloadAfter(2_000);
      yield* advance(59_999);
      yield* crashAndExpectReloadAfter(4_000);
      yield* advance(60_000);
      yield* crashAndExpectReloadAfter(500);
    }),
  );

  it.effect("schedules nothing for a destroyed window", () =>
    Effect.gen(function* () {
      const { recovery, state, advance } = yield* makeHarness;
      state.windowGone = true;
      const decision = yield* recovery.renderProcessGone("crashed");
      assert.deepStrictEqual(decision, { recovering: false });
      yield* advance(120_000);
      assert.strictEqual(state.reloads, 0);
    }),
  );

  it.effect("does not reload a window destroyed during the wait", () =>
    Effect.gen(function* () {
      const { recovery, state, advance } = yield* makeHarness;
      yield* recovery.renderProcessGone("crashed");
      state.windowGone = true;
      yield* advance(120_000);
      assert.strictEqual(state.reloads, 0);
    }),
  );

  it.effect("stops for a closed window: the pending reload is cancelled and none follows", () =>
    Effect.gen(function* () {
      const { recovery, state, advance } = yield* makeHarness;
      yield* recovery.renderProcessGone("crashed");
      yield* recovery.stop;
      yield* advance(120_000);
      assert.strictEqual(state.reloads, 0);
      const decision = yield* recovery.renderProcessGone("crashed");
      assert.deepStrictEqual(decision, { recovering: false });
      yield* advance(120_000);
      assert.strictEqual(state.reloads, 0);
    }),
  );

  it.effect("never reloads while the host is quitting or installing an update", () =>
    Effect.gen(function* () {
      const { recovery, state, advance } = yield* makeHarness;
      state.quitting = true;
      yield* recovery.renderProcessGone("killed");
      yield* advance(120_000);
      assert.strictEqual(state.reloads, 0);
    }),
  );

  it.effect("reloads once a failed update install clears the quitting flag", () =>
    Effect.gen(function* () {
      const { recovery, state, advance } = yield* makeHarness;
      state.quitting = true;
      const decision = yield* recovery.renderProcessGone("crashed");
      assert.deepStrictEqual(decision, { recovering: true, reloadInMs: 500 });
      yield* advance(120_000);
      assert.strictEqual(state.reloads, 0);
      state.quitting = false;
      yield* advance(500);
      assert.strictEqual(state.reloads, 1);
    }),
  );

  it.effect("does not reload when a quit starts during the wait", () =>
    Effect.gen(function* () {
      const { recovery, state, advance } = yield* makeHarness;
      yield* recovery.renderProcessGone("crashed");
      state.quitting = true;
      yield* advance(120_000);
      assert.strictEqual(state.reloads, 0);
    }),
  );

  it.effect("does not stack a second reload while one is pending", () =>
    Effect.gen(function* () {
      const { recovery, state, advance } = yield* makeHarness;
      yield* recovery.renderProcessGone("crashed");
      const second = yield* recovery.renderProcessGone("abnormal-exit");
      assert.deepStrictEqual(second, { recovering: true });
      yield* advance(120_000);
      assert.strictEqual(state.reloads, 1);
    }),
  );

  it.effect("leaves a renderer that exited cleanly alone", () =>
    Effect.gen(function* () {
      const { recovery, state, advance } = yield* makeHarness;
      const decision = yield* recovery.renderProcessGone("clean-exit");
      assert.deepStrictEqual(decision, { recovering: false });
      yield* advance(120_000);
      assert.strictEqual(state.reloads, 0);
    }),
  );
});
