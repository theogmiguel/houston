// @effect-diagnostics nodeBuiltinImport:off -- The tray lives in the Electron main process and reads the desktop environment directly.

import { sessionBus, Message } from "dbus-next";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as Electron from "electron";

import type { DesktopTrayPayload, DesktopTrayState } from "@houston-app/contracts";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import { makeComponentLogger } from "../app/DesktopObservability.ts";
import {
  baseIconSize,
  headerText,
  iconSizeFor,
  iconState,
  menuModel,
  shouldHideOnClose,
  trayIconFile,
  type TrayIconState,
  type TrayItem,
} from "./model.ts";

export type TrayAction =
  | { readonly type: "open" }
  | { readonly type: "new-thread" }
  | { readonly type: "focus-thread"; readonly threadKey: string }
  | { readonly type: "quit" };

type TrayActionListener = (action: TrayAction) => void;

const STATUS_NOTIFIER_WATCHER = "org.kde.StatusNotifierWatcher";

const DEFAULT_TRAY_SETTINGS = { keepInTray: true } as const;

const TraySettingsDocument = Schema.Struct({
  keepInTray: Schema.Boolean,
});
const TraySettingsJson = Schema.fromJsonString(TraySettingsDocument);
const decodeTraySettings = Schema.decodeUnknownOption(TraySettingsJson);
const encodeTraySettings = Schema.encodeSync(TraySettingsJson);

