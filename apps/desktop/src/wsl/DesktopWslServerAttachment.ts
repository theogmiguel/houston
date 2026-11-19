// @effect-diagnostics nodeBuiltinImport:off -- the record path is a Linux path, so it joins with POSIX rules rather than the host's.
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { bootstrapRemoteBearerSession } from "@houston-app/client-runtime/authorization";
import { currentDesktopBootstrapToken } from "@houston-app/shared/desktopBootstrapToken";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Mac from "effect/crypto/Mac";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { HttpClient } from "effect/http";

import serverPackageJson from "../../../server/package.json" with { type: "json" };

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import { resolveDesktopBaseDir } from "../app/DesktopStatePaths.ts";
import type * as DesktopBackendManager from "../backend/DesktopBackendManager.ts";
import * as DesktopBootstrapSecret from "../backend/DesktopBootstrapSecret.ts";
import {
  decideServerAttachment,
  decodePersistedServerRuntimeState,
  probeHealth,
} from "../backend/DesktopServerAttachment.ts";
import * as DesktopWslEnvironment from "./DesktopWslEnvironment.ts";

// The bearer exchange proves the surviving server accepts this desktop's credential.
const AUTH_PROBE_TIMEOUT_MS = 5_000;
// Mirrors `deriveServerPaths` for a hosted launch: the desktop passes no --base-dir,
// so a development URL moves the server's state into `dev/` instead of `userdata/`.
const WSL_SERVER_STATE_DIR_NAME = "userdata";
const WSL_SERVER_DEVELOPMENT_STATE_DIR_NAME = "dev";
const SERVER_RUNTIME_RECORD_NAME = "server-runtime.json";

export const resolveWslServerRuntimeRecordPath = (input: {
  readonly baseDir: string;
  readonly isDevelopment: boolean;
}): string =>
  NodePath.posix.join(
    input.baseDir,
    input.isDevelopment ? WSL_SERVER_DEVELOPMENT_STATE_DIR_NAME : WSL_SERVER_STATE_DIR_NAME,
    SERVER_RUNTIME_RECORD_NAME,
  );

// In WSL2 mirrored mode, eth0 matches a host IP; use loopback for the renderer.
const isLocalHostIpv4 = (ip: string): boolean => {
  for (const list of Object.values(NodeOS.networkInterfaces())) {
    if (!list) continue;
    for (const entry of list) {
      const family = String(entry.family);
      if ((family === "IPv4" || family === "4") && entry.address === ip) return true;
    }
  }
  return false;
};

/** The distro address the desktop can reach, falling back to loopback. */
export const resolveWslReachableHost = (distroIp: Option.Option<string>): string => {
  const usesSharedNetworkStack = Option.match(distroIp, {
    onNone: () => false,
    onSome: isLocalHostIpv4,
  });
  return usesSharedNetworkStack ? "127.0.0.1" : Option.getOrElse(distroIp, () => "127.0.0.1");
};

export const describeWslDistro = (distro: string | null): string =>
  distro === null ? "the default WSL distro" : `WSL distro ${distro}`;

export type WslServerAttachmentResult =
  | {
      readonly _tag: "Attached";
      readonly attachment: DesktopBackendManager.DesktopBackendAttachment;
    }
  | { readonly _tag: "NoRecord"; readonly recordPath: string }
  | {
      readonly _tag: "Unavailable";
      readonly reason: string;
      readonly pid: number | null;
    };

export class DesktopWslServerAttachment extends Context.Service<
  DesktopWslServerAttachment,
  {
    readonly resolve: (input: {
      readonly distro: string | null;
    }) => Effect.Effect<WslServerAttachmentResult>;
  }
>()("@houston-app/desktop/wsl/DesktopWslServerAttachment") {}

