import { expect, vi } from "vite-plus/test";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import { FetchHttpClient } from "effect/http";
import { DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS, EnvironmentId } from "@houston-app/contracts";
import { decodeSpeechPcmRequest } from "@houston-app/shared/speech";
import * as Schema from "effect/Schema";
import {
  PrimaryConnectionTarget,
  type PreparedConnection,
  type PreparedHttpAuthorization,
} from "../connection/model.ts";
import { getEnvironmentSpeechStreamUrl, transcribeEnvironmentPcm } from "./environment.ts";

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
