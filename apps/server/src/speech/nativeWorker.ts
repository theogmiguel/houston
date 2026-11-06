// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalConsole:off - the isolated speech process owns its own IPC lifetime and stderr.
import * as NodeModule from "node:module";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeSea from "node:sea";
import * as NodeURL from "node:url";
import type { SpeechStreamText } from "@houston-app/contracts";
import { createSpeechAudio } from "./audio.ts";

type BackendInfo = {
  readonly kind: string;
  readonly deviceType: string;
  readonly deviceId?: string | null;
  readonly name: string;
  readonly description?: string;
};

type VadSession = {
  streamReset(): Promise<void>;
  streamFeed(pcm: Float32Array): Promise<{ firstFrame: number; probs: readonly number[] }>;
  streamFlush(): Promise<{ firstFrame: number; probs: readonly number[] }>;
  dispose(): void;
};

type SpeechModel = {
  readonly backend: string;
  readonly capabilities: {
    readonly supportsStreaming: boolean;
    readonly supportsTranslate: boolean;
    readonly maxAudioMs: number;
  };
  readonly vadInfo: { readonly sampleRate: number; readonly frameSamples: number };
  supports(feature: string): boolean;
  createSession(): {
    stream(options: NativeSpeechOptions): Promise<SpeechStream>;
    dispose(): void;
  };
  createVadSession(options: { nThreads: number }): VadSession;
  transcribe(pcm: Float32Array, options: NativeSpeechOptions): Promise<{ readonly text: string }>;
  dispose(): void;
};

type SpeechModule = {
  readonly TranscribeModel: {
    load(path: string, options: { device?: unknown; backend?: string }): Promise<SpeechModel>;
  };
  readonly getAvailableBackends: () => ReadonlyArray<BackendInfo>;
  readonly artifactDir?: () => string;
};

type SpeechStream = {
  readonly text: { readonly committed: string; readonly tentative: string; readonly full: string };
  feed(pcm: Float32Array): Promise<{
    readonly revision: number;
    readonly committedChanged: boolean;
    readonly tentativeChanged: boolean;
  }>;
  finalize(): Promise<void>;
  reset(): void;
};

type NativeSpeechOptions = {
  readonly timestamps: "none";
  readonly task?: "translate";
  readonly targetLanguage?: "en";
  readonly language?: string;
  readonly vocabulary?: readonly string[];
};

/**
 * Loads the speech module beside the app. The packaged server is a single
 * executable, where `import()` cannot reach the file system, so an absolute
 * module path goes through `require` instead; development and tests keep the
 * ordinary ESM loader, which also handles `data:` fixtures.
 */
async function loadSpeechModule(url: string): Promise<SpeechModule> {
  const speech =
    !url.startsWith("file:") || !NodeSea.isSea()
      ? ((await import(url)) as SpeechModule)
      : (NodeModule.createRequire(url)(NodeURL.fileURLToPath(url)) as SpeechModule);
  useUnpackedLibrary(speech);
  return speech;
}

/**
 * Koffi opens native libraries outside Electron's ASAR-aware file system, so inside an
 * ASAR archive the library path points at its `.asar.unpacked` copy instead.
 */
function useUnpackedLibrary(speech: SpeechModule): void {
  if (!process.versions.electron || process.env.TRANSCRIBE_LIBRARY || !speech.artifactDir) return;
  const directory = speech.artifactDir();
  const unpacked = directory.replace(/\.asar([\\/])/g, ".asar.unpacked$1");
  if (unpacked === directory || !NodeFS.existsSync(unpacked)) return;
  // The unpacked directory holds exactly one engine library for the host it was built for.
  const library = NodeFS.readdirSync(unpacked).find((name) =>
    /^(lib)?transcribe\.(dll|dylib|so)$/.test(name),
  );
  if (!library) return;
  process.env.TRANSCRIBE_LIBRARY = NodePath.join(unpacked, library);
}

/** The installed transcribe-cpp entry beside the packaged executable. */
export function defaultSpeechModuleUrl(): string {
  if (!NodeSea.isSea()) return import.meta.resolve("transcribe-cpp");
  return NodeURL.pathToFileURL(
    NodePath.join(
      NodePath.dirname(process.execPath),
      "node_modules",
      "transcribe-cpp",
      "dist",
      "index.js",
    ),
  ).href;
}

// transcribe-cpp slices tentative by position, so a hypothesis that revises the committed
// words ("And so my" -> "And so, my") repeats letters. Realign on word boundaries instead.
const tentativeAfter = ({
  full,
  committed,
  tentative,
}: {
  readonly full: string;
  readonly committed: string;
  readonly tentative: string;
}) => {
  if (!committed || full.startsWith(committed)) return tentative;
  const words = full.trim().split(/\s+/).slice(committed.trim().split(/\s+/).length);
  return words.length ? " " + words.join(" ") : "";
};

