// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { DesktopBackendBootstrap } from "@houston-app/contracts";
import {
  HoustonObservabilityPreset,
  type HoustonObservabilityPreset as Preset,
} from "@houston-app/contracts/houston/observability";
import * as NetService from "@houston-app/shared/Net";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

import { type CliServerFlags, resolveServerConfig } from "../../cli/config.ts";
import * as ServerConfig from "../../config.ts";
import * as OtlpEndpointCheck from "../../observability/OtlpEndpointCheck.ts";
import * as HoustonSecrets from "../secrets/HoustonSecrets.ts";
import * as DatadogKey from "./DatadogKey.ts";
import * as ObservabilityExport from "./ObservabilityExport.ts";

const KEY = "0123456789abcdef0123456789abcdef";
const DATADOG: Preset = {
  _tag: "Datadog",
  site: "us5.datadoghq.com",
  signals: { traces: true, metrics: true, logs: false },
};
const encodeEnvelope = Schema.encodeEffect(Schema.fromJsonString(DesktopBackendBootstrap));
const isPreset = Schema.is(HoustonObservabilityPreset);

const flags = (bootstrapFd: number): CliServerFlags => ({
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
  lan: Option.none(),
});

// Resolves the server config from settings.json, the environment and a desktop bootstrap.
const resolveWith = Effect.fn(function* (input: {
  readonly observability?: unknown;
  readonly env?: Record<string, string>;
  readonly bootstrapTracesUrl?: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const base = yield* fs.makeTempDirectoryScoped({ prefix: "houston-datadog-" });
  if (input.observability !== undefined) {
    yield* fs.makeDirectory(path.join(base, "userdata"), { recursive: true });
    yield* fs.writeFileString(
      path.join(base, "userdata", "settings.json"),
      `${JSON.stringify({ observability: input.observability })}\n`,
    );
  }
  const envelopePath = path.join(base, "envelope.ndjson");
  const encoded = yield* encodeEnvelope({
    mode: "desktop",
    noBrowser: true,
    port: 4888,
    houstonHome: base,
    host: "127.0.0.1",
    desktopBootstrapToken: "token",
    tailscaleServeEnabled: false,
    tailscaleServePort: 443,
    ...(input.bootstrapTracesUrl === undefined ? {} : { otlpTracesUrl: input.bootstrapTracesUrl }),
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
  return yield* resolveServerConfig(flags(fd), Option.none()).pipe(
    Effect.provide(
      Layer.mergeAll(
        ConfigProvider.layer(ConfigProvider.fromEnv({ env: input.env ?? {} })),
        NetService.layer,
      ),
    ),
  );
});

const withSecrets = (entries: Record<string, string>) => {
  const memory = HoustonSecrets.makeMemory();
  for (const [name, value] of Object.entries(entries)) memory.entries.set(name, value);
  return { memory, layer: HoustonSecrets.layerMemory(memory) };
};

it.layer(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))("Datadog preset", (it) => {
  it.effect(
    "environment, then bootstrap, then the preset, then settings URLs decide each URL",
    () =>
      Effect.gen(function* () {
        const preset = yield* resolveWith({
          observability: { otlpTracesUrl: "http://127.0.0.1:9/v1/traces", preset: DATADOG },
        });
        assert.strictEqual(preset.otlpTracesUrl, "https://otlp.us5.datadoghq.com/v1/traces");
        assert.strictEqual(preset.otlpMetricsUrl, "https://otlp.us5.datadoghq.com/v1/metrics");
        assert.isUndefined(preset.otlpLogsUrl);
        assert.deepStrictEqual(preset.otlpPreset, DATADOG);

        const bootstrap = yield* resolveWith({
          observability: { preset: DATADOG },
          bootstrapTracesUrl: "http://127.0.0.1:9/bootstrap",
        });
        assert.strictEqual(bootstrap.otlpTracesUrl, "http://127.0.0.1:9/bootstrap");

        const env = yield* resolveWith({
          observability: { preset: DATADOG },
          env: { HOUSTON_OTLP_TRACES_URL: "http://127.0.0.1:9/env" },
          bootstrapTracesUrl: "http://127.0.0.1:9/bootstrap",
        });
        assert.strictEqual(env.otlpTracesUrl, "http://127.0.0.1:9/env");

        const agent = yield* resolveWith({
          observability: { preset: { _tag: "DatadogAgent", host: "127.0.0.1", port: 4318 } },
        });
        assert.strictEqual(agent.otlpLogsUrl, "http://127.0.0.1:4318/v1/logs");
      }),
  );

  it.effect("ignores an unsupported site and names it and the supported sites", () =>
    Effect.gen(function* () {
      const config = yield* resolveWith({
        observability: {
          otlpLogsUrl: "http://127.0.0.1:9/v1/logs",
          preset: { _tag: "Datadog", site: "ddog-gov.com", signals: DATADOG.signals },
        },
      });
      // The rest of the settings still load.
      assert.strictEqual(config.otlpLogsUrl, "http://127.0.0.1:9/v1/logs");
      assert.isUndefined(config.otlpTracesUrl);
      assert.isUndefined(config.otlpPreset);
      const warning = config.otelEnvironment.warnings.find((text) => text.includes("ddog-gov.com"));
      assert.isDefined(warning);
      assert.include(warning!, "datadoghq.eu");
      assert.isFalse(isPreset({ ...DATADOG, site: "ddog-gov.com" }));
    }),
  );

  it.effect("a Datadog signal sends the stored key, protobuf and delta metrics", () =>
    Effect.gen(function* () {
      const config = yield* resolveWith({ observability: { preset: DATADOG } });
      const { layer } = withSecrets({ [DatadogKey.DATADOG_KEY_SECRET]: KEY });
      const traces = yield* ObservabilityExport.resolve("traces").pipe(
        Effect.provideService(ServerConfig.ServerConfig, config),
        Effect.provide(layer),
      );
      const metrics = yield* ObservabilityExport.resolve("metrics").pipe(
        Effect.provideService(ServerConfig.ServerConfig, config),
        Effect.provide(layer),
      );
      assert.deepStrictEqual(traces, {
        url: "https://otlp.us5.datadoghq.com/v1/traces",
        headers: { "dd-api-key": KEY, compute_stats: "true" },
        protocol: "http/protobuf",
        exportIntervalMs: config.otlpTracesExport.exportIntervalMs,
        temporality: "delta",
        destination: "datadog",
      });
      assert.strictEqual(metrics?.temporality, "delta");
      assert.strictEqual(
        metrics?.headers?.["dd-otel-metric-config"],
        '{"resource_attributes_as_tags":true}',
      );
      // The key never enters the server config.
      assert.notInclude(JSON.stringify(config), KEY);
    }),
  );

  it.effect("exports nothing to Datadog without a key, and never sends the key elsewhere", () =>
    Effect.gen(function* () {
      const config = yield* resolveWith({ observability: { preset: DATADOG } });
      const missing = yield* ObservabilityExport.resolve("traces", { quiet: true }).pipe(
        Effect.provideService(ServerConfig.ServerConfig, config),
        Effect.provide(withSecrets({}).layer),
      );
      assert.isUndefined(missing);

      const own = yield* resolveWith({
        observability: { preset: DATADOG },
        env: { HOUSTON_OTLP_TRACES_URL: "http://127.0.0.1:9/env" },
      });
      const target = yield* ObservabilityExport.resolve("traces").pipe(
        Effect.provideService(ServerConfig.ServerConfig, own),
        Effect.provide(withSecrets({ [DatadogKey.DATADOG_KEY_SECRET]: KEY }).layer),
      );
      assert.strictEqual(target?.destination, "otlp");
      assert.notInclude(JSON.stringify(target), KEY);
    }),
  );

  it.effect(
    "a signal the Datadog preset leaves off goes to its settings URL, without the key",
    () =>
      Effect.gen(function* () {
        const config = yield* resolveWith({
          observability: { otlpLogsUrl: "http://127.0.0.1:9/v1/logs", preset: DATADOG },
        });
        assert.strictEqual(config.otlpLogsUrl, "http://127.0.0.1:9/v1/logs");
        const logs = yield* ObservabilityExport.resolve("logs").pipe(
          Effect.provideService(ServerConfig.ServerConfig, config),
          Effect.provide(withSecrets({ [DatadogKey.DATADOG_KEY_SECRET]: KEY }).layer),
        );
        assert.strictEqual(logs?.destination, "otlp");
        assert.notInclude(JSON.stringify(logs), KEY);
      }),
  );

  it.effect("removing or replacing the key applies to the next export without a restart", () =>
    Effect.gen(function* () {
      const sent: Array<{ readonly url: string; readonly key: string | undefined }> = [];
      const client = HttpClient.make((request) =>
        Effect.sync(() => {
          sent.push({ url: request.url, key: request.headers["dd-api-key"] });
          return HttpClientResponse.fromWeb(request, new Response(null, { status: 202 }));
        }),
      );
      const { memory, layer } = withSecrets({ [DatadogKey.DATADOG_KEY_SECRET]: KEY });
      const gated = yield* ObservabilityExport.datadogKeyGate.pipe(
        Effect.provideService(HttpClient.HttpClient, client),
        Effect.provide(layer),
      );
      const intake = "https://otlp.us5.datadoghq.com/v1/traces";
      // The exporter was built with the key it had at start-up.
      const post = (url: string) =>
        gated.post(url, { headers: { "dd-api-key": KEY } }).pipe(Effect.map((r) => r.status));
      assert.strictEqual(yield* post(intake), 202);
      const replaced = "fedcba9876543210fedcba9876543210";
      memory.entries.set(DatadogKey.DATADOG_KEY_SECRET, replaced);
      yield* post(intake);
      yield* DatadogKey.clear().pipe(Effect.provide(layer));
      assert.isTrue((yield* post(intake)) < 300);
      yield* post("http://127.0.0.1:9/v1/traces");
      assert.deepStrictEqual(sent, [
        { url: intake, key: KEY },
        { url: intake, key: replaced },
        { url: "http://127.0.0.1:9/v1/traces", key: KEY },
      ]);
    }),
  );

  it.effect("the Test button sends the key to a Datadog intake only", () =>
    Effect.gen(function* () {
      const config = yield* resolveWith({});
      const sent: Array<{ readonly url: string; readonly headers: Record<string, string> }> = [];
      const client = HttpClient.make((request) =>
        Effect.sync(() => {
          sent.push({ url: request.url, headers: { ...request.headers } });
          return HttpClientResponse.fromWeb(request, new Response(null, { status: 202 }));
        }),
      );
      const check = yield* OtlpEndpointCheck.OtlpEndpointCheck.pipe(
        Effect.provide(OtlpEndpointCheck.layer),
        Effect.provideService(HttpClient.HttpClient, client),
        Effect.provideService(ServerConfig.ServerConfig, config),
      );
      const { layer } = withSecrets({ [DatadogKey.DATADOG_KEY_SECRET]: KEY });
      const accepted = yield* check
        .check({ signal: "traces", url: "https://otlp.datadoghq.eu/v1/traces" })
        .pipe(Effect.provide(layer));
      yield* check
        .check({ signal: "traces", url: "https://otlp.datadoghq.eu.example.com/v1/traces" })
        .pipe(Effect.provide(layer));
      assert.strictEqual(accepted._tag, "Accepted");
      assert.strictEqual(sent[0]?.headers["dd-api-key"], KEY);
      assert.notProperty(sent[1]?.headers, "dd-api-key");
    }),
  );
});

it.layer(NodeServices.layer)("Datadog API key", (it) => {
  it.effect("is stored trimmed, reported only as present, and removed", () =>
    Effect.gen(function* () {
      const { memory, layer } = withSecrets({});
      const set = yield* DatadogKey.set(`  ${KEY}\n`).pipe(Effect.provide(layer));
      assert.deepStrictEqual(set, { present: true });
      assert.strictEqual(memory.entries.get(DatadogKey.DATADOG_KEY_SECRET), KEY);
      assert.deepStrictEqual(yield* DatadogKey.status().pipe(Effect.provide(layer)), {
        present: true,
      });
      assert.deepStrictEqual(yield* DatadogKey.clear().pipe(Effect.provide(layer)), {
        present: false,
      });
      assert.isFalse(memory.entries.has(DatadogKey.DATADOG_KEY_SECRET));
    }),
  );

  it.effect("is refused by length and shape without repeating it", () =>
    Effect.gen(function* () {
      const { memory, layer } = withSecrets({});
      const short = yield* DatadogKey.set("not-a-key-zzzz").pipe(
        Effect.flip,
        Effect.provide(layer),
      );
      assert.strictEqual(short.kind, "invalid");
      assert.include(short.message, "14 characters");
      assert.include(short.message, "32 hexadecimal characters");
      assert.notInclude(short.message, "not-a-key-zzzz");

      const huge = yield* DatadogKey.set("a".repeat(300)).pipe(Effect.flip, Effect.provide(layer));
      assert.include(huge.message, "300 bytes; the limit is 256 bytes");
      assert.strictEqual(memory.entries.size, 0);
    }),
  );

  it.effect("is refused by name where there is no secret store", () =>
    Effect.gen(function* () {
      const error = yield* DatadogKey.status().pipe(Effect.flip);
      assert.strictEqual(error.kind, "secret_store_unavailable");
    }),
  );
});
