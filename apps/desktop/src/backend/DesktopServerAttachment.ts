import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest } from "effect/http";

import { currentDesktopBootstrapToken } from "@houston-app/shared/desktopBootstrapToken";
import serverPackageJson from "../../../server/package.json" with { type: "json" };

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import type * as DesktopBackendManager from "./DesktopBackendManager.ts";
import * as DesktopBootstrapSecret from "./DesktopBootstrapSecret.ts";

const READINESS_PATH = "/.well-known/houston/environment";
const HEALTH_TIMEOUT = Duration.seconds(2);

const PersistedServerRuntimeState = Schema.Struct({
  version: Schema.optional(Schema.Int),
  pid: Schema.Int,
  host: Schema.optional(Schema.String),
  port: Schema.Int,
  origin: Schema.String,
  startedAt: Schema.optional(Schema.String),
  serviceManaged: Schema.optional(Schema.Boolean),
  serverVersion: Schema.optional(Schema.String),
});
export type PersistedServerRuntimeState = typeof PersistedServerRuntimeState.Type;

const decodeRuntimeState = Schema.decodeUnknownEffect(
  Schema.fromJsonString(PersistedServerRuntimeState),
);

export interface AttachedServer {
  readonly _tag: "Attach";
  readonly pid: number;
  readonly port: number;
  readonly origin: string;
  readonly serverVersion: string | null;
  readonly versionSkew: boolean;
}

export type AttachmentDecision =
  | AttachedServer
  | { readonly _tag: "NoRecord" }
  | { readonly _tag: "Dead"; readonly pid: number }
  | { readonly _tag: "Unhealthy"; readonly pid: number; readonly origin: string }
  | { readonly _tag: "InvalidOrigin"; readonly pid: number; readonly origin: string };

/**
 * Attach to any live, healthy server that owns the state directory, including one
 * from another build: stopping a server this app did not start is never allowed.
 */
export function decideServerAttachment(input: {
  readonly record: PersistedServerRuntimeState | null;
  readonly processAlive: boolean;
  readonly healthy: boolean;
  readonly currentServerVersion: string;
}): AttachmentDecision {
  const { record } = input;
  if (record === null) {
    return { _tag: "NoRecord" };
  }
  if (record.pid <= 0 || !input.processAlive) {
    return { _tag: "Dead", pid: record.pid };
  }
  if (!record.origin.startsWith("http://") && !record.origin.startsWith("https://")) {
    return { _tag: "InvalidOrigin", pid: record.pid, origin: record.origin };
  }
  if (!input.healthy) {
    return { _tag: "Unhealthy", pid: record.pid, origin: record.origin };
  }
  return {
    _tag: "Attach",
    pid: record.pid,
    port: record.port,
    origin: record.origin,
    serverVersion: record.serverVersion ?? null,
    versionSkew: record.serverVersion !== input.currentServerVersion,
  };
}

/** Signal 0 only probes existence; EPERM still means alive. */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
}

const readRuntimeRecord = Effect.fn("desktop.serverAttachment.readRuntimeRecord")(function* (
  recordPath: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const raw = yield* fs.readFileString(recordPath).pipe(
    Effect.catchIf(
      (cause) => cause.reason._tag === "NotFound",
      () => Effect.succeed(null),
    ),
    Effect.catchTags({
      PlatformError: (cause) =>
        Effect.logWarning("failed to read the server runtime record", {
          recordPath,
          reason: cause.message,
        }).pipe(Effect.as(null)),
    }),
  );
  if (raw === null) {
    return null;
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return null;
  }
  return yield* decodeRuntimeState(trimmed).pipe(Effect.orElseSucceed(() => null));
});

const probeHealth = Effect.fn("desktop.serverAttachment.probeHealth")(function* (origin: string) {
  const client = yield* HttpClient.HttpClient;
  const url = new URL(READINESS_PATH, origin).toString();
  return yield* client.execute(HttpClientRequest.get(url)).pipe(
    Effect.map((response) => response.status >= 200 && response.status < 300),
    Effect.timeoutOption(HEALTH_TIMEOUT),
    Effect.map(Option.getOrElse(() => false)),
    Effect.orElseSucceed(() => false),
  );
});

