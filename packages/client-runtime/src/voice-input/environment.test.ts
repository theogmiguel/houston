import { expect, vi } from "vite-plus/test";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import { FetchHttpClient } from "effect/http";
import {
  DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS,
  EnvironmentId,
  SecretProviderId,
} from "@houston-app/contracts";
import { decodeSpeechPcmRequest } from "@houston-app/shared/speech";
import * as Schema from "effect/Schema";
import {
  PrimaryConnectionTarget,
  type PreparedConnection,
  type PreparedHttpAuthorization,
} from "../connection/model.ts";
import {
  getCloudSpeechModels,
  getEnvironmentSpeechStreamUrl,
  requireCloudSpeechKey,
  setCloudSpeechKey,
  transcribeCloudPcm,
  transcribeEnvironmentPcm,
} from "./environment.ts";

const environmentId = Schema.decodeSync(EnvironmentId)("voice-test");
const prepared = (
  httpBaseUrl: string,
  httpAuthorization: PreparedHttpAuthorization | null = null,
): PreparedConnection => ({
  environmentId,
  label: "test",
  httpBaseUrl,
  socketUrl: "ws://localhost/ws",
  httpAuthorization,
  target: new PrimaryConnectionTarget({
    environmentId,
    label: "test",
    httpBaseUrl,
    wsBaseUrl: "ws://localhost",
  }),
});
it.effect.each(["http://remote.example", "http://127.0.0.1.evil.example", "http://192.168.1.1"])(
  "does not send audio or credentials to %s",
  (url) =>
    Effect.gen(function* () {
      const fetch = vi.fn(async () => Response.json({ text: "hello" }));
      const result = yield* transcribeEnvironmentPcm(
        prepared(url),
        new Uint8Array(4),
        DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS,
      ).pipe(
        Effect.provide(FetchHttpClient.layer),
        Effect.provideService(FetchHttpClient.Fetch, fetch),
        Effect.result,
      );
      expect(Result.isFailure(result) && result.failure).toMatchObject({
        message: "Voice input requires HTTPS for remote environments.",
      });
      expect(fetch).not.toHaveBeenCalled();
    }),
);
it.effect.each([
  "https://remote.example",
  "http://localhost:3000",
  "http://127.0.0.1:3000",
  "http://[::1]:3000",
])("allows protected or loopback transport %s", (url) =>
  Effect.gen(function* () {
    const fetch = vi.fn(async () => Response.json({ text: "hello" }));
    expect(
      yield* transcribeEnvironmentPcm(
        prepared(url),
        new Uint8Array(4),
        DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS,
      ).pipe(
        Effect.provide(FetchHttpClient.layer),
        Effect.provideService(FetchHttpClient.Fetch, fetch),
      ),
    ).toEqual({ text: "hello" });
    expect(fetch).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ redirect: "error", credentials: "include" }),
    );
  }),
);

it.effect("does not send browser cookies with bearer-authenticated voice requests", () =>
  Effect.gen(function* () {
    let credentials: RequestCredentials | undefined;
    const fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      credentials = init?.credentials;
      return Response.json({ text: "hello" });
    });
    yield* transcribeEnvironmentPcm(
      prepared("https://remote.example", { _tag: "Bearer", token: "secret" }),
      new Uint8Array(4),
      DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS,
    ).pipe(
      Effect.provide(FetchHttpClient.layer),
      Effect.provideService(FetchHttpClient.Fetch, fetch),
    );
    expect(fetch).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ redirect: "error" }),
    );
    expect(credentials).toBeUndefined();
  }),
);

