import * as Schema from "effect/Schema";

/** Who answered a runtime request, set only by the server; a missing value reads as `server`. */
export const RuntimeRequestAnsweredBy = Schema.Literals(["user", "agent", "server"]);
export type RuntimeRequestAnsweredBy = typeof RuntimeRequestAnsweredBy.Type;
