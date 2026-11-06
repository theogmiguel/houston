import * as HostProcess from "@houston-app/shared/HostProcess";
import * as HttpObservability from "@houston-app/shared/httpObservability";
import { makeLocalFileTracer, makeTraceSink } from "@houston-app/shared/observability";
import * as SharedObservability from "@houston-app/shared/observability";
import * as OtelEnvironment from "@houston-app/shared/otelEnvironment";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as References from "effect/References";
import * as Tracer from "effect/Tracer";
import * as OtlpExporter from "effect/observability/OtlpExporter";
import * as OtlpMetrics from "effect/observability/OtlpMetrics";
import * as OtlpTracer from "effect/observability/OtlpTracer";
import * as Statement from "effect/sql/Statement";
import * as CodexProtocol from "effect-codex-app-server/protocol";

import * as ServerConfig from "../config.ts";
import * as ResourceAttribution from "../resourceTelemetry/ResourceAttribution.ts";
import * as ServerLogger from "../serverLogger.ts";
import * as ExportRedaction from "../houston/observability/ExportRedaction.ts";
import * as ExportTracer from "../houston/observability/ExportTracer.ts";
import * as ObservabilityExport from "../houston/observability/ObservabilityExport.ts";
import * as UnsampledSpans from "../houston/observability/UnsampledSpans.ts";
import * as BrowserTraceCollector from "./BrowserTraceCollector.ts";
import * as HeapAttribution from "./HeapAttribution.ts";
import { RPC_SPANS_UNSAMPLED } from "./RpcInstrumentation.ts";

export const layer = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;

    // Houston: each signal's URL, headers and protocol, including a Datadog preset's.
    const traces = yield* ObservabilityExport.resolve("traces");
    const metrics = yield* ObservabilityExport.resolve("metrics");
    // Keep serialization in context for the browser trace forwarder's exporter.
    const layerSerialization = SharedObservability.layerOtlpSerialization(
      traces?.protocol ?? config.otlpTracesExport.protocol,
    );
    const resource = ExportRedaction.exportedResource(
      ServerConfig.otlpResource(config, yield* HostProcess.Hostname),
    );
    const attribution = yield* ResourceAttribution.ResourceAttribution;

    const layerTraceReferences = Layer.mergeAll(
      Layer.succeed(Tracer.MinimumTraceLevel, config.traceMinLevel),
      Layer.succeed(References.TracerTimingEnabled, config.traceTimingEnabled),
      // Preserve SQL spans while awaiting connections so lock waits can be recorded on them.
      Layer.succeed(Statement.SpanPropagationEnabled, true),
      // Houston: the Codex app-server receives trace context only while traces are exported.
      Layer.succeed(CodexProtocol.PropagateTraceContext, traces !== undefined),
      HttpObservability.layer,
    );

    const layerTracer = Layer.unwrap(
      Effect.gen(function* () {
        const sink = yield* makeTraceSink({
          filePath: config.serverTracePath,
          maxBytes: config.traceMaxBytes,
          maxFiles: config.traceMaxFiles,
          batchWindowMs: config.traceBatchWindowMs,
          onFlush: (stats) =>
            attribution.record({
              component: "server-trace",
              operation: "append",
              logicalWriteBytes: stats.logicalWriteBytes,
              count: stats.count,
              durationMs: stats.durationMs,
            }),
        });
        const delegate =
          traces === undefined
            ? undefined
            : ExportTracer.make(
                yield* OtlpTracer.make({
                  url: traces.url,
                  exportInterval: `${traces.exportIntervalMs} millis`,
                  headers: traces.headers,
                  resource,
                }),
              );

        const tracer = yield* makeLocalFileTracer({
          filePath: config.serverTracePath,
          maxBytes: config.traceMaxBytes,
          maxFiles: config.traceMaxFiles,
          batchWindowMs: config.traceBatchWindowMs,
          sink,
          ...(delegate ? { delegate } : {}),
        });

        const heapAttribution = yield* HeapAttribution.make(
          UnsampledSpans.make(tracer, RPC_SPANS_UNSAMPLED),
        );
        yield* heapAttribution.run;

        return Layer.mergeAll(
          Layer.succeed(Tracer.Tracer, heapAttribution.tracer),
          BrowserTraceCollector.layer(sink),
        );
      }),
    ).pipe(Layer.provide(OtlpExporter.layerFlusher), Layer.provideMerge(layerSerialization));

    const metricsLayer =
      metrics === undefined
        ? Layer.empty
        : OtlpMetrics.layer({
            url: metrics.url,
            exportInterval: `${metrics.exportIntervalMs} millis`,
            headers: metrics.headers,
            temporality: metrics.temporality,
            resource,
          }).pipe(Layer.provide(SharedObservability.layerOtlpSerialization(metrics.protocol)));

    const layerOtelWarnings = Layer.effectDiscard(
      Effect.forEach(config.otelEnvironment.warnings, (warning) => Effect.logWarning(warning)),
    );

    return layerOtelWarnings.pipe(
      Layer.provideMerge(
        Layer.mergeAll(ServerLogger.layer, layerTraceReferences, layerTracer, metricsLayer),
      ),
      Layer.provide(
        OtelEnvironment.layerResourceAttributes(
          ExportRedaction.exportedResourceAttributes(config.otelEnvironment.resourceAttributes),
        ),
      ),
    );
  }),
);
