import { describe, expect, it } from "@effect/vitest";
import { RunId, ThreadId } from "@houston-app/contracts";
import { InferenceServerId } from "@houston-app/contracts/houston/inference";
import * as Effect from "effect/Effect";

import * as InferenceStops from "./InferenceStops.ts";

describe("InferenceStops", () => {
  it.effect(
    "refuses a stopped run's retries for a minute, and keeps the thread's latest stop",
    () =>
      Effect.gen(function* () {
        const stops = yield* InferenceStops.make;
        const thread = ThreadId.make("thread-1");
        const run = RunId.make("run-1");
        yield* stops.record({
          threadId: thread,
          runId: run,
          serverId: InferenceServerId.make("rtx"),
          model: "GLM-5.3-Flash",
          reason: "loop",
          atMs: 1_000,
        });
        expect(yield* stops.refusesRetry(run, 30_000)).toBe(true);
        expect(yield* stops.refusesRetry(run, 62_000)).toBe(false);
        expect(yield* stops.refusesRetry(RunId.make("run-2"), 2_000)).toBe(false);
        expect(yield* stops.latest(thread)).toMatchObject({
          reason: "loop",
          model: "GLM-5.3-Flash",
        });
      }),
  );
});
