import { cloudSpeechLanguages, effectiveSpeechLanguage } from "@houston-app/shared/speech";
import {
  getEnvironmentSpeechStatus,
  getEnvironmentSpeechStreamUrl,
  openSpeechStream,
  requireCloudSpeechKey,
  throwIfVoiceTranscriptionAborted,
  transcribeCloudPcm,
  transcribeEnvironmentPcm,
  VoiceTranscriptionError,
  type VoiceTranscriptionOptions,
} from "@houston-app/client-runtime/voice-input";
import type { PreparedConnection } from "@houston-app/client-runtime/connection";
import type {
  CloudSpeechModelId,
  CloudSpeechProvider,
  SpeechStreamText,
  SpeechTranscriptionOptions,
} from "@houston-app/contracts";

import { runtime } from "../lib/runtime";
import { createBrowserPcmCapture } from "./browserPcmCapture";

export function createBrowserVoiceInputPlatform(input: {
  readonly prepared: PreparedConnection;
  /** Send each finished recording to this provider through `prepared` instead of its local engine. */
  readonly cloudProvider?: CloudSpeechProvider | undefined;
  /** The exact OpenRouter model the grant names; that provider sends nothing without it. */
  readonly cloudModel?: CloudSpeechModelId | undefined;
  /** Re-read at each send: audio never leaves the device once the audio grant has changed. */
  readonly hasAudioConsent: () => boolean;
  readonly getTranscriptionOptions: () => SpeechTranscriptionOptions;
  readonly getMicrophoneId: () => string;
  readonly onLevel: (level: number) => void;
  readonly onDurationLimit: () => void;
  readonly onText: (text: SpeechStreamText) => void;
  readonly onError: (message: string) => void;
}) {
  return createBrowserPcmCapture(input, async (options) => {
    const recordingOptions = input.getTranscriptionOptions();
    const transcribeRecording = async (
      uri: string,
      { signal: transcriptionSignal }: VoiceTranscriptionOptions,
    ) => {
      try {
        if (!input.hasAudioConsent())
          throw new VoiceTranscriptionError(
            "cancelled",
            "The audio destination changed before this recording was sent.",
          );
        const response = await fetch(uri, { signal: transcriptionSignal });
        const pcm = new Uint8Array(await response.arrayBuffer());
        const result = await runtime.runPromise(
          input.cloudProvider
            ? transcribeCloudPcm(
                input.prepared,
                input.cloudProvider,
                pcm,
                recordingOptions,
                input.cloudModel,
              )
            : transcribeEnvironmentPcm(input.prepared, pcm, recordingOptions),
          { signal: transcriptionSignal },
        );
        throwIfVoiceTranscriptionAborted(transcriptionSignal);
        return result.text;
      } catch (cause) {
        throwIfVoiceTranscriptionAborted(transcriptionSignal);
        if (cause instanceof VoiceTranscriptionError) throw cause;
        throw new VoiceTranscriptionError(
          "transcription-failed",
          input.cloudProvider
            ? "Cloud transcription failed. Check the destination in Settings → Voice."
            : "Voice transcription on this environment failed.",
          { cause },
        );
      }
    };
    if (input.cloudProvider) {
      if (input.cloudProvider === "openrouter" && !input.cloudModel)
        throw new VoiceTranscriptionError(
          "unavailable",
          "Choose an OpenRouter model in Settings → Voice.",
        );
      await runtime.runPromise(requireCloudSpeechKey(input.prepared, input.cloudProvider), options);
      throwIfVoiceTranscriptionAborted(options.signal);
      return {
        locale: effectiveSpeechLanguage(cloudSpeechLanguages, recordingOptions.speechLanguage),
        transcribe: transcribeRecording,
      };
    }
    const status = await runtime.runPromise(getEnvironmentSpeechStatus(input.prepared), options);
    throwIfVoiceTranscriptionAborted(options.signal);
    if (!status.supported) throw new VoiceTranscriptionError("unavailable", status.reason);
    const language = status.languages
      ? effectiveSpeechLanguage(
          {
            languages: status.languages,
            supportsLanguageDetection: status.supportsLanguageDetection ?? false,
          },
          recordingOptions.speechLanguage,
        )
      : "auto";
    const locale =
      !status.supportsStreaming &&
      status.supportsTranslation &&
      recordingOptions.speechTranslateToEnglish
        ? "en"
        : language;
    if (!status.supportsStreaming && !status.supportsBufferedStreaming) {
      return { locale, transcribe: transcribeRecording };
    }
    const url = await runtime.runPromise(getEnvironmentSpeechStreamUrl(input.prepared), options);
    // The socket opens asynchronously; audio captured meanwhile waits here and is
    // dropped, never sent, when the recording is cancelled or consent has changed.
    let pending: Float32Array[] | null = [];
    let live: Awaited<ReturnType<typeof openSpeechStream>> | undefined;
    const session = openSpeechStream({
      url,
      options: recordingOptions,
      signal: options.signal,
      onText: input.onText,
      onError: (error) => input.onError(error.message),
    }).then((opened) => {
      const queued = pending ?? [];
      pending = null;
      if (options.signal.aborted) return opened;
      live = opened;
      for (const chunk of queued) opened.feed(chunk);
      return opened;
    });
    void session.catch((error: unknown) => {
      if (!options.signal.aborted)
        input.onError(error instanceof Error ? error.message : "Could not prepare voice input.");
    });
    return {
      locale,
      transcribe: transcribeRecording,
      streaming: {
        feed: (pcm: Float32Array) => {
          if (!input.hasAudioConsent()) {
            input.onError("The audio destination changed. Please record again.");
            return;
          }
          if (live) live.feed(pcm);
          else pending?.push(pcm);
        },
        finish: async (finishOptions: VoiceTranscriptionOptions) => {
          throwIfVoiceTranscriptionAborted(finishOptions.signal);
          return (await session).finish();
        },
      },
    };
  });
}
