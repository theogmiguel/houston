import type {
  OtlpEndpointCheckInput,
  OtlpEndpointCheckResult,
  OtlpSignal,
} from "@houston-app/contracts";
import { layerOtlpSerialization } from "@houston-app/shared/observability";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { FetchHttpClient, HttpClient } from "effect/http";
import { OtlpSerialization } from "effect/observability";

import * as ServerConfig from "../config.ts";
import * as ObservabilityExport from "../houston/observability/ObservabilityExport.ts";

const CHECK_TIMEOUT = "5 seconds";

export class OtlpEndpointCheck extends Context.Service<
  OtlpEndpointCheck,
  {
    readonly check: (input: OtlpEndpointCheckInput) => Effect.Effect<OtlpEndpointCheckResult>;
  }
>()("@houston-app/cli/observability/OtlpEndpointCheck") {}

const emptyExport = (
  serialization: OtlpSerialization.OtlpSerialization["Service"],
  signal: OtlpSignal,
) => {
  switch (signal) {
    case "traces":
      return serialization.traces({ resourceSpans: [] });
    case "metrics":
      return serialization.metrics({ resourceMetrics: [] });
    case "logs":
      return serialization.logs({ resourceLogs: [] });
  }
};

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const httpClient = yield* HttpClient.HttpClient;

  const running = {
    traces: { url: config.otlpTracesUrl, export: config.otlpTracesExport },
    metrics: { url: config.otlpMetricsUrl, export: config.otlpMetricsExport },
    logs: { url: config.otlpLogsUrl, export: config.otlpLogsExport },
  } satisfies Record<OtlpSignal, unknown>;

  const check = Effect.fn("OtlpEndpointCheck.check")(function* ({
    signal,
    url,
  }: OtlpEndpointCheckInput) {
    const { url: runningUrl, export: signalExport } = running[signal];
    // Houston: a Datadog intake gets the stored key, and only Datadog's own host receives it.
    const datadogKey = ObservabilityExport.isDatadogIntake(url, signal)
      ? Option.getOrUndefined(yield* ObservabilityExport.readDatadogKey())
      : undefined;
    const headers =
      datadogKey !== undefined
        ? ObservabilityExport.datadogHeaders(signal, datadogKey)
        : url === runningUrl
          ? signalExport.headers
          : undefined;
    const protocol = ObservabilityExport.isDatadogIntake(url, signal)
      ? "http/protobuf"
      : signalExport.protocol;
    const body = yield* Effect.gen(function* () {
      const serialization = yield* OtlpSerialization.OtlpSerialization;
      return emptyExport(serialization, signal);
    }).pipe(Effect.provide(layerOtlpSerialization(protocol)));
    const startedAt = yield* Clock.currentTimeMillis;
    // Close after reading status so open bodies cannot hang; disable tracing to keep URLs and credentials out of spans.
    const response = yield* HttpClient.withScope(httpClient)
      .post(url, { body, headers })
      .pipe(
        Effect.map(({ status }) => ({ status })),
        Effect.scoped,
        Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
        Effect.withTracerEnabled(false),
        Effect.timeoutOption(CHECK_TIMEOUT),
        Effect.option,
      );
    if (Option.isNone(response)) {
      return { _tag: "Unreachable", timedOut: false } as const;
    }
    if (Option.isNone(response.value)) {
      return { _tag: "Unreachable", timedOut: true } as const;
    }
    const { status } = response.value.value;
    if (status < 200 || status >= 300) {
      return { _tag: "Rejected", status } as const;
    }
    const latencyMs = (yield* Clock.currentTimeMillis) - startedAt;
    return { _tag: "Accepted", latencyMs } as const;
  });

  return OtlpEndpointCheck.of({ check });
});

export const layer = Layer.effect(OtlpEndpointCheck, make);
