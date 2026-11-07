// The Datadog API key the Datadog preset sends. It lives in the server's secret store and is
// never returned, logged or traced; RPCs report only whether one is stored.
import {
  HOUSTON_DATADOG_KEY_LIMITS,
  type HoustonDatadogKeyStatus,
  HoustonObservabilityError,
} from "@houston-app/contracts/houston/observability";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";

import { HoustonSecrets, type SecretStoreUnavailable } from "../secrets/HoustonSecrets.ts";

export const DATADOG_KEY_SECRET = "observability-datadog-api-key";
const KEY_SHAPE = /^[0-9a-fA-F]{32}$/;

// Looked up per call, so a context without a secret store refuses by name instead of requiring one.
const secretsFor = (operation: string) =>
  Effect.flatMap(Effect.serviceOption(HoustonSecrets), (secrets) =>
    Effect.fromOption(secrets).pipe(
      Effect.mapError(
        () =>
          new HoustonObservabilityError({
            kind: "secret_store_unavailable",
            message: "This server has no secret store.",
            operation,
          }),
      ),
    ),
  );

const storeFailure = (operation: string) => (error: SecretStoreUnavailable) =>
  new HoustonObservabilityError({
    kind: "secret_store_unavailable",
    message: error.message,
    operation,
  });

/** Refuses a key by its length and the expected shape; the message never repeats the key. */
const validate = (key: string): Effect.Effect<string, HoustonObservabilityError> => {
  const trimmed = key.trim();
  const bytes = new TextEncoder().encode(key).byteLength;
  if (bytes > HOUSTON_DATADOG_KEY_LIMITS.maxBytes) {
    return Effect.fail(
      new HoustonObservabilityError({
        kind: "invalid",
        operation: "store the Datadog API key",
        message: `The Datadog API key is ${bytes} bytes; the limit is ${HOUSTON_DATADOG_KEY_LIMITS.maxBytes} bytes, and a key is ${HOUSTON_DATADOG_KEY_LIMITS.chars} hexadecimal characters.`,
      }),
    );
  }
  if (!KEY_SHAPE.test(trimmed)) {
    return Effect.fail(
      new HoustonObservabilityError({
        kind: "invalid",
        operation: "store the Datadog API key",
        message: `The Datadog API key has ${trimmed.length} characters; expected ${HOUSTON_DATADOG_KEY_LIMITS.chars} hexadecimal characters (0-9, a-f).`,
      }),
    );
  }
  return Effect.succeed(trimmed);
};

export const set = Effect.fn("DatadogKey.set")(function* (key: string) {
  const valid = yield* validate(key);
  const secrets = yield* secretsFor("store the Datadog API key");
  yield* secrets
    .set(DATADOG_KEY_SECRET, Redacted.make(valid))
    .pipe(Effect.mapError(storeFailure("store the Datadog API key")));
  return { present: true } satisfies HoustonDatadogKeyStatus;
});

export const clear = Effect.fn("DatadogKey.clear")(function* () {
  const secrets = yield* secretsFor("remove the Datadog API key");
  yield* secrets
    .remove(DATADOG_KEY_SECRET)
    .pipe(Effect.mapError(storeFailure("remove the Datadog API key")));
  return { present: false } satisfies HoustonDatadogKeyStatus;
});

export const status = Effect.fn("DatadogKey.status")(function* () {
  const secrets = yield* secretsFor("read the Datadog API key");
  const stored = yield* secrets
    .get(DATADOG_KEY_SECRET)
    .pipe(Effect.mapError(storeFailure("read the Datadog API key")));
  return { present: Option.isSome(stored) } satisfies HoustonDatadogKeyStatus;
});

/** The stored key, or none when absent or unreadable. */
export const read = Effect.fn("DatadogKey.read")(function* () {
  const secrets = yield* HoustonSecrets;
  return yield* secrets.get(DATADOG_KEY_SECRET).pipe(Effect.orElseSucceed(() => Option.none()));
});
