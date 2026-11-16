// @effect-diagnostics nodeBuiltinImport:off globalTimers:off - native inference and IPC cleanup need killable Promise boundaries outside the Effect runtime.
import * as NodeChildProcess from "node:child_process";
import * as NodeSea from "node:sea";
import * as NodeURL from "node:url";
import type { SpeechStreamText } from "@houston-app/contracts";
import { defaultSpeechModuleUrl } from "./nativeWorker.ts";

type Reply = {
  readonly type: "houston-speech-reply";
  readonly ok: boolean;
  readonly text?: string;
  readonly error?: string;
  readonly supportsStreaming?: boolean;
  readonly supportsLongForm?: boolean;
  readonly supportsTranslation?: boolean;
  readonly supportsVocabulary?: boolean;
  readonly backend?: string;
  readonly revision?: number;
  readonly preview?: SpeechStreamText | null;
  readonly devices?: unknown;
};

type DeviceReply = {
  readonly type: "houston-speech-reply";
  readonly ok: boolean;
  readonly devices?: unknown;
};

// This module is bundled into bin.mjs, so the compiled entry sits beside it.
const workerEntry = NodeURL.fileURLToPath(
  new URL(import.meta.url.endsWith(".ts") ? "../bin.ts" : "./bin.mjs", import.meta.url),
);

/** The packaged server is a single executable and runs the hidden worker command itself. */
const workerCommand = () =>
  NodeSea.isSea()
    ? { command: process.execPath, args: ["__speech-worker"] }
    : { command: process.execPath, args: [workerEntry, "__speech-worker"] };

const spawnWorker = (cpuOnly = false) => {
  const { command, args } = workerCommand();
  return NodeChildProcess.spawn(command, args, {
    stdio: ["ignore", "ignore", "inherit", "ipc"],
    serialization: "advanced",
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
      // Backend registration can initialize drivers even when model placement is CPU.
      ...(cpuOnly ? { TRANSCRIBE_BACKENDS: "cpu" } : {}),
    },
  });
};

export type NativeSpeechOptions = {
  readonly timestamps: "none";
  readonly task?: "translate";
  readonly targetLanguage?: "en";
  readonly language?: string;
  readonly vocabulary?: readonly string[];
};

export async function listNativeSpeechGpuDevices(moduleUrl = defaultSpeechModuleUrl()) {
  const child = spawnWorker();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  return await new Promise<{ id: string; name: string }[]>((resolve, reject) => {
    timeout = setTimeout(() => reject(new Error("Speech device discovery timed out.")), 10_000);
    child.on("message", (message: unknown) => {
      if (
        typeof message !== "object" ||
        message === null ||
        !("type" in message) ||
        message.type !== "houston-speech-reply"
      )
        return;
      const reply = message as DeviceReply;
      if (!reply.ok) {
        reject(new Error("Speech device discovery failed."));
        return;
      }
      if (
        Array.isArray(reply.devices) &&
        reply.devices.every(
          (device: unknown) =>
            typeof device === "object" &&
            device !== null &&
            "id" in device &&
            typeof device.id === "string" &&
            "name" in device &&
            typeof device.name === "string",
        )
      )
        resolve(reply.devices);
    });
    child.once("error", reject);
    child.once("exit", (code) => reject(new Error(`Speech device discovery exited (${code}).`)));
    child.send({ kind: "devices", moduleUrl }, (error) => {
      if (error) reject(error);
    });
  }).finally(() => {
    clearTimeout(timeout);
    if (child.connected) child.disconnect();
    child.kill("SIGKILL");
  });
}

/** Loads a model in an isolated process. "auto" retries on the CPU when GPU setup fails. */
export async function loadNativeSpeechModel(
  path: string,
  signal: AbortSignal,
  moduleUrl = defaultSpeechModuleUrl(),
  acceleration = "auto",
) {
  try {
    return await loadNativeSpeechModelOnce(path, signal, moduleUrl, acceleration);
  } catch (error) {
    if (acceleration !== "auto" || signal.aborted) throw error;
    return await loadNativeSpeechModelOnce(path, signal, moduleUrl, "cpu");
  }
}