export type ServerAttachmentFailure =
  | {
      readonly _tag: "NoRecord";
      readonly recordPath: string;
      readonly stateDir: string;
    }
  | {
      readonly _tag: "Dead";
      readonly recordPath: string;
      readonly stateDir: string;
      readonly pid: number;
    }
  | {
      readonly _tag: "Unhealthy";
      readonly recordPath: string;
      readonly stateDir: string;
      readonly pid: number;
      readonly origin: string;
    }
  | {
      readonly _tag: "InvalidOrigin";
      readonly recordPath: string;
      readonly stateDir: string;
      readonly pid: number;
      readonly origin: string;
    };

export type ServerAttachmentResult =
  | {
      readonly _tag: "Attached";
      readonly server: AttachedServer;
      readonly config: DesktopBackendManager.DesktopBackendStartConfig;
      readonly warning: Option.Option<string>;
    }
  | ServerAttachmentFailure;

export class DesktopServerAttachment extends Context.Service<
  DesktopServerAttachment,
  {
    readonly resolve: Effect.Effect<ServerAttachmentResult>;
  }
>()("@houston-app/desktop/backend/DesktopServerAttachment") {}

export const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const secretStore = yield* DesktopBootstrapSecret.DesktopBootstrapSecret;
  const fileSystem = yield* FileSystem.FileSystem;
  const httpClient = yield* HttpClient.HttpClient;

  const resolve = Effect.gen(function* () {
    const recordPath = environment.serverRuntimeRecordPath;
    const candidates = [
      recordPath,
      ...Option.toArray(environment.developmentServerRuntimeRecordPath),
    ];
    let attached: {
      readonly read: PersistedServerRuntimeState;
      readonly decision: Extract<AttachmentDecision, { _tag: "Attach" }>;
    } | null = null;
    let firstFailure: ServerAttachmentFailure | null = null;

    for (const candidatePath of candidates) {
      const read = yield* readRuntimeRecord(candidatePath);
      if (read === null) {
        continue;
      }
      const alive = isProcessAlive(read.pid);
      const healthy = alive ? yield* probeHealth(read.origin) : false;
      const decision = decideServerAttachment({
        record: read,
        processAlive: alive,
        healthy,
        currentServerVersion: serverPackageJson.version,
      });
      if (decision._tag === "Attach") {
        attached = { read, decision };
        break;
      }
      firstFailure ??= {
        ...decision,
        recordPath: candidatePath,
        stateDir: environment.stateDir,
      } as ServerAttachmentFailure;
    }

    if (attached === null) {
      const failure: ServerAttachmentFailure = firstFailure ?? {
        _tag: "NoRecord",
        recordPath,
        stateDir: environment.stateDir,
      };
      return failure;
    }
    const { read, decision } = attached;

    const secret = yield* secretStore.resolve;
    const bootstrapToken = currentDesktopBootstrapToken(
      secret.secret,
      yield* Clock.currentTimeMillis,
    );
    const httpBaseUrl = new URL(decision.origin);
    const config: DesktopBackendManager.DesktopBackendStartConfig = {
      executablePath: process.execPath,
      entryPath: environment.backendEntryPath,
      cwd: environment.backendCwd,
      args: [],
      env: {},
      extendEnv: true,
      bootstrap: {
        mode: "desktop",
        noBrowser: true,
        port: decision.port,
        houstonHome: environment.baseDir,
        host: read.host ?? "",
        desktopBootstrapToken: bootstrapToken,
        desktopBootstrapSecret: secret.secret,
        tailscaleServeEnabled: false,
        tailscaleServePort: 443,
      },
      bootstrapDelivery: "fd3",
      httpBaseUrl,
      captureOutput: false,
      preflightFailure: Option.none(),
    };

    const warning = Option.firstSomeOf([
      decision.versionSkew
        ? Option.some(
            `Attached to the Houston server at ${decision.origin} (version ${decision.serverVersion ?? "unknown"}), which differs from this app's server version ${serverPackageJson.version}. The app keeps that server running until you quit it yourself.`,
          )
        : Option.none<string>(),
      secret.warning,
    ]);

    return { _tag: "Attached", server: decision, config, warning } as const;
  }).pipe(
    Effect.provideService(FileSystem.FileSystem, fileSystem),
    Effect.provideService(HttpClient.HttpClient, httpClient),
    Effect.withSpan("desktop.serverAttachment.resolve"),
  );

  return DesktopServerAttachment.of({ resolve });
});

export const layer = Layer.effect(DesktopServerAttachment, make);
