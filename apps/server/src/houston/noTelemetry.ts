import * as OtelEnvironment from "@t3tools/shared/otelEnvironment";

import type * as ServerConfig from "../config.ts";

type Config = ServerConfig.ServerConfig["Service"];

// Clears every OTLP endpoint whatever set it (environment, envelope or settings file),
// so no traces, metrics or logs leave the process.
export function withoutTelemetry(config: Config): Config {
  const {
    otlpTracesSource: _tracesSource,
    otlpTracesVariable: _tracesVariable,
    otlpMetricsSource: _metricsSource,
    otlpMetricsVariable: _metricsVariable,
    otlpLogsSource: _logsSource,
    otlpLogsVariable: _logsVariable,
    ...rest
  } = config;
  return {
    ...rest,
    otlpTracesUrl: undefined,
    otlpMetricsUrl: undefined,
    otlpLogsUrl: undefined,
    otelEnvironment: OtelEnvironment.none,
  };
}
