import { describe, expect, it } from "@effect/vitest";
import {
  type InferenceServerConfig,
  InferenceServerId,
} from "@houston-app/contracts/houston/inference";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientError, HttpClientResponse } from "effect/http";

import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as HoustonSecrets from "../secrets/HoustonSecrets.ts";
import * as InferenceServerRegistry from "./InferenceServerRegistry.ts";

// A string is a 200 text body, `{ statusCode }` an empty error, anything else a JSON body.
type Route = unknown;
type Routes = Readonly<Record<string, Route>>;

const rtx = InferenceServerId.make("rtx");
const HOST = "http://rtx.test:8888";

const layerFakeHttp = (routes: Routes, seen: Array<{ url: string; auth: string | undefined }>) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.suspend(() => {
        seen.push({ url: request.url, auth: request.headers["authorization"] });
        const route = routes[request.url];
        if (route === "unreachable" || route === "hang") {
          return route === "hang"
            ? Effect.never
            : Effect.fail(
                new HttpClientError.HttpClientError({
                  reason: new HttpClientError.TransportError({
                    request,
                    cause: new TypeError("fetch failed"),
                  }),
                }),
              );
        }
        const response =
          route === undefined
            ? new Response("Not Found", { status: 404 })
            : typeof route === "string"
              ? new Response(route, { status: 200 })
              : typeof route === "object" && route !== null && "statusCode" in route
                ? new Response("", { status: (route as { statusCode: number }).statusCode })
                : Response.json(route);
        return Effect.succeed(HttpClientResponse.fromWeb(request, response));
      }),
    ),
  );

/** Probes again for each entry of `later`, with that entry's routes changed. */
const probe = (
  routes: Routes,
  config: Partial<InferenceServerConfig> = {},
  seen: Array<{ url: string; auth: string | undefined }> = [],
  later: ReadonlyArray<Routes> = [],
  secrets: HoustonSecrets.MemorySecrets = HoustonSecrets.makeMemory(),
) => {
  const live: Record<string, Route> = { ...routes };
  return Effect.gen(function* () {
    const registry = yield* InferenceServerRegistry.make;
    let snapshots = yield* registry.refresh();
    for (const changed of later) {
      Object.assign(live, changed);
      snapshots = yield* registry.refresh();
    }
    return snapshots.find((snapshot) => snapshot.id === rtx);
  }).pipe(
    Effect.provide([
      ServerSettings.layerTest({
        inferenceServers: {
          [rtx]: { baseUrl: `${HOST}/v1`, enabled: true, ...config },
        },
      }),
      Layer.mock(BackgroundPolicy.BackgroundPolicy)({
        shouldRunScopeWork: () => Effect.succeed(false),
      }),
      HoustonSecrets.layerMemory(secrets),
      layerFakeHttp(live, seen),
    ]),
    Effect.scoped,
  );
};

const tensorFoldModels = {
  object: "list",
  data: [
    {
      id: "GLM-5.3-Flash",
      object: "model",
      owned_by: "tensorfold",
      context_length: 813056,
      max_model_len: 813056,
      max_output_tokens: 32768,
      reasoning: {
        default_enabled: false,
        default_effort: "xhigh",
        supported_efforts: ["max", "high", "low"],
      },
    },
  ],
};

