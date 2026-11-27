import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";

import {
  enterRunStartGate,
  runStartGate,
  skipsAdmission,
  type RunStartAdmission,
  type RunStartHold,
} from "./RunStartGate.ts";

const limitHold: RunStartHold = {
  type: "hold",
  reason: {
    kind: "usage_limit",
    message: "Provider instance codex reached its usage limit.",
  },
  releaseAt: "2026-01-01T00:05:00.000Z",
};

describe("runStartGate", () => {
  it.effect("runs admission, then context, then start", () =>
    Effect.gen(function* () {
      const steps = yield* Ref.make<ReadonlyArray<string>>([]);
      yield* runStartGate({
        admission: () =>
          Ref.update(steps, (seen) => [...seen, "admission"]).pipe(
            Effect.as({ type: "start" as const }),
          ),
        context: () => Ref.update(steps, (seen) => [...seen, "context"]).pipe(Effect.as("context")),
        start: () => Ref.update(steps, (seen) => [...seen, "start"]),
      })({ origin: "automatic" });
      assert.deepEqual(yield* Ref.get(steps), ["admission", "context", "start"]);
    }),
  );

  it.effect("stops at the first holding step and names the hold", () =>
    Effect.gen(function* () {
      const steps = yield* Ref.make<ReadonlyArray<string>>([]);
      const outcome = yield* runStartGate({
        admission: () =>
          Ref.update(steps, (seen) => [...seen, "admission"]).pipe(Effect.as(limitHold)),
        context: () => Ref.update(steps, (seen) => [...seen, "context"]).pipe(Effect.as(null)),
        start: () => Ref.update(steps, (seen) => [...seen, "start"]),
      })({ origin: "automatic" });
      assert.deepEqual(outcome, limitHold);
      assert.deepEqual(yield* Ref.get(steps), ["admission"]);
    }),
  );

  it.effect("skips admission for user and provider starts", () =>
    Effect.gen(function* () {
      for (const origin of ["user", "provider"] as const) {
        const steps = yield* Ref.make<ReadonlyArray<string>>([]);
        yield* runStartGate({
          admission: () =>
            Ref.update(steps, (seen) => [...seen, "admission"]).pipe(Effect.as(limitHold)),
          context: () => Ref.update(steps, (seen) => [...seen, "context"]).pipe(Effect.as(null)),
          start: () => Ref.update(steps, (seen) => [...seen, "start"]),
        })({ origin });
        assert.deepEqual(yield* Ref.get(steps), ["context", "start"]);
      }
    }),
  );

  it("admits maintenance and automatic origins through the admission step", () => {
    assert.isFalse(skipsAdmission("maintenance"));
    assert.isFalse(skipsAdmission("automatic"));
    assert.isTrue(skipsAdmission("user"));
    assert.isTrue(skipsAdmission("provider"));
  });
});

describe("enterRunStartGate", () => {
  it.effect("runs the context step only after admission admits", () =>
    Effect.gen(function* () {
      const outcome = yield* enterRunStartGate({
        origin: "automatic",
        admission: () => Effect.succeed<RunStartAdmission>(limitHold),
        context: () => Effect.die("context must not run for a held start"),
      });
      assert.deepEqual(outcome, limitHold);
    }),
  );
});