it.effect("sends the recording's options in the request body, not in headers", () =>
  Effect.gen(function* () {
    let body: Uint8Array | undefined;
    const fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      body = new Uint8Array(await new Response(init?.body).arrayBuffer());
      return Response.json({ text: "hello" });
    });
    const options = {
      ...DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS,
      speechLanguage: "pt" as const,
      speechCustomWords: [{ term: "Houston", aliases: ["hust"] }],
    };
    yield* transcribeEnvironmentPcm(
      prepared("http://localhost:3000"),
      new Uint8Array([1, 2, 3, 4]),
      options,
    ).pipe(
      Effect.provide(FetchHttpClient.layer),
      Effect.provideService(FetchHttpClient.Fetch, fetch),
    );
    expect(body).toBeDefined();
    const decoded = decodeSpeechPcmRequest(body!);
    expect(decoded.options).toEqual(options);
    expect(Array.from(decoded.pcm)).toEqual([1, 2, 3, 4]);
  }),
);

it.effect("opens speech streaming with a media ticket", () =>
  Effect.gen(function* () {
    const fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      Response.json({ ticket: "voice-ticket", expiresAt: "2026-10-25T12:00:00.000Z" }),
    );
    const streamUrl = yield* getEnvironmentSpeechStreamUrl(
      prepared("https://remote.example", { _tag: "Bearer", token: "credential" }),
    ).pipe(
      Effect.provide(FetchHttpClient.layer),
      Effect.provideService(FetchHttpClient.Fetch, fetch),
    );
    expect(fetch).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ method: "POST", redirect: "error" }),
    );
    expect(String(fetch.mock.calls[0]?.[0])).toBe(
      "https://remote.example/api/auth/websocket-ticket/media",
    );
    const url = new URL(streamUrl);
    expect(url.protocol).toBe("wss:");
    expect(url.pathname).toBe("/ws/voice");
    expect(url.searchParams.get("wsTicket")).toBe("voice-ticket");
    expect(url.searchParams.has("projectName")).toBe(false);
  }),
);

const cloudFetch = (respond: (url: URL, init?: RequestInit) => Response) =>
  vi.fn(async (input: RequestInfo | URL, init?: RequestInit) =>
    respond(new URL(String(input instanceof Request ? input.url : input)), init),
  );
const provideFetch =
  (fetch: ReturnType<typeof cloudFetch>) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.provide(FetchHttpClient.layer),
      Effect.provideService(FetchHttpClient.Fetch, fetch),
    );

it.effect("posts a cloud recording to its provider path with the options in the body", () =>
  Effect.gen(function* () {
    let body: Uint8Array | undefined;
    const fetch = cloudFetch((url, init) => {
      expect(url.pathname).toBe("/api/voice/cloud/openai/transcribe");
      expect(url.search).toBe("");
      body = init?.body as Uint8Array;
      return Response.json({ text: "hello" });
    });
    const options = {
      ...DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS,
      speechCustomWords: [{ term: "Houston", aliases: [] }],
    };
    const result = yield* transcribeCloudPcm(
      prepared("http://localhost:3000"),
      "openai",
      new Uint8Array([1, 2, 3, 4]),
      options,
    ).pipe(provideFetch(fetch));
    expect(result).toEqual({ text: "hello" });
    expect(decodeSpeechPcmRequest(body!).options).toEqual(options);
  }),
);

it.effect("names the exact OpenRouter model in the query and refuses to send without one", () =>
  Effect.gen(function* () {
    const fetch = cloudFetch((url) => {
      expect(url.pathname).toBe("/api/voice/cloud/openrouter/transcribe");
      expect(url.searchParams.get("model")).toBe("acme/voice-1");
      return Response.json({ text: "ok" });
    });
    yield* transcribeCloudPcm(
      prepared("http://localhost:3000"),
      "openrouter",
      new Uint8Array(4),
      DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS,
      "acme/voice-1",
    ).pipe(provideFetch(fetch));
    expect(fetch).toHaveBeenCalledTimes(1);

    const refused = vi.fn();
    const failure = yield* transcribeCloudPcm(
      prepared("http://localhost:3000"),
      "openrouter",
      new Uint8Array(4),
      DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS,
    ).pipe(provideFetch(cloudFetch(() => (refused(), Response.json({ text: "no" })))), Effect.flip);
    expect(failure).toMatchObject({ code: "unavailable" });
    expect(failure.message).toContain("OpenRouter");
    expect(refused).not.toHaveBeenCalled();
  }),
);