describe("InferenceServerRegistry probes", () => {
  it.effect("reads TensorFold models, batch size, and load", () =>
    Effect.gen(function* () {
      const seen: Array<{ url: string; auth: string | undefined }> = [];
      const secrets = HoustonSecrets.makeMemory();
      secrets.entries.set("houston-inference-server-rtx", "secret-key");
      const snapshot = yield* probe(
        {
          [`${HOST}/v1/models`]: tensorFoldModels,
          [`${HOST}/health`]: {
            status: "ok",
            model: "GLM-5.3-Flash",
            max_batch_size: 4,
            warming: false,
          },
          [`${HOST}/metrics`]:
            "# HELP tensorfold:requests_running Running\ntensorfold:requests_running 1\ntensorfold:requests_waiting 0\n",
          // Routes that exist reject an empty body; missing ones answer 404.
          [`${HOST}/v1/chat/completions`]: { statusCode: 400 },
          [`${HOST}/v1/responses`]: { statusCode: 422 },
          [`${HOST}/v1/messages`]: { statusCode: 400 },
          [`${HOST}/v1/completions`]: { statusCode: 500 },
        },
        { displayName: "rtx" },
        seen,
        [],
        secrets,
      );
      expect(snapshot).toMatchObject({
        id: rtx,
        displayName: "rtx",
        baseUrl: `${HOST}/v1`,
        enabled: true,
        status: "ready",
        engine: "TensorFold",
        models: [
          {
            id: "GLM-5.3-Flash",
            servedContextWindow: 813056,
            maxOutputTokens: 32768,
            reasoningEfforts: ["max", "high", "low"],
          },
        ],
        load: { running: 1, waiting: 0 },
        maxConcurrentRequests: 4,
        apiProtocols: ["chat-completions", "responses", "messages"],
      });
      expect(snapshot?.checkedAt).toBeTypeOf("string");
      expect(seen.every(({ auth }) => auth === "Bearer secret-key")).toBe(true);
    }),
  );

  it.effect("reads vLLM's served window and labeled load, without trusting its batch size", () =>
    Effect.gen(function* () {
      const snapshot = yield* probe({
        [`${HOST}/v1/models`]: {
          object: "list",
          data: [
            {
              id: "Qwen/Qwen3-32B",
              object: "model",
              owned_by: "vllm",
              root: "Qwen/Qwen3-32B",
              max_model_len: 32768,
            },
          ],
        },
        [`${HOST}/health`]: { max_batch_size: 256 },
        [`${HOST}/metrics`]: [
          'vllm:num_requests_running{model_name="Qwen/Qwen3-32B"} 2.0',
          'vllm:num_requests_waiting{model_name="Qwen/Qwen3-32B"} 3.0',
        ].join("\n"),
      });
      expect(snapshot).toMatchObject({
        status: "ready",
        engine: "vLLM",
        models: [{ id: "Qwen/Qwen3-32B", servedContextWindow: 32768 }],
        load: { running: 2, waiting: 3 },
      });
      expect(snapshot?.maxConcurrentRequests).toBeUndefined();
      expect(snapshot?.apiProtocols).toBeUndefined();
    }),
  );

  it.effect("keeps llama.cpp's trained window apart from the served one and counts its slots", () =>
    Effect.gen(function* () {
      const snapshot = yield* probe({
        [`${HOST}/v1/models`]: {
          object: "list",
          data: [
            {
              id: "gemma-3-27b.gguf",
              object: "model",
              created: 1,
              owned_by: "llamacpp",
              meta: { n_vocab: 262144, n_ctx_train: 131072, n_params: 27_000_000_000 },
            },
          ],
        },
        [`${HOST}/slots`]: [{ id: 0 }, { id: 1 }, { id: 2 }, { id: 3 }],
        [`${HOST}/metrics`]: "llamacpp:requests_processing 1\nllamacpp:requests_deferred 2\n",
        [`${HOST}/props`]: { modalities: { vision: true, audio: false } },
      });
      expect(snapshot).toMatchObject({
        status: "ready",
        engine: "llama.cpp",
        models: [
          {
            id: "gemma-3-27b.gguf",
            trainedContextWindow: 131072,
            capabilities: { image: { supported: true, source: "reported" } },
          },
        ],
        load: { running: 1, waiting: 2 },
        maxConcurrentRequests: 4,
      });
      expect(snapshot?.models[0]?.servedContextWindow).toBeUndefined();
    }),
  );

  it.effect.each([
    [
      "Ollama",
      { id: "qwen3:8b", object: "model", created: 1, owned_by: "library" },
      { [`${HOST}/api/show`]: { capabilities: ["completion", "tools"] } },
    ],
    [
      "LM Studio",
      { id: "qwen/qwen3-8b", object: "model", owned_by: "organization_owner" },
      { [`${HOST}/api/v0/models`]: { data: [{ id: "qwen/qwen3-8b", type: "llm" }] } },
    ],
  ] as const)(
    "lists %s models and whether they read images, without load",
    ([engine, model, native]) =>
      Effect.gen(function* () {
        const snapshot = yield* probe({
          [`${HOST}/v1/models`]: { object: "list", data: [model] },
          ...native,
        });
        expect(snapshot).toMatchObject({
          status: "ready",
          engine,
          models: [
            { id: model.id, capabilities: { image: { supported: false, source: "reported" } } },
          ],
        });
        expect(snapshot?.load).toBeUndefined();
        expect(snapshot?.maxConcurrentRequests).toBeUndefined();
      }),
  );

  it.effect("skips entries without an id and ignores metadata of the wrong type", () =>
    Effect.gen(function* () {
      const snapshot = yield* probe({
        [`${HOST}/v1/models`]: {
          data: [
            { object: "model" },
            "not a model",
            { id: "kept", context_length: "huge", reasoning: { supported_efforts: [1, "low"] } },
          ],
        },
      });
      expect(snapshot?.status).toBe("ready");
      expect(snapshot?.models).toEqual([{ id: "kept", reasoningEfforts: ["low"] }]);
    }),
  );

  it.effect("keeps a successful model list when every enrichment fails", () =>
    Effect.gen(function* () {
      const snapshot = yield* probe({
        [`${HOST}/v1/models`]: tensorFoldModels,
        [`${HOST}/health`]: { statusCode: 500 },
        [`${HOST}/metrics`]: "unreachable",
      });
      expect(snapshot).toMatchObject({
        status: "ready",
        engine: "TensorFold",
        models: [{ id: "GLM-5.3-Flash" }],
      });
      expect(snapshot?.load).toBeUndefined();
      expect(snapshot?.maxConcurrentRequests).toBeUndefined();
    }),
  );

  it.effect.each([
    ["malformed JSON", { [`${HOST}/v1/models`]: "<html>not json" }, "error"],
    ["a non-list body", { [`${HOST}/v1/models`]: { models: [] } }, "error"],
    ["a rejected key", { [`${HOST}/v1/models`]: { statusCode: 401 } }, "error"],
    ["a server error", { [`${HOST}/v1/models`]: { statusCode: 503 } }, "error"],
    ["an unreachable host", { [`${HOST}/v1/models`]: "unreachable" }, "unreachable"],
  ] as const)("reports %s with a message", ([, routes, status]) =>
    Effect.gen(function* () {
      const snapshot = yield* probe(routes);
      expect(snapshot?.status).toBe(status);
      expect(snapshot?.message).toBeTypeOf("string");
      expect(snapshot?.models).toEqual([]);
    }),
  );

  it.effect("gives up on a server that never answers", () =>
    Effect.gen(function* () {
      const fiber = yield* probe({ [`${HOST}/v1/models`]: "hang" }).pipe(Effect.forkChild);
      yield* TestClock.adjust("1 minute");
      const snapshot = yield* Fiber.join(fiber);
      expect(snapshot?.status).toBe("unreachable");
    }),
  );

  it.effect.each([
    ["credentials", "http://user:hunter2@rtx.test:8888/v1"],
    ["a query string", "http://rtx.test:8888/v1?api_key=hunter2"],
  ] as const)("refuses a base URL carrying %s without calling it", ([, baseUrl]) =>
    Effect.gen(function* () {
      const seen: Array<{ url: string; auth: string | undefined }> = [];
      const snapshot = yield* probe({}, { baseUrl }, seen);
      expect(snapshot?.status).toBe("error");
      expect(snapshot?.message).toBeTypeOf("string");
      expect(snapshot?.baseUrl).not.toContain("hunter2");
      expect(seen).toEqual([]);
    }),
  );

  it.effect("normalizes a trailing slash and sends a saved API key", () =>
    Effect.gen(function* () {
      const seen: Array<{ url: string; auth: string | undefined }> = [];
      const secrets = HoustonSecrets.makeMemory();
      secrets.entries.set("houston-inference-server-rtx", "resolved-key");
      const snapshot = yield* probe(
        { [`${HOST}/v1/models`]: tensorFoldModels },
        { baseUrl: `${HOST}/v1/` },
        seen,
        [],
        secrets,
      );
      expect(snapshot?.status).toBe("ready");
      expect(snapshot?.baseUrl).toBe(`${HOST}/v1`);
      expect(seen[0]).toEqual({ url: `${HOST}/v1/models`, auth: "Bearer resolved-key" });
    }),
  );

  it.effect("does not call a server whose key cannot be read", () =>
    Effect.gen(function* () {
      const seen: Array<{ url: string; auth: string | undefined }> = [];
      const secrets = HoustonSecrets.makeMemory();
      secrets.failWith = "vault is locked";
      const snapshot = yield* probe(
        { [`${HOST}/v1/models`]: tensorFoldModels },
        {},
        seen,
        [],
        secrets,
      );
      expect(snapshot?.status).toBe("error");
      expect(seen).toEqual([]);
    }),
  );

  it.effect("lists a turned-off server without probing it", () =>
    Effect.gen(function* () {
      const seen: Array<{ url: string; auth: string | undefined }> = [];
      const snapshot = yield* probe(
        { [`${HOST}/v1/models`]: tensorFoldModels },
        { enabled: false },
        seen,
      );
      expect(snapshot).toMatchObject({ enabled: false, models: [] });
      expect(snapshot?.status).not.toBe("ready");
      expect(seen).toEqual([]);
    }),
  );
});

