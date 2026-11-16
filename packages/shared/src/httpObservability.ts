import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Headers from "effect/http/Headers";
import * as UrlParams from "effect/http/UrlParams";

export const layer = Layer.mergeAll(
  Layer.effect(
    Headers.CurrentRedactedNames,
    // `expo-session` carries the `eas login` session secret on Expo API requests; `dd-api-key`
    // carries the Datadog API key on OTLP exports to a Datadog intake.
    Effect.map(Headers.CurrentRedactedNames, (names) => [
      ...names,
      "dpop",
      "expo-session",
      "dd-api-key",
    ]),
  ),
  Layer.effect(
    UrlParams.CurrentRedactedNames,
    // Socket tickets and proofs, pairing tokens, and OAuth codes travel in query strings.
    Effect.map(UrlParams.CurrentRedactedNames, (names) => [
      ...names,
      "wsTicket",
      "dpop",
      "token",
      "pairingUrl",
      "code",
      "state",
      "challenge",
    ]),
  ),
);
