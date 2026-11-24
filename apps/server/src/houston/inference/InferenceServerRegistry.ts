import {
  DEFAULT_PROVIDER_HEALTH_REFRESH_INTERVAL,
  type ServerSettings,
} from "@houston-app/contracts";
import {
  type InferenceApiProtocol,
  type InferenceServerConfig,
  InferenceServerId,
  type InferenceServerLoad,
  type InferenceServerModel,
  type InferenceServerSaveInput,
  type InferenceServerSnapshot,
  HoustonInferenceError,
} from "@houston-app/contracts/houston/inference";
import { resolveServerBackgroundActivitySettings } from "@houston-app/shared/backgroundActivitySettings";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientRequest } from "effect/http";

import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import * as Settings from "../../serverSettings.ts";
import * as HoustonSecrets from "../secrets/HoustonSecrets.ts";

export class InferenceServerRegistry extends Context.Service<
  InferenceServerRegistry,
  {
    readonly current: Effect.Effect<ReadonlyArray<InferenceServerSnapshot>>;
    readonly streamChanges: Stream.Stream<ReadonlyArray<InferenceServerSnapshot>>;
    /** Probes every enabled server, or only `id`, and returns every snapshot after it. */
    readonly refresh: (
      id?: InferenceServerId,
    ) => Effect.Effect<ReadonlyArray<InferenceServerSnapshot>>;
    /** Adds or replaces a server and stores its API key; an omitted key keeps the saved one. */
    readonly save: (input: InferenceServerSaveInput) => Effect.Effect<void, HoustonInferenceError>;
    readonly remove: (id: InferenceServerId) => Effect.Effect<void, HoustonInferenceError>;
  }
>()("@houston-app/cli/houston/inference/InferenceServerRegistry") {}

const MODELS_TIMEOUT = Duration.seconds(5);
const ENRICHMENT_TIMEOUT = Duration.seconds(3);
const MAX_BODY_BYTES = 4_000_000;
const URL_CREDENTIALS = /^([a-z][a-z0-9+.-]*:\/\/)?[^/@]*@/i;
const TRAILING_SLASHES = /\/+$/;
const METRIC_LINE = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(?:\{[^}]*\})?\s+(\S+)/;

type Endpoint =
  | { readonly base: string; readonly origin: string; readonly display: string }
  | { readonly error: string; readonly display: string };

/** The secret entry holding one server's API key. The name is scoped to the channel's store. */
export const inferenceApiKeySecretName = (id: InferenceServerId): string =>
  `houston-inference-server-${id}`;

export function parseBaseUrl(raw: string): Endpoint {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return {
      error: "The base URL is not a valid URL.",
      display: raw.replace(URL_CREDENTIALS, "$1"),
    };
  }
  const display = `${url.protocol}//${url.host}${url.pathname.replace(TRAILING_SLASHES, "")}`;
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { error: "The base URL must start with http:// or https://.", display };
  }
  if (url.username !== "" || url.password !== "") {
    return { error: "Put credentials in the API key, not the base URL.", display };
  }
  if (url.search !== "" || url.hash !== "") {
    return {
      error: "The base URL cannot carry a query string; put credentials in the API key.",
      display,
    };
  }
  return { base: display, origin: url.origin, display };
}

function displayNameOf(id: string, config: InferenceServerConfig): string {
  if (config.displayName) return config.displayName;
  try {
    return new URL(config.baseUrl).hostname || id;
  } catch {
    return id;
  }
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const positiveInt = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;

const nonEmptyStrings = (value: unknown): ReadonlyArray<string> =>
  Array.isArray(value)
    ? value.flatMap((entry) =>
        typeof entry === "string" && entry.trim() !== "" ? [entry.trim()] : [],
      )
    : [];

const ModelList = Schema.fromJsonString(Schema.Struct({ data: Schema.Array(Schema.Unknown) }));
const decodeModelList = Schema.decodeUnknownOption(ModelList);
const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));

function readModel(raw: unknown): InferenceServerModel | undefined {
  if (!isRecord(raw) || typeof raw.id !== "string" || raw.id.trim() === "") return undefined;
  const served = positiveInt(raw.context_length) ?? positiveInt(raw.max_model_len);
  // llama.cpp reports what the weights were trained for, not the --ctx-size it serves.
  const trained = isRecord(raw.meta) ? positiveInt(raw.meta.n_ctx_train) : undefined;
  const maxOutputTokens = positiveInt(raw.max_output_tokens);
  const efforts = isRecord(raw.reasoning) ? nonEmptyStrings(raw.reasoning.supported_efforts) : [];
  return {
    id: raw.id.trim(),
    ...(served === undefined ? {} : { servedContextWindow: served }),
    ...(trained === undefined ? {} : { trainedContextWindow: trained }),
    ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
    ...(efforts.length === 0 ? {} : { reasoningEfforts: efforts }),
  };
}

