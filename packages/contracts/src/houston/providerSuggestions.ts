import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { IsoDateTime } from "../baseSchemas.ts";
import { ProviderDriverKind } from "../providerInstance.ts";

/**
 * Houston suggests turning on a local agent found on this machine without switching it on by
 * itself. `enabled` remembers an agent that was configured here, so removing its instance later
 * does not bring the suggestion back; `dismissed` is the user's answer to keep it off.
 */
export const LocalAgentSuggestionStatus = Schema.Literals(["suggested", "dismissed", "enabled"]);
export type LocalAgentSuggestionStatus = typeof LocalAgentSuggestionStatus.Type;

export const LocalAgentSuggestion = Schema.Struct({
  driver: ProviderDriverKind,
  status: LocalAgentSuggestionStatus,
  foundAt: IsoDateTime,
});
export type LocalAgentSuggestion = typeof LocalAgentSuggestion.Type;

export const LocalAgentSuggestions = Schema.Record(ProviderDriverKind, LocalAgentSuggestion).pipe(
  Schema.withDecodingDefault(Effect.succeed({})),
);
export type LocalAgentSuggestions = typeof LocalAgentSuggestions.Type;