export const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const wslEnvironment = yield* DesktopWslEnvironment.DesktopWslEnvironment;
  const secretStore = yield* DesktopBootstrapSecret.DesktopBootstrapSecret;
  const mac = yield* Mac.Mac;
  const httpClient = yield* HttpClient.HttpClient;

  const unavailable = (
    distro: string | null,
    pid: number | null,
    detail: string,
  ): WslServerAttachmentResult => ({
    _tag: "Unavailable",
    pid,
    reason: `The Houston state directory in ${describeWslDistro(distro)} is owned by ${
      pid === null ? "another process" : `PID ${String(pid)}`
    }, but ${detail}. Houston will not start another server there. Stop that server or pair with it, then reopen Houston.`,
  });

  const resolve = Effect.fn("desktop.wslServerAttachment.resolve")(function* (input: {
    readonly distro: string | null;
  }) {
    const home = yield* wslEnvironment.getUserHome(input.distro);
    if (!home.ok) {
      return {
        _tag: "Unavailable",
        pid: null,
        reason: `The Houston state directory in ${describeWslDistro(input.distro)} could not be located because ${home.reason}. Houston cannot attach to or start a WSL server there.`,
      } as const;
    }
    const baseDir = resolveDesktopBaseDir({
      homeDirectory: home.home,
      joinPath: NodePath.posix.join,
      houstonHome: Option.none(),
      channel: environment.channel,
    });
    const recordPath = resolveWslServerRuntimeRecordPath({
      baseDir,
      isDevelopment: Option.isSome(environment.devServerUrl),
    });

    const read = yield* wslEnvironment.readServerRuntimeRecord(input.distro, recordPath);
    if (read._tag === "Missing") {
      return { _tag: "NoRecord", recordPath } as const;
    }
    if (read._tag === "Unreadable") {
      return {
        _tag: "Unavailable",
        pid: null,
        reason: `The Houston state directory in ${describeWslDistro(input.distro)} is owned by another process, but its runtime record at ${recordPath} could not be read: ${read.reason}. Houston will not start another server there. Stop that server or pair with it, then reopen Houston.`,
      } as const;
    }

    const record = yield* decodePersistedServerRuntimeState(read.contents).pipe(Effect.option);
    if (Option.isNone(record)) {
      return {
        _tag: "Unavailable",
        pid: null,
        reason: `The Houston state directory in ${describeWslDistro(input.distro)} is owned by another process, but its runtime record at ${recordPath} is not valid. Houston will not start another server there. Stop that server or pair with it, then reopen Houston.`,
      } as const;
    }
    const runtime = record.value;
    if (!Number.isInteger(runtime.port) || runtime.port <= 0 || runtime.port > 65_535) {
      return unavailable(
        input.distro,
        runtime.pid,
        `it records an invalid port ${String(runtime.port)}`,
      );
    }

    const processAlive = yield* wslEnvironment.isProcessAlive(input.distro, runtime.pid);
    const distroIp = yield* wslEnvironment.getDistroIp(input.distro);
    const reachableHost = resolveWslReachableHost(distroIp);
    const httpBaseUrl = new URL(`http://${reachableHost}:${String(runtime.port)}`);
    const healthy = processAlive
      ? yield* probeHealth(httpBaseUrl.origin).pipe(
          Effect.provideService(HttpClient.HttpClient, httpClient),
        )
      : false;

    const decision = decideServerAttachment({
      record: runtime,
      processAlive,
      healthy,
      currentServerVersion: serverPackageJson.version,
    });

    switch (decision._tag) {
      case "NoRecord":
        return { _tag: "NoRecord", recordPath } as const;
      case "Dead":
        return unavailable(input.distro, decision.pid, "that process is not running");
      case "Unhealthy":
        return unavailable(
          input.distro,
          decision.pid,
          `it does not answer its health endpoint at ${httpBaseUrl.origin}`,
        );
      case "InvalidOrigin":
        return unavailable(
          input.distro,
          decision.pid,
          `it records origin ${String(decision.origin)}, which is not an HTTP origin`,
        );
      case "Attach": {
        const secret = yield* secretStore.resolve;
        const bootstrapToken = yield* currentDesktopBootstrapToken(
          secret.secret,
          yield* Clock.currentTimeMillis,
        ).pipe(Effect.provideService(Mac.Mac, mac));
        const config: DesktopBackendManager.DesktopBackendStartConfig = {
          executablePath: "wsl.exe",
          entryPath: environment.backendEntryPath,
          cwd: environment.backendCwd,
          args: [],
          env: {},
          extendEnv: true,
          bootstrap: {
            mode: "desktop",
            noBrowser: true,
            port: runtime.port,
            houstonHome: baseDir,
            host: runtime.host ?? "",
            desktopBootstrapToken: bootstrapToken,
            desktopBootstrapSecret: secret.secret,
            tailscaleServeEnabled: false,
            tailscaleServePort: 443,
          },
          bootstrapDelivery: "fd3",
          httpBaseUrl,
          captureOutput: false,
          preflightFailure: Option.none(),
          ...(input.distro === null ? {} : { runningDistro: input.distro }),
        };
        // The WSL server was started with the same desktop secret, so a rejected
        // exchange means a different launch owns it and attaching would not authenticate.
        const authenticated = yield* bootstrapRemoteBearerSession({
          httpBaseUrl: httpBaseUrl.href,
          credential: bootstrapToken,
          clientMetadata: { label: "Houston Desktop", deviceType: "desktop" },
          timeoutMs: AUTH_PROBE_TIMEOUT_MS,
        }).pipe(
          Effect.as(true),
          Effect.catchCause((cause) =>
            Effect.logWarning("the running WSL server rejected the desktop credential", {
              origin: httpBaseUrl.origin,
              pid: decision.pid,
              cause,
            }).pipe(Effect.as(false)),
          ),
          Effect.provideService(HttpClient.HttpClient, httpClient),
        );
        if (!authenticated) {
          return unavailable(
            input.distro,
            decision.pid,
            `it does not accept this app's desktop credential at ${httpBaseUrl.origin}, so the app cannot sign in to it`,
          );
        }
        const warning = Option.firstSomeOf([
          decision.versionSkew
            ? Option.some(
                `Attached to the Houston server at ${httpBaseUrl.origin} (version ${decision.serverVersion ?? "unknown"}), which differs from this app's server version ${serverPackageJson.version}. The app keeps that server running until you quit it yourself.`,
              )
            : Option.none<string>(),
          secret.warning,
        ]);
        return {
          _tag: "Attached",
          attachment: {
            config,
            httpBaseUrl,
            pid: decision.pid,
            warning,
          },
        } as const;
      }
    }
  });

  return DesktopWslServerAttachment.of({ resolve });
});

export const layer = Layer.effect(DesktopWslServerAttachment, make);
