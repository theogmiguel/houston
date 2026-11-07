import { it } from "@effect/vitest";
import { DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS, SecretProviderId } from "@houston-app/contracts";
import * as SecretResolver from "@houston-app/secret-provider-core/server/SecretResolver";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import { expect, vi } from "vite-plus/test";
import * as ServerSettings from "../serverSettings.ts";
import * as CloudSpeech from "./CloudSpeech.ts";

const PCM = () => new Uint8Array(new Float32Array([0, 0.5]).buffer);

const makeService = (resolver: Partial<SecretResolver.SecretResolver["Service"]> = {}) =>
  CloudSpeech.CloudSpeech.pipe(
    Effect.provide(
      CloudSpeech.layer.pipe(
        Layer.provide(FetchHttpClient.layer),
        Layer.provide(ServerSettings.ServerSettingsService.layerTest()),
        Layer.provide(Layer.mock(SecretResolver.SecretResolver)(resolver)),
      ),
    ),
  );

it.effect.each(["openai", "xai"] as const)("sends only to %s using its own saved key", (provider) =>
  Effect.gen(function* () {
    const reference = {
      provider: SecretProviderId.make("work"),
      reference: "op://Work/Voice/key",
    };
    let resolved: string | undefined;
    let cached: string | undefined;
    const read = vi.fn(() => Effect.sync(() => [(cached ??= resolved)]));
    const upstream = vi.fn<typeof fetch>(async () => Response.json({ text: "hello" }));
    const service = yield* makeService({
      read,
      label: () => Effect.succeed("Work"),
      invalidate: () =>
        Effect.sync(() => {
          cached = undefined;
        }),
    });
    const transcribe = (pcm = PCM()) =>
      service
        .transcribe(provider, pcm, {
          ...DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS,
          speechLanguage: "en",
          speechCustomWords: [{ term: "Houston", aliases: [] }],
        })
        .pipe(Effect.provideService(FetchHttpClient.Fetch, upstream));
    yield* service.setKey(provider === "openai" ? "xai" : "openai", Redacted.make("other"));
    expect((yield* Effect.flip(transcribe()))._tag).toBe("CloudSpeechError");
    yield* service.setKey(provider, Redacted.make("chosen"));
    expect(yield* service.configured).toEqual({ openai: true, xai: true, openrouter: false });
    yield* Effect.flip(transcribe(new Uint8Array(3)));
    expect(upstream).not.toHaveBeenCalled();
    expect(yield* transcribe()).toBe("hello");
    const [url, init] = upstream.mock.calls[0]!;
    expect(String(url)).toBe(
      {
        openai: "https://api.openai.com/v1/audio/transcriptions",
        xai: "https://api.x.ai/v1/stt",
      }[provider],
    );
    expect(init?.redirect).toBe("error");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer chosen");
    const form = init?.body as FormData;
    expect(form.get("model")).toBe(
      provider === "openai" ? "gpt-transcribe" : "grok-voice-transcribe-2.0",
    );
    expect(form.getAll(provider === "openai" ? "keywords[]" : "keyterm")).toEqual(["Houston"]);
    expect(form.get(provider === "openai" ? "languages[]" : "language")).toBe("en");
    expect([...form.keys()].at(-1)).toBe("file");
    const wav = new DataView(yield* Effect.promise(() => (form.get("file") as Blob).arrayBuffer()));
    expect(wav.getUint32(24, true)).toBe(16_000);
    expect(wav.getInt16(46, true)).toBe(16384);
    upstream.mockResolvedValueOnce(new Response("sensitive upstream diagnostic", { status: 401 }));
    const rejected = yield* Effect.flip(transcribe());
    expect(rejected).toMatchObject({ provider, reason: "rejected-key" });
    expect(rejected.message).not.toContain("sensitive upstream diagnostic");
    yield* service.setKey(provider, null);
    expect((yield* service.configured)[provider]).toBe(false);
    yield* Effect.flip(transcribe());
    expect(upstream).toHaveBeenCalledTimes(2);
    yield* service.setKey(provider, reference);
    expect((yield* service.configured)[provider]).toBe(true);
    expect(read).not.toHaveBeenCalled();
    resolved = "resolved-fixture";
    expect(yield* transcribe()).toBe("hello");
    expect(read).toHaveBeenCalledWith([reference]);
    expect(new Headers(upstream.mock.calls[2]?.[1]?.headers).get("authorization")).toBe(
      "Bearer resolved-fixture",
    );
    resolved = undefined;
    expect(yield* Effect.flip(transcribe())).toMatchObject({
      provider,
      reason: "unreadable-key",
    });
    expect(upstream).toHaveBeenCalledTimes(3);
  }),
);