describe("InferenceServerRegistry lifecycle", () => {
  it.effect("adds a server, stores its key, and removes both", () =>
    Effect.gen(function* () {
      const secrets = HoustonSecrets.makeMemory();
      const seen: Array<{ url: string; auth: string | undefined }> = [];
      yield* Effect.gen(function* () {
        const registry = yield* InferenceServerRegistry.make;
        yield* registry.save({
          id: rtx,
          displayName: "RTX",
          baseUrl: `${HOST}/v1`,
          apiKey: "secret",
        });
        expect(secrets.entries.get("houston-inference-server-rtx")).toBe("secret");
        expect(yield* registry.current).toMatchObject([
          { id: rtx, displayName: "RTX", status: "ready" },
        ]);
        expect(seen.every(({ auth }) => auth === "Bearer secret")).toBe(true);

        yield* registry.remove(rtx);
        expect(secrets.entries.has("houston-inference-server-rtx")).toBe(false);
        expect(yield* registry.current).toEqual([]);
      }).pipe(
        Effect.provide([
          ServerSettings.layerTest(),
          Layer.mock(BackgroundPolicy.BackgroundPolicy)({
            shouldRunScopeWork: () => Effect.succeed(false),
          }),
          HoustonSecrets.layerMemory(secrets),
          layerFakeHttp({ [`${HOST}/v1/models`]: tensorFoldModels }, seen),
        ]),
        Effect.scoped,
      );
    }),
  );

  it.effect("refuses an invalid base URL before saving anything", () =>
    Effect.gen(function* () {
      const settings = yield* ServerSettings.ServerSettingsService;
      const registry = yield* InferenceServerRegistry.make;
      const outcome = yield* registry
        .save({ id: rtx, baseUrl: "http://user:pass@host/v1" })
        .pipe(Effect.result);
      expect(outcome._tag).toBe("Failure");
      expect((yield* settings.getSettings).inferenceServers).toEqual({});
    }).pipe(
      Effect.provide([
        ServerSettings.layerTest(),
        Layer.mock(BackgroundPolicy.BackgroundPolicy)({
          shouldRunScopeWork: () => Effect.succeed(false),
        }),
        HoustonSecrets.layerMemory(),
        layerFakeHttp({}, []),
      ]),
      Effect.scoped,
    ),
  );

  it.effect("probes on the interval only while background work may run", () =>
    Effect.gen(function* () {
      const seen: Array<{ url: string; auth: string | undefined }> = [];
      let mayRun = false;
      const program = Effect.gen(function* () {
        const registry = yield* InferenceServerRegistry.make;
        yield* registry.refresh();
        yield* TestClock.adjust("10 minutes");
        const afterStartup = seen.length;
        yield* TestClock.adjust("10 minutes");
        expect(seen.length).toBe(afterStartup);
        mayRun = true;
        yield* TestClock.adjust("10 minutes");
        expect(seen.length).toBeGreaterThan(afterStartup);
      });
      yield* program.pipe(
        Effect.provide([
          ServerSettings.layerTest({
            inferenceServers: { [rtx]: { baseUrl: `${HOST}/v1`, enabled: true } },
          }),
          Layer.mock(BackgroundPolicy.BackgroundPolicy)({
            shouldRunScopeWork: () => Effect.sync(() => mayRun),
          }),
          HoustonSecrets.layerMemory(),
          layerFakeHttp({ [`${HOST}/v1/models`]: tensorFoldModels }, seen),
        ]),
        Effect.scoped,
      );
    }),
  );
});

