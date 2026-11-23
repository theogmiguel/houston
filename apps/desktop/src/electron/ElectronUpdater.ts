// @effect-diagnostics nodeBuiltinImport:off -- the updater relaunch spawns bash synchronously through its own patch.
import * as NodeChildProcess from "node:child_process";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";

import type { AppUpdater } from "electron-updater";

type AutoUpdater = AppUpdater;

// AppImageUpdater relaunches the new AppImage while this process and its
// keepalive pipes are still alive. Closing every descriptor Electron inherited
// lets the old AppImage mount exit; exec keeps the detached spawn semantics.
const APPIMAGE_CLOSE_INHERITED_FDS_SCRIPT =
  'for fd in /proc/self/fd/*; do fd=${fd##*/}; case $fd in 0|1|2) ;; *) eval "exec $fd>&-" 2>/dev/null ;; esac; done; exec "$@"';

export const appImageCloseInheritedFdsCommand = (
  command: string,
  args: readonly string[] = [],
): { readonly command: "bash"; readonly args: ReadonlyArray<string> } => ({
  command: "bash",
  args: ["-c", APPIMAGE_CLOSE_INHERITED_FDS_SCRIPT, "bash", command, ...args],
});

const APPIMAGE_SPAWN_PATCHED = Symbol.for("@houston-app/desktop/appimage-spawn-patched");

interface AppImageUpdaterPrototype {
  spawnLog?: (
    cmd: string,
    args?: string[],
    env?: NodeJS.ProcessEnv,
    stdio?: NodeChildProcess.StdioOptions,
  ) => Promise<boolean>;
  [APPIMAGE_SPAWN_PATCHED]?: boolean;
}

const patchAppImageSpawnLog = (
  module: typeof import("electron-updater"),
  autoUpdater: AutoUpdater,
): void => {
  // oxlint-disable-next-line houston/no-global-process-runtime -- the updater patch runs before the Effect runtime exists.
  if (process.platform !== "linux" || !(autoUpdater instanceof module.AppImageUpdater)) return;
  const prototype = module.AppImageUpdater.prototype as unknown as AppImageUpdaterPrototype;
  if (prototype[APPIMAGE_SPAWN_PATCHED] === true) return;
  prototype.spawnLog = function (cmd, args = [], env, stdio = "ignore") {
    const wrapped = appImageCloseInheritedFdsCommand(cmd, args);
    return new Promise<boolean>((resolve, reject) => {
      try {
        const child = NodeChildProcess.spawn(wrapped.command, [...wrapped.args], {
          stdio,
          env,
          detached: true,
        });
        child.on("error", reject);
        child.unref();
        if (child.pid !== undefined) resolve(true);
      } catch (error) {
        reject(error);
      }
    });
  };
  prototype[APPIMAGE_SPAWN_PATCHED] = true;
};

// electron-updater and its dependencies are evaluated on first use, not at launch.
let autoUpdaterPromise: Promise<AutoUpdater> | undefined;
const loadAutoUpdater = () =>
  (autoUpdaterPromise ??= import("electron-updater").then((module) => {
    const autoUpdater = module.autoUpdater;
    patchAppImageSpawnLog(module, autoUpdater);
    return autoUpdater;
  }));
const withAutoUpdater = <A, E = never, R = never>(
  f: (updater: AutoUpdater) => Effect.Effect<A, E, R>,
) => Effect.promise(loadAutoUpdater).pipe(Effect.flatMap(f));

export type ElectronUpdaterFeedUrl = Parameters<AutoUpdater["setFeedURL"]>[0];

export class ElectronUpdaterCheckForUpdatesError extends Schema.TaggedError<ElectronUpdaterCheckForUpdatesError>()(
  "ElectronUpdaterCheckForUpdatesError",
  {
    channel: Schema.NullOr(Schema.String),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Electron updater failed to check for updates on channel ${this.channel ?? "default"}.`;
  }
}

export class ElectronUpdaterDownloadUpdateError extends Schema.TaggedError<ElectronUpdaterDownloadUpdateError>()(
  "ElectronUpdaterDownloadUpdateError",
  {
    channel: Schema.NullOr(Schema.String),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Electron updater failed to download the update on channel ${this.channel ?? "default"}.`;
  }
}

