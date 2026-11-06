import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";

import { TrimmedNonEmptyString } from "../baseSchemas.ts";

// Datadog sites that accept OTLP directly. The two US government sites do not, so they cannot
// be chosen.
export const DATADOG_SITES = [
  "datadoghq.com",
  "us3.datadoghq.com",
  "us5.datadoghq.com",
  "datadoghq.eu",
  "ap1.datadoghq.com",
  "ap2.datadoghq.com",
  "uk1.datadoghq.com",
] as const;
export const DatadogSite = Schema.Literals(DATADOG_SITES);
export type DatadogSite = typeof DatadogSite.Type;

export const DATADOG_AGENT_DEFAULT = { host: "127.0.0.1", port: 4318 } as const;

/** Which signals the Datadog preset exports. Traces start on; metrics and logs start off. */
export const DatadogSignals = Schema.Struct({
  traces: Schema.Boolean,
  metrics: Schema.Boolean,
  logs: Schema.Boolean,
});
export type DatadogSignals = typeof DatadogSignals.Type;

export const HoustonObservabilityPreset = Schema.Union([
  Schema.TaggedStruct("Datadog", { site: DatadogSite, signals: DatadogSignals }),
  Schema.TaggedStruct("DatadogAgent", {
    host: TrimmedNonEmptyString,
    port: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65_535 })),
  }),
]);
export type HoustonObservabilityPreset = typeof HoustonObservabilityPreset.Type;

const isPreset = Schema.is(HoustonObservabilityPreset);

// A hand-edited preset this build cannot read becomes null here, so the rest of the settings still
// decode; startup logs why. Lenient on the encoded side too, which a decoding default checks.
export const LenientObservabilityPreset = Schema.Unknown.pipe(
  Schema.decodeTo(
    Schema.NullOr(HoustonObservabilityPreset),
    SchemaTransformation.transform({
      decode: (value): HoustonObservabilityPreset | null => (isPreset(value) ? value : null),
      encode: (preset) => preset,
    }),
  ),
);

/** The Datadog API key: 32 hexadecimal characters; the server refuses more than `maxBytes`. */
export const HOUSTON_DATADOG_KEY_LIMITS = { maxBytes: 256, chars: 32 } as const;

export const HoustonDatadogKeyInput = Schema.Struct({ key: Schema.String });
export type HoustonDatadogKeyInput = typeof HoustonDatadogKeyInput.Type;

export const HoustonObservabilityEmptyInput = Schema.Struct({});

/** Whether a key is stored. The key itself is never returned. */
export const HoustonDatadogKeyStatus = Schema.Struct({ present: Schema.Boolean });
export type HoustonDatadogKeyStatus = typeof HoustonDatadogKeyStatus.Type;

export const HoustonObservabilityErrorKind = Schema.Literals([
  "invalid",
  "secret_store_unavailable",
]);

/** A refusal. It never carries the key. */
export class HoustonObservabilityError extends Schema.TaggedError<HoustonObservabilityError>()(
  "HoustonObservabilityError",
  {
    kind: HoustonObservabilityErrorKind,
    message: Schema.String,
    operation: Schema.String,
  },
) {}
