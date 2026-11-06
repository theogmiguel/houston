// Where each OTLP signal goes and with which headers. Environment, then the desktop bootstrap,
// then the settings preset, then the settings URLs decide the URL (cli/config.ts); this adds the
// preset's headers, reading the Datadog API key from the secret store when a signal is sent.
import {
  DATADOG_SITES,
  type DatadogSite,
  type HoustonObservabilityPreset,
} from "@houston-app/contracts/houston/observability";
import type { OtlpProtocol, SignalExport } from "@houston-app/shared/observability";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

import * as ServerConfig from "../../config.ts";
import { HoustonSecrets } from "../secrets/HoustonSecrets.ts";
import { DATADOG_KEY_SECRET } from "./DatadogKey.ts";

export type Signal = "traces" | "metrics" | "logs";

export interface SignalTarget {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>> | undefined;
  readonly protocol: OtlpProtocol;
  readonly exportIntervalMs: number;
  /** Datadog accepts delta metrics only. */
  readonly temporality: "delta" | "cumulative";
  readonly destination: "datadog" | "datadog-agent" | "otlp";
}

const intakeUrl = (site: DatadogSite, signal: Signal) => `https://otlp.${site}/v1/${signal}`;

/** The URL a preset gives a signal, or undefined when the preset does not export it. */
export const presetUrl = (
  preset: HoustonObservabilityPreset | undefined,
  signal: Signal,
): string | undefined => {
  if (preset === undefined) return undefined;
  if (preset._tag === "DatadogAgent") {
    const host = preset.host.includes(":") ? `[${preset.host}]` : preset.host;
    return `http://${host}:${preset.port}/v1/${signal}`;
  }
  return preset.signals[signal] ? intakeUrl(preset.site, signal) : undefined;
};

const INTAKE_URL = new RegExp(
  `^https://otlp\\.(${DATADOG_SITES.map((site) => site.replaceAll(".", "\\.")).join("|")})/v1/(traces|metrics|logs)$`,
);

/** True for a Datadog OTLP intake URL on a supported site: the only place the key is sent. */
export const isDatadogIntake = (url: string, signal: Signal): boolean =>
  INTAKE_URL.exec(url)?.[2] === signal;

/** The headers Datadog's OTLP intake needs for a signal. */
export const datadogHeaders = (signal: Signal, key: string): Record<string, string> => ({
  "dd-api-key": key,
  ...(signal === "traces" ? { compute_stats: "true" } : {}),
  ...(signal === "metrics"
    ? { "dd-otel-metric-config": JSON.stringify({ resource_attributes_as_tags: true }) }
    : {}),
});

export type DatadogKeyRead =
  | { readonly _tag: "Present"; readonly key: string }
  | { readonly _tag: "Absent" }
  /** The secret store failed; `reason` is its error message, which never holds the key. */
  | { readonly _tag: "Unreadable"; readonly reason: string };

/** Whether the Datadog API key is stored, absent, or unreadable because the secret store failed. */
export const readDatadogKeyState = Effect.fn("ObservabilityExport.readDatadogKeyState")(
  function* () {
    const secrets = yield* Effect.serviceOption(HoustonSecrets);
    if (Option.isNone(secrets)) return { _tag: "Absent" } as DatadogKeyRead;
    return yield* secrets.value.get(DATADOG_KEY_SECRET).pipe(
      Effect.map((stored): DatadogKeyRead =>
        Option.isSome(stored)
          ? { _tag: "Present", key: Redacted.value(stored.value) }
          : { _tag: "Absent" },
      ),
      Effect.catch((error) =>
        Effect.succeed<DatadogKeyRead>({ _tag: "Unreadable", reason: error.message }),
      ),
    );
  },
);

/** The stored Datadog API key, or none when there is no secret store, no key or it is unreadable. */
export const readDatadogKey = Effect.fn("ObservabilityExport.readDatadogKey")(function* () {
  const read = yield* readDatadogKeyState();
  return read._tag === "Present" ? Option.some(read.key) : Option.none<string>();
});

/** Why a Datadog signal is not exported, for a warning that never contains the key. */
export const pausedMessage = (
  signal: Signal,
  read: Exclude<DatadogKeyRead, { _tag: "Present" }>,
) =>
  read._tag === "Absent"
    ? `Datadog ${signal} export is off: no Datadog API key is stored (Settings, Diagnostics, OpenTelemetry export).`
    : `Datadog ${signal} export is off: the Datadog API key could not be read from the secret store (${read.reason}).`;

