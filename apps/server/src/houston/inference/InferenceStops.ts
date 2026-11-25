import type { RunId, ThreadId } from "@houston-app/contracts";
import type {
  InferenceServerId,
  InferenceStopReason,
  InferenceThreadStop,
} from "@houston-app/contracts/houston/inference";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

// Long enough for a harness's automatic retries of the stopped request, short of a user's next turn.
const RETRY_REFUSAL_MS = 60_000;
const MAX_REMEMBERED = 200;

/** Replies T3's gateway stopped, for the thread's notice and to refuse the harness's retries. */
export class InferenceStops extends Context.Service<
  InferenceStops,
  {
    readonly record: (stop: {
      readonly threadId: ThreadId | undefined;
      readonly runId: RunId | null;
      readonly serverId: InferenceServerId;
      readonly model: string;
      readonly reason: InferenceStopReason;
      readonly atMs: number;
    }) => Effect.Effect<void>;
    readonly latest: (threadId: ThreadId) => Effect.Effect<InferenceThreadStop | null>;
    /** Whether a run had a reply stopped a moment ago, so a retry would only repeat it. */
    readonly refusesRetry: (runId: RunId, nowMs: number) => Effect.Effect<boolean>;
  }
>()("@houston-app/cli/houston/inference/InferenceStops") {}

export const make = Effect.gen(function* () {
  const byThread = yield* Ref.make(new Map<ThreadId, InferenceThreadStop>());
  const byRun = yield* Ref.make(new Map<RunId, number>());
  const bounded = <K, V>(map: Map<K, V>) => {
    while (map.size > MAX_REMEMBERED) map.delete(map.keys().next().value as K);
    return map;
  };
  return InferenceStops.of({
    record: Effect.fn("InferenceStops.record")(function* (stop) {
      const at = DateTime.formatIso(DateTime.makeUnsafe(stop.atMs));
      const { threadId, runId } = stop;
      if (threadId !== undefined) {
        yield* Ref.update(byThread, (all) => {
          const next = new Map(all);
          next.delete(threadId);
          return bounded(
            next.set(threadId, {
              serverId: stop.serverId,
              model: stop.model,
              reason: stop.reason,
              at,
            }),
          );
        });
      }
      if (runId !== null) {
        yield* Ref.update(byRun, (all) => bounded(new Map(all).set(runId, stop.atMs)));
      }
    }),
    latest: Effect.fn("InferenceStops.latest")(function* (threadId) {
      return (yield* Ref.get(byThread)).get(threadId) ?? null;
    }),
    refusesRetry: Effect.fn("InferenceStops.refusesRetry")(function* (runId, nowMs) {
      const at = (yield* Ref.get(byRun)).get(runId);
      return at !== undefined && nowMs - at < RETRY_REFUSAL_MS;
    }),
  });
});

export const layer = Layer.effect(InferenceStops, make);