describe("parseBaseUrl", () => {
  it("refuses dangerous or unusable addresses", () => {
    expect(InferenceServerRegistry.parseBaseUrl("not a url")).toMatchObject({
      error: "The base URL is not a valid URL.",
    });
    expect(InferenceServerRegistry.parseBaseUrl("ftp://host/v1")).toMatchObject({
      error: "The base URL must start with http:// or https://.",
    });
    expect(InferenceServerRegistry.parseBaseUrl("http://user:pass@host/v1")).toMatchObject({
      error: "Put credentials in the API key, not the base URL.",
    });
  });

  it("normalizes a trailing slash", () => {
    expect(InferenceServerRegistry.parseBaseUrl("http://host:8080/v1/")).toEqual({
      base: "http://host:8080/v1",
      origin: "http://host:8080",
      display: "http://host:8080/v1",
    });
  });
});

describe("readPromptCache", () => {
  const totals = (values: Readonly<Record<string, number>>) =>
    new Map(Object.entries(values).map(([name, value]) => [`tensorfold:${name}`, value]));
  const full = { prompt_cache_budget_bytes: 1_000, prompt_cache_bytes: 990 };
  const half = { prompt_cache_budget_bytes: 1_000, prompt_cache_bytes: 500 };
  const counted = (hits: number, queries: number) => ({
    prefix_cache_hits_total: hits,
    prefix_cache_queries_total: queries,
  });
  const before = { hits: 140, queries: 200, share: 0.9, falling: false };

  it.each([
    [
      "first sight has no share",
      full,
      counted(50, 100),
      undefined,
      { status: "ok" },
      { hits: 50, queries: 100 },
    ],
    [
      "an interval's share",
      full,
      counted(140, 200),
      { hits: 50, queries: 100 },
      { recentCachedShare: 0.9, status: "ok" },
      before,
    ],
    [
      "an idle interval keeps the last share",
      full,
      counted(140, 200),
      before,
      { recentCachedShare: 0.9, status: "ok" },
      before,
    ],
    [
      "a restart counts from zero",
      full,
      counted(30, 100),
      { hits: 900, queries: 1_000, share: 0.9, falling: false },
      { recentCachedShare: 0.3, status: "saturated-falling" },
      { hits: 30, queries: 100, share: 0.3, falling: true },
    ],
    [
      "a falling share in a full cache",
      full,
      counted(160, 300),
      before,
      { recentCachedShare: 0.2, status: "saturated-falling" },
      { hits: 160, queries: 300, share: 0.2, falling: true },
    ],
    [
      "a falling share with room to spare",
      half,
      counted(160, 300),
      before,
      { recentCachedShare: 0.2, status: "ok" },
      { hits: 160, queries: 300, share: 0.2, falling: true },
    ],
  ] as const)("%s", (_, cache, counters, previous, expected, next) => {
    const read = InferenceServerRegistry.readPromptCache(
      totals({ ...cache, ...counters }),
      previous,
    );
    expect(read.cache).toMatchObject(expected);
    if (!("recentCachedShare" in expected)) expect(read.cache?.recentCachedShare).toBeUndefined();
    expect(read.counters).toEqual(next);
  });

  it("knows nothing without a budget", () => {
    expect(InferenceServerRegistry.readPromptCache(totals(counted(1, 2)), undefined)).toEqual({});
  });
});

