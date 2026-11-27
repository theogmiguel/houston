import type { MessageDeliveryQueueHoldReason } from "@houston-app/contracts/houston/messageDelivery";
import type { RunStartOrigin } from "@houston-app/contracts";
import * as Effect from "effect/Effect";

/** A start the gate refused to perform now, with the typed reason the queue shows. */
export interface RunStartHold {
  readonly type: "hold";
  readonly reason: MessageDeliveryQueueHoldReason;
  /** When the hold is expected to release, in ISO 8601, or null when the provider reported no reset. */
  readonly releaseAt: string | null;
}

export type RunStartAdmission = { readonly type: "start" } | RunStartHold;

export type RunStartGateOutcome = { readonly type: "started" } | RunStartHold;

export interface RunStartGateInput {
  readonly origin: RunStartOrigin;
}

export interface RunStartGateSteps<Context, E = never, R = never> {
  /** The first step that can hold: a limit window, a budget reserve or a load hold. */
  readonly admission: (input: RunStartGateInput) => Effect.Effect<RunStartAdmission, E, R>;
  /** Prepare the run before it starts; a pass-through until the context work lands. */
  readonly context: (input: RunStartGateInput) => Effect.Effect<Context, E, R>;
  /** Hand the prepared context to the provider. */
  readonly start: (context: Context) => Effect.Effect<void, E, R>;
}

/** Only work someone asked for may be held; a typed send and provider output always start. */
export function skipsAdmission(origin: RunStartOrigin): boolean {
  return origin === "user" || origin === "provider";
}

/**
 * Every run start passes one gate under the thread lock: admission, then context, then start.
 * The first step that holds names the reason; later steps never run.
 */
export const runStartGate =
  <Context, E = never, R = never>(steps: RunStartGateSteps<Context, E, R>) =>
  (input: RunStartGateInput): Effect.Effect<RunStartGateOutcome, E, R> =>
    Effect.gen(function* () {
      const admission: RunStartAdmission = skipsAdmission(input.origin)
        ? { type: "start" }
        : yield* steps.admission(input);
      if (admission.type === "hold") return admission;
      const context = yield* steps.context(input);
      yield* steps.start(context);
      return { type: "started" } as const;
    });

/**
 * Ask the gate whether a start may proceed. The caller owns the start itself, because a start
 * is one transaction of domain events rather than a provider call.
 */
export const enterRunStartGate =
  <E = never, R = never>(input: {
    readonly origin: RunStartOrigin;
    readonly admission: () => Effect.Effect<RunStartAdmission, E, R>;
    readonly context: () => Effect.Effect<void, E, R>;
  }): Effect.Effect<RunStartAdmission, E, R> =>
    Effect.gen(function* () {
      const admission: RunStartAdmission = skipsAdmission(input.origin)
        ? { type: "start" }
        : yield* input.admission();
      if (admission.type === "hold") return admission;
      yield* input.context();
      return admission;
    });
