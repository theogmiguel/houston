import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as Electron from "electron";
import {
  KeybindingShortcut,
  type DesktopQuickComposerShortcutStatus,
} from "@houston-app/contracts";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import { makeComponentLogger } from "../app/DesktopObservability.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import { getDesktopUrl } from "../electron/ElectronProtocol.ts";
import {
  DEFAULT_QUICK_COMPOSER_SETTINGS,
  DEFAULT_QUICK_COMPOSER_SHORTCUT,
  accelerator,
  chordLabel,
  normalizeShortcut,
  registrationFailureReason,
  sessionIsWayland,
  type QuickComposerSettings,
} from "./shortcut.ts";

const QUICK_COMPOSER_WIDTH = 560;
const QUICK_COMPOSER_HEIGHT = 380;
const QUICK_COMPOSER_MIN_WIDTH = 420;
const QUICK_COMPOSER_MIN_HEIGHT = 260;

const QuickComposerSettingsDocument = Schema.Struct({
  enabled: Schema.optionalKey(Schema.Boolean),
  shortcut: Schema.optionalKey(Schema.NullOr(KeybindingShortcut)),
});

const QuickComposerSettingsJson = Schema.fromJsonString(QuickComposerSettingsDocument);
const decodeSettingsJson = Schema.decodeUnknownOption(QuickComposerSettingsJson);
const encodeSettingsJson = Schema.encodeSync(QuickComposerSettingsJson);

function normalizeSettings(document: {
  readonly enabled?: boolean;
  readonly shortcut?: KeybindingShortcut | null;
}): QuickComposerSettings {
  return {
    enabled: document.enabled !== false,
    shortcut: document.shortcut === undefined ? DEFAULT_QUICK_COMPOSER_SHORTCUT : document.shortcut,
  };
}

