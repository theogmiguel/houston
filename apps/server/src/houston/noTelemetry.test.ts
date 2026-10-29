// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { DesktopBackendBootstrap } from "@t3tools/contracts";
import * as NetService from "@t3tools/shared/Net";
import * as OtelEnvironment from "@t3tools/shared/otelEnvironment";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { type CliServerFlags, resolveServerConfig } from "../cli/config.ts";
import { withoutTelemetry } from "./noTelemetry.ts";

type Signal = "traces" | "metrics" | "logs";
type UrlKey = "otlpTracesUrl" | "otlpMetricsUrl" | "otlpLogsUrl";
type Source = "t3code-env" | "otel-env" | "envelope" | "settings";

const SIGNALS: ReadonlyArray<Signal> = ["traces", "metrics", "logs"];
const SOURCES: ReadonlyArray<Source> = ["t3code-env", "otel-env", "envelope", "settings"];
const SINK = "http://127.0.0.1:9/v1";

const capitalized = (signal: Signal) => `${signal[0]!.toUpperCase()}${signal.slice(1)}`;
const urlKey = (signal: Signal) => `otlp${capitalized(signal)}Url` as UrlKey;
const encodeEnvelope = Schema.encodeEffect(Schema.fromJsonString(DesktopBackendBootstrap));

const desktopFlags = (bootstrapFd: number): CliServerFlags => ({
  mode: Option.none(),
  port: Option.none(),
  host: Option.none(),
  baseDir: Option.none(),
  cwd: Option.none(),
  devUrl: Option.none(),
  noBrowser: Option.none(),
  bootstrapFd: Option.some(bootstrapFd),
  autoBootstrapProjectFromCwd: Option.none(),
  logWebSocketEvents: Option.none(),
  tailscaleServeEnabled: Option.none(),
  tailscaleServePort: Option.none(),
});

const resolveWith = Effect.fn(function* (sources: ReadonlyArray<[Source, Signal]>) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const base = yield* fs.makeTempDirectoryScoped({ prefix: "houston-no-telemetry-" });
  const env: Record<string, string> = {};
  const envelopeUrls: Record<string, string> = {};
  const settingsUrls: Record<string, string> = {};
  for (const [source, signal] of sources) {
    const url = `${SINK}/${signal}`;
    if (source === "t3code-env") env[`T3CODE_OTLP_${signal.toUpperCase()}_URL`] = url;
    if (source === "otel-env") env[`OTEL_EXPORTER_OTLP_${signal.toUpperCase()}_ENDPOINT`] = url;
    if (source === "envelope") envelopeUrls[`otlp${capitalized(signal)}Url`] = url;
    if (source === "settings") settingsUrls[`otlp${capitalized(signal)}Url`] = url;
  }
  if (Object.keys(settingsUrls).length > 0) {
    yield* fs.makeDirectory(path.join(base, "userdata"), { recursive: true });
    yield* fs.writeFileString(
      path.join(base, "userdata", "settings.json"),
      `${JSON.stringify({ observability: settingsUrls })}\n`,
    );
  }
  const envelopePath = path.join(base, "envelope.ndjson");
  const encoded = yield* encodeEnvelope({
    mode: "desktop",
    noBrowser: true,
    port: 4888,
    t3Home: base,
    host: "127.0.0.1",
    desktopBootstrapToken: "token",
    tailscaleServeEnabled: false,
    tailscaleServePort: 443,
    ...envelopeUrls,
  });
  yield* fs.writeFileString(envelopePath, `${encoded}\n`);
  const fd = yield* Effect.acquireRelease(
    Effect.sync(() => NodeFS.openSync(envelopePath, "r")),
    (fd) =>
      Effect.sync(() => {
        try {
          NodeFS.closeSync(fd);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EBADF") throw error;
        }
      }),
  );
  return yield* resolveServerConfig(desktopFlags(fd), Option.none()).pipe(
    Effect.provide(
      Layer.mergeAll(ConfigProvider.layer(ConfigProvider.fromEnv({ env })), NetService.layer),
    ),
  );
});

const ROWS: ReadonlyArray<{ readonly name: string; readonly sources: Array<[Source, Signal]> }> = [
  ...SOURCES.flatMap((source) =>
    SIGNALS.map((signal) => ({
      name: `${source} ${signal}`,
      sources: [[source, signal]] as Array<[Source, Signal]>,
    })),
  ),
  {
    name: "every source at once",
    sources: SOURCES.flatMap((source) =>
      SIGNALS.map((signal) => [source, signal] as [Source, Signal]),
    ),
  },
];

it.layer(NodeServices.layer)("houston no telemetry", (it) => {
  it.effect("every OTLP source resolves to no export", () =>
    Effect.gen(function* () {
      expect(ROWS).toHaveLength(13);
      for (const row of ROWS) {
        const upstream = yield* resolveWith(row.sources);
        // The row is a live source: upstream alone would export it.
        for (const [, signal] of row.sources) {
          expect(upstream[urlKey(signal)], row.name).toBe(`${SINK}/${signal}`);
        }

        const cleared = withoutTelemetry(upstream);
        expect(cleared.otlpTracesUrl, row.name).toBeUndefined();
        expect(cleared.otlpMetricsUrl, row.name).toBeUndefined();
        expect(cleared.otlpLogsUrl, row.name).toBeUndefined();
        for (const signal of SIGNALS) {
          expect(cleared, row.name).not.toHaveProperty(`otlp${capitalized(signal)}Source`);
          expect(cleared, row.name).not.toHaveProperty(`otlp${capitalized(signal)}Variable`);
        }
        expect(cleared.otelEnvironment, row.name).toEqual(OtelEnvironment.none);
        // Nothing but telemetry changes.
        expect(cleared.baseDir, row.name).toBe(upstream.baseDir);
        expect(cleared.port, row.name).toBe(upstream.port);
      }
    }),
  );
});