describe("InferenceServerRegistry snapshot additions", () => {
  const service = () =>
    Effect.gen(function* () {
      const registry = yield* InferenceServerRegistry.make;
      yield* registry.refresh();
      return registry;
    }).pipe(
      Effect.provide([
        ServerSettings.layerTest({
          inferenceServers: { [rtx]: { baseUrl: `${HOST}/v1`, enabled: true } },
        }),
        Layer.mock(BackgroundPolicy.BackgroundPolicy)({
          shouldRunScopeWork: () => Effect.succeed(false),
        }),
        HoustonSecrets.layerMemory(),
        layerFakeHttp({ [`${HOST}/v1/models`]: tensorFoldModels }, []),
      ]),
      Effect.scoped,
    );

  it.effect("carries the queue and a recent failure, and clears them when idle", () =>
    Effect.gen(function* () {
      const registry = yield* service();
      yield* registry.publishGatewayQueue(rtx, {
        capacity: 2,
        active: [{ purpose: "interactive" }],
        waiting: [{ purpose: "background", position: 1 }],
      });
      yield* registry.publishRequestFailure(rtx, {
        at: "2026-01-01T00:00:00.000Z",
        status: "failed",
        cause: "transport",
        advice: "Check that the model server is running and reachable.",
      });
      const busy = (yield* registry.current).find((snapshot) => snapshot.id === rtx);
      expect(busy?.gatewayQueue).toEqual({
        capacity: 2,
        active: [{ purpose: "interactive" }],
        waiting: [{ purpose: "background", position: 1 }],
      });
      expect(busy?.recentFailure).toMatchObject({ status: "failed", cause: "transport" });

      yield* registry.publishGatewayQueue(rtx, { capacity: 2, active: [], waiting: [] });
      yield* registry.publishRequestFailure(rtx, null);
      const idle = (yield* registry.current).find((snapshot) => snapshot.id === rtx);
      expect(idle?.gatewayQueue).toBeUndefined();
      expect(idle?.recentFailure).toBeUndefined();
    }),
  );
});
