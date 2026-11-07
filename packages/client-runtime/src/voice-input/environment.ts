import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { encodeSpeechPcmRequest } from "@houston-app/shared/speech";
import { SPEECH_STREAM_PATH } from "@houston-app/contracts";
import type {
  SpeechAcceleration,
  SpeechModelUnloadTimeout,
  SpeechPostProcessingOptions,
  SpeechTranscriptionOptions,
} from "@houston-app/contracts";
import { RemoteEnvironmentAuthFetchError } from "../rpc/http.ts";

import type { PreparedConnection } from "../connection/model.ts";
import {
  makeEnvironmentHttpApiGroupClient,
  makeEnvironmentHttpApiUrlBuilder,
} from "../rpc/http.ts";
import { executeAuthenticatedEnvironmentHttpRequest } from "../state/environmentHttpAuth.ts";

const VOICE_REQUEST_TIMEOUT_MS = 30 * 60_000;
type EnvironmentApiClient<G extends "voice" | "auth"> = Effect.Success<
  ReturnType<typeof makeEnvironmentHttpApiGroupClient<G>>
>;

const LOOPBACK_PATTERN = /^127\.\d+\.\d+\.\d+$/;

const request = Effect.fn("clientRuntime.voiceInput.environmentRequest")(function* <
  A,
  E,
  G extends "voice" | "auth",
>(input: {
  readonly group: G;
  readonly prepared: PreparedConnection;
  readonly method: "GET" | "POST" | "DELETE";
  readonly path: (
    urls: ReturnType<typeof makeEnvironmentHttpApiUrlBuilder>[G],
    baseUrl: string,
  ) => string;
  readonly run: (input: {
    readonly client: EnvironmentApiClient<G>;
    readonly headers: { readonly authorization?: string; readonly dpop?: string };
  }) => Effect.Effect<A, E>;
}) {
  return yield* executeAuthenticatedEnvironmentHttpRequest({
    group: input.group,
    prepared: input.prepared,
    method: input.method,
    url: input.path,
    timeoutMs: VOICE_REQUEST_TIMEOUT_MS,
    requestInit: { redirect: "error" },
    validateUrl: (baseUrl) =>
      Effect.try({
        try: () => {
          const url = new URL(baseUrl);
          const loopback =
            url.hostname === "localhost" ||
            url.hostname === "[::1]" ||
            LOOPBACK_PATTERN.test(url.hostname);
          if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
            throw new Error("Voice input requires HTTPS for remote environments.");
          }
        },
        catch: (cause) =>
          new RemoteEnvironmentAuthFetchError({
            message: "Voice input requires HTTPS for remote environments.",
            cause,
          }),
      }),
    request: input.run,
  });
});

export const getEnvironmentSpeechStatus = (prepared: PreparedConnection) =>
  request({
    group: "voice",
    prepared,
    method: "GET",
    path: (urls) => urls.status(),
    run: ({ client, headers }) => client.status({ headers }),
  });

export const getEnvironmentSpeechStreamUrl = (prepared: PreparedConnection) => {
  let endpoint = prepared.httpBaseUrl;
  return request({
    group: "auth",
    prepared,
    method: "POST",
    path: (urls, baseUrl) => {
      endpoint = baseUrl;
      return urls.webSocketTicketFor({ params: { use: "media" } });
    },
    run: ({ client, headers }) => client.webSocketTicketFor({ headers, params: { use: "media" } }),
  }).pipe(
    Effect.map(({ ticket }) => {
      const url = new URL(SPEECH_STREAM_PATH, endpoint);
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      url.searchParams.set("wsTicket", Redacted.value(ticket));
      return url.toString();
    }),
  );
};

export const getEnvironmentSpeechModels = (
  prepared: PreparedConnection,
  includeBenchmarks = false,
) => {
  const query = includeBenchmarks ? { benchmarks: "1" as const } : {};
  return request({
    group: "voice",
    prepared,
    method: "GET",
    path: (urls) => urls.models({ query }),
    run: ({ client, headers }) => client.models({ headers, query }),
  });
};

export const prepareEnvironmentSpeechModel = (prepared: PreparedConnection) =>
  request({
    group: "voice",
    prepared,
    method: "POST",
    path: (urls) => urls.prepareModel(),
    run: ({ client, headers }) => client.prepareModel({ headers }),
  });

export const downloadEnvironmentSpeechModel = (prepared: PreparedConnection, modelId: string) =>
  request({
    group: "voice",
    prepared,
    method: "POST",
    path: (urls) => urls.downloadModel(),
    run: ({ client, headers }) => client.downloadModel({ headers, payload: { modelId } }),
  });

export const selectEnvironmentSpeechModel = (prepared: PreparedConnection, modelId: string) =>
  request({
    group: "voice",
    prepared,
    method: "POST",
    path: (urls) => urls.selectModel(),
    run: ({ client, headers }) => client.selectModel({ headers, payload: { modelId } }),
  });

export const cancelEnvironmentSpeechModelDownload = (
  prepared: PreparedConnection,
  modelId: string,
) =>
  request({
    group: "voice",
    prepared,
    method: "POST",
    path: (urls) => urls.cancelModelDownload(),
    run: ({ client, headers }) => client.cancelModelDownload({ headers, payload: { modelId } }),
  });

export const transcribeEnvironmentPcm = (
  prepared: PreparedConnection,
  pcm: Uint8Array,
  options: SpeechTranscriptionOptions,
) =>
  request({
    group: "voice",
    prepared,
    method: "POST",
    path: (urls) => urls.transcribe(),
    run: ({ client, headers }) =>
      client.transcribe({ headers, payload: encodeSpeechPcmRequest(pcm, options) }),
  });

/** Sends the transcript and draft context to a text-generation provider on `prepared`. */
export const postProcessEnvironmentTranscript = (
  prepared: PreparedConnection,
  transcript: string,
  draft: {
    readonly text: string;
    readonly selection: { readonly start: number; readonly end: number };
  },
  options: SpeechPostProcessingOptions,
) =>
  request({
    group: "voice",
    prepared,
    method: "POST",
    path: (urls) => urls.postProcess(),
    run: ({ client, headers }) =>
      client.postProcess({ headers, payload: { transcript, draft, options } }),
  });

export const updateEnvironmentSpeechAcceleration = (
  prepared: PreparedConnection,
  acceleration: SpeechAcceleration,
) =>
  request({
    group: "voice",
    prepared,
    method: "POST",
    path: (urls) => urls.updateAcceleration(),
    run: ({ client, headers }) => client.updateAcceleration({ headers, payload: { acceleration } }),
  });

export const updateEnvironmentSpeechModelUnloadTimeout = (
  prepared: PreparedConnection,
  timeout: SpeechModelUnloadTimeout,
) =>
  request({
    group: "voice",
    prepared,
    method: "POST",
    path: (urls) => urls.updateModelUnloadTimeout(),
    run: ({ client, headers }) =>
      client.updateModelUnloadTimeout({ headers, payload: { timeout } }),
  });

export const removeEnvironmentSpeechModel = (prepared: PreparedConnection, modelId: string) =>
  request({
    group: "voice",
    prepared,
    method: "POST",
    path: (urls) => urls.removeModel(),
    run: ({ client, headers }) => client.removeModel({ headers, payload: { modelId } }),
  });