it.effect("does not send cloud audio to a remote environment over plain HTTP", () =>
  Effect.gen(function* () {
    const fetch = cloudFetch(() => Response.json({ text: "no" }));
    const failure = yield* transcribeCloudPcm(
      prepared("http://remote.example"),
      "xai",
      new Uint8Array(4),
      DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS,
    ).pipe(provideFetch(fetch), Effect.flip);
    expect(failure.message).toBe("Voice input requires HTTPS for remote environments.");
    expect(fetch).not.toHaveBeenCalled();
  }),
);

it.effect("reports a provider failure by its message, without the provider's body", () =>
  Effect.gen(function* () {
    const fetch = cloudFetch(() =>
      Response.json(
        { _tag: "CloudSpeechError", provider: "xai", reason: "rejected-key" },
        { status: 422 },
      ),
    );
    const failure = yield* transcribeCloudPcm(
      prepared("http://localhost:3000"),
      "xai",
      new Uint8Array(4),
      DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS,
    ).pipe(provideFetch(fetch), Effect.flip);
    expect(failure).toMatchObject({ code: "transcription-failed" });
    expect(failure.message).toBe(
      "xAI rejected this API key. Check its permissions and billing in Settings → Voice.",
    );
  }),
);

it.effect("stops before sending audio when the provider has no saved key", () =>
  Effect.gen(function* () {
    const fetch = cloudFetch((url) => {
      expect(url.pathname).toBe("/api/voice/cloud/keys");
      return Response.json({ openai: true, xai: false });
    });
    yield* requireCloudSpeechKey(prepared("http://localhost:3000"), "openai").pipe(
      provideFetch(fetch),
    );
    const failure = yield* requireCloudSpeechKey(prepared("http://localhost:3000"), "xai").pipe(
      provideFetch(fetch),
      Effect.flip,
    );
    expect(failure).toMatchObject({ code: "unavailable" });
    expect(failure.message).toContain("xAI");
    // A server that predates OpenRouter reports no flag, which is not a saved key.
    const older = yield* requireCloudSpeechKey(
      prepared("http://localhost:3000"),
      "openrouter",
    ).pipe(provideFetch(fetch), Effect.flip);
    expect(older.message).toContain("OpenRouter");
  }),
);

it.effect("saves a key in the body, never in the URL, and a reference as a reference", () =>
  Effect.gen(function* () {
    const seen: Array<{ url: string; body: unknown }> = [];
    const fetch = cloudFetch((url, init) => {
      seen.push({ url: url.toString(), body: JSON.parse(String(init?.body)) });
      return new Response(null, { status: 204 });
    });
    const reference = { provider: SecretProviderId.make("work"), reference: "op://Work/Voice/key" };
    yield* setCloudSpeechKey(prepared("http://localhost:3000"), "openai", "sk-fixture").pipe(
      provideFetch(fetch),
    );
    yield* setCloudSpeechKey(prepared("http://localhost:3000"), "xai", reference).pipe(
      provideFetch(fetch),
    );
    yield* setCloudSpeechKey(prepared("http://localhost:3000"), "openrouter", null).pipe(
      provideFetch(fetch),
    );
    expect(seen.map((entry) => entry.body)).toEqual([
      { key: "sk-fixture" },
      { key: reference },
      { key: null },
    ]);
    expect(seen.every((entry) => !entry.url.includes("sk-fixture"))).toBe(true);
  }),
);

it.effect("reads the OpenRouter catalog", () =>
  Effect.gen(function* () {
    const fetch = cloudFetch((url) => {
      expect(url.pathname).toBe("/api/voice/cloud/openrouter/models");
      return Response.json({ models: [{ id: "acme/voice-1", name: "Acme Voice" }] });
    });
    expect(
      yield* getCloudSpeechModels(prepared("http://localhost:3000")).pipe(provideFetch(fetch)),
    ).toEqual({
      models: [{ id: "acme/voice-1", name: "Acme Voice" }],
    });
  }),
);