type WorkerMessage =
  | { readonly kind: "devices"; readonly moduleUrl: string }
  | {
      readonly kind: "load";
      readonly path: string;
      readonly moduleUrl: string;
      readonly acceleration: string;
    }
  | {
      readonly kind: "begin";
      readonly options: NativeSpeechOptions;
      readonly filterSilence: boolean;
      readonly vadPath?: string;
    }
  | { readonly kind: "feed"; readonly pcm: Float32Array }
  | { readonly kind: "finish" }
  | { readonly kind: "reset" }
  | {
      readonly kind: "transcribe";
      readonly pcm: Float32Array;
      readonly options: NativeSpeechOptions;
      readonly filterSilence: boolean;
      readonly vadPath?: string;
    };

// The Silero model scores 512-sample frames of 16 kHz audio.
const VAD_FRAME_SAMPLES = 512;
const VAD_SAMPLE_RATE = 16_000;
// Chunks the engine refuses as too long are halved until they fit; below this they are real failures.
const MINIMUM_SPLIT_SAMPLES = 4_000;

const isLengthLimitError = (error: unknown) =>
  error instanceof Error &&
  (error.name === "OutputTruncated" ||
    error.name === "InputTooLong" ||
    error.name === "OutputRepetition");

const warnVad = () =>
  console.warn(
    "Silero silence filtering unavailable; preserving raw recording and using bounded ASR chunks.",
  );

const gpuBackendId = (device: BackendInfo) =>
  JSON.stringify([device.kind, device.deviceId ?? device.name]);

/**
 * The isolated speech process's message loop. The parent loads a model, drives
 * one streaming session or batch transcription at a time, and kills the process
 * rather than disposing native state while inference is active.
 */
