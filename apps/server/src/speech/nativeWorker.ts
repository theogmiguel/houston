// @effect-diagnostics nodeBuiltinImport:off globalTimers:off - the isolated speech process owns its own IPC lifetime.
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import * as NodeSea from "node:sea";
import * as NodeURL from "node:url";
import type { SpeechStreamText } from "@houston-app/contracts";

const WHITESPACE_RUN = /\s+/;

type SpeechModule = {
  readonly TranscribeModel: {
    load(path: string, options: { device?: unknown; backend?: string }): Promise<SpeechModel>;
  };
  readonly getAvailableBackends: () => ReadonlyArray<{
    readonly kind: string;
    readonly deviceType: string;
    readonly deviceId?: string | null;
    readonly name: string;
    readonly description?: string;
  }>;
};

type SpeechModel = {
  readonly backend: string;
  readonly capabilities: {
    readonly supportsStreaming: boolean;
    readonly supportsTranslate: boolean;
  };
  supports(feature: string): boolean;
  createSession(): {
    stream(options: { timestamps: "none"; language?: string }): Promise<SpeechStream>;
    dispose(): void;
  };
  transcribe(pcm: Float32Array, options: object): Promise<{ readonly text: string }>;
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

/**
 * Loads the speech module beside the app. The packaged server is a single
 * executable, where `import()` cannot reach the file system, so an absolute
 * module path goes through `require` instead; development and tests keep the
 * ordinary ESM loader, which also handles `data:` fixtures.
 */
async function loadSpeechModule(url: string): Promise<SpeechModule> {
  if (!url.startsWith("file:") || !NodeSea.isSea()) return import(url);
  const { createRequire } = NodeModule;
  return createRequire(url)(NodeURL.fileURLToPath(url)) as SpeechModule;
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
  const words = full
    .trim()
    .split(WHITESPACE_RUN)
    .slice(committed.trim().split(WHITESPACE_RUN).length);
  return words.length ? " " + words.join(" ") : "";
};

type WorkerMessage =
  | {
      readonly kind: "devices";
      readonly moduleUrl: string;
      readonly koffiModuleUrl: string;
    }
  | {
      readonly kind: "load";
      readonly path: string;
      readonly moduleUrl: string;
      readonly koffiModuleUrl: string;
      readonly acceleration: string;
    }
  | { readonly kind: "begin"; readonly language?: string }
  | { readonly kind: "feed"; readonly pcm: Float32Array }
  | { readonly kind: "finish" }
  | { readonly kind: "reset" }
  | {
      readonly kind: "transcribe";
      readonly pcm: Float32Array;
      readonly options: object;
    };

/**
 * The isolated speech process's message loop. The parent loads a model, drives
 * one streaming session or batch transcription at a time, and kills the process
 * rather than disposing native state while inference is active.
 */
export async function runSpeechWorker(): Promise<void> {
  let model: SpeechModel | undefined;
  let session: Awaited<ReturnType<SpeechModel["createSession"]>> | undefined;
  let stream: SpeechStream | undefined;

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

  process.on("message", (message: WorkerMessage) => {
    void (async () => {
      try {
        if (message.kind === "devices") {
          // Koffi configuration is process-global; set the stack floor before the
          // binding loads so Vulkan model initialization has room on Windows.
          const { createRequire } = NodeModule;
          const koffi = createRequire(message.koffiModuleUrl)("koffi") as {
            config: (options?: { async_stack_size?: number }) => { async_stack_size?: number };
          };
          if ((koffi.config().async_stack_size ?? 0) < 2 * 1024 * 1024)
            koffi.config({ async_stack_size: 2 * 1024 * 1024 });
          const module = await loadSpeechModule(message.moduleUrl);
          reply({
            devices: module
              .getAvailableBackends()
              .filter((device) => device.deviceType === "gpu" || device.deviceType === "igpu")
              .map((device) => ({
                id: JSON.stringify([device.kind, device.deviceId ?? device.name]),
                name: device.description || device.name,
              })),
          });
        } else if (message.kind === "load") {
          const { createRequire } = NodeModule;
          const koffi = createRequire(message.koffiModuleUrl)("koffi") as {
            config: (options?: { async_stack_size?: number }) => { async_stack_size?: number };
          };
          // transcribe-cpp 0.2.3 still uses 512 KiB. Raise it with headroom for ggml
          // backends that overflow the default stack during model initialization.
          if ((koffi.config().async_stack_size ?? 0) < 2 * 1024 * 1024)
            koffi.config({ async_stack_size: 2 * 1024 * 1024 });
          const speechModule = await loadSpeechModule(message.moduleUrl);
          const device = message.acceleration.startsWith("gpu:")
            ? speechModule
                .getAvailableBackends()
                .find(
                  (item) =>
                    (item.deviceType === "gpu" || item.deviceType === "igpu") &&
                    JSON.stringify([item.kind, item.deviceId ?? item.name]) ===
                      message.acceleration.slice(4),
                )
            : undefined;
          if (message.acceleration.startsWith("gpu:") && !device)
            throw new Error("The selected speech GPU is unavailable.");
          model = await speechModule.TranscribeModel.load(
            message.path,
            device ? { device } : { backend: message.acceleration },
          );
          reply({
            backend: model.backend,
            supportsStreaming: model.capabilities.supportsStreaming,
            supportsTranslation: model.capabilities.supportsTranslate,
            supportsInitialPrompt: model.supports("initial_prompt"),
          });
        } else if (message.kind === "begin") {
          if (!model) throw new Error("The speech model is not loaded.");
          session = model.createSession();
          stream = await session.stream({
            timestamps: "none",
            ...(message.language === undefined ? {} : { language: message.language }),
          });
          reply({});
        } else if (message.kind === "feed") {
          if (!stream) throw new Error("The speech stream is not ready.");
          const update = await stream.feed(message.pcm);
          const text: SpeechStreamText | null =
            update.committedChanged || update.tentativeChanged
              ? {
                  committed: stream.text.committed,
                  tentative: tentativeAfter(stream.text),
                }
              : null;
          reply({ revision: update.revision, preview: text });
        } else if (message.kind === "finish") {
          if (!stream || !session) throw new Error("The speech stream is not ready.");
          await stream.finalize();
          const text = stream.text.full;
          stream.reset();
          session.dispose();
          stream = undefined;
          session = undefined;
          reply({ text });
        } else if (message.kind === "reset") {
          if (stream && session) {
            stream.reset();
            session.dispose();
          }
          stream = undefined;
          session = undefined;
          reply({});
        } else if (message.kind === "transcribe") {
          if (!model) throw new Error("The speech model is not loaded.");
          const result = await model.transcribe(message.pcm, message.options);
          reply({ text: result.text });
        }
      } catch (error) {
        fail(error);
      }
    })();
  });
  process.on("disconnect", () => process.exit(0));
}
