import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "../baseSchemas.ts";

/** The work a provider session still runs, as a provider-switch refusal lists it. */
export const HoustonBlockingBackgroundWorkKind = Schema.Literals(["command", "subagent"]);
export type HoustonBlockingBackgroundWorkKind = typeof HoustonBlockingBackgroundWorkKind.Type;

export const HoustonBlockingBackgroundWork = Schema.Struct({
  kind: HoustonBlockingBackgroundWorkKind,
  /** What the item is; absent when the provider did not name it. */
  description: Schema.optionalKey(TrimmedNonEmptyString),
  /** When the item started; null when the provider does not report it. */
  startedAt: Schema.NullOr(Schema.DateTimeUtc),
});
export type HoustonBlockingBackgroundWork = typeof HoustonBlockingBackgroundWork.Type;
