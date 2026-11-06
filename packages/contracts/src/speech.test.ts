import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import {
  DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS,
  EnvironmentSpeechStatus,
  EnvironmentSpeechTranscriptionResult,
  SpeechStreamCommand,
  SpeechTranscriptionOptions,
} from "./speech.ts";

const decodeStatus = Schema.decodeUnknownSync(EnvironmentSpeechStatus);
const decodeTranscription = Schema.decodeUnknownSync(EnvironmentSpeechTranscriptionResult);
const decodeStreamCommand = Schema.decodeUnknownSync(SpeechStreamCommand);
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
