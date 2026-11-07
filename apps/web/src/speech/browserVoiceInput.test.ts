import { afterEach, expect, it, vi } from "vite-plus/test";
import * as Effect from "effect/Effect";
import type { PreparedConnection } from "@houston-app/client-runtime/connection";
import { DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS } from "@houston-app/contracts";
import {
  VoiceInputController,
  VoiceTranscriptionError,
} from "@houston-app/client-runtime/voice-input";

const mocks = vi.hoisted(() => ({
  openStream: vi.fn(),
}));

vi.mock("@houston-app/client-runtime/voice-input", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@houston-app/client-runtime/voice-input")>()),
  getEnvironmentSpeechStatus: () =>
    Effect.succeed({ supported: true, state: "ready", supportsStreaming: true }),
  getEnvironmentSpeechStreamUrl: () => Effect.succeed("ws://speech.test"),
  openSpeechStream: mocks.openStream,
}));
vi.mock("../lib/runtime", () => ({ runtime: { runPromise: Effect.runPromise } }));

import { createBrowserVoiceInputPlatform } from "./browserVoiceInput";

let worklet: {
  port: {
    onmessage: ((event: { data: Float32Array | number | "stopped" }) => void) | null;
    postMessage: () => void;
    close: () => void;
  };
};

afterEach(() => vi.unstubAllGlobals());

it.each([
  { cancelled: false, consentLost: false },
  { cancelled: true, consentLost: false },
  { cancelled: false, consentLost: true },
])(
  "keeps pending streaming audio unless it is withdrawn: %o",
  async ({ cancelled, consentLost }) => {
    let consent = true;
    const onError = vi.fn();
    const session = Promise.withResolvers<{
      feed: (pcm: Float32Array) => void;
      finish: () => Promise<string>;
    }>();
    mocks.openStream.mockReturnValueOnce(session.promise);
    const feed = vi.fn();
    const onLevel = vi.fn();
    worklet = {
      port: { onmessage: null, postMessage: vi.fn(), close: vi.fn() },
    };
    vi.stubGlobal("navigator", {
      mediaDevices: { getUserMedia: async () => ({ getTracks: () => [] }) },
    });
    vi.stubGlobal(
      "AudioContext",
      class {
        audioWorklet = { addModule: async () => {} };
        destination = {};
        createMediaStreamSource() {
          return { connect: () => {} };
        }
        resume = async () => {};
        close = async () => {};
      },
    );
    vi.stubGlobal(
      "AudioWorkletNode",
      class {
        port = worklet.port;
        connect() {}
        disconnect() {}
      },
    );

    const platform = createBrowserVoiceInputPlatform({
      prepared: {} as PreparedConnection,
      hasAudioConsent: () => consent,
      getTranscriptionOptions: () => DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS,
      getMicrophoneId: () => "",
      onLevel,
      onDurationLimit() {},
      onText() {},
      onError,
    });
    const released = Promise.withResolvers<void>();
    const commitDraft = vi.fn();
    const controller = new VoiceInputController({
      recorder: platform.recorder,
      getTranscriber: () => platform.transcriber,
      requestPermission: async () => ({ granted: true, canAskAgain: true }),
      configureRecording: async () => undefined,
      releaseRecording: async () => {
        platform.cancelRecording();
        released.resolve();
      },
      deleteRecording: platform.deleteRecording,
      readDraft: () => ({
        ownerKey: "draft",
        text: "",
        selection: { start: 0, end: 0 },
        revision: 0,
      }),
      commitDraft,
      onStateChange() {},
    });
    await controller.start();
    worklet.port.onmessage?.({ data: 0.4 });
    expect(onLevel).toHaveBeenLastCalledWith(0.4);
    const earlyAudio = new Float32Array([0.25, 0.5]);
    if (consentLost) consent = false;
    worklet.port.onmessage?.({ data: earlyAudio });

    expect(feed).not.toHaveBeenCalled();
    let stopping: Promise<void> | undefined;
    if (cancelled) controller.cancel();
    else {
      stopping = controller.stop();
      worklet.port.onmessage?.({ data: "stopped" });
    }
    await released.promise;
    session.resolve({ feed, finish: async () => "hello" });
    await stopping;
    if (consentLost) {
      expect(feed).not.toHaveBeenCalled();
      expect(onError).toHaveBeenCalledWith(expect.stringContaining("audio destination changed"));
    } else if (cancelled) {
      expect(feed).not.toHaveBeenCalled();
      expect(commitDraft).not.toHaveBeenCalled();
    } else {
      expect(feed).toHaveBeenCalledWith(earlyAudio);
      expect(commitDraft).toHaveBeenCalledWith("hello", { start: 5, end: 5 });
    }
    controller.dispose();
  },
);