/**
 * The exporters' HTTP client with the key re-read before each request to a Datadog intake: the
 * exporters are built once at start-up, so removing the key stops their next export and
 * replacing it sends the new one. Requests to other URLs pass through unchanged. A warning is
 * logged each time the key turns absent or unreadable, and a note when it is back.
 */
export const datadogKeyGate = Effect.gen(function* () {
  const client = yield* HttpClient.HttpClient;
  const secrets = yield* Effect.serviceOption(HoustonSecrets);
  const currentKey = readDatadogKeyState().pipe(
    Option.isSome(secrets) ? Effect.provideService(HoustonSecrets, secrets.value) : (self) => self,
  );
  // The exporter exists because a key was stored at start-up.
  let last: DatadogKeyRead["_tag"] = "Present";
  const report = (signal: Signal, read: DatadogKeyRead) => {
    if (read._tag === last) return Effect.void;
    last = read._tag;
    return read._tag === "Present"
      ? Effect.logInfo(`Datadog ${signal} export resumed with the stored Datadog API key.`)
      : Effect.logWarning(pausedMessage(signal, read));
  };
  return HttpClient.transform(client, (response, request) => {
    const signal = INTAKE_URL.exec(request.url)?.[2] as Signal | undefined;
    if (signal === undefined) return response;
    return Effect.flatMap(currentKey, (read) =>
      Effect.andThen(
        report(signal, read),
        read._tag === "Present"
          ? client.execute(HttpClientRequest.setHeader(request, "dd-api-key", read.key))
          : // Dropped here, with a success status so the exporter does not retry it.
            Effect.succeed(
              HttpClientResponse.fromWeb(request, new Response(null, { status: 204 })),
            ),
      ),
    );
  });
});

/** Provides datadogKeyGate in place of the HTTP client an exporter would use. */
export const layerDatadogKeyGate = Layer.effect(HttpClient.HttpClient, datadogKeyGate);

const running = (config: ServerConfig.ServerConfig["Service"], signal: Signal) => {
  switch (signal) {
    case "traces":
      return {
        url: config.otlpTracesUrl,
        export: config.otlpTracesExport,
        source: config.otlpTracesSource,
      };
    case "metrics":
      return {
        url: config.otlpMetricsUrl,
        export: config.otlpMetricsExport,
        source: config.otlpMetricsSource,
      };
    case "logs":
      return {
        url: config.otlpLogsUrl,
        export: config.otlpLogsExport,
        source: config.otlpLogsSource,
      };
  }
};

const otlpTarget = (url: string, signalExport: SignalExport): SignalTarget => ({
  url,
  headers: signalExport.headers,
  protocol: signalExport.protocol,
  exportIntervalMs: signalExport.exportIntervalMs,
  temporality: "cumulative",
  destination: "otlp",
});

// The signal's export target, or undefined when it is not exported. A Datadog signal without a
// stored key is not exported, and a warning names the missing key.
export const resolve = Effect.fn("ObservabilityExport.resolve")(function* (
  signal: Signal,
  options: { readonly quiet?: boolean } = {},
) {
  const config = yield* ServerConfig.ServerConfig;
  const { url, export: signalExport, source } = running(config, signal);
  if (url === undefined) return undefined;
  const fromPreset = source === "settings" && url === presetUrl(config.otlpPreset, signal);
  if (!fromPreset || config.otlpPreset === undefined) return otlpTarget(url, signalExport);
  if (config.otlpPreset._tag === "DatadogAgent") {
    return {
      ...otlpTarget(url, signalExport),
      headers: undefined,
      protocol: "http/protobuf",
      destination: "datadog-agent",
    } satisfies SignalTarget;
  }
  const read = yield* readDatadogKeyState();
  if (read._tag !== "Present") {
    if (options.quiet === true) return undefined;
    yield* Effect.logWarning(pausedMessage(signal, read));
    return undefined;
  }
  return {
    url,
    headers: datadogHeaders(signal, read.key),
    protocol: "http/protobuf",
    exportIntervalMs: signalExport.exportIntervalMs,
    temporality: "delta",
    destination: "datadog",
  } satisfies SignalTarget;
});