it.effect("uploads to OpenRouter only for a listed exact model, as zero-retention JSON WAV", () =>
  Effect.gen(function* () {
    const upstream = vi.fn<typeof fetch>(async (input) =>
      new URL(String(input)).pathname.endsWith("/models")
        ? Response.json({ data: [{ id: "acme/transcribe-1" }, { id: "acme/transcribe-2" }] })
        : Response.json({ text: "hello" }),
    );
    const service = yield* makeService();
    const uploads = () =>
      upstream.mock.calls.filter(([url]) => String(url).endsWith("/audio/transcriptions"));
    const transcribe = (model: string | undefined) =>
      service
        .transcribe(
          "openrouter",
          PCM(),
          {
            ...DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS,
            speechLanguage: "en",
            speechCustomWords: [{ term: "Houston", aliases: [] }],
          },
          model,
        )
        .pipe(Effect.provideService(FetchHttpClient.Fetch, upstream));
    yield* service.setKey("openrouter", Redacted.make("router-key"));
    expect(yield* Effect.flip(transcribe(undefined))).toMatchObject({ provider: "openrouter" });
    upstream.mockResolvedValueOnce(new Response(null, { status: 503 }));
    expect(yield* Effect.flip(transcribe("acme/transcribe-2"))).toMatchObject({
      reason: "unavailable",
    });
    expect(yield* Effect.flip(transcribe("acme/delisted"))).toMatchObject({
      provider: "openrouter",
      reason: "model-unavailable",
    });
    expect(uploads()).toEqual([]);
    expect(yield* transcribe("acme/transcribe-2")).toBe("hello");
    const [[url, init]] = uploads() as [[URL, RequestInit]];
    expect(new URL(String(upstream.mock.calls[0]![0])).searchParams.get("zdr")).toBe("true");
    expect(String(url)).toBe("https://openrouter.ai/api/v1/audio/transcriptions");
    expect(init.redirect).toBe("error");
    const headers = new Headers(init.headers);
    expect(headers.get("authorization")).toBe("Bearer router-key");
    expect(headers.get("content-type")).toContain("application/json");
    const raw = yield* Effect.promise(() => new Response(init.body).text());
    // OpenRouter gets neither project names nor dictionary hints.
    expect(raw).not.toContain("Houston");
    const body = JSON.parse(raw) as {
      model: string;
      models?: unknown;
      provider: { zdr: boolean };
      input_audio: { format: string; data: string };
    };
    expect(body).toMatchObject({
      model: "acme/transcribe-2",
      provider: { zdr: true },
      input_audio: { format: "wav" },
    });
    expect(body.models).toBeUndefined();
    const wav = Buffer.from(body.input_audio.data, "base64");
    expect(wav.toString("ascii", 0, 4)).toBe("RIFF");
    expect(wav.readInt16LE(46)).toBe(16384);
  }),
);