const cloudMocks = vi.hoisted(() => ({
  requireKey: vi.fn(),
  transcribe: vi.fn(),
  status: vi.fn(),
}));
vi.mock("@houston-app/client-runtime/voice-input", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@houston-app/client-runtime/voice-input")>()),
  getEnvironmentSpeechStatus: (...args: unknown[]) => {
    cloudMocks.status(...args);
    return Effect.succeed({ supported: true, state: "ready", supportsStreaming: true });
  },
  getEnvironmentSpeechStreamUrl: () => Effect.succeed("ws://speech.test"),
  openSpeechStream: mocks.openStream,
  requireCloudSpeechKey: (...args: unknown[]) => cloudMocks.requireKey(...args),
  transcribeCloudPcm: (...args: unknown[]) => cloudMocks.transcribe(...args),
}));

function cloudPlatform(input: {
  cloudProvider: "openai" | "xai" | "openrouter";
  cloudModel?: string;
  hasAudioConsent?: () => boolean;
}) {
  return createBrowserVoiceInputPlatform({
    prepared: {} as PreparedConnection,
    hasAudioConsent: () => true,
    getTranscriptionOptions: () => ({
      ...DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS,
      speechLanguage: "pt",
    }),
    getMicrophoneId: () => "",
    onLevel() {},
    onDurationLimit() {},
    onText() {},
    onError() {},
    ...input,
  } as Parameters<typeof createBrowserVoiceInputPlatform>[0]);
}
const abort = () => ({ signal: new AbortController().signal });

it("sends a cloud recording through the cloud path, with no local status probe or stream", async () => {
  cloudMocks.requireKey.mockReturnValue(Effect.void);
  cloudMocks.transcribe.mockReturnValue(Effect.succeed({ text: "olá" }));
  cloudMocks.status.mockClear();
  vi.stubGlobal("fetch", async () => new Response(new Uint8Array([1, 2, 3, 4])));
  const platform = cloudPlatform({ cloudProvider: "openrouter", cloudModel: "acme/voice-1" });
  const prepared = await platform.transcriber.prepare(abort());
  expect(prepared.locale).toBe("pt");
  expect(prepared.streaming).toBeUndefined();
  expect(await prepared.transcribe("blob:recording", abort())).toBe("olá");
  expect(cloudMocks.status).not.toHaveBeenCalled();
  expect(cloudMocks.transcribe).toHaveBeenCalledWith(
    expect.anything(),
    "openrouter",
    new Uint8Array([1, 2, 3, 4]),
    expect.objectContaining({ speechLanguage: "pt" }),
    "acme/voice-1",
  );
});

it("sends nothing to a cloud provider once the audio grant has changed", async () => {
  cloudMocks.requireKey.mockReturnValue(Effect.void);
  cloudMocks.transcribe.mockClear();
  let consent = true;
  const fetchRecording = vi.fn(async () => new Response(new Uint8Array(4)));
  vi.stubGlobal("fetch", fetchRecording);
  const platform = cloudPlatform({ cloudProvider: "openai", hasAudioConsent: () => consent });
  const prepared = await platform.transcriber.prepare(abort());
  consent = false;
  await expect(prepared.transcribe("blob:recording", abort())).rejects.toMatchObject({
    code: "cancelled",
  });
  expect(fetchRecording).not.toHaveBeenCalled();
  expect(cloudMocks.transcribe).not.toHaveBeenCalled();
});

it("refuses OpenRouter without a chosen model before checking the key or recording", async () => {
  cloudMocks.requireKey.mockClear();
  const platform = cloudPlatform({ cloudProvider: "openrouter" });
  await expect(platform.transcriber.prepare(abort())).rejects.toMatchObject({
    code: "unavailable",
    message: expect.stringContaining("OpenRouter model"),
  });
  expect(cloudMocks.requireKey).not.toHaveBeenCalled();
});

it("stops before recording when the environment holds no key for the provider", async () => {
  cloudMocks.requireKey.mockReturnValue(
    Effect.fail(new VoiceTranscriptionError("unavailable", "No xAI API key is saved.")),
  );
  const platform = cloudPlatform({ cloudProvider: "xai" });
  await expect(platform.transcriber.prepare(abort())).rejects.toMatchObject({
    message: "No xAI API key is saved.",
  });
});
