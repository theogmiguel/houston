import type { InferenceModelImageSupport } from "@houston-app/contracts/houston/inference";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";

interface Verdict {
  readonly supported: boolean;
  readonly checkedAt: string;
}

/** One stored verdict, for a layer that starts from something already remembered. */
export interface RememberedVerdict {
  readonly address: string;
  readonly model: string;
  readonly supported: boolean;
  readonly checkedAt: string;
}

/** What Houston's image checks found, by server address and model, kept across restarts. */
export class InferenceImageVerdicts extends Context.Service<
  InferenceImageVerdicts,
  {
    /** Verdicts for the models at `address`; clients show their age and offer to check again. */
    readonly forAddress: (
      address: string,
    ) => Effect.Effect<(model: string) => InferenceModelImageSupport | undefined>;
    readonly record: (address: string, model: string, supported: boolean) => Effect.Effect<void>;
  }
>()("@houston-app/cli/houston/inference/InferenceImageVerdicts") {}

const keyOf = (address: string, model: string) => JSON.stringify([address, model]);

const makeWith = Effect.fn("InferenceImageVerdicts.make")(function* (
  initial: ReadonlyMap<string, Verdict>,
  persist: (address: string, model: string, verdict: Verdict) => Effect.Effect<void>,
) {
  const verdicts = yield* Ref.make(initial);
  // Updates and their writes go one at a time, so an older write never lands last.
  const writes = yield* Semaphore.make(1);
  return InferenceImageVerdicts.of({
    forAddress: Effect.fn("InferenceImageVerdicts.forAddress")(function* (address) {
      const all = yield* Ref.get(verdicts);
      return (model) => {
        const verdict = all.get(keyOf(address, model));
        return verdict === undefined
          ? undefined
          : {
              supported: verdict.supported,
              source: "checked" as const,
              checkedAt: verdict.checkedAt,
            };
      };
    }),
    record: Effect.fn("InferenceImageVerdicts.record")(function* (address, model, supported) {
      yield* writes.withPermits(1)(
        Effect.gen(function* () {
          const verdict: Verdict = {
            supported,
            checkedAt: DateTime.formatIso(yield* DateTime.now),
          };
          yield* Ref.update(verdicts, (all) => new Map(all).set(keyOf(address, model), verdict));
          // A lost write only means the model is checked again after a restart.
          yield* persist(address, model, verdict);
        }),
      );
    }),
  });
});

const asVerdict = (remembered: RememberedVerdict): readonly [string, Verdict] => [
  keyOf(remembered.address, remembered.model),
  { supported: remembered.supported, checkedAt: remembered.checkedAt },
];

/** Keeps verdicts in the channel database. */
export const layer = Layer.effect(
  InferenceImageVerdicts,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{
      readonly server_address: string;
      readonly model: string;
      readonly supported: number;
      readonly checked_at: string;
    }>`SELECT server_address, model, supported, checked_at FROM houston_inference_image_verdicts`;
    return yield* makeWith(
      new Map(
        rows.map((row) => [
          keyOf(row.server_address, row.model),
          { supported: row.supported !== 0, checkedAt: row.checked_at },
        ]),
      ),
      (address, model, verdict) =>
        sql`
          INSERT INTO houston_inference_image_verdicts (server_address, model, supported, checked_at)
          VALUES (${address}, ${model}, ${verdict.supported ? 1 : 0}, ${verdict.checkedAt})
          ON CONFLICT (server_address, model)
          DO UPDATE SET supported = excluded.supported, checked_at = excluded.checked_at
        `.pipe(
          Effect.asVoid,
          Effect.catch((error) =>
            Effect.logWarning("Houston could not save an image-check verdict", error).pipe(
              Effect.asVoid,
            ),
          ),
        ),
    );
  }),
);

/** Keeps verdicts in memory only, for tests. */
export const layerMemory = (initial: ReadonlyArray<RememberedVerdict> = []) =>
  Layer.effect(
    InferenceImageVerdicts,
    makeWith(new Map(initial.map(asVerdict)), () => Effect.void),
  );

export const __testing = { makeWith };