export class QuickComposerError extends Schema.TaggedError<QuickComposerError>()(
  "QuickComposerError",
  {
    operation: Schema.Literals(["open", "save-settings"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    switch (this.operation) {
      case "open":
        return `Could not open the quick composer window: ${
          this.cause instanceof Error ? this.cause.message : String(this.cause)
        }`;
      case "save-settings":
        return `Could not save the quick composer shortcut: ${
          this.cause instanceof Error ? this.cause.message : String(this.cause)
        }. It applies until Houston restarts.`;
    }
  }
}

export class QuickComposer extends Context.Service<
  QuickComposer,
  {
    readonly initialize: Effect.Effect<void>;
    readonly status: Effect.Effect<DesktopQuickComposerShortcutStatus>;
    readonly setShortcut: (
      shortcut: KeybindingShortcut | null,
    ) => Effect.Effect<DesktopQuickComposerShortcutStatus, QuickComposerError>;
    readonly open: Effect.Effect<void, QuickComposerError>;
    readonly close: Effect.Effect<void>;
    readonly toggle: Effect.Effect<void, QuickComposerError>;
  }
>()("@houston-app/desktop/quickComposer/QuickComposer") {}

const { logWarning: logQuickComposerWarning } = makeComponentLogger("desktop-quick-composer");

/** @public */
export const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const electronWindow = yield* ElectronWindow.ElectronWindow;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = environment.path;
  const settingsPath = path.join(environment.stateDir, "quick-composer.json");
  const context = yield* Effect.context<
    DesktopEnvironment.DesktopEnvironment | ElectronWindow.ElectronWindow
  >();
  const runPromise = Effect.runPromiseWith(context);

  let settings: QuickComposerSettings = DEFAULT_QUICK_COMPOSER_SETTINGS;
  let status: {
    enabled: boolean;
    shortcut: KeybindingShortcut | null;
    registered: boolean;
    reason: string | null;
  } = {
    enabled: settings.enabled,
    shortcut: settings.shortcut,
    registered: false,
    reason: null,
  };
  let registeredAccelerator: string | undefined;
  let window: Electron.BrowserWindow | null = null;
  let initialized = false;

  const releaseShortcut = () => {
    if (registeredAccelerator === undefined) return;
    Electron.globalShortcut.unregister(registeredAccelerator);
    registeredAccelerator = undefined;
  };

  const apply = () => {
    releaseShortcut();
    const next: typeof status = {
      enabled: settings.enabled,
      shortcut: settings.shortcut,
      registered: false,
      reason: null,
    };
    if (!settings.enabled) {
      status = next;
      return status;
    }
    const shortcut = settings.shortcut;
    if (shortcut === null) {
      next.reason = "No shortcut is configured. Choose one in Settings > Keybindings.";
      status = next;
      return status;
    }
    const wayland = sessionIsWayland(environment.platform, process.env);
    if (wayland) {
      next.reason = registrationFailureReason(
        shortcut,
        "a Wayland session has no X server for global hotkeys",
        true,
      );
      status = next;
      return status;
    }
    let electronAccelerator: string;
    try {
      electronAccelerator = accelerator(shortcut);
    } catch (error) {
      next.reason = error instanceof Error ? error.message : String(error);
      status = next;
      return status;
    }
    try {
      const registered = Electron.globalShortcut.register(electronAccelerator, () => {
        void runPromise(
          Effect.suspend(() => toggle).pipe(
            Effect.catchCause((cause) =>
              logQuickComposerWarning("quick composer shortcut failed", { cause }),
            ),
          ),
        );
      });
      if (registered) {
        registeredAccelerator = electronAccelerator;
        next.registered = true;
      } else {
        next.reason = registrationFailureReason(shortcut, chordLabel(shortcut), false);
      }
    } catch (error) {
      next.reason = registrationFailureReason(
        shortcut,
        error instanceof Error ? error.message : String(error),
        false,
      );
    }
    status = next;
    return status;
  };

  const open = Effect.gen(function* () {
    if (window !== null && !window.isDestroyed()) {
      if (window.isMinimized()) window.restore();
      window.show();
      window.focus();
      return;
    }
    const created = yield* electronWindow
      .create(
        {
          width: QUICK_COMPOSER_WIDTH,
          height: QUICK_COMPOSER_HEIGHT,
          minWidth: QUICK_COMPOSER_MIN_WIDTH,
          minHeight: QUICK_COMPOSER_MIN_HEIGHT,
          frame: false,
          alwaysOnTop: true,
          resizable: false,
          skipTaskbar: true,
          center: true,
          title: "New thread",
          show: false,
          webPreferences: {
            preload: environment.preloadPath,
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
            backgroundThrottling: false,
          },
        },
        { auxiliary: true },
      )
      .pipe(Effect.mapError((cause) => new QuickComposerError({ operation: "open", cause })));
    window = created;
    created.on("closed", () => {
      if (window === created) window = null;
    });
    created.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    const applicationUrl = getDesktopUrl(environment.isDevelopment);
    created.webContents.on("will-navigate", (event, url) => {
      if (!url.startsWith(applicationUrl)) event.preventDefault();
    });
    created.once("ready-to-show", () => {
      if (!created.isDestroyed()) {
        created.show();
        created.focus();
      }
    });
    yield* Effect.tryPromise({
      try: () => created.loadURL(`${applicationUrl}#/quick-composer`),
      catch: (cause) => new QuickComposerError({ operation: "open", cause }),
    });
  }).pipe(
    Effect.catchCause((cause) =>
      logQuickComposerWarning("could not open the quick composer window", { cause }).pipe(
        Effect.andThen(Effect.fail(new QuickComposerError({ operation: "open", cause }))),
      ),
    ),
  );

  const close = Effect.sync(() => {
    if (window !== null && !window.isDestroyed()) window.close();
  });

  const toggle: Effect.Effect<void, QuickComposerError> = Effect.suspend(() =>
    window !== null && !window.isDestroyed() ? close : open,
  );

  const initialize = Effect.gen(function* () {
    if (initialized) return;
    initialized = true;
    const body = yield* fileSystem
      .readFileString(settingsPath)
      .pipe(Effect.orElseSucceed((): string | null => null));
    if (body === null) {
      settings = DEFAULT_QUICK_COMPOSER_SETTINGS;
    } else {
      const decoded = decodeSettingsJson(body);
      if (decoded._tag === "None") {
        yield* logQuickComposerWarning(
          "quick composer settings are corrupt; keeping the default shortcut",
          { path: settingsPath },
        );
        settings = DEFAULT_QUICK_COMPOSER_SETTINGS;
      } else {
        settings = normalizeSettings(decoded.value);
      }
    }
    apply();
  }).pipe(
    Effect.catchCause((cause) =>
      logQuickComposerWarning("quick composer initialization failed", { cause }),
    ),
  );

  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      releaseShortcut();
    }),
  );

  return QuickComposer.of({
    initialize,
    status: Effect.sync(() => status),
    setShortcut: Effect.fn("desktop.quickComposer.setShortcut")(function* (shortcut) {
      const next: QuickComposerSettings = {
        enabled: shortcut !== null,
        shortcut: shortcut === null ? settings.shortcut : normalizeShortcut(shortcut),
      };
      yield* fileSystem
        .writeFileString(settingsPath, encodeSettingsJson(next))
        .pipe(
          Effect.mapError((cause) => new QuickComposerError({ operation: "save-settings", cause })),
        );
      settings = next;
      return apply();
    }),
    open,
    close,
    toggle,
  });
});

export const layer = Layer.effect(QuickComposer, make);