const ENGINE_BY_OWNER: Readonly<Record<string, string>> = {
  tensorfold: "TensorFold",
  vllm: "vLLM",
  llamacpp: "llama.cpp",
  library: "Ollama",
  organization_owner: "LM Studio",
};

/** llama.cpp's /props: one loaded model, with or without a vision projector. */
function readLlamaCppVision(props: unknown): boolean | undefined {
  return isRecord(props) &&
    isRecord(props.modalities) &&
    typeof props.modalities.vision === "boolean"
    ? props.modalities.vision
    : undefined;
}

/** LM Studio's native model list types vision models "vlm". */
function readLmStudioVision(list: unknown): ReadonlyMap<string, boolean> {
  if (!isRecord(list) || !Array.isArray(list.data)) return new Map();
  return new Map(
    list.data.flatMap((model) =>
      isRecord(model) &&
      typeof model.id === "string" &&
      (model.type === "vlm" || model.type === "llm")
        ? [[model.id, model.type === "vlm"] as const]
        : [],
    ),
  );
}

/** Ollama's /api/show lists what a model can do. */
function readOllamaVision(show: unknown): boolean | undefined {
  return isRecord(show) && Array.isArray(show.capabilities)
    ? show.capabilities.includes("vision")
    : undefined;
}

// Ollama answers /api/show per model, so its answers are reused across probes for a while.
const OLLAMA_SHOW_REUSE_MS = 10 * 60_000;

/** An OpenAI-format model list and the engine its owner names; undefined when the body is not one. */
export function readModelList(body: string) {
  const list = decodeModelList(body);
  if (list._tag === "None") return undefined;
  const owner = list.value.data.find(isRecord)?.owned_by;
  return {
    models: list.value.data.flatMap((raw) => readModel(raw) ?? []),
    engine: typeof owner === "string" ? ENGINE_BY_OWNER[owner] : undefined,
  };
}

const METRICS = [
  {
    engine: "TensorFold",
    running: "tensorfold:requests_running",
    waiting: "tensorfold:requests_waiting",
  },
  { engine: "vLLM", running: "vllm:num_requests_running", waiting: "vllm:num_requests_waiting" },
  {
    engine: "llama.cpp",
    running: "llamacpp:requests_processing",
    waiting: "llamacpp:requests_deferred",
  },
] as const;

/** Sums each series across its labels. */
function sumMetrics(text: string): ReadonlyMap<string, number> {
  const totals = new Map<string, number>();
  for (const line of text.split("\n")) {
    const match = METRIC_LINE.exec(line.trim());
    if (match === null) continue;
    const value = Number(match[2]);
    if (!Number.isFinite(value) || value < 0) continue;
    totals.set(match[1]!, (totals.get(match[1]!) ?? 0) + value);
  }
  return totals;
}

/** The first engine whose two load gauges are present. */
function readLoad(
  totals: ReadonlyMap<string, number>,
): { engine: string; load: InferenceServerLoad } | undefined {
  for (const family of METRICS) {
    const running = totals.get(family.running);
    const waiting = totals.get(family.waiting);
    if (running === undefined || waiting === undefined) continue;
    return {
      engine: family.engine,
      load: { running: Math.round(running), waiting: Math.round(waiting) },
    };
  }
  return undefined;
}

export const PROTOCOL_PATHS: ReadonlyArray<readonly [InferenceApiProtocol, string]> = [
  ["chat-completions", "chat/completions"],
  ["completions", "completions"],
  ["responses", "responses"],
  ["messages", "messages"],
];

type Fetched =
  | { readonly _tag: "Response"; readonly status: number; readonly body: string | undefined }
  | { readonly _tag: "Unreachable"; readonly timedOut: boolean };

