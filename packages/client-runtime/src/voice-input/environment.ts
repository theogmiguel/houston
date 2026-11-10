import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { encodeSpeechPcmRequest } from "@houston-app/shared/speech";
import { CLOUD_SPEECH_LABELS, CloudSpeechError, SPEECH_STREAM_PATH } from "@houston-app/contracts";
import type {
  CloudSpeechModelId,
  CloudSpeechProvider,
  SettingsSecretValue,
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
import { VoiceTranscriptionError } from "./transcription.ts";

const VOICE_REQUEST_TIMEOUT_MS = 30 * 60_000;
/** The server gives a provider two minutes; ten more seconds let its error reach the client. */
const CLOUD_TRANSCRIBE_TIMEOUT_MS = 130_000;
const isCloudSpeechError = Schema.is(CloudSpeechError);
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
  readonly timeoutMs?: number;
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
    timeoutMs: input.timeoutMs ?? VOICE_REQUEST_TIMEOUT_MS,
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

export const getCloudSpeechKeys = (prepared: PreparedConnection) =>
  request({
    group: "voice",
    prepared,
    method: "GET",
    path: (urls) => urls.cloudKeys(),
    run: ({ client, headers }) => client.cloudKeys({ headers }),
  });

export const getCloudSpeechModels = (prepared: PreparedConnection) =>
  request({
    group: "voice",
    prepared,
    method: "GET",
    path: (urls) => urls.cloudModels(),
    run: ({ client, headers }) => client.cloudModels({ headers }),
  });

/** Fails before any audio is sent when the environment holds no key for `provider`. */
export const requireCloudSpeechKey = (
  prepared: PreparedConnection,
  provider: CloudSpeechProvider,
) =>
  getCloudSpeechKeys(prepared).pipe(
    Effect.flatMap((keys) =>
      keys[provider]
        ? Effect.void
        : Effect.fail(
            new VoiceTranscriptionError(
              "unavailable",
              new CloudSpeechError({ provider, reason: "missing-key" }).message,
            ),
          ),
    ),
  );

/** A literal is sent in the body once and is never returned; `null` removes the saved key. */
export const setCloudSpeechKey = (
  prepared: PreparedConnection,
  provider: CloudSpeechProvider,
  key: SettingsSecretValue | null,
) =>
  request({
    group: "voice",
    prepared,
    method: "POST",
    path: (urls) => urls.setCloudKey({ params: { provider } }),
    run: ({ client, headers }) =>
      client.setCloudKey({
        headers,
        params: { provider },
        payload: { key: typeof key === "string" ? Redacted.make(key) : key },
      }),
  });

/**
 * Sends one finished recording to `provider` through `prepared`. OpenRouter needs the exact model
 * the user chose; without it nothing is sent.
 */
export const transcribeCloudPcm = (
  prepared: PreparedConnection,
  provider: CloudSpeechProvider,
  pcm: Uint8Array,
  options: SpeechTranscriptionOptions,
  model?: CloudSpeechModelId,
) => {
  if (provider === "openrouter" && model === undefined)
    return Effect.fail(
      new VoiceTranscriptionError(
        "unavailable",
        `Choose a ${CLOUD_SPEECH_LABELS.openrouter} model in Settings → Voice.`,
      ),
    );
  const query = model === undefined ? {} : { model };
  return request({
    group: "voice",
    prepared,
    method: "POST",
    timeoutMs: CLOUD_TRANSCRIBE_TIMEOUT_MS,
    path: (urls) => urls.transcribeCloud({ params: { provider }, query }),
    run: ({ client, headers }) =>
      client.transcribeCloud({
        headers,
        params: { provider },
        query,
        payload: encodeSpeechPcmRequest(pcm, options),
      }),
  }).pipe(
    Effect.mapError((error) =>
      error._tag === "RemoteEnvironmentAuthFetchError" && isCloudSpeechError(error.cause)
        ? new VoiceTranscriptionError("transcription-failed", error.cause.message)
        : error,
    ),
  );
};

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
