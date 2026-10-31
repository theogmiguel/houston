import * as Schema from "effect/Schema";

import { IsoDateTime, TrimmedNonEmptyString } from "../baseSchemas.ts";

// The same limits as a turn's provider failure, whose message and code these carry.
const ReadinessMessage = TrimmedNonEmptyString.check(Schema.isMaxLength(4_096));
const ReadinessCode = TrimmedNonEmptyString.check(Schema.isMaxLength(128));

/** The one state a provider instance is in, with its cause. */
export const ProviderReadiness = Schema.Union([
  Schema.Struct({
    state: Schema.Literal("notInstalled"),
    reason: Schema.Literals(["missing", "unusable"]),
    message: ReadinessMessage,
  }),
  Schema.Struct({
    state: Schema.Literal("turnedOff"),
    message: ReadinessMessage,
  }),
  Schema.Struct({
    state: Schema.Literal("signedOut"),
    source: Schema.Literals(["probe", "turn"]),
    message: ReadinessMessage,
  }),
  Schema.Struct({
    state: Schema.Literal("rejected"),
    code: ReadinessCode,
    message: ReadinessMessage,
    at: IsoDateTime,
  }),
  Schema.Struct({
    state: Schema.Literal("outOfUsage"),
    resetsAt: Schema.NullOr(IsoDateTime),
    message: ReadinessMessage,
    at: IsoDateTime,
  }),
  Schema.Struct({
    state: Schema.Literal("ready"),
  }),
]);
export type ProviderReadiness = typeof ProviderReadiness.Type;
export type ProviderReadinessState = ProviderReadiness["state"];
