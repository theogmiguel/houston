// The server's one verification slot, across projects: two verifications never run at once on
// this machine. Night shift's port takes the same slot.
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";

import { nowIso } from "./Store.ts";

export interface SlotHolder {
  readonly label: string;
  readonly projectId: string | null;
  readonly number: number | null;
  readonly since: string;
}

export class HoustonBuildSlot extends Context.Service<
  HoustonBuildSlot,
  {
    /** Runs `effect` in the slot, or returns none at once when another holder has it. */
    readonly withSlot: <A, E, R>(
      holder: string | Omit<SlotHolder, "since">,
      effect: Effect.Effect<A, E, R>,
    ) => Effect.Effect<Option.Option<A>, E, R>;
    /** Who holds the slot, by name. */
    readonly holder: Effect.Effect<string | null>;
    readonly current: Effect.Effect<SlotHolder | null>;
  }
>()("houston/houston/mergeQueue/BuildSlot/HoustonBuildSlot") {}

const make = Effect.gen(function* () {
  const state = yield* Ref.make<SlotHolder | null>(null);

  const withSlot: HoustonBuildSlot["Service"]["withSlot"] = (holder, effect) =>
    nowIso.pipe(
      Effect.flatMap((since) => {
        const taken: SlotHolder =
          typeof holder === "string"
            ? { label: holder, projectId: null, number: null, since }
            : { ...holder, since };
        return Effect.uninterruptibleMask((restore) =>
          Ref.modify(state, (current) =>
            current === null ? [true, taken] : [false, current],
          ).pipe(
            Effect.flatMap((acquired) =>
              acquired
                ? restore(effect).pipe(Effect.asSome, Effect.ensuring(Ref.set(state, null)))
                : Effect.succeed(Option.none<never>()),
            ),
          ),
        );
      }),
    );

  return HoustonBuildSlot.of({
    withSlot,
    holder: Ref.get(state).pipe(Effect.map((current) => current?.label ?? null)),
    current: Ref.get(state),
  });
});

export const layer = Layer.effect(HoustonBuildSlot, make);
