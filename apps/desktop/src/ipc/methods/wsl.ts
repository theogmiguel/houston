import { DesktopWslStateSchema, type DesktopWslState } from "@houston-app/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as DesktopEnvironment from "../../app/DesktopEnvironment.ts";
import * as DesktopAppSettings from "../../settings/DesktopAppSettings.ts";
import * as DesktopWslBackend from "../../wsl/DesktopWslBackend.ts";
import * as DesktopWslEnvironment from "../../wsl/DesktopWslEnvironment.ts";
import { decideWslEnable, wslPreflightError } from "../../wsl/wslServerSupport.ts";
import type { WslDistro } from "../../wsl/wslPathParsing.ts";
import * as IpcChannels from "../channels.ts";
import { makeIpcMethod } from "../DesktopIpc.ts";

// Houston refuses to run its server in a distro, so a non-Windows host has no WSL state to show.
const UNSUPPORTED_WSL_STATE: DesktopWslState = {
  enabled: false,
  distro: null,
  available: false,
  wslOnly: false,
  distros: [],
  preflightError: null,
};

export class DesktopWslRequestError extends Schema.TaggedError<DesktopWslRequestError>()(
  "DesktopWslRequestError",
  {
    reason: Schema.String,
  },
) {
  override get message(): string {
    return this.reason;
  }
}

const listDistroNames = (distros: readonly WslDistro[]): string =>
  distros.map((distro) => distro.name).join(", ");

const readWslState: Effect.Effect<
  DesktopWslState,
  never,
  | DesktopEnvironment.DesktopEnvironment
  | DesktopAppSettings.DesktopAppSettings
  | DesktopWslEnvironment.DesktopWslEnvironment
> = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  if (environment.platform !== "win32") return UNSUPPORTED_WSL_STATE;
  const appSettings = yield* DesktopAppSettings.DesktopAppSettings;
  const wslEnvironment = yield* DesktopWslEnvironment.DesktopWslEnvironment;
  const settings = yield* appSettings.get;
  const available = settings.localEnvironmentEnabled && (yield* wslEnvironment.isAvailable);
  // Listing distros on non-WSL hosts spawns wsl.exe only to time out.
  const distros = available ? yield* wslEnvironment.listDistros : [];
  return {
    enabled: settings.wslBackendEnabled,
    distro: settings.wslDistro,
    available,
    wslOnly: settings.wslOnly,
    distros,
    preflightError: wslPreflightError({
      enabled: settings.wslBackendEnabled,
      wslOnly: settings.wslOnly,
      distro: settings.wslDistro,
      distros,
    }),
  };
});

export const getWslState = makeIpcMethod({
  channel: IpcChannels.GET_WSL_STATE_CHANNEL,
  payload: Schema.Void,
  result: DesktopWslStateSchema,
  handler: Effect.fn("desktop.ipc.wsl.getState")(function* () {
    return yield* readWslState;
  }),
});

export const setWslBackendEnabled = makeIpcMethod({
  channel: IpcChannels.SET_WSL_BACKEND_ENABLED_CHANNEL,
  payload: Schema.Boolean,
  result: DesktopWslStateSchema,
  handler: Effect.fn("desktop.ipc.wsl.setEnabled")(function* (enabled) {
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    if (environment.platform !== "win32") return UNSUPPORTED_WSL_STATE;
    const appSettings = yield* DesktopAppSettings.DesktopAppSettings;
    const wslBackend = yield* DesktopWslBackend.DesktopWslBackend;
    if (!enabled) {
      yield* appSettings.setWslBackendEnabled(false);
      yield* wslBackend.reconcile;
      return yield* readWslState;
    }

    const wslEnvironment = yield* DesktopWslEnvironment.DesktopWslEnvironment;
    const settings = yield* appSettings.get;
    const distros = yield* wslEnvironment.probeDistros;
    const decision = decideWslEnable({ distro: settings.wslDistro, distros });
    if (!decision.ok) {
      return yield* new DesktopWslRequestError({ reason: decision.reason });
    }
    yield* appSettings.setWslBackendEnabled(true);
    yield* wslBackend.reconcile;
    return yield* readWslState;
  }),
});

export const setWslDistro = makeIpcMethod({
  channel: IpcChannels.SET_WSL_DISTRO_CHANNEL,
  payload: Schema.NullOr(Schema.String),
  result: DesktopWslStateSchema,
  handler: Effect.fn("desktop.ipc.wsl.setDistro")(function* (distro) {
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    if (environment.platform !== "win32") return UNSUPPORTED_WSL_STATE;
    const appSettings = yield* DesktopAppSettings.DesktopAppSettings;
    if (distro !== null) {
      const trimmed = distro.trim();
      if (trimmed.length === 0) {
        return yield* new DesktopWslRequestError({
          reason: "WSL distro must name a distro, got an empty string",
        });
      }
      const wslEnvironment = yield* DesktopWslEnvironment.DesktopWslEnvironment;
      const distros = yield* wslEnvironment.probeDistros;
      if (!distros.some((candidate) => candidate.name.toLowerCase() === trimmed.toLowerCase())) {
        return yield* new DesktopWslRequestError({
          reason: `no WSL distro named "${trimmed}"; wsl.exe -l -v lists: ${listDistroNames(distros)}`,
        });
      }
      yield* appSettings.setWslDistro(trimmed);
      return yield* readWslState;
    }
    yield* appSettings.setWslDistro(null);
    return yield* readWslState;
  }),
});

export const setWslOnly = makeIpcMethod({
  channel: IpcChannels.SET_WSL_ONLY_CHANNEL,
  payload: Schema.Boolean,
  result: DesktopWslStateSchema,
  handler: Effect.fn("desktop.ipc.wsl.setOnly")(function* (enabled) {
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    if (environment.platform !== "win32") return UNSUPPORTED_WSL_STATE;
    const appSettings = yield* DesktopAppSettings.DesktopAppSettings;
    yield* appSettings.setWslOnly(enabled);
    return yield* readWslState;
  }),
});