/** @public */
export const make = Effect.gen(function* () {
  const client = yield* HttpClient.HttpClient;
  const settingsService = yield* Settings.ServerSettingsService;
  const secrets = yield* HoustonSecrets.HoustonSecrets;
  const backgroundPolicy = yield* BackgroundPolicy.BackgroundPolicy;
  const stateRef = yield* Ref.make<ReadonlyArray<InferenceServerSnapshot>>([]);
  const changes = yield* Effect.acquireRelease(
    PubSub.unbounded<ReadonlyArray<InferenceServerSnapshot>>(),
    PubSub.shutdown,
  );

  const readBoundedBody = <E, R>(response: {
    readonly stream: Stream.Stream<Uint8Array, E, R>;
  }): Effect.Effect<string | undefined, E, R> => {
    let read = 0;
    return response.stream.pipe(
      Stream.takeWhile((chunk) => {
        read += chunk.length;
        return read <= MAX_BODY_BYTES;
      }),
      Stream.decodeText(),
      Stream.mkString,
      Effect.map((body) => (read > MAX_BODY_BYTES ? undefined : body)),
    );
  };

  const fetchText = Effect.fn("InferenceServerRegistry.fetch")(function* (
    url: string,
    apiKey: string,
    timeout: Duration.Duration,
  ) {
    const request = HttpClientRequest.get(url).pipe(
      apiKey === "" ? (request) => request : HttpClientRequest.bearerToken(apiKey),
    );
    return yield* client.execute(request).pipe(
      Effect.flatMap((response) =>
        readBoundedBody(response).pipe(
          Effect.map((body): Fetched => ({ _tag: "Response", status: response.status, body })),
        ),
      ),
      Effect.timeoutOption(timeout),
      Effect.map((result) =>
        result._tag === "Some" ? result.value : ({ _tag: "Unreachable", timedOut: true } as const),
      ),
      Effect.orElseSucceed(() => ({ _tag: "Unreachable", timedOut: false }) as const),
    );
  });

  /**
   * An empty POST costs no generation: a served route rejects it as invalid (400/422), a missing
   * one answers 404/405. Anything else proves nothing either way.
   */
  const protocolServed = Effect.fn("InferenceServerRegistry.protocolServed")(function* (
    url: string,
    apiKey: string,
  ) {
    const request = HttpClientRequest.post(url).pipe(
      HttpClientRequest.bodyText("{}", "application/json"),
      apiKey === "" ? (request) => request : HttpClientRequest.bearerToken(apiKey),
    );
    return yield* client.execute(request).pipe(
      Effect.map(
        (response) =>
          response.status === 400 ||
          response.status === 422 ||
          (response.status >= 200 && response.status < 300),
      ),
      Effect.timeoutOption(ENRICHMENT_TIMEOUT),
      Effect.map((result) => result._tag === "Some" && result.value),
      Effect.orElseSucceed(() => false),
    );
  });

  const enrichmentJson = (url: string, apiKey: string) =>
    fetchText(url, apiKey, ENRICHMENT_TIMEOUT).pipe(
      Effect.map((fetched) =>
        fetched._tag === "Response" &&
        fetched.body !== undefined &&
        fetched.status >= 200 &&
        fetched.status < 300
          ? decodeJson(fetched.body).pipe((option) =>
              option._tag === "Some" ? option.value : undefined,
            )
          : undefined,
      ),
    );

  const ollamaShows = yield* Ref.make(
    new Map<string, { readonly atMs: number; readonly vision: boolean | undefined }>(),
  );
  const ollamaVision = Effect.fn("InferenceServerRegistry.ollamaVision")(function* (
    origin: string,
    apiKey: string,
    model: string,
  ) {
    const key = `${origin} ${model}`;
    const now = yield* Clock.currentTimeMillis;
    const known = (yield* Ref.get(ollamaShows)).get(key);
    if (known !== undefined && now - known.atMs < OLLAMA_SHOW_REUSE_MS) return known.vision;
    const request = HttpClientRequest.post(`${origin}/api/show`).pipe(
      HttpClientRequest.bodyJsonUnsafe({ model }),
      apiKey === "" ? (request) => request : HttpClientRequest.bearerToken(apiKey),
    );
    const vision = yield* client.execute(request).pipe(
      Effect.flatMap((response) =>
        response.status >= 200 && response.status < 300
          ? readBoundedBody(response).pipe(Effect.map((body) => body ?? ""))
          : Effect.succeed(""),
      ),
      Effect.timeoutOption(ENRICHMENT_TIMEOUT),
      Effect.map((body) => (body._tag === "Some" ? decodeJson(body.value) : Option.none())),
      Effect.map((json) => (json._tag === "Some" ? readOllamaVision(json.value) : undefined)),
      Effect.orElseSucceed(() => undefined),
    );
    yield* Ref.update(ollamaShows, (all) => new Map(all).set(key, { atMs: now, vision }));
    return vision;
  });

  /** Whether each model reads images, as its engine says; absent when the engine does not say. */
  const reportedVision = Effect.fn("InferenceServerRegistry.reportedVision")(function* (
    engine: string | undefined,
    origin: string,
    apiKey: string,
    models: ReadonlyArray<InferenceServerModel>,
  ) {
    if (engine === "llama.cpp") {
      const vision = readLlamaCppVision(yield* enrichmentJson(`${origin}/props`, apiKey));
      return new Map(
        vision === undefined ? [] : models.map((model) => [model.id, vision] as const),
      );
    }
    if (engine === "LM Studio") {
      return readLmStudioVision(yield* enrichmentJson(`${origin}/api/v0/models`, apiKey));
    }
    if (engine === "Ollama") {
      const found = yield* Effect.forEach(
        models,
        (model) =>
          ollamaVision(origin, apiKey, model.id).pipe(
            Effect.map((vision) => (vision === undefined ? [] : [[model.id, vision] as const])),
          ),
        { concurrency: 4 },
      );
      return new Map(found.flat());
    }
    return new Map<string, boolean>();
  });

  const readApiKey = Effect.fn("InferenceServerRegistry.readApiKey")(function* (
    id: InferenceServerId,
  ) {
    const read = yield* secrets.get(inferenceApiKeySecretName(id)).pipe(Effect.option);
    if (read._tag === "None") return undefined;
    return Option.match(read.value, {
      onNone: () => "",
      onSome: (value) => Redacted.value(value).trim(),
    });
  });

  const probe = Effect.fn("InferenceServerRegistry.probe")(function* (
    id: InferenceServerId,
    config: InferenceServerConfig,
  ) {
    const endpoint = parseBaseUrl(config.baseUrl);
    const base = {
      id,
      displayName: displayNameOf(id, config),
      baseUrl: endpoint.display,
      enabled: config.enabled,
      models: [],
      ...(config.maxConcurrentRequests === undefined
        ? {}
        : { maxConcurrentRequests: config.maxConcurrentRequests }),
    } as const;
    if (!config.enabled) {
      return { ...base, status: "unreachable", checkedAt: null, message: "Turned off." } as const;
    }
    const checkedAt = DateTime.formatIso(yield* DateTime.now);
    if ("error" in endpoint) {
      return { ...base, status: "error", checkedAt, message: endpoint.error } as const;
    }
    const apiKey = yield* readApiKey(id);
    if (apiKey === undefined) {
      return {
        ...base,
        status: "error",
        checkedAt,
        message: "Could not read the API key from the secret store.",
      } as const;
    }
    const key = apiKey;

    const listed = yield* fetchText(`${endpoint.base}/models`, key, MODELS_TIMEOUT);
    if (listed._tag === "Unreachable") {
      return {
        ...base,
        status: "unreachable",
        checkedAt,
        message: listed.timedOut
          ? "The server did not answer in time."
          : "Could not connect to the server.",
      } as const;
    }
    if (listed.status === 401 || listed.status === 403) {
      return {
        ...base,
        status: "error",
        checkedAt,
        message: "The server rejected the API key.",
      } as const;
    }
    if (listed.status < 200 || listed.status >= 300) {
      return {
        ...base,
        status: "error",
        checkedAt,
        message: `The server answered ${listed.status} when listing models.`,
      } as const;
    }
    if (listed.body === undefined) {
      return {
        ...base,
        status: "error",
        checkedAt,
        message: "The server's model list is too large.",
      } as const;
    }
    const list = readModelList(listed.body);
    if (list === undefined) {
      return {
        ...base,
        status: "error",
        checkedAt,
        message: "The server's model list is not in the OpenAI format.",
      } as const;
    }
    const { engine: ownerEngine } = list;

    // Optional: a failure here never downgrades the model list above.
    const [health, metricsText, slots, protocols, reported] = yield* Effect.all(
      [
        ownerEngine === "TensorFold"
          ? enrichmentJson(`${endpoint.origin}/health`, key)
          : Effect.undefined,
        fetchText(`${endpoint.origin}/metrics`, key, ENRICHMENT_TIMEOUT),
        ownerEngine === "llama.cpp"
          ? enrichmentJson(`${endpoint.origin}/slots`, key)
          : Effect.undefined,
        Effect.forEach(
          PROTOCOL_PATHS,
          ([protocol, path]) =>
            protocolServed(`${endpoint.base}/${path}`, key).pipe(
              Effect.map((served) => (served ? [protocol] : [])),
            ),
          { concurrency: "unbounded" },
        ).pipe(Effect.map((found) => found.flat())),
        reportedVision(ownerEngine, endpoint.origin, key, list.models),
      ],
      { concurrency: "unbounded" },
    );
    const models = list.models.map((model) => {
      const vision = reported.get(model.id);
      return vision === undefined
        ? model
        : {
            ...model,
            capabilities: {
              ...model.capabilities,
              image: { supported: vision, source: "reported" as const },
            },
          };
    });
    const totals =
      metricsText._tag === "Response" &&
      metricsText.body !== undefined &&
      metricsText.status >= 200 &&
      metricsText.status < 300
        ? sumMetrics(metricsText.body)
        : undefined;
    const metrics = totals === undefined ? undefined : readLoad(totals);
    const engine = ownerEngine ?? metrics?.engine;
    // Batch size means concurrent requests only where that is verified for the engine.
    const detectedConcurrency =
      engine === "TensorFold" && isRecord(health)
        ? positiveInt(health.max_batch_size)
        : engine === "llama.cpp" && Array.isArray(slots) && slots.length > 0
          ? slots.length
          : undefined;
    const maxConcurrentRequests = config.maxConcurrentRequests ?? detectedConcurrency;
    return {
      ...base,
      status: "ready",
      checkedAt,
      models,
      ...(engine === undefined ? {} : { engine }),
      ...(metrics === undefined ? {} : { load: metrics.load }),
      ...(maxConcurrentRequests === undefined ? {} : { maxConcurrentRequests }),
      ...(protocols.length === 0 ? {} : { apiProtocols: protocols }),
    } as const;
  });

  const publish = Effect.fn("InferenceServerRegistry.publish")(function* (
    snapshots: ReadonlyArray<InferenceServerSnapshot>,
  ) {
    const changed = yield* Ref.modify(stateRef, (previous) =>
      Equal.equals(previous, snapshots) ? [false, previous] : [true, snapshots],
    );
    if (changed) yield* PubSub.publish(changes, snapshots);
  });

  // Serialized so a slow probe of old settings cannot resurrect a removed server.
  const refreshLock = yield* Semaphore.make(1);
  const refreshEffect = Effect.fn("InferenceServerRegistry.refresh")(function* (
    only?: InferenceServerId,
  ) {
    const settings = yield* settingsService.getSettings.pipe(
      Effect.orElseSucceed((): ServerSettings | null => null),
    );
    if (settings === null) return yield* Ref.get(stateRef);
    const previous = new Map((yield* Ref.get(stateRef)).map((snapshot) => [snapshot.id, snapshot]));
    const entries = Object.entries(settings.inferenceServers).map(
      ([rawId, config]) => [InferenceServerId.make(rawId), config] as const,
    );
    const isTarget = (id: InferenceServerId) => only === undefined || only === id;
    // New servers show as checking until their first probe lands.
    yield* publish(
      entries.map(
        ([id, config]) =>
          previous.get(id) ?? {
            id,
            displayName: displayNameOf(id, config),
            baseUrl: parseBaseUrl(config.baseUrl).display,
            enabled: config.enabled,
            status: "checking" as const,
            checkedAt: null,
            models: [],
          },
      ),
    );
    const snapshots = yield* Effect.forEach(
      entries,
      ([id, config]) =>
        isTarget(id) || previous.get(id) === undefined
          ? probe(id, config)
          : Effect.succeed(previous.get(id)!),
      { concurrency: 4 },
    );
    yield* publish(snapshots);
    return snapshots;
  });

  const refresh = (only?: InferenceServerId) =>
    refreshEffect(only).pipe(
      refreshLock.withPermits(1),
      Effect.catchCause((cause) =>
        Effect.logError("inference server refresh failed", { cause }).pipe(
          Effect.andThen(Ref.get(stateRef)),
        ),
      ),
    );

  const settingsFailure = (operation: string, cause: unknown) =>
    new HoustonInferenceError({
      operation,
      kind: "settings",
      message:
        cause instanceof Error && cause.message.trim() !== ""
          ? cause.message
          : "The settings could not be saved.",
    });

  const secretFailure = (operation: string, cause: unknown) =>
    new HoustonInferenceError({
      operation,
      kind: "secret_store_unavailable",
      message:
        cause instanceof Error && cause.message.trim() !== ""
          ? cause.message
          : "The secret store is unavailable.",
    });

  const save = Effect.fn("InferenceServerRegistry.save")(function* (
    input: InferenceServerSaveInput,
  ) {
    const endpoint = parseBaseUrl(input.baseUrl);
    if ("error" in endpoint) {
      return yield* new HoustonInferenceError({
        operation: "save",
        kind: "invalid",
        message: endpoint.error,
      });
    }
    const currentSettings = yield* settingsService.getSettings.pipe(
      Effect.mapError((cause) => settingsFailure("save", cause)),
    );
    const existing = Object.hasOwn(currentSettings.inferenceServers, input.id)
      ? currentSettings.inferenceServers[input.id]
      : undefined;
    const config: InferenceServerConfig = {
      ...(input.displayName === undefined ? {} : { displayName: input.displayName }),
      baseUrl: endpoint.base,
      enabled: input.enabled ?? existing?.enabled ?? true,
      ...(input.maxConcurrentRequests === undefined
        ? {}
        : { maxConcurrentRequests: input.maxConcurrentRequests }),
    };

    if (input.apiKey !== undefined) {
      const name = inferenceApiKeySecretName(input.id);
      yield* (
        input.apiKey === "" ? secrets.remove(name) : secrets.set(name, Redacted.make(input.apiKey))
      ).pipe(Effect.mapError((cause) => secretFailure("save", cause)));
    }

    const patch = {
      inferenceServers: { [input.id]: config } as Record<
        InferenceServerId,
        InferenceServerConfig | null
      >,
    };
    yield* settingsService
      .updateSettings(patch)
      .pipe(Effect.mapError((cause) => settingsFailure("save", cause)));
    yield* refresh(input.id);
  });

  const remove = Effect.fn("InferenceServerRegistry.remove")(function* (id: InferenceServerId) {
    const patch = {
      inferenceServers: { [id]: null } as Record<InferenceServerId, InferenceServerConfig | null>,
    };
    yield* settingsService
      .updateSettings(patch)
      .pipe(Effect.mapError((cause) => settingsFailure("remove", cause)));
    const removedKey = yield* secrets.remove(inferenceApiKeySecretName(id)).pipe(
      Effect.mapError((cause) => secretFailure("remove", cause)),
      Effect.result,
    );
    yield* refresh();
    if (Result.isFailure(removedKey)) return yield* removedKey.failure;
  });

  yield* settingsService.streamChanges.pipe(
    Stream.map((settings) => settings.inferenceServers),
    Stream.changes,
    Stream.runForEach(() => refresh()),
    Effect.forkScoped,
  );

  const interval = settingsService.getSettings.pipe(
    Effect.map(
      (settings) => resolveServerBackgroundActivitySettings(settings).providerHealthRefreshInterval,
    ),
    Effect.orElseSucceed(() => DEFAULT_PROVIDER_HEALTH_REFRESH_INTERVAL),
  );
  yield* Effect.forever(
    interval.pipe(
      Effect.flatMap((wait) => Effect.sleep(Duration.isPositive(wait) ? wait : "60 seconds")),
      Effect.andThen(interval),
      Effect.flatMap((current) =>
        Duration.isPositive(current)
          ? backgroundPolicy.shouldRunScopeWork({ type: "provider-status" })
          : Effect.succeed(false),
      ),
      Effect.flatMap((shouldRun) => (shouldRun ? refresh() : Effect.void)),
      Effect.ignoreCause({ log: true }),
    ),
  ).pipe(Effect.forkScoped);

  // Startup never waits on a server that may be asleep or gone.
  yield* refresh().pipe(Effect.forkScoped);

  return InferenceServerRegistry.of({
    current: Ref.get(stateRef),
    refresh,
    save,
    remove,
    get streamChanges() {
      return Stream.unwrap(
        Effect.gen(function* () {
          const subscription = yield* PubSub.subscribe(changes);
          const snapshot = yield* Ref.get(stateRef);
          return Stream.concat(Stream.make(snapshot), Stream.fromSubscription(subscription)).pipe(
            Stream.changes,
          );
        }),
      );
    },
  });
});

export const layer = Layer.effect(InferenceServerRegistry, make);