export async function runSpeechWorker(): Promise<void> {
  let speech: SpeechModule | undefined;
  let model: SpeechModel | undefined;
  let vadModel: SpeechModel | undefined;
  let vad: VadSession | undefined;
  let session: ReturnType<SpeechModel["createSession"]> | undefined;
  let stream: SpeechStream | undefined;
  let audio: ReturnType<typeof createSpeechAudio> | undefined;
  let options: NativeSpeechOptions = { timestamps: "none" };
  let nativeStreaming = false;
  let useVad = false;
  let scored = 0;
  let revision = 0;
  let texts: string[] = [];
  let heardAudio = false;

  const reply = (message: object) => {
    process.send?.({ type: "houston-speech-reply", ok: true, ...message });
  };
  const fail = (error: unknown) => {
    process.send?.({
      type: "houston-speech-reply",
      ok: false,
      error: error instanceof Error ? (error.stack ?? error.message) : String(error),
    });
  };
  const loaded = (): SpeechModel => {
    if (!model) throw new Error("The speech model is not loaded.");
    return model;
  };

  const resetAsr = () => {
    stream?.reset();
    session?.dispose();
    stream = session = undefined;
  };
  const newAudio = (filterSilence: boolean) => {
    const current = loaded();
    return createSpeechAudio({
      frameSamples: VAD_FRAME_SAMPLES,
      filterSilence,
      nativeStreaming: current.capabilities.supportsStreaming,
      longForm: current.supports("long_form"),
      maxAudioMs: current.capabilities.maxAudioMs,
    });
  };
  const openAsr = async () => {
    if (!nativeStreaming) return;
    session = loaded().createSession();
    stream = await session.stream(options);
  };

  const begin = async (
    message: { options: NativeSpeechOptions; filterSilence: boolean; vadPath?: string },
    live: boolean,
  ) => {
    const current = loaded();
    resetAsr();
    options = message.options;
    nativeStreaming = live && current.capabilities.supportsStreaming;
    texts = [];
    scored = revision = 0;
    heardAudio = false;
    useVad =
      Boolean(message.vadPath) &&
      (message.filterSilence ||
        (!current.capabilities.supportsStreaming && !current.supports("long_form")));
    if (useVad && message.vadPath) {
      try {
        if (!vadModel) {
          vadModel = await speech!.TranscribeModel.load(message.vadPath, { backend: "cpu" });
          if (
            vadModel.vadInfo.sampleRate !== VAD_SAMPLE_RATE ||
            vadModel.vadInfo.frameSamples !== VAD_FRAME_SAMPLES
          )
            throw new Error("Unsupported Silero model frames.");
          vad = vadModel.createVadSession({ nThreads: 1 });
        }
        await vad!.streamReset();
      } catch {
        vad?.dispose();
        vadModel?.dispose();
        vad = vadModel = undefined;
        useVad = false;
        warnVad();
      }
    }
    audio = newAudio(useVad && message.filterSilence);
    await openAsr();
  };

  const transcribeChunk = async (pcm: Float32Array): Promise<void> => {
    try {
      texts.push((await loaded().transcribe(pcm, options)).text);
    } catch (error) {
      if (!isLengthLimitError(error) || pcm.length <= MINIMUM_SPLIT_SAMPLES) throw error;
      const middle = Math.floor(pcm.length / 2);
      await transcribeChunk(pcm.subarray(0, middle));
      await transcribeChunk(pcm.subarray(middle));
    }
  };

  const decode = async (final: boolean): Promise<SpeechStreamText | null> => {
    let preview: SpeechStreamText | null = null;
    for (const pcm of audio!.take(final)) {
      if (!pcm.length) continue;
      heardAudio = true;
      if (nativeStreaming) {
        const update = await stream!.feed(pcm);
        if (update.committedChanged || update.tentativeChanged) {
          preview = {
            committed: stream!.text.committed,
            tentative: tentativeAfter(stream!.text),
          };
        }
      } else {
        await transcribeChunk(pcm);
        preview = { committed: texts.join(" ").trim(), tentative: "" };
      }
    }
    return preview;
  };

  const feed = async (pcm: Float32Array | undefined, final = false) => {
    if (pcm) audio!.append(pcm);
    try {
      if (useVad) {
        if (pcm) {
          const result = await vad!.streamFeed(pcm);
          audio!.score(result.firstFrame, result.probs);
          if (
            result.firstFrame + result.probs.length !==
            Math.floor(audio!.samples() / VAD_FRAME_SAMPLES)
          )
            throw new Error("Incomplete Silero frames.");
        }
        if (final) {
          const result = await vad!.streamFlush();
          audio!.score(result.firstFrame, result.probs);
          if (
            result.firstFrame + result.probs.length !==
            Math.ceil(audio!.samples() / VAD_FRAME_SAMPLES)
          )
            throw new Error("Incomplete Silero tail.");
        }
      } else {
        const frames = audio!.samples() / VAD_FRAME_SAMPLES;
        const count = final ? Math.ceil(frames) : Math.floor(frames);
        audio!.score(scored, new Array<number>(count - scored).fill(1));
        scored = count;
      }
    } catch {
      // Replay on optional VAD failure, including audio it had withheld; ASR errors stay separate.
      const raw = audio!.audio();
      useVad = false;
      warnVad();
      resetAsr();
      texts = [];
      heardAudio = false;
      audio = newAudio(false);
      audio.append(raw);
      const frames = raw.length / VAD_FRAME_SAMPLES;
      scored = final ? Math.ceil(frames) : Math.floor(frames);
      audio.score(0, new Array<number>(scored).fill(1));
      await openAsr();
    }
    return await decode(final);
  };

  process.on("message", (message: WorkerMessage) => {
    void (async () => {
      try {
        if (message.kind === "devices") {
          const module = await loadSpeechModule(message.moduleUrl);
          reply({
            devices: module
              .getAvailableBackends()
              .filter((device) => device.deviceType === "gpu" || device.deviceType === "igpu")
              .map((device) => ({
                id: gpuBackendId(device),
                name: device.description || device.name,
              })),
          });
        } else if (message.kind === "load") {
          speech = await loadSpeechModule(message.moduleUrl);
          const device = message.acceleration.startsWith("gpu:")
            ? speech
                .getAvailableBackends()
                .find(
                  (item) =>
                    (item.deviceType === "gpu" || item.deviceType === "igpu") &&
                    gpuBackendId(item) === message.acceleration.slice(4),
                )
            : undefined;
          if (message.acceleration.startsWith("gpu:") && !device)
            throw new Error(
              `The selected speech GPU is unavailable (looked for ${message.acceleration}).`,
            );
          model = await speech.TranscribeModel.load(
            message.path,
            device ? { device } : { backend: message.acceleration },
          );
          reply({
            backend: model.backend,
            supportsStreaming: model.capabilities.supportsStreaming,
            supportsLongForm: model.supports("long_form"),
            supportsTranslation: model.capabilities.supportsTranslate,
            supportsVocabulary: model.supports("vocabulary"),
          });
        } else if (message.kind === "begin") {
          await begin(message, true);
          reply({});
        } else if (message.kind === "feed") {
          const preview = await feed(message.pcm);
          reply({ revision: ++revision, preview });
        } else if (message.kind === "finish") {
          await feed(undefined, true);
          if (nativeStreaming && heardAudio) await stream!.finalize();
          const text = nativeStreaming
            ? heardAudio
              ? stream!.text.full
              : ""
            : texts.join(" ").trim();
          resetAsr();
          audio = undefined;
          reply({ text });
        } else if (message.kind === "reset") {
          resetAsr();
          if (vad) await vad.streamReset();
          audio = undefined;
          reply({});
        } else if (message.kind === "transcribe") {
          await begin(message, false);
          await feed(message.pcm, true);
          const text = texts.join(" ").trim();
          audio = undefined;
          reply({ text });
        }
      } catch (error) {
        fail(error);
      }
    })();
  });
  process.on("disconnect", () => process.exit(0));
}