export class TraySettingsWriteError extends Schema.TaggedError<TraySettingsWriteError>()(
  "TraySettingsWriteError",
  {
    path: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Could not save the tray setting to ${this.path}. It applies until Houston restarts.`;
  }
}

export class TrayCreateError extends Schema.TaggedError<TrayCreateError>()("TrayCreateError", {
  cause: Schema.Defect(),
}) {
  override get message(): string {
    return `The tray icon refused to build: ${
      this.cause instanceof Error ? this.cause.message : String(this.cause)
    }`;
  }
}

export class TrayHost extends Context.Service<
  TrayHost,
  {
    /** Creates the tray after Electron is ready; safe to call once. */
    readonly initialize: Effect.Effect<void>;
    readonly sync: (payload: DesktopTrayPayload) => Effect.Effect<void>;
    readonly state: Effect.Effect<DesktopTrayState>;
    readonly setKeepInTray: (
      enabled: boolean,
    ) => Effect.Effect<DesktopTrayState, TraySettingsWriteError>;
    /** Synchronous because Electron's close event must decide before returning. */
    readonly hidesOnCloseNow: () => boolean;
    readonly onAction: (listener: TrayActionListener) => () => void;
  }
>()("@houston-app/desktop/tray/TrayHost") {}

const { logWarning: logTrayWarning } = makeComponentLogger("desktop-tray");

function messageText(item: Exclude<TrayItem, { type: "separator" }>): string {
  switch (item.type) {
    case "header":
    case "group":
    case "overflow":
      return item.label;
    case "open":
      return "Open Houston";
    case "newThread":
      return "New thread…";
    case "session":
      return item.label;
    case "submenu":
      return item.label;
    case "quit":
      return "Quit and keep sessions";
  }
}

function buildMenu(payload: DesktopTrayPayload, emit: (action: TrayAction) => void): Electron.Menu {
  const toTemplate = (items: readonly TrayItem[]): Electron.MenuItemConstructorOptions[] =>
    items.map((item): Electron.MenuItemConstructorOptions => {
      switch (item.type) {
        case "header":
        case "group":
        case "overflow":
          return { label: messageText(item), enabled: false };
        case "open":
          return { label: messageText(item), click: () => emit({ type: "open" }) };
        case "newThread":
          return { label: messageText(item), click: () => emit({ type: "new-thread" }) };
        case "separator":
          return { type: "separator" };
        case "session":
          return {
            label: messageText(item),
            click: () => emit({ type: "focus-thread", threadKey: item.id }),
          };
        case "submenu":
          return { label: messageText(item), submenu: toTemplate(item.items) };
        case "quit":
          return { label: messageText(item), click: () => emit({ type: "quit" }) };
      }
    });
  return Electron.Menu.buildFromTemplate(toTemplate(menuModel(payload)));
}

function payloadsEqual(left: DesktopTrayPayload, right: DesktopTrayPayload): boolean {
  if (left.connection !== right.connection || left.sessions.length !== right.sessions.length) {
    return false;
  }
  return left.sessions.every((session, index) => {
    const other = right.sessions[index];
    return (
      other !== undefined &&
      session.id === other.id &&
      session.agent === other.agent &&
      session.title === other.title &&
      session.status === other.status &&
      session.needsInput === other.needsInput &&
      session.workspace === other.workspace
    );
  });
}

async function linuxTrayAvailability(): Promise<{ available: boolean; reason: string | null }> {
  const bus = sessionBus();
  try {
    const reply = await bus.call(
      new Message({
        destination: "org.freedesktop.DBus",
        path: "/org/freedesktop/DBus",
        interface: "org.freedesktop.DBus",
        member: "NameHasOwner",
        signature: "s",
        body: [STATUS_NOTIFIER_WATCHER],
      }),
    );
    if (reply === null || reply.body[0] !== true) {
      return {
        available: false,
        reason: `No tray on this desktop: nothing owns ${STATUS_NOTIFIER_WATCHER}; on GNOME that is the AppIndicator extension`,
      };
    }
    return { available: true, reason: null };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      available: false,
      reason: `No tray on this desktop: the session bus could not be asked who owns ${STATUS_NOTIFIER_WATCHER}: ${detail}`,
    };
  } finally {
    bus.disconnect();
  }
}

/** @public */
export const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const fileSystem = yield* FileSystem.FileSystem;
  const settingsPath = environment.path.join(environment.stateDir, "tray.json");

  let initialized = false;
  let tray: Electron.Tray | null = null;
  let available = false;
  let reason: string | null = null;
  let keepInTray: boolean = DEFAULT_TRAY_SETTINGS.keepInTray;
  let payload: DesktopTrayPayload = { connection: "connecting", sessions: [] };
  let paintedPayload: DesktopTrayPayload | null = null;
  let paintedIcon: TrayIconState | null = null;
  let iconSize: number = baseIconSize(environment.platform, process.env.XDG_CURRENT_DESKTOP);
  const listeners = new Set<TrayActionListener>();

  const emit = (action: TrayAction) => {
    for (const listener of listeners) listener(action);
  };

  const refuse = (nextReason: string) => {
    available = false;
    reason = nextReason;
  };

  const resolveIcon = Effect.fn("desktop.tray.resolveIcon")(function* (
    state: TrayIconState,
    size: number,
  ) {
    const candidates = environment.resolveResourcePathCandidates(trayIconFile(state, size));
    for (const candidate of candidates) {
      if (yield* fileSystem.exists(candidate)) return candidate;
    }
    return null;
  });

  const paint = Effect.fn("desktop.tray.paint")(function* () {
    if (tray === null || (paintedPayload !== null && payloadsEqual(paintedPayload, payload))) {
      return;
    }
    const menu = buildMenu(payload, emit);
    tray.setContextMenu(menu);
    tray.setToolTip(headerText(payload));
    const nextIcon = iconState(payload);
    if (paintedIcon !== nextIcon) {
      const iconPath = yield* resolveIcon(nextIcon, iconSize);
      if (iconPath === null) {
        yield* logTrayWarning("tray icon file is missing", {
          icon: trayIconFile(nextIcon, iconSize),
        });
      } else {
        const image = Electron.nativeImage.createFromPath(iconPath);
        if (!image.isEmpty()) {
          tray.setImage(image);
          paintedIcon = nextIcon;
        }
      }
    }
    paintedPayload = payload;
  });

  const initialize = Effect.gen(function* () {
    if (initialized) return;
    initialized = true;
    const stored = yield* fileSystem
      .readFileString(settingsPath)
      .pipe(Effect.orElseSucceed((): string | null => null));
    const decoded = stored === null ? null : decodeTraySettings(stored);
    keepInTray =
      decoded !== null && decoded._tag === "Some"
        ? decoded.value.keepInTray
        : DEFAULT_TRAY_SETTINGS.keepInTray;
    iconSize = iconSizeFor(
      baseIconSize(environment.platform, process.env.XDG_CURRENT_DESKTOP),
      Electron.screen.getPrimaryDisplay()?.scaleFactor,
    );

    if (environment.platform === "linux") {
      const probe = yield* Effect.tryPromise({
        try: linuxTrayAvailability,
        catch: () => ({
          available: false,
          reason: "No tray on this desktop: the session bus probe failed",
        }),
      });
      if (!probe.available) {
        refuse(probe.reason ?? "No tray on this desktop");
        yield* logTrayWarning(reason ?? "tray unavailable");
        return;
      }
    }

    const initialState = iconState(payload);
    const iconPath = yield* resolveIcon(initialState, iconSize);
    if (iconPath === null) {
      refuse(
        `No tray on this desktop: the ${iconSize}px tray icon could not be found in the app's resources`,
      );
      yield* logTrayWarning(reason ?? "tray icon missing");
      return;
    }
    const image = Electron.nativeImage.createFromPath(iconPath);
    if (image.isEmpty()) {
      refuse(
        `No tray on this desktop: the ${iconSize}px tray icon failed to load from ${iconPath}`,
      );
      yield* logTrayWarning(reason ?? "tray icon unreadable");
      return;
    }

    const created = yield* Effect.try({
      try: () => {
        const nextTray = new Electron.Tray(image);
        nextTray.setToolTip(headerText(payload));
        nextTray.setContextMenu(buildMenu(payload, emit));
        if (environment.platform !== "linux") {
          nextTray.on("click", () => emit({ type: "open" }));
        }
        return nextTray;
      },
      catch: (cause) => new TrayCreateError({ cause }),
    }).pipe(
      Effect.catch((cause) => {
        refuse(`No tray on this desktop: ${cause.message}`);
        return Effect.succeed<Electron.Tray | null>(null);
      }),
    );
    if (created === null) {
      yield* logTrayWarning(reason ?? "tray creation failed");
      return;
    }
    tray = created;
    available = true;
    reason = null;
    paintedPayload = payload;
    paintedIcon = initialState;
  }).pipe(
    Effect.catchCause((cause) =>
      logTrayWarning("tray initialization failed", { cause }).pipe(
        Effect.andThen(
          Effect.sync(() => {
            refuse("No tray on this desktop: the tray could not be initialized");
          }),
        ),
      ),
    ),
  );

  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      tray?.destroy();
      tray = null;
    }),
  );

  return TrayHost.of({
    initialize,
    sync: Effect.fn("desktop.tray.sync")(function* (next) {
      payload = next;
      yield* paint().pipe(
        Effect.catchCause((cause) => logTrayWarning("tray repaint failed", { cause })),
      );
    }),
    state: Effect.sync(() => ({
      available,
      reason,
      keepInTray,
      hidesOnClose: available && keepInTray,
    })),
    setKeepInTray: Effect.fn("desktop.tray.setKeepInTray")(function* (enabled) {
      keepInTray = enabled;
      yield* fileSystem
        .writeFileString(settingsPath, encodeTraySettings({ keepInTray: enabled }))
        .pipe(
          Effect.mapError((cause) => new TraySettingsWriteError({ path: settingsPath, cause })),
        );
      return { available, reason, keepInTray, hidesOnClose: available && keepInTray };
    }),
    hidesOnCloseNow: () => shouldHideOnClose({ available, keepInTray, quitting: false }),
    onAction: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  });
});

export const layer = Layer.effect(TrayHost, make);