it.effect("removing a key while a catalog read is pending prevents the upload", () =>
  Effect.gen(function* () {
    const service = yield* makeService();
    const catalogStarted = Promise.withResolvers<void>();
    const catalog = Promise.withResolvers<Response>();
    const uploads: string[] = [];
    const upstream: typeof fetch = async (input) => {
      if (new URL(String(input)).pathname.endsWith("/models")) {
        catalogStarted.resolve();
        return catalog.promise;
      }
      uploads.push(String(input));
      return Response.json({ text: "unexpected" });
    };
    yield* service.setKey("openrouter", Redacted.make("old-key"));
    const job = yield* service
      .transcribe(
        "openrouter",
        new Uint8Array(4),
        DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS,
        "acme/voice",
      )
      .pipe(Effect.provideService(FetchHttpClient.Fetch, upstream), Effect.forkChild);
    yield* Effect.promise(() => catalogStarted.promise);
    yield* service.setKey("openrouter", null);
    catalog.resolve(Response.json({ data: [{ id: "acme/voice" }] }));
    const exit = yield* Fiber.await(job);
    expect(uploads).toEqual([]);
    expect(exit._tag).toBe("Failure");
  }),
);

it.effect("replacing a key during the vault read stops the upload with key-changed", () =>
  Effect.gen(function* () {
    const reference = {
      provider: SecretProviderId.make("work"),
      reference: "op://Work/Voice/key",
    };
    const readStarted = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const upstream = vi.fn<typeof fetch>(async () => Response.json({ text: "unexpected" }));
    const service = yield* makeService({
      invalidate: () => Effect.void,
      read: () =>
        Effect.promise(async () => {
          readStarted.resolve();
          await release.promise;
          return ["vault-key"];
        }),
    });
    yield* service.setKey("openai", reference);
    const job = yield* service
      .transcribe("openai", PCM(), DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS)
      .pipe(Effect.provideService(FetchHttpClient.Fetch, upstream), Effect.forkChild);
    yield* Effect.promise(() => readStarted.promise);
    yield* service.setKey("openai", Redacted.make("replacement"));
    release.resolve();
    const exit = yield* Fiber.await(job);
    expect(upstream).not.toHaveBeenCalled();
    expect(JSON.stringify(exit)).toContain("key-changed");
  }),
);

it.effect("refuses a response over the size limit, naming the provider, limit and size", () =>
  Effect.gen(function* () {
    const service = yield* makeService();
    yield* service.setKey("openai", Redacted.make("chosen"));
    const huge = "x".repeat(CloudSpeech.MAX_TRANSCRIPTION_RESPONSE_BYTES + 1);
    const upstream = vi.fn<typeof fetch>(async () => Response.json({ text: huge }));
    const error = yield* Effect.flip(
      service
        .transcribe("openai", PCM(), DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS)
        .pipe(Effect.provideService(FetchHttpClient.Fetch, upstream)),
    );
    expect(error).toMatchObject({ provider: "openai", reason: "response-too-large" });
    expect(error.message).toContain(String(CloudSpeech.MAX_TRANSCRIPTION_RESPONSE_BYTES));
    expect(error.message).toContain("OpenAI");
  }),
);

it.effect(
  "treats the OpenRouter catalog as data: bad slugs are dropped and the count is capped",
  () =>
    Effect.gen(function* () {
      const service = yield* makeService();
      const entries = [
        { id: "openrouter/auto", name: "Router" },
        { id: "acme/ok-1", name: "  Acme One  " },
        { id: "not a slug" },
        { id: "acme/no-name" },
        ...Array.from({ length: CloudSpeech.MAX_CATALOG_MODELS + 10 }, (_, index) => ({
          id: `bulk/model-${index}`,
        })),
      ];
      const upstream = vi.fn<typeof fetch>(async () => Response.json({ data: entries }));
      const models = yield* service.models.pipe(
        Effect.provideService(FetchHttpClient.Fetch, upstream),
      );
      expect(models.slice(0, 2)).toEqual([
        { id: "acme/ok-1", name: "Acme One" },
        { id: "acme/no-name", name: "acme/no-name" },
      ]);
      expect(models).toHaveLength(CloudSpeech.MAX_CATALOG_MODELS);
    }),
);
