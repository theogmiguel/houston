import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import { SETTINGS_SECRET_MAX_BYTES } from "./settingsSecretValue.ts";
import {
  CLOUD_SPEECH_ERROR_REASONS,
  CloudSpeechApiKey,
  CloudSpeechError,
  CloudSpeechKeys,
  CloudSpeechModelId,
  DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS,
  EnvironmentSpeechStatus,
  EnvironmentSpeechTranscriptionResult,
  SpeechStreamCommand,
  SpeechTranscriptionOptions,
} from "./speech.ts";

const decodeStatus = Schema.decodeUnknownSync(EnvironmentSpeechStatus);
const decodeTranscription = Schema.decodeUnknownSync(EnvironmentSpeechTranscriptionResult);
const decodeStreamCommand = Schema.decodeUnknownSync(SpeechStreamCommand);
const decodeCloudSpeechKeys = Schema.decodeSync(CloudSpeechKeys);
const decodeTranscriptionOptions = Schema.decodeUnknownSync(SpeechTranscriptionOptions);
const readyStatus = {
  supported: true,
  state: "ready",
  modelId: "handy-computer/moonshine-tiny-gguf",
  model: "Moonshine Tiny",
  size: 35_466_912,
  supportsStreaming: false,
  supportsTranslation: true,
  acceleration: "auto",
  modelUnloadTimeout: "min_15",
  gpuDevices: [],
};

describe("environment speech contracts", () => {
  it("accepts supported and unsupported statuses", () => {
    expect(decodeStatus(readyStatus)).toEqual(readyStatus);
    expect(decodeStatus({ supported: false, reason: "unsupported platform" })).toEqual({
      supported: false,
      reason: "unsupported platform",
    });
  });

  it.each(["acceleration", "modelUnloadTimeout", "gpuDevices", "supportsTranslation"])(
    "rejects a supported status missing %s",
    (field) => {
      const incomplete = Object.fromEntries(
        Object.entries(readyStatus).filter(([key]) => key !== field),
      );
      expect(() => decodeStatus(incomplete)).toThrow();
    },
  );

  it("names the unavailable selection when the server fell back to its default model", () => {
    const fallback = { ...readyStatus, unavailableModelId: "handy-computer/retired-gguf" };
    expect(decodeStatus(fallback)).toEqual(fallback);
  });

  it("bounds vocabulary entries and rejects duplicate aliases in recording options", () => {
    const decode = (customWords: unknown) =>
      decodeTranscriptionOptions({
        ...DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS,
        speechCustomWords: customWords,
      });
    expect(() => decode([{ term: "x".repeat(51), aliases: [] }])).toThrow();
    expect(() =>
      decode([
        { term: "MiniMax", aliases: ["mini max"] },
        { term: "Other", aliases: ["MINI MAX"] },
      ]),
    ).toThrow();
  });

  it("starts a stream with options and finishes without any", () => {
    const decode = decodeStreamCommand;
    expect(
      decode({ type: "start", options: { ...DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS } }).type,
    ).toBe("start");
    expect(decode({ type: "finish" })).toEqual({ type: "finish" });
    expect(() => decode({ type: "start" })).toThrow();
  });

  it("accepts a transcription result", () => {
    expect(decodeTranscription({ text: "hello" })).toEqual({ text: "hello" });
  });
});

describe("cloud speech contracts", () => {
  const decodeKey = Schema.decodeUnknownSync(CloudSpeechApiKey);
  const decodeModel = Schema.decodeUnknownSync(CloudSpeechModelId);

  it("accepts a normal key and refuses one above the credential bound, naming both sizes", () => {
    expect(decodeKey("  sk-test_123  ")).toBe("sk-test_123");
    const oversize = "k".repeat(SETTINGS_SECRET_MAX_BYTES + 1);
    expect(() => decodeKey(oversize)).toThrow(
      `${SETTINGS_SECRET_MAX_BYTES + 1} bytes, over the limit of ${SETTINGS_SECRET_MAX_BYTES} bytes`,
    );
  });

  it.each(["has space", "https://api.example.test/key", "tab\tkey", "clé"])(
    "refuses the key shape %j",
    (key) => {
      expect(() => decodeKey(key)).toThrow();
    },
  );

  it("accepts exact author/model slugs and refuses router shortcuts", () => {
    expect(decodeModel("acme/transcribe-1")).toBe("acme/transcribe-1");
    for (const slug of ["openrouter/auto", "acme", "acme/model:nitro", "/model", "acme/"]) {
      expect(() => decodeModel(slug)).toThrow();
    }
  });

  it("names the provider in every error reason", () => {
    for (const reason of CLOUD_SPEECH_ERROR_REASONS) {
      const message = new CloudSpeechError({ provider: "xai", reason }).message;
      expect(message, reason).toContain("xAI");
    }
  });

  it("decodes key status from servers that predate OpenRouter", () => {
    expect(decodeCloudSpeechKeys({ openai: true, xai: false })).toEqual({
      openai: true,
      xai: false,
    });
  });
});