async function loadNativeSpeechModelOnce(
  path: string,
  signal: AbortSignal,
  moduleUrl: string,
  acceleration: string,
) {
  signal.throwIfAborted();
  const child = spawnWorker(acceleration === "cpu");
  let stopped = false;
  let pending: ReturnType<typeof Promise.withResolvers<Reply>> | undefined;
  const exited = Promise.withResolvers<void>();
  const fail = (error: Error) => {
    stopped = true;
    pending?.reject(error);
    pending = undefined;
  };
  child.on("error", (error) => {
    fail(error);
    exited.resolve();
  });
  child.on("exit", (code, exitSignal) => {
    fail(new Error(`Speech process exited (${exitSignal ?? code}).`));
    signal.removeEventListener("abort", stop);
    exited.resolve();
  });
  child.on("message", (message: unknown) => {
    if (
      typeof message !== "object" ||
      message === null ||
      !("type" in message) ||
      message.type !== "houston-speech-reply"
    )
      return;
    const reply = message as Reply;
    const request = pending;
    pending = undefined;
    if (reply.ok) request?.resolve(reply);
    else request?.reject(new Error(reply.error ?? "Native speech failed."));
  });
  function stop() {
    fail(new Error("Speech process stopped."));
    // Never call native dispose while inference is active. The OS owns cleanup of the isolated process.
    child.kill("SIGKILL");
  }
  signal.addEventListener("abort", stop, { once: true });
  if (signal.aborted) stop();
  const send = (message: object) => {
    if (stopped) return Promise.reject(new Error("Speech process stopped."));
    if (pending) return Promise.reject(new Error("Speech process is busy."));
    const request = Promise.withResolvers<Reply>();
    pending = request;
    child.send(message, (error) => {
      if (error) {
        request.reject(error);
        if (pending === request) pending = undefined;
      }
    });
    return request.promise;
  };
  const dispose = async () => {
    stop();
    await exited.promise;
  };
  let loaded: Reply;
  try {
    loaded = await send({ kind: "load", path, moduleUrl, acceleration });
  } catch (error) {
    await dispose();
    throw error;
  }
  return {
    backend: loaded.backend ?? "unknown",
    supportsStreaming: loaded.supportsStreaming === true,
    supportsLongForm: loaded.supportsLongForm === true,
    supportsTranslation: loaded.supportsTranslation === true,
    supportsVocabulary: loaded.supportsVocabulary === true,
    begin: async (options: NativeSpeechOptions, filterSilence: boolean, vadPath?: string) => {
      await send({ kind: "begin", options, filterSilence, vadPath });
    },
    feed: async (pcm: Float32Array) => {
      const reply = await send({ kind: "feed", pcm });
      if (typeof reply.revision !== "number" || reply.preview === undefined)
        throw new Error("Invalid speech stream response.");
      return { revision: reply.revision, text: reply.preview };
    },
    finish: async () => {
      const reply = await send({ kind: "finish" });
      if (typeof reply.text !== "string") throw new Error("Invalid speech stream response.");
      return reply.text;
    },
    reset: async () => {
      const inFlight = pending?.promise;
      if (inFlight) {
        let timeout: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            inFlight.catch(() => undefined),
            new Promise<never>((_, reject) => {
              timeout = setTimeout(
                () => reject(new Error("Speech stream reset timed out.")),
                1_000,
              );
            }),
          ]);
        } finally {
          clearTimeout(timeout);
        }
      }
      await send({ kind: "reset" });
    },
    transcribe: async (
      pcm: Float32Array,
      options: NativeSpeechOptions,
      filterSilence: boolean,
      vadPath?: string,
    ) => {
      const result = await send({ kind: "transcribe", pcm, options, filterSilence, vadPath });
      if (typeof result.text !== "string") throw new Error("Invalid speech process response.");
      return { text: result.text };
    },
    dispose,
  };
}
