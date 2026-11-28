import * as Schema from "effect/Schema";

/**
 * Who asked for a run to start. Only automatic work may be held before it reaches the provider;
 * a user send, provider output already in flight and maintenance work always start.
 */
export const RunStartOrigin = Schema.Literals(["user", "automatic", "provider", "maintenance"]);
export type RunStartOrigin = typeof RunStartOrigin.Type;