export class ElectronUpdaterQuitAndInstallError extends Schema.TaggedError<ElectronUpdaterQuitAndInstallError>()(
  "ElectronUpdaterQuitAndInstallError",
  {
    channel: Schema.NullOr(Schema.String),
    isSilent: Schema.Boolean,
    isForceRunAfter: Schema.Boolean,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Electron updater failed to quit and install the update on channel ${this.channel ?? "default"} (silent: ${this.isSilent}, force run after: ${this.isForceRunAfter}).`;
  }
}

export const ElectronUpdaterError = Schema.Union([
  ElectronUpdaterCheckForUpdatesError,
  ElectronUpdaterDownloadUpdateError,
  ElectronUpdaterQuitAndInstallError,
]);
export type ElectronUpdaterError = typeof ElectronUpdaterError.Type;

export class ElectronUpdater extends Context.Service<
  ElectronUpdater,
  {
    readonly setFeedURL: (options: ElectronUpdaterFeedUrl) => Effect.Effect<void>;
    readonly setAutoDownload: (value: boolean) => Effect.Effect<void>;
    readonly setAutoInstallOnAppQuit: (value: boolean) => Effect.Effect<void>;
    readonly setChannel: (channel: string) => Effect.Effect<void>;
    readonly setAllowPrerelease: (value: boolean) => Effect.Effect<void>;
    readonly allowDowngrade: Effect.Effect<boolean>;
    readonly setAllowDowngrade: (value: boolean) => Effect.Effect<void>;
    readonly setFullChangelog: (value: boolean) => Effect.Effect<void>;
    readonly setDisableDifferentialDownload: (value: boolean) => Effect.Effect<void>;
    readonly checkForUpdates: Effect.Effect<void, ElectronUpdaterCheckForUpdatesError>;
    readonly downloadUpdate: Effect.Effect<void, ElectronUpdaterDownloadUpdateError>;
    readonly quitAndInstall: (options: {
      readonly isSilent: boolean;
      readonly isForceRunAfter: boolean;
    }) => Effect.Effect<void, ElectronUpdaterQuitAndInstallError>;
    readonly on: <Args extends ReadonlyArray<unknown>>(
      eventName: string,
      listener: (...args: Args) => void,
    ) => Effect.Effect<void, never, Scope.Scope>;
  }
>()("@houston-app/desktop/electron/ElectronUpdater") {}

/** @public */
export const make = ElectronUpdater.of({
  setFeedURL: Effect.fn("ElectronUpdater.setFeedURL")(function (options) {
    return withAutoUpdater((autoUpdater) => {
      autoUpdater.setFeedURL(options);
      return Effect.void;
    });
  }),
  setAutoDownload: Effect.fn("ElectronUpdater.setAutoDownload")(function (value) {
    return withAutoUpdater((autoUpdater) => {
      autoUpdater.autoDownload = value;
      return Effect.void;
    });
  }),
  setAutoInstallOnAppQuit: Effect.fn("ElectronUpdater.setAutoInstallOnAppQuit")(function (value) {
    return withAutoUpdater((autoUpdater) => {
      autoUpdater.autoInstallOnAppQuit = value;
      return Effect.void;
    });
  }),
  setChannel: Effect.fn("ElectronUpdater.setChannel")(function (channel) {
    return withAutoUpdater((autoUpdater) => {
      autoUpdater.channel = channel;
      return Effect.void;
    });
  }),
  setAllowPrerelease: Effect.fn("ElectronUpdater.setAllowPrerelease")(function (value) {
    return withAutoUpdater((autoUpdater) => {
      autoUpdater.allowPrerelease = value;
      return Effect.void;
    });
  }),
  allowDowngrade: withAutoUpdater((autoUpdater) => Effect.succeed(autoUpdater.allowDowngrade)),
  setAllowDowngrade: Effect.fn("ElectronUpdater.setAllowDowngrade")(function (value) {
    return withAutoUpdater((autoUpdater) => {
      autoUpdater.allowDowngrade = value;
      return Effect.void;
    });
  }),
  setFullChangelog: Effect.fn("ElectronUpdater.setFullChangelog")(function (value) {
    return withAutoUpdater((autoUpdater) => {
      autoUpdater.fullChangelog = value;
      return Effect.void;
    });
  }),
  setDisableDifferentialDownload: Effect.fn("ElectronUpdater.setDisableDifferentialDownload")(
    function (value) {
      return withAutoUpdater((autoUpdater) => {
        autoUpdater.disableDifferentialDownload = value;
        return Effect.void;
      });
    },
  ),
  checkForUpdates: withAutoUpdater((autoUpdater) => {
    const channel = autoUpdater.channel;
    return Effect.tryPromise({
      try: () => autoUpdater.checkForUpdates(),
      catch: (cause) => new ElectronUpdaterCheckForUpdatesError({ channel, cause }),
    }).pipe(Effect.asVoid);
  }),
  downloadUpdate: withAutoUpdater((autoUpdater) => {
    const channel = autoUpdater.channel;
    return Effect.tryPromise({
      try: () => autoUpdater.downloadUpdate(),
      catch: (cause) => new ElectronUpdaterDownloadUpdateError({ channel, cause }),
    }).pipe(Effect.asVoid);
  }),
  quitAndInstall: Effect.fn("ElectronUpdater.quitAndInstall")(function ({
    isSilent,
    isForceRunAfter,
  }) {
    return withAutoUpdater((autoUpdater) => {
      const channel = autoUpdater.channel;
      return Effect.try({
        try: () => autoUpdater.quitAndInstall(isSilent, isForceRunAfter),
        catch: (cause) =>
          new ElectronUpdaterQuitAndInstallError({
            channel,
            isSilent,
            isForceRunAfter,
            cause,
          }),
      });
    });
  }),
  on: Effect.fn("ElectronUpdater.on")(function (eventName, listener) {
    const untypedListener = listener as unknown as (...args: Array<unknown>) => void;
    return withAutoUpdater((autoUpdater) => {
      const eventTarget = autoUpdater as unknown as {
        on: (eventName: string, listener: (...args: Array<unknown>) => void) => void;
        removeListener: (eventName: string, listener: (...args: Array<unknown>) => void) => void;
      };
      return Effect.acquireRelease(
        Effect.sync(() => {
          eventTarget.on(eventName, untypedListener);
        }),
        () =>
          Effect.sync(() => {
            eventTarget.removeListener(eventName, untypedListener);
          }),
      );
    }).pipe(Effect.asVoid);
  }),
});

export const layer = Layer.succeed(ElectronUpdater, make);
